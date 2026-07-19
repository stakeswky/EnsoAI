import { realpath } from 'node:fs/promises';
import * as os from 'node:os';
import { dirname, join, posix, relative, resolve, win32 } from 'node:path';
import type { WorkspaceSceneSnapshot } from '@shared/types';

function isMissingPathError(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** Resolve symlinks in the existing prefix while preserving a missing suffix. */
async function resolveFromNearestExistingAncestor(value: string): Promise<string | null> {
  const absolute = resolve(value);
  let ancestor = absolute;

  while (true) {
    try {
      const realAncestor = await realpath(ancestor);
      return resolve(realAncestor, relative(ancestor, absolute));
    } catch (error) {
      if (!isMissingPathError(error)) return null;
      const parent = dirname(ancestor);
      if (parent === ancestor) return null;
      ancestor = parent;
    }
  }
}

export type WorkspacePathFlavor = 'posix' | 'win32';

function hostPathFlavor(): WorkspacePathFlavor {
  return process.platform === 'win32' ? 'win32' : 'posix';
}

function normalizeForComparison(value: string, flavor: WorkspacePathFlavor): string {
  const pathApi = flavor === 'win32' ? win32 : posix;
  const normalized = pathApi.normalize(pathApi.resolve(value));
  const root = pathApi.parse(normalized).root;
  let end = normalized.length;
  while (end > root.length && (normalized[end - 1] === '/' || normalized[end - 1] === '\\')) {
    end -= 1;
  }
  return normalized.slice(0, end);
}

export function remoteRepositoryBasePath(): string {
  return join(os.homedir(), 'ensoai', 'repos');
}

export function remoteWorktreeBasePath(): string {
  return join(os.homedir(), 'ensoai', 'workspaces');
}

/** Return only host-owned repository/worktree roots from the canonical scene. */
export function workspaceRootPaths(snapshot: WorkspaceSceneSnapshot): string[] {
  const roots = new Set<string>();
  for (const repository of Object.values(snapshot.catalog.repositories)) {
    roots.add(repository.path);
  }
  for (const worktree of Object.values(snapshot.catalog.worktrees)) {
    roots.add(worktree.path);
  }
  return [...roots];
}

/** Lexically check a path without treating a sibling such as `/repo-evil` as a child. */
export function isPathWithinRoots(
  candidate: string,
  roots: readonly string[],
  flavor: WorkspacePathFlavor = hostPathFlavor()
): boolean {
  const pathApi = flavor === 'win32' ? win32 : posix;
  if (!pathApi.isAbsolute(candidate)) return false;
  const normalizedCandidate = normalizeForComparison(candidate, flavor);
  return roots.some((root) => {
    if (!pathApi.isAbsolute(root)) return false;
    const normalizedRoot = normalizeForComparison(root, flavor);
    if (normalizedCandidate === normalizedRoot) return true;
    const rootPrefix = normalizedRoot.endsWith(pathApi.sep)
      ? normalizedRoot
      : `${normalizedRoot}${pathApi.sep}`;
    return normalizedCandidate.startsWith(rootPrefix);
  });
}

/**
 * Check both the lexical path and its effective real target. For a missing
 * path, resolve the nearest existing ancestor and append the missing suffix so
 * a symlinked parent cannot turn a permitted create path into an escape.
 */
export async function isExistingOrWorkspacePath(
  candidate: string,
  roots: readonly string[]
): Promise<boolean> {
  if (!isPathWithinRoots(candidate, roots)) return false;
  const [effectiveCandidate, effectiveRoots] = await Promise.all([
    resolveFromNearestExistingAncestor(candidate),
    Promise.all(roots.map(resolveFromNearestExistingAncestor)),
  ]);
  if (!effectiveCandidate) return false;
  return isPathWithinRoots(
    effectiveCandidate,
    effectiveRoots.filter((root): root is string => root !== null)
  );
}

export function resolveWorkspaceChild(root: string, child: string): string | null {
  const candidate = resolve(root, child);
  return isPathWithinRoots(candidate, [root]) ? candidate : null;
}
