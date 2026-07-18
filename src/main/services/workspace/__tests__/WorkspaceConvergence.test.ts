import {
  createEmptyWorkspaceSceneSnapshot,
  digestWorkspaceScene,
  type WorkspaceSceneEvent,
  type WorkspaceSceneSnapshot,
} from '@shared/types';
import { describe, expect, it } from 'vitest';
import { applyWorkspaceSceneEvent } from '../WorkspaceMirrorService';

const identity = {
  hostId: 'host-convergence',
  sceneId: 'scene-convergence',
  hostEpoch: '33333333-3333-4333-8333-333333333333',
};

function apply(
  snapshot: WorkspaceSceneSnapshot,
  event: WorkspaceSceneEvent
): WorkspaceSceneSnapshot {
  const result = applyWorkspaceSceneEvent(snapshot, event);
  if (result.status === 'resyncRequired') throw new Error(result.error.message);
  return result.snapshot;
}

function createFixture(): WorkspaceSceneSnapshot {
  const snapshot = createEmptyWorkspaceSceneSnapshot(identity);
  snapshot.catalog.repositories.repo = {
    id: 'repo',
    path: '/workspace/repo',
    name: 'repo',
    groupId: null,
    order: 0,
    settings: { autoInitWorktree: false, initScript: '', hidden: false },
  };
  snapshot.catalog.worktrees.worktree = {
    id: 'worktree',
    repositoryId: 'repo',
    path: '/workspace/repo',
    name: 'main',
    branch: 'main',
    order: 0,
    isMain: true,
  };
  snapshot.navigation = {
    ...snapshot.navigation,
    selectedRepositoryId: 'repo',
    activeWorktreeId: 'worktree',
    activePanelByWorktree: { worktree: 'chat' },
    panelOrderByWorktree: { worktree: ['chat', 'file', 'terminal', 'todo'] },
  };
  snapshot.editors.worktree = {
    tabs: [
      {
        id: 'tab-index',
        path: '/workspace/repo/index.ts',
        title: 'index.ts',
        order: 0,
        encoding: 'utf-8',
        isUnsupported: false,
      },
    ],
    activeFile: '/workspace/repo/index.ts',
    buffers: {
      '/workspace/repo/index.ts': {
        path: '/workspace/repo/index.ts',
        isDirty: false,
        version: 0,
        hasExternalChange: false,
      },
    },
  };
  snapshot.terminals.sessions.terminal = {
    id: 'terminal',
    generation: 1,
    repositoryId: 'repo',
    worktreeId: 'worktree',
    title: 'Terminal',
    cwd: '/workspace/repo',
    groupId: null,
    order: 0,
    processState: 'running',
    exitCode: null,
  };
  snapshot.agents.sessions.agent = {
    id: 'agent',
    providerSessionId: 'provider-session',
    generation: 1,
    agentId: 'claude',
    name: 'Agent',
    repositoryId: 'repo',
    worktreeId: 'worktree',
    terminalSessionId: 'terminal',
    environment: 'native',
    initialized: true,
    activated: true,
    displayOrder: 0,
    runtimeState: 'idle',
    status: 'idle',
    waitingReason: null,
    draft: { text: '', resources: [] },
    task: null,
  };
  snapshot.todos.boardsByRepository.repo = {
    tasks: {
      task: {
        id: 'task',
        title: 'Task',
        description: '',
        priority: 'medium',
        status: 'todo',
        createdAt: 1,
        updatedAt: 1,
        order: 0,
        sessionId: null,
      },
    },
    autoExecution: {
      running: false,
      queue: [],
      currentTaskId: null,
      currentSessionId: null,
    },
  };
  snapshot.selections = {
    selectedFileByWorktree: { worktree: '/workspace/repo/index.ts' },
    selectedDiffByWorktree: { worktree: null },
    selectedTaskByRepository: { repo: 'task' },
  };
  return snapshot;
}

function eventFor(host: WorkspaceSceneSnapshot, revision: number): WorkspaceSceneEvent {
  const envelope = {
    t: 'state.event' as const,
    hostEpoch: identity.hostEpoch,
    sceneId: identity.sceneId,
    revision,
    origin: {
      source: 'client' as const,
      clientId: 'controller',
      deviceId: 'device-controller',
      operationId: `operation-${revision}`,
    },
  };
  switch (revision % 8) {
    case 0:
      return {
        ...envelope,
        kind: 'catalog.replace',
        payload: {
          catalog: {
            ...host.catalog,
            repositories: {
              ...host.catalog.repositories,
              repo: {
                ...host.catalog.repositories.repo!,
                settings: {
                  ...host.catalog.repositories.repo!.settings,
                  hidden: revision % 16 === 0,
                },
              },
            },
          },
        },
      };
    case 1:
      return {
        ...envelope,
        kind: 'navigation.replace',
        payload: {
          navigation: {
            ...host.navigation,
            activePrimaryPanel: revision % 16 === 1 ? 'terminal' : 'chat',
          },
        },
      };
    case 2: {
      const dirty = revision % 16 === 2;
      return {
        ...envelope,
        kind: 'editor.replace',
        payload: {
          worktreeId: 'worktree',
          editor: {
            ...host.editors.worktree!,
            buffers: {
              '/workspace/repo/index.ts': {
                path: '/workspace/repo/index.ts',
                isDirty: dirty,
                version: revision,
                hasExternalChange: false,
                ...(dirty ? { content: `revision ${revision}` } : {}),
              },
            },
          },
        },
      };
    }
    case 3: {
      const waiting = revision % 16 === 3;
      return {
        ...envelope,
        kind: 'agents.replace',
        payload: {
          agents: {
            ...host.agents,
            sessions: {
              agent: {
                ...host.agents.sessions.agent!,
                runtimeState: waiting ? 'unread' : 'outputting',
                status: waiting ? 'waiting' : 'running',
                waitingReason: waiting ? 'Choose an option' : null,
                draft: { text: waiting ? 'unsent reply' : '', resources: [] },
                task: {
                  id: 'agent',
                  status: waiting ? 'waiting' : 'running',
                  description: 'Exercise convergence',
                  waitingReason: waiting ? 'Choose an option' : null,
                  startedAt: 1,
                  completedAt: null,
                },
              },
            },
          },
        },
      };
    }
    case 4:
      return {
        ...envelope,
        kind: 'terminals.replace',
        payload: {
          terminals: {
            ...host.terminals,
            sessions: {
              terminal: {
                ...host.terminals.sessions.terminal!,
                title: `Terminal r${revision}`,
              },
            },
          },
        },
      };
    case 5:
      return {
        ...envelope,
        kind: 'todos.replace',
        payload: {
          todos: {
            boardsByRepository: {
              repo: {
                ...host.todos.boardsByRepository.repo!,
                tasks: {
                  task: {
                    ...host.todos.boardsByRepository.repo!.tasks.task!,
                    title: `Task r${revision}`,
                    updatedAt: revision,
                  },
                },
              },
            },
          },
        },
      };
    case 6:
      return {
        ...envelope,
        kind: 'selections.replace',
        payload: {
          selections: {
            ...host.selections,
            selectedDiffByWorktree: {
              worktree: revision % 16 === 6 ? '/workspace/repo/index.ts' : null,
            },
          },
        },
      };
    default:
      return {
        ...envelope,
        kind: 'resources.invalidate',
        payload: {
          resourceKey: 'git-status:repo',
          domain: 'git-status',
          entityId: 'repo',
          generation: revision,
          reason: 'changed',
        },
      };
  }
}

describe('workspace mirror deterministic convergence', () => {
  it('converges three projections through 10,000 ordered mutations and duplicate delivery', async () => {
    let host = createFixture();
    let first = createFixture();
    let second = createFixture();
    let third = createFixture();
    const delayedSecond: WorkspaceSceneEvent[] = [];
    const reorderedThird: WorkspaceSceneEvent[] = [];

    for (let revision = 1; revision <= 10_000; revision += 1) {
      const event = eventFor(host, revision);
      host = apply(host, event);
      first = apply(first, event);
      if (revision % 257 === 0) first = apply(first, event);

      if (delayedSecond.length > 0 || revision % 997 === 0) delayedSecond.push(event);
      else second = apply(second, event);
      if (revision % 997 === 5 && delayedSecond.length > 0) {
        for (const delayed of delayedSecond.splice(0)) second = apply(second, delayed);
      }

      reorderedThird.unshift(event);
      if (reorderedThird.length === 17) {
        reorderedThird.sort((left, right) => left.revision - right.revision);
        for (const buffered of reorderedThird.splice(0)) third = apply(third, buffered);
      }
    }
    for (const delayed of delayedSecond.sort((left, right) => left.revision - right.revision)) {
      second = apply(second, delayed);
    }
    for (const buffered of reorderedThird.sort((left, right) => left.revision - right.revision)) {
      third = apply(third, buffered);
    }

    expect([first.revision, second.revision, third.revision]).toEqual([10_000, 10_000, 10_000]);
    const hostDigest = await digestWorkspaceScene(host);
    await expect(Promise.all([first, second, third].map(digestWorkspaceScene))).resolves.toEqual([
      hostDigest,
      hostDigest,
      hostDigest,
    ]);
  }, 15_000);
});
