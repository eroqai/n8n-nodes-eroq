import type {
  IExecuteFunctions,
  INode,
  INodeExecutionData,
  INodeType,
  INodeTypeDescription,
  JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { accountOperations, executeAccount } from './resources/account';
import { executeFlow, flowFields, flowOperations } from './resources/flow';
import { executeImage, imageFields, imageOperations } from './resources/image';
import { executeVideo, videoFields, videoOperations } from './resources/video';
import { getFlows, getImageModels, getPublishedFlows, getVideoModels } from './shared/loadOptions';

type ResourceHandler = (this: IExecuteFunctions, operation: string, itemIndex: number) => Promise<INodeExecutionData[]>;

const HANDLERS: Record<string, ResourceHandler> = {
  account: executeAccount,
  flow: executeFlow,
  image: executeImage,
  video: executeVideo,
};

/** n8n errors pass through untouched; anything else becomes a NodeOperationError for this item. */
function nodeError(node: INode, error: unknown, itemIndex: number): NodeApiError | NodeOperationError {
  if (error instanceof NodeApiError) return error;
  if (error instanceof NodeOperationError) return error;
  if (error instanceof Error) return new NodeOperationError(node, error, { itemIndex });
  return new NodeApiError(node, error as JsonObject, { itemIndex });
}

export class Eroq implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'eroq',
    name: 'eroq',
    icon: { light: 'file:eroq.svg', dark: 'file:eroq.svg' },
    group: ['transform'],
    version: 1,
    subtitle: '={{ $parameter["operation"] + ": " + $parameter["resource"] }}',
    description: 'Run Flows and generate images and videos with eroq',
    defaults: {
      name: 'eroq',
    },
    usableAsTool: true,
    inputs: [NodeConnectionTypes.Main],
    outputs: [NodeConnectionTypes.Main],
    credentials: [
      {
        name: 'eroqApi',
        required: true,
      },
    ],
    properties: [
      {
        displayName: 'Resource',
        name: 'resource',
        type: 'options',
        noDataExpression: true,
        options: [
          { name: 'Account', value: 'account' },
          { name: 'Flow', value: 'flow' },
          { name: 'Image', value: 'image' },
          { name: 'Video', value: 'video' },
        ],
        default: 'flow',
      },
      ...accountOperations,
      ...flowOperations,
      ...flowFields,
      ...imageOperations,
      ...imageFields,
      ...videoOperations,
      ...videoFields,
    ],
  };

  methods = {
    loadOptions: {
      getFlows,
      getImageModels,
      getPublishedFlows,
      getVideoModels,
    },
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const returnData: INodeExecutionData[] = [];

    for (let itemIndex = 0; itemIndex < items.length; itemIndex++) {
      try {
        const resource = this.getNodeParameter('resource', itemIndex) as string;
        const operation = this.getNodeParameter('operation', itemIndex) as string;
        const handler = HANDLERS[resource];
        if (!handler) {
          throw new NodeOperationError(this.getNode(), `The resource "${resource}" is not supported`, { itemIndex });
        }
        const results = await handler.call(this, operation, itemIndex);
        for (const result of results) {
          returnData.push({ ...result, pairedItem: { item: itemIndex } });
        }
      }
      catch (error) {
        if (this.continueOnFail()) {
          returnData.push({ json: { error: (error as Error).message }, pairedItem: { item: itemIndex } });
          continue;
        }
        throw nodeError(this.getNode(), error, itemIndex);
      }
    }

    return [returnData];
  }
}
