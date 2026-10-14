import type { IDataObject, IExecuteFunctions, INodeExecutionData, INodeProperties } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import type { DownloadOptions } from '../shared/generation';
import { getJob, jobItem, waitForJob } from '../shared/generation';
import { eroqApiRequest } from '../shared/transport';

export const imageOperations: INodeProperties[] = [
  {
    displayName: 'Operation',
    name: 'operation',
    type: 'options',
    noDataExpression: true,
    displayOptions: { show: { resource: ['image'] } },
    options: [
      {
        name: 'Generate',
        value: 'generate',
        description: 'Generate an image from a prompt',
        action: 'Generate an image',
      },
      {
        name: 'Get Job',
        value: 'getJob',
        description: 'Get the status and result of an image job',
        action: 'Get an image job',
      },
    ],
    default: 'generate',
  },
];

const downloadFields: INodeProperties[] = [
  {
    displayName: 'Download File',
    name: 'download',
    type: 'boolean',
    default: false,
    description: 'Whether to download the finished image into a binary field. Links are signed and expire, the binary stays.',
  },
  {
    displayName: 'Put Output File in Field',
    name: 'binaryPropertyName',
    type: 'string',
    default: 'data',
    displayOptions: { show: { download: [true] } },
    hint: 'The name of the output binary field to put the file in',
  },
];

export const imageFields: INodeProperties[] = [
  {
    displayName: 'Prompt',
    name: 'prompt',
    type: 'string',
    typeOptions: { rows: 4 },
    required: true,
    default: '',
    displayOptions: { show: { resource: ['image'], operation: ['generate'] } },
    description: 'What to picture',
  },
  {
    displayName: 'Model Name or ID',
    name: 'model',
    type: 'options',
    typeOptions: { loadOptionsMethod: 'getImageModels' },
    default: '',
    displayOptions: { show: { resource: ['image'], operation: ['generate'] } },
    description: 'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
  },
  {
    displayName: 'Wait for Completion',
    name: 'waitForCompletion',
    type: 'boolean',
    default: true,
    displayOptions: { show: { resource: ['image'], operation: ['generate'] } },
    description: 'Whether to wait for the image and return it. Turned off, the node returns the job ID right away.',
  },
  {
    displayName: 'Timeout (Seconds)',
    name: 'timeout',
    type: 'number',
    typeOptions: { minValue: 10, maxValue: 3600 },
    default: 600,
    displayOptions: { show: { resource: ['image'], operation: ['generate'], waitForCompletion: [true] } },
    description: 'How long to wait before giving up. The render keeps going on eroq and Get Job reads it later.',
  },
  {
    displayName: 'Options',
    name: 'options',
    type: 'collection',
    placeholder: 'Add Option',
    default: {},
    displayOptions: { show: { resource: ['image'], operation: ['generate'] } },
    options: [
      {
        displayName: 'Aspect Ratio',
        name: 'aspect',
        type: 'options',
        default: '1:1',
        options: [
          { name: '1:1 (Square)', value: '1:1' },
          { name: '16:9 (Landscape)', value: '16:9' },
          { name: '3:4 (Portrait)', value: '3:4' },
          { name: '4:3 (Classic)', value: '4:3' },
          { name: '9:16 (Vertical)', value: '9:16' },
        ],
      },
      ...downloadFields,
    ],
  },
  {
    displayName: 'Job ID',
    name: 'jobId',
    type: 'string',
    required: true,
    default: '',
    displayOptions: { show: { resource: ['image'], operation: ['getJob'] } },
    description: 'The ID returned by Generate. Image jobs expire 24 hours after creation.',
  },
  {
    displayName: 'Options',
    name: 'options',
    type: 'collection',
    placeholder: 'Add Option',
    default: {},
    displayOptions: { show: { resource: ['image'], operation: ['getJob'] } },
    options: downloadFields,
  },
];

interface GenerateOptions extends DownloadOptions {
  aspect?: string;
}

async function generateImage(this: IExecuteFunctions, itemIndex: number): Promise<INodeExecutionData[]> {
  const prompt = String(this.getNodeParameter('prompt', itemIndex, '') ?? '').trim();
  if (!prompt) throw new NodeOperationError(this.getNode(), 'The prompt is empty', { itemIndex });
  const model = String(this.getNodeParameter('model', itemIndex, '') ?? '').trim();
  const options = this.getNodeParameter('options', itemIndex, {}) as GenerateOptions;

  const body: IDataObject = { prompt };
  if (model) body.model = model;
  if (options.aspect) body.aspect = options.aspect;
  const created = await eroqApiRequest.call(this, 'POST', '/images/generations', body, undefined, itemIndex) as {
    jobs?: Array<{ id: string; poll?: string }>;
    model?: string;
    usage?: IDataObject;
  };
  const jobs = created.jobs ?? [];
  if (!jobs.length) throw new NodeOperationError(this.getNode(), 'eroq accepted the request but returned no job', { itemIndex });

  const wait = this.getNodeParameter('waitForCompletion', itemIndex, true) as boolean;
  if (!wait) {
    return jobs.map(job => ({ json: { id: job.id, status: 'processing', poll: job.poll, model: created.model, usage: created.usage } }));
  }
  const timeoutSeconds = this.getNodeParameter('timeout', itemIndex, 600) as number;
  const items: INodeExecutionData[] = [];
  for (const job of jobs) {
    const finished = await waitForJob.call(this, 'image', job.id, timeoutSeconds, itemIndex);
    items.push(await jobItem.call(this, 'image', finished, options));
  }
  return items;
}

async function getImageJob(this: IExecuteFunctions, itemIndex: number): Promise<INodeExecutionData[]> {
  const jobId = String(this.getNodeParameter('jobId', itemIndex, '') ?? '').trim();
  if (!jobId) throw new NodeOperationError(this.getNode(), 'No job ID was given', { itemIndex });
  const options = this.getNodeParameter('options', itemIndex, {}) as DownloadOptions;
  const job = await getJob.call(this, 'image', jobId, itemIndex);
  return [await jobItem.call(this, 'image', job, options)];
}

export async function executeImage(this: IExecuteFunctions, operation: string, itemIndex: number): Promise<INodeExecutionData[]> {
  switch (operation) {
    case 'generate':
      return await generateImage.call(this, itemIndex);
    case 'getJob':
      return await getImageJob.call(this, itemIndex);
    default:
      throw new NodeOperationError(this.getNode(), `The operation "${operation}" is not supported`, { itemIndex });
  }
}
