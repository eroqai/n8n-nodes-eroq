import type {
  IAuthenticateGeneric,
  Icon,
  ICredentialTestRequest,
  ICredentialType,
  INodeProperties,
} from 'n8n-workflow';

/**
 * An eroq API key (`eroq_sk_…`, created under Developers → API keys) and the
 * API's base URL. Every request carries the key as a Bearer token; the test
 * reads the workspace balance, which any valid key may do.
 */
export class EroqApi implements ICredentialType {
  name = 'eroqApi';

  // The brand is always written in lowercase (n8n's title-case check would make it "Eroq")
  displayName = `eroq API`;

  icon: Icon = { light: 'file:../nodes/Eroq/eroq.svg', dark: 'file:../nodes/Eroq/eroq.svg' };

  documentationUrl = 'https://eroq.ai/docs/authentication';

  properties: INodeProperties[] = [
    {
      displayName: 'API Key',
      name: 'apiKey',
      type: 'string',
      typeOptions: { password: true },
      required: true,
      default: '',
      placeholder: 'eroq_sk_...',
      description: 'Create one at https://eroq.ai/dashboard/developers',
    },
    {
      displayName: 'Base URL',
      name: 'baseUrl',
      type: 'string',
      default: 'https://eroq.ai/v1',
      description: 'Keep the default unless you run eroq locally (http://localhost:4100/v1)',
    },
  ];

  authenticate: IAuthenticateGeneric = {
    type: 'generic',
    properties: {
      headers: {
        Authorization: '=Bearer {{$credentials.apiKey}}',
      },
    },
  };

  test: ICredentialTestRequest = {
    request: {
      // Tolerates a base URL typed without /v1 or with a trailing slash
      baseURL: '={{ ($credentials.baseUrl || "https://eroq.ai/v1").replace(/\\/+$/, "").replace(/\\/v1$/, "") + "/v1" }}',
      url: '/account',
      method: 'GET',
    },
  };
}
