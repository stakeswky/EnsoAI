import { createEmptyWorkspaceSceneSnapshot } from '@shared/types';
import { describe, expect, it, vi } from 'vitest';
import {
  applyWorkspaceSceneEvent,
  canMutateWorkspaceProjection,
  useWorkspaceMirrorStore,
} from '../workspaceMirror';

const identity = {
  hostId: 'host-1',
  sceneId: 'scene-1',
  hostEpoch: '9c704499-736f-461d-9451-ae650ed3dbe8',
};

describe('workspace mirror renderer projection', () => {
  it('applies contiguous events and ignores duplicates', () => {
    const empty = createEmptyWorkspaceSceneSnapshot(identity);
    const event = {
      t: 'state.event' as const,
      hostEpoch: identity.hostEpoch,
      sceneId: identity.sceneId,
      revision: 1,
      origin: {
        clientId: 'client-1',
        deviceId: 'device-1',
        operationId: 'op-1',
        source: 'client' as const,
      },
      kind: 'navigation.replace' as const,
      payload: { navigation: { ...empty.navigation, activePrimaryPanel: 'terminal' as const } },
    };
    const applied = applyWorkspaceSceneEvent(empty, event);
    expect(applied.revision).toBe(1);
    expect(applied.navigation.activePrimaryPanel).toBe('terminal');
    expect(applyWorkspaceSceneEvent(applied, event)).toBe(applied);
  });

  it('rejects revision gaps and foreign scene events', () => {
    const empty = createEmptyWorkspaceSceneSnapshot(identity);
    const base = {
      t: 'state.event' as const,
      hostEpoch: identity.hostEpoch,
      sceneId: identity.sceneId,
      origin: {
        clientId: 'client-1',
        deviceId: 'device-1',
        operationId: 'op-1',
        source: 'client' as const,
      },
      kind: 'catalog.replace' as const,
      payload: { catalog: empty.catalog },
    };
    expect(() => applyWorkspaceSceneEvent(empty, { ...base, revision: 2 })).toThrow(/revision gap/);
    expect(() =>
      applyWorkspaceSceneEvent(empty, { ...base, sceneId: 'other-scene', revision: 1 })
    ).toThrow(/identity changed/);
  });

  it('applies an atomic scene replacement without exposing dangling catalog references', () => {
    const empty = createEmptyWorkspaceSceneSnapshot(identity);
    const replaced = applyWorkspaceSceneEvent(empty, {
      t: 'state.event',
      hostEpoch: identity.hostEpoch,
      sceneId: identity.sceneId,
      revision: 1,
      origin: {
        clientId: 'client-1',
        deviceId: 'device-1',
        operationId: 'replace-scene',
        source: 'client',
      },
      kind: 'scene.replace',
      payload: {
        catalog: empty.catalog,
        navigation: { ...empty.navigation, activePrimaryPanel: 'todo' },
        editors: empty.editors,
        agents: empty.agents,
        terminals: empty.terminals,
        todos: empty.todos,
        selections: empty.selections,
      },
    });
    expect(replaced.revision).toBe(1);
    expect(replaced.navigation.activePrimaryPanel).toBe('todo');
  });

  it('records and releases a controller lease through the mirror store actions', async () => {
    const lease = {
      leaseId: 'lease-1',
      holderDeviceId: 'device-1',
      holderClientId: 'client-1',
      acquiredAt: 1,
      expiresAt: 60_000,
      graceUntil: null,
      coordSeq: 1,
    };
    const requestControl = vi.fn().mockResolvedValue(lease);
    const releaseControl = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('window', {
      electronAPI: { workspaceMirror: { requestControl, releaseControl } },
    });
    useWorkspaceMirrorStore.setState({ controllerLease: null, ownsControl: false });

    await expect(useWorkspaceMirrorStore.getState().requestControl(true)).resolves.toEqual(lease);
    expect(requestControl).toHaveBeenCalledWith(true);
    expect(useWorkspaceMirrorStore.getState()).toMatchObject({
      controllerLease: lease,
      ownsControl: true,
    });
    await useWorkspaceMirrorStore.getState().releaseControl();
    expect(useWorkspaceMirrorStore.getState()).toMatchObject({
      controllerLease: null,
      ownsControl: false,
    });
  });

  it('allows local mutations but requires control for a remote projection', () => {
    useWorkspaceMirrorStore.setState({ projectionTarget: 'local', ownsControl: false });
    expect(canMutateWorkspaceProjection()).toBe(true);

    useWorkspaceMirrorStore.setState({ projectionTarget: 'remote', ownsControl: false });
    expect(canMutateWorkspaceProjection()).toBe(false);

    useWorkspaceMirrorStore.setState({ projectionTarget: 'remote', ownsControl: true });
    expect(canMutateWorkspaceProjection()).toBe(true);

    useWorkspaceMirrorStore.setState({ projectionTarget: 'transitioning', ownsControl: true });
    expect(canMutateWorkspaceProjection()).toBe(false);
  });
});
