import type { IDataObject, IExecuteFunctions, INodeExecutionData, INodeProperties } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import type { DownloadOptions } from '../shared/generation';
import { getJob, jobItem, waitForJob } from '../shared/generation';
import { eroqApiRequest } from '../shared/transport';

export const videoOperations: INodeProperties[] = [
  {
    displayName: 'Operation',
    name: 'operation',
    type: 'options',
    noDataExpression: true,
    displayOptions: { show: { resource: ['video'] } },
    options: [
      {
        name: 'Generate',
        value: 'generate',
        description: 'Generate a video clip from a prompt, optionally from a first frame',
        action: 'Generate a video',
      },
      {
        name: 'Get Job',
        value: 'getJob',
        description: 'Get the status and result of a video job',
        action: 'Get a video job',
      },
    ],
    default: 'generate',
  },
];

const downloadField: INodeProperties = {
  displayName: 'Download File',
  name: 'download',
  type: 'boolean',
  default: false,
  description: 'Whether to download the finished clip into a binary field. Links are signed and expire, the binary stays.',
};

const binaryPropertyField: INodeProperties = {
  displayName: 'Put Output File in Field',
  name: 'binaryPropertyName',
  type: 'string',
  default: 'data',
  displayOptions: { show: { download: [true] } },
  hint: 'The name of the output binary field to put the file in',
};

export const videoFields: INodeProperties[] = [
  {
    displayName: 'Prompt',
    name: 'prompt',
    type: 'string',
    typeOptions: { rows: 4 },
    required: true,
    default: '',
    displayOptions: { show: { resource: ['video'], operation: ['generate'] } },
    description: 'What happens in the clip',
  },
  {
    displayName: 'Model Name or ID',
    name: 'model',
    type: 'options',
    typeOptions: { loadOptionsMethod: 'getVideoModels' },
    default: '',
    displayOptions: { show: { resource: ['video'], operation: ['generate'] } },
    description: 'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
  },
  {
    displayName: 'Wait for Completion',
    name: 'waitForCompletion',
    type: 'boolean',
    default: false,
    displayOptions: { show: { resource: ['video'], operation: ['generate'] } },
    description: 'Whether to wait for the clip and return it. Clips take minutes: left off, the node returns the job ID and Get Job reads it later.',
  },
  {
    displayName: 'Timeout (Seconds)',
    name: 'timeout',
    type: 'number',
    typeOptions: { minValue: 30, maxValue: 3600 },
    default: 1800,
    displayOptions: { show: { resource: ['video'], operation: ['generate'], waitForCompletion: [true] } },
    description: 'How long to wait before giving up. The render keeps going on eroq and Get Job reads it later.',
  },
  {
    displayName: 'Options',
    name: 'options',
    type: 'collection',
    placeholder: 'Add Option',
    default: {},
    displayOptions: { show: { resource: ['video'], operation: ['generate'] } },
    options: [
      {
        displayName: 'Aspect Ratio',
        name: 'aspect',
        type: 'options',
        default: '16:9',
        options: [
          { name: '1:1 (Square)', value: '1:1' },
          { name: '16:9 (Wide)', value: '16:9' },
          { name: '21:9 (Cinema)', value: '21:9' },
          { name: '3:4 (Portrait)', value: '3:4' },
          { name: '4:3 (Classic)', value: '4:3' },
          { name: '9:16 (Vertical)', value: '9:16' },
        ],
      },
      downloadField,
      {
        displayName: 'Duration (Seconds)',
        name: 'seconds',
        type: 'number',
        typeOptions: { minValue: 1, maxValue: 30 },
        default: 5,
        description: 'Clip length. The plan caps it and the engine snaps it to the lengths it supports.',
      },
      binaryPropertyField,
      {
        displayName: 'Reference Image URLs',
        name: 'references',
        type: 'string',
        default: '',
        placeholder: 'https://example.com/first-frame.png',
        description: 'Up to 4 picture URLs, comma-separated. On engines that start from a frame, the first one is the first frame.',
      },
    ],
  },
  {
    displayName: 'Job ID',
    name: 'jobId',
    type: 'string',
    required: true,
    default: '',
    displayOptions: { show: { resource: ['video'], operation: ['getJob'] } },
    description: 'The ID returned by Generate',
  },
  {
    displayName: 'Options',
    name: 'options',
    type: 'collection',
    placeholder: 'Add Option',
    default: {},
    displayOptions: { show: { resource: ['video'], operation: ['getJob'] } },
    options: [downloadField, binaryPropertyField],
  },
];

interface GenerateOptions extends DownloadOptions {
  aspect?: string;
  seconds?: number;
  references?: string;
}

/** Comma, space or line separated URLs → a clean list. */
export function splitReferences(raw: string | undefined): string[] {
  return (raw ?? '').split(/[\s,]+/).map(entry => entry.trim()).filter(Boolean);
}

async function generateVideo(this: IExecuteFunctions, itemIndex: number): Promise<INodeExecutionData[]> {
  const prompt = String(this.getNodeParameter('prompt', itemIndex, '') ?? '').trim();
  if (!prompt) throw new NodeOperationError(this.getNode(), 'The prompt is empty', { itemIndex });
  const model = String(this.getNodeParameter('model', itemIndex, '') ?? '').trim();
  const options = this.getNodeParameter('options', itemIndex, {}) as GenerateOptions;

  const body: IDataObject = { prompt };
  if (model) body.model = model;
  if (options.aspect) body.aspect = options.aspect;
  if (options.seconds) body.seconds = Math.round(options.seconds);
  const references = splitReferences(options.references);
  if (references.length) body.references = references;

  const created = await eroqApiRequest.call(this, 'POST', '/videos/generations', body, undefined, itemIndex) as IDataObject & { id?: string };
  if (!created.id) throw new NodeOperationError(this.getNode(), 'eroq accepted the request but returned no job', { itemIndex });

  const wait = this.getNodeParameter('waitForCompletion', itemIndex, false) as boolean;
  if (!wait) return [{ json: created }];
  const timeoutSeconds = this.getNodeParameter('timeout', itemIndex, 1800) as number;
  const finished = await waitForJob.call(this, 'video', created.id, timeoutSeconds, itemIndex);
  return [await jobItem.call(this, 'video', finished, options)];
}

async function getVideoJob(this: IExecuteFunctions, itemIndex: number): Promise<INodeExecutionData[]> {
  const jobId = String(this.getNodeParameter('jobId', itemIndex, '') ?? '').trim();
  if (!jobId) throw new NodeOperationError(this.getNode(), 'No job ID was given', { itemIndex });
  const options = this.getNodeParameter('options', itemIndex, {}) as DownloadOptions;
  const job = await getJob.call(this, 'video', jobId, itemIndex);
  return [await jobItem.call(this, 'video', job, options)];
}

export async function executeVideo(this: IExecuteFunctions, operation: string, itemIndex: number): Promise<INodeExecutionData[]> {
  switch (operation) {
    case 'generate':
      return await generateVideo.call(this, itemIndex);
    case 'getJob':
      return await getVideoJob.call(this, itemIndex);
    default:
      throw new NodeOperationError(this.getNode(), `The operation "${operation}" is not supported`, { itemIndex });
  }
}
