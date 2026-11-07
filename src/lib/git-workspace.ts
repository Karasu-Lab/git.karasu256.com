import git from 'isomorphic-git';
import http from 'isomorphic-git/http/web';
import { Volume, createFsFromVolume } from 'memfs';
import type { IFs } from 'memfs';
import { getObject, putObject } from './storage';
import { signGitPayload } from './ssh-signature';

export interface SigningIdentity {
  name: string;
  email: string;
}

interface FlatTreeEntry {
  mode: string;
  type: 'blob' | 'commit';
  oid: string;
}

const WORKDIR = '/repo';

function joinPath(base: string, rel: string): string {
  return rel ? `${base}/${rel}` : base;
}

export class RepositoryWorkspace {
  private fs: IFs;
  private dir: string;
  private gitlinkOverrides = new Map<string, string>();
  private gitlinkRemovals = new Set<string>();

  constructor(fs: IFs) {
    this.fs = fs;
    this.dir = WORKDIR;
  }

  getFs(): IFs {
    return this.fs;
  }

  getDir(): string {
    return this.dir;
  }

  async readTextFile(relPath: string): Promise<string | null> {
    try {
      const content = await this.fs.promises.readFile(joinPath(this.dir, relPath), 'utf8');
      return content as string;
    } catch {
      return null;
    }
  }

  async writeTextFile(relPath: string, content: string): Promise<void> {
    const fullPath = joinPath(this.dir, relPath);
    const parent = fullPath.slice(0, fullPath.lastIndexOf('/'));
    await this.fs.promises.mkdir(parent, { recursive: true });
    await this.fs.promises.writeFile(fullPath, content, { encoding: 'utf8' });
  }

  async fileExists(relPath: string): Promise<boolean> {
    try {
      const stat = await this.fs.promises.stat(joinPath(this.dir, relPath));
      return stat.isFile();
    } catch {
      return false;
    }
  }

  async createBranch(branch: string): Promise<void> {
    await git.branch({ fs: this.fs, dir: this.dir, ref: branch, checkout: true });
  }

  async headOid(): Promise<string | null> {
    try {
      return await git.resolveRef({ fs: this.fs, dir: this.dir, ref: 'HEAD' });
    } catch {
      return null;
    }
  }

  private async headEntries(): Promise<Map<string, FlatTreeEntry>> {
    const entries = new Map<string, FlatTreeEntry>();
    const head = await this.headOid();
    if (!head) return entries;
    await git.walk({
      fs: this.fs,
      dir: this.dir,
      trees: [git.TREE({ ref: 'HEAD' })],
      map: async (filepath, [entry]) => {
        if (!entry || filepath === '.') return undefined;
        const type = await entry.type();
        if (type !== 'blob' && type !== 'commit') return undefined;
        const oid = await entry.oid();
        const mode = await entry.mode();
        if (!oid || !mode) return undefined;
        entries.set(filepath, { mode: mode.toString(8).padStart(6, '0'), type, oid });
        return undefined;
      },
    });
    return entries;
  }

  async gitlinkOid(relPath: string): Promise<string | null> {
    const override = this.gitlinkOverrides.get(relPath);
    if (override) return override;
    const entries = await this.headEntries();
    const entry = entries.get(relPath);
    return entry?.type === 'commit' ? entry.oid : null;
  }

  setGitlink(relPath: string, oid: string): void {
    this.gitlinkOverrides.set(relPath, oid);
  }

  removeGitlink(relPath: string): void {
    this.gitlinkRemovals.add(relPath);
  }

  async removeTextFile(relPath: string): Promise<void> {
    try {
      await this.fs.promises.unlink(joinPath(this.dir, relPath));
    } catch {}
  }

  private async listWorkdirFiles(): Promise<string[]> {
    const files: string[] = [];
    const walkDir = async (absPath: string, relPrefix: string): Promise<void> => {
      const names = (await this.fs.promises.readdir(absPath)) as string[];
      for (const name of names) {
        if (relPrefix === '' && name === '.git') continue;
        const abs = joinPath(absPath, name);
        const rel = relPrefix ? `${relPrefix}/${name}` : name;
        const stat = await this.fs.promises.stat(abs);
        if (stat.isDirectory()) {
          await walkDir(abs, rel);
        } else if (stat.isFile()) {
          files.push(rel);
        }
      }
    };
    await walkDir(this.dir, '');
    return files;
  }

  private async buildTreeLevel(entries: Map<string, FlatTreeEntry>, prefix: string): Promise<string> {
    const leaves = new Map<string, FlatTreeEntry>();
    const subdirs = new Set<string>();
    for (const [path, entry] of entries) {
      if (prefix && !path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        leaves.set(rest, entry);
      } else {
        subdirs.add(rest.slice(0, slash));
      }
    }
    const treeEntries: { path: string; mode: string; type: 'blob' | 'tree' | 'commit'; oid: string }[] = [];
    for (const [name, entry] of leaves) {
      treeEntries.push({ path: name, mode: entry.mode, type: entry.type, oid: entry.oid });
    }
    for (const name of subdirs) {
      const oid = await this.buildTreeLevel(entries, `${prefix}${name}/`);
      treeEntries.push({ path: name, mode: '040000', type: 'tree', oid });
    }
    treeEntries.sort((a, b) => {
      const aKey = a.type === 'tree' ? `${a.path}/` : a.path;
      const bKey = b.type === 'tree' ? `${b.path}/` : b.path;
      return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
    });
    return git.writeTree({ fs: this.fs, dir: this.dir, tree: treeEntries });
  }

  private async buildTree(): Promise<string> {
    const entries = await this.headEntries();
    const files = await this.listWorkdirFiles();
    const present = new Set(files);
    for (const [path, entry] of entries) {
      if (entry.type === 'blob' && !present.has(path)) entries.delete(path);
    }
    const gitlinkPaths = new Set<string>([
      ...[...entries].filter(([, entry]) => entry.type === 'commit').map(([path]) => path),
      ...this.gitlinkOverrides.keys(),
    ]);
    for (const relPath of files) {
      if ([...gitlinkPaths].some((linkPath) => relPath === linkPath || relPath.startsWith(`${linkPath}/`))) continue;
      const content = await this.fs.promises.readFile(joinPath(this.dir, relPath));
      const oid = await git.writeBlob({
        fs: this.fs,
        dir: this.dir,
        blob: new Uint8Array(content as Buffer),
      });
      const previous = entries.get(relPath);
      entries.set(relPath, { mode: previous?.type === 'blob' ? previous.mode : '100644', type: 'blob', oid });
    }
    for (const [relPath, oid] of this.gitlinkOverrides) {
      entries.set(relPath, { mode: '160000', type: 'commit', oid });
    }
    for (const relPath of this.gitlinkRemovals) {
      entries.delete(relPath);
    }
    return this.buildTreeLevel(entries, '');
  }

  async commitSigned(message: string, identity: SigningIdentity, privateKey: string): Promise<string | null> {
    const head = await this.headOid();
    const tree = await this.buildTree();
    if (head) {
      const { commit } = await git.readCommit({ fs: this.fs, dir: this.dir, oid: head });
      if (commit.tree === tree) return null;
    }
    const now = Math.floor(Date.now() / 1000);
    const author = {
      name: identity.name,
      email: identity.email,
      timestamp: now,
      timezoneOffset: new Date().getTimezoneOffset(),
    };
    return git.commit({
      fs: this.fs,
      dir: this.dir,
      message,
      author,
      committer: author,
      tree,
      parent: head ? [head] : [],
      signingKey: privateKey,
      onSign: ({ payload, secretKey }) => ({ signature: signGitPayload(payload, secretKey) }),
    });
  }

  async pushBranch(branch: string, token: string): Promise<void> {
    await git.push({
      fs: this.fs,
      http,
      dir: this.dir,
      remote: 'origin',
      ref: branch,
      onAuth: () => ({ username: 'x-access-token', password: token }),
    });
  }

  async fetchFromOrigin(token: string): Promise<void> {
    await git.fetch({
      fs: this.fs,
      http,
      dir: this.dir,
      remote: 'origin',
      onAuth: () => ({ username: 'x-access-token', password: token }),
    });
  }

  async checkoutRef(ref: string): Promise<void> {
    await git.checkout({ fs: this.fs, dir: this.dir, ref, force: true });
  }

  async remoteHeadOid(branch: string): Promise<string | null> {
    try {
      return await git.resolveRef({ fs: this.fs, dir: this.dir, ref: `refs/remotes/origin/${branch}` });
    } catch {
      return null;
    }
  }

  async writeBranchRef(branch: string, oid: string): Promise<void> {
    await git.writeRef({ fs: this.fs, dir: this.dir, ref: `refs/heads/${branch}`, value: oid, force: true });
  }
}

export function mirrorKey(repositoryFullName: string): string {
  return `mirrors/${repositoryFullName}.json`;
}

export class MirrorNotSeededError extends Error {
  readonly repositoryFullName: string;

  constructor(repositoryFullName: string) {
    super(`The mirror of ${repositoryFullName} has not been seeded yet`);
    this.name = 'MirrorNotSeededError';
    this.repositoryFullName = repositoryFullName;
  }
}

interface MirrorArchive {
  files: Record<string, string>;
}

async function serializeGitDirectory(fs: IFs): Promise<Uint8Array> {
  const gitDir = `${WORKDIR}/.git`;
  const files: Record<string, string> = {};
  const walkDir = async (absPath: string, relPrefix: string): Promise<void> => {
    const names = (await fs.promises.readdir(absPath)) as string[];
    for (const name of names) {
      const abs = joinPath(absPath, name);
      const rel = relPrefix ? `${relPrefix}/${name}` : name;
      const stat = await fs.promises.stat(abs);
      if (stat.isDirectory()) {
        await walkDir(abs, rel);
      } else if (stat.isFile()) {
        const content = await fs.promises.readFile(abs);
        files[rel] = Buffer.from(content as Buffer).toString('base64');
      }
    }
  };
  await walkDir(gitDir, '');
  const archive: MirrorArchive = { files };
  return new TextEncoder().encode(JSON.stringify(archive));
}

async function restoreGitDirectory(fs: IFs, archiveBytes: Uint8Array): Promise<void> {
  const archive = JSON.parse(new TextDecoder().decode(archiveBytes)) as MirrorArchive;
  const gitDir = `${WORKDIR}/.git`;
  for (const [rel, base64] of Object.entries(archive.files)) {
    const fullPath = joinPath(gitDir, rel);
    const parent = fullPath.slice(0, fullPath.lastIndexOf('/'));
    await fs.promises.mkdir(parent, { recursive: true });
    await fs.promises.writeFile(fullPath, Buffer.from(base64, 'base64'));
  }
}

export interface LoadedMirror {
  workspace: RepositoryWorkspace;
  existed: boolean;
}

export async function loadMirror(env: Env, repositoryFullName: string, token: string): Promise<LoadedMirror> {
  const fs = createFsFromVolume(new Volume());
  const stored = await getObject(env, mirrorKey(repositoryFullName));
  if (!stored) throw new MirrorNotSeededError(repositoryFullName);
  await restoreGitDirectory(fs, stored);
  const workspace = new RepositoryWorkspace(fs);
  await workspace.fetchFromOrigin(token);
  return { workspace, existed: true };
}

export async function saveMirror(env: Env, repositoryFullName: string, workspace: RepositoryWorkspace): Promise<void> {
  const archive = await serializeGitDirectory(workspace.getFs());
  await putObject(env, mirrorKey(repositoryFullName), archive, 'application/json');
}

export async function syncMirrorToDefaultBranch(
  env: Env,
  repositoryFullName: string,
  token: string,
  defaultBranch: string
): Promise<{ workspace: RepositoryWorkspace; headOid: string }> {
  const { workspace } = await loadMirror(env, repositoryFullName, token);
  const remoteHead = await workspace.remoteHeadOid(defaultBranch);
  if (remoteHead) {
    await workspace.writeBranchRef(defaultBranch, remoteHead);
    await workspace.checkoutRef(defaultBranch);
  }
  const headOid = await workspace.headOid();
  if (!headOid) throw new Error(`The mirror of ${repositoryFullName} has no HEAD commit`);
  await saveMirror(env, repositoryFullName, workspace);
  return { workspace, headOid };
}

export async function fetchRepositoryHeadOid(
  repositoryFullName: string,
  token: string,
  branch: string
): Promise<string> {
  const info = await git.getRemoteInfo({
    http,
    url: `https://github.com/${repositoryFullName}.git`,
    onAuth: () => ({ username: 'x-access-token', password: token }),
  });
  const ref = info.heads?.[branch];
  if (!ref || typeof ref !== 'string') {
    throw new Error(`The branch ${branch} of ${repositoryFullName} could not be resolved`);
  }
  return ref;
}

export async function fetchRepositoryDefaultBranch(repositoryFullName: string, token: string): Promise<string> {
  const response = await fetch(`https://api.github.com/repos/${repositoryFullName}`, {
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'user-agent': 'karasu-lab-git',
      'x-github-api-version': '2022-11-28',
    },
    cache: 'no-store',
  });
  if (!response.ok) {
    throw new Error(`Reading ${repositoryFullName} from GitHub failed (${response.status})`);
  }
  const data = (await response.json()) as { default_branch?: unknown };
  if (typeof data.default_branch !== 'string' || !data.default_branch) {
    throw new Error(`The default branch of ${repositoryFullName} could not be resolved`);
  }
  return data.default_branch;
}
