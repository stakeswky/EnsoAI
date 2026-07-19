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

let clientSequence = 0;

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
  syncPhase: 'disconnected',
  projectionTarget: 'transitioning',
  bootstrapReady: false,
  controllerLease: null,
  ownsControl: false,
  error: null,
  applyingAuthoritativeState: false,

  hydrate: (snapshot, target = 'local', bootstrapReady = target === 'remote') => {
    const parsed = WorkspaceSceneSnapshotSchema.parse(snapshot);
    set({
      snapshot: parsed,
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
    const target =
      isRemoteAttached(remoteStatus) && remoteStatus?.mirrorProtocol === 'v2' ? 'remote' : 'local';
    set({ syncPhase: get().snapshot ? 'resyncing' : 'syncing', error: null });
    try {
      const [snapshot, bootstrapStatus] = await Promise.all([
        window.electronAPI.workspaceMirror.getSnapshot(),
        target === 'local'
          ? window.electronAPI.workspaceMirror.getBootstrapStatus()
          : Promise.resolve({ ready: true }),
      ]);
      get().hydrate(snapshot, target, bootstrapStatus.ready);
    } catch (error) {
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
    const lease = await window.electronAPI.workspaceMirror.requestControl(allowTransfer);
    set({ controllerLease: lease, ownsControl: true });
    return lease;
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
    useWorkspaceMirrorStore.setState({
      controllerLease: lease,
      ownsControl: Boolean(
        lease && current.controllerLease?.leaseId === lease.leaseId && current.ownsControl
      ),
    });
    if (!lease && !isRemoteAttached(useRemoteStore.getState().status)) {
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
    const attachedToV2 = isRemoteAttached(status) && status.mirrorProtocol === 'v2';
    useWorkspaceMirrorStore.setState({
      controllerLease: attachedToV2 ? (status.mirrorController ?? null) : null,
      ownsControl: attachedToV2 ? status.mirrorOwnsControl === true : false,
    });
    if (status.state === 'reconnecting') {
      useWorkspaceMirrorStore.setState({ syncPhase: 'stale' });
      return;
    }
    useWorkspaceMirrorStore.setState({ projectionTarget: 'transitioning' });
    if (
      status.state === 'connecting' ||
      (status.mirrorProtocol === 'v2' && status.mirrorSyncPhase !== 'live')
    ) {
      return;
    }
    void refreshAndTryControl();
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
