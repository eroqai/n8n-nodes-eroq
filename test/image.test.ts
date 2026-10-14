import type { IHttpRequestOptions } from 'n8n-workflow';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Eroq } from '../nodes/Eroq/Eroq.node';
import { executeContext, fakeApi, fakeClock } from './helpers';

const JOB_ID = '5c7e2a90-8d1f-4b3c-9e2a-1f0d3c4b5a69';
const SIGNED_URL = 'https://cdn.example.com/renders/5c7e2a90.webp?token=signed';

function job(status: string, extra: Record<string, unknown> = {}) {
  return { id: JOB_ID, object: 'image.generation', status, created: 1_760_000_000, model: 'eroq-one', ...extra };
}

const SUCCEEDED = job('succeeded', {
  data: [{ url: SIGNED_URL, content_type: 'image/webp', library_id: 'lib-1' }],
  usage: { credits_spent: 10, credits_remaining: 967 },
});

const GENERATE_PARAMS = {
  resource: 'image',
  operation: 'generate',
  prompt: 'A neon diner at night, rain on the window',
  model: 'eroq-one',
  waitForCompletion: true,
  timeout: 600,
  options: { aspect: '9:16' },
};

function generationApi(polls: unknown[]) {
  return fakeApi({
    'POST /images/generations': {
      jobs: [{ id: JOB_ID, poll: `/v1/images/generations/${JOB_ID}` }],
      model: 'eroq-one',
      usage: { credits_spent: 10, credits_remaining: 967 },
    },
    [`GET /images/generations/${JOB_ID}`]: polls,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Image > Generate', () => {
  it('creates the job, then polls every 2.5 seconds until the image is there', async () => {
    const { pauses } = fakeClock();
    const api = generationApi([job('processing', { phase: 'queued' }), job('processing', { phase: 'generating' }), SUCCEEDED]);

    const [items] = await new Eroq().execute.call(executeContext({ api, params: GENERATE_PARAMS }));

    expect(api.calls[0]).toMatchObject({
      method: 'POST',
      url: 'https://eroq.ai/v1/images/generations',
      body: { prompt: 'A neon diner at night, rain on the window', model: 'eroq-one', aspect: '9:16' },
    });
    expect(api.calls.slice(1).map(call => call.path)).toEqual(Array(3).fill(`/images/generations/${JOB_ID}`));
    expect(pauses).toEqual([2500, 2500]);
    expect(items).toHaveLength(1);
    expect(items[0].json).toMatchObject({ id: JOB_ID, status: 'succeeded', data: [{ url: SIGNED_URL }] });
    expect(items[0].binary).toBeUndefined();
    expect(items[0].pairedItem).toEqual({ item: 0 });
  });

  it('leaves the default engine and aspect to eroq when none is picked', async () => {
    fakeClock();
    const api = generationApi([SUCCEEDED]);
    await new Eroq().execute.call(executeContext({ api, params: { ...GENERATE_PARAMS, model: '', options: {} } }));
    expect(api.calls[0].body).toEqual({ prompt: 'A neon diner at night, rain on the window' });
  });

  it('downloads the image into a binary field, without sending the API key to the CDN', async () => {
    fakeClock();
    const api = generationApi([SUCCEEDED]);
    const download = vi.fn((request: IHttpRequestOptions) => ({
      body: Buffer.from(`bytes of ${request.url}`),
      headers: { 'content-type': 'image/webp' },
    }));
    const context = executeContext({
      api,
      download,
      params: { ...GENERATE_PARAMS, options: { download: true, binaryPropertyName: 'picture' } },
    });

    const [items] = await new Eroq().execute.call(context);

    expect(download).toHaveBeenCalledTimes(1);
    const request = download.mock.calls[0][0];
    expect(request).toMatchObject({ method: 'GET', url: SIGNED_URL, encoding: 'arraybuffer' });
    expect(request.headers?.Authorization).toBeUndefined();
    expect(api.calls.some(call => call.url === SIGNED_URL)).toBe(false);
    expect(items[0].binary?.picture).toMatchObject({
      fileName: `eroq-image-${JOB_ID}.webp`,
      mimeType: 'image/webp',
      data: Buffer.from(`bytes of ${SIGNED_URL}`).toString('base64'),
    });
  });

  it('decodes a private render delivered inline, and keeps the base64 out of the JSON', async () => {
    fakeClock();
    const inline = job('succeeded', { data: [{ b64_json: Buffer.from('inline-image').toString('base64'), content_type: 'image/png' }] });
    const api = generationApi([inline]);
    const [items] = await new Eroq().execute.call(executeContext({ api, params: { ...GENERATE_PARAMS, options: { download: true } } }));
    expect(items[0].binary?.data).toMatchObject({ fileName: `eroq-image-${JOB_ID}.png`, mimeType: 'image/png', data: Buffer.from('inline-image').toString('base64') });
    expect(items[0].json.data).toEqual([{ content_type: 'image/png' }]);
  });

  it('fails with eroq\'s words when the render fails', async () => {
    fakeClock();
    const failed = job('failed', { error: { message: 'This prompt was refused by the content policy.', type: 'invalid_request_error', code: 'content_blocked' } });
    const api = generationApi([job('processing'), failed]);
    const error = await new Eroq().execute.call(executeContext({ api, params: GENERATE_PARAMS })).catch((thrown: Error) => thrown);
    expect((error as Error).message).toBe('This prompt was refused by the content policy.');
    expect((error as { description?: string }).description).toContain('content_blocked');
  });

  it('gives up after the timeout and names the job', async () => {
    const { pauses } = fakeClock();
    const api = generationApi([job('processing')]);
    const error = await new Eroq().execute.call(executeContext({ api, params: { ...GENERATE_PARAMS, timeout: 5 } })).catch((thrown: Error) => thrown);
    expect((error as Error).message).toBe('The image is still rendering after 5 seconds');
    expect((error as { description?: string }).description).toContain(JOB_ID);
    expect(pauses).toEqual([2500, 2500]);
  });

  it('returns the job right away when not waiting', async () => {
    const api = generationApi([]);
    const [items] = await new Eroq().execute.call(executeContext({ api, params: { ...GENERATE_PARAMS, waitForCompletion: false } }));
    expect(api.calls).toHaveLength(1);
    expect(items[0].json).toMatchObject({ id: JOB_ID, status: 'processing', poll: `/v1/images/generations/${JOB_ID}` });
  });
});

describe('Image > Get Job', () => {
  it('reads the job as it stands', async () => {
    const api = fakeApi({ [`GET /images/generations/${JOB_ID}`]: job('processing', { phase: 'queued' }) });
    const [items] = await new Eroq().execute.call(executeContext({ api, params: { resource: 'image', operation: 'getJob', jobId: JOB_ID, options: {} } }));
    expect(items[0].json).toMatchObject({ id: JOB_ID, status: 'processing', phase: 'queued' });
  });
});

describe('Video > Generate', () => {
  it('sends the clip settings and returns the job without waiting by default', async () => {
    const api = fakeApi({
      'POST /videos/generations': { id: 'v1', status: 'processing', poll: '/v1/videos/generations/v1', usage: { credits_spent: 60 } },
    });
    const params = {
      resource: 'video',
      operation: 'generate',
      prompt: 'Slow push-in on a latte',
      model: '',
      options: { seconds: 5, aspect: '9:16', references: 'https://example.com/a.png, https://example.com/b.png' },
    };
    const [items] = await new Eroq().execute.call(executeContext({ api, params }));
    expect(api.calls[0].body).toEqual({
      prompt: 'Slow push-in on a latte',
      seconds: 5,
      aspect: '9:16',
      references: ['https://example.com/a.png', 'https://example.com/b.png'],
    });
    expect(items[0].json).toMatchObject({ id: 'v1', status: 'processing' });
  });

  it('polls a clip every 5 seconds when asked to wait', async () => {
    const { pauses } = fakeClock();
    const api = fakeApi({
      'POST /videos/generations': { id: 'v1', status: 'processing', poll: '/v1/videos/generations/v1' },
      'GET /videos/generations/v1': [
        { id: 'v1', status: 'processing' },
        { id: 'v1', status: 'succeeded', data: [{ url: 'https://cdn.example.com/v1.mp4', content_type: 'video/mp4' }] },
      ],
    });
    const params = { resource: 'video', operation: 'generate', prompt: 'Slow push-in', model: 'eroq-motion-one', waitForCompletion: true, timeout: 1800, options: {} };
    const [items] = await new Eroq().execute.call(executeContext({ api, params }));
    expect(pauses).toEqual([5000]);
    expect(items[0].json).toMatchObject({ id: 'v1', status: 'succeeded' });
  });
});

describe('Account > Get', () => {
  it('returns the balance', async () => {
    const account = { object: 'account', credits: 977, usage_30d: { requests: 12, credits: 140 }, workspace: { id: 'w1', name: 'Night Shift Studio' } };
    const api = fakeApi({ 'GET /account': account });
    const [items] = await new Eroq().execute.call(executeContext({ api, params: { resource: 'account', operation: 'get' } }));
    expect(items[0].json).toEqual(account);
  });
});
