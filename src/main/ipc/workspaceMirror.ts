import {
  IPC_CHANNELS,
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
import type { WorkspaceIntentActor } from '../services/workspace/WorkspaceMirrorService';
import {
  completeWorkspaceMirrorBootstrap,
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

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_MIRROR_REQUEST_CONTROL, async (event) => {
    trackSender(event.sender);
    let result = await service.requestControl(actorIdentity(event.sender.id));
    if (!result.granted && event.sender.id >= REMOTE_VIRTUAL_SENDER_ID_START) {
      await service.revokeControl('host-revoked');
      result = await service.requestControl(actorIdentity(event.sender.id));
    }
    if (!result.granted) {
      throw new Error(result.error.message);
    }
    return result.lease;
  });

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_MIRROR_RELEASE_CONTROL, async (event) => {
    trackSender(event.sender);
    const error = await service.releaseControl(await actorForEvent(event));
    if (error) {
      throw new Error(error.message);
    }
  });

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
