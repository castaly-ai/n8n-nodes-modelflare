import {
  NodeConnectionTypes,
  NodeOperationError,
  sleep,
  type IDataObject,
  type IExecuteFunctions,
  type IHttpRequestMethods,
  type IHttpRequestOptions,
  type ILoadOptionsFunctions,
  type INodeExecutionData,
  type INodePropertyOptions,
  type INodeType,
  type INodeTypeDescription,
} from 'n8n-workflow'

import { ATTRIBUTION_HEADER, attributionValue } from './core/attribution.js'
import { classifyModels, needsCatalog, type CatalogEntry, type ClassifiedModel, type ModelKind, type ModelListEntry } from './core/classify.js'
import { CATALOG_URL, resolveBaseUrl } from './core/config.js'
import { ModelflareError, errorFromResponse } from './core/errors.js'
import { describeError } from './core/messages.js'
import { VERSION } from './core/version.js'

const CREDENTIALS = 'modelflareApi'
const UTM_SOURCE = 'n8n'
const ATTRIBUTION = attributionValue('modelflare-n8n', VERSION)
const MAX_WAIT_SECONDS = 600

type Context = IExecuteFunctions | ILoadOptionsFunctions

async function baseUrl(context: Context): Promise<string> {
  const credentials = await context.getCredentials(CREDENTIALS)
  const value = credentials.baseUrl === 'custom' ? credentials.customBaseUrl : credentials.baseUrl
  return resolveBaseUrl(typeof value === 'string' ? value : undefined)
}

async function api<T>(
  context: Context,
  method: IHttpRequestMethods,
  path: string,
  options: Partial<IHttpRequestOptions> = {},
): Promise<T> {
  return (await context.helpers.httpRequestWithAuthentication.call(context, CREDENTIALS, {
    method,
    baseURL: await baseUrl(context),
    url: `/${path}`,
    json: true,
    ...options,
    headers: { ...options.headers, [ATTRIBUTION_HEADER]: ATTRIBUTION },
  })) as T
}

async function classified(context: Context): Promise<{ models: ClassifiedModel[]; listed: Set<string> }> {
  const list = await api<{ data?: ModelListEntry[] }>(context, 'GET', 'models?scope=authorized')
  const entries = Array.isArray(list.data) ? list.data : []
  let catalog: CatalogEntry[] | null = null
  try {
    if (!needsCatalog(entries)) return { models: classifyModels(entries, null), listed: new Set(entries.map((entry) => entry.id)) }
    const body = (await context.helpers.httpRequest({ method: 'GET', url: CATALOG_URL, json: true })) as { data?: CatalogEntry[] }
    catalog = Array.isArray(body.data) ? body.data : null
  } catch {
    catalog = null
  }
  return { models: classifyModels(entries, catalog), listed: new Set(entries.map((entry) => entry.id)) }
}

async function optionsOf(context: ILoadOptionsFunctions, kind: ModelKind): Promise<INodePropertyOptions[]> {
  const { models } = await classified(context)
  return models
    .filter((model) => model.kind === kind && (kind !== 'text' || model.endpoints.includes('openai')))
    .map((model) => ({ name: model.id, value: model.id }))
}

/**
 * Rebuilds the gateway response from n8n's request error, so the shared core
 * decides the error kind from the gateway's error code.
 */
async function asModelflareError(error: unknown): Promise<ModelflareError | undefined> {
  const failure = error as {
    httpCode?: string
    response?: { status?: number; data?: unknown; body?: unknown }
    cause?: { response?: { status?: number; data?: unknown; body?: unknown } }
  }
  const response = failure.response ?? failure.cause?.response
  const status = response?.status ?? Number(failure.httpCode)
  if (!Number.isInteger(status) || status < 400 || status > 599) return undefined
  const body = response?.data ?? response?.body
  return errorFromResponse(new Response(typeof body === 'string' ? body : JSON.stringify(body ?? {}), { status }))
}

async function explain(context: IExecuteFunctions, error: unknown, modelId?: string): Promise<string> {
  const gatewayError = error instanceof ModelflareError ? error : await asModelflareError(error)
  if (!gatewayError) return error instanceof Error ? error.message : String(error)
  let modelListed: boolean | undefined
  if (gatewayError.kind === 'model_not_found' && modelId) {
    modelListed = await classified(context)
      .then(({ listed }) => listed.has(modelId))
      .catch(() => undefined)
  }
  return describeError(gatewayError, { locale: 'en', utmSource: UTM_SOURCE, ...(modelListed !== undefined ? { modelListed } : {}) })
}

function collectionParameter(context: IExecuteFunctions, name: string, index: number): IDataObject {
  const value = context.getNodeParameter(name, index, {}) as unknown
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as IDataObject) : {}
}

// 0.1.2 exposed open JSON fields. They stay readable so saved workflows keep
// their model-specific parameters, while 0.1.3 only offers typed controls for
// new configurations.
function legacyObjectParameter(context: IExecuteFunctions, name: 'parameters' | 'request', index: number): IDataObject {
  const value = context.getNodeParameter(name, index, {}) as unknown
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as IDataObject
    } catch {
      throw new NodeOperationError(context.getNode(), `The saved ${name} value must be a JSON object`, { itemIndex: index })
    }
  }
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as IDataObject) : {}
}

function textParameters(context: IExecuteFunctions, index: number): IDataObject {
  const options = collectionParameter(context, 'textOptions', index)
  const result: IDataObject = { ...legacyObjectParameter(context, 'parameters', index) }
  if (typeof options.temperature === 'number') result.temperature = options.temperature
  if (typeof options.maxTokens === 'number') result.max_tokens = options.maxTokens
  if (typeof options.topP === 'number') result.top_p = options.topP
  if (typeof options.reasoningEffort === 'string' && options.reasoningEffort) result.reasoning_effort = options.reasoningEffort
  if (options.responseFormat === 'json_object' || options.responseFormat === 'text') {
    result.response_format = { type: options.responseFormat }
  }
  return result
}

function imageParameters(context: IExecuteFunctions, index: number): IDataObject {
  const options = collectionParameter(context, 'imageOptions', index)
  const result: IDataObject = { ...legacyObjectParameter(context, 'parameters', index) }
  if (typeof options.size === 'string' && options.size) result.size = options.size
  if (typeof options.quality === 'string' && options.quality) result.quality = options.quality
  if (typeof options.numberOfImages === 'number') result.n = options.numberOfImages
  if (typeof options.outputFormat === 'string' && options.outputFormat) result.output_format = options.outputFormat
  if (typeof options.aspectRatio === 'string' && options.aspectRatio) result.aspect_ratio = options.aspectRatio
  if (typeof options.seed === 'number') result.seed = options.seed
  if (typeof options.negativePrompt === 'string' && options.negativePrompt) result.negative_prompt = options.negativePrompt
  if (typeof options.referenceImageUrl === 'string' && options.referenceImageUrl) result.image_url = options.referenceImageUrl
  return result
}

function videoParameters(context: IExecuteFunctions, index: number): IDataObject {
  const options = collectionParameter(context, 'videoOptions', index)
  const result: IDataObject = { ...legacyObjectParameter(context, 'request', index) }
  delete result.model
  if (typeof options.duration === 'number') result.duration = options.duration
  if (typeof options.resolution === 'string' && options.resolution) result.resolution = options.resolution
  if (typeof options.aspectRatio === 'string' && options.aspectRatio) result.aspect_ratio = options.aspectRatio
  if (typeof options.mode === 'string' && options.mode) result.mode = options.mode
  if (typeof options.imageUrl === 'string' && options.imageUrl) result.image_url = options.imageUrl
  if (typeof options.lastFrameUrl === 'string' && options.lastFrameUrl) result.last_frame_url = options.lastFrameUrl
  if (typeof options.inputVideoUrl === 'string' && options.inputVideoUrl) result.input_video_url = options.inputVideoUrl
  if (typeof options.audio === 'boolean') result.audio = options.audio
  if (typeof options.seed === 'number') result.seed = options.seed
  if (typeof options.negativePrompt === 'string' && options.negativePrompt) result.negative_prompt = options.negativePrompt
  return result
}

const modelProperty = (kind: ModelKind, resource: string): INodeTypeDescription['properties'][number] => ({
  displayName: 'Model Name or ID',
  name: 'model',
  type: 'options',
  typeOptions: { loadOptionsMethod: `get${kind[0]!.toUpperCase()}${kind.slice(1)}Models` },
  default: '',
  required: true,
  description:
    'Models your key can call. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
  displayOptions: { show: { resource: [resource] } },
})

export class Modelflare implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'Modelflare',
    name: 'modelflare',
    icon: {
      light: 'file:modelflare.svg',
      dark: 'file:modelflare.dark.svg',
    },
    group: ['transform'],
    version: 1,
    subtitle: '={{$parameter["operation"] + ": " + $parameter["resource"]}}',
    description: 'Chat, image and video generation with one Modelflare Smart API Key',
    defaults: { name: 'Modelflare' },
    usableAsTool: true,
    inputs: [NodeConnectionTypes.Main],
    outputs: [NodeConnectionTypes.Main],
    credentials: [{ name: CREDENTIALS, required: true }],
    properties: [
      {
        displayName: 'Resource',
        name: 'resource',
        type: 'options',
        noDataExpression: true,
        options: [
          { name: 'Text', value: 'text' },
          { name: 'Image', value: 'image' },
          { name: 'Video', value: 'video' },
        ],
        default: 'text',
      },
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        displayOptions: { show: { resource: ['text'] } },
        options: [{ name: 'Message a Model', value: 'message', action: 'Message a model' }],
        default: 'message',
      },
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        displayOptions: { show: { resource: ['image'] } },
        options: [{ name: 'Generate', value: 'generate', action: 'Generate an image' }],
        default: 'generate',
      },
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        displayOptions: { show: { resource: ['video'] } },
        options: [
          { name: 'Generate', value: 'generate', action: 'Generate a video' },
          { name: 'Get Status', value: 'status', action: 'Get the status of a video task' },
          { name: 'Download', value: 'download', action: 'Download a finished video' },
        ],
        default: 'generate',
      },
      modelProperty('text', 'text'),
      modelProperty('image', 'image'),
      { ...modelProperty('video', 'video'), displayOptions: { show: { resource: ['video'], operation: ['generate'] } } },
      {
        displayName: 'Prompt',
        name: 'prompt',
        type: 'string',
        typeOptions: { rows: 4 },
        default: '',
        required: true,
        displayOptions: { show: { resource: ['text', 'image', 'video'], operation: ['message', 'generate'] } },
      },
      {
        displayName: 'System Message',
        name: 'system',
        type: 'string',
        typeOptions: { rows: 2 },
        default: '',
        displayOptions: { show: { resource: ['text'] } },
      },
      {
        displayName: 'Image URL',
        name: 'imageUrl',
        type: 'string',
        default: '',
        placeholder: 'https://example.com/image.png',
        description: 'Optional image input for a vision-capable text model. HTTPS and data URLs are supported by the gateway.',
        displayOptions: { show: { resource: ['text'] } },
      },
      {
        displayName: 'Edit Mode',
        name: 'edit',
        type: 'boolean',
        default: false,
        description:
          'Whether to use the OpenAI-compatible edits route. Native Gemini image models do not support this switch.',
        displayOptions: { show: { resource: ['image'] } },
      },
      {
        displayName: 'Additional Options',
        name: 'textOptions',
        type: 'collection',
        placeholder: 'Add Option',
        default: {},
        displayOptions: { show: { resource: ['text'] } },
        options: [
          {
            displayName: 'Max Output Tokens',
            name: 'maxTokens',
            type: 'number',
            typeOptions: { minValue: 1 },
            default: 1024,
            description: 'Maximum number of tokens to generate. The model-specific limit is published by Modelflare.',
          },
          {
            displayName: 'Reasoning Effort',
            name: 'reasoningEffort',
            type: 'options',
            options: [
              { name: 'Extra High', value: 'xhigh' },
              { name: 'High', value: 'high' },
              { name: 'Low', value: 'low' },
              { name: 'Maximum', value: 'max' },
              { name: 'Medium', value: 'medium' },
              { name: 'Minimal', value: 'minimal' },
              { name: 'None', value: 'none' },
            ],
            default: 'medium',
            description: 'Reasoning level when supported by the selected model',
          },
          {
            displayName: 'Response Format',
            name: 'responseFormat',
            type: 'options',
            options: [
              { name: 'Text', value: 'text' },
              { name: 'JSON Object', value: 'json_object' },
            ],
            default: 'text',
            description: 'Requested response format when supported by the selected model',
          },
          {
            displayName: 'Temperature',
            name: 'temperature',
            type: 'number',
            typeOptions: { minValue: 0, maxValue: 2, numberPrecision: 2 },
            default: 1,
            description: 'Sampling temperature when supported by the selected model',
          },
          {
            displayName: 'Top P',
            name: 'topP',
            type: 'number',
            typeOptions: { minValue: 0, maxValue: 1, numberPrecision: 2 },
            default: 1,
            description: 'Nucleus sampling threshold when supported by the selected model',
          },
        ],
      },
      {
        displayName: 'Additional Options',
        name: 'imageOptions',
        type: 'collection',
        placeholder: 'Add Option',
        default: {},
        displayOptions: { show: { resource: ['image'], operation: ['generate'] } },
        options: [
          {
            displayName: 'Aspect Ratio',
            name: 'aspectRatio',
            type: 'string',
            default: '',
            placeholder: '16:9',
            description: 'Aspect ratio when supported by the selected model',
          },
          {
            displayName: 'Negative Prompt',
            name: 'negativePrompt',
            type: 'string',
            typeOptions: { rows: 2 },
            default: '',
            description: 'Elements to avoid when supported by the selected model',
          },
          {
            displayName: 'Number of Images',
            name: 'numberOfImages',
            type: 'number',
            typeOptions: { minValue: 1, maxValue: 4 },
            default: 1,
          },
          {
            displayName: 'Output Format',
            name: 'outputFormat',
            type: 'options',
            options: [
              { name: 'PNG', value: 'png' },
              { name: 'JPEG', value: 'jpeg' },
              { name: 'WEBP', value: 'webp' },
            ],
            default: 'png',
            description: 'Output image format when supported by the selected model',
          },
          {
            displayName: 'Quality',
            name: 'quality',
            type: 'options',
            options: [
              { name: 'Auto', value: 'auto' },
              { name: 'Low', value: 'low' },
              { name: 'Medium', value: 'medium' },
              { name: 'High', value: 'high' },
            ],
            default: 'auto',
            description: 'Image quality when supported by the selected model',
          },
          {
            displayName: 'Reference Image URL',
            name: 'referenceImageUrl',
            type: 'string',
            default: '',
            placeholder: 'https://example.com/reference.png',
            description: 'Reference or source image URL when supported by the selected model',
          },
          {
            displayName: 'Seed',
            name: 'seed',
            type: 'number',
            default: 0,
            description: 'Deterministic seed when supported by the selected model',
          },
          {
            displayName: 'Size',
            name: 'size',
            type: 'string',
            default: '',
            placeholder: '1024x1024',
            description: 'Output size when supported by the selected model',
          },
        ],
      },
      {
        displayName: 'Additional Options',
        name: 'videoOptions',
        type: 'collection',
        placeholder: 'Add Option',
        default: {},
        displayOptions: { show: { resource: ['video'], operation: ['generate'] } },
        options: [
          {
            displayName: 'Aspect Ratio',
            name: 'aspectRatio',
            type: 'string',
            default: '',
            placeholder: '16:9',
          },
          {
            displayName: 'Duration (Seconds)',
            name: 'duration',
            type: 'number',
            typeOptions: { minValue: -1, maxValue: 30 },
            default: 5,
            description: 'Video duration; some models use -1 to choose the duration automatically',
          },
          {
            displayName: 'First Frame Image URL',
            name: 'imageUrl',
            type: 'string',
            default: '',
            placeholder: 'https://example.com/first-frame.png',
          },
          {
            displayName: 'Generate Audio',
            name: 'audio',
            type: 'boolean',
            default: false,
            description: 'Whether to generate synchronized audio when supported',
          },
          {
            displayName: 'Input Video URL',
            name: 'inputVideoUrl',
            type: 'string',
            default: '',
            placeholder: 'https://example.com/input.mp4',
          },
          {
            displayName: 'Last Frame Image URL',
            name: 'lastFrameUrl',
            type: 'string',
            default: '',
            placeholder: 'https://example.com/last-frame.png',
          },
          {
            displayName: 'Mode',
            name: 'mode',
            type: 'string',
            default: '',
            description: 'Model-specific generation mode',
          },
          {
            displayName: 'Negative Prompt',
            name: 'negativePrompt',
            type: 'string',
            typeOptions: { rows: 2 },
            default: '',
          },
          {
            displayName: 'Resolution',
            name: 'resolution',
            type: 'options',
            options: [
              { name: '480p', value: '480p' },
              { name: '720p', value: '720p' },
              { name: '1080p', value: '1080p' },
              { name: '4K', value: '4k' },
            ],
            default: '720p',
          },
          {
            displayName: 'Seed',
            name: 'seed',
            type: 'number',
            default: 0,
          },
        ],
      },
      {
        displayName: 'Wait (Seconds)',
        name: 'waitSeconds',
        type: 'number',
        typeOptions: { minValue: 0, maxValue: MAX_WAIT_SECONDS },
        default: 300,
        description: 'How long to wait for the video before returning the task ID instead',
        displayOptions: { show: { resource: ['video'], operation: ['generate'] } },
      },
      {
        displayName: 'Task ID',
        name: 'taskId',
        type: 'string',
        default: '',
        required: true,
        displayOptions: { show: { resource: ['video'], operation: ['status', 'download'] } },
      },
      {
        displayName: 'Put Output File in Field',
        name: 'binaryPropertyName',
        type: 'string',
        default: 'data',
        displayOptions: { show: { resource: ['image', 'video'], operation: ['generate', 'download'] } },
      },
    ],
  }

  methods = {
    loadOptions: {
      async getTextModels(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
        return optionsOf(this, 'text')
      },
      async getImageModels(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
        return optionsOf(this, 'image')
      },
      async getVideoModels(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
        return optionsOf(this, 'video')
      },
    },
  }

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData()
    const output: INodeExecutionData[] = []
    for (let index = 0; index < items.length; index++) {
      const resource = this.getNodeParameter('resource', index) as string
      const operation = this.getNodeParameter('operation', index) as string
      const modelId = operation === 'generate' || operation === 'message' ? (this.getNodeParameter('model', index) as string) : undefined
      try {
        output.push(...(await run(this, index, resource, operation, modelId)))
      } catch (error) {
        const message = error instanceof NodeOperationError ? error.message : await explain(this, error, modelId)
        if (this.continueOnFail()) {
          output.push({ json: { error: message }, pairedItem: { item: index } })
          continue
        }
        throw new NodeOperationError(this.getNode(), message, { itemIndex: index })
      }
    }
    return [output]
  }
}

async function run(
  context: IExecuteFunctions,
  index: number,
  resource: string,
  operation: string,
  modelId: string | undefined,
): Promise<INodeExecutionData[]> {
  const pairedItem = { item: index }
  if (resource === 'text') {
    const model = (await classified(context)).models.find(
      (candidate) => candidate.id === modelId && candidate.kind === 'text' && candidate.endpoints.includes('openai'),
    )
    if (!model) {
      throw new NodeOperationError(context.getNode(), `${String(modelId)} is not an authorized Chat Completions model`, {
        itemIndex: index,
      })
    }
    const system = context.getNodeParameter('system', index, '') as string
    const prompt = context.getNodeParameter('prompt', index) as string
    const imageUrl = (context.getNodeParameter('imageUrl', index, '') as string).trim()
    const userContent = imageUrl
      ? [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: imageUrl } },
        ]
      : prompt
    const messages = [
      ...(system ? [{ role: 'system', content: system }] : []),
      { role: 'user', content: userContent },
    ]
    const body = await api<IDataObject>(context, 'POST', 'chat/completions', {
      body: { ...textParameters(context, index), model: model.id, messages },
    })
    const choice = (body.choices as Array<{ message?: { content?: string } }> | undefined)?.[0]
    return [{ json: { content: choice?.message?.content ?? '', model: body.model, usage: body.usage, response: body }, pairedItem }]
  }

  const binaryProperty = () => context.getNodeParameter('binaryPropertyName', index, 'data') as string

  if (resource === 'image') {
    const { models } = await classified(context)
    const model = models.find((candidate) => candidate.id === modelId && candidate.kind === 'image')
    if (!model) {
      throw new NodeOperationError(context.getNode(), `${String(modelId)} is not an authorized image model`, { itemIndex: index })
    }
    const prompt = context.getNodeParameter('prompt', index) as string
    const parameters = imageParameters(context, index)
    const edit = context.getNodeParameter('edit', index, false) as boolean
    if (edit && model.imageRoute !== 'images') {
      throw new NodeOperationError(context.getNode(), `${model.id} does not use the OpenAI-compatible image edits route`, {
        itemIndex: index,
      })
    }
    const files: Array<{ data: Buffer; mimeType: string }> = []
    if (model.imageRoute === 'gemini-generate-content') {
      const { contents, ...rest } = parameters
      const body = await api<{ candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { mimeType?: string; data?: string } }> } }> }>(
        context,
        'POST',
        `models/${encodeURIComponent(model.id)}:generateContent`,
        { body: { contents: contents ?? [{ role: 'user', parts: [{ text: prompt }] }], ...rest } },
      )
      for (const part of body.candidates?.flatMap((candidate) => candidate.content?.parts ?? []) ?? []) {
        if (part.inlineData?.data) files.push({ data: Buffer.from(part.inlineData.data, 'base64'), mimeType: part.inlineData.mimeType ?? 'image/png' })
      }
    } else {
      const body = await api<{ data?: Array<{ b64_json?: string; url?: string }> }>(context, 'POST', edit ? 'images/edits' : 'images/generations', {
        body: { ...parameters, model: model.id, prompt },
      })
      for (const item of body.data ?? []) {
        if (item.b64_json) {
          files.push({ data: Buffer.from(item.b64_json, 'base64'), mimeType: 'image/png' })
        } else if (item.url) {
          // Result URLs expire, so the file is fetched right away.
          const download = await context.helpers.httpRequest({ method: 'GET', url: item.url, encoding: 'arraybuffer', returnFullResponse: true })
          files.push({ data: Buffer.from(download.body as ArrayBuffer), mimeType: String(download.headers?.['content-type'] ?? 'image/png') })
        }
      }
    }
    if (files.length === 0) {
      throw new NodeOperationError(context.getNode(), `${model.id} returned no image`, { itemIndex: index })
    }
    return Promise.all(
      files.map(async (file, position) => ({
        json: { model: model.id },
        binary: { [binaryProperty()]: await context.helpers.prepareBinaryData(file.data, `${model.id}-${position + 1}`, file.mimeType) },
        pairedItem,
      })),
    )
  }

  const download = async (taskId: string, model?: string): Promise<INodeExecutionData> => {
    const response = await api<{ body: ArrayBuffer; headers?: Record<string, string> }>(context, 'GET', `videos/${encodeURIComponent(taskId)}/content`, {
      json: false,
      encoding: 'arraybuffer',
      returnFullResponse: true,
      timeout: 10 * 60 * 1000,
    })
    const mimeType = String(response.headers?.['content-type'] ?? 'video/mp4').split(';')[0] ?? 'video/mp4'
    return {
      json: { task_id: taskId, ...(model ? { model } : {}), status: 'completed' },
      binary: { [binaryProperty()]: await context.helpers.prepareBinaryData(Buffer.from(response.body), `${taskId}.mp4`, mimeType) },
      pairedItem,
    }
  }
  const status = (taskId: string) => api<IDataObject>(context, 'GET', `videos/${encodeURIComponent(taskId)}`)

  if (operation === 'status') {
    return [{ json: await status(context.getNodeParameter('taskId', index) as string), pairedItem }]
  }
  if (operation === 'download') {
    return [await download(context.getNodeParameter('taskId', index) as string)]
  }

  const videoModel = (await classified(context)).models.find((candidate) => candidate.id === modelId && candidate.kind === 'video')
  if (!videoModel) {
    throw new NodeOperationError(context.getNode(), `${String(modelId)} is not an authorized video model`, { itemIndex: index })
  }
  const created = await api<IDataObject>(context, 'POST', 'videos', {
    body: {
      ...videoParameters(context, index),
      model: videoModel.id,
      prompt:
        (context.getNodeParameter('prompt', index, '') as string) ||
        String(legacyObjectParameter(context, 'request', index).prompt ?? ''),
    },
  })
  const taskId = String(created.id ?? created.task_id ?? '')
  if (!taskId) {
    throw new NodeOperationError(context.getNode(), 'The video task response has no id', { itemIndex: index })
  }
  const deadline = Date.now() + Math.min(context.getNodeParameter('waitSeconds', index, 0) as number, MAX_WAIT_SECONDS) * 1000
  let task: IDataObject = created
  while (task.status !== 'completed' && task.status !== 'failed' && Date.now() < deadline) {
    await sleep(5000)
    task = await status(taskId)
  }
  if (task.status === 'failed') {
    const reason = (task.error as { message?: string } | undefined)?.message ?? 'the task failed'
    throw new NodeOperationError(context.getNode(), `Video task ${taskId} failed: ${reason}`, { itemIndex: index })
  }
  if (task.status !== 'completed') return [{ json: { task_id: taskId, status: task.status ?? 'queued' }, pairedItem }]
  return [await download(taskId, videoModel.id)]
}
