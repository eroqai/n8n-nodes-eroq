import type {
  IDataObject,
  IHookFunctions,
  INodeType,
  INodeTypeDescription,
  IWebhookFunctions,
  IWebhookResponseData,
} from 'n8n-workflow';
import { NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';
import { getTriggerFlows } from './shared/loadOptions';
import { SIGNATURE_HEADER, verifySignature } from './shared/signature';
import { eroqApiError, eroqApiRequest, readEroqError } from './shared/transport';
import type { WebhookSubscription } from './shared/types';

/** Header naming the subscription a delivery comes from. */
const SUBSCRIPTION_HEADER = 'eroq-webhook-id';
/** eroq keeps a subscription's flow filter as a `flow:<id>` entry of its events; a listing may show it there. */
const FLOW_FILTER_PREFIX = 'flow:';
const LABEL_MAX = 80;

interface SubscriptionSettings {
  events: string[];
  flowId: string;
}

function settingsOf(context: IHookFunctions | IWebhookFunctions): SubscriptionSettings {
  const events = (context.getNodeParameter('events', []) as string[]).filter(Boolean);
  const flowId = String(context.getNodeParameter('flowId', '') ?? '').trim();
  return { events: [...new Set(events)].sort(), flowId };
}

/** What eroq lists for a subscription, normalized: event names apart from its flow filter. */
function subscriptionShape(hook: WebhookSubscription): SubscriptionSettings {
  const entries = Array.isArray(hook.events) ? hook.events : [];
  const legacyFilter = entries.find(entry => entry.startsWith(FLOW_FILTER_PREFIX))?.slice(FLOW_FILTER_PREFIX.length);
  return {
    events: [...new Set(entries.filter(entry => !entry.startsWith(FLOW_FILTER_PREFIX)))].sort(),
    flowId: hook.flowId || legacyFilter || '',
  };
}

function sameSettings(a: SubscriptionSettings, b: SubscriptionSettings): boolean {
  return a.flowId === b.flowId && a.events.length === b.events.length && a.events.every((event, index) => event === b.events[index]);
}

export function subscriptionLabel(workflowName: string | undefined): string {
  const label = `n8n · ${workflowName?.trim() || 'workflow'}`;
  return label.length > LABEL_MAX ? `${label.slice(0, LABEL_MAX - 1)}…` : label;
}

function forget(staticData: IDataObject): void {
  delete staticData.webhookId;
  delete staticData.webhookSecret;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** The exact bytes eroq signed. n8n keeps them on the request; re-serializing is the fallback (eroq sends compact JSON). */
async function rawBodyOf(context: IWebhookFunctions): Promise<Buffer | string> {
  const request = context.getRequestObject() as unknown as { rawBody?: Buffer | string; readRawBody?: () => Promise<void> };
  if (request.rawBody === undefined && typeof request.readRawBody === 'function') await request.readRawBody();
  if (Buffer.isBuffer(request.rawBody) || typeof request.rawBody === 'string') return request.rawBody;
  return JSON.stringify(context.getBodyData());
}

/** Does eroq still list this subscription? (False when it cannot tell.) */
async function subscriptionAlive(this: IWebhookFunctions, id: string): Promise<boolean> {
  try {
    const response = await eroqApiRequest.call(this, 'GET', '/webhooks') as { webhooks?: WebhookSubscription[] };
    return (response.webhooks ?? []).some(hook => hook.id === id);
  }
  catch (error) {
    this.logger.warn(`eroq Trigger could not list the webhook subscriptions: ${(error as Error).message}`);
    return false;
  }
}

function refuse(context: IWebhookFunctions, status: number, message: string): IWebhookResponseData {
  context.getResponseObject().status(status).json({ error: message });
  return { noWebhookResponse: true };
}

export class EroqTrigger implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'eroq Trigger',
    name: 'eroqTrigger',
    icon: { light: 'file:eroq.svg', dark: 'file:eroq.svg' },
    group: ['trigger'],
    version: 1,
    subtitle: '={{ $parameter["events"].join(", ") }}',
    description: 'Starts the workflow when an eroq flow run or render finishes',
    defaults: {
      name: 'eroq Trigger',
    },
    inputs: [],
    outputs: [NodeConnectionTypes.Main],
    credentials: [
      {
        name: 'eroqApi',
        required: true,
      },
    ],
    webhooks: [
      {
        name: 'default',
        httpMethod: 'POST',
        responseMode: 'onReceived',
        path: 'webhook',
      },
    ],
    properties: [
      {
        displayName: 'Events',
        name: 'events',
        type: 'multiOptions',
        required: true,
        default: ['flow.run.succeeded'],
        options: [
          {
            name: 'Flow Run Failed',
            value: 'flow.run.failed',
            description: 'A flow run ended on an error',
          },
          {
            name: 'Flow Run Succeeded',
            value: 'flow.run.succeeded',
            description: 'A flow run finished, with links to what its steps made',
          },
          {
            name: 'Flow Run Waiting',
            value: 'flow.run.waiting',
            description: 'A flow run waits for a post to be approved in the studio',
          },
          {
            name: 'Image Generation Failed',
            value: 'image.generation.failed',
          },
          {
            name: 'Image Generation Succeeded',
            value: 'image.generation.succeeded',
          },
          {
            name: 'Video Generation Failed',
            value: 'video.generation.failed',
          },
          {
            name: 'Video Generation Succeeded',
            value: 'video.generation.succeeded',
          },
        ],
      },
      {
        displayName: 'Flow Name or ID',
        name: 'flowId',
        type: 'options',
        typeOptions: { loadOptionsMethod: 'getTriggerFlows' },
        default: '',
        description: 'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
        hint: 'Narrows the flow run events to one flow. Image and video events are not affected.',
      },
    ],
  };

  methods = {
    loadOptions: {
      getTriggerFlows,
    },
  };

  webhookMethods = {
    default: {
      async checkExists(this: IHookFunctions): Promise<boolean> {
        const staticData = this.getWorkflowStaticData('node');
        const webhookId = typeof staticData.webhookId === 'string' ? staticData.webhookId : '';
        // Without its secret a subscription cannot be verified: open a new one
        if (!webhookId || !staticData.webhookSecret) return false;
        const response = await eroqApiRequest.call(this, 'GET', '/webhooks') as { webhooks?: WebhookSubscription[] };
        const current = (response.webhooks ?? []).find(hook => hook.id === webhookId);
        if (current && current.url === this.getNodeWebhookUrl('default') && sameSettings(subscriptionShape(current), settingsOf(this))) {
          return true;
        }
        // Gone, or listening to something else: create() replaces it
        return false;
      },

      async create(this: IHookFunctions): Promise<boolean> {
        const url = this.getNodeWebhookUrl('default');
        if (!url) throw new NodeOperationError(this.getNode(), 'n8n gave this trigger no webhook URL');
        const settings = settingsOf(this);
        if (!settings.events.length) throw new NodeOperationError(this.getNode(), 'Pick at least one event');

        // Subscriptions left behind by this node would sign with a secret it no
        // longer holds: the one it stored (its URL may have changed with n8n's
        // public address) and any other on this exact URL, which is unique to
        // this trigger node (a deactivation that never reached eroq).
        const staticData = this.getWorkflowStaticData('node');
        const previousId = typeof staticData.webhookId === 'string' ? staticData.webhookId : '';
        const response = await eroqApiRequest.call(this, 'GET', '/webhooks') as { webhooks?: WebhookSubscription[] };
        for (const hook of response.webhooks ?? []) {
          if (hook.url !== url && hook.id !== previousId) continue;
          try {
            await eroqApiRequest.call(this, 'DELETE', `/webhooks/${encodeURIComponent(hook.id)}`);
          }
          catch (error) {
            if (readEroqError(error).status !== 404) throw eroqApiError(this.getNode(), error);
            this.logger.debug(`eroq webhook ${hook.id} was already gone`);
          }
        }

        const body: IDataObject = {
          url,
          events: settings.events,
          label: subscriptionLabel(this.getWorkflow().name),
        };
        if (settings.flowId) body.flow_id = settings.flowId;
        const created = await eroqApiRequest.call(this, 'POST', '/webhooks', body) as Partial<WebhookSubscription> & { secret?: string };
        if (!created.id || !created.secret) {
          forget(staticData);
          throw new NodeOperationError(this.getNode(), 'eroq did not return the subscription ID and its signing secret');
        }
        staticData.webhookId = created.id;
        staticData.webhookSecret = created.secret;
        return true;
      },

      async delete(this: IHookFunctions): Promise<boolean> {
        const staticData = this.getWorkflowStaticData('node');
        const webhookId = typeof staticData.webhookId === 'string' ? staticData.webhookId : '';
        if (webhookId) {
          try {
            await eroqApiRequest.call(this, 'DELETE', `/webhooks/${encodeURIComponent(webhookId)}`);
          }
          catch (error) {
            if (readEroqError(error).status !== 404) throw eroqApiError(this.getNode(), error);
            this.logger.debug(`eroq webhook ${webhookId} was already gone`);
          }
        }
        forget(staticData);
        return true;
      },
    },
  };

  async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
    const staticData = this.getWorkflowStaticData('node');
    const headers = this.getHeaderData();
    const verdict = verifySignature({
      secret: typeof staticData.webhookSecret === 'string' ? staticData.webhookSecret : '',
      header: headerValue(headers[SIGNATURE_HEADER]),
      body: await rawBodyOf(this),
      nowSeconds: Math.floor(Date.now() / 1000),
    });
    if (!verdict.valid) {
      // A second subscription on this URL (left behind, or added by hand in the
      // dashboard) signs with a secret this node never had. Once eroq confirms
      // this node's own subscription is alive, a 410 makes eroq delete the other
      // one. Without that check, a delivery racing the static-data save that
      // follows an activation could get the brand-new subscription deleted.
      const ownId = typeof staticData.webhookId === 'string' ? staticData.webhookId : '';
      const sentBy = headerValue(headers[SUBSCRIPTION_HEADER]);
      if (ownId && sentBy && sentBy !== ownId && await subscriptionAlive.call(this, ownId)) {
        return refuse(this, 410, 'This URL belongs to another eroq subscription');
      }
      return refuse(this, 401, verdict.reason);
    }

    const event = this.getBodyData();
    const type = typeof event.type === 'string' ? event.type : '';
    const { events, flowId } = settingsOf(this);
    // eroq filters already; this guards against settings changed on the eroq side
    const data = (event.data ?? {}) as IDataObject;
    const eventFlowId = ((data.flow ?? {}) as IDataObject).id;
    const wanted = type === 'webhook.test'
      || (events.includes(type) && (!flowId || !type.startsWith('flow.run.') || eventFlowId === flowId));
    if (!wanted) return { webhookResponse: { received: true, ignored: type || 'unknown' } };

    return { workflowData: [this.helpers.returnJsonArray([event])] };
  }
}
