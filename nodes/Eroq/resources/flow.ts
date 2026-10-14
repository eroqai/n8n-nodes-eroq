import type { IDataObject, IExecuteFunctions, INodeExecutionData, INodeProperties } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { pollUntil } from '../shared/poll';
import { eroqApiRequest } from '../shared/transport';
import type { FlowRun, FlowSummary } from '../shared/types';

/** How often a run is read while waiting (each read also moves the run on, server-side). */
export const FLOW_POLL_INTERVAL_MS = 5_000;

/** Nothing left to wait for: it ended, or it waits on a person in the studio. */
const SETTLED_STATUSES = new Set(['done', 'failed', 'stopped', 'waiting']);

export const flowOperations: INodeProperties[] = [
  {
    displayName: 'Operation',
    name: 'operation',
    type: 'options',
    noDataExpression: true,
    displayOptions: { show: { resource: ['flow'] } },
    options: [
      {
        name: 'Get Hook URL',
        value: 'getHookUrl',
        description: 'Get the secret URL that starts a flow from any app',
        action: 'Get the hook URL of a flow',
      },
      {
        name: 'Get Many',
        value: 'getAll',
        description: 'Get many flows',
        action: 'Get many flows',
      },
      {
        name: 'Get Run',
        value: 'getRun',
        description: 'Get where a run stands and what its steps made',
        action: 'Get a flow run',
      },
      {
        name: 'Run',
        value: 'run',
        description: 'Start a published flow',
        action: 'Run a flow',
      },
    ],
    default: 'run',
  },
];

export const flowFields: INodeProperties[] = [
  {
    displayName: 'Flow Name or ID',
    name: 'flowId',
    type: 'options',
    typeOptions: { loadOptionsMethod: 'getPublishedFlows' },
    required: true,
    default: '',
    displayOptions: { show: { resource: ['flow'], operation: ['run'] } },
    description: 'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
    hint: 'Only published flows can be started from n8n',
  },
  {
    displayName: 'Flow Name or ID',
    name: 'flowId',
    type: 'options',
    typeOptions: { loadOptionsMethod: 'getFlows' },
    required: true,
    default: '',
    displayOptions: { show: { resource: ['flow'], operation: ['getRun', 'getHookUrl'] } },
    description: 'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
  },
  {
    displayName: 'Run ID',
    name: 'runId',
    type: 'string',
    required: true,
    default: '',
    displayOptions: { show: { resource: ['flow'], operation: ['getRun'] } },
    description: 'The ID the Run operation returned. A flow keeps its last 30 runs.',
  },
  {
    displayName: 'Prompt',
    name: 'prompt',
    type: 'string',
    typeOptions: { rows: 3 },
    default: '',
    displayOptions: { show: { resource: ['flow'], operation: ['run'] } },
    description: 'The prompt handed to the trigger of flows that ask for one',
  },
  {
    displayName: 'Wait for Completion',
    name: 'waitForCompletion',
    type: 'boolean',
    default: true,
    displayOptions: { show: { resource: ['flow'], operation: ['run'] } },
    description: 'Whether to wait for the run to end and return its results. The run is read every 5 seconds.',
  },
  {
    displayName: 'Timeout (Seconds)',
    name: 'timeout',
    type: 'number',
    typeOptions: { minValue: 10, maxValue: 3600 },
    default: 600,
    displayOptions: { show: { resource: ['flow'], operation: ['run'], waitForCompletion: [true] } },
    description: 'How long to wait before giving up. The run keeps going on eroq and Get Run reads it later.',
  },
  {
    displayName: 'Options',
    name: 'options',
    type: 'collection',
    placeholder: 'Add Option',
    default: {},
    displayOptions: { show: { resource: ['flow'], operation: ['run'] } },
    options: [
      {
        displayName: 'Callback URL',
        name: 'callbackUrl',
        type: 'string',
        default: '',
        placeholder: 'https://',
        description: 'An HTTPS address that receives one event when the run ends. Use the resume URL of a Wait node to continue the workflow only then.',
      },
      {
        displayName: 'Creation ID',
        name: 'creationId',
        type: 'string',
        default: '',
        description: 'A render of your library, for flows that start after a render',
      },
      {
        displayName: 'Image URL',
        name: 'imageUrl',
        type: 'string',
        default: '',
        placeholder: 'https://',
        description: 'A picture, for flows whose trigger asks for one',
      },
      {
        displayName: 'Payload (JSON)',
        name: 'payload',
        type: 'json',
        default: '{}',
        description: 'The JSON body that a webhook trigger reads its fields from',
      },
      {
        displayName: 'Start From',
        name: 'trigger',
        type: 'options',
        default: '',
        description: 'Which trigger of the flow the run starts from',
        options: [
          {
            name: 'Automatic',
            value: '',
            description: 'The run trigger, or the render trigger when only a creation is sent',
          },
          {
            name: 'Manual Trigger',
            value: 'manual',
            description: 'When I run it',
          },
          {
            name: 'Render Trigger',
            value: 'render',
            description: 'After a render: send a creation ID',
          },
          {
            name: 'Webhook Trigger',
            value: 'webhook',
            description: 'When a webhook is called: send a payload',
          },
        ],
      },
    ],
  },
  {
    displayName: 'Return All',
    name: 'returnAll',
    type: 'boolean',
    default: false,
    displayOptions: { show: { resource: ['flow'], operation: ['getAll'] } },
    description: 'Whether to return all results or only up to a given limit',
  },
  {
    displayName: 'Limit',
    name: 'limit',
    type: 'number',
    typeOptions: { minValue: 1 },
    default: 50,
    displayOptions: { show: { resource: ['flow'], operation: ['getAll'], returnAll: [false] } },
    description: 'Max number of results to return',
  },
  {
    displayName: 'Filters',
    name: 'filters',
    type: 'collection',
    placeholder: 'Add Filter',
    default: {},
    displayOptions: { show: { resource: ['flow'], operation: ['getAll'] } },
    options: [
      {
        displayName: 'Published Only',
        name: 'publishedOnly',
        type: 'boolean',
        default: false,
        description: 'Whether to return only published flows, the ones n8n can start',
      },
    ],
  },
];

interface RunOptions {
  callbackUrl?: string;
  creationId?: string;
  imageUrl?: string;
  payload?: unknown;
  trigger?: string;
}

/** A required ID parameter, trimmed and ready for a URL path. */
function idParameter(this: IExecuteFunctions, name: string, label: string, itemIndex: number): string {
  const value = String(this.getNodeParameter(name, itemIndex, '') ?? '').trim();
  if (!value) throw new NodeOperationError(this.getNode(), `No ${label} ID was given`, { itemIndex });
  return encodeURIComponent(value);
}

/** The payload option as an object (it may arrive as JSON text or as an object from an expression). */
function parsePayload(this: IExecuteFunctions, raw: unknown, itemIndex: number): IDataObject | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    }
    catch {
      throw new NodeOperationError(this.getNode(), 'The payload is not valid JSON', { itemIndex });
    }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new NodeOperationError(this.getNode(), 'The payload must be a JSON object', { itemIndex });
  }
  return Object.keys(value).length ? (value as IDataObject) : undefined;
}

/** POST /v1/flows/{id}/runs body: only what was filled in. */
function runBody(this: IExecuteFunctions, prompt: string, options: RunOptions, itemIndex: number): IDataObject {
  const inputs: IDataObject = {};
  if (prompt) inputs.prompt = prompt;
  const imageUrl = options.imageUrl?.trim();
  if (imageUrl) inputs.image_url = imageUrl;
  const creationId = options.creationId?.trim();
  if (creationId) inputs.creation_id = creationId;
  const payload = parsePayload.call(this, options.payload, itemIndex);
  if (payload) inputs.payload = payload;

  const body: IDataObject = {};
  if (options.trigger) body.trigger = options.trigger;
  if (Object.keys(inputs).length) body.inputs = inputs;
  const callbackUrl = options.callbackUrl?.trim();
  if (callbackUrl) body.callback_url = callbackUrl;
  return body;
}

/** The first error a step of the run reported. */
export function firstStepError(run: FlowRun): string | undefined {
  for (const result of Object.values(run.results ?? {})) {
    if (result?.status === 'failed' && typeof result.error === 'string' && result.error) return result.error;
  }
  return undefined;
}

async function runFlow(this: IExecuteFunctions, itemIndex: number): Promise<INodeExecutionData[]> {
  const flowId = idParameter.call(this, 'flowId', 'flow', itemIndex);
  const prompt = String(this.getNodeParameter('prompt', itemIndex, '') ?? '').trim();
  const wait = this.getNodeParameter('waitForCompletion', itemIndex, true) as boolean;
  const options = this.getNodeParameter('options', itemIndex, {}) as RunOptions;
  const body = runBody.call(this, prompt, options, itemIndex);

  const started = await eroqApiRequest.call(this, 'POST', `/flows/${flowId}/runs`, body, undefined, itemIndex) as { run: FlowRun; poll?: string };
  if (!wait) return [{ json: { ...started.run, poll: started.poll } }];

  const timeoutSeconds = this.getNodeParameter('timeout', itemIndex, 600) as number;
  const path = `/flows/${flowId}/runs/${encodeURIComponent(started.run.id)}`;
  const { value: run, settled } = await pollUntil<FlowRun>({
    read: async () => (await eroqApiRequest.call(this, 'GET', path, undefined, undefined, itemIndex) as { run: FlowRun }).run,
    settled: current => SETTLED_STATUSES.has(current.status),
    intervalMs: FLOW_POLL_INTERVAL_MS,
    timeoutMs: timeoutSeconds * 1000,
    signal: this.getExecutionCancelSignal?.(),
  });

  if (!settled) {
    throw new NodeOperationError(this.getNode(), `The flow run is still going after ${timeoutSeconds} seconds`, {
      itemIndex,
      description: `It keeps running on eroq. Read it later with Flow > Get Run (run ID ${run.id}), raise the timeout, or use a Callback URL with a Wait node.`,
    });
  }
  if (run.status === 'failed') {
    throw new NodeOperationError(this.getNode(), `The flow run failed: ${firstStepError(run) ?? 'no step reported why'}`, {
      itemIndex,
      description: `Run ID ${run.id}. Open the flow in the eroq studio to see each step.`,
    });
  }
  if (run.status === 'stopped') {
    throw new NodeOperationError(this.getNode(), 'The flow run was stopped before it finished', {
      itemIndex,
      description: `Run ID ${run.id}.`,
    });
  }
  return [{ json: run }];
}

async function getRun(this: IExecuteFunctions, itemIndex: number): Promise<INodeExecutionData[]> {
  const flowId = idParameter.call(this, 'flowId', 'flow', itemIndex);
  const runId = idParameter.call(this, 'runId', 'run', itemIndex);
  const response = await eroqApiRequest.call(this, 'GET', `/flows/${flowId}/runs/${runId}`, undefined, undefined, itemIndex) as { run: FlowRun };
  return [{ json: response.run }];
}

async function getManyFlows(this: IExecuteFunctions, itemIndex: number): Promise<INodeExecutionData[]> {
  const response = await eroqApiRequest.call(this, 'GET', '/flows', undefined, undefined, itemIndex) as { flows?: FlowSummary[] };
  const filters = this.getNodeParameter('filters', itemIndex, {}) as { publishedOnly?: boolean };
  let flows = response.flows ?? [];
  if (filters.publishedOnly) flows = flows.filter(flow => flow.published);
  const returnAll = this.getNodeParameter('returnAll', itemIndex, false) as boolean;
  if (!returnAll) flows = flows.slice(0, this.getNodeParameter('limit', itemIndex, 50) as number);
  return flows.map(flow => ({ json: flow }));
}

async function getHookUrl(this: IExecuteFunctions, itemIndex: number): Promise<INodeExecutionData[]> {
  const flowId = idParameter.call(this, 'flowId', 'flow', itemIndex);
  const response = await eroqApiRequest.call(this, 'GET', `/flows/${flowId}`, undefined, undefined, itemIndex) as {
    flow: { id: string; name: string; published?: boolean; hookUrl?: string | null };
  };
  const flow = response.flow;
  if (!flow.hookUrl) {
    throw new NodeOperationError(this.getNode(), 'This flow has no "When a webhook is called" trigger', {
      itemIndex,
      description: 'Add that trigger to the flow in the eroq studio, publish the flow, then try again.',
    });
  }
  return [{ json: { flowId: flow.id, name: flow.name, published: flow.published === true, hookUrl: flow.hookUrl } }];
}

export async function executeFlow(this: IExecuteFunctions, operation: string, itemIndex: number): Promise<INodeExecutionData[]> {
  switch (operation) {
    case 'run':
      return await runFlow.call(this, itemIndex);
    case 'getRun':
      return await getRun.call(this, itemIndex);
    case 'getAll':
      return await getManyFlows.call(this, itemIndex);
    case 'getHookUrl':
      return await getHookUrl.call(this, itemIndex);
    default:
      throw new NodeOperationError(this.getNode(), `The operation "${operation}" is not supported`, { itemIndex });
  }
}
