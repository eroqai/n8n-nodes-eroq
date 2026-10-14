import type { IBinaryKeyData, IDataObject, IExecuteFunctions, INodeExecutionData } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';
import { downloadMedia } from './media';
import { pollUntil } from './poll';
import { eroqApiRequest } from './transport';
import type { GenerationJob } from './types';

export type GenerationKind = 'image' | 'video';

/** Poll cadence per kind: images land in seconds, clips in minutes. */
export const JOB_POLL_INTERVAL_MS: Record<GenerationKind, number> = { image: 2_500, video: 5_000 };

const ENDPOINT: Record<GenerationKind, string> = { image: '/images/generations', video: '/videos/generations' };

export interface DownloadOptions {
  download?: boolean;
  binaryPropertyName?: string;
}

export async function getJob(this: IExecuteFunctions, kind: GenerationKind, jobId: string, itemIndex: number): Promise<GenerationJob> {
  return await eroqApiRequest.call(this, 'GET', `${ENDPOINT[kind]}/${encodeURIComponent(jobId)}`, undefined, undefined, itemIndex) as GenerationJob;
}

/** Reads the job until it succeeds or fails; a failure throws with eroq's words (its credits are already back). */
export async function waitForJob(
  this: IExecuteFunctions,
  kind: GenerationKind,
  jobId: string,
  timeoutSeconds: number,
  itemIndex: number,
): Promise<GenerationJob> {
  const { value: job, settled } = await pollUntil<GenerationJob>({
    read: async () => await getJob.call(this, kind, jobId, itemIndex),
    settled: current => current.status !== 'processing',
    intervalMs: JOB_POLL_INTERVAL_MS[kind],
    timeoutMs: timeoutSeconds * 1000,
    signal: this.getExecutionCancelSignal?.(),
  });
  if (!settled) {
    throw new NodeOperationError(this.getNode(), `The ${kind} is still rendering after ${timeoutSeconds} seconds`, {
      itemIndex,
      description: `The render keeps going on eroq. Fetch it later with ${kind === 'image' ? 'Image' : 'Video'} > Get Job (job ID ${jobId}) or raise the timeout.`,
    });
  }
  if (job.status === 'failed') {
    throw new NodeOperationError(this.getNode(), job.error?.message || `The ${kind} failed`, {
      itemIndex,
      description: `Job ID ${jobId}${job.error?.code ? `, eroq error code: ${job.error.code}` : ''}. Failed renders are not charged.`,
    });
  }
  return job;
}

/** The job as an n8n item, with its files as binary data when asked (and when there are some). */
export async function jobItem(
  this: IExecuteFunctions,
  kind: GenerationKind,
  job: GenerationJob,
  options: DownloadOptions,
): Promise<INodeExecutionData> {
  if (!options.download || job.status !== 'succeeded' || !job.data?.length) return { json: job };
  const property = options.binaryPropertyName?.trim() || 'data';
  const binary: IBinaryKeyData = {};
  const data: IDataObject[] = [];
  for (const [index, media] of job.data.entries()) {
    const key = index === 0 ? property : `${property}_${index}`;
    binary[key] = await downloadMedia.call(this, media, `eroq-${kind}-${job.id}${index ? `-${index}` : ''}`, kind === 'image' ? 'webp' : 'mp4');
    // Inline renders are now in the binary field: no need to carry the base64 twice
    const kept: IDataObject = { ...media };
    delete kept.b64_json;
    data.push(kept);
  }
  return { json: { ...job, data }, binary };
}
