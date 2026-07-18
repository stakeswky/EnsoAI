import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  REMOTE_TOKEN_HEADER,
  WORKSPACE_MIRROR_PROTOCOL_VERSION,
  WORKSPACE_MIRROR_SCHEMA_VERSION,
  WORKSPACE_MIRROR_SUBPROTOCOL,
} from '@shared/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

const terminalHarness = vi.hoisted(() => {
  const sessions = new Set(['terminal-integration']);
  const subscribers = new Map<string, (event: unknown) => void>();
  const writes: Array<{ id: string; data: string }> = [];
  const resizes: Array<{ id: string; cols: number; rows: number }> = [];
  const detaches: Array<{ id: string; subscriberId: string }> = [];
  return {
    sessions,
    subscribers,
    writes,
    resizes,
    detaches,
    registry: {
      getMetadata: () => undefined,
      subscribeLifecycle: () => () => undefined,
      has: (id: string) => sessions.has(id),
      attach: (
        id: string,
        request: { subscriberId: string; onEvent: (event: unknown) => void }
      ) => {
        subscribers.set(request.subscriberId, request.onEvent);
        request.onEvent({ type: 'stream.data', sessionId: id, streamSeq: 1, data: 'ready' });
        return {
          sessionId: id,
          reset: false,
          retainedFromSeq: 1,
          currentStreamSeq: 1,
          replayedEventCount: 1,
        };
      },
      detach: (id: string, subscriberId: string) => {
        detaches.push({ id, subscriberId });
        return subscribers.delete(subscriberId);
      },
      write: (id: string, data: string) => {
        writes.push({ id, data });
        return sessions.has(id);
      },
      resize: (id: string, cols: number, rows: number) => {
        resizes.push({ id, cols, rows });
        return sessions.has(id);
      },
    },
  };
});

vi.mock('electron', () => ({
  app: { getVersion: () => 'test' },
  BrowserWindow: { getAllWindows: () => [] },
}));

vi.mock('../../terminal/terminalRuntime', () => ({
  ptyManager: {},
  terminalSessionRegistry: terminalHarness.registry,
}));

interface FrameWaiter {
  predicate: (frame: Record<string, unknown>) => boolean;
  resolve: (frame: Record<string, unknown>) => void;
}

describe('Remote Workspace Mirror V2 terminal stream', () => {
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
    terminalHarness.subscribers.clear();
    terminalHarness.writes.length = 0;
    terminalHarness.resizes.length = 0;
    terminalHarness.detaches.length = 0;
  });

  it('attaches, replays, controls, deduplicates, and detaches a scene terminal', async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'enso-remote-stream-'));
    const runtime = await import('../../workspace/workspaceMirrorRuntime');
    await runtime.initializeWorkspaceMirrorRuntime(temporaryDirectory);
    await runtime.completeWorkspaceMirrorBootstrap();
    cleanupRuntime = runtime.cleanupWorkspaceMirrorRuntime;

    const { RemoteHostServer } = await import('../RemoteHostServer');
    const server = new RemoteHostServer();
    stopServer = () => server.stop();
    const token = 'terminal-stream-test-token';
    const status = await server.start({
      enabled: true,
      port: 0,
      bind: 'localhost',
      token,
      mirrorV2Enabled: true,
    });
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
        const waiter = { predicate, resolve };
        waiters.push(waiter);
        setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error('timed out waiting for WebSocket frame'));
        }, 5_000);
      });
    };

    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    const challenge = await next((frame) => frame.t === 'auth.challenge');
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    socket.send(
      JSON.stringify({
        t: 'auth.proof',
        deviceId: 'device-stream',
        nonce: challenge.nonce,
        signature: sign(null, Buffer.from(String(challenge.nonce)), privateKey).toString('base64'),
        publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
      })
    );
    socket.send(
      JSON.stringify({
        t: 'clientHello',
        protocolVersions: [WORKSPACE_MIRROR_PROTOCOL_VERSION],
        schemaVersions: [WORKSPACE_MIRROR_SCHEMA_VERSION],
        deviceId: 'device-stream',
        clientId: 'client-stream',
        capabilities: ['scene.intent', 'control.lease', 'terminal.stream'],
        resumeCursor: null,
      })
    );
    await next((frame) => frame.t === 'serverHello');
    socket.send(JSON.stringify({ t: 'control.request', requestId: 'control', knownCoordSeq: 0 }));
    await next((frame) => frame.t === 'control.granted');
    socket.send(
      JSON.stringify({
        t: 'state.intent',
        operationId: 'terminal-scene',
        clientSeq: 1,
        baseRevision: 0,
        kind: 'terminals.replace',
        payload: {
          terminals: {
            sessions: {
              'terminal-integration': {
                id: 'terminal-integration',
                generation: 1,
                repositoryId: null,
                worktreeId: null,
                title: 'Integration terminal',
                cwd: '/tmp',
                groupId: null,
                order: 0,
                processState: 'running',
                exitCode: null,
              },
            },
            groups: {},
            activeSessionByWorktree: {},
            quickSessionByWorktree: {},
          },
        },
      })
    );
    await next(
      (frame) => frame.t === 'state.intentResult' && frame.operationId === 'terminal-scene'
    );

    socket.send(
      JSON.stringify({
        t: 'stream.attach',
        streamId: 'stream-integration',
        streamKind: 'terminal',
        entityId: 'terminal-integration',
        entityGeneration: 1,
        sceneRevision: 1,
        fromStreamSeq: 0,
      })
    );
    await expect(next((frame) => frame.t === 'stream.chunk')).resolves.toMatchObject({
      entityId: 'terminal-integration',
      streamSeq: 1,
      data: 'ready',
    });

    const input = {
      t: 'stream.input',
      streamId: 'stream-integration',
      streamKind: 'terminal',
      entityId: 'terminal-integration',
      entityGeneration: 1,
      operationId: 'input-once',
      data: 'pwd\r',
    };
    socket.send(JSON.stringify(input));
    socket.send(JSON.stringify(input));
    socket.send(
      JSON.stringify({
        t: 'stream.resize',
        streamId: 'stream-integration',
        streamKind: 'terminal',
        entityId: 'terminal-integration',
        entityGeneration: 1,
        operationId: 'resize-once',
        cols: 120,
        rows: 40,
      })
    );
    await vi.waitFor(() => {
      expect(terminalHarness.writes).toEqual([{ id: 'terminal-integration', data: 'pwd\r' }]);
      expect(terminalHarness.resizes).toEqual([
        { id: 'terminal-integration', cols: 120, rows: 40 },
      ]);
    });

    socket.send(
      JSON.stringify({
        t: 'stream.detach',
        streamId: 'stream-integration',
        streamKind: 'terminal',
        entityId: 'terminal-integration',
        entityGeneration: 1,
      })
    );
    await vi.waitFor(() => expect(terminalHarness.detaches).toHaveLength(1));
    socket.close();
  });
});
