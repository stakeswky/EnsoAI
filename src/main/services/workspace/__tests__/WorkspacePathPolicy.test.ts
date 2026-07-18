import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isExistingOrWorkspacePath, isPathWithinRoots } from '../WorkspacePathPolicy';

describe('WorkspacePathPolicy', () => {
  let root: string | null = null;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = null;
  });

  it('rejects sibling prefixes and traversal outside a workspace root', () => {
    expect(isPathWithinRoots('/workspace/repo/file.ts', ['/workspace/repo'])).toBe(true);
    expect(isPathWithinRoots('/workspace/repo-evil/file.ts', ['/workspace/repo'])).toBe(false);
    expect(isPathWithinRoots('/workspace/repo/../secret', ['/workspace/repo'])).toBe(false);
  });

  it('rejects an existing symlink that escapes the workspace root', async () => {
    root = await mkdtemp(join(tmpdir(), 'enso-workspace-path-'));
    const workspace = join(root, 'repo');
    const outside = join(root, 'outside');
    await mkdir(workspace);
    await mkdir(outside);
    const secret = join(outside, 'secret.txt');
    await writeFile(secret, 'secret');
    const link = join(workspace, 'link.txt');
    await symlink(secret, link);

    await expect(isExistingOrWorkspacePath(link, [workspace])).resolves.toBe(false);
    await expect(
      isExistingOrWorkspacePath(join(workspace, 'missing.txt'), [workspace])
    ).resolves.toBe(true);
  });

  it('rejects a missing child beneath a symlink that escapes the workspace root', async () => {
    root = await mkdtemp(join(tmpdir(), 'enso-workspace-path-'));
    const workspace = join(root, 'repo');
    const outside = join(root, 'outside');
    await mkdir(workspace);
    await mkdir(outside);
    const link = join(workspace, 'external');
    await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir');

    await expect(
      isExistingOrWorkspacePath(join(link, 'missing', 'new-file.txt'), [workspace])
    ).resolves.toBe(false);
    await expect(
      isExistingOrWorkspacePath(join(workspace, 'missing', 'new-file.txt'), [workspace])
    ).resolves.toBe(true);
  });
});
