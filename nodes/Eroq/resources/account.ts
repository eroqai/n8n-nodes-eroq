import type { IDataObject, IExecuteFunctions, INodeExecutionData, INodeProperties } from 'n8n-workflow';
import { eroqApiRequest } from '../shared/transport';

export const accountOperations: INodeProperties[] = [
  {
    displayName: 'Operation',
    name: 'operation',
    type: 'options',
    noDataExpression: true,
    displayOptions: { show: { resource: ['account'] } },
    options: [
      {
        name: 'Get',
        value: 'get',
        description: 'Get the credits left on the workspace and its usage over 30 days',
        action: 'Get the account',
      },
    ],
    default: 'get',
  },
];

/** GET /v1/account: the balance, 30-day usage and workspace of the key. */
export async function executeAccount(this: IExecuteFunctions, _operation: string, itemIndex: number): Promise<INodeExecutionData[]> {
  const account = await eroqApiRequest.call(this, 'GET', '/account', undefined, undefined, itemIndex);
  return [{ json: account as IDataObject }];
}
