import type { IBinaryData, IDataObject, IExecuteFunctions } from 'n8n-workflow';
import { NodeOperationError } from 'n8n-workflow';

/** One rendered file as the generation endpoints describe it. */
export interface MediaItem {
  url?: string;
  b64_json?: string;
  content_type?: string;
}

const EXTENSIONS: Record<string, string> = {
  'image/webp': 'webp',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
};

export function extensionFor(contentType: string | undefined, fallback: string): string {
  const bare = (contentType ?? '').split(';')[0].trim().toLowerCase();
  return EXTENSIONS[bare] ?? fallback;
}

function headerText(value: unknown): string | undefined {
  if (Array.isArray(value)) return headerText(value[0]);
  return typeof value === 'string' && value ? value : undefined;
}

/**
 * The bytes of a finished render as n8n binary data. Signed CDN links are
 * fetched WITHOUT the eroq key (it must never travel to a CDN); inline
 * base64 (private renders) is decoded as is.
 */
export async function downloadMedia(
  this: IExecuteFunctions,
  media: MediaItem,
  fileStem: string,
  fallbackExtension: string,
): Promise<IBinaryData> {
  let data: Buffer;
  let contentType = media.content_type;
  if (media.b64_json) {
    data = Buffer.from(media.b64_json, 'base64');
  }
  else if (media.url) {
    const response = (await this.helpers.httpRequest({
      method: 'GET',
      url: media.url,
      encoding: 'arraybuffer',
      returnFullResponse: true,
      json: false,
    })) as { body: ArrayBuffer | Buffer; headers?: IDataObject };
    data = Buffer.isBuffer(response.body) ? response.body : Buffer.from(response.body);
    contentType = headerText(response.headers?.['content-type']) ?? contentType;
  }
  else {
    throw new NodeOperationError(this.getNode(), 'The render has no file to download');
  }
  const mimeType = (contentType ?? 'application/octet-stream').split(';')[0].trim();
  return await this.helpers.prepareBinaryData(data, `${fileStem}.${extensionFor(mimeType, fallbackExtension)}`, mimeType);
}
