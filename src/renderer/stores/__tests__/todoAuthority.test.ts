import { createEmptyWorkspaceSceneSnapshot } from '@shared/types';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  canMutateTodo,
  getTodoStoreKey,
  INITIAL_AUTO_EXECUTE,
  selectTasks,
  useTodoStore,
} from '../todo';
import { useWorkspaceMirrorStore } from '../workspaceMirror';

const identity = {
  hostId: 'host-1',
  sceneId: 'scene-1',
  hostEpoch: '9c704499-736f-461d-9451-ae650ed3bbe8',
};

function setMirror(
  projectionTarget: 'local' | 'remote' | 'transitioning',
  ownsControl: boolean
): string {
  const snapshot = createEmptyWorkspaceSceneSnapshot(identity);
  snapshot.catalog.repositories['repo-1'] = {
    id: 'repo-1',
    path: '/repo',
    name: 'repo',
    groupId: null,
    order: 0,
    settings: { autoInitWorktree: false, initScript: '', hidden: false },
  };
  useWorkspaceMirrorStore.setState({
    snapshot,
    syncPhase: projectionTarget === 'transitioning' ? 'stale' : 'live',
    projectionTarget,
    bootstrapReady: projectionTarget !== 'local',
    controllerLease: ownsControl
      ? {
          leaseId: 'lease-1',
          holderDeviceId: 'device-1',
          holderClientId: 'client-1',
          acquiredAt: 1,
          expiresAt: Number.MAX_SAFE_INTEGER,
          graceUntil: null,
          coordSeq: 1,
        }
      : null,
    ownsControl,
    error: null,
    applyingAuthoritativeState: false,
  });
  return getTodoStoreKey('/repo');
}

const task = {
  id: 'task-1',
  title: 'Keep state authoritative',
  description: '',
  priority: 'medium' as const,
  status: 'todo' as const,
  createdAt: 1,
  updatedAt: 1,
  order: 0,
};

beforeEach(() => {
  useTodoStore.setState({ tasks: {}, _loaded: new Set(), autoExecute: {} });
  useWorkspaceMirrorStore.setState({
    snapshot: null,
    syncPhase: 'disconnected',
    projectionTarget: 'local',
    bootstrapReady: false,
    controllerLease: null,
    ownsControl: false,
    error: null,
    applyingAuthoritativeState: false,
  });
});

describe('Todo authority boundaries', () => {
  it('does not optimistically mutate an observer projection', () => {
    const key = setMirror('remote', false);
    useTodoStore.setState({
      tasks: { [key]: [task] },
      _loaded: new Set([key]),
      autoExecute: { [key]: { ...INITIAL_AUTO_EXECUTE, queue: ['task-1'] } },
    });
    const before = useTodoStore.getState();

    expect(canMutateTodo()).toBe(false);
    expect(
      useTodoStore.getState().addTask('/repo', {
        title: 'blocked',
        description: '',
        priority: 'medium',
        status: 'todo',
      })
    ).toBeNull();
    useTodoStore.getState().updateTask('/repo', 'task-1', { title: 'blocked' });
    useTodoStore.getState().deleteTask('/repo', 'task-1');
    useTodoStore.getState().moveTask('/repo', 'task-1', 'done', 0);
    useTodoStore.getState().reorderTasks('/repo', 'todo', ['task-1']);
    useTodoStore.getState().startAutoExecute('/repo', ['task-1']);
    useTodoStore.getState().stopAutoExecute('/repo');
    useTodoStore.getState().setCurrentExecution('/repo', 'task-1', 'session-1');
    expect(useTodoStore.getState().advanceQueue('/repo')).toBeNull();
    useTodoStore.getState().reorderAutoExecuteQueue('/repo', 0, 0);
    useTodoStore.getState().removeFromAutoExecuteQueue('/repo', 'task-1');

    expect(useTodoStore.getState().tasks).toEqual(before.tasks);
    expect(useTodoStore.getState().autoExecute).toEqual(before.autoExecute);
  });

  it('does not fall back to the local compatibility DB while transitioning', () => {
    const key = setMirror('transitioning', true);
    expect(key).toBe('/repo');
    expect(canMutateTodo()).toBe(false);

    expect(
      useTodoStore.getState().addTask('/repo', {
        title: 'blocked during handoff',
        description: '',
        priority: 'medium',
        status: 'todo',
      })
    ).toBeNull();
    expect(useTodoStore.getState().tasks).toEqual({});
  });

  it('uses the host-issued repository key for a remote controller', () => {
    const key = setMirror('remote', true);
    expect(key).toBe('remote:host-1:scene-1:repo-1');
    expect(canMutateTodo()).toBe(true);

    const created = useTodoStore.getState().addTask('/repo', {
      title: 'remote task',
      description: '',
      priority: 'medium',
      status: 'todo',
    });
    expect(created?.title).toBe('remote task');
    expect(selectTasks(useTodoStore.getState(), '/repo')).toHaveLength(1);
  });
});
