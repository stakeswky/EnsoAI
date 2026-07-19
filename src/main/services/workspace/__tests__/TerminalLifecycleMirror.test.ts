import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TerminalSessionLifecycleEvent } from '../../terminal/TerminalSessionRegistry';

const terminalLifecycleHarness = vi.hoisted(() => {
  const listeners = new Set<(event: TerminalSessionLifecycleEvent) => void>();
  const metadata = new Map<string, { id: string; title: string; cwd: string | null }>();
  return {
    listeners,
    metadata,
    emit(event: TerminalSessionLifecycleEvent) {
      for (const listener of listeners) listener(event);
    },
  };
});

vi.mock('electron', () => ({
  app: { getPath: () => '' },
}));

vi.mock('../../terminal/terminalRuntime', () => ({
  terminalSessionRegistry: {
    getMetadata(sessionId: string) {
      return terminalLifecycleHarness.metadata.get(sessionId);
    },
    subscribeLifecycle(listener: (event: TerminalSessionLifecycleEvent) => void) {
      terminalLifecycleHarness.listeners.add(listener);
      return () => terminalLifecycleHarness.listeners.delete(listener);
    },
  },
}));

describe('workspace mirror terminal lifecycle projection', () => {
  let temporaryDirectory: string | null = null;

  afterEach(async () => {
    const runtime = await import('../workspaceMirrorRuntime');
    await runtime.cleanupWorkspaceMirrorRuntime();
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = null;
    terminalLifecycleHarness.listeners.clear();
    terminalLifecycleHarness.metadata.clear();
  });

  it('commits process exit and explicit destroy without a renderer', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'enso-terminal-lifecycle-'));
    const runtime = await import('../workspaceMirrorRuntime');
    const service = await runtime.initializeWorkspaceMirrorRuntime(temporaryDirectory);
    await service.dispatchHostMutation({
      kind: 'terminals.replace',
      payload: {
        terminals: {
          sessions: {
            'terminal-headless': {
              id: 'terminal-headless',
              generation: 1,
              repositoryId: null,
              worktreeId: null,
              title: 'Headless terminal',
              cwd: '/tmp',
              groupId: null,
              order: 0,
              processState: 'running',
              exitCode: null,
            },
          },
          groups: {},
          activeSessionByWorktree: {},
          quickSessionByWorktree: {},
        },
      },
    });

    terminalLifecycleHarness.emit({
      sessionId: 'terminal-headless',
      processState: 'exited',
      exitCode: 7,
    });
    await vi.waitFor(() => {
      expect(service.getSnapshot().terminals.sessions['terminal-headless']).toMatchObject({
        processState: 'exited',
        exitCode: 7,
      });
    });

    terminalLifecycleHarness.emit({
      sessionId: 'terminal-headless',
      processState: 'terminated',
      exitCode: null,
    });
    await vi.waitFor(() => {
      expect(service.getSnapshot().terminals.sessions['terminal-headless']).toMatchObject({
        processState: 'terminated',
        exitCode: null,
      });
    });

    terminalLifecycleHarness.metadata.set('terminal-fast-exit', {
      id: 'terminal-fast-exit',
      title: 'Fast exit',
      cwd: '/headless',
    });
    terminalLifecycleHarness.emit({
      sessionId: 'terminal-fast-exit',
      processState: 'exited',
      exitCode: 9,
    });
    await vi.waitFor(() => {
      expect(service.getSnapshot().terminals.sessions['terminal-fast-exit']).toMatchObject({
        title: 'Fast exit',
        cwd: '/headless',
        processState: 'exited',
        exitCode: 9,
      });
    });
    expect(service.getSnapshot().revision).toBe(4);
  });
});
