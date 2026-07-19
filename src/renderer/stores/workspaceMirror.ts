import {
  type ControllerLease,
  type RemoteClientStatus,
  type StateIntentResultFrame,
  type WorkspaceSceneEvent,
  WorkspaceSceneEventSchema,
  type WorkspaceSceneIntent,
  type WorkspaceSceneMutation,
  type WorkspaceSceneSnapshot,
  WorkspaceSceneSnapshotSchema,
  type WorkspaceSyncPhase,
} from '@shared/types';
import { create } from 'zustand';
import { isRemoteAttached, useRemoteStore } from './remote';

interface WorkspaceMirrorState {
  snapshot: WorkspaceSceneSnapshot | null;
  snapshotTarget: Exclude<WorkspaceProjectionTarget, 'transitioning'> | null;
  syncPhase: WorkspaceSyncPhase;
  projectionTarget: WorkspaceProjectionTarget;
  bootstrapReady: boolean;
  controllerLease: ControllerLease | null;
  ownsControl: boolean;
  error: string | null;
  applyingAuthoritativeState: boolean;
  hydrate: (
    snapshot: WorkspaceSceneSnapshot,
    target?: Exclude<WorkspaceProjectionTarget, 'transitioning'>,
    bootstrapReady?: boolean
  ) => void;
  applyEvent: (event: WorkspaceSceneEvent) => void;
  refresh: () => Promise<void>;
  dispatchMutation: (mutation: WorkspaceSceneMutation) => Promise<StateIntentResultFrame>;
  requestControl: (allowTransfer?: boolean) => Promise<ControllerLease>;
  releaseControl: () => Promise<void>;
}

type RemoteStatusProjectionState = Pick<
  WorkspaceMirrorState,
  | 'snapshot'
  | 'snapshotTarget'
  | 'syncPhase'
  | 'projectionTarget'
  | 'controllerLease'
  | 'ownsControl'
>;

type RemoteStatusProjectionPatch = Partial<
  Pick<WorkspaceMirrorState, 'syncPhase' | 'projectionTarget' | 'controllerLease' | 'ownsControl'>
>;

export interface RemoteStatusProjectionReconciliation {
  patch: RemoteStatusProjectionPatch;
  refreshProjection: boolean;
}

export type WorkspaceProjectionTarget = 'local' | 'remote' | 'transitioning';

export function isLocalWorkspaceProjection(): boolean {
  return useWorkspaceMirrorStore.getState().projectionTarget === 'local';
}

export function canMutateWorkspaceProjection(): boolean {
  const { ownsControl, projectionTarget } = useWorkspaceMirrorStore.getState();
  return projectionTarget !== 'transitioning' && (projectionTarget === 'local' || ownsControl);
}

export function canQueryWorkspaceResources(
  projectionTarget: WorkspaceProjectionTarget,
  syncPhase: WorkspaceSyncPhase
): boolean {
  return projectionTarget !== 'transitioning' && syncPhase === 'live';
}

export function getWorkspaceQueryScope(
  projectionTarget: WorkspaceProjectionTarget,
  snapshot: WorkspaceSceneSnapshot | null
): string {
  if (projectionTarget === 'transitioning') return 'transitioning';
  return `${projectionTarget}:${snapshot?.hostId ?? 'unknown'}:${snapshot?.sceneId ?? 'unknown'}`;
}

function getSettledProjectionTarget(
  status: RemoteClientStatus | null
): Exclude<WorkspaceProjectionTarget, 'transitioning'> | null {
  if (status === null || status.state === 'connecting' || status.state === 'reconnecting') {
    return null;
  }
  if (status.state === 'disconnected') return 'local';
  if (status.mirrorProtocol === 'v1') return 'local';
  if (status.mirrorProtocol === 'v2' && status.mirrorSyncPhase === 'live') return 'remote';
  return null;
}

function sameControllerLease(left: ControllerLease | null, right: ControllerLease | null): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.leaseId === right.leaseId &&
      left.holderDeviceId === right.holderDeviceId &&
      left.holderClientId === right.holderClientId &&
      left.acquiredAt === right.acquiredAt &&
      left.expiresAt === right.expiresAt &&
      left.graceUntil === right.graceUntil &&
      left.coordSeq === right.coordSeq)
  );
}

export function reconcileWorkspaceMirrorRemoteStatus(
  current: RemoteStatusProjectionState,
  status: RemoteClientStatus
): RemoteStatusProjectionReconciliation {
  const patch: RemoteStatusProjectionPatch = {};
  const connectedToV2 = status.state === 'connected' && status.mirrorProtocol === 'v2';
  const nextLease = connectedToV2 ? (status.mirrorController ?? null) : null;
  const nextOwnership = connectedToV2 && status.mirrorOwnsControl === true;

  if (!sameControllerLease(current.controllerLease, nextLease)) {
    patch.controllerLease = nextLease;
  }
  if (current.ownsControl !== nextOwnership) {
    patch.ownsControl = nextOwnership;
  }

  if (status.state === 'reconnecting') {
    if (current.syncPhase !== 'stale') patch.syncPhase = 'stale';
    return { patch, refreshProjection: false };
  }

  const waitingForRemoteProjection =
    status.state === 'connecting' ||
    (status.state === 'connected' && status.mirrorProtocol === undefined) ||
    (connectedToV2 && status.mirrorSyncPhase !== 'live');
  if (waitingForRemoteProjection) {
    if (current.projectionTarget !== 'transitioning') {
      patch.projectionTarget = 'transitioning';
    }
    if (connectedToV2 && status.mirrorSyncPhase && current.syncPhase !== status.mirrorSyncPhase) {
      patch.syncPhase = status.mirrorSyncPhase;
    }
    return { patch, refreshProjection: false };
  }

  const desiredTarget = connectedToV2 ? 'remote' : 'local';
  if (current.snapshot !== null && current.snapshotTarget === desiredTarget) {
    if (current.projectionTarget !== desiredTarget) patch.projectionTarget = desiredTarget;
    if (current.syncPhase !== 'live') patch.syncPhase = 'live';
    return { patch, refreshProjection: false };
  }
  if (current.projectionTarget !== 'transitioning') {
    patch.projectionTarget = 'transitioning';
  }
  return { patch, refreshProjection: true };
}

let clientSequence = 0;
let projectionRefreshSequence = 0;

export function applyWorkspaceSceneEvent(
  current: WorkspaceSceneSnapshot,
  candidate: WorkspaceSceneEvent
): WorkspaceSceneSnapshot {
  const event = WorkspaceSceneEventSchema.parse(candidate);
  if (event.hostEpoch !== current.hostEpoch || event.sceneId !== current.sceneId) {
    throw new Error('workspace scene identity changed');
  }
  if (event.revision <= current.revision) {
    return current;
  }
  if (event.revision !== current.revision + 1) {
    throw new Error(
      `workspace revision gap: expected ${current.revision + 1}, got ${event.revision}`
    );
  }

  let next: WorkspaceSceneSnapshot;
  switch (event.kind) {
    case 'scene.replace':
      next = { ...current, ...event.payload };
      break;
    case 'catalog.replace':
      next = { ...current, catalog: event.payload.catalog };
      break;
    case 'navigation.replace':
      next = { ...current, navigation: event.payload.navigation };
      break;
    case 'editor.replace':
      next = {
        ...current,
        editors: { ...current.editors, [event.payload.worktreeId]: event.payload.editor },
      };
      break;
    case 'editor.remove': {
      const editors = { ...current.editors };
      delete editors[event.payload.worktreeId];
      next = { ...current, editors };
      break;
    }
    case 'editor.buffer.update': {
      const editor = current.editors[event.payload.worktreeId];
      if (!editor) {
        throw new Error(`editor scene not found: ${event.payload.worktreeId}`);
      }
      next = {
        ...current,
        editors: {
          ...current.editors,
          [event.payload.worktreeId]: {
            ...editor,
            buffers: {
              ...editor.buffers,
              [event.payload.path]: {
                path: event.payload.path,
                isDirty: event.payload.isDirty,
                version: event.payload.nextVersion,
                hasExternalChange: event.payload.hasExternalChange,
                ...(event.payload.content === undefined ? {} : { content: event.payload.content }),
                ...(event.payload.externalContent === undefined
                  ? {}
                  : { externalContent: event.payload.externalContent }),
              },
            },
          },
        },
      };
      break;
    }
    case 'agents.replace':
      next = { ...current, agents: event.payload.agents };
      break;
    case 'terminals.replace':
      next = { ...current, terminals: event.payload.terminals };
      break;
    case 'todos.replace':
      next = { ...current, todos: event.payload.todos };
      break;
    case 'selections.replace':
      next = { ...current, selections: event.payload.selections };
      break;
    case 'resources.invalidate':
      next = {
        ...current,
        resources: {
          invalidations: {
            ...current.resources.invalidations,
            [event.payload.resourceKey]: event.payload,
          },
        },
      };
      break;
  }
  return WorkspaceSceneSnapshotSchema.parse({ ...next, revision: event.revision });
}

export const useWorkspaceMirrorStore = create<WorkspaceMirrorState>((set, get) => ({
  snapshot: null,
  snapshotTarget: null,
  syncPhase: 'disconnected',
  projectionTarget: 'transitioning',
  bootstrapReady: false,
  controllerLease: null,
  ownsControl: false,
  error: null,
  applyingAuthoritativeState: false,

  hydrate: (snapshot, target = 'local', bootstrapReady = target === 'remote') => {
    projectionRefreshSequence += 1;
    const parsed = WorkspaceSceneSnapshotSchema.parse(snapshot);
    set({
      snapshot: parsed,
      snapshotTarget: target,
      syncPhase: 'live',
      projectionTarget: target,
      bootstrapReady,
      error: null,
      applyingAuthoritativeState: true,
    });
    queueMicrotask(() => set({ applyingAuthoritativeState: false }));
  },

  applyEvent: (event) => {
    const current = get().snapshot;
    if (!current) {
      void get().refresh();
      return;
    }
    try {
      const snapshot = applyWorkspaceSceneEvent(current, event);
      projectionRefreshSequence += 1;
      set({ snapshot, syncPhase: 'live', error: null, applyingAuthoritativeState: true });
      queueMicrotask(() => set({ applyingAuthoritativeState: false }));
    } catch (error) {
      set({
        syncPhase: 'resyncing',
        error: error instanceof Error ? error.message : String(error),
      });
      void get().refresh();
    }
  },

  refresh: async () => {
    const remoteStatus = useRemoteStore.getState().status;
    const target = getSettledProjectionTarget(remoteStatus);
    if (target === null) {
      set({ projectionTarget: 'transitioning' });
      return;
    }
    const refreshSequence = ++projectionRefreshSequence;
    set({ syncPhase: get().snapshot ? 'resyncing' : 'syncing', error: null });
    try {
      const [snapshot, bootstrapStatus] = await Promise.all([
        window.electronAPI.workspaceMirror.getSnapshot(),
        target === 'local'
          ? window.electronAPI.workspaceMirror.getBootstrapStatus()
          : Promise.resolve({ ready: true }),
      ]);
      if (
        refreshSequence !== projectionRefreshSequence ||
        getSettledProjectionTarget(useRemoteStore.getState().status) !== target
      ) {
        return;
      }
      get().hydrate(snapshot, target, bootstrapStatus.ready);
    } catch (error) {
      if (refreshSequence !== projectionRefreshSequence) return;
      set({
        syncPhase: 'stale',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  },

  dispatchMutation: async (mutation) => {
    const snapshot = get().snapshot;
    if (!snapshot) {
      throw new Error('workspace mirror is not hydrated');
    }
    const intent = {
      ...mutation,
      t: 'state.intent',
      operationId: crypto.randomUUID(),
      clientSeq: ++clientSequence,
      baseRevision: snapshot.revision,
    } as WorkspaceSceneIntent;
    const result = await window.electronAPI.workspaceMirror.dispatchIntent(intent);
    if (!result.accepted) {
      set({ error: result.error.message });
      await get().refresh();
    }
    return result;
  },

  requestControl: async (allowTransfer = false) => {
    try {
      const lease = await window.electronAPI.workspaceMirror.requestControl(allowTransfer);
      set({ controllerLease: lease, ownsControl: true });
      return lease;
    } catch (error) {
      const status = useRemoteStore.getState().status;
      if (status?.state === 'connected' && status.mirrorProtocol === 'v2') {
        set({
          controllerLease: status.mirrorController ?? null,
          ownsControl: status.mirrorOwnsControl === true,
        });
      }
      throw error;
    }
  },

  releaseControl: async () => {
    await window.electronAPI.workspaceMirror.releaseControl();
    set({ controllerLease: null, ownsControl: false });
  },
}));

let initialized = false;

export function initWorkspaceMirrorSync(): void {
  if (initialized) return;
  initialized = true;
  window.electronAPI.workspaceMirror.onEvent((event) => {
    useWorkspaceMirrorStore.getState().applyEvent(event);
  });
  window.electronAPI.workspaceMirror.onSnapshot((snapshot) => {
    useWorkspaceMirrorStore.getState().hydrate(snapshot, 'remote');
  });
  window.electronAPI.workspaceMirror.onControlChanged((lease) => {
    const current = useWorkspaceMirrorStore.getState();
    const attachedToV2 =
      isRemoteAttached(useRemoteStore.getState().status) &&
      useRemoteStore.getState().status?.mirrorProtocol === 'v2';
    useWorkspaceMirrorStore.setState({
      controllerLease: lease,
      ...(attachedToV2
        ? {}
        : {
            ownsControl: Boolean(
              lease && current.controllerLease?.leaseId === lease.leaseId && current.ownsControl
            ),
          }),
    });
    if (!lease && !attachedToV2) {
      setTimeout(() => {
        void useWorkspaceMirrorStore
          .getState()
          .requestControl()
          .catch(() => undefined);
      }, 1_000);
    }
  });
  const refreshAndTryControl = async (): Promise<void> => {
    const current = useWorkspaceMirrorStore.getState();
    await current.refresh();
    if (useWorkspaceMirrorStore.getState().projectionTarget !== 'local') return;
    await useWorkspaceMirrorStore
      .getState()
      .requestControl()
      .catch(() => undefined);
  };
  const handleRemoteStatus = (status: RemoteClientStatus): void => {
    const reconciliation = reconcileWorkspaceMirrorRemoteStatus(
      useWorkspaceMirrorStore.getState(),
      status
    );
    if (Object.keys(reconciliation.patch).length > 0) {
      useWorkspaceMirrorStore.setState(reconciliation.patch);
    }
    if (reconciliation.refreshProjection) void refreshAndTryControl();
  };
  useRemoteStore.subscribe((state, previousState) => {
    if (!state.status || state.status === previousState.status) return;
    handleRemoteStatus(state.status);
  });
  const initialRemoteStatus = useRemoteStore.getState().status;
  if (initialRemoteStatus) handleRemoteStatus(initialRemoteStatus);
  setInterval(() => {
    if (useWorkspaceMirrorStore.getState().ownsControl) {
      void useWorkspaceMirrorStore
        .getState()
        .requestControl()
        .catch(() => {
          useWorkspaceMirrorStore.setState({ ownsControl: false });
        });
    }
  }, 15_000);
}
