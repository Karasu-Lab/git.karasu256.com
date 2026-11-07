import { createHash, createHmac } from 'node:crypto';
import { z } from 'zod';

const storageEnvSchema = z.object({
  STORAGE_ENDPOINT: z.url(),
  STORAGE_BUCKET: z.string().min(1),
  STORAGE_ACCESS_KEY_ID: z.string().min(1),
  STORAGE_SECRET_ACCESS_KEY: z.string().min(1),
  STORAGE_REGION: z.string().default('auto'),
});

function storageEnv(env: Env) {
  return storageEnvSchema.parse(env);
}

function encodeSegment(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

function objectPath(key: string): string {
  return key.split('/').map(encodeSegment).join('/');
}

async function s3Request(
  env: Env,
  method: string,
  path: string,
  body?: Uint8Array,
  contentType?: string
): Promise<Response> {
  const storage = storageEnv(env);
  const endpoint = new URL(storage.STORAGE_ENDPOINT);
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${storage.STORAGE_REGION}/s3/aws4_request`;
  const payloadHash = createHash('sha256').update(body ?? new Uint8Array()).digest('hex');
  const canonicalUri = `${endpoint.pathname.replace(/\/$/, '')}${path}`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [
    method,
    canonicalUri,
    '',
    `host:${endpoint.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${storage.STORAGE_SECRET_ACCESS_KEY}`, dateStamp), storage.STORAGE_REGION), 's3'),
    'aws4_request'
  );
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    createHash('sha256').update(canonicalRequest, 'utf8').digest('hex'),
  ].join('\n');
  const signature = hmac(signingKey, stringToSign).toString('hex');
  return fetch(`${endpoint.origin}${canonicalUri}`, {
    method,
    headers: {
      authorization: `AWS4-HMAC-SHA256 Credential=${storage.STORAGE_ACCESS_KEY_ID}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      ...(contentType ? { 'content-type': contentType } : {}),
    },
    body: body ? Buffer.from(body) : undefined,
  });
}

async function errorDetail(response: Response): Promise<string> {
  const text = await response.text().catch(() => '');
  return text.slice(0, 300);
}

export async function ensureBucket(env: Env): Promise<{ bucket: string; created: boolean }> {
  const bucket = storageEnv(env).STORAGE_BUCKET;
  const response = await s3Request(env, 'PUT', `/${encodeSegment(bucket)}`);
  if (response.ok) return { bucket, created: true };
  const detail = await errorDetail(response);
  if (
    detail.includes('BucketAlreadyExists') ||
    detail.includes('BucketAlreadyOwnedByYou') ||
    response.status === 409
  ) {
    return { bucket, created: false };
  }
  throw new Error(`Creating the storage bucket ${bucket} failed (${response.status}): ${detail}`);
}

export async function getObject(env: Env, key: string): Promise<Uint8Array | null> {
  const response = await s3Request(env, 'GET', `/${encodeSegment(storageEnv(env).STORAGE_BUCKET)}/${objectPath(key)}`);
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Reading ${key} from the storage bucket failed (${response.status}): ${await errorDetail(response)}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

export async function putObject(env: Env, key: string, body: Uint8Array, contentType: string): Promise<void> {
  const response = await s3Request(env, 'PUT', `/${encodeSegment(storageEnv(env).STORAGE_BUCKET)}/${objectPath(key)}`, body, contentType);
  if (!response.ok) {
    throw new Error(`Writing ${key} to the storage bucket failed (${response.status}): ${await errorDetail(response)}`);
  }
}
