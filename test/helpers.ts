import type {
  IDataObject,
  IExecuteFunctions,
  IHookFunctions,
  IHttpRequestOptions,
  INode,
  IWebhookFunctions,
  JsonObject,
} from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';
import { vi } from 'vitest';
import { clock } from '../nodes/Eroq/shared/poll';

export const API_KEY = 'eroq_sk_example';

export const NODE: INode = {
  id: 'node-1',
  name: 'eroq',
  type: 'n8n-nodes-eroq.eroq',
  typeVersion: 1,
  position: [0, 0],
  parameters: {},
};

/** A recorded API call: method, path under /v1, body, query. */
export interface ApiCall {
  method: string;
  url: string;
  path: string;
  body?: unknown;
  qs?: unknown;
}

type Responder = unknown | ((call: ApiCall) => unknown);

/** An HTTP error shaped like the ones axios throws, which n8n then wraps in a NodeApiError. */
export class AxiosError extends Error {
  response: { status: number; headers: Record<string, string>; data: unknown };

  constructor(status: number, data: unknown, headers: Record<string, string> = {}) {
    super(`Request failed with status code ${status}`);
    this.response = { status, headers, data };
  }
}

/** What n8n's httpRequestWithAuthentication throws for an eroq error answer. */
export function apiFailure(status: number, message: string, code: string, headers: Record<string, string> = {}): NodeApiError {
  return new NodeApiError(NODE, new AxiosError(status, { error: { message, type: 'invalid_request_error', code } }, headers) as unknown as JsonObject);
}

/**
 * A fake eroq API: routes are "METHOD /path" (path under /v1); a route given
 * an array answers its entries in turn (the last one repeats), a function is
 * called with the request, an Error is thrown.
 */
export function fakeApi(routes: Record<string, Responder | Responder[]>) {
  const calls: ApiCall[] = [];
  const served = new Map<string, number>();
  const handler = vi.fn(async (credentialType: string, options: IHttpRequestOptions) => {
    if (credentialType !== 'eroqApi') throw new Error(`unexpected credential ${credentialType}`);
    const url = String(options.url);
    const path = url.replace(/^https:\/\/eroq\.ai\/v1/, '');
    const call: ApiCall = { method: String(options.method ?? 'GET'), url, path, body: options.body, qs: options.qs };
    calls.push(call);
    const key = `${call.method} ${path}`;
    const route = routes[key];
    if (route === undefined) throw new Error(`no fake route for ${key}`);
    let responder: Responder = route;
    if (Array.isArray(route)) {
      const index = served.get(key) ?? 0;
      served.set(key, index + 1);
      responder = route[Math.min(index, route.length - 1)];
    }
    const value = typeof responder === 'function' ? (responder as (call: ApiCall) => unknown)(call) : responder;
    if (value instanceof Error) throw value;
    return value;
  });
  return { calls, handler };
}

/** Instant, recorded pauses for the polling loops. */
export function fakeClock() {
  let now = 1_760_000_000_000;
  const pauses: number[] = [];
  vi.spyOn(clock, 'now').mockImplementation(() => now);
  vi.spyOn(clock, 'sleep').mockImplementation(async (ms: number) => {
    pauses.push(ms);
    now += ms;
  });
  return { pauses };
}

interface ExecuteOptions {
  params: IDataObject;
  api: ReturnType<typeof fakeApi>;
  download?: (options: IHttpRequestOptions) => unknown;
  continueOnFail?: boolean;
}

function parameterReader(params: IDataObject) {
  return (name: string, _itemIndex?: unknown, fallback?: unknown) => {
    if (params[name] !== undefined) return params[name];
    if (fallback !== undefined) return fallback;
    throw new Error(`missing parameter ${name}`);
  };
}

export function executeContext(options: ExecuteOptions): IExecuteFunctions {
  const context = {
    getInputData: () => [{ json: {} }],
    getNodeParameter: (name: string, itemIndex: number, fallback?: unknown) => parameterReader(options.params)(name, itemIndex, fallback),
    getNode: () => NODE,
    getCredentials: async () => ({ apiKey: API_KEY, baseUrl: 'https://eroq.ai/v1/' }),
    continueOnFail: () => options.continueOnFail === true,
    getExecutionCancelSignal: () => undefined,
    helpers: {
      httpRequestWithAuthentication: options.api.handler,
      httpRequest: vi.fn(async (request: IHttpRequestOptions) => {
        if (!options.download) throw new Error('no download expected');
        return options.download(request);
      }),
      prepareBinaryData: vi.fn(async (data: Buffer, fileName?: string, mimeType?: string) => ({
        data: data.toString('base64'),
        fileName,
        mimeType: mimeType ?? 'application/octet-stream',
      })),
    },
  };
  return context as unknown as IExecuteFunctions;
}

interface HookOptions {
  params: IDataObject;
  api: ReturnType<typeof fakeApi>;
  staticData: IDataObject;
  webhookUrl?: string;
  workflowName?: string;
}

export const WEBHOOK_URL = 'https://n8n.example.com/webhook/7f0c2c1e-0000-4000-8000-000000000001/webhook';

export function hookContext(options: HookOptions): IHookFunctions {
  const context = {
    getNodeParameter: (name: string, fallback?: unknown) => parameterReader(options.params)(name, undefined, fallback),
    getNode: () => ({ ...NODE, type: 'n8n-nodes-eroq.eroqTrigger', name: 'eroq Trigger' }),
    getNodeWebhookUrl: () => options.webhookUrl ?? WEBHOOK_URL,
    getWorkflowStaticData: () => options.staticData,
    getWorkflow: () => ({ id: 'wf-1', name: options.workflowName ?? 'Post every render', active: true }),
    getCredentials: async () => ({ apiKey: API_KEY, baseUrl: 'https://eroq.ai/v1' }),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    helpers: { httpRequestWithAuthentication: options.api.handler },
  };
  return context as unknown as IHookFunctions;
}

interface WebhookOptions {
  params: IDataObject;
  staticData: IDataObject;
  api?: ReturnType<typeof fakeApi>;
  headers: Record<string, string>;
  rawBody: string;
  /** Leave the raw bytes off the request (n8n versions without rawBody). */
  withoutRawBody?: boolean;
}

export function webhookContext(options: WebhookOptions) {
  const response = {
    status: vi.fn(),
    json: vi.fn(),
  };
  response.status.mockReturnValue(response);
  response.json.mockReturnValue(response);
  const request = options.withoutRawBody ? {} : { rawBody: Buffer.from(options.rawBody, 'utf8') };
  const context = {
    getNodeParameter: (name: string, fallback?: unknown) => parameterReader(options.params)(name, undefined, fallback),
    getNode: () => ({ ...NODE, type: 'n8n-nodes-eroq.eroqTrigger', name: 'eroq Trigger' }),
    getWorkflowStaticData: () => options.staticData,
    getHeaderData: () => options.headers,
    getBodyData: () => JSON.parse(options.rawBody) as IDataObject,
    getRequestObject: () => request,
    getResponseObject: () => response,
    getCredentials: async () => ({ apiKey: API_KEY, baseUrl: 'https://eroq.ai/v1' }),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    helpers: {
      httpRequestWithAuthentication: (options.api ?? fakeApi({})).handler,
      returnJsonArray: (items: IDataObject[]) => items.map(json => ({ json })),
    },
  };
  return { context: context as unknown as IWebhookFunctions, response };
}
