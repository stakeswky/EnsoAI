import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  digestWorkspaceScene,
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
import { remoteMirrorDiagnosticsServer } from '../services/remote/RemoteMirrorDiagnosticsServer';
import { remoteMirrorMetrics } from '../services/remote/RemoteMirrorMetrics';
import { mimeForExtension, REMOTE_PREVIEW_MAX_BYTES } from '../services/remote/remoteFileFetch';
import {
  isExistingOrWorkspacePath,
  workspaceRootPaths,
} from '../services/workspace/WorkspacePathPolicy';
import {
  acknowledgeWorkspaceMirrorHandoff,
  configureWorkspaceMirrorLifecycleHooks,
  getWorkspaceMirrorLifecycleCoordinator,
  getWorkspaceMirrorService,
  runWorkspaceMirrorLifecycle,
} from '../services/workspace/workspaceMirrorRuntime';
import { stopFileWatchersForOwner } from './files';
import { readSettings, updateSettingsFromMain } from './settings';
import { destroyAllTerminalsAndWait } from './terminal';

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
    mirrorV2CanaryStage: stored.mirrorV2CanaryStage ?? 'disabled',
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

  configureWorkspaceMirrorLifecycleHooks({
    detachTransport: async () => {
      remoteHostServer.setMirrorV2Enabled(false, { skipVolatileGuard: true });
    },
    destroyRuntimes: async () => {
      await destroyAllTerminalsAndWait();
    },
    persistDisabled: async () => {
      const settings = { ...readRemoteHostSettings(), mirrorV2Enabled: false };
      persistRemoteHostSettings(settings);
    },
    releaseControllerLease: async () => {
      const service = getWorkspaceMirrorService();
      const lease = await service.getControllerLease();
      if (lease) {
        await service.revokeControl('host-revoked');
      }
    },
  });

  void maybeStartMirrorDiagnostics();

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
    const settings = readRemoteHostSettings();
    if (settings.mirrorV2Enabled) {
      const result = await runWorkspaceMirrorLifecycle('host-stop');
      if (!result.ok) {
        throw new Error(result.blockedBy ?? 'host stop blocked by live mirror lifecycle');
      }
    }
    const next = { ...settings, enabled: false };
    persistRemoteHostSettings(next);
    await remoteHostServer.stop();
    return idleStatus(next);
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
    if (!enabled) {
      const result = await runWorkspaceMirrorLifecycle('disable');
      if (!result.ok) {
        throw new Error(result.blockedBy ?? 'disable live mirror blocked');
      }
      const settings = { ...readRemoteHostSettings(), mirrorV2Enabled: false };
      return remoteHostServer.isRunning() ? remoteHostServer.getStatus() : idleStatus(settings);
    }
    const settings = { ...readRemoteHostSettings(), mirrorV2Enabled: true };
    remoteHostServer.setMirrorV2Enabled(true);
    getWorkspaceMirrorLifecycleCoordinator()
      .reEnable()
      .catch(() => undefined);
    persistRemoteHostSettings(settings);
    return remoteHostServer.isRunning() ? remoteHostServer.getStatus() : idleStatus(settings);
  });

  ipcMain.handle(
    'workspaceMirror:ackHandoff',
    async (_, payload: { ok: boolean; discard?: boolean; exportAcked?: boolean }) => {
      if (payload.discard) getWorkspaceMirrorLifecycleCoordinator().acknowledgeDiscard();
      if (payload.exportAcked) getWorkspaceMirrorLifecycleCoordinator().acknowledgeExport();
      acknowledgeWorkspaceMirrorHandoff(payload.ok);
      return true;
    }
  );

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
  const settings = readRemoteHostSettings();
  if (settings.mirrorV2Enabled) {
    const result = await runWorkspaceMirrorLifecycle('graceful-quit');
    if (!result.ok) {
      getWorkspaceMirrorLifecycleCoordinator().markForcedExitIncomplete('forced-exit-recovery');
    }
  }
  remoteClientManager.disposeAll();
  await remoteHostServer.stop();
  await remoteMirrorDiagnosticsServer.stop();
}

export function cleanupRemoteSync(): void {
  remoteClientManager.disposeAll();
  remoteHostServer.stopSync();
  void remoteMirrorDiagnosticsServer.stop();
}

async function maybeStartMirrorDiagnostics(): Promise<void> {
  try {
    if (app.isPackaged || process.env.ENSO_REMOTE_MIRROR_TEST !== '1') return;
    const preferredPort = Number(process.env.ENSO_REMOTE_MIRROR_DIAG_PORT || '0');
    const endpointFile =
      process.env.ENSO_REMOTE_MIRROR_ENDPOINT_FILE ||
      path.join(app.getPath('userData'), 'remote-mirror-diagnostics.json');
    await remoteMirrorDiagnosticsServer.start({
      isPackaged: app.isPackaged,
      testFlag: process.env.ENSO_REMOTE_MIRROR_TEST,
      preferredPort:
        Number.isFinite(preferredPort) && preferredPort > 0 ? preferredPort : undefined,
      endpointFile,
      fixedToken: process.env.ENSO_REMOTE_MIRROR_DIAG_TOKEN || undefined,
      handlers: {
        getHostDigest: async () => {
          const snapshot = getWorkspaceMirrorService().getSnapshot();
          return {
            revision: snapshot.revision,
            digest: await digestWorkspaceScene(snapshot),
            hostEpochDigest: createHash('sha256').update(snapshot.hostEpoch).digest('hex'),
          };
        },
        getClientDigest: async () => {
          const primary = remoteClientManager.getPrimaryRemoteSnapshot();
          if (!primary?.snapshot) {
            return {
              revision: null,
              digest: null,
              phase: primary?.status.mirrorSyncPhase ?? null,
              hostEpochDigest: null,
            };
          }
          return {
            revision: primary.snapshot.revision,
            digest: await digestWorkspaceScene(primary.snapshot),
            phase: primary.status.mirrorSyncPhase ?? null,
            hostEpochDigest: createHash('sha256').update(primary.snapshot.hostEpoch).digest('hex'),
          };
        },
        getMetrics: async () => {
          const sample = remoteMirrorMetrics.getSamples().at(-1);
          return {
            revision: sample?.revision ?? 0,
            queuedBytes: sample?.queuedBytes ?? 0,
            sockets: sample?.sockets ?? 0,
            phase: getWorkspaceMirrorLifecycleCoordinator().getPhase(),
          };
        },
        getLifecyclePhase: async () => getWorkspaceMirrorLifecycleCoordinator().getPhase(),
        listConnections: async () => {
          const host = remoteHostServer.getStatus();
          const clients = remoteClientManager.listConnectionStatuses();
          return [
            {
              connectionId: 'host',
              protocol: host.mirrorV2Enabled ? 'v2' : 'v1',
              deviceIdDigest: null,
            },
            ...clients.map((client, index) => ({
              connectionId: `client-${index}`,
              protocol: client.mirrorProtocol ?? 'unknown',
              deviceIdDigest: null,
            })),
          ];
        },
        getRemoteHostStatus: async () => {
          const status = remoteHostServer.isRunning()
            ? remoteHostServer.getStatus()
            : idleStatus(readRemoteHostSettings());
          return {
            running: status.running,
            port: status.port,
            bindAddress: status.bindAddress,
            clientCount: status.clientCount,
            mirrorV2Enabled: status.mirrorV2Enabled === true,
            hasToken: Boolean(status.token),
          };
        },
        getRemoteClientStatus: async () => {
          const primary = remoteClientManager.getPrimaryRemoteSnapshot();
          if (!primary) {
            return { state: 'disconnected', mirrorSyncPhase: null, mirrorRevision: null };
          }
          return {
            state: primary.status.state,
            mirrorSyncPhase: primary.status.mirrorSyncPhase ?? null,
            mirrorRevision: primary.status.mirrorRevision ?? null,
            mirrorProtocol: primary.status.mirrorProtocol ?? null,
            error: primary.status.error ?? null,
          };
        },
        dispatchUserAction: async (action) => dispatchDiagnosticsUserAction(action),
      },
    });
    console.log(
      `[remote] diagnostics listening endpointFile=${endpointFile} port=${remoteMirrorDiagnosticsServer.getStatus().port}`
    );
  } catch (error) {
    console.warn(
      '[remote] diagnostics server not started:',
      error instanceof Error ? error.message : error
    );
  }
}

async function dispatchDiagnosticsUserAction(action: {
  name: string;
  args: Record<string, unknown>;
}): Promise<unknown> {
  const { BrowserWindow } = await import('electron');
  const primaryWindow = BrowserWindow.getAllWindows().find((window) => !window.isDestroyed());

  switch (action.name) {
    case 'disableLiveMirror':
      return runWorkspaceMirrorLifecycle('disable');
    case 'stopRemoteHost':
      return runWorkspaceMirrorLifecycle('host-stop');
    case 'discardVolatileHandoff':
      getWorkspaceMirrorLifecycleCoordinator().acknowledgeDiscard();
      return { ok: true };
    case 'exportVolatileHandoff':
      getWorkspaceMirrorLifecycleCoordinator().acknowledgeExport();
      return { ok: true };
    case 'startRemoteHost': {
      const port =
        typeof action.args.port === 'number' && Number.isFinite(action.args.port)
          ? action.args.port
          : 0;
      const settings: RemoteHostSettings = {
        ...readRemoteHostSettings(),
        enabled: true,
        bind: 'localhost',
        port: port > 0 ? port : 0,
        mirrorV2Enabled: action.args.mirrorV2 === false ? false : true,
      };
      persistRemoteHostSettings(settings);
      const status = await remoteHostServer.start(settings);
      return {
        running: status.running,
        port: status.port,
        mirrorV2Enabled: status.mirrorV2Enabled === true,
        hasToken: Boolean(status.token),
        token: status.token,
      };
    }
    case 'enableMirrorV2': {
      const settings = { ...readRemoteHostSettings(), mirrorV2Enabled: true };
      remoteHostServer.setMirrorV2Enabled(true, { skipVolatileGuard: true });
      await getWorkspaceMirrorLifecycleCoordinator().reEnable();
      persistRemoteHostSettings(settings);
      return { ok: true, mirrorV2Enabled: true };
    }
    case 'disableMirrorV2':
      return runWorkspaceMirrorLifecycle('disable');
    case 'connectRemote': {
      if (!primaryWindow) throw new Error('no renderer window available for remote connect');
      const host = typeof action.args.host === 'string' ? action.args.host : '127.0.0.1';
      const port = typeof action.args.port === 'number' ? action.args.port : 0;
      const token = typeof action.args.token === 'string' ? action.args.token : '';
      if (!port || !token) throw new Error('connectRemote requires port and token');
      const deviceId = typeof action.args.deviceId === 'string' ? action.args.deviceId : undefined;
      const identity = await getRemoteDeviceIdentityStore().loadOrCreate(
        deviceId ?? defaultRemoteDeviceId()
      );
      const status = await remoteClientManager.connect(
        primaryWindow.webContents,
        {
          host,
          port,
          token,
          deviceId: identity.deviceId,
          mirrorV2: true,
        },
        identity
      );
      return {
        state: status.state,
        mirrorSyncPhase: status.mirrorSyncPhase ?? null,
        mirrorRevision: status.mirrorRevision ?? null,
        error: status.error ?? null,
      };
    }
    case 'disconnectRemote': {
      if (!primaryWindow) return { ok: true };
      remoteClientManager.disconnect(primaryWindow.webContents.id);
      return { ok: true };
    }
    case 'seedMinimalScene': {
      const service = getWorkspaceMirrorService();
      if (!service.isBootstrapReady()) {
        await service.completeBootstrapAfter(async () => undefined);
      }
      const control = await service.requestControl({
        clientId: 'diagnostics-host',
        deviceId: 'diagnostics-host-device',
      });
      if (!control.granted) {
        throw new Error(control.error?.message ?? 'failed to obtain host control for seed');
      }
      const actor = {
        clientId: 'diagnostics-host',
        deviceId: 'diagnostics-host-device',
        leaseId: control.lease.leaseId,
      };
      const seedPath =
        typeof action.args.repositoryPath === 'string'
          ? action.args.repositoryPath
          : path.join(app.getPath('temp'), 'enso-mirror-e2e-repo');
      await fs.promises.mkdir(seedPath, { recursive: true });
      const result = await service.dispatchIntent(
        {
          t: 'state.intent',
          operationId: `seed-${Date.now()}`,
          clientSeq: 1,
          baseRevision: service.getSnapshot().revision,
          kind: 'catalog.replace',
          payload: {
            catalog: {
              groups: {
                'group-e2e': {
                  id: 'group-e2e',
                  name: 'E2E',
                  emoji: '',
                  color: '#3b82f6',
                  order: 0,
                },
              },
              repositories: {
                'repo-e2e': {
                  id: 'repo-e2e',
                  path: seedPath,
                  name: 'e2e-repo',
                  groupId: 'group-e2e',
                  order: 0,
                  settings: { autoInitWorktree: false, initScript: '', hidden: false },
                },
              },
              worktrees: {
                'worktree-e2e': {
                  id: 'worktree-e2e',
                  repositoryId: 'repo-e2e',
                  path: seedPath,
                  name: 'main',
                  branch: 'main',
                  order: 0,
                  isMain: true,
                },
              },
            },
          },
        },
        actor
      );
      return {
        ok: result.accepted,
        revision: service.getSnapshot().revision,
        rejected: result.accepted ? null : result.error.code,
      };
    }
    case 'awaitReady': {
      const timeoutMs = typeof action.args.timeoutMs === 'number' ? action.args.timeoutMs : 15_000;
      const started = Date.now();
      while (Date.now() - started < timeoutMs) {
        if (BrowserWindow.getAllWindows().some((window) => !window.isDestroyed())) {
          return { ok: true, ready: true };
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return { ok: false, ready: false };
    }
    case 'requestControl': {
      const service = getWorkspaceMirrorService();
      return service.requestControl({
        clientId: 'diagnostics-host',
        deviceId: 'diagnostics-host-device',
      });
    }
    default:
      return { ok: false, error: `action-not-implemented:${action.name}` };
  }
}
