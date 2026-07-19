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

    const { ipcMain } = await import('electron');
    const { installIpcInterceptor } = await import('../handlerRegistry');
    installIpcInterceptor();
    const { registerWorkspaceMirrorHandlers } = await import('../../../ipc/workspaceMirror');
    registerWorkspaceMirrorHandlers();
    const terminalCreateHandler = vi.fn(
      async (_event: unknown, _options: unknown) => 'pty-command-test'
    );
    const watchStartHandler = vi.fn(async () => undefined);
    const watchStopHandler = vi.fn(async () => undefined);
    const genericMutationHandler = vi.fn(async () => undefined);
    const forbiddenMutationHandler = vi.fn(async () => undefined);
    ipcMain.handle(IPC_CHANNELS.TERMINAL_CREATE, terminalCreateHandler);
    ipcMain.handle(IPC_CHANNELS.FILE_WATCH_START, watchStartHandler);
    ipcMain.handle(IPC_CHANNELS.FILE_WATCH_STOP, watchStopHandler);
    ipcMain.handle(IPC_CHANNELS.FILE_CREATE_DIR, genericMutationHandler);
    ipcMain.handle(IPC_CHANNELS.TODO_ADD_TASK, forbiddenMutationHandler);

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

    const legacySocket = new WebSocket(`ws://127.0.0.1:${status.port}/`, {
      headers: { [REMOTE_TOKEN_HEADER]: token },
    });
    const legacyError = new Promise<Record<string, unknown>>((resolve, reject) => {
      legacySocket.once('message', (raw) => resolve(JSON.parse(raw.toString())));
      legacySocket.once('error', reject);
    });
    const legacyClose = new Promise<void>((resolve) => {
      legacySocket.once('close', () => resolve());
    });
    await expect(legacyError).resolves.toMatchObject({
      t: 'protocol.error',
      code: 'UPGRADE_REQUIRED',
    });
    await legacyClose;

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
          reject(
            new Error(
              `timed out waiting for WebSocket frame; recent frames: ${JSON.stringify(frames.slice(-5))}`
            )
          );
        }, 3_000);
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
        capabilities: [
          'scene.snapshot',
          'scene.replay',
          'scene.intent',
          'command.execute',
          'control.lease',
          'terminal.stream',
        ],
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
        kind: 'scene.replace',
        payload: {
          catalog: {
            groups: {},
            repositories: {
              'repo-integration': {
                id: 'repo-integration',
                path: temporaryDirectory,
                name: 'integration',
                groupId: null,
                order: 0,
                settings: { autoInitWorktree: false, initScript: '', hidden: false },
              },
            },
            worktrees: {},
          },
          navigation: { ...snapshot.navigation, activePrimaryPanel: 'terminal' },
          editors: snapshot.editors,
          agents: snapshot.agents,
          terminals: snapshot.terminals,
          todos: snapshot.todos,
          selections: snapshot.selections,
        },
      })
    );
    const event = await next((frame) => frame.t === 'state.event' && frame.revision === 1);
    const result = await next(
      (frame) => frame.t === 'state.intentResult' && frame.operationId === 'operation-1'
    );
    expect(event.revision).toBe(1);
    expect(result).toMatchObject({ accepted: true, committedRevision: 1 });

    socket.send(
      JSON.stringify({
        t: 'req',
        id: 901,
        ch: IPC_CHANNELS.FILE_CREATE_DIR,
        args: [join(temporaryDirectory, 'legacy-write')],
      })
    );
    await expect(next((frame) => frame.t === 'res' && frame.id === 901)).resolves.toMatchObject({
      ok: false,
      error: 'use command.execute for durable workspace commands',
    });
    socket.send(
      JSON.stringify({
        t: 'req',
        id: 902,
        ch: IPC_CHANNELS.TODO_ADD_TASK,
        args: [temporaryDirectory, { title: 'forbidden' }],
      })
    );
    await expect(next((frame) => frame.t === 'res' && frame.id === 902)).resolves.toMatchObject({
      ok: false,
      error: 'channel is not available in workspace mirror V2',
    });
    expect(genericMutationHandler).not.toHaveBeenCalled();
    expect(forbiddenMutationHandler).not.toHaveBeenCalled();

    const { REMOTE_COMMAND_MANIFEST } = await import('../remoteCommandManifest');
    const nonCompatibilityRoutes = Object.values(REMOTE_COMMAND_MANIFEST).filter(
      (descriptor) => descriptor.route !== 'read-only'
    );
    for (const [index, descriptor] of nonCompatibilityRoutes.entries()) {
      const id = 1_000 + index;
      socket.send(JSON.stringify({ t: 'req', id, ch: descriptor.channel, args: [] }));
      const expectedError =
        descriptor.route === 'durable-command'
          ? 'use command.execute'
          : descriptor.route === 'stream/coordination'
            ? 'coordination plane'
            : 'not available in workspace mirror V2';
      await expect(next((frame) => frame.t === 'res' && frame.id === id)).resolves.toMatchObject({
        ok: false,
        error: expect.stringContaining(expectedError),
      });
    }
    expect(genericMutationHandler).not.toHaveBeenCalled();
    expect(forbiddenMutationHandler).not.toHaveBeenCalled();

    const { digestWorkspaceCommandRequest, WORKSPACE_COMMAND_VERSION } = await import(
      '../../workspace/WorkspaceCommandRegistry'
    );
    const commandArgs = [
      {
        cwd: temporaryDirectory,
        title: 'first',
        sessionId: 'terminal-durable-command-1',
        persistent: true,
      },
    ];
    const command = {
      t: 'command.execute',
      operationId: 'durable-command-1',
      clientSeq: 2,
      command: IPC_CHANNELS.TERMINAL_CREATE,
      commandVersion: WORKSPACE_COMMAND_VERSION,
      requestDigest: digestWorkspaceCommandRequest(
        IPC_CHANNELS.TERMINAL_CREATE,
        WORKSPACE_COMMAND_VERSION,
        commandArgs
      ),
      args: commandArgs,
    } as const;
    socket.send(JSON.stringify(command));
    await expect(
      next(
        (frame) =>
          frame.t === 'command.result' &&
          frame.operationId === command.operationId &&
          frame.resultExpired === false
      )
    ).resolves.toMatchObject({ state: 'committed', result: 'pty-command-test' });
    socket.send(JSON.stringify(command));
    await expect(
      next(
        (frame) =>
          frame.t === 'command.result' &&
          frame.operationId === command.operationId &&
          frame.resultExpired === false
      )
    ).resolves.toMatchObject({ state: 'committed', result: 'pty-command-test' });
    expect(terminalCreateHandler).toHaveBeenCalledTimes(1);

    const conflictingArgs = [
      {
        cwd: temporaryDirectory,
        title: 'different',
        sessionId: 'terminal-durable-command-1',
        persistent: true,
      },
    ];
    socket.send(
      JSON.stringify({
        ...command,
        requestDigest: digestWorkspaceCommandRequest(
          command.command,
          command.commandVersion,
          conflictingArgs
        ),
        args: conflictingArgs,
      })
    );
    await expect(
      next(
        (frame) =>
          frame.t === 'command.result' &&
          frame.operationId === command.operationId &&
          (frame.error as { code?: unknown } | undefined)?.code === 'CONFLICT'
      )
    ).resolves.toMatchObject({ state: 'failed' });
    expect(terminalCreateHandler).toHaveBeenCalledTimes(1);

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
    await expect(
      manager.forward(webContents.id, IPC_CHANNELS.WORKSPACE_MIRROR_RESOLVE_ENTITIES, [
        [{ kind: 'repository', path: temporaryDirectory }],
      ])
    ).resolves.toMatchObject([
      { status: 'resolved', entityId: 'repo-integration', match: 'current' },
    ]);
    const reservedWorktreePath = join(temporaryDirectory, 'reserved-worktree');
    const reservation = await manager.forward(
      webContents.id,
      IPC_CHANNELS.WORKSPACE_MIRROR_REGISTER_ENTITY,
      ['worktree', reservedWorktreePath]
    );
    expect(reservation).toMatchObject({
      kind: 'worktree',
      path: reservedWorktreePath,
      disposition: 'new',
    });
    await expect(
      manager.forward(webContents.id, IPC_CHANNELS.WORKSPACE_MIRROR_RESOLVE_ENTITIES, [
        [{ kind: 'worktree', path: reservedWorktreePath }],
      ])
    ).resolves.toMatchObject([{ status: 'resolved', match: 'reservation', durable: true }]);
    await expect(
      manager.forward(webContents.id, IPC_CHANNELS.TERMINAL_CREATE, [
        { cwd: temporaryDirectory, title: 'managed' },
      ])
    ).resolves.toBe('remote:pty-command-test');
    expect(terminalCreateHandler).toHaveBeenCalledTimes(2);
    expect(terminalCreateHandler.mock.calls[1]?.[1]).toMatchObject({
      cwd: temporaryDirectory,
      title: 'managed',
      sessionId: expect.stringMatching(/^terminal-[0-9a-f-]{36}$/),
      persistent: true,
    });
    await expect(
      manager.forward(webContents.id, IPC_CHANNELS.FILE_WATCH_START, [temporaryDirectory])
    ).resolves.toBeUndefined();
    await expect(
      manager.forward(webContents.id, IPC_CHANNELS.FILE_WATCH_STOP, [temporaryDirectory])
    ).resolves.toBeUndefined();
    expect(watchStartHandler).toHaveBeenCalledTimes(1);
    expect(watchStopHandler).toHaveBeenCalledTimes(1);
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
