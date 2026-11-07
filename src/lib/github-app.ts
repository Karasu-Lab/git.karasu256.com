import { z } from 'zod';
import { getAppJwt } from './api-auth';

const GITHUB_API_URL = 'https://api.github.com';

export const reregisterWebhookRequestSchema = z.object({
  url: z.string().min(1),
  secret: z.string().min(1),
});

const appHookConfigSchema = z.object({
  url: z.string(),
});

async function githubFetch(token: string, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${GITHUB_API_URL}${path}`, {
    ...init,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: ['Bearer', token].join(' '),
      'user-agent': 'karasu-lab-git',
      'x-github-api-version': '2022-11-28',
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
    },
    cache: 'no-store',
  });
}

export async function reregisterAppWebhook(env: Env, input: { url: string; secret: string }): Promise<{ url: string }> {
  const jwt = await getAppJwt(env);
  const configPath = '/app/hook/config';
  const configResponse = await githubFetch(jwt, configPath, {
    method: 'PATCH',
    body: JSON.stringify({ url: input.url, content_type: 'json', insecure_ssl: '0', secret: input.secret }),
  });
  if (!configResponse.ok) {
    throw new Error(JSON.stringify({ error: 'github_api_error', status: configResponse.status, path: configPath }));
  }
  const config = appHookConfigSchema.parse(await configResponse.json().catch(() => null));
  return { url: config.url };
}
