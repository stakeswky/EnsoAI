import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  IPC_CHANNELS,
  REMOTE_TOKEN_HEADER,
  WORKSPACE_MIRROR_PROTOCOL_VERSION,
  WORKSPACE_MIRROR_SCHEMA_VERSION,
  WORKSPACE_MIRROR_SUBPROTOCOL,
  type WorkspaceMirrorV2Frame,
  type WorkspaceSceneSnapshot,
} from '@shared/types';
import type { WebContents } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { WorkspaceSnapshotAssembler } from '../workspaceMirrorFrames';

vi.mock('electron', () => ({
  app: { getVersion: () => 'test' },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: {
    handle: () => undefined,
    removeHandler: () => undefined,
  },
}));

interface FrameWaiter {
  predicate: (frame: Record<string, unknown>) => boolean;
  resolve: (frame: Record<string, unknown>) => void;
}

describe('Remote Workspace Mirror V2 WebSocket', () => {
  let temporaryDirectory: string | null = null;
  let stopServer: (() => Promise<void>) | null = null;
  let cleanupRuntime: (() => Promise<void>) | null = null;

  afterEach(async () => {
    await stopServer?.();
    await cleanupRuntime?.();
    if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
    stopServer = null;
    cleanupRuntime = null;
    temporaryDirectory = null;
  });

  it('negotiates, snapshots, grants control, and commits an ordered intent', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'enso-remote-mirror-'));
    const runtime = await import('../../workspace/workspaceMirrorRuntime');
    await runtime.initializeWorkspaceMirrorRuntime(temporaryDirectory);
    await runtime.completeWorkspaceMirrorBootstrap();
    cleanupRuntime = runtime.cleanupWorkspaceMirrorRuntime;

    const { RemoteHostServer } = await import('../RemoteHostServer');
    const server = new RemoteHostServer();
    stopServer = () => server.stop();
    const token = 'test-token-that-is-long-enough';
    const status = await server.start({
      enabled: true,
      port: 0,
      bind: 'localhost',
      token,
      mirrorV2Enabled: true,
    });
    expect(status.running).toBe(true);
    expect(status.port).toBeGreaterThan(0);

    const socket = new WebSocket(`ws://127.0.0.1:${status.port}/`, WORKSPACE_MIRROR_SUBPROTOCOL, {
      headers: { [REMOTE_TOKEN_HEADER]: token },
    });
    const frames: Record<string, unknown>[] = [];
    const waiters: FrameWaiter[] = [];
    socket.on('message', (raw) => {
      const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
      frames.push(frame);
      for (const waiter of [...waiters]) {
        if (!waiter.predicate(frame)) continue;
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(frame);
      }
    });
    const next = (predicate: FrameWaiter['predicate']): Promise<Record<string, unknown>> => {
      const existing = frames.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter: FrameWaiter = { predicate, resolve };
        waiters.push(waiter);
        setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error('timed out waiting for WebSocket frame'));
        }, 5_000);
      });
    };

    await new Promise<void>((resolve, reject) => {
      socket.once('open', () => resolve());
      socket.once('error', reject);
    });
    expect(socket.protocol).toBe(WORKSPACE_MIRROR_SUBPROTOCOL);
    const challenge = await next((frame) => frame.t === 'auth.challenge');
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const authProof = {
      t: 'auth.proof',
      deviceId: 'device-integration',
      nonce: challenge.nonce,
      signature: sign(null, Buffer.from(String(challenge.nonce)), privateKey).toString('base64'),
      publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    };
    socket.send(JSON.stringify(authProof));
    socket.send(
      JSON.stringify({
        t: 'clientHello',
        protocolVersions: [WORKSPACE_MIRROR_PROTOCOL_VERSION],
        schemaVersions: [WORKSPACE_MIRROR_SCHEMA_VERSION],
        deviceId: 'device-integration',
        clientId: 'client-integration',
        capabilities: ['scene.snapshot', 'scene.replay', 'scene.intent', 'control.lease'],
        resumeCursor: null,
      })
    );
    const hello = await next((frame) => frame.t === 'serverHello');
    expect(hello.bootstrapPhase).toBe('live');

    socket.send(
      JSON.stringify({
        t: 'state.subscribe',
        requestId: 'request-1',
        mode: 'snapshot',
        cursor: null,
      })
    );
    const begin = (await next((frame) => frame.t === 'state.snapshot.begin')) as Extract<
      WorkspaceMirrorV2Frame,
      { t: 'state.snapshot.begin' }
    >;
    const assembler = new WorkspaceSnapshotAssembler();
    assembler.start(begin);
    for (let index = 0; index < begin.totalChunks; index += 1) {
      assembler.add(
        (await next(
          (frame) => frame.t === 'state.snapshot.chunk' && frame.index === index
        )) as Extract<WorkspaceMirrorV2Frame, { t: 'state.snapshot.chunk' }>
      );
    }
    const snapshot = assembler.finish(
      (await next((frame) => frame.t === 'state.snapshot.end')) as Extract<
        WorkspaceMirrorV2Frame,
        { t: 'state.snapshot.end' }
      >
    );
    expect(snapshot.revision).toBe(0);

    socket.send(JSON.stringify({ t: 'control.request', requestId: 'control-1', knownCoordSeq: 0 }));
    await next((frame) => frame.t === 'control.granted');
    socket.send(
      JSON.stringify({
        t: 'state.intent',
        operationId: 'operation-1',
        clientSeq: 1,
        baseRevision: 0,
        kind: 'navigation.replace',
        payload: {
          navigation: { ...snapshot.navigation, activePrimaryPanel: 'terminal' },
        },
      })
    );
    const event = await next((frame) => frame.t === 'state.event' && frame.revision === 1);
    const result = await next(
      (frame) => frame.t === 'state.intentResult' && frame.operationId === 'operation-1'
    );
    expect(event.revision).toBe(1);
    expect(result).toMatchObject({ accepted: true, committedRevision: 1 });

    const replayClose = new Promise<number>((resolve) => {
      socket.once('close', (code) => resolve(code));
    });
    socket.send(JSON.stringify(authProof));
    await expect(replayClose).resolves.toBe(4401);
    const managedToken = 'managed-device-pairing-token';
    server.updateToken(managedToken);

    const { RemoteClientManager } = await import('../RemoteClientManager');
    const manager = new RemoteClientManager();
    let resolveClientSnapshot: (value: WorkspaceSceneSnapshot) => void = () => undefined;
    const clientSnapshot = new Promise<WorkspaceSceneSnapshot>((resolve) => {
      resolveClientSnapshot = resolve;
    });
    const webContents = {
      id: 42,
      isDestroyed: () => false,
      once: (_event: string, _handler: () => void) => {
        return webContents;
      },
      send: (channel: string, value: unknown) => {
        if (channel === IPC_CHANNELS.WORKSPACE_MIRROR_SNAPSHOT) {
          resolveClientSnapshot(value as WorkspaceSceneSnapshot);
        }
      },
    } as unknown as WebContents;
    const clientStatus = await manager.connect(webContents, {
      host: '127.0.0.1',
      port: status.port,
      token: managedToken,
      mirrorV2: true,
      clientId: 'managed-client',
      deviceId: 'managed-device',
    });
    expect(clientStatus.state).toBe('connected');
    await expect(clientSnapshot).resolves.toMatchObject({
      revision: 1,
      navigation: { activePrimaryPanel: 'terminal' },
    });
    expect(manager.getStatus(webContents.id)).toMatchObject({
      mirrorSyncPhase: 'live',
      mirrorRevision: 1,
      mirrorProtocol: 'v2',
    });
    const lease = await manager.forward(
      webContents.id,
      IPC_CHANNELS.WORKSPACE_MIRROR_REQUEST_CONTROL,
      []
    );
    expect(lease).toMatchObject({
      holderClientId: 'managed-client',
      holderDeviceId: 'managed-device',
    });
    const managedResult = await manager.forward(
      webContents.id,
      IPC_CHANNELS.WORKSPACE_MIRROR_DISPATCH_INTENT,
      [
        {
          t: 'state.intent',
          operationId: 'managed-operation',
          clientSeq: 1,
          baseRevision: 1,
          kind: 'navigation.replace',
          payload: {
            navigation: { ...snapshot.navigation, activePrimaryPanel: 'file' },
          },
        },
      ]
    );
    expect(managedResult).toMatchObject({ accepted: true, committedRevision: 2 });
    expect(manager.getStatus(webContents.id)).toMatchObject({
      mirrorRevision: 2,
      mirrorOwnsControl: true,
    });
    manager.disconnect(webContents.id);
  });
});
