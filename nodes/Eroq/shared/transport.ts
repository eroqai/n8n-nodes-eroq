import type {
  IDataObject,
  IExecuteFunctions,
  IHookFunctions,
  IHttpRequestMethods,
  IHttpRequestOptions,
  ILoadOptionsFunctions,
  INode,
  IWebhookFunctions,
  JsonObject,
} from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';
import { version } from '../../../package.json';

/** Every context that calls the eroq API with the node's credential. */
export type EroqContext = IExecuteFunctions | ILoadOptionsFunctions | IHookFunctions | IWebhookFunctions;

export const CREDENTIAL_NAME = 'eroqApi';
export const DEFAULT_BASE_URL = 'https://eroq.ai/v1';
const USER_AGENT = `eroq-n8n/${version}`;

/** The credential's base URL, without a trailing slash and always ending in /v1. */
export function normalizeBaseUrl(raw: unknown): string {
  const value = typeof raw === 'string' && raw.trim() ? raw.trim() : DEFAULT_BASE_URL;
  const bare = value.replace(/\/+$/, '').replace(/\/v1$/, '');
  return `${bare}/v1`;
}

/** One JSON call to /v1. eroq's own error message becomes the NodeApiError message. */
export async function eroqApiRequest<T = IDataObject>(
  this: EroqContext,
  method: IHttpRequestMethods,
  path: string,
  body?: IDataObject,
  qs?: IDataObject,
  itemIndex?: number,
): Promise<T> {
  const credentials = await this.getCredentials(CREDENTIAL_NAME);
  const options: IHttpRequestOptions = {
    method,
    url: `${normalizeBaseUrl(credentials.baseUrl)}${path}`,
    json: true,
    headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' },
  };
  if (body !== undefined) options.body = body;
  if (qs !== undefined) options.qs = qs;
  try {
    return (await this.helpers.httpRequestWithAuthentication.call(this, CREDENTIAL_NAME, options)) as T;
  }
  catch (error) {
    throw eroqApiError(this.getNode(), error, itemIndex);
  }
}

// ---- errors ----------------------------------------------------------------------

interface EroqErrorBody {
  message: string;
  type?: string;
  code?: string;
}

export interface EroqErrorInfo {
  status?: number;
  retryAfter?: string;
  body?: EroqErrorBody;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}

/** `{ "error": { "message", "type", "code" } }`, from an object or its JSON text. */
function errorBody(value: unknown): EroqErrorBody | undefined {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    }
    catch {
      return undefined;
    }
  }
  const inner = record(record(parsed)?.error);
  const message = text(inner?.message);
  return message ? { message, type: text(inner?.type), code: text(inner?.code) } : undefined;
}

/**
 * Digs eroq's error out of whatever the HTTP helper threw: an axios-style
 * error (`response.status` / `response.data`), the NodeApiError n8n wraps it
 * in (`httpCode`, `context.data`, `cause`), or a legacy request error
 * (`statusCode`, `error`).
 */
export function readEroqError(error: unknown): EroqErrorInfo {
  const info: EroqErrorInfo = {};
  const queue: unknown[] = [error];
  const seen = new Set<unknown>();
  while (queue.length && seen.size < 8) {
    const current = record(queue.shift());
    if (!current || seen.has(current)) continue;
    seen.add(current);
    const response = record(current.response);
    if (info.status === undefined) {
      const status = Number(response?.status ?? response?.statusCode ?? current.httpCode ?? current.statusCode);
      if (Number.isInteger(status) && status >= 100 && status < 600) info.status = status;
    }
    const headers = record(response?.headers);
    if (info.retryAfter === undefined && headers) {
      const value = headers['retry-after'] ?? headers['Retry-After'];
      if (value !== undefined && value !== null) info.retryAfter = String(value);
    }
    if (!info.body) {
      for (const candidate of [response?.data, response?.body, record(current.context)?.data, current.error, current.errorResponse]) {
        const body = errorBody(candidate);
        if (body) {
          info.body = body;
          break;
        }
      }
    }
    queue.push(current.cause, current.reason);
  }
  return info;
}

const HINTS_BY_CODE: Record<string, string> = {
  plan_required: 'This needs a higher eroq plan: https://eroq.ai/pricing',
  role_forbidden: 'Your role in this eroq workspace does not allow it. Ask a workspace admin.',
  flow_not_published: 'Publish the flow in the eroq studio first: only published flows start from outside.',
};

const HINTS_BY_STATUS: Record<number, string> = {
  401: 'Check the API key of the eroq credential (https://eroq.ai/dashboard/developers).',
  402: 'Not enough credits on the workspace. Top up at https://eroq.ai/dashboard/billing',
  404: 'Check the ID: it does not exist in this workspace (or has expired).',
};

/** A short next step for the error, with eroq's code when there is one. */
export function describeEroqError(info: EroqErrorInfo): string | undefined {
  const code = info.body?.code;
  const parts: string[] = [];
  const hint = (code && HINTS_BY_CODE[code]) || (info.status !== undefined ? HINTS_BY_STATUS[info.status] : undefined);
  if (hint) parts.push(hint);
  if (info.status === 429) {
    parts.push(info.retryAfter ? `Rate limited: retry after ${info.retryAfter} seconds.` : 'Rate limited: retry in a moment.');
  }
  if (code) parts.push(`eroq error code: ${code}`);
  return parts.length ? parts.join(' ') : undefined;
}

/** The NodeApiError for a failed call, carrying eroq's `error.message`. */
export function eroqApiError(node: INode, error: unknown, itemIndex?: number): NodeApiError {
  const info = readEroqError(error);
  if (!info.body) {
    // Not an eroq answer (network failure, proxy page…): keep n8n's own reading of it
    return new NodeApiError(node, error as JsonObject, itemIndex === undefined ? {} : { itemIndex });
  }
  const httpCode = info.status === undefined ? undefined : String(info.status);
  return new NodeApiError(node, { ...info.body } as unknown as JsonObject, {
    message: info.body.message,
    description: describeEroqError(info),
    httpCode,
    itemIndex,
  });
}
