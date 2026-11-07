import { Elysia } from 'elysia';
import { CloudflareAdapter } from 'elysia/adapter/cloudflare-worker';
import { env as cfEnv } from 'cloudflare:workers';
import { z } from 'zod';
import { resolveEnv } from './constants';
import {
  MirrorNotSeededError,
  commitRequestSchema,
  runMirrorSync,
  runMirrorUploadUrl,
  runSignedCommit,
} from './lib/commit';
import { checkRepositoryAccess } from './lib/repository-access';
import { rejectInvalidSignature } from './lib/signature-gate';
import { ensureBucket } from './lib/storage';

const env = resolveEnv(cfEnv as Env);

const organizationRepositorySchema = z.object({
  organizationId: z.string().min(1),
  repositoryId: z.number().int(),
  repositoryFullName: z.string().min(1),
});

const accessRequestSchema = z.object({
  repositoryId: z.number().int(),
});

const uploadUrlRequestSchema = z.object({
  repositoryId: z.number().int(),
  repositoryFullName: z.string().min(1),
});

function mirrorNotSeededResponse(error: unknown): Response | null {
  if (error instanceof MirrorNotSeededError) {
    return Response.json(
      { error: 'mirror_not_seeded', repositoryFullName: error.repositoryFullName },
      { status: 409 }
    );
  }
  return null;
}

async function readJson(request: Request): Promise<unknown> {
  return request.clone().json().catch(() => null);
}

const app = new Elysia({ adapter: CloudflareAdapter, aot: false, normalize: 'typebox' })
  .onError(({ error }) => {
    if (error instanceof z.ZodError) {
      return Response.json({ error: 'Bad Request', issues: error.issues.map((issue) => issue.message) }, { status: 400 });
    }
    return Response.json(
      { error: error instanceof Error ? error.message : 'Internal Server Error' },
      { status: 500 }
    );
  })
  .post('/api/internal/storage/bucket', async () => {
    const result = await ensureBucket(env);
    return Response.json({ bucket: result.bucket, created: result.created });
  })
  .post('/api/internal/repositories/access', async ({ request }) => {
    const parsed = accessRequestSchema.safeParse(await readJson(request));
    if (!parsed.success) return Response.json({ error: 'Bad Request' }, { status: 400 });
    const access = await checkRepositoryAccess(env, parsed.data.repositoryId);
    return Response.json(access);
  })
  .post('/api/internal/mirrors/upload-url', async ({ request }) => {
    const parsed = uploadUrlRequestSchema.safeParse(await readJson(request));
    if (!parsed.success) return Response.json({ error: 'Bad Request' }, { status: 400 });
    const result = await runMirrorUploadUrl(env, parsed.data.repositoryId, parsed.data.repositoryFullName);
    if ('outcome' in result && result.outcome === 'blocked') {
      return Response.json(
        {
          accepted: false,
          repositoryId: result.repositoryId,
          remote: result.remote,
          visibility: result.visibility,
          allowed: false,
          reason: result.reason,
        },
        { status: 403 }
      );
    }
    return Response.json(result);
  })
  .post('/api/internal/mirrors/sync', async ({ request }) => {
    const parsed = organizationRepositorySchema.safeParse(await readJson(request));
    if (!parsed.success) return Response.json({ error: 'Bad Request' }, { status: 400 });
    let result: Awaited<ReturnType<typeof runMirrorSync>>;
    try {
      result = await runMirrorSync(
        env,
        parsed.data.organizationId,
        parsed.data.repositoryId,
        parsed.data.repositoryFullName
      );
    } catch (error) {
      const response = mirrorNotSeededResponse(error);
      if (response) return response;
      throw error;
    }
    if ('outcome' in result && result.outcome === 'blocked') {
      return Response.json(
        {
          accepted: false,
          repositoryId: result.repositoryId,
          remote: result.remote,
          visibility: result.visibility,
          allowed: false,
          reason: result.reason,
        },
        { status: 403 }
      );
    }
    return Response.json(result);
  })
  .post('/api/internal/mirrors/commit', async ({ request }) => {
    const parsed = commitRequestSchema.safeParse(await readJson(request));
    if (!parsed.success) return Response.json({ error: 'Bad Request' }, { status: 400 });
    let result: Awaited<ReturnType<typeof runSignedCommit>>;
    try {
      result = await runSignedCommit(env, parsed.data);
    } catch (error) {
      const response = mirrorNotSeededResponse(error);
      if (response) return response;
      throw error;
    }
    if (result.outcome === 'blocked') {
      return Response.json(
        {
          accepted: false,
          repositoryId: result.repositoryId,
          remote: result.remote,
          visibility: result.visibility,
          allowed: false,
          reason: result.reason,
        },
        { status: 403 }
      );
    }
    return Response.json(result);
  });

export default {
  async fetch(request: Request): Promise<Response> {
    const rejected = await rejectInvalidSignature(env, request);
    return rejected ?? (await app.fetch(request));
  },
};
