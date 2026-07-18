import { afterEach, describe, expect, it, vi } from 'vitest';
import { isRemoteHostPathWithinRoot, RemoteClientManager } from '../RemoteClientManager';

describe('remote preview path ownership', () => {
  it('matches host paths with the remote platform semantics', () => {
    expect(isRemoteHostPathWithinRoot('/srv/repo/image.png', '/srv/repo', 'linux')).toBe(true);
    expect(isRemoteHostPathWithinRoot('/srv/repository/image.png', '/srv/repo', 'linux')).toBe(
      false
    );
    expect(isRemoteHostPathWithinRoot('C:\\Work\\Repo\\image.png', 'c:\\work\\repo', 'win32')).toBe(
      true
    );
    expect(isRemoteHostPathWithinRoot('/Users/Me/Repo/a.png', '/users/me/repo', 'darwin')).toBe(
      true
    );
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
