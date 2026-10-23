import type { IAuthenticateGeneric, ICredentialTestRequest, ICredentialType, Icon, INodeProperties } from 'n8n-workflow'

export class ModelflareApi implements ICredentialType {
  name = 'modelflareApi'

  displayName = 'Modelflare API'

  icon: Icon = {
    light: 'file:../nodes/Modelflare/modelflare.svg',
    dark: 'file:../nodes/Modelflare/modelflare.dark.svg',
  }

  documentationUrl = 'https://docs.modelflare.dev/'

  properties: INodeProperties[] = [
    {
      displayName: 'Smart API Key',
      name: 'apiKey',
      type: 'string',
      typeOptions: { password: true },
      default: '',
      required: true,
      description:
        'Recommended: one Smart API Key calls every model available to your account. Create one under API Keys → Create Smart API Key at https://modelflare.dev/keys. No account yet: https://modelflare.dev/sign-up?utm_source=n8n&utm_medium=plugin&utm_campaign=integrations',
    },
    {
      displayName: 'Base URL',
      name: 'baseUrl',
      type: 'options',
      options: [
        { name: 'Global (https://modelflare.dev/v1)', value: 'https://modelflare.dev/v1' },
        { name: 'China (https://origin.modelflare.dev/v1)', value: 'https://origin.modelflare.dev/v1' },
        { name: 'Custom', value: 'custom' },
      ],
      default: 'https://modelflare.dev/v1',
    },
    {
      displayName: 'Custom Base URL',
      name: 'customBaseUrl',
      type: 'string',
      default: '',
      placeholder: 'https://example.com/v1',
      displayOptions: { show: { baseUrl: ['custom'] } },
    },
  ]

  authenticate: IAuthenticateGeneric = {
    type: 'generic',
    properties: {
      headers: { Authorization: '=Bearer {{$credentials.apiKey}}' },
    },
  }

  test: ICredentialTestRequest = {
    request: {
      baseURL: '={{$credentials.baseUrl === "custom" ? $credentials.customBaseUrl : $credentials.baseUrl}}',
      url: '/models',
    },
  }
}
