import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  IPC_CHANNELS,
  REMOTE_DEFAULT_PORT,
  REMOTE_FS_READ_FILE_CHANNEL,
  type RemoteConnectOptions,
  type RemoteFileReadResult,
  type RemoteHostSettings,
  type RemoteHostStatus,
} from '@shared/types';
import { ipcMain } from 'electron';
import { setRemoteRouting } from '../services/remote/handlerRegistry';
import { remoteClientManager } from '../services/remote/RemoteClientManager';
import {
  detectTailscaleAddress,
  generateRemoteToken,
  remoteHostServer,
} from '../services/remote/RemoteHostServer';
import { mimeForExtension, REMOTE_PREVIEW_MAX_BYTES } from '../services/remote/remoteFileFetch';
import { readSettings, updateSettingsFromMain } from './settings';

function readRemoteHostSettings(): RemoteHostSettings {
  const stored = (readSettings()?.remoteHost ?? {}) as Partial<RemoteHostSettings>;
  const settings: RemoteHostSettings = {
    enabled: stored.enabled ?? false,
    port: stored.port ?? REMOTE_DEFAULT_PORT,
    bind: stored.bind ?? 'tailscale',
    token: stored.token || generateRemoteToken(),
  };
  if (!stored.token) {
    updateSettingsFromMain({ remoteHost: settings });
  }
  return settings;
}

function persistRemoteHostSettings(settings: RemoteHostSettings): void {
  updateSettingsFromMain({ remoteHost: settings });
}

function idleStatus(settings: RemoteHostSettings): RemoteHostStatus {
  return {
    running: false,
    port: settings.port,
    bindAddress: null,
    tailscaleAddress: detectTailscaleAddress(),
    token: settings.token,
    clientCount: 0,
  };
}

export function registerRemoteHandlers(): void {
  // Wire the IPC interceptor to the client manager: while a window is
  // attached to a remote host, whitelisted invokes are forwarded over WS.
  setRemoteRouting({
    isAttached: (senderId) => remoteClientManager.isAttached(senderId),
    forward: (senderId, channel, args) => remoteClientManager.forward(senderId, channel, args),
  });

  // --- Host side ---
  ipcMain.handle(
    IPC_CHANNELS.REMOTE_HOST_START,
    async (_, config?: Partial<Pick<RemoteHostSettings, 'port' | 'bind'>>) => {
      const settings: RemoteHostSettings = {
        ...readRemoteHostSettings(),
        ...config,
        enabled: true,
      };
      persistRemoteHostSettings(settings);
      return remoteHostServer.start(settings);
    }
  );

  ipcMain.handle(IPC_CHANNELS.REMOTE_HOST_STOP, async () => {
    const settings = { ...readRemoteHostSettings(), enabled: false };
    persistRemoteHostSettings(settings);
    await remoteHostServer.stop();
    return idleStatus(settings);
  });

  ipcMain.handle(IPC_CHANNELS.REMOTE_HOST_GET_STATUS, async () => {
    if (remoteHostServer.isRunning()) {
      return remoteHostServer.getStatus();
    }
    return idleStatus(readRemoteHostSettings());
  });

  ipcMain.handle(IPC_CHANNELS.REMOTE_HOST_REGENERATE_TOKEN, async () => {
    const settings = { ...readRemoteHostSettings(), token: generateRemoteToken() };
    persistRemoteHostSettings(settings);
    remoteHostServer.updateToken(settings.token);
    if (remoteHostServer.isRunning()) {
      return remoteHostServer.getStatus();
    }
    return idleStatus(settings);
  });

  // --- Host side: preview bytes for remote clients (WS-only channel) ---
  // Registered as a normal handler so it lands in the handler registry and
  // can be dispatched by RemoteHostServer; never invoked via renderer IPC.
  ipcMain.handle(
    REMOTE_FS_READ_FILE_CHANNEL,
    async (_, filePath: string): Promise<RemoteFileReadResult> => {
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile()) {
        throw new Error('not a file');
      }
      if (stat.size > REMOTE_PREVIEW_MAX_BYTES) {
        throw new Error('file too large for remote preview');
      }
      const buf = await fs.promises.readFile(filePath);
      return {
        data: buf.toString('base64'),
        mime: mimeForExtension(path.extname(filePath)),
        size: stat.size,
      };
    }
  );

  // --- Client side ---
  ipcMain.handle(IPC_CHANNELS.REMOTE_CONNECT, async (event, options: RemoteConnectOptions) => {
    return remoteClientManager.connect(event.sender, options);
  });

  ipcMain.handle(IPC_CHANNELS.REMOTE_DISCONNECT, async (event) => {
    remoteClientManager.disconnect(event.sender.id);
  });

  ipcMain.handle(IPC_CHANNELS.REMOTE_GET_STATUS, async (event) => {
    return remoteClientManager.getStatus(event.sender.id);
  });
}

/** Auto-start the host server on boot when enabled in settings */
export async function autoStartRemoteHost(): Promise<void> {
  const settings = readRemoteHostSettings();
  if (settings.enabled) {
    await remoteHostServer.start(settings);
  }
}

export async function cleanupRemote(): Promise<void> {
  remoteClientManager.disposeAll();
  await remoteHostServer.stop();
}

export function cleanupRemoteSync(): void {
  remoteClientManager.disposeAll();
  remoteHostServer.stopSync();
}
