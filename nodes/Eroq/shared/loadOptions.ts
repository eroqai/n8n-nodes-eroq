import type { ILoadOptionsFunctions, INodePropertyOptions } from 'n8n-workflow';
import { eroqApiRequest } from './transport';
import type { EroqModel, FlowSummary } from './types';

async function listFlows(this: ILoadOptionsFunctions): Promise<FlowSummary[]> {
  const response = await eroqApiRequest.call(this, 'GET', '/flows') as { flows?: FlowSummary[] };
  return response.flows ?? [];
}

function flowOption(flow: FlowSummary): INodePropertyOptions {
  return {
    name: flow.published ? flow.name : `${flow.name} (draft)`,
    value: flow.id,
    description: flow.triggers?.length ? `Starts: ${flow.triggers.map(trigger => trigger.replace(/^trigger\./, '')).join(', ')}` : undefined,
  };
}

async function listModels(this: ILoadOptionsFunctions, kind: 'image' | 'video'): Promise<INodePropertyOptions[]> {
  const response = await eroqApiRequest.call(this, 'GET', '/models') as { data?: EroqModel[] };
  const models = (response.data ?? []).filter(model => model.kind === kind && model.input !== 'video');
  return [
    { name: 'Default', value: '', description: 'The engine eroq picks when none is named' },
    ...models.map(model => ({
      name: model.name || model.id,
      value: model.id,
      description: [model.pricing, model.requires_plan ? `${model.requires_plan} plan` : ''].filter(Boolean).join(' · ') || undefined,
    })),
  ];
}

/** Flows that can be started from n8n: the published ones. */
export async function getPublishedFlows(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
  const flows = await listFlows.call(this);
  return flows.filter(flow => flow.published).map(flowOption);
}

/** Every flow of the workspace, drafts marked as such. */
export async function getFlows(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
  const flows = await listFlows.call(this);
  return flows.map(flowOption);
}

/** The trigger's flow filter: every flow, or none. */
export async function getTriggerFlows(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
  const flows = await listFlows.call(this);
  return [{ name: 'All Flows', value: '' }, ...flows.map(flowOption)];
}

export async function getImageModels(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
  return await listModels.call(this, 'image');
}

/** Video engines that start from a prompt (video-to-video models are left out). */
export async function getVideoModels(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
  return await listModels.call(this, 'video');
}
