import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isExistingDirectory } from '../runtime';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe('git runtime paths', () => {
  it('distinguishes an existing directory from a stale persisted path', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'enso-git-runtime-'));
    temporaryDirectories.push(directory);

    expect(isExistingDirectory(directory)).toBe(true);
    expect(isExistingDirectory(join(directory, 'missing'))).toBe(false);
  });
});
