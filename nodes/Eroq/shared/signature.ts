import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * eroq signs every webhook delivery Stripe-style:
 *   eroq-signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
 * The receiver rebuilds the HMAC over the exact bytes it got and compares in
 * constant time; a timestamp more than five minutes away is refused (replays).
 */
export const SIGNATURE_HEADER = 'eroq-signature';
export const SIGNATURE_TOLERANCE_SECONDS = 300;

export interface ParsedSignature {
  timestamp?: number;
  signatures: string[];
}

export function parseSignatureHeader(header: string): ParsedSignature {
  const parsed: ParsedSignature = { signatures: [] };
  for (const part of header.split(',')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === 't' && /^\d+$/.test(value)) parsed.timestamp = Number(value);
    else if (key === 'v1' && /^[0-9a-f]{64}$/i.test(value)) parsed.signatures.push(value.toLowerCase());
  }
  return parsed;
}

/** HMAC-SHA256 of `<timestamp>.<body>`, hex — what eroq puts in `v1`. */
export function signPayload(secret: string, timestamp: number, body: Buffer | string): string {
  return createHmac('sha256', secret).update(`${timestamp}.`).update(body).digest('hex');
}

export type SignatureVerdict = { valid: true } | { valid: false; reason: string };

export interface VerifyInput {
  secret: string;
  header: string | undefined;
  body: Buffer | string;
  nowSeconds: number;
  toleranceSeconds?: number;
}

export function verifySignature(input: VerifyInput): SignatureVerdict {
  if (!input.secret) return { valid: false, reason: 'This trigger has no signing secret: deactivate and activate the workflow again' };
  if (!input.header) return { valid: false, reason: `Missing ${SIGNATURE_HEADER} header` };
  const { timestamp, signatures } = parseSignatureHeader(input.header);
  if (timestamp === undefined || !signatures.length) return { valid: false, reason: `Malformed ${SIGNATURE_HEADER} header` };
  const tolerance = input.toleranceSeconds ?? SIGNATURE_TOLERANCE_SECONDS;
  if (Math.abs(input.nowSeconds - timestamp) > tolerance) return { valid: false, reason: 'Signature timestamp is too old or in the future' };
  const expected = Buffer.from(signPayload(input.secret, timestamp, input.body), 'hex');
  const matches = signatures.some((signature) => {
    const given = Buffer.from(signature, 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  return matches ? { valid: true } : { valid: false, reason: 'Signature mismatch' };
}
