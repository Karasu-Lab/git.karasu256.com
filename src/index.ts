import { Elysia } from 'elysia';
import { CloudflareAdapter } from 'elysia/adapter/cloudflare-worker';
import { env as cfEnv } from 'cloudflare:workers';
import { z } from 'zod';
import { resolveEnv } from './constants';
import { ApiAuthError } from './lib/api-auth';
import {
  BranchExistsError,
  commitContentsRequestSchema,
  commitContentsToNewBranch,
  createBotPullRequest,
  createCommentRequestSchema,
  createCommitStatus,
  createInstallationRepository,
  createIssueComment,
  createDispatchRequestSchema,
  createPullRequestRequestSchema,
  createRepositoryDispatch,
  createRepositoryRequestSchema,
  createStatusRequestSchema,
  findMergedPullRequestByCommit,
  findPullRequestByCommitRequestSchema,
  listInstallationRepositories,
  listRepositoriesRequestSchema,
  updateCommentRequestSchema,
  updateIssueComment,
} from './lib/github-repositories';
import { rejectInvalidSignature } from './lib/signature-gate';

const env = resolveEnv(cfEnv as Env);

const app = new Elysia({ adapter: CloudflareAdapter, aot: false, normalize: 'typebox' })
  .onError(({ error, code }) => {
    if (code === 'NOT_FOUND') {
      return Response.json({ error: 'not_found' }, { status: 404 });
    }
    if (error instanceof ApiAuthError && error.code) {
      return Response.json({ error: error.code }, { status: error.status });
    }
    if (error instanceof BranchExistsError) {
      return Response.json({ error: 'branch_exists', branch: error.branch }, { status: 409 });
    }
    if (error instanceof z.ZodError) {
      return Response.json({ error: 'Bad Request', issues: error.issues.map((issue) => issue.message) }, { status: 400 });
    }
    return Response.json(
      { error: error instanceof Error ? error.message : 'Internal Server Error' },
      { status: 500 }
    );
  })
  .post('/api/internal/repositories/list', async ({ body }) => {
    const parsed = listRepositoriesRequestSchema.safeParse(body);
    if (!parsed.success) return Response.json({ error: 'Bad Request' }, { status: 400 });
    const repositories = await listInstallationRepositories(env, parsed.data.organizationId);
    return Response.json({ repositories });
  })
  .post('/api/internal/repositories/create', async ({ body }) => {
    const parsed = createRepositoryRequestSchema.safeParse(body);
    if (!parsed.success) return Response.json({ error: 'Bad Request' }, { status: 400 });
    const { organizationId, targetType, targetLogin, ...repository } = parsed.data;
    const created = await createInstallationRepository(env, organizationId, { type: targetType, login: targetLogin }, repository);
    return Response.json({ repository: created });
  })
  .post('/api/internal/pull-requests/create', async ({ body }) => {
    const parsed = createPullRequestRequestSchema.safeParse(body);
    if (!parsed.success) return Response.json({ error: 'Bad Request' }, { status: 400 });
    const { organizationId, ...input } = parsed.data;
    const pullRequest = await createBotPullRequest(env, organizationId, input);
    return Response.json({ pullRequest });
  })
  .post('/api/internal/pull-requests/find-by-commit', async ({ body }) => {
    const parsed = findPullRequestByCommitRequestSchema.safeParse(body);
    if (!parsed.success) return Response.json({ error: 'Bad Request' }, { status: 400 });
    const pullRequest = await findMergedPullRequestByCommit(
      env,
      parsed.data.organizationId,
      parsed.data.repositoryFullName,
      parsed.data.sha
    );
    return Response.json({ pullRequest });
  })
  .post('/api/internal/comments/create', async ({ body }) => {
    const parsed = createCommentRequestSchema.safeParse(body);
    if (!parsed.success) return Response.json({ error: 'Bad Request' }, { status: 400 });
    const comment = await createIssueComment(
      env,
      parsed.data.organizationId,
      parsed.data.repositoryFullName,
      parsed.data.issueNumber,
      parsed.data.body
    );
    return Response.json({ comment });
  })
  .post('/api/internal/comments/update', async ({ body }) => {
    const parsed = updateCommentRequestSchema.safeParse(body);
    if (!parsed.success) return Response.json({ error: 'Bad Request' }, { status: 400 });
    const comment = await updateIssueComment(
      env,
      parsed.data.organizationId,
      parsed.data.repositoryFullName,
      parsed.data.commentId,
      parsed.data.body
    );
    return Response.json({ comment });
  })
  .post('/api/internal/statuses/create', async ({ body }) => {
    const parsed = createStatusRequestSchema.safeParse(body);
    if (!parsed.success) return Response.json({ error: 'Bad Request' }, { status: 400 });
    const status = await createCommitStatus(env, parsed.data.organizationId, parsed.data.repositoryFullName, parsed.data.sha, {
      state: parsed.data.state,
      context: parsed.data.context,
      description: parsed.data.description,
      targetUrl: parsed.data.targetUrl,
    });
    return Response.json({ status });
  })
  .post('/api/internal/contents/commit', async ({ body }) => {
    const parsed = commitContentsRequestSchema().safeParse(body);
    if (!parsed.success) return Response.json({ error: 'Bad Request' }, { status: 400 });
    const { organizationId, ...input } = parsed.data;
    return Response.json(await commitContentsToNewBranch(env, organizationId, input));
  })
  .post('/api/internal/dispatches/create', async ({ body }) => {
    const parsed = createDispatchRequestSchema().safeParse(body);
    if (!parsed.success) return Response.json({ error: 'Bad Request' }, { status: 400 });
    await createRepositoryDispatch(
      env,
      parsed.data.organizationId,
      parsed.data.repositoryFullName,
      parsed.data.eventType,
      parsed.data.clientPayload
    );
    return Response.json({ dispatched: true });
  });

export default {
  async fetch(request: Request): Promise<Response> {
    const rejected = await rejectInvalidSignature(env, request);
    return rejected ?? (await app.fetch(request));
  },
};
