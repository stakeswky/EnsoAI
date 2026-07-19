import { isRemoteForwardedChannel } from '@shared/types';
import { type IpcMainInvokeEvent, ipcMain } from 'electron';
import { createRemoteCommandRegistry } from './remoteCommandRegistry';

/**
 * IPC handler registry + interceptor.
 *
 * Wraps `ipcMain.handle` so that:
 * 1. Explicitly approved V1 handlers are recorded in a separate remote
 *    command registry for host-side WebSocket dispatch.
 * 2. Handlers for remote-forwarded channels are wrapped: when the calling
 *    window is attached to a remote host, the invoke is forwarded over WS
 *    instead of executing locally.
 *
 * Must be installed BEFORE registerIpcHandlers().
 */

export type IpcHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

interface RemoteRouting {
  /** Whether this invoke should be routed to the attached remote host. */
  shouldForward: (senderId: number, channel: string) => boolean;
  /** Forward an invoke to the remote host */
  forward: (senderId: number, channel: string, args: unknown[]) => Promise<unknown>;
}

const remoteCommandHandlers = createRemoteCommandRegistry<IpcHandler>();
let routing: RemoteRouting | null = null;
let installed = false;

export function setRemoteRouting(r: RemoteRouting | null): void {
  routing = r;
}

/** Approved raw handler lookup, used by the host server to dispatch requests. */
export function getRegisteredHandler(channel: string): IpcHandler | undefined {
  return remoteCommandHandlers.lookup(channel);
}

export function installIpcInterceptor(): void {
  if (installed) {
    return;
  }
  installed = true;

  const originalHandle = ipcMain.handle.bind(ipcMain);
  const originalRemoveHandler = ipcMain.removeHandler.bind(ipcMain);

  ipcMain.handle = (channel: string, handler: IpcHandler): void => {
    remoteCommandHandlers.register(channel, handler);

    if (!isRemoteForwardedChannel(channel)) {
      originalHandle(channel, handler);
      return;
    }

    originalHandle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (routing?.shouldForward(event.sender.id, channel)) {
        return routing.forward(event.sender.id, channel, args);
      }
      return handler(event, ...args);
    });
  };

  ipcMain.removeHandler = (channel: string): void => {
    remoteCommandHandlers.remove(channel);
    originalRemoveHandler(channel);
  };
}
