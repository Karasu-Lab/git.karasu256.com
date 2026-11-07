export type RepositoryVisibility = 'public' | 'private';

export interface RepositoryAccess {
  repositoryId: number;
  remote: string | null;
  visibility: RepositoryVisibility | null;
  allowed: boolean;
  reason?: string;
}

interface RepositoryRow {
  repository_id: number;
  remote: string;
  is_private: number;
}

export async function checkRepositoryAccess(env: Env, repositoryId: number): Promise<RepositoryAccess> {
  let row: RepositoryRow | null;
  try {
    row = await env.ADMIN_DB.prepare(
      'SELECT repository_id, remote, is_private FROM repositories WHERE repository_id = ?'
    )
      .bind(repositoryId)
      .first<RepositoryRow>();
  } catch (error) {
    throw new Error(
      `Reading the repositories table from the admin D1 database failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  if (!row) {
    return { repositoryId, remote: null, visibility: null, allowed: false, reason: 'repository_not_registered' };
  }
  if (row.is_private) {
    return { repositoryId, remote: row.remote, visibility: 'private', allowed: false, reason: 'repository_private' };
  }
  return { repositoryId, remote: row.remote, visibility: 'public', allowed: true };
}
