import { MissingEnvError, signRequest } from '@karasu-lab/utils/server';

async function apiAuthJson<T>(env: Env, path: string, body: unknown): Promise<T> {
  const secret = env.INTERNAL_API_SECRET;
  if (!secret) throw new MissingEnvError('INTERNAL_API_SECRET');
  const method = 'POST';
  const url = `${env.AUTH_API_URL.replace(/\/+$/, '')}${path}`;
  const serialized = JSON.stringify(body);
  const response = await fetch(url, {
    method,
    headers: {
      'content-type': 'application/json',
      ...signRequest({ secret, method, url, body: serialized }),
    },
    body: serialized,
    cache: 'no-store',
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`api-auth request failed (${response.status}): ${detail.slice(0, 300)}`);
  }
  return (await response.json()) as T;
}

export async function getInstallationToken(env: Env, organizationId: string): Promise<string> {
  const data = await apiAuthJson<{ token: string; expiresAt: string }>(
    env,
    `/api/internal/tenants/${organizationId}/github-installation-token`,
    {}
  );
  return data.token;
}

export interface SigningKeyMaterial {
  userId: string;
  privateKey: string;
  publicKey: string;
  committerName: string;
  committerEmail: string;
}

export async function getSigningKeyMaterial(env: Env, userId: string): Promise<SigningKeyMaterial> {
  return apiAuthJson<SigningKeyMaterial>(env, `/api/internal/users/${encodeURIComponent(userId)}/signing-key-material`, {});
}
