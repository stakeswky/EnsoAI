import { isRemoteForwardedChannel } from '@shared/types';
import { type IpcMainInvokeEvent, ipcMain } from 'electron';

/**
 * IPC handler registry + interceptor.
 *
 * Wraps `ipcMain.handle` so that:
 * 1. Every registered handler is recorded in a registry. The host-side
 *    RemoteHostServer dispatches incoming WS requests to these raw handlers.
 * 2. Handlers for remote-forwarded channels are wrapped: when the calling
 *    window is attached to a remote host, the invoke is forwarded over WS
 *    instead of executing locally.
 *
 * Must be installed BEFORE registerIpcHandlers().
 */

export type IpcHandler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

interface RemoteRouting {
  /** Whether this webContents is attached to a remote host */
  isAttached: (senderId: number) => boolean;
  /** Forward an invoke to the remote host */
  forward: (senderId: number, channel: string, args: unknown[]) => Promise<unknown>;
}

const registeredHandlers = new Map<string, IpcHandler>();
let routing: RemoteRouting | null = null;
let installed = false;

export function setRemoteRouting(r: RemoteRouting | null): void {
  routing = r;
}

/** Raw (unwrapped) handler lookup, used by the host server to dispatch requests */
export function getRegisteredHandler(channel: string): IpcHandler | undefined {
  return registeredHandlers.get(channel);
}

export function installIpcInterceptor(): void {
  if (installed) {
    return;
  }
  installed = true;

  const originalHandle = ipcMain.handle.bind(ipcMain);
  const originalRemoveHandler = ipcMain.removeHandler.bind(ipcMain);

  ipcMain.handle = (channel: string, handler: IpcHandler): void => {
    registeredHandlers.set(channel, handler);

    if (!isRemoteForwardedChannel(channel)) {
      originalHandle(channel, handler);
      return;
    }

    originalHandle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (routing?.isAttached(event.sender.id)) {
        return routing.forward(event.sender.id, channel, args);
      }
      return handler(event, ...args);
    });
  };

  ipcMain.removeHandler = (channel: string): void => {
    registeredHandlers.delete(channel);
    originalRemoveHandler(channel);
  };
}
