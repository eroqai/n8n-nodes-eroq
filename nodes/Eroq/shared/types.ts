import type { IDataObject } from 'n8n-workflow';

/** GET /v1/flows → flows[] */
export interface FlowSummary extends IDataObject {
  id: string;
  name: string;
  published: boolean;
  triggers: string[];
}

export type FlowRunStatus = 'running' | 'waiting' | 'done' | 'failed' | 'stopped';

export interface FlowStepResult extends IDataObject {
  status?: string;
  output?: string;
  url?: string;
  text?: string;
  error?: string;
}

/** GET /v1/flows/{id}/runs/{run_id} → run */
export interface FlowRun extends IDataObject {
  id: string;
  flowId: string;
  status: FlowRunStatus;
  results?: { [nodeId: string]: FlowStepResult };
}

/** GET /v1/models → data[] */
export interface EroqModel extends IDataObject {
  id: string;
  name: string;
  kind: string;
  pricing?: string;
  description?: string;
  requires_plan?: string;
  input?: string;
}

/** GET /v1/{images|videos}/generations/{id} */
export interface GenerationJob extends IDataObject {
  id: string;
  status: 'processing' | 'succeeded' | 'failed';
  data?: Array<{ url?: string; b64_json?: string; content_type?: string; library_id?: string }>;
  error?: { message?: string; type?: string; code?: string };
}

/** GET /v1/webhooks → webhooks[] */
export interface WebhookSubscription extends IDataObject {
  id: string;
  url: string;
  events: string[];
  flowId?: string | null;
  enabled?: boolean;
}
