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
import { classifyModels, type CatalogEntry, type ClassifiedModel, type ModelKind, type ModelListEntry } from './core/classify.js'
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
  const list = await api<{ data?: ModelListEntry[] }>(context, 'GET', 'models')
  const entries = Array.isArray(list.data) ? list.data : []
  let catalog: CatalogEntry[] | null = null
  try {
    const body = (await context.helpers.httpRequest({ method: 'GET', url: CATALOG_URL, json: true })) as { data?: CatalogEntry[] }
    catalog = Array.isArray(body.data) ? body.data : null
  } catch {
    catalog = null
  }
  return { models: classifyModels(entries, catalog), listed: new Set(entries.map((entry) => entry.id)) }
}

async function optionsOf(context: ILoadOptionsFunctions, kind: ModelKind): Promise<INodePropertyOptions[]> {
  const { models } = await classified(context)
  return models.filter((model) => model.kind === kind).map((model) => ({ name: model.id, value: model.id }))
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

function jsonParameter(context: IExecuteFunctions, name: string, index: number): IDataObject {
  const value = context.getNodeParameter(name, index, {}) as unknown
  if (typeof value === 'string') {
    if (value.trim() === '') return {}
    try {
      const parsed = JSON.parse(value) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as IDataObject
    } catch {
      // Reported below.
    }
    throw new NodeOperationError(context.getNode(), `${name} must be a JSON object`, { itemIndex: index })
  }
  return value && typeof value === 'object' ? (value as IDataObject) : {}
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
    icon: 'file:modelflare.svg',
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
        displayOptions: { show: { resource: ['text', 'image'] } },
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
        displayName: 'Edit Mode',
        name: 'edit',
        type: 'boolean',
        default: false,
        description: "Whether to use the edits route. Put the source images in the parameters as the model's docs page describes.",
        displayOptions: { show: { resource: ['image'] } },
      },
      {
        displayName: 'Parameters (JSON)',
        name: 'parameters',
        type: 'json',
        default: '{}',
        description:
          "Model-specific fields sent unchanged, for example temperature for text or size for images. Each model's fields are on its page at https://docs.modelflare.dev/models/.",
        displayOptions: { show: { resource: ['text', 'image'] } },
      },
      {
        displayName: 'Request (JSON)',
        name: 'request',
        type: 'json',
        default: '{\n  "prompt": ""\n}',
        required: true,
        description: "The request body from the model's page at https://docs.modelflare.dev/models/video/. The model field is set for you.",
        displayOptions: { show: { resource: ['video'], operation: ['generate'] } },
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
    const system = context.getNodeParameter('system', index, '') as string
    const messages = [
      ...(system ? [{ role: 'system', content: system }] : []),
      { role: 'user', content: context.getNodeParameter('prompt', index) as string },
    ]
    const body = await api<IDataObject>(context, 'POST', 'chat/completions', {
      body: { ...jsonParameter(context, 'parameters', index), model: modelId, messages },
    })
    const choice = (body.choices as Array<{ message?: { content?: string } }> | undefined)?.[0]
    return [{ json: { content: choice?.message?.content ?? '', model: body.model, usage: body.usage, response: body }, pairedItem }]
  }

  const binaryProperty = () => context.getNodeParameter('binaryPropertyName', index, 'data') as string

  if (resource === 'image') {
    const { models } = await classified(context)
    const model = models.find((candidate) => candidate.id === modelId && candidate.kind === 'image')
    if (!model) throw new ModelflareError({ kind: 'model_not_found', message: String(modelId) })
    const prompt = context.getNodeParameter('prompt', index) as string
    const parameters = jsonParameter(context, 'parameters', index)
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
      const edit = context.getNodeParameter('edit', index, false) as boolean
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
    if (files.length === 0) throw new ModelflareError({ kind: 'upstream', message: `${model.id} returned no image` })
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

  const created = await api<IDataObject>(context, 'POST', 'videos', {
    body: { ...jsonParameter(context, 'request', index), model: modelId },
  })
  const taskId = String(created.id ?? created.task_id ?? '')
  if (!taskId) throw new ModelflareError({ kind: 'upstream', message: 'The video task response has no id' })
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
  return [await download(taskId, modelId)]
}
