import { z } from 'zod';
import { getInstallationToken } from './api-auth';

const GITHUB_API_URL = 'https://api.github.com';

const repositorySchema = z.object({
  id: z.number(),
  full_name: z.string(),
  name: z.string(),
  private: z.boolean(),
  html_url: z.string(),
  default_branch: z.string(),
});

const repositoryListSchema = z.object({
  total_count: z.number(),
  repositories: z.array(repositorySchema),
});

const pullRequestSchema = z.object({
  number: z.number(),
  html_url: z.string(),
  node_id: z.string(),
});

export interface InstallationRepository {
  id: number;
  fullName: string;
  name: string;
  private: boolean;
  htmlUrl: string;
  defaultBranch: string;
}

class AutoMergeNotGatedError extends Error {
  constructor() {
    super('auto-merge is not available because the branch has no protection rules');
    this.name = 'AutoMergeNotGatedError';
  }
}

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

async function githubJson<T>(token: string, path: string, schema: z.ZodType<T>, init?: RequestInit): Promise<T> {
  const response = await githubFetch(token, path, init);
  if (!response.ok) {
    throw new Error(JSON.stringify({ error: 'github_api_error', status: response.status, path }));
  }
  const parsed = schema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    throw new Error(JSON.stringify({ error: 'github_api_invalid_response', path }));
  }
  return parsed.data;
}

function mapRepository(repository: z.infer<typeof repositorySchema>): InstallationRepository {
  return {
    id: repository.id,
    fullName: repository.full_name,
    name: repository.name,
    private: repository.private,
    htmlUrl: repository.html_url,
    defaultBranch: repository.default_branch,
  };
}

export async function listInstallationRepositories(env: Env, organizationId: string): Promise<InstallationRepository[]> {
  const token = await getInstallationToken(env, organizationId);
  const repositories: InstallationRepository[] = [];
  let page = 1;
  for (;;) {
    const list = await githubJson(token, `/installation/repositories?per_page=100&page=${page}`, repositoryListSchema);
    repositories.push(...list.repositories.map(mapRepository));
    if (repositories.length >= list.total_count || list.repositories.length === 0) return repositories;
    page += 1;
  }
}

export async function createInstallationRepository(
  env: Env,
  organizationId: string,
  target: { type: string; login: string },
  body: { name: string; description?: string; private?: boolean; isTemplate?: boolean }
): Promise<InstallationRepository> {
  const token = await getInstallationToken(env, organizationId);
  const path = target.type === 'Organization' ? `/orgs/${target.login}/repos` : '/user/repos';
  const created = await githubJson(token, path, repositorySchema, {
    method: 'POST',
    body: JSON.stringify({
      name: body.name,
      description: body.description,
      private: body.private ?? true,
      is_template: body.isTemplate ?? false,
      auto_init: true,
    }),
  });
  return mapRepository(created);
}

async function enableRepositoryAutoMerge(token: string, repositoryFullName: string): Promise<void> {
  const path = `/repos/${repositoryFullName}`;
  const response = await githubFetch(token, path, {
    method: 'PATCH',
    body: JSON.stringify({ allow_auto_merge: true }),
  });
  if (!response.ok) throw new Error(JSON.stringify({ error: 'github_api_error', status: response.status, path }));
}

async function enablePullRequestAutoMerge(token: string, pullRequestNodeId: string): Promise<void> {
  const response = await githubFetch(token, '/graphql', {
    method: 'POST',
    body: JSON.stringify({
      query: 'mutation($id: ID!) { enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: MERGE }) { clientMutationId } }',
      variables: { id: pullRequestNodeId },
    }),
  });
  if (!response.ok) {
    throw new Error(JSON.stringify({ error: 'github_api_error', status: response.status, path: '/graphql' }));
  }
  const payload = (await response.json().catch(() => null)) as { errors?: { message?: unknown }[] } | null;
  if (!payload) throw new Error(JSON.stringify({ error: 'github_api_invalid_response', path: '/graphql' }));
  if (payload.errors) {
    const messages = payload.errors.map((entry) => (typeof entry.message === 'string' ? entry.message : 'unknown error'));
    if (messages.some((message) => message.includes('Protected branch rules not configured'))) throw new AutoMergeNotGatedError();
    throw new Error(JSON.stringify({ error: 'github_graphql_error', path: '/graphql', message: messages.join('; ') }));
  }
}

async function mergePullRequest(token: string, repositoryFullName: string, pullRequestNumber: number): Promise<void> {
  const path = `/repos/${repositoryFullName}/pulls/${pullRequestNumber}/merge`;
  const response = await githubFetch(token, path, {
    method: 'PUT',
    body: JSON.stringify({ merge_method: 'merge' }),
  });
  if (!response.ok) throw new Error(JSON.stringify({ error: 'github_api_error', status: response.status, path }));
}

export async function createBotPullRequest(
  env: Env,
  organizationId: string,
  input: {
    repositoryFullName: string;
    title: string;
    head: string;
    base: string;
    body?: string;
    enableAutoMerge?: boolean;
  }
): Promise<{ number: number; url: string; autoMergeEnabled: boolean }> {
  const token = await getInstallationToken(env, organizationId);
  if (input.enableAutoMerge) {
    await enableRepositoryAutoMerge(token, input.repositoryFullName);
  }
  const created = await githubJson(
    token,
    `/repos/${input.repositoryFullName}/pulls`,
    pullRequestSchema,
    {
      method: 'POST',
      body: JSON.stringify({ title: input.title, head: input.head, base: input.base, body: input.body }),
    }
  );
  if (input.enableAutoMerge) {
    try {
      await enablePullRequestAutoMerge(token, created.node_id);
    } catch (error) {
      if (!(error instanceof AutoMergeNotGatedError)) throw error;
      await mergePullRequest(token, input.repositoryFullName, created.number);
    }
  }
  return { number: created.number, url: created.html_url, autoMergeEnabled: input.enableAutoMerge ?? false };
}

export const listRepositoriesRequestSchema = z.object({
  organizationId: z.string().min(1),
});

export const createRepositoryRequestSchema = z.object({
  organizationId: z.string().min(1),
  targetType: z.enum(['Organization', 'User']),
  targetLogin: z.string().min(1),
  name: z.string().trim().min(1).max(100),
  description: z.string().max(350).optional(),
  private: z.boolean().optional(),
  isTemplate: z.boolean().optional(),
});

export const createPullRequestRequestSchema = z.object({
  organizationId: z.string().min(1),
  repositoryFullName: z.string().min(1),
  title: z.string().min(1),
  head: z.string().min(1),
  base: z.string().min(1),
  body: z.string().optional(),
  enableAutoMerge: z.boolean().optional(),
});
