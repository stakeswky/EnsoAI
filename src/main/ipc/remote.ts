import { createHash } from 'node:crypto';
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
import { app, ipcMain, safeStorage } from 'electron';
import { setRemoteRouting } from '../services/remote/handlerRegistry';
import { remoteClientManager } from '../services/remote/RemoteClientManager';
import { RemoteCredentialStore } from '../services/remote/RemoteCredentialStore';
import { RemoteDeviceIdentityStore } from '../services/remote/RemoteDeviceIdentityStore';
import {
  detectTailscaleAddress,
  generateRemoteToken,
  remoteHostServer,
} from '../services/remote/RemoteHostServer';
import { mimeForExtension, REMOTE_PREVIEW_MAX_BYTES } from '../services/remote/remoteFileFetch';
import {
  isExistingOrWorkspacePath,
  workspaceRootPaths,
} from '../services/workspace/WorkspacePathPolicy';
import { getWorkspaceMirrorService } from '../services/workspace/workspaceMirrorRuntime';
import { stopFileWatchersForOwner } from './files';
import { readSettings, updateSettingsFromMain } from './settings';

let remoteCredentialStore: RemoteCredentialStore | null = null;
let remoteDeviceIdentityStore: RemoteDeviceIdentityStore | null = null;

function getRemoteCredentialStore(): RemoteCredentialStore {
  remoteCredentialStore ??= new RemoteCredentialStore(
    path.join(app.getPath('userData'), 'remote-credentials.json'),
    {
      isAvailable: () => safeStorage.isEncryptionAvailable(),
      encrypt: (value) => safeStorage.encryptString(value),
      decrypt: (value) => safeStorage.decryptString(value),
    }
  );
  return remoteCredentialStore;
}

function getRemoteDeviceIdentityStore(): RemoteDeviceIdentityStore {
  remoteDeviceIdentityStore ??= new RemoteDeviceIdentityStore(
    path.join(app.getPath('userData'), 'remote-device-identities.json'),
    {
      isAvailable: () => safeStorage.isEncryptionAvailable(),
      encrypt: (value) => safeStorage.encryptString(value),
      decrypt: (value) => safeStorage.decryptString(value),
    }
  );
  return remoteDeviceIdentityStore;
}

function defaultRemoteDeviceId(): string {
  return `device-${createHash('sha256')
    .update(app.getPath('userData'))
    .digest('hex')
    .slice(0, 24)}`;
}

function decryptHostToken(stored: string | undefined): string | null {
  if (!stored) return null;
  if (!stored.startsWith('enc:')) return stored;
  if (!safeStorage.isEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'));
  } catch {
    return null;
  }
}

function encryptHostToken(token: string): string {
  // Keep the legacy plaintext token when safeStorage is unavailable so a
  // host does not silently rotate credentials on every startup. V2 device
  // private keys still fail closed without safeStorage.
  if (!safeStorage.isEncryptionAvailable()) return token;
  return `enc:${safeStorage.encryptString(token).toString('base64')}`;
}

function readRemoteHostSettings(): RemoteHostSettings {
  const stored = (readSettings()?.remoteHost ?? {}) as Partial<RemoteHostSettings>;
  const decryptedToken = decryptHostToken(stored.token);
  const settings: RemoteHostSettings = {
    enabled: stored.enabled ?? false,
    port: stored.port ?? REMOTE_DEFAULT_PORT,
    bind: stored.bind ?? 'tailscale',
    token: decryptedToken || generateRemoteToken(),
    mirrorV2Enabled: stored.mirrorV2Enabled ?? false,
  };
  if (!stored.token || !stored.token.startsWith('enc:')) {
    persistRemoteHostSettings(settings);
  }
  return settings;
}

function persistRemoteHostSettings(settings: RemoteHostSettings): void {
  updateSettingsFromMain({
    remoteHost: { ...settings, token: encryptHostToken(settings.token) },
  });
}

function idleStatus(settings: RemoteHostSettings): RemoteHostStatus {
  return {
    running: false,
    port: settings.port,
    bindAddress: null,
    tailscaleAddress: detectTailscaleAddress(),
    token: settings.token,
    clientCount: 0,
    mirrorV2Enabled: settings.mirrorV2Enabled ?? false,
  };
}

export function registerRemoteHandlers(): void {
  // Wire the IPC interceptor to the client manager: while a window is
  // attached to a remote host, whitelisted invokes are forwarded over WS.
  setRemoteRouting({
    shouldForward: (senderId, channel) => remoteClientManager.shouldForward(senderId, channel),
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

  ipcMain.handle(IPC_CHANNELS.REMOTE_HOST_LIST_PAIRED_DEVICES, async () => {
    return remoteHostServer.listPairedDevices();
  });

  ipcMain.handle(IPC_CHANNELS.REMOTE_HOST_REVOKE_PAIRED_DEVICE, async (_, deviceId: string) => {
    const revoked = await remoteHostServer.revokePairedDevice(deviceId);
    if (!revoked) return false;

    // V1 has no device-bound credential. Rotate its shared token as part of
    // device revocation so the revoked device cannot reconnect through the
    // compatibility transport with a previously stored token.
    const settings = { ...readRemoteHostSettings(), token: generateRemoteToken() };
    persistRemoteHostSettings(settings);
    remoteHostServer.updateToken(settings.token);
    return true;
  });

  ipcMain.handle(IPC_CHANNELS.REMOTE_HOST_SET_MIRROR_V2_ENABLED, async (_, enabled: boolean) => {
    const settings = { ...readRemoteHostSettings(), mirrorV2Enabled: enabled };
    remoteHostServer.setMirrorV2Enabled(enabled);
    persistRemoteHostSettings(settings);
    return remoteHostServer.isRunning() ? remoteHostServer.getStatus() : idleStatus(settings);
  });

  // --- Host side: preview bytes for remote clients (WS-only channel) ---
  // Registered as a normal handler so it lands in the handler registry and
  // can be dispatched by RemoteHostServer; never invoked via renderer IPC.
  ipcMain.handle(
    REMOTE_FS_READ_FILE_CHANNEL,
    async (_, filePath: string): Promise<RemoteFileReadResult> => {
      if (typeof filePath !== 'string' || !filePath.trim()) {
        throw new Error('invalid preview path');
      }
      const snapshot = getWorkspaceMirrorService().getSnapshot();
      if (!(await isExistingOrWorkspacePath(filePath, workspaceRootPaths(snapshot)))) {
        throw new Error('preview path is outside the workspace');
      }
      const canonicalPath = await fs.promises.realpath(filePath);
      const stat = await fs.promises.stat(canonicalPath);
      if (!stat.isFile()) {
        throw new Error('not a file');
      }
      if (stat.size > REMOTE_PREVIEW_MAX_BYTES) {
        throw new Error('file too large for remote preview');
      }
      const buf = await fs.promises.readFile(canonicalPath);
      return {
        data: buf.toString('base64'),
        mime: mimeForExtension(path.extname(canonicalPath)),
        size: stat.size,
      };
    }
  );

  // --- Client side ---
  ipcMain.handle(IPC_CHANNELS.REMOTE_CONNECT, async (event, options: RemoteConnectOptions) => {
    const credentials = getRemoteCredentialStore();
    const token = options.token.trim() || (await credentials.load(options.host, options.port));
    if (!token) {
      throw new Error('pairing token is required');
    }
    const deviceId = options.deviceId ?? defaultRemoteDeviceId();
    const resolved = { ...options, deviceId, token };
    const identity =
      options.mirrorV2 === false
        ? undefined
        : await getRemoteDeviceIdentityStore().loadOrCreate(deviceId);
    await stopFileWatchersForOwner(event.sender.id);
    const status = await remoteClientManager.connect(event.sender, resolved, identity);
    if (status.state === 'connected') {
      await credentials.save(options.host, options.port, token);
    }
    return status;
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
