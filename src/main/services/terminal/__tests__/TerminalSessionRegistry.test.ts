import { describe, expect, it } from 'vitest';
import type { TerminalCreateOptions } from '../../../../shared/types/terminal';
import {
  type TerminalPtyAdapter,
  type TerminalSessionLifecycleEvent,
  TerminalSessionRegistry,
  type TerminalStreamEvent,
} from '../TerminalSessionRegistry';

interface FakePtyCallbacks {
  onData: (data: string) => void;
  onExit?: (exitCode: number, signal?: number) => void;
}

class FakePtyManager implements TerminalPtyAdapter {
  private nextRawId = 0;
  private readonly callbacks = new Map<string, FakePtyCallbacks>();
  readonly created: Array<{ rawPtyId: string; options: TerminalCreateOptions }> = [];
  readonly writes: Array<{ rawPtyId: string; data: string }> = [];
  readonly resizes: Array<{ rawPtyId: string; cols: number; rows: number }> = [];
  readonly destroyed: string[] = [];
  activity = false;

  create(
    options: TerminalCreateOptions,
    onData: (data: string) => void,
    onExit?: (exitCode: number, signal?: number) => void
  ): string {
    const rawPtyId = `pty-${++this.nextRawId}`;
    this.created.push({ rawPtyId, options });
    this.callbacks.set(rawPtyId, { onData, onExit });
    return rawPtyId;
  }

  write(rawPtyId: string, data: string): void {
    this.writes.push({ rawPtyId, data });
  }

  resize(rawPtyId: string, cols: number, rows: number): void {
    this.resizes.push({ rawPtyId, cols, rows });
  }

  destroy(rawPtyId: string): void {
    this.destroyed.push(rawPtyId);
    this.exit(rawPtyId, 0);
  }

  async getProcessActivity(): Promise<boolean> {
    return this.activity;
  }

  emitData(rawPtyId: string, data: string): void {
    this.callbacks.get(rawPtyId)?.onData(data);
  }

  exit(rawPtyId: string, exitCode: number, signal?: number): void {
    const callbacks = this.callbacks.get(rawPtyId);
    this.callbacks.delete(rawPtyId);
    callbacks?.onExit?.(exitCode, signal);
  }
}

function dataEvents(events: TerminalStreamEvent[]) {
  return events.filter((event) => event.type === 'stream.data');
}

describe('TerminalSessionRegistry', () => {
  it('maps a stable session ID to one raw PTY and exposes metadata and controls', async () => {
    const pty = new FakePtyManager();
    const registry = new TerminalSessionRegistry(pty, {
      createSessionId: () => 'terminal-stable-id',
      now: () => 100,
    });

    const sessionId = registry.create(
      { cwd: '/workspace', cols: 100, rows: 30 },
      { title: 'Agent', workspaceId: 'workspace-1' }
    );
    const rawPtyId = registry.getRawPtyId(sessionId);

    expect(sessionId).toBe('terminal-stable-id');
    expect(rawPtyId).toBe('pty-1');
    expect(registry.getSessionIdByRawPtyId('pty-1')).toBe(sessionId);
    expect(registry.list()).toEqual([
      expect.objectContaining({
        id: sessionId,
        title: 'Agent',
        workspaceId: 'workspace-1',
        cwd: '/workspace',
        cols: 100,
        rows: 30,
        status: 'running',
        createdAt: 100,
      }),
    ]);

    expect(registry.write(sessionId, 'input')).toBe(true);
    expect(registry.resize(sessionId, 120, 40)).toBe(true);
    pty.activity = true;
    await expect(registry.getActivity(sessionId)).resolves.toBe(true);
    expect(pty.writes).toEqual([{ rawPtyId: 'pty-1', data: 'input' }]);
    expect(pty.resizes).toEqual([{ rawPtyId: 'pty-1', cols: 120, rows: 40 }]);
    expect(registry.getMetadata(sessionId)).toEqual(
      expect.objectContaining({ cols: 120, rows: 40 })
    );
  });

  it('delivers the same ordered stream sequence to multiple subscribers', () => {
    const pty = new FakePtyManager();
    const registry = new TerminalSessionRegistry(pty, {
      createSessionId: () => 'terminal-multi',
    });
    const sessionId = registry.create();
    const rawPtyId = registry.getRawPtyId(sessionId);
    const first: TerminalStreamEvent[] = [];
    const second: TerminalStreamEvent[] = [];

    registry.attach(sessionId, { subscriberId: 'first', onEvent: (event) => first.push(event) });
    registry.attach(sessionId, { subscriberId: 'second', onEvent: (event) => second.push(event) });
    if (rawPtyId) {
      pty.emitData(rawPtyId, 'one');
      pty.emitData(rawPtyId, 'two');
    }

    expect(dataEvents(first)).toEqual([
      expect.objectContaining({ streamSeq: 1, data: 'one' }),
      expect.objectContaining({ streamSeq: 2, data: 'two' }),
    ]);
    expect(dataEvents(second)).toEqual(dataEvents(first));
    expect(registry.getMetadata(sessionId)?.subscriberCount).toBe(2);
  });

  it('keeps the PTY alive after detach and replays missed output on reconnect', () => {
    const pty = new FakePtyManager();
    const registry = new TerminalSessionRegistry(pty, {
      createSessionId: () => 'terminal-reconnect',
    });
    const sessionId = registry.create();
    const rawPtyId = registry.getRawPtyId(sessionId);
    const initial: TerminalStreamEvent[] = [];

    registry.attach(sessionId, { subscriberId: 'client', onEvent: (event) => initial.push(event) });
    if (rawPtyId) {
      pty.emitData(rawPtyId, 'one');
      pty.emitData(rawPtyId, 'two');
    }
    expect(registry.detach(sessionId, 'client')).toBe(true);
    if (rawPtyId) {
      pty.emitData(rawPtyId, 'missed');
    }

    const reconnected: TerminalStreamEvent[] = [];
    const result = registry.attach(sessionId, {
      subscriberId: 'client',
      afterStreamSeq: 2,
      onEvent: (event) => reconnected.push(event),
    });
    if (rawPtyId) {
      pty.emitData(rawPtyId, 'live');
    }

    expect(pty.destroyed).toEqual([]);
    expect(registry.has(sessionId)).toBe(true);
    expect(result).toEqual({
      sessionId,
      reset: false,
      retainedFromSeq: 1,
      currentStreamSeq: 3,
      replayedEventCount: 1,
    });
    expect(dataEvents(reconnected)).toEqual([
      expect.objectContaining({ streamSeq: 3, data: 'missed' }),
      expect.objectContaining({ streamSeq: 4, data: 'live' }),
    ]);
  });

  it('sends a reset before retained replay when the cursor fell behind the ring', () => {
    const pty = new FakePtyManager();
    const registry = new TerminalSessionRegistry(pty, {
      createSessionId: () => 'terminal-overflow',
      maxReplayBytesPerTerminal: 5,
    });
    const sessionId = registry.create();
    const rawPtyId = registry.getRawPtyId(sessionId);
    if (rawPtyId) {
      pty.emitData(rawPtyId, '');
      pty.emitData(rawPtyId, 'abc');
      pty.emitData(rawPtyId, 'def');
    }

    const events: TerminalStreamEvent[] = [];
    const result = registry.attach(sessionId, {
      subscriberId: 'late-client',
      afterStreamSeq: 0,
      onEvent: (event) => events.push(event),
    });

    expect(result).toEqual({
      sessionId,
      reset: true,
      retainedFromSeq: 2,
      currentStreamSeq: 2,
      replayedEventCount: 1,
    });
    expect(events).toEqual([
      {
        type: 'stream.reset',
        sessionId,
        reason: 'overflow',
        retainedFromSeq: 2,
        currentStreamSeq: 2,
      },
      { type: 'stream.data', sessionId, streamSeq: 2, data: 'def' },
    ]);
    expect(registry.getMetadata(sessionId)?.retainedBytes).toBe(3);
  });

  it('enforces a host-wide replay ceiling across terminal sessions', () => {
    const pty = new FakePtyManager();
    let id = 0;
    const registry = new TerminalSessionRegistry(pty, {
      createSessionId: () => `terminal-${++id}`,
      maxReplayBytesPerTerminal: 10,
      maxReplayBytesTotal: 6,
    });
    const first = registry.create();
    const second = registry.create();
    const firstRaw = registry.getRawPtyId(first);
    const secondRaw = registry.getRawPtyId(second);
    if (firstRaw) pty.emitData(firstRaw, 'aaaa');
    if (secondRaw) pty.emitData(secondRaw, 'bbbb');

    expect(registry.getMetadata(first)?.retainedBytes).toBe(0);
    expect(registry.getMetadata(second)?.retainedBytes).toBe(4);
    const replay: TerminalStreamEvent[] = [];
    const attached = registry.attach(first, {
      subscriberId: 'late-client',
      afterStreamSeq: 0,
      onEvent: (event) => replay.push(event),
    });
    expect(attached.reset).toBe(true);
    expect(replay[0]).toMatchObject({ type: 'stream.reset', reason: 'overflow' });
  });

  it('kills the raw PTY only on explicit destroy and emits one exit event', () => {
    const pty = new FakePtyManager();
    const registry = new TerminalSessionRegistry(pty, {
      createSessionId: () => 'terminal-destroy',
    });
    const sessionId = registry.create();
    const events: TerminalStreamEvent[] = [];
    const lifecycleEvents: TerminalSessionLifecycleEvent[] = [];
    registry.subscribeLifecycle((event) => lifecycleEvents.push(event));
    registry.attach(sessionId, { subscriberId: 'client', onEvent: (event) => events.push(event) });

    expect(registry.detach(sessionId, 'client')).toBe(true);
    expect(pty.destroyed).toEqual([]);
    registry.attach(sessionId, { subscriberId: 'client', onEvent: (event) => events.push(event) });

    expect(registry.destroy(sessionId)).toBe(true);
    expect(registry.destroy(sessionId)).toBe(false);
    expect(pty.destroyed).toEqual(['pty-1']);
    expect(registry.has(sessionId)).toBe(false);
    expect(registry.getSessionIdByRawPtyId('pty-1')).toBeUndefined();
    expect(events.filter((event) => event.type === 'stream.exit')).toEqual([
      {
        type: 'stream.exit',
        sessionId,
        streamSeq: 0,
        exitCode: null,
        reason: 'destroyed',
      },
    ]);
    expect(lifecycleEvents).toEqual([{ sessionId, processState: 'terminated', exitCode: null }]);
  });

  it('records a natural PTY exit without killing it again', () => {
    let now = 100;
    const pty = new FakePtyManager();
    const registry = new TerminalSessionRegistry(pty, {
      createSessionId: () => 'terminal-exit',
      now: () => now,
    });
    const sessionId = registry.create();
    const events: TerminalStreamEvent[] = [];
    const lifecycleEvents: TerminalSessionLifecycleEvent[] = [];
    registry.subscribeLifecycle((event) => lifecycleEvents.push(event));
    registry.attach(sessionId, { subscriberId: 'client', onEvent: (event) => events.push(event) });

    now = 200;
    pty.exit('pty-1', 7, 9);

    expect(registry.getMetadata(sessionId)).toEqual(
      expect.objectContaining({ status: 'exited', exitedAt: 200, exitCode: 7, signal: 9 })
    );
    expect(events).toContainEqual({
      type: 'stream.exit',
      sessionId,
      streamSeq: 0,
      exitCode: 7,
      signal: 9,
      reason: 'process-exit',
    });
    expect(lifecycleEvents).toEqual([{ sessionId, processState: 'exited', exitCode: 7 }]);
    expect(registry.getRawPtyId(sessionId)).toBeUndefined();
    expect(registry.destroy(sessionId)).toBe(true);
    expect(pty.destroyed).toEqual([]);
    expect(lifecycleEvents).toEqual([
      { sessionId, processState: 'exited', exitCode: 7 },
      { sessionId, processState: 'terminated', exitCode: null },
    ]);
  });
});
