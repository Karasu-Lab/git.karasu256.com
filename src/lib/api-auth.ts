import { MissingEnvError, signRequest } from '@karasu-lab/utils/server';

export class ApiAuthError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, code: string | null, detail: string) {
    super(`api-auth request failed (${status}): ${detail}`);
    this.status = status;
    this.code = code;
  }
}

function errorCodeOf(detail: string): string | null {
  try {
    const parsed = JSON.parse(detail) as { error?: unknown };
    return typeof parsed.error === 'string' ? parsed.error : null;
  } catch {
    return null;
  }
}

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
    throw new ApiAuthError(response.status, errorCodeOf(detail), detail.slice(0, 300));
  }
  return (await response.json()) as T;
}

export async function getInstallationToken(env: Env, organizationId: string): Promise<string> {
  const data = await apiAuthJson<{ token: string; expiresAt: string }>(
    env,
    `/api/internal/tenants/${encodeURIComponent(organizationId)}/github-installation-token`,
    {}
  );
  return data.token;
}
