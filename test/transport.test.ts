import type { JsonObject } from 'n8n-workflow';
import { NodeApiError } from 'n8n-workflow';
import { describe, expect, it } from 'vitest';
import { eroqApiError, normalizeBaseUrl, readEroqError } from '../nodes/Eroq/shared/transport';
import { apiFailure, AxiosError, NODE } from './helpers';

describe('normalizeBaseUrl', () => {
  it('always ends in /v1, without a trailing slash', () => {
    expect(normalizeBaseUrl('https://eroq.ai/v1')).toBe('https://eroq.ai/v1');
    expect(normalizeBaseUrl('https://eroq.ai/v1/')).toBe('https://eroq.ai/v1');
    expect(normalizeBaseUrl('https://eroq.ai')).toBe('https://eroq.ai/v1');
    expect(normalizeBaseUrl(' http://localhost:4100/v1 ')).toBe('http://localhost:4100/v1');
    expect(normalizeBaseUrl('')).toBe('https://eroq.ai/v1');
    expect(normalizeBaseUrl(undefined)).toBe('https://eroq.ai/v1');
  });
});

describe('eroq errors', () => {
  it('puts eroq\'s message first on what n8n\'s HTTP helper throws', () => {
    const error = eroqApiError(NODE, apiFailure(402, 'Not enough credits: this render needs 60, the workspace has 12.', 'insufficient_credits'), 0);
    expect(error).toBeInstanceOf(NodeApiError);
    expect(error.message).toBe('Not enough credits: this render needs 60, the workspace has 12.');
    expect(error.httpCode).toBe('402');
    expect(error.description).toContain('https://eroq.ai/dashboard/billing');
    expect(error.description).toContain('insufficient_credits');
    expect(error.context.itemIndex).toBe(0);
  });

  it('reads Retry-After on a 429', () => {
    const failure = apiFailure(429, 'Too many runs at once.', 'rate_limited', { 'retry-after': '20' });
    const error = eroqApiError(NODE, failure);
    expect(error.message).toBe('Too many runs at once.');
    expect(error.description).toContain('retry after 20 seconds');
  });

  it('explains plan and role refusals', () => {
    expect(eroqApiError(NODE, apiFailure(403, 'Publishing a flow comes with the Studio plan.', 'plan_required')).description).toContain('https://eroq.ai/pricing');
    expect(eroqApiError(NODE, apiFailure(403, 'This workspace role cannot build or run flows.', 'role_forbidden')).description).toContain('workspace admin');
  });

  it('reads a bare axios-style error too', () => {
    const info = readEroqError(new AxiosError(401, { error: { message: 'Invalid API key.', type: 'authentication_error', code: 'invalid_api_key' } }));
    expect(info).toEqual({ status: 401, body: { message: 'Invalid API key.', type: 'authentication_error', code: 'invalid_api_key' } });
  });

  it('leaves errors that are not eroq answers to n8n', () => {
    const offline = new NodeApiError(NODE, Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:4100'), { code: 'ECONNREFUSED' }) as unknown as JsonObject);
    expect(eroqApiError(NODE, offline)).toBe(offline);
  });
});
