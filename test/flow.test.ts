import { NodeApiError } from 'n8n-workflow';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Eroq } from '../nodes/Eroq/Eroq.node';
import { apiFailure, executeContext, fakeApi, fakeClock } from './helpers';

const FLOW_ID = '3f1c8a52-5a8e-4d1e-9a51-0d7f0d6f1a11';
const RUN_ID = '9b2d6f10-1c2b-4f7e-8a3d-5e6f7a8b9c0d';
const RUN_PATH = `/flows/${FLOW_ID}/runs/${RUN_ID}`;

function run(status: string, extra: Record<string, unknown> = {}) {
  return {
    id: RUN_ID,
    flowId: FLOW_ID,
    status,
    source: 'api',
    results: {},
    credits: 0,
    startedAt: '2026-10-09T10:00:00.000Z',
    finishedAt: null,
    ...extra,
  };
}

const RUN_PARAMS = {
  resource: 'flow',
  operation: 'run',
  flowId: FLOW_ID,
  prompt: '  A barista slides a latte across the counter ',
  waitForCompletion: true,
  timeout: 600,
  options: {},
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Flow > Run', () => {
  it('starts the run with its inputs, then polls it every 5 seconds until it is done', async () => {
    const { pauses } = fakeClock();
    const done = run('done', {
      credits: 45,
      finishedAt: '2026-10-09T10:01:30.000Z',
      results: { clip: { status: 'done', output: 'video', url: 'https://cdn.example.com/clip.mp4' } },
    });
    const api = fakeApi({
      [`POST /flows/${FLOW_ID}/runs`]: { run: run('running'), poll: `/v1${RUN_PATH}` },
      [`GET ${RUN_PATH}`]: [{ run: run('running') }, { run: run('running') }, { run: done }],
    });
    const context = executeContext({
      api,
      params: {
        ...RUN_PARAMS,
        options: {
          trigger: 'manual',
          imageUrl: 'https://example.com/cup.png',
          payload: '{"sku":"A-1"}',
          callbackUrl: 'https://n8n.example.com/webhook-waiting/42',
        },
      },
    });

    const [items] = await new Eroq().execute.call(context);

    expect(api.calls[0]).toMatchObject({
      method: 'POST',
      url: `https://eroq.ai/v1/flows/${FLOW_ID}/runs`,
      body: {
        trigger: 'manual',
        inputs: {
          prompt: 'A barista slides a latte across the counter',
          image_url: 'https://example.com/cup.png',
          payload: { sku: 'A-1' },
        },
        callback_url: 'https://n8n.example.com/webhook-waiting/42',
      },
    });
    const [credentialType, request] = api.handler.mock.calls[0];
    expect(credentialType).toBe('eroqApi');
    expect(request.headers).toMatchObject({ 'User-Agent': expect.stringMatching(/^eroq-n8n\/\d+\.\d+\.\d+$/) });
    expect(api.calls.filter(call => call.method === 'GET' && call.path === RUN_PATH)).toHaveLength(3);
    expect(pauses).toEqual([5000, 5000]);
    expect(items).toHaveLength(1);
    expect(items[0].json).toMatchObject({ id: RUN_ID, status: 'done', credits: 45 });
    expect(items[0].pairedItem).toEqual({ item: 0 });
  });

  it('sends only what was filled in', async () => {
    fakeClock();
    const api = fakeApi({
      [`POST /flows/${FLOW_ID}/runs`]: { run: run('running'), poll: `/v1${RUN_PATH}` },
      [`GET ${RUN_PATH}`]: { run: run('done') },
    });
    await new Eroq().execute.call(executeContext({ api, params: { ...RUN_PARAMS, prompt: '', options: { payload: '{}' } } }));
    expect(api.calls[0].body).toEqual({});
  });

  it('returns at once with the poll path when not waiting', async () => {
    const api = fakeApi({
      [`POST /flows/${FLOW_ID}/runs`]: { run: run('running'), poll: `/v1${RUN_PATH}` },
    });
    const [items] = await new Eroq().execute.call(executeContext({ api, params: { ...RUN_PARAMS, waitForCompletion: false } }));
    expect(api.calls).toHaveLength(1);
    expect(items[0].json).toMatchObject({ id: RUN_ID, status: 'running', poll: `/v1${RUN_PATH}` });
  });

  it('returns a run that waits on a post in the studio without waiting further', async () => {
    const { pauses } = fakeClock();
    const waiting = run('waiting', { waiting: { nodeId: 'post', creationId: 'c1', caption: 'Morning ritual', platforms: ['tiktok'] } });
    const api = fakeApi({
      [`POST /flows/${FLOW_ID}/runs`]: { run: run('running'), poll: `/v1${RUN_PATH}` },
      [`GET ${RUN_PATH}`]: [{ run: run('running') }, { run: waiting }],
    });
    const [items] = await new Eroq().execute.call(executeContext({ api, params: RUN_PARAMS }));
    expect(pauses).toEqual([5000]);
    expect(items[0].json).toMatchObject({ status: 'waiting', waiting: { caption: 'Morning ritual' } });
  });

  it('fails with the words of the step that failed', async () => {
    fakeClock();
    const failed = run('failed', { results: { clip: { status: 'failed', error: 'The engine refused this picture' } } });
    const api = fakeApi({
      [`POST /flows/${FLOW_ID}/runs`]: { run: run('running'), poll: `/v1${RUN_PATH}` },
      [`GET ${RUN_PATH}`]: { run: failed },
    });
    await expect(new Eroq().execute.call(executeContext({ api, params: RUN_PARAMS })))
      .rejects.toThrow('The flow run failed: The engine refused this picture');
  });

  it('gives up after the timeout and says where to read the run later', async () => {
    const { pauses } = fakeClock();
    const api = fakeApi({
      [`POST /flows/${FLOW_ID}/runs`]: { run: run('running'), poll: `/v1${RUN_PATH}` },
      [`GET ${RUN_PATH}`]: { run: run('running') },
    });
    const error = await new Eroq().execute.call(executeContext({ api, params: { ...RUN_PARAMS, timeout: 12 } })).catch((thrown: Error) => thrown);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('The flow run is still going after 12 seconds');
    expect((error as { description?: string }).description).toContain(RUN_ID);
    expect(pauses).toEqual([5000, 5000, 2000]);
  });

  it('surfaces eroq\'s own message when the flow is not published', async () => {
    const api = fakeApi({
      [`POST /flows/${FLOW_ID}/runs`]: apiFailure(409, 'This flow is a draft: publish it to start it from the API.', 'flow_not_published'),
    });
    const error = await new Eroq().execute.call(executeContext({ api, params: RUN_PARAMS })).catch((thrown: Error) => thrown);
    expect(error).toBeInstanceOf(NodeApiError);
    expect((error as NodeApiError).message).toBe('This flow is a draft: publish it to start it from the API.');
    expect((error as NodeApiError).httpCode).toBe('409');
    expect((error as NodeApiError).description).toContain('Publish the flow in the eroq studio first');
  });

  it('turns a failure into an item when the node continues on fail', async () => {
    const api = fakeApi({
      [`POST /flows/${FLOW_ID}/runs`]: apiFailure(402, 'Not enough credits: this run needs 45, the workspace has 12.', 'insufficient_credits'),
    });
    const [items] = await new Eroq().execute.call(executeContext({ api, params: RUN_PARAMS, continueOnFail: true }));
    expect(items).toEqual([{ json: { error: 'Not enough credits: this run needs 45, the workspace has 12.' }, pairedItem: { item: 0 } }]);
  });
});

describe('Flow > other operations', () => {
  it('lists flows, published only, up to the limit', async () => {
    const api = fakeApi({
      'GET /flows': {
        object: 'list',
        flows: [
          { id: 'a', name: 'Post every render', published: true, triggers: ['trigger.render'] },
          { id: 'b', name: 'Draft idea', published: false, triggers: ['trigger.manual'] },
          { id: 'c', name: 'Shop orders', published: true, triggers: ['trigger.webhook'] },
        ],
      },
    });
    const params = { resource: 'flow', operation: 'getAll', returnAll: false, limit: 1, filters: { publishedOnly: true } };
    const [items] = await new Eroq().execute.call(executeContext({ api, params }));
    expect(items.map(item => item.json.id)).toEqual(['a']);
  });

  it('reads the hook URL of a flow', async () => {
    const hookUrl = `https://eroq.ai/hooks/flows/${FLOW_ID}/abcdefghijklmnopqrstuvwxyz012345`;
    const api = fakeApi({
      [`GET /flows/${FLOW_ID}`]: { flow: { id: FLOW_ID, name: 'Shop orders', published: true, graph: {}, hookUrl }, runs: [] },
    });
    const [items] = await new Eroq().execute.call(executeContext({ api, params: { resource: 'flow', operation: 'getHookUrl', flowId: FLOW_ID } }));
    expect(items[0].json).toEqual({ flowId: FLOW_ID, name: 'Shop orders', published: true, hookUrl });
  });

  it('says so when the flow has no webhook trigger', async () => {
    const api = fakeApi({
      [`GET /flows/${FLOW_ID}`]: { flow: { id: FLOW_ID, name: 'Shop orders', published: true, graph: {} }, runs: [] },
    });
    await expect(new Eroq().execute.call(executeContext({ api, params: { resource: 'flow', operation: 'getHookUrl', flowId: FLOW_ID } })))
      .rejects.toThrow('This flow has no "When a webhook is called" trigger');
  });

  it('reads a run', async () => {
    const api = fakeApi({ [`GET ${RUN_PATH}`]: { run: run('done') } });
    const [items] = await new Eroq().execute.call(executeContext({ api, params: { resource: 'flow', operation: 'getRun', flowId: FLOW_ID, runId: RUN_ID } }));
    expect(items[0].json).toMatchObject({ id: RUN_ID, status: 'done' });
  });
});
