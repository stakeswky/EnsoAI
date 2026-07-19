import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isRemoteHostPathWithinRoot,
  RemoteClientManager,
  RemoteWorkspaceCommandError,
  restoreMirrorCommandResult,
} from '../RemoteClientManager';

describe('remote preview path ownership', () => {
  it('matches host paths with the remote platform semantics', () => {
    expect(isRemoteHostPathWithinRoot('/srv/repo/image.png', '/srv/repo', 'linux')).toBe(true);
    expect(isRemoteHostPathWithinRoot('/srv/repository/image.png', '/srv/repo', 'linux')).toBe(
      false
    );
    expect(isRemoteHostPathWithinRoot('C:\\Work\\Repo\\image.png', 'c:\\work\\repo', 'win32')).toBe(
      false
    );
    expect(isRemoteHostPathWithinRoot('/Users/Me/Repo/a.png', '/users/me/repo', 'darwin')).toBe(
      false
    );
  });

  it('restores a redacted clone path only from the bound original request', () => {
    expect(
      restoreMirrorCommandResult(
        {
          t: 'command.execute',
          operationId: 'clone-1',
          clientSeq: 1,
          command: 'git:clone',
          commandVersion: 1,
          requestDigest: 'a'.repeat(64),
          args: ['ssh://example.invalid/repository.git', '/host/repository'],
        },
        { success: true }
      )
    ).toEqual({ success: true, path: '/host/repository' });
    expect(
      restoreMirrorCommandResult(
        {
          t: 'command.execute',
          operationId: 'entity-1',
          clientSeq: 2,
          command: 'workspaceMirror:registerEntity',
          commandVersion: 1,
          requestDigest: 'b'.repeat(64),
          args: ['repository', '/host/repository'],
        },
        {
          sceneId: 'scene-1',
          entityId: 'entity-1',
          kind: 'repository',
          disposition: 'new',
        }
      )
    ).toEqual({
      sceneId: 'scene-1',
      entityId: 'entity-1',
      kind: 'repository',
      disposition: 'new',
      path: '/host/repository',
      normalizedPath: '/host/repository',
    });
    expect(
      restoreMirrorCommandResult(
        {
          t: 'command.execute',
          operationId: 'adoption-1',
          clientSeq: 3,
          command: 'workspaceMirror:adoptEntity',
          commandVersion: 1,
          requestDigest: 'c'.repeat(64),
          args: ['repository', 'entity-1', '/host/repository-renamed'],
        },
        {
          ok: true,
          reservation: {
            sceneId: 'scene-1',
            entityId: 'entity-1',
            kind: 'repository',
            disposition: 'adopted',
          },
        }
      )
    ).toEqual({
      ok: true,
      reservation: {
        sceneId: 'scene-1',
        entityId: 'entity-1',
        kind: 'repository',
        disposition: 'adopted',
        path: '/host/repository-renamed',
        normalizedPath: '/host/repository-renamed',
      },
    });
  });

  it('preserves typed RESULT_EXPIRED failures from command status recovery', () => {
    const manager = new RemoteClientManager();
    const reject = vi.fn();
    const frame = {
      t: 'command.execute' as const,
      operationId: 'expired-command',
      clientSeq: 1,
      command: 'tempWorkspace:checkPath',
      commandVersion: 1,
      requestDigest: 'd'.repeat(64),
      args: ['/host/repository'],
    };
    const connection = {
      mirrorPendingCommands: new Map([
        [frame.operationId, { frame, resolve: vi.fn(), reject, timer: null }],
      ]),
    } as never;
    (
      manager as unknown as {
        handleMirrorServerFrame: (connection: unknown, frame: unknown) => void;
      }
    ).handleMirrorServerFrame(connection, {
      t: 'command.result',
      operationId: frame.operationId,
      command: frame.command,
      commandVersion: frame.commandVersion,
      requestDigest: frame.requestDigest,
      state: 'committed',
      resultDigest: 'e'.repeat(64),
      resultExpired: true,
      error: {
        code: 'RESULT_EXPIRED',
        message: 'Workspace command result is no longer available',
        retryable: false,
      },
    });

    expect(reject).toHaveBeenCalledTimes(1);
    expect(reject.mock.calls[0]?.[0]).toBeInstanceOf(RemoteWorkspaceCommandError);
    expect(reject.mock.calls[0]?.[0]).toMatchObject({
      code: 'RESULT_EXPIRED',
      retryable: false,
    });
  });
});

describe('RemoteClientManager V2 terminal attach', () => {
  afterEach(() => vi.restoreAllMocks());

  it('uses only the mirror stream and never creates a legacy subscriber', async () => {
    const manager = new RemoteClientManager();
    const send = vi.fn();
    const connection = {
      ws: { readyState: 1, protocol: 'enso-mirror.v2', send },
      mirrorSyncPhase: 'live',
      mirrorSnapshot: {
        revision: 4,
        terminals: {
          sessions: {
            'terminal-1': { id: 'terminal-1', generation: 2 },
          },
        },
        agents: { sessions: {} },
      },
      mirrorStreams: new Map(),
      terminalStreamCursors: new Map(),
    } as never;
    const invoke = (
      manager as unknown as {
        forwardTerminalAttach: (
          connection: unknown,
          terminalSessionId: string,
          args: unknown[]
        ) => Promise<{
          sessionId: string;
          currentStreamSeq: number;
          replayedEventCount: number;
        }>;
      }
    ).forwardTerminalAttach.bind(manager);
    const resultPromise = invoke(connection, 'terminal-1', [{ afterStreamSeq: 4 }]);
    expect(JSON.parse(send.mock.calls[0]?.[0] as string)).toMatchObject({
      t: 'stream.attach',
      entityId: 'terminal-1',
      entityGeneration: 2,
      fromStreamSeq: 4,
    });
    const attachFrame = JSON.parse(send.mock.calls[0]?.[0] as string) as { streamId: string };
    (
      manager as unknown as {
        handleMirrorServerFrame: (connection: unknown, frame: unknown) => void;
      }
    ).handleMirrorServerFrame(connection, {
      t: 'stream.attached',
      streamId: attachFrame.streamId,
      streamKind: 'terminal',
      entityId: 'terminal-1',
      entityGeneration: 2,
      sceneRevision: 4,
      reset: false,
      retainedFromSeq: 4,
      currentStreamSeq: 7,
      replayedEventCount: 3,
    });
    await expect(resultPromise).resolves.toMatchObject({
      sessionId: 'remote:terminal-1',
      currentStreamSeq: 7,
      replayedEventCount: 3,
    });
  });

  it('rejects attach when the host reports that the scene runtime is missing', async () => {
    const manager = new RemoteClientManager();
    const send = vi.fn();
    const connection = {
      wc: { id: 99, isDestroyed: () => true },
      ws: { readyState: 1, protocol: 'enso-mirror.v2', send },
      mirrorSyncPhase: 'live',
      mirrorSnapshot: {
        revision: 4,
        terminals: { sessions: { stale: { id: 'stale', generation: 1 } } },
        agents: { sessions: {} },
      },
      mirrorStreams: new Map(),
      terminalStreamCursors: new Map(),
      mirrorPendingControls: new Map(),
      mirrorPendingIntents: new Map(),
      mirrorPendingCommands: new Map(),
      mirrorPendingCoordination: new Map(),
      mirrorPendingResourceUploads: new Map(),
    } as never;
    const attach = manager as unknown as {
      forwardTerminalAttach: (
        connection: unknown,
        terminalSessionId: string,
        args: unknown[]
      ) => Promise<unknown>;
      handleMirrorServerFrame: (connection: unknown, frame: unknown) => void;
    };
    const result = attach.forwardTerminalAttach(connection, 'stale', []);
    const frame = JSON.parse(send.mock.calls[0]?.[0] as string) as { streamId: string };
    attach.handleMirrorServerFrame(connection, {
      t: 'error',
      requestId: frame.streamId,
      error: {
        code: 'CONFLICT',
        message: 'terminal process is not running',
        retryable: false,
      },
    });

    await expect(result).rejects.toThrow('terminal process is not running');
  });
});
