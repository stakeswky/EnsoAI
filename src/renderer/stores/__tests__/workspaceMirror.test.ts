import { createEmptyWorkspaceSceneSnapshot } from '@shared/types';
import { describe, expect, it, vi } from 'vitest';
import { useRemoteStore } from '../remote';
import {
  applyWorkspaceSceneEvent,
  canMutateWorkspaceProjection,
  canQueryWorkspaceResources,
  getWorkspaceQueryScope,
  reconcileWorkspaceMirrorRemoteStatus,
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

  it('queries workspace resources only after the active projection is live', () => {
    expect(canQueryWorkspaceResources('transitioning', 'syncing')).toBe(false);
    expect(canQueryWorkspaceResources('remote', 'stale')).toBe(false);
    expect(canQueryWorkspaceResources('remote', 'live')).toBe(true);
    expect(canQueryWorkspaceResources('local', 'live')).toBe(true);
  });

  it('isolates resource query caches by projection and scene identity', () => {
    const snapshot = createEmptyWorkspaceSceneSnapshot(identity);
    expect(getWorkspaceQueryScope('transitioning', snapshot)).toBe('transitioning');
    expect(getWorkspaceQueryScope('local', snapshot)).toBe('local:host-1:scene-1');
    expect(getWorkspaceQueryScope('remote', snapshot)).toBe('remote:host-1:scene-1');
  });

  it('keeps a live remote projection stable across lease-only status updates', () => {
    const snapshot = createEmptyWorkspaceSceneSnapshot(identity);
    const lease = {
      leaseId: 'lease-2',
      holderDeviceId: 'device-2',
      holderClientId: 'client-2',
      acquiredAt: 2,
      expiresAt: 60_002,
      graceUntil: null,
      coordSeq: 2,
    };
    const reconciliation = reconcileWorkspaceMirrorRemoteStatus(
      {
        snapshot,
        snapshotTarget: 'remote',
        syncPhase: 'live',
        projectionTarget: 'remote',
        controllerLease: null,
        ownsControl: false,
      },
      {
        state: 'connected',
        host: '100.64.0.2',
        port: 48925,
        hostInfo: null,
        mirrorProtocol: 'v2',
        mirrorSyncPhase: 'live',
        mirrorRevision: 12,
        mirrorController: lease,
        mirrorOwnsControl: false,
      }
    );

    expect(reconciliation).toEqual({
      patch: { controllerLease: lease },
      refreshProjection: false,
    });
  });

  it('uses remote status ownership directly across revoked and granted frames', () => {
    const snapshot = createEmptyWorkspaceSceneSnapshot(identity);
    const current = {
      snapshot,
      snapshotTarget: 'remote' as const,
      syncPhase: 'live' as const,
      projectionTarget: 'remote' as const,
      controllerLease: {
        leaseId: 'lease-old',
        holderDeviceId: 'device-1',
        holderClientId: 'client-1',
        acquiredAt: 1,
        expiresAt: 60_000,
        graceUntil: null,
        coordSeq: 1,
      },
      ownsControl: true,
    };
    const revoked = reconcileWorkspaceMirrorRemoteStatus(current, {
      state: 'connected',
      host: '100.64.0.2',
      port: 48925,
      hostInfo: null,
      mirrorProtocol: 'v2',
      mirrorSyncPhase: 'live',
      mirrorRevision: 12,
      mirrorController: null,
      mirrorOwnsControl: false,
    });
    expect(revoked.patch).toEqual({ controllerLease: null, ownsControl: false });
    expect(revoked.refreshProjection).toBe(false);

    const nextLease = { ...current.controllerLease, leaseId: 'lease-new', coordSeq: 3 };
    const granted = reconcileWorkspaceMirrorRemoteStatus(
      { ...current, controllerLease: null, ownsControl: false },
      {
        state: 'connected',
        host: '100.64.0.2',
        port: 48925,
        hostInfo: null,
        mirrorProtocol: 'v2',
        mirrorSyncPhase: 'live',
        mirrorRevision: 12,
        mirrorController: nextLease,
        mirrorOwnsControl: true,
      }
    );
    expect(granted.patch).toEqual({ controllerLease: nextLease, ownsControl: true });
    expect(granted.refreshProjection).toBe(false);
  });

  it('enters transitioning only for an actual connect, disconnect, or resync boundary', () => {
    const snapshot = createEmptyWorkspaceSceneSnapshot(identity);
    const remoteState = {
      snapshot,
      snapshotTarget: 'remote' as const,
      syncPhase: 'live' as const,
      projectionTarget: 'remote' as const,
      controllerLease: null,
      ownsControl: false,
    };
    const resync = reconcileWorkspaceMirrorRemoteStatus(remoteState, {
      state: 'connected',
      host: '100.64.0.2',
      port: 48925,
      hostInfo: null,
      mirrorProtocol: 'v2',
      mirrorSyncPhase: 'resyncing',
      mirrorOwnsControl: false,
    });
    expect(resync).toEqual({
      patch: { projectionTarget: 'transitioning', syncPhase: 'resyncing' },
      refreshProjection: false,
    });

    const disconnect = reconcileWorkspaceMirrorRemoteStatus(remoteState, {
      state: 'disconnected',
      host: null,
      port: null,
      hostInfo: null,
    });
    expect(disconnect).toEqual({
      patch: { projectionTarget: 'transitioning' },
      refreshProjection: true,
    });
  });

  it('returns to the remote projection after an empty replay reaches live', () => {
    const snapshot = createEmptyWorkspaceSceneSnapshot(identity);
    const reconciliation = reconcileWorkspaceMirrorRemoteStatus(
      {
        snapshot,
        snapshotTarget: 'remote',
        syncPhase: 'resyncing',
        projectionTarget: 'transitioning',
        controllerLease: null,
        ownsControl: false,
      },
      {
        state: 'connected',
        host: '100.64.0.2',
        port: 48925,
        hostInfo: null,
        mirrorProtocol: 'v2',
        mirrorSyncPhase: 'live',
        mirrorRevision: snapshot.revision,
        mirrorController: null,
        mirrorOwnsControl: false,
      }
    );

    expect(reconciliation).toEqual({
      patch: { projectionTarget: 'remote', syncPhase: 'live' },
      refreshProjection: false,
    });
  });

  it('fails closed while reconnecting even if transport status contains a stale lease', () => {
    const snapshot = createEmptyWorkspaceSceneSnapshot(identity);
    const staleLease = {
      leaseId: 'lease-stale',
      holderDeviceId: 'device-1',
      holderClientId: 'client-1',
      acquiredAt: 1,
      expiresAt: 60_000,
      graceUntil: null,
      coordSeq: 1,
    };
    const reconciliation = reconcileWorkspaceMirrorRemoteStatus(
      {
        snapshot,
        snapshotTarget: 'remote',
        syncPhase: 'live',
        projectionTarget: 'remote',
        controllerLease: staleLease,
        ownsControl: true,
      },
      {
        state: 'reconnecting',
        host: '100.64.0.2',
        port: 48925,
        hostInfo: null,
        mirrorProtocol: 'v2',
        mirrorSyncPhase: 'stale',
        mirrorController: staleLease,
        mirrorOwnsControl: true,
      }
    );

    expect(reconciliation).toEqual({
      patch: { controllerLease: null, ownsControl: false, syncPhase: 'stale' },
      refreshProjection: false,
    });
  });

  it('refreshes instead of exposing a snapshot from the previous projection', () => {
    const snapshot = createEmptyWorkspaceSceneSnapshot(identity);
    const reconciliation = reconcileWorkspaceMirrorRemoteStatus(
      {
        snapshot,
        snapshotTarget: 'local',
        syncPhase: 'live',
        projectionTarget: 'transitioning',
        controllerLease: null,
        ownsControl: false,
      },
      {
        state: 'connected',
        host: '100.64.0.2',
        port: 48925,
        hostInfo: null,
        mirrorProtocol: 'v2',
        mirrorSyncPhase: 'live',
        mirrorRevision: 0,
        mirrorController: null,
        mirrorOwnsControl: false,
      }
    );

    expect(reconciliation).toEqual({ patch: {}, refreshProjection: true });
  });

  it('does not let a stale local refresh overwrite a newer remote snapshot', async () => {
    const localSnapshot = createEmptyWorkspaceSceneSnapshot(identity);
    const remoteSnapshot = createEmptyWorkspaceSceneSnapshot({
      hostId: 'host-remote',
      sceneId: 'scene-remote',
      hostEpoch: '82ba9162-39cf-421a-82ff-80b505790f44',
    });
    let resolveSnapshot!: (snapshot: typeof localSnapshot) => void;
    const getSnapshot = vi.fn(
      () =>
        new Promise<typeof localSnapshot>((resolve) => {
          resolveSnapshot = resolve;
        })
    );
    vi.stubGlobal('window', {
      electronAPI: {
        workspaceMirror: {
          getSnapshot,
          getBootstrapStatus: vi.fn().mockResolvedValue({ ready: true }),
        },
      },
    });
    useRemoteStore.setState({
      status: { state: 'disconnected', host: null, port: null, hostInfo: null },
    });

    const refresh = useWorkspaceMirrorStore.getState().refresh();
    useRemoteStore.setState({
      status: {
        state: 'connected',
        host: '100.64.0.2',
        port: 48925,
        hostInfo: null,
        mirrorProtocol: 'v2',
        mirrorSyncPhase: 'live',
        mirrorOwnsControl: false,
      },
    });
    useWorkspaceMirrorStore.getState().hydrate(remoteSnapshot, 'remote');
    resolveSnapshot(localSnapshot);
    await refresh;

    expect(getSnapshot).toHaveBeenCalledTimes(1);
    expect(useWorkspaceMirrorStore.getState()).toMatchObject({
      snapshot: remoteSnapshot,
      snapshotTarget: 'remote',
      projectionTarget: 'remote',
    });
  });
});
