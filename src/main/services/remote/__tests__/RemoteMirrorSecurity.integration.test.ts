import { generateKeyPairSync, type KeyObject, sign } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createEmptyWorkspaceSceneSnapshot,
  IPC_CHANNELS,
  REMOTE_FS_READ_FILE_CHANNEL,
  REMOTE_TOKEN_HEADER,
  WORKSPACE_MIRROR_PROTOCOL_VERSION,
  WORKSPACE_MIRROR_SCHEMA_VERSION,
  WORKSPACE_MIRROR_SUBPROTOCOL,
  type WorkspaceMirrorCapability,
} from '@shared/types';
import type { WebContents } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { RemotePairedDeviceStore } from '../RemotePairedDeviceStore';

vi.mock('electron', () => ({
  app: {
    getVersion: () => 'test',
    getPath: () => {
      throw new Error('No Electron userData path in integration tests');
    },
  },
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: {
    handle: () => undefined,
    removeHandler: () => undefined,
  },
}));

interface FrameWaiter {
  predicate: (frame: Record<string, unknown>) => boolean;
  resolve: (frame: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface FrameCollector {
  next: (
    predicate: FrameWaiter['predicate'],
    timeoutMs?: number
  ) => Promise<Record<string, unknown>>;
}

interface TestWebContents extends WebContents {
  sentFrames: Array<{ channel: string; payload: unknown[] }>;
}

const TEST_TOKEN = 'remote-mirror-security-test-token';
let temporaryDirectory: string | null = null;
let activeServer: import('../RemoteHostServer').RemoteHostServer | null = null;
let cleanupRuntime: (() => Promise<void>) | null = null;
const sockets: WebSocket[] = [];
const clientCleanups: Array<() => void> = [];

function collectFrames(socket: WebSocket): FrameCollector {
  const frames: Record<string, unknown>[] = [];
  const waiters: FrameWaiter[] = [];
  socket.on('message', (raw) => {
    const frame = JSON.parse(raw.toString()) as Record<string, unknown>;
    const waiterIndex = waiters.findIndex((waiter) => waiter.predicate(frame));
    if (waiterIndex < 0) {
      frames.push(frame);
      return;
    }
    const [waiter] = waiters.splice(waiterIndex, 1);
    clearTimeout(waiter!.timer);
    waiter!.resolve(frame);
  });
  return {
    next(predicate, timeoutMs = 5_000) {
      const frameIndex = frames.findIndex(predicate);
      if (frameIndex >= 0) return Promise.resolve(frames.splice(frameIndex, 1)[0]!);
      return new Promise((resolve, reject) => {
        const waiter = {
          predicate,
          resolve,
          reject,
          timer: setTimeout(() => {
            const waiterIndex = waiters.indexOf(waiter);
            if (waiterIndex >= 0) waiters.splice(waiterIndex, 1);
            reject(new Error('timed out waiting for WebSocket frame'));
          }, timeoutMs),
        } satisfies FrameWaiter;
        waiters.push(waiter);
      });
    },
  };
}

function createWebContents(id: number): TestWebContents {
  const sentFrames: TestWebContents['sentFrames'] = [];
  const webContents = {
    id,
    sentFrames,
    isDestroyed: () => false,
    once: () => webContents,
    send: (channel: string, ...payload: unknown[]) => {
      sentFrames.push({ channel, payload });
    },
  } as unknown as TestWebContents;
  return webContents;
}

async function startHost(options?: {
  bootstrapReady?: boolean;
  mirrorV2Enabled?: boolean;
  deviceStore?: RemotePairedDeviceStore;
}) {
  temporaryDirectory ??= await mkdtemp(join(tmpdir(), 'enso-remote-security-'));
  const runtime = await import('../../workspace/workspaceMirrorRuntime');
  await runtime.initializeWorkspaceMirrorRuntime(temporaryDirectory);
  if (options?.bootstrapReady !== false) await runtime.completeWorkspaceMirrorBootstrap();
  cleanupRuntime = runtime.cleanupWorkspaceMirrorRuntime;

  const { RemoteHostServer } = await import('../RemoteHostServer');
  const server = new RemoteHostServer(options?.deviceStore);
  activeServer = server;
  const status = await server.start({
    enabled: true,
    port: 0,
    bind: 'localhost',
    token: TEST_TOKEN,
    mirrorV2Enabled: options?.mirrorV2Enabled ?? true,
  });
  expect(status.running).toBe(true);
  return { runtime, server, status };
}

function openV2Socket(port: number): { socket: WebSocket; frames: FrameCollector } {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/`, WORKSPACE_MIRROR_SUBPROTOCOL, {
    headers: { [REMOTE_TOKEN_HEADER]: TEST_TOKEN },
  });
  sockets.push(socket);
  return { socket, frames: collectFrames(socket) };
}

function waitForOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('open', () => resolve());
    socket.once('error', reject);
  });
}

function waitForClose(socket: WebSocket): Promise<number> {
  return new Promise((resolve) => socket.once('close', (code) => resolve(code)));
}

async function authenticate(
  socket: WebSocket,
  frames: FrameCollector,
  identity: { deviceId: string; publicKey: KeyObject; privateKey: KeyObject },
  capabilities: WorkspaceMirrorCapability[]
): Promise<Record<string, unknown>> {
  const challenge = await frames.next((frame) => frame.t === 'auth.challenge');
  socket.send(
    JSON.stringify({
      t: 'auth.proof',
      deviceId: identity.deviceId,
      nonce: challenge.nonce,
      signature: sign(null, Buffer.from(String(challenge.nonce)), identity.privateKey).toString(
        'base64'
      ),
      publicKey: identity.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    })
  );
  socket.send(
    JSON.stringify({
      t: 'clientHello',
      protocolVersions: [WORKSPACE_MIRROR_PROTOCOL_VERSION],
      schemaVersions: [WORKSPACE_MIRROR_SCHEMA_VERSION],
      deviceId: identity.deviceId,
      clientId: `client-${identity.deviceId}`,
      capabilities,
      resumeCursor: null,
    })
  );
  return frames.next((frame) => frame.t === 'serverHello');
}

afterEach(async () => {
  for (const cleanup of clientCleanups.splice(0)) cleanup();
  for (const socket of sockets.splice(0)) socket.terminate();
  await activeServer?.stop();
  await cleanupRuntime?.();
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  activeServer = null;
  cleanupRuntime = null;
  temporaryDirectory = null;
});

describe('Remote Workspace Mirror security boundaries', () => {
  it('blocks the V2 kill switch while volatile workspace data has not been handed off', async () => {
    const { workspaceSceneHasVolatileData } = await import('../RemoteHostServer');
    const snapshot = createEmptyWorkspaceSceneSnapshot({
      hostId: 'host-kill-switch',
      sceneId: 'scene-kill-switch',
      hostEpoch: '11111111-1111-4111-8111-111111111111',
    });
    snapshot.agents.sessions.agent = {
      id: 'agent',
      providerSessionId: 'provider-session',
      generation: 1,
      agentId: 'claude',
      name: 'Agent',
      repositoryId: null,
      worktreeId: null,
      terminalSessionId: null,
      environment: 'native',
      initialized: true,
      activated: true,
      displayOrder: 0,
      runtimeState: 'idle',
      status: 'idle',
      waitingReason: null,
      draft: { text: 'unsent prompt', resources: [] },
      task: null,
    };
    expect(workspaceSceneHasVolatileData(snapshot)).toBe(true);
    snapshot.agents.sessions.agent!.draft.text = '';
    expect(workspaceSceneHasVolatileData(snapshot)).toBe(false);
  });

  it('rejects compatibility RPC before device proof and client hello', async () => {
    const { server, status } = await startHost();
    const { socket, frames } = openV2Socket(status.port);
    await waitForOpen(socket);
    await frames.next((frame) => frame.t === 'auth.challenge');

    server.broadcastToClients(IPC_CHANNELS.AGENT_USER_PROMPT_NOTIFICATION, {
      prompt: 'must-not-leak-before-device-proof',
    });
    await expect(
      frames.next(
        (frame) => frame.t === 'ev' && frame.ch === IPC_CHANNELS.AGENT_USER_PROMPT_NOTIFICATION,
        75
      )
    ).rejects.toThrow('timed out waiting for WebSocket frame');

    const closed = waitForClose(socket);
    socket.send(
      JSON.stringify({
        t: 'req',
        id: 1,
        ch: IPC_CHANNELS.WORKSPACE_MIRROR_GET_SNAPSHOT,
        args: [],
      })
    );

    await expect(
      frames.next((frame) => frame.t === 'error' && frame.error !== undefined)
    ).resolves.toMatchObject({ error: { code: 'UNAUTHORIZED' } });
    await expect(closed).resolves.toBe(4401);
  });

  it('does not allow the shared-token V1 socket to bypass V2 device scopes', async () => {
    const { status } = await startHost();
    const socket = new WebSocket(`ws://127.0.0.1:${status.port}/`, {
      headers: { [REMOTE_TOKEN_HEADER]: TEST_TOKEN },
    });
    sockets.push(socket);
    await waitForOpen(socket);
    await expect(waitForClose(socket)).resolves.toBe(4406);
  });

  it('rejects remote preview reads outside canonical workspace roots', async () => {
    const { status } = await startHost();
    const { socket, frames } = openV2Socket(status.port);
    await waitForOpen(socket);
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    await authenticate(
      socket,
      frames,
      { deviceId: 'device-preview-policy', publicKey, privateKey },
      ['scene.snapshot', 'scene.replay', 'resource.transfer']
    );
    socket.send(
      JSON.stringify({
        t: 'req',
        id: 77,
        ch: REMOTE_FS_READ_FILE_CHANNEL,
        args: ['/etc/passwd'],
      })
    );
    await expect(
      frames.next((frame) => frame.t === 'res' && frame.id === 77)
    ).resolves.toMatchObject({
      ok: false,
      error: 'workspace path is not authorized',
    });
  });

  it('falls back to one isolated V1 socket after the V2 kill switch', async () => {
    const { server, status } = await startHost();
    const { RemoteClientManager } = await import('../RemoteClientManager');
    const manager = new RemoteClientManager();
    clientCleanups.push(() => manager.disposeAll());
    const webContents = createWebContents(71);

    await expect(
      manager.connect(webContents, {
        host: '127.0.0.1',
        port: status.port,
        token: TEST_TOKEN,
        deviceId: 'device-kill-switch',
        clientId: 'client-kill-switch',
        mirrorV2: true,
      })
    ).resolves.toMatchObject({ state: 'connected', mirrorProtocol: 'v2' });
    await vi.waitFor(() => expect(manager.getStatus(webContents.id).mirrorSyncPhase).toBe('live'));

    server.setMirrorV2Enabled(false);
    await vi.waitFor(
      () =>
        expect(manager.getStatus(webContents.id)).toMatchObject({
          state: 'connected',
          mirrorProtocol: 'v1',
          mirrorSyncPhase: 'disconnected',
        }),
      { timeout: 5_000, interval: 20 }
    );
    expect(manager.shouldForward(webContents.id, IPC_CHANNELS.WORKSPACE_MIRROR_GET_SNAPSHOT)).toBe(
      false
    );
    expect(manager.shouldForward(webContents.id, IPC_CHANNELS.FILE_READ)).toBe(true);
    expect(manager.getStatus(webContents.id).mirrorRevision).toBeUndefined();
    await expect(
      manager.forward(webContents.id, IPC_CHANNELS.WORKSPACE_MIRROR_GET_SNAPSHOT, [])
    ).rejects.toThrow(/no handler/);

    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(server.getStatus().clientCount).toBe(1);
    expect(manager.getStatus(webContents.id).mirrorProtocol).toBe('v1');
  });

  it('terminates a revoked device without reconnecting or retaining control state', async () => {
    const { server, status } = await startHost();
    const { RemoteClientManager } = await import('../RemoteClientManager');
    const manager = new RemoteClientManager();
    clientCleanups.push(() => manager.disposeAll());
    const webContents = createWebContents(72);

    await manager.connect(webContents, {
      host: '127.0.0.1',
      port: status.port,
      token: TEST_TOKEN,
      deviceId: 'device-revoked',
      clientId: 'client-revoked',
      mirrorV2: true,
    });
    await expect(
      manager.forward(webContents.id, IPC_CHANNELS.WORKSPACE_MIRROR_REQUEST_CONTROL, [])
    ).resolves.toMatchObject({ holderDeviceId: 'device-revoked' });

    await expect(server.revokePairedDevice('device-revoked')).resolves.toBe(true);
    await vi.waitFor(() => expect(manager.getStatus(webContents.id).state).toBe('disconnected'));
    expect(manager.getStatus(webContents.id)).toEqual({
      state: 'disconnected',
      host: null,
      port: null,
      hostInfo: null,
    });

    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(server.getStatus().clientCount).toBe(0);
    expect(manager.getStatus(webContents.id).state).toBe('disconnected');
  });

  it('keeps a mirror.read device from requesting control or dispatching intents', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'enso-remote-readonly-'));
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const publicKeyBase64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const deviceStorePath = join(temporaryDirectory, 'paired-devices.json');
    await writeFile(
      deviceStorePath,
      JSON.stringify({
        version: 1,
        devices: {
          'device-readonly': {
            deviceId: 'device-readonly',
            publicKey: publicKeyBase64,
            scopes: ['mirror.read'],
            pairedAt: 1,
            revokedAt: null,
          },
        },
      })
    );
    const deviceStore = new RemotePairedDeviceStore(deviceStorePath);
    const { runtime, status } = await startHost({ deviceStore });
    const { socket, frames } = openV2Socket(status.port);
    await waitForOpen(socket);
    await authenticate(socket, frames, { deviceId: 'device-readonly', publicKey, privateKey }, [
      'scene.snapshot',
      'scene.intent',
      'control.lease',
    ]);

    socket.send(
      JSON.stringify({ t: 'control.request', requestId: 'control-readonly', knownCoordSeq: 0 })
    );
    await expect(
      frames.next((frame) => frame.t === 'error' && frame.requestId === 'control-readonly')
    ).resolves.toMatchObject({ error: { code: 'FORBIDDEN' } });
    await expect(runtime.getWorkspaceMirrorService().getControllerLease()).resolves.toBeNull();

    const snapshot = runtime.getWorkspaceMirrorService().getSnapshot();
    socket.send(
      JSON.stringify({
        t: 'state.intent',
        operationId: 'intent-readonly',
        clientSeq: 1,
        baseRevision: snapshot.revision,
        kind: 'navigation.replace',
        payload: { navigation: { ...snapshot.navigation, activePrimaryPanel: 'terminal' } },
      })
    );
    await expect(
      frames.next((frame) => frame.t === 'error' && frame.requestId === 'intent-readonly')
    ).resolves.toMatchObject({ error: { code: 'FORBIDDEN' } });
    expect(runtime.getWorkspaceMirrorService().getSnapshot().revision).toBe(snapshot.revision);
  });

  it('requires the negotiated capability even when the device has control scope', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const { runtime, status } = await startHost();
    const { socket, frames } = openV2Socket(status.port);
    await waitForOpen(socket);
    await authenticate(
      socket,
      frames,
      { deviceId: 'device-limited-capability', publicKey, privateKey },
      ['scene.snapshot']
    );

    socket.send(
      JSON.stringify({
        t: 'control.request',
        requestId: 'control-without-capability',
        knownCoordSeq: 0,
      })
    );
    await expect(
      frames.next(
        (frame) => frame.t === 'error' && frame.requestId === 'control-without-capability'
      )
    ).resolves.toMatchObject({
      error: { code: 'FORBIDDEN', message: expect.stringContaining('control.lease') },
    });
    await expect(runtime.getWorkspaceMirrorService().getControllerLease()).resolves.toBeNull();
  });

  it('keeps terminal mutations off compatibility RPC and requires terminal.stream when typed', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const { runtime, status } = await startHost();
    const { socket, frames } = openV2Socket(status.port);
    await waitForOpen(socket);
    await authenticate(
      socket,
      frames,
      { deviceId: 'device-without-terminal-stream', publicKey, privateKey },
      ['scene.snapshot', 'command.execute', 'control.lease']
    );
    socket.send(
      JSON.stringify({
        t: 'control.request',
        requestId: 'terminal-control',
        knownCoordSeq: 0,
      })
    );
    await frames.next((frame) => frame.t === 'control.granted');

    const requests = [
      {
        ch: IPC_CHANNELS.TERMINAL_CREATE,
        args: [{ cwd: temporaryDirectory }],
        error: 'command.execute',
      },
      {
        ch: IPC_CHANNELS.TERMINAL_WRITE,
        args: ['terminal-unknown', 'input'],
        error: 'coordination plane',
      },
      {
        ch: IPC_CHANNELS.TERMINAL_RESIZE,
        args: ['terminal-unknown', { cols: 80, rows: 24 }],
        error: 'coordination plane',
      },
      {
        ch: IPC_CHANNELS.TERMINAL_DESTROY,
        args: ['terminal-unknown'],
        error: 'command.execute',
      },
      { ch: IPC_CHANNELS.TERMINAL_LIST_PERSISTENT, args: [], error: 'terminal.stream' },
      {
        ch: IPC_CHANNELS.TERMINAL_GET_ACTIVITY,
        args: ['terminal-unknown'],
        error: 'terminal.stream',
      },
    ];
    for (const [index, request] of requests.entries()) {
      const id = 900 + index;
      const { error: expectedError, ...remoteRequest } = request;
      socket.send(JSON.stringify({ t: 'req', id, ...remoteRequest }));
      await expect(
        frames.next((frame) => frame.t === 'res' && frame.id === id)
      ).resolves.toMatchObject({
        ok: false,
        error: expect.stringContaining(expectedError),
      });
    }
    const { digestWorkspaceCommandRequest, WORKSPACE_COMMAND_VERSION } = await import(
      '../../workspace/WorkspaceCommandRegistry'
    );
    const commandArgs = [{ cwd: temporaryDirectory }];
    socket.send(
      JSON.stringify({
        t: 'command.execute',
        operationId: 'terminal-without-capability',
        clientSeq: 1,
        command: IPC_CHANNELS.TERMINAL_CREATE,
        commandVersion: WORKSPACE_COMMAND_VERSION,
        requestDigest: digestWorkspaceCommandRequest(
          IPC_CHANNELS.TERMINAL_CREATE,
          WORKSPACE_COMMAND_VERSION,
          commandArgs
        ),
        args: commandArgs,
      })
    );
    await expect(
      frames.next(
        (frame) => frame.t === 'error' && frame.requestId === 'terminal-without-capability'
      )
    ).resolves.toMatchObject({
      error: { code: 'FORBIDDEN', message: expect.stringContaining('capability') },
    });
    expect(runtime.getWorkspaceMirrorService().getSnapshot().terminals.sessions).toEqual({});
  });

  it('renews the same controller lease when its device reconnects during grace', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const identity = { deviceId: 'device-controller-reconnect', publicKey, privateKey };
    const { runtime, status } = await startHost();
    const first = openV2Socket(status.port);
    await waitForOpen(first.socket);
    await authenticate(first.socket, first.frames, identity, ['scene.snapshot', 'control.lease']);
    first.socket.send(
      JSON.stringify({ t: 'control.request', requestId: 'first-control', knownCoordSeq: 0 })
    );
    const initialGrant = await first.frames.next((frame) => frame.t === 'control.granted');
    const initialLease = initialGrant.lease as { leaseId: string };

    const firstClosed = waitForClose(first.socket);
    first.socket.close();
    await firstClosed;
    await vi.waitFor(async () => {
      expect((await runtime.getWorkspaceMirrorService().getControllerLease())?.graceUntil).not.toBe(
        null
      );
    });

    const second = openV2Socket(status.port);
    await waitForOpen(second.socket);
    await authenticate(second.socket, second.frames, identity, ['scene.snapshot', 'control.lease']);
    const renewedGrant = await second.frames.next((frame) => frame.t === 'control.granted');
    expect(renewedGrant.lease).toMatchObject({
      leaseId: initialLease.leaseId,
      graceUntil: null,
    });
    await expect(runtime.getWorkspaceMirrorService().getControllerLease()).resolves.toMatchObject({
      leaseId: initialLease.leaseId,
      graceUntil: null,
    });
  });

  it('validates every compatibility RPC path at its real argument position', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'enso-remote-path-policy-'));
    const repository = join(temporaryDirectory, 'repository');
    const existingWorktree = join(temporaryDirectory, 'existing-worktree');
    const unrelated = join(temporaryDirectory, 'unrelated');
    const targetDir = join(repository, 'target');
    const source = join(repository, 'source.txt');
    await mkdir(repository, { recursive: true });
    await mkdir(existingWorktree, { recursive: true });
    await mkdir(unrelated, { recursive: true });
    await mkdir(targetDir, { recursive: true });
    await writeFile(source, 'source');
    const roots = [repository, existingWorktree];
    const newSibling = join(temporaryDirectory, 'new-worktree');
    const outsideTarget = join(unrelated, 'outside-target');
    const { validateV2WorkspaceRpcPaths } = await import('../RemoteHostServer');

    await expect(
      validateV2WorkspaceRpcPaths(
        IPC_CHANNELS.WORKTREE_ADD,
        [repository, { path: newSibling, newBranch: 'feature' }],
        roots
      )
    ).resolves.toBe(true);
    await expect(
      validateV2WorkspaceRpcPaths(
        IPC_CHANNELS.FILE_LIST,
        [join(homedir(), 'ensoai', 'repos')],
        roots
      )
    ).resolves.toBe(true);
    await expect(
      validateV2WorkspaceRpcPaths(
        IPC_CHANNELS.WORKTREE_ADD,
        [repository, { path: outsideTarget, newBranch: 'feature' }],
        roots
      )
    ).resolves.toBe(false);

    await expect(
      validateV2WorkspaceRpcPaths(
        IPC_CHANNELS.GIT_COMMIT_SHOW,
        [repository, '0123456789abcdef0123456789abcdef01234567'],
        roots
      )
    ).resolves.toBe(true);
    await expect(
      validateV2WorkspaceRpcPaths(
        IPC_CHANNELS.GIT_COMMIT_SHOW,
        [repository, `--output=${join(unrelated, 'written-by-git')}`],
        roots
      )
    ).resolves.toBe(false);
    await expect(
      validateV2WorkspaceRpcPaths(
        IPC_CHANNELS.GIT_COMMIT_DIFF,
        [repository, '0123456789abcdef0123456789abcdef01234567', source, 'M', undefined],
        roots
      )
    ).resolves.toBe(true);
    await expect(
      validateV2WorkspaceRpcPaths(
        IPC_CHANNELS.GIT_COMMIT_DIFF,
        [
          repository,
          '0123456789abcdef0123456789abcdef01234567',
          join(unrelated, 'outside.txt'),
          'M',
          undefined,
        ],
        roots
      )
    ).resolves.toBe(false);
    for (const channel of [IPC_CHANNELS.GIT_SUBMODULE_INIT, IPC_CHANNELS.GIT_SUBMODULE_UPDATE]) {
      await expect(validateV2WorkspaceRpcPaths(channel, [repository, true], roots)).resolves.toBe(
        true
      );
    }
    await expect(
      validateV2WorkspaceRpcPaths(
        IPC_CHANNELS.GIT_CLONE,
        ['https://example.test/repo', newSibling],
        roots
      )
    ).resolves.toBe(true);
    await expect(
      validateV2WorkspaceRpcPaths(
        IPC_CHANNELS.GIT_CLONE,
        ['https://example.test/repo', outsideTarget],
        roots
      )
    ).resolves.toBe(false);
    await expect(
      validateV2WorkspaceRpcPaths(
        IPC_CHANNELS.GIT_CLONE,
        ['https://example.test/repo', join(homedir(), 'ensoai', 'repos', 'new-repository')],
        roots
      )
    ).resolves.toBe(true);
    await expect(
      validateV2WorkspaceRpcPaths(
        IPC_CHANNELS.WORKTREE_ADD,
        [
          repository,
          {
            path: join(homedir(), 'ensoai', 'workspaces', 'repository', 'feature'),
            newBranch: 'feature',
          },
        ],
        roots
      )
    ).resolves.toBe(true);

    for (const channel of [
      IPC_CHANNELS.GIT_INIT,
      IPC_CHANNELS.GIT_GENERATE_COMMIT_MSG,
      IPC_CHANNELS.GIT_GENERATE_BRANCH_NAME,
      IPC_CHANNELS.GIT_CODE_REVIEW_START,
    ]) {
      await expect(validateV2WorkspaceRpcPaths(channel, [repository, {}], roots)).resolves.toBe(
        true
      );
      await expect(validateV2WorkspaceRpcPaths(channel, [unrelated, {}], roots)).resolves.toBe(
        false
      );
    }

    await expect(
      validateV2WorkspaceRpcPaths(
        IPC_CHANNELS.WORKTREE_MERGE_CONTINUE,
        [repository, 'merge', { worktreePath: existingWorktree }],
        roots
      )
    ).resolves.toBe(true);
    await expect(
      validateV2WorkspaceRpcPaths(
        IPC_CHANNELS.WORKTREE_MERGE_CONTINUE,
        [repository, 'merge', { worktreePath: unrelated }],
        roots
      )
    ).resolves.toBe(false);

    const tempChild = join(repository, 'temporary-child');
    await mkdir(tempChild);
    await expect(
      validateV2WorkspaceRpcPaths(IPC_CHANNELS.TEMP_WORKSPACE_CREATE, [repository], roots)
    ).resolves.toBe(true);
    await expect(
      validateV2WorkspaceRpcPaths(IPC_CHANNELS.TEMP_WORKSPACE_CREATE, [unrelated], roots)
    ).resolves.toBe(false);
    await expect(
      validateV2WorkspaceRpcPaths(
        IPC_CHANNELS.TEMP_WORKSPACE_REMOVE,
        [tempChild, repository],
        roots
      )
    ).resolves.toBe(true);
    await expect(
      validateV2WorkspaceRpcPaths(
        IPC_CHANNELS.TEMP_WORKSPACE_REMOVE,
        [unrelated, temporaryDirectory],
        roots
      )
    ).resolves.toBe(false);

    await expect(
      validateV2WorkspaceRpcPaths(IPC_CHANNELS.TERMINAL_CREATE, [{ cwd: repository }], roots)
    ).resolves.toBe(true);
    await expect(
      validateV2WorkspaceRpcPaths(IPC_CHANNELS.TERMINAL_CREATE, [{ cwd: unrelated }], roots)
    ).resolves.toBe(false);

    await expect(
      validateV2WorkspaceRpcPaths(
        IPC_CHANNELS.FILE_BATCH_COPY,
        [[source], targetDir, [{ path: source, action: 'rename', newName: 'renamed.txt' }]],
        roots
      )
    ).resolves.toBe(true);
    await expect(
      validateV2WorkspaceRpcPaths(
        IPC_CHANNELS.FILE_BATCH_COPY,
        [[source], targetDir, [{ path: source, action: 'rename', newName: '../../escaped.txt' }]],
        roots
      )
    ).resolves.toBe(false);

    const outsideDirectory = join(unrelated, 'outside-directory');
    const linkedDirectory = join(repository, 'linked-directory');
    await mkdir(outsideDirectory);
    await symlink(
      outsideDirectory,
      linkedDirectory,
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    await expect(
      validateV2WorkspaceRpcPaths(
        IPC_CHANNELS.FILE_CREATE,
        [join(linkedDirectory, 'escaped.txt'), 'content'],
        roots
      )
    ).resolves.toBe(false);
    for (const channel of [
      IPC_CHANNELS.GIT_SUBMODULE_CHANGES,
      IPC_CHANNELS.GIT_SUBMODULE_BRANCHES,
    ]) {
      await expect(
        validateV2WorkspaceRpcPaths(channel, [repository, linkedDirectory], roots)
      ).resolves.toBe(false);
    }
  });

  it('does not expose an empty snapshot while the host is bootstrapping', async () => {
    const { runtime, status } = await startHost({ bootstrapReady: false });
    const { RemoteClientManager } = await import('../RemoteClientManager');
    const manager = new RemoteClientManager();
    clientCleanups.push(() => manager.disposeAll());
    const webContents = createWebContents(73);

    await expect(
      manager.connect(webContents, {
        host: '127.0.0.1',
        port: status.port,
        token: TEST_TOKEN,
        deviceId: 'device-bootstrap',
        clientId: 'client-bootstrap',
        mirrorV2: true,
      })
    ).resolves.toMatchObject({
      state: 'connected',
      mirrorProtocol: 'v2',
      mirrorSyncPhase: 'bootstrapping',
    });
    await expect(
      manager.forward(webContents.id, IPC_CHANNELS.WORKSPACE_MIRROR_GET_SNAPSHOT, [])
    ).rejects.toThrow(/not synchronized/);
    expect(
      webContents.sentFrames.some(
        ({ channel }) => channel === IPC_CHANNELS.WORKSPACE_MIRROR_SNAPSHOT
      )
    ).toBe(false);

    await runtime.completeWorkspaceMirrorBootstrap();
    await vi.waitFor(() => expect(manager.getStatus(webContents.id).mirrorSyncPhase).toBe('live'));
    expect(
      webContents.sentFrames.some(
        ({ channel }) => channel === IPC_CHANNELS.WORKSPACE_MIRROR_SNAPSHOT
      )
    ).toBe(true);
  });

  it('uploads resources in verified chunks and returns no host path', async () => {
    const { runtime, status } = await startHost();
    const { RemoteClientManager } = await import('../RemoteClientManager');
    const manager = new RemoteClientManager();
    clientCleanups.push(() => manager.disposeAll());
    const webContents = createWebContents(74);
    const sourcePath = join(temporaryDirectory!, 'attachment.bin');
    const source = Buffer.alloc(700 * 1024, 7);
    await writeFile(sourcePath, source);

    await manager.connect(webContents, {
      host: '127.0.0.1',
      port: status.port,
      token: TEST_TOKEN,
      deviceId: 'device-resource-upload',
      clientId: 'client-resource-upload',
      mirrorV2: true,
    });
    expect(manager.shouldForward(webContents.id, IPC_CHANNELS.FILE_SAVE_TO_TEMP)).toBe(false);
    await manager.forward(webContents.id, IPC_CHANNELS.WORKSPACE_MIRROR_REQUEST_CONTROL, []);
    const reference = await manager.forward(
      webContents.id,
      IPC_CHANNELS.WORKSPACE_MIRROR_STAGE_RESOURCE,
      [sourcePath, 'application/octet-stream']
    );
    expect(reference).toMatchObject({ size: source.byteLength });

    runtime
      .getWorkspaceResourceService()
      .setReferencedResourceIds(new Set([(reference as { id: string }).id]));
    const opaquePath = runtime
      .getWorkspaceResourceService()
      .materializeForRemote((reference as { id: string }).id, 'observer');
    expect(opaquePath).toBe(`enso-resource://${(reference as { id: string }).id}`);
    expect(opaquePath).not.toContain(temporaryDirectory!);

    const fetched = await runtime
      .getWorkspaceResourceService()
      .fetch((reference as { id: string }).id, 'observer');
    expect(Buffer.from(fetched.data, 'base64')).toEqual(source);
  });
});
