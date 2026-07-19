import {
  IPC_CHANNELS,
  WorkspaceEntityAdoptionResultSchema,
  WorkspaceEntityIdSchema,
  type WorkspaceEntityKind,
  WorkspaceEntityLookupSchema,
  type WorkspaceEntityReservation,
  WorkspaceEntityReservationSchema,
  WorkspaceEntityResolutionSchema,
  type WorkspaceResourceUpload,
  WorkspaceResourceUploadSchema,
  type WorkspaceSceneIntent,
  WorkspaceSceneIntentSchema,
} from '@shared/types';
import { BrowserWindow, type IpcMainInvokeEvent, ipcMain, type WebContents } from 'electron';
import { remoteClientManager } from '../services/remote/RemoteClientManager';
import {
  broadcastToRemoteClients,
  REMOTE_VIRTUAL_SENDER_ID_START,
  remoteVirtualClientId,
} from '../services/remote/RemoteHostServer';
import * as todoService from '../services/todo/TodoService';
import { WorkspaceEntityRegistryError } from '../services/workspace/WorkspaceEntityRegistry';
import type { WorkspaceIntentActor } from '../services/workspace/WorkspaceMirrorService';
import {
  completeWorkspaceMirrorBootstrap,
  getWorkspaceEntityRegistry,
  getWorkspaceMirrorService,
  getWorkspaceResourceService,
} from '../services/workspace/workspaceMirrorRuntime';

const trackedSenders = new Set<number>();

function actorIdentity(senderId: number): Omit<WorkspaceIntentActor, 'leaseId'> {
  return {
    clientId: remoteVirtualClientId(senderId),
    deviceId: `device-${senderId}`,
  };
}

async function actorForEvent(event: IpcMainInvokeEvent): Promise<WorkspaceIntentActor> {
  const identity = actorIdentity(event.sender.id);
  const lease = await getWorkspaceMirrorService().getControllerLease();
  return {
    ...identity,
    ...(lease?.holderClientId === identity.clientId && lease.holderDeviceId === identity.deviceId
      ? { leaseId: lease.leaseId }
      : {}),
  };
}

function trackSender(sender: WebContents): void {
  if (trackedSenders.has(sender.id)) return;
  trackedSenders.add(sender.id);
  const identity = actorIdentity(sender.id);
  sender.once('destroyed', () => {
    trackedSenders.delete(sender.id);
    void (async () => {
      const service = getWorkspaceMirrorService();
      const lease = await service.getControllerLease();
      if (
        lease?.holderClientId === identity.clientId &&
        lease.holderDeviceId === identity.deviceId
      ) {
        await service.markControllerDisconnected({ ...identity, leaseId: lease.leaseId });
      }
    })();
  });
}

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.webContents.isDestroyed()) {
      window.webContents.send(channel, payload);
    }
  }
  broadcastToRemoteClients(channel, payload);
}

function adoptionConflictEntityIds(error: WorkspaceEntityRegistryError): string[] | undefined {
  const candidates = [
    error.details.conflictingEntityIds,
    error.details.entityIds,
    error.details.entityId,
  ];
  const entityIds = [
    ...new Set(
      candidates.flatMap((candidate) =>
        Array.isArray(candidate)
          ? candidate.filter((value): value is string => typeof value === 'string')
          : typeof candidate === 'string'
            ? [candidate]
            : []
      )
    ),
  ];
  return entityIds.length > 0 ? entityIds : undefined;
}

export function registerWorkspaceMirrorHandlers(): void {
  const service = getWorkspaceMirrorService();
  service.subscribe((event) => broadcast(IPC_CHANNELS.WORKSPACE_MIRROR_EVENT, event));
  service.subscribeControl(() => {
    void service
      .getControllerLease()
      .then((lease) => broadcast(IPC_CHANNELS.WORKSPACE_MIRROR_CONTROL_CHANGED, lease));
  });

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_MIRROR_GET_SNAPSHOT, async (event) => {
    trackSender(event.sender);
    return service.getSnapshot();
  });

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_MIRROR_GET_BOOTSTRAP_STATUS, async () => ({
    ready: service.isBootstrapReady(),
  }));

  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_MIRROR_DISPATCH_INTENT,
    async (event, candidate: WorkspaceSceneIntent) => {
      trackSender(event.sender);
      const intent = WorkspaceSceneIntentSchema.parse(candidate);
      return service.dispatchIntent(intent, await actorForEvent(event));
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_MIRROR_REQUEST_CONTROL,
    async (event, options?: { allowTransfer?: boolean }) => {
      trackSender(event.sender);
      const actor = actorIdentity(event.sender.id);
      const allowTransfer =
        options?.allowTransfer === true || event.sender.id >= REMOTE_VIRTUAL_SENDER_ID_START;
      const current = allowTransfer ? await service.getControllerLease() : null;
      const result = allowTransfer
        ? await service.requestControlTransfer(actor, current?.coordSeq ?? 0)
        : await service.requestControl(actor);
      if (!result.granted) {
        throw new Error(result.error.message);
      }
      return result.lease;
    }
  );

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_MIRROR_RELEASE_CONTROL, async (event) => {
    trackSender(event.sender);
    const error = await service.releaseControl(await actorForEvent(event));
    if (error) {
      throw new Error(error.message);
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_MIRROR_RESOLVE_ENTITIES,
    async (event, candidates: unknown) => {
      trackSender(event.sender);
      const requests = WorkspaceEntityLookupSchema.array().max(10_000).parse(candidates);
      return WorkspaceEntityResolutionSchema.array().parse(
        await getWorkspaceEntityRegistry().resolveEntities(requests)
      );
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_MIRROR_REGISTER_ENTITY,
    async (event, kind: WorkspaceEntityKind, path: string) => {
      trackSender(event.sender);
      const request = WorkspaceEntityLookupSchema.parse({ kind, path });
      return WorkspaceEntityReservationSchema.parse(
        await getWorkspaceEntityRegistry().registerEntity(request.kind, request.path)
      );
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_MIRROR_ADOPT_ENTITY,
    async (event, kind: WorkspaceEntityKind, entityId: string, path: string) => {
      trackSender(event.sender);
      const request = WorkspaceEntityLookupSchema.parse({ kind, path });
      const id = WorkspaceEntityIdSchema.parse(entityId);
      const registry = getWorkspaceEntityRegistry();
      let reservation: WorkspaceEntityReservation;
      try {
        reservation = await registry.adoptEntity(request.kind, id, request.path);
      } catch (error) {
        if (error instanceof WorkspaceEntityRegistryError && error.code.endsWith('_CONFLICT')) {
          return WorkspaceEntityAdoptionResultSchema.parse({
            ok: false,
            error: {
              code: 'ENTITY_ADOPTION_CONFLICT',
              message: error.message,
              conflictingEntityIds: adoptionConflictEntityIds(error),
            },
          });
        }
        throw error;
      }
      try {
        if (request.kind === 'repository') {
          await getWorkspaceMirrorService().upsertWorkspaceEntity({
            kind: 'repository',
            entityId: id,
            path: reservation.path,
          });
        } else {
          const worktree = getWorkspaceMirrorService().getSnapshot().catalog.worktrees[id];
          if (!worktree) throw new Error('Workspace worktree adoption requires an active entity');
          await getWorkspaceMirrorService().upsertWorkspaceEntity({
            kind: 'worktree',
            entityId: id,
            repositoryId: worktree.repositoryId,
            path: reservation.path,
            branch: worktree.branch,
          });
        }
      } catch (error) {
        registry.discardReservation(id);
        throw error;
      }
      const resolved = await registry.resolveEntity(request.kind, reservation.path);
      if (resolved.status !== 'resolved' || resolved.entityId !== id || !resolved.durable) {
        throw new Error('Workspace entity adoption did not commit atomically');
      }
      return WorkspaceEntityAdoptionResultSchema.parse({
        ok: true,
        reservation: WorkspaceEntityReservationSchema.parse({
          sceneId: resolved.sceneId,
          entityId: resolved.entityId,
          kind: resolved.kind,
          path: resolved.currentPath,
          normalizedPath: resolved.normalizedPath,
          disposition: reservation.disposition,
        }),
      });
    }
  );

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_MIRROR_COMPLETE_LEGACY_IMPORT, async (event) => {
    if (event.sender.id >= REMOTE_VIRTUAL_SENDER_ID_START) {
      throw new Error('Only the host renderer can complete workspace migration');
    }
    if (remoteClientManager.isAttached(event.sender.id)) {
      throw new Error(
        'Disconnect from the remote host before completing local workspace migration'
      );
    }
    await completeWorkspaceMirrorBootstrap((snapshot) =>
      todoService.finalizeWorkspaceMigration(snapshot)
    );
  });

  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_MIRROR_STAGE_RESOURCE,
    async (event, source: string | WorkspaceResourceUpload, mime?: string) => {
      trackSender(event.sender);
      const ownerId = actorIdentity(event.sender.id).clientId;
      if (typeof source === 'string') {
        if (event.sender.id >= REMOTE_VIRTUAL_SENDER_ID_START) {
          throw new Error('Remote clients must upload resource bytes, not host paths');
        }
        return getWorkspaceResourceService().stageFile(source, ownerId, mime);
      }
      const upload = WorkspaceResourceUploadSchema.parse(source);
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(upload.data)) {
        throw new Error('Workspace resource upload is not valid base64');
      }
      const data = Buffer.from(upload.data, 'base64');
      if (data.toString('base64') !== upload.data) {
        throw new Error('Workspace resource upload is not canonical base64');
      }
      return getWorkspaceResourceService().stageBuffer(
        data,
        upload.displayName,
        ownerId,
        upload.mime
      );
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_MIRROR_MATERIALIZE_RESOURCE,
    async (event, resourceId: string) => {
      trackSender(event.sender);
      const service = getWorkspaceResourceService();
      const requesterId = actorIdentity(event.sender.id).clientId;
      return event.sender.id >= REMOTE_VIRTUAL_SENDER_ID_START
        ? service.materializeForRemote(resourceId, requesterId)
        : service.materialize(resourceId, requesterId);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_MIRROR_FETCH_RESOURCE,
    async (event, resourceId: string) => {
      trackSender(event.sender);
      return getWorkspaceResourceService().fetch(
        resourceId,
        actorIdentity(event.sender.id).clientId
      );
    }
  );
}
