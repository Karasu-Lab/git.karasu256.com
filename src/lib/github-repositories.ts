import { z } from 'zod';
import { getInstallationToken } from './api-auth';
import {
  branchNameSchema,
  byteLength,
  clientPayloadSchema,
  encodePathSegments,
  fileContentSchema,
  filePathSchema,
  ownerLoginSchema,
  repositoryFullNameSchema,
  repositoryNameSchema,
  shaSchema,
} from './validation';

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

const associatedPullRequestSchema = z.object({
  number: z.number(),
  html_url: z.string(),
  merged_at: z.string().nullable(),
  merge_commit_sha: z.string().nullable(),
  head: z.object({ ref: z.string(), sha: z.string() }),
});

const issueCommentSchema = z.object({
  id: z.number(),
  html_url: z.string(),
});

export interface InstallationRepository {
  id: number;
  fullName: string;
  name: string;
  private: boolean;
  htmlUrl: string;
  defaultBranch: string;
}

export class BranchExistsError extends Error {
  readonly branch: string;

  constructor(branch: string) {
    super(`branch ${branch} already exists`);
    this.name = 'BranchExistsError';
    this.branch = branch;
  }
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
  const path = target.type === 'Organization' ? `/orgs/${encodeURIComponent(target.login)}/repos` : '/user/repos';
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
  const path = `/repos/${encodePathSegments(repositoryFullName)}`;
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
  const path = `/repos/${encodePathSegments(repositoryFullName)}/pulls/${pullRequestNumber}/merge`;
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
    `/repos/${encodePathSegments(input.repositoryFullName)}/pulls`,
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

export async function findMergedPullRequestByCommit(
  env: Env,
  organizationId: string,
  repositoryFullName: string,
  sha: string
): Promise<{ number: number; url: string; headRef: string; headSha: string } | null> {
  const token = await getInstallationToken(env, organizationId);
  const associated = await githubJson(
    token,
    `/repos/${encodePathSegments(repositoryFullName)}/commits/${encodeURIComponent(sha)}/pulls`,
    z.array(associatedPullRequestSchema)
  );
  const merged = associated.filter((entry) => entry.merged_at !== null);
  const match = merged.find((entry) => entry.merge_commit_sha === sha) ?? merged[0];
  if (!match) return null;
  return { number: match.number, url: match.html_url, headRef: match.head.ref, headSha: match.head.sha };
}

export async function createIssueComment(
  env: Env,
  organizationId: string,
  repositoryFullName: string,
  issueNumber: number,
  body: string
): Promise<{ id: number; url: string }> {
  const token = await getInstallationToken(env, organizationId);
  const created = await githubJson(token, `/repos/${encodePathSegments(repositoryFullName)}/issues/${issueNumber}/comments`, issueCommentSchema, {
    method: 'POST',
    body: JSON.stringify({ body }),
  });
  return { id: created.id, url: created.html_url };
}

export async function updateIssueComment(
  env: Env,
  organizationId: string,
  repositoryFullName: string,
  commentId: number,
  body: string
): Promise<{ url: string }> {
  const token = await getInstallationToken(env, organizationId);
  const updated = await githubJson(token, `/repos/${encodePathSegments(repositoryFullName)}/issues/comments/${commentId}`, issueCommentSchema, {
    method: 'PATCH',
    body: JSON.stringify({ body }),
  });
  return { url: updated.html_url };
}

function gitObjectSchema() {
  return z.object({ sha: z.string() });
}

function gitRefSchema() {
  return z.object({ object: z.object({ sha: z.string() }) });
}

function gitCommitSchema() {
  return z.object({ tree: z.object({ sha: z.string() }) });
}

const commitStatusSchema = z.object({
  id: z.number(),
});

export type CommitStatusState = 'error' | 'failure' | 'pending' | 'success';

export async function createCommitStatus(
  env: Env,
  organizationId: string,
  repositoryFullName: string,
  sha: string,
  input: { state: CommitStatusState; context: string; description?: string; targetUrl?: string }
): Promise<{ id: number }> {
  const token = await getInstallationToken(env, organizationId);
  const created = await githubJson(token, `/repos/${encodePathSegments(repositoryFullName)}/statuses/${encodeURIComponent(sha)}`, commitStatusSchema, {
    method: 'POST',
    body: JSON.stringify({
      state: input.state,
      context: input.context,
      description: input.description,
      target_url: input.targetUrl,
    }),
  });
  return { id: created.id };
}

async function githubGit<T>(token: string, path: string, schema: z.ZodType<T>, body: unknown): Promise<T> {
  return githubJson(token, path, schema, { method: 'POST', body: JSON.stringify(body) });
}

async function branchExists(token: string, repoPath: string, branch: string): Promise<boolean> {
  const path = `${repoPath}/git/ref/heads/${encodePathSegments(branch)}`;
  const response = await githubFetch(token, path);
  if (response.status === 404) return false;
  if (!response.ok) throw new Error(JSON.stringify({ error: 'github_api_error', status: response.status, path }));
  return true;
}

export async function commitContentsToNewBranch(
  env: Env,
  organizationId: string,
  input: {
    repositoryFullName: string;
    branch: string;
    baseBranch: string;
    message: string;
    files: { path: string; content: string }[];
    deletions: string[];
  }
): Promise<{ outcome: 'pushed'; commitOid: string; branch: string } | { outcome: 'no_changes'; branch: string }> {
  const token = await getInstallationToken(env, organizationId);
  const repoPath = `/repos/${encodePathSegments(input.repositoryFullName)}`;
  if (await branchExists(token, repoPath, input.branch)) throw new BranchExistsError(input.branch);

  const baseRef = await githubJson(token, `${repoPath}/git/ref/heads/${encodePathSegments(input.baseBranch)}`, gitRefSchema());
  const baseSha = baseRef.object.sha;
  const baseCommit = await githubJson(token, `${repoPath}/git/commits/${encodeURIComponent(baseSha)}`, gitCommitSchema());
  const baseTreeSha = baseCommit.tree.sha;

  const blobs = await Promise.all(
    input.files.map(async (file) => {
      const blob = await githubGit(token, `${repoPath}/git/blobs`, gitObjectSchema(), {
        content: file.content,
        encoding: 'utf-8',
      });
      return { path: file.path, mode: '100644', type: 'blob', sha: blob.sha };
    })
  );
  const removals = input.deletions.map((path) => ({ path, mode: '100644', type: 'blob', sha: null }));
  const tree = await githubGit(token, `${repoPath}/git/trees`, gitObjectSchema(), {
    base_tree: baseTreeSha,
    tree: [...blobs, ...removals],
  });
  if (tree.sha === baseTreeSha) return { outcome: 'no_changes', branch: input.branch };

  const commit = await githubGit(token, `${repoPath}/git/commits`, gitObjectSchema(), {
    message: input.message,
    tree: tree.sha,
    parents: [baseSha],
  });

  const refPath = `${repoPath}/git/refs`;
  const response = await githubFetch(token, refPath, {
    method: 'POST',
    body: JSON.stringify({ ref: `refs/heads/${input.branch}`, sha: commit.sha }),
  });
  if (response.status === 422) throw new BranchExistsError(input.branch);
  if (!response.ok) throw new Error(JSON.stringify({ error: 'github_api_error', status: response.status, path: refPath }));
  return { outcome: 'pushed', commitOid: commit.sha, branch: input.branch };
}

export async function createRepositoryDispatch(
  env: Env,
  organizationId: string,
  repositoryFullName: string,
  eventType: string,
  clientPayload: Record<string, unknown>
): Promise<void> {
  const token = await getInstallationToken(env, organizationId);
  const path = `/repos/${encodePathSegments(repositoryFullName)}/dispatches`;
  const response = await githubFetch(token, path, {
    method: 'POST',
    body: JSON.stringify({ event_type: eventType, client_payload: clientPayload }),
  });
  if (!response.ok) throw new Error(JSON.stringify({ error: 'github_api_error', status: response.status, path }));
}

export const findPullRequestByCommitRequestSchema = z.object({
  organizationId: z.string().min(1),
  repositoryFullName: repositoryFullNameSchema(),
  sha: shaSchema(),
});

export const createCommentRequestSchema = z.object({
  organizationId: z.string().min(1),
  repositoryFullName: repositoryFullNameSchema(),
  issueNumber: z.number().int().positive(),
  body: z.string().min(1),
});

export const updateCommentRequestSchema = z.object({
  organizationId: z.string().min(1),
  repositoryFullName: repositoryFullNameSchema(),
  commentId: z.number().int().positive(),
  body: z.string().min(1),
});

export const createStatusRequestSchema = z.object({
  organizationId: z.string().min(1),
  repositoryFullName: repositoryFullNameSchema(),
  sha: shaSchema(),
  state: z.enum(['error', 'failure', 'pending', 'success']),
  context: z.string().min(1),
  description: z.string().max(140).optional(),
  targetUrl: z.string().url().optional(),
});

export const listRepositoriesRequestSchema = z.object({
  organizationId: z.string().min(1),
});

export const createRepositoryRequestSchema = z.object({
  organizationId: z.string().min(1),
  targetType: z.enum(['Organization', 'User']),
  targetLogin: ownerLoginSchema(),
  name: repositoryNameSchema(),
  description: z.string().max(350).optional(),
  private: z.boolean().optional(),
  isTemplate: z.boolean().optional(),
});

export const createPullRequestRequestSchema = z.object({
  organizationId: z.string().min(1),
  repositoryFullName: repositoryFullNameSchema(),
  title: z.string().min(1),
  head: branchNameSchema(),
  base: branchNameSchema(),
  body: z.string().optional(),
  enableAutoMerge: z.boolean().optional(),
});

export function commitContentsRequestSchema() {
  const maxFiles = 50;
  const maxTotalBytes = 4 * 1024 * 1024;
  return z
    .object({
      organizationId: z.string().min(1),
      repositoryFullName: repositoryFullNameSchema(),
      branch: branchNameSchema(),
      baseBranch: branchNameSchema(),
      message: z.string().min(1),
      files: z.array(z.object({ path: filePathSchema(), content: fileContentSchema() })).max(maxFiles).default([]),
      deletions: z.array(filePathSchema()).max(maxFiles).default([]),
    })
    .refine((value) => value.files.reduce((total, file) => total + byteLength(file.content), 0) <= maxTotalBytes)
    .refine((value) => {
      const paths = [...value.files.map((file) => file.path), ...value.deletions];
      return new Set(paths).size === paths.length;
    });
}

export function createDispatchRequestSchema() {
  return z.object({
    organizationId: z.string().min(1),
    repositoryFullName: repositoryFullNameSchema(),
    eventType: z.enum(['pointer-update', 'link-package', 'unlink-package']),
    clientPayload: clientPayloadSchema(),
  });
}
