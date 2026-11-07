import { z } from 'zod';
import { getInstallationToken, getSigningKeyMaterial } from './api-auth';
import {
  MirrorNotSeededError,
  fetchRepositoryDefaultBranch,
  loadMirror,
  mirrorKey,
  saveMirror,
  syncMirrorToDefaultBranch,
} from './git-workspace';
import { checkRepositoryAccess } from './repository-access';
import { ensureBucket, objectExists, presignPutUrl } from './storage';

export const commitRequestSchema = z.object({
  organizationId: z.string().min(1),
  signingUserId: z.string().min(1),
  repositoryId: z.number().int(),
  repositoryFullName: z.string().min(1),
  branch: z.string().min(1),
  baseBranch: z.string().min(1).optional(),
  message: z.string().min(1),
  fileChanges: z.array(z.object({ path: z.string().min(1), content: z.string() })).optional(),
  fileDeletions: z.array(z.string().min(1)).optional(),
  gitlinkChanges: z
    .array(z.object({ path: z.string().min(1), oid: z.string().min(7) }))
    .optional(),
  gitlinkRemovals: z.array(z.string().min(1)).optional(),
  gitmodulesAdditions: z
    .array(
      z.object({
        path: z.string().min(1),
        url: z.string().min(1),
        branch: z.string().min(1),
      })
    )
    .optional(),
  gitmodulesRemovals: z.array(z.string().min(1)).optional(),
  expectGitlinkPath: z.string().min(1).optional(),
});

function removeGitmodulesSection(content: string, path: string): string {
  const lines = content.split('\n');
  const kept: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (line.startsWith('[')) skipping = line === `[submodule "${path}"]`;
    if (!skipping) kept.push(line);
  }
  return kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .replace(/\n*$/, '\n');
}

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
  for (const deletion of input.fileDeletions ?? []) {
    await workspace.removeFile(deletion);
  }
  for (const addition of input.gitmodulesAdditions ?? []) {
    const existing = await workspace.readTextFile('.gitmodules');
    if (!existing || !existing.includes(`[submodule "${addition.path}"]`)) {
      const section = `[submodule "${addition.path}"]\n\tpath = ${addition.path}\n\turl = ${addition.url}\n\tbranch = ${addition.branch}\n`;
      await workspace.writeTextFile('.gitmodules', existing ? `${existing.replace(/\n*$/, '\n')}${section}` : section);
    }
  }
  for (const removal of input.gitmodulesRemovals ?? []) {
    const existing = await workspace.readTextFile('.gitmodules');
    if (existing && existing.includes(`[submodule "${removal}"]`)) {
      const updated = removeGitmodulesSection(existing, removal);
      if (updated.trim()) {
        await workspace.writeTextFile('.gitmodules', updated);
      } else {
        await workspace.removeFile('.gitmodules');
      }
    }
  }
  for (const change of input.gitlinkChanges ?? []) {
    workspace.setGitlink(change.path, change.oid);
  }
  for (const removal of input.gitlinkRemovals ?? []) {
    workspace.removeGitlink(removal);
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

export type MirrorUploadUrlOutcome =
  | BlockedOutcome
  | { exists: true; key: string }
  | { exists: false; key: string; uploadUrl: string; expiresAt: string };

export async function runMirrorUploadUrl(
  env: Env,
  repositoryId: number,
  repositoryFullName: string
): Promise<MirrorUploadUrlOutcome> {
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
  const key = mirrorKey(repositoryFullName);
  if (await objectExists(env, key)) return { exists: true, key };
  const { url, expiresAt } = presignPutUrl(env, key, 3600);
  return { exists: false, key, uploadUrl: url, expiresAt };
}

export { MirrorNotSeededError, loadMirror };
