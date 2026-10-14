import { createHmac } from 'node:crypto';
import type { IDataObject } from 'n8n-workflow';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EroqTrigger, subscriptionLabel } from '../nodes/Eroq/EroqTrigger.node';
import { verifySignature } from '../nodes/Eroq/shared/signature';
import { apiFailure, fakeApi, hookContext, WEBHOOK_URL, webhookContext } from './helpers';

const FLOW_ID = '3f1c8a52-5a8e-4d1e-9a51-0d7f0d6f1a11';
const SUBSCRIPTION_ID = '0d9c8b7a-6f5e-4d3c-2b1a-098765432100';
const STALE_ID = '11111111-2222-4333-8444-555555555555';
const SIGNING_VALUE = 'whsec_example_signing_value_for_tests';

const PARAMS = { events: ['flow.run.succeeded', 'flow.run.failed'], flowId: FLOW_ID };

afterEach(() => {
  vi.restoreAllMocks();
});

describe('eroq Trigger: subscription lifecycle', () => {
  it('create() removes a leftover subscription of its URL, subscribes, and keeps the secret', async () => {
    const api = fakeApi({
      'GET /webhooks': {
        object: 'list',
        webhooks: [
          { id: STALE_ID, url: WEBHOOK_URL, events: ['flow.run.succeeded'], flowId: null, enabled: true },
          { id: 'zap-1', url: 'https://hooks.zapier.com/hooks/standard/1/abc', events: ['flow.run.succeeded'], flowId: null, enabled: true },
        ],
      },
      [`DELETE /webhooks/${STALE_ID}`]: { ok: true, id: STALE_ID },
      'POST /webhooks': call => ({
        ...(call.body as IDataObject),
        id: SUBSCRIPTION_ID,
        flowId: FLOW_ID,
        enabled: true,
        createdAt: '2026-10-09T10:00:00.000Z',
        secret: SIGNING_VALUE,
      }),
    });
    const staticData: IDataObject = {};
    const context = hookContext({ api, staticData, params: PARAMS, workflowName: 'Post every render' });

    expect(await new EroqTrigger().webhookMethods.default.create.call(context)).toBe(true);

    expect(api.calls.map(call => `${call.method} ${call.path}`)).toEqual(['GET /webhooks', `DELETE /webhooks/${STALE_ID}`, 'POST /webhooks']);
    expect(api.calls[2].body).toEqual({
      url: WEBHOOK_URL,
      events: ['flow.run.failed', 'flow.run.succeeded'],
      flow_id: FLOW_ID,
      label: 'n8n · Post every render',
    });
    expect(staticData).toEqual({ webhookId: SUBSCRIPTION_ID, webhookSecret: SIGNING_VALUE });
  });

  it('create() also removes the subscription it stored under a previous public URL', async () => {
    const api = fakeApi({
      'GET /webhooks': {
        object: 'list',
        webhooks: [{ id: STALE_ID, url: 'https://old-n8n.example.com/webhook/x/webhook', events: ['flow.run.succeeded'], flowId: null, enabled: true }],
      },
      [`DELETE /webhooks/${STALE_ID}`]: { ok: true, id: STALE_ID },
      'POST /webhooks': { id: SUBSCRIPTION_ID, url: WEBHOOK_URL, events: ['flow.run.succeeded'], flowId: null, enabled: true, secret: SIGNING_VALUE },
    });
    const staticData: IDataObject = { webhookId: STALE_ID, webhookSecret: 'whsec_example_previous_value' };
    await new EroqTrigger().webhookMethods.default.create.call(hookContext({ api, staticData, params: { events: ['flow.run.succeeded'], flowId: '' } }));
    expect(api.calls.map(call => `${call.method} ${call.path}`)).toEqual(['GET /webhooks', `DELETE /webhooks/${STALE_ID}`, 'POST /webhooks']);
    expect(api.calls[2].body).not.toHaveProperty('flow_id');
    expect(staticData).toEqual({ webhookId: SUBSCRIPTION_ID, webhookSecret: SIGNING_VALUE });
  });

  it('create() surfaces eroq\'s refusal of a non-HTTPS n8n URL', async () => {
    const api = fakeApi({
      'GET /webhooks': { object: 'list', webhooks: [] },
      'POST /webhooks': apiFailure(400, 'url: Webhook URLs must be https.', 'invalid_url'),
    });
    const context = hookContext({ api, staticData: {}, params: PARAMS, webhookUrl: 'http://localhost:5678/webhook/x/webhook' });
    await expect(new EroqTrigger().webhookMethods.default.create.call(context)).rejects.toThrow('url: Webhook URLs must be https.');
  });

  it('checkExists() keeps the stored subscription while it matches, and drops it once the settings change', async () => {
    const listed = { id: SUBSCRIPTION_ID, url: WEBHOOK_URL, events: ['flow.run.succeeded', 'flow.run.failed'], flowId: FLOW_ID, enabled: true };
    const api = fakeApi({ 'GET /webhooks': { object: 'list', webhooks: [listed] } });
    const staticData: IDataObject = { webhookId: SUBSCRIPTION_ID, webhookSecret: SIGNING_VALUE };
    const trigger = new EroqTrigger();

    expect(await trigger.webhookMethods.default.checkExists.call(hookContext({ api, staticData, params: PARAMS }))).toBe(true);
    const narrower = { ...PARAMS, events: ['flow.run.succeeded'] };
    expect(await trigger.webhookMethods.default.checkExists.call(hookContext({ api, staticData, params: narrower }))).toBe(false);
    const otherFlow = { ...PARAMS, flowId: '' };
    expect(await trigger.webhookMethods.default.checkExists.call(hookContext({ api, staticData, params: otherFlow }))).toBe(false);
  });

  it('checkExists() reads a flow filter stored inside the events list', async () => {
    const listed = { id: SUBSCRIPTION_ID, url: WEBHOOK_URL, events: ['flow.run.failed', 'flow.run.succeeded', `flow:${FLOW_ID}`], enabled: true };
    const api = fakeApi({ 'GET /webhooks': { object: 'list', webhooks: [listed] } });
    const staticData: IDataObject = { webhookId: SUBSCRIPTION_ID, webhookSecret: SIGNING_VALUE };
    expect(await new EroqTrigger().webhookMethods.default.checkExists.call(hookContext({ api, staticData, params: PARAMS }))).toBe(true);
  });

  it('checkExists() is false without a stored secret, without asking eroq', async () => {
    const api = fakeApi({});
    const context = hookContext({ api, staticData: { webhookId: SUBSCRIPTION_ID }, params: PARAMS });
    expect(await new EroqTrigger().webhookMethods.default.checkExists.call(context)).toBe(false);
    expect(api.calls).toHaveLength(0);
  });

  it('delete() unsubscribes and forgets the subscription', async () => {
    const api = fakeApi({ [`DELETE /webhooks/${SUBSCRIPTION_ID}`]: { ok: true, id: SUBSCRIPTION_ID } });
    const staticData: IDataObject = { webhookId: SUBSCRIPTION_ID, webhookSecret: SIGNING_VALUE };
    expect(await new EroqTrigger().webhookMethods.default.delete.call(hookContext({ api, staticData, params: PARAMS }))).toBe(true);
    expect(api.calls.map(call => `${call.method} ${call.path}`)).toEqual([`DELETE /webhooks/${SUBSCRIPTION_ID}`]);
    expect(staticData).toEqual({});
  });

  it('delete() treats a subscription already gone (404) as deleted', async () => {
    const api = fakeApi({ [`DELETE /webhooks/${SUBSCRIPTION_ID}`]: apiFailure(404, 'No such webhook in this workspace.', 'not_found') });
    const staticData: IDataObject = { webhookId: SUBSCRIPTION_ID, webhookSecret: SIGNING_VALUE };
    expect(await new EroqTrigger().webhookMethods.default.delete.call(hookContext({ api, staticData, params: PARAMS }))).toBe(true);
    expect(staticData).toEqual({});
  });

  it('delete() keeps the subscription on record when eroq cannot be reached', async () => {
    const api = fakeApi({ [`DELETE /webhooks/${SUBSCRIPTION_ID}`]: apiFailure(503, 'eroq is restarting, retry in a minute.', 'unavailable') });
    const staticData: IDataObject = { webhookId: SUBSCRIPTION_ID, webhookSecret: SIGNING_VALUE };
    await expect(new EroqTrigger().webhookMethods.default.delete.call(hookContext({ api, staticData, params: PARAMS })))
      .rejects.toThrow('eroq is restarting, retry in a minute.');
    expect(staticData.webhookId).toBe(SUBSCRIPTION_ID);
  });

  it('labels the subscription after the workflow, within 80 characters', () => {
    expect(subscriptionLabel('Post every render')).toBe('n8n · Post every render');
    expect(subscriptionLabel('x'.repeat(200))).toHaveLength(80);
    expect(subscriptionLabel('')).toBe('n8n · workflow');
  });
});

/** Signs a body exactly like eroq's server does (server/utils/webhooks.ts). */
function eroqSignature(body: string, timestamp: number, signingValue = SIGNING_VALUE): string {
  const v1 = createHmac('sha256', signingValue).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${v1}`;
}

function delivery(type: string, flowId = FLOW_ID): string {
  return JSON.stringify({
    id: 'evt_0123456789abcdef',
    type,
    created: Math.floor(Date.now() / 1000),
    data: {
      flow: { id: flowId, name: 'Post every render' },
      run: { id: 'r1', status: 'done', source: 'api', credits: 45, startedAt: '2026-10-09T10:00:00.000Z', finishedAt: '2026-10-09T10:01:30.000Z', inputs: { prompt: 'A latte' } },
      outputs: [{ step: 2, nodeId: 'clip', type: 'generate.video', kind: 'video', url: 'https://cdn.example.com/clip.mp4', creationId: 'c1' }],
    },
  });
}

const now = () => Math.floor(Date.now() / 1000);
const STORED: IDataObject = { webhookId: SUBSCRIPTION_ID, webhookSecret: SIGNING_VALUE };

describe('eroq Trigger: deliveries', () => {
  it('starts the workflow with a correctly signed event', async () => {
    const body = delivery('flow.run.succeeded');
    const { context, response } = webhookContext({
      params: PARAMS,
      staticData: { ...STORED },
      rawBody: body,
      headers: { 'eroq-signature': eroqSignature(body, now()), 'eroq-webhook-id': SUBSCRIPTION_ID },
    });
    const result = await new EroqTrigger().webhook.call(context);
    expect(response.status).not.toHaveBeenCalled();
    expect(result.workflowData?.[0][0].json).toMatchObject({ type: 'flow.run.succeeded', data: { outputs: [{ kind: 'video' }] } });
  });

  it('answers 401 to a body that does not match its signature', async () => {
    const body = delivery('flow.run.succeeded');
    const tampered = body.replace('A latte', 'Something else');
    const { context, response } = webhookContext({
      params: PARAMS,
      staticData: { ...STORED },
      rawBody: tampered,
      headers: { 'eroq-signature': eroqSignature(body, now()) },
    });
    const result = await new EroqTrigger().webhook.call(context);
    expect(result).toEqual({ noWebhookResponse: true });
    expect(response.status).toHaveBeenCalledWith(401);
  });

  it('answers 401 to a signature made with another secret', async () => {
    const body = delivery('flow.run.succeeded');
    const { context, response } = webhookContext({
      params: PARAMS,
      staticData: { ...STORED },
      rawBody: body,
      headers: { 'eroq-signature': eroqSignature(body, now(), 'whsec_example_some_other_value') },
    });
    await new EroqTrigger().webhook.call(context);
    expect(response.status).toHaveBeenCalledWith(401);
  });

  it('answers 401 to a replay older than five minutes', async () => {
    const body = delivery('flow.run.succeeded');
    const { context, response } = webhookContext({
      params: PARAMS,
      staticData: { ...STORED },
      rawBody: body,
      headers: { 'eroq-signature': eroqSignature(body, now() - 301) },
    });
    await new EroqTrigger().webhook.call(context);
    expect(response.status).toHaveBeenCalledWith(401);
  });

  it('answers 410 to another subscription of the same URL once its own is confirmed alive, so eroq deletes the other', async () => {
    const body = delivery('flow.run.succeeded');
    const api = fakeApi({
      'GET /webhooks': {
        object: 'list',
        webhooks: [
          { id: SUBSCRIPTION_ID, url: WEBHOOK_URL, events: ['flow.run.failed', 'flow.run.succeeded'], flowId: FLOW_ID, enabled: true },
          { id: STALE_ID, url: WEBHOOK_URL, events: ['flow.run.succeeded'], flowId: null, enabled: true },
        ],
      },
    });
    const { context, response } = webhookContext({
      api,
      params: PARAMS,
      staticData: { ...STORED },
      rawBody: body,
      headers: { 'eroq-signature': eroqSignature(body, now(), 'whsec_example_old_value'), 'eroq-webhook-id': STALE_ID },
    });
    const result = await new EroqTrigger().webhook.call(context);
    expect(result).toEqual({ noWebhookResponse: true });
    expect(response.status).toHaveBeenCalledWith(410);
  });

  it('never answers 410 while its own stored subscription is not on eroq (activation still being saved)', async () => {
    const body = delivery('flow.run.succeeded');
    const api = fakeApi({
      'GET /webhooks': { object: 'list', webhooks: [{ id: STALE_ID, url: WEBHOOK_URL, events: ['flow.run.succeeded'], flowId: null, enabled: true }] },
    });
    const { context, response } = webhookContext({
      api,
      params: PARAMS,
      staticData: { ...STORED },
      rawBody: body,
      headers: { 'eroq-signature': eroqSignature(body, now(), 'whsec_example_newer_value'), 'eroq-webhook-id': STALE_ID },
    });
    await new EroqTrigger().webhook.call(context);
    expect(response.status).toHaveBeenCalledWith(401);
    expect(response.status).not.toHaveBeenCalledWith(410);
  });

  it('verifies against the re-serialized body when n8n kept no raw bytes', async () => {
    const body = delivery('flow.run.failed');
    const { context, response } = webhookContext({
      params: PARAMS,
      staticData: { ...STORED },
      rawBody: body,
      withoutRawBody: true,
      headers: { 'eroq-signature': eroqSignature(body, now()) },
    });
    const result = await new EroqTrigger().webhook.call(context);
    expect(response.status).not.toHaveBeenCalled();
    expect(result.workflowData).toHaveLength(1);
  });

  it('acknowledges but does not run for another flow\'s events', async () => {
    const body = delivery('flow.run.succeeded', 'another-flow');
    const { context } = webhookContext({
      params: PARAMS,
      staticData: { ...STORED },
      rawBody: body,
      headers: { 'eroq-signature': eroqSignature(body, now()) },
    });
    const result = await new EroqTrigger().webhook.call(context);
    expect(result.workflowData).toBeUndefined();
    expect(result.webhookResponse).toEqual({ received: true, ignored: 'flow.run.succeeded' });
  });
});

describe('verifySignature', () => {
  const body = '{"id":"evt_1","type":"image.generation.succeeded"}';
  const t = 1_760_000_000;

  it('accepts eroq\'s header, including a second v1 during a secret rotation', () => {
    const header = `${eroqSignature(body, t)},v1=${'0'.repeat(64)}`;
    expect(verifySignature({ secret: SIGNING_VALUE, header, body, nowSeconds: t + 299 })).toEqual({ valid: true });
    expect(verifySignature({ secret: SIGNING_VALUE, header, body: Buffer.from(body), nowSeconds: t - 299 })).toEqual({ valid: true });
  });

  it('refuses a missing or malformed header and an empty secret', () => {
    expect(verifySignature({ secret: SIGNING_VALUE, header: undefined, body, nowSeconds: t }).valid).toBe(false);
    expect(verifySignature({ secret: SIGNING_VALUE, header: 't=abc,v1=xyz', body, nowSeconds: t }).valid).toBe(false);
    expect(verifySignature({ secret: '', header: eroqSignature(body, t), body, nowSeconds: t }).valid).toBe(false);
  });
});
