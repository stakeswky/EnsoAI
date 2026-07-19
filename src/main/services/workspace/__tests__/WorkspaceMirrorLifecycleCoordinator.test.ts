import {
  createEmptyWorkspaceSceneSnapshot,
  WORKSPACE_MIRROR_SCHEMA_VERSION,
  type WorkspaceSceneSnapshot,
} from '@shared/types';
import { describe, expect, it, vi } from 'vitest';
import {
  buildVolatileHandoff,
  WorkspaceMirrorLifecycleCoordinator,
} from '../WorkspaceMirrorLifecycleCoordinator';

const HOST_EPOCH = '11111111-1111-4111-8111-111111111111';

function baseScene(overrides: Partial<WorkspaceSceneSnapshot> = {}): WorkspaceSceneSnapshot {
  const empty = createEmptyWorkspaceSceneSnapshot({
    hostId: 'host',
    sceneId: 'scene',
    hostEpoch: HOST_EPOCH,
  });
  return {
    ...empty,
    schemaVersion: WORKSPACE_MIRROR_SCHEMA_VERSION,
    revision: 3,
    ...overrides,
  };
}

describe('WorkspaceMirrorLifecycleCoordinator', () => {
  it('transitions enabled -> quiescing -> disabled on clean disable', async () => {
    const freeze = vi.fn();
    const unfreeze = vi.fn();
    const detach = vi.fn(async () => undefined);
    const persist = vi.fn(async () => undefined);
    const destroy = vi.fn(async () => undefined);
    const notify = vi.fn();
    const coordinator = new WorkspaceMirrorLifecycleCoordinator({
      getSnapshot: () => baseScene(),
      freezeMutations: freeze,
      unfreezeMutations: unfreeze,
      drainOperations: async () => 'drained',
      requestHostHandoff: async () => 'acked',
      detachTransport: detach,
      destroyRuntimes: destroy,
      persistDisabled: persist,
      notifyClients: notify,
      releaseControllerLease: async () => undefined,
    });

    const result = await coordinator.transitionToDisabled('disable');
    expect(result).toMatchObject({ ok: true, phase: 'disabled', reason: 'disable' });
    expect(coordinator.getPhase()).toBe('disabled');
    expect(freeze).toHaveBeenCalled();
    expect(detach).toHaveBeenCalled();
    expect(persist).toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith('quiescing', 'disable');
    expect(notify).toHaveBeenCalledWith('disabled', 'disable');
  });

  it('blocks when volatile handoff cannot be ACKed and no export/discard', async () => {
    const empty = baseScene();
    const unfreeze = vi.fn();
    const coordinator = new WorkspaceMirrorLifecycleCoordinator({
      getSnapshot: () => ({
        ...empty,
        editors: {
          wt1: {
            tabs: [],
            activeFile: '/f.ts',
            buffers: {
              '/f.ts': {
                path: '/f.ts',
                version: 2,
                isDirty: true,
                content: 'unsaved',
                hasExternalChange: false,
              },
            },
          },
        },
      }),
      freezeMutations: () => undefined,
      unfreezeMutations: unfreeze,
      drainOperations: async () => 'drained',
      requestHostHandoff: async () => 'no-renderer',
      detachTransport: async () => undefined,
      destroyRuntimes: async () => undefined,
      persistDisabled: async () => undefined,
      notifyClients: () => undefined,
      releaseControllerLease: async () => undefined,
    });

    const result = await coordinator.transitionToDisabled('host-stop');
    expect(result.ok).toBe(false);
    expect(result.blockedBy).toBe('handoff-requires-export-or-discard');
    expect(result.phase).toBe('enabled');
    expect(coordinator.getPhase()).toBe('enabled');
    expect(unfreeze).toHaveBeenCalled();
  });

  it('allows explicit discard of volatile data', async () => {
    const empty = baseScene();
    const coordinator = new WorkspaceMirrorLifecycleCoordinator({
      getSnapshot: () => ({
        ...empty,
        agents: {
          ...empty.agents,
          sessions: {
            a1: {
              id: 'a1',
              providerSessionId: null,
              generation: 1,
              agentId: 'claude',
              name: 'Claude',
              repositoryId: 'r1',
              worktreeId: 'w1',
              terminalSessionId: 't1',
              environment: 'native',
              initialized: true,
              activated: true,
              displayOrder: 0,
              runtimeState: 'idle',
              status: 'idle',
              waitingReason: null,
              draft: { text: 'hello', resources: [] },
              task: null,
            },
          },
          activeSessionByWorktree: { w1: 'a1' },
        },
      }),
      freezeMutations: () => undefined,
      unfreezeMutations: () => undefined,
      drainOperations: async () => 'drained',
      requestHostHandoff: async () => 'no-renderer',
      detachTransport: async () => undefined,
      destroyRuntimes: async () => undefined,
      persistDisabled: async () => undefined,
      notifyClients: () => undefined,
      releaseControllerLease: async () => undefined,
    });

    coordinator.acknowledgeDiscard();
    const result = await coordinator.transitionToDisabled('disable');
    expect(result.ok).toBe(true);
    expect(result.phase).toBe('disabled');
  });

  it('destroys runtimes only on graceful quit after handoff', async () => {
    const destroy = vi.fn(async () => undefined);
    const coordinator = new WorkspaceMirrorLifecycleCoordinator({
      getSnapshot: () => baseScene(),
      freezeMutations: () => undefined,
      unfreezeMutations: () => undefined,
      drainOperations: async () => 'drained',
      requestHostHandoff: async () => 'acked',
      detachTransport: async () => undefined,
      destroyRuntimes: destroy,
      persistDisabled: async () => undefined,
      notifyClients: () => undefined,
      releaseControllerLease: async () => undefined,
    });
    await coordinator.transitionToDisabled('graceful-quit');
    expect(destroy).toHaveBeenCalled();
  });

  it('rolls back to enabled on drain timeout', async () => {
    const coordinator = new WorkspaceMirrorLifecycleCoordinator({
      getSnapshot: () => baseScene(),
      freezeMutations: () => undefined,
      unfreezeMutations: () => undefined,
      drainOperations: async () => 'timeout',
      requestHostHandoff: async () => 'acked',
      detachTransport: async () => undefined,
      destroyRuntimes: async () => undefined,
      persistDisabled: async () => undefined,
      notifyClients: () => undefined,
      releaseControllerLease: async () => undefined,
      disableDeadlineMs: 10,
    });
    const result = await coordinator.transitionToDisabled('disable');
    expect(result).toMatchObject({
      ok: false,
      phase: 'enabled',
      blockedBy: 'drain-timeout',
      timedOut: true,
    });
  });

  it('buildVolatileHandoff captures dirty versions and draft hashes without content', () => {
    const empty = baseScene();
    const handoff = buildVolatileHandoff({
      ...empty,
      editors: {
        wt: {
          tabs: [],
          activeFile: '/a.ts',
          buffers: {
            '/a.ts': {
              path: '/a.ts',
              version: 7,
              isDirty: true,
              content: 'SECRET_BUFFER',
              hasExternalChange: false,
            },
          },
        },
      },
      agents: {
        ...empty.agents,
        sessions: {
          s1: {
            id: 's1',
            providerSessionId: null,
            generation: 1,
            agentId: 'codex',
            name: 'Codex',
            repositoryId: 'r',
            worktreeId: 'wt',
            terminalSessionId: null,
            environment: 'native',
            initialized: true,
            activated: true,
            displayOrder: 0,
            runtimeState: 'idle',
            status: 'idle',
            waitingReason: null,
            draft: { text: 'SECRET_DRAFT', resources: [] },
            task: null,
          },
        },
        activeSessionByWorktree: { wt: 's1' },
      },
    });
    expect(handoff.targetRevision).toBe(3);
    expect(handoff.dirtyBufferVersions).toEqual([{ worktreeId: 'wt', path: '/a.ts', version: 7 }]);
    expect(handoff.agentDraftHashes[0]?.draftHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(handoff)).not.toContain('SECRET_BUFFER');
    expect(JSON.stringify(handoff)).not.toContain('SECRET_DRAFT');
  });

  it('records forced-exit recovery warning', () => {
    const coordinator = new WorkspaceMirrorLifecycleCoordinator({
      getSnapshot: () => baseScene(),
      freezeMutations: () => undefined,
      unfreezeMutations: () => undefined,
      drainOperations: async () => 'drained',
      requestHostHandoff: async () => 'acked',
      detachTransport: async () => undefined,
      destroyRuntimes: async () => undefined,
      persistDisabled: async () => undefined,
      notifyClients: () => undefined,
      releaseControllerLease: async () => undefined,
      now: () => 1234,
    });
    coordinator.markForcedExitIncomplete();
    expect(coordinator.getForcedExitRecoveryWarning()).toEqual({
      at: 1234,
      reason: 'forced-exit-recovery',
    });
  });
});
