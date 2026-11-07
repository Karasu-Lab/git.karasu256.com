import { z } from 'zod';
import { getInstallationToken, getSigningKeyMaterial } from './api-auth';
import {
  fetchRepositoryDefaultBranch,
  loadMirror,
  saveMirror,
  syncMirrorToDefaultBranch,
} from './git-workspace';
import { checkRepositoryAccess } from './repository-access';
import { ensureBucket } from './storage';

export const commitRequestSchema = z.object({
  organizationId: z.string().min(1),
  signingUserId: z.string().min(1),
  repositoryId: z.number().int(),
  repositoryFullName: z.string().min(1),
  branch: z.string().min(1),
  baseBranch: z.string().min(1).optional(),
  message: z.string().min(1),
  fileChanges: z.array(z.object({ path: z.string().min(1), content: z.string() })).optional(),
  gitlinkChanges: z
    .array(z.object({ path: z.string().min(1), oid: z.string().min(7) }))
    .optional(),
  gitmodulesAdditions: z
    .array(
      z.object({
        path: z.string().min(1),
        url: z.string().min(1),
        branch: z.string().min(1),
      })
    )
    .optional(),
  expectGitlinkPath: z.string().min(1).optional(),
});

export type CommitRequest = z.infer<typeof commitRequestSchema>;

export interface BlockedOutcome {
  outcome: 'blocked';
  repositoryId: number;
  remote: string | null;
  visibility: 'public' | 'private' | null;
  allowed: false;
  reason?: string;
}

export type CommitOutcome =
  | { outcome: 'pushed'; commitOid: string; branch: string }
  | { outcome: 'no_changes'; branch: string }
  | { outcome: 'already_synced'; branch: string }
  | { outcome: 'submodule_not_found'; branch: string }
  | BlockedOutcome;

export async function runSignedCommit(env: Env, input: CommitRequest): Promise<CommitOutcome> {
  const access = await checkRepositoryAccess(env, input.repositoryId);
  if (!access.allowed) {
    return {
      outcome: 'blocked',
      repositoryId: access.repositoryId,
      remote: access.remote,
      visibility: access.visibility,
      allowed: false,
      reason: access.reason,
    };
  }
  await ensureBucket(env);
  const token = await getInstallationToken(env, input.organizationId);
  const material = await getSigningKeyMaterial(env, input.signingUserId);
  const defaultBranch = input.baseBranch ?? (await fetchRepositoryDefaultBranch(input.repositoryFullName, token));
  const { workspace } = await syncMirrorToDefaultBranch(env, input.repositoryFullName, token, defaultBranch);

  if (input.expectGitlinkPath) {
    const current = await workspace.gitlinkOid(input.expectGitlinkPath);
    const wanted = input.gitlinkChanges?.find((change) => change.path === input.expectGitlinkPath)?.oid;
    if (!current) return { outcome: 'submodule_not_found', branch: input.branch };
    if (wanted && current === wanted) return { outcome: 'already_synced', branch: input.branch };
  }

  await workspace.createBranch(input.branch);
  for (const change of input.fileChanges ?? []) {
    await workspace.writeTextFile(change.path, change.content);
  }
  for (const addition of input.gitmodulesAdditions ?? []) {
    const existing = await workspace.readTextFile('.gitmodules');
    if (!existing || !existing.includes(`[submodule "${addition.path}"]`)) {
      const section = `[submodule "${addition.path}"]\n\tpath = ${addition.path}\n\turl = ${addition.url}\n\tbranch = ${addition.branch}\n`;
      await workspace.writeTextFile('.gitmodules', existing ? `${existing.replace(/\n*$/, '\n')}${section}` : section);
    }
  }
  for (const change of input.gitlinkChanges ?? []) {
    workspace.setGitlink(change.path, change.oid);
  }
  const committed = await workspace.commitSigned(
    input.message,
    { name: material.committerName, email: material.committerEmail },
    material.privateKey
  );
  if (!committed) return { outcome: 'no_changes', branch: input.branch };
  await workspace.pushBranch(input.branch, token);
  await saveMirror(env, input.repositoryFullName, workspace);
  return { outcome: 'pushed', commitOid: committed, branch: input.branch };
}

export async function runMirrorSync(
  env: Env,
  organizationId: string,
  repositoryId: number,
  repositoryFullName: string
): Promise<{ repositoryFullName: string; headOid: string; defaultBranch: string } | BlockedOutcome> {
  const access = await checkRepositoryAccess(env, repositoryId);
  if (!access.allowed) {
    return {
      outcome: 'blocked',
      repositoryId: access.repositoryId,
      remote: access.remote,
      visibility: access.visibility,
      allowed: false,
      reason: access.reason,
    };
  }
  await ensureBucket(env);
  const token = await getInstallationToken(env, organizationId);
  const defaultBranch = await fetchRepositoryDefaultBranch(repositoryFullName, token);
  const { headOid } = await syncMirrorToDefaultBranch(env, repositoryFullName, token, defaultBranch);
  return { repositoryFullName, headOid, defaultBranch };
}

export { loadMirror };
