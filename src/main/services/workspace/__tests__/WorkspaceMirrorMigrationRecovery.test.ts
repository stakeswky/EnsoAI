import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const migrationState = vi.hoisted(() => ({ markerValid: false }));

vi.mock('electron', () => ({
  app: { getPath: () => '' },
}));

vi.mock('../../todo/TodoService', () => ({
  hasValidWorkspaceMigrationMarker: vi.fn(async () => migrationState.markerValid),
  finalizeWorkspaceMigration: vi.fn(async () => undefined),
}));

vi.mock('../../terminal/terminalRuntime', () => ({
  terminalSessionRegistry: {
    getMetadata: () => undefined,
    subscribeLifecycle: () => () => undefined,
  },
}));

describe('workspace mirror migration recovery', () => {
  let directory: string | null = null;

  afterEach(async () => {
    const runtime = await import('../workspaceMirrorRuntime');
    await runtime.cleanupWorkspaceMirrorRuntime();
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = null;
    migrationState.markerValid = false;
  });

  it('recovers the canonical marker after an external Todo marker was written first', async () => {
    directory = await mkdtemp(join(tmpdir(), 'enso-mirror-migration-recovery-'));
    const runtime = await import('../workspaceMirrorRuntime');
    const first = await runtime.initializeWorkspaceMirrorRuntime(directory);
    await first.dispatchHostMutation({
      kind: 'resources.invalidate',
      payload: {
        resourceKey: 'migration-test',
        domain: 'file-tree',
        entityId: null,
        generation: 1,
        reason: 'changed',
      },
    });
    await runtime.cleanupWorkspaceMirrorRuntime();

    migrationState.markerValid = true;
    const restarted = await runtime.initializeWorkspaceMirrorRuntime(directory);
    expect(restarted.isBootstrapReady()).toBe(true);
  });
});
