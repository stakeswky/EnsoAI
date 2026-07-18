import { randomUUID } from 'node:crypto';
import type { TerminalCreateOptions } from '../../../shared/types/terminal';

export const DEFAULT_TERMINAL_REPLAY_BYTES = 8 * 1024 * 1024;
export const DEFAULT_TERMINAL_TOTAL_REPLAY_BYTES = 64 * 1024 * 1024;

export interface TerminalPtyAdapter {
  create(
    options: TerminalCreateOptions,
    onData: (data: string) => void,
    onExit?: (exitCode: number, signal?: number) => void
  ): string;
  write(rawPtyId: string, data: string): void;
  resize(rawPtyId: string, cols: number, rows: number): void;
  destroy(rawPtyId: string): void;
  getProcessActivity(rawPtyId: string): Promise<boolean>;
}

export interface TerminalSessionCreateMetadata {
  sessionId?: string;
  title?: string;
  workspaceId?: string;
}

export type TerminalSessionStatus = 'running' | 'exited';

export interface TerminalSessionMetadata {
  id: string;
  title: string;
  workspaceId?: string;
  cwd: string | null;
  cols: number;
  rows: number;
  status: TerminalSessionStatus;
  createdAt: number;
  exitedAt?: number;
  exitCode?: number;
  signal?: number;
  streamSeq: number;
  retainedFromSeq: number;
  retainedBytes: number;
  subscriberCount: number;
}

export interface TerminalStreamDataEvent {
  type: 'stream.data';
  sessionId: string;
  streamSeq: number;
  data: string;
}

export interface TerminalStreamResetEvent {
  type: 'stream.reset';
  sessionId: string;
  reason: 'overflow' | 'cursor-ahead';
  retainedFromSeq: number;
  currentStreamSeq: number;
}

export interface TerminalStreamExitEvent {
  type: 'stream.exit';
  sessionId: string;
  streamSeq: number;
  exitCode: number | null;
  signal?: number;
  reason: 'process-exit' | 'destroyed';
}

export type TerminalStreamEvent =
  | TerminalStreamDataEvent
  | TerminalStreamResetEvent
  | TerminalStreamExitEvent;

export type TerminalStreamSubscriber = (event: TerminalStreamEvent) => void;

export interface TerminalSessionLifecycleEvent {
  sessionId: string;
  processState: 'exited' | 'terminated';
  exitCode: number | null;
}

export type TerminalSessionLifecycleSubscriber = (event: TerminalSessionLifecycleEvent) => void;

export interface TerminalAttachRequest {
  subscriberId: string;
  afterStreamSeq?: number;
  onEvent: TerminalStreamSubscriber;
}

export interface TerminalAttachResult {
  sessionId: string;
  reset: boolean;
  retainedFromSeq: number;
  currentStreamSeq: number;
  replayedEventCount: number;
}

export interface TerminalSessionRegistryOptions {
  maxReplayBytesPerTerminal?: number;
  maxReplayBytesTotal?: number;
  createSessionId?: () => string;
  now?: () => number;
}

interface ReplayChunk {
  event: TerminalStreamDataEvent;
  bytes: number;
  order: number;
}

interface SubscriberState {
  onEvent: TerminalStreamSubscriber;
  replaying: boolean;
  pending: TerminalStreamEvent[];
}

type InternalSessionStatus = 'starting' | 'running' | 'destroying' | 'exited';

interface TerminalSessionRecord {
  id: string;
  rawPtyId: string | null;
  title: string;
  workspaceId?: string;
  cwd: string | null;
  cols: number;
  rows: number;
  status: InternalSessionStatus;
  createdAt: number;
  exitedAt?: number;
  exitCode?: number;
  signal?: number;
  streamSeq: number;
  discardedThroughSeq: number;
  retainedBytes: number;
  replay: ReplayChunk[];
  subscribers: Map<string, SubscriberState>;
  exitEvent?: TerminalStreamExitEvent;
}

function defaultSessionId(): string {
  return `terminal-${randomUUID()}`;
}

/**
 * Owns stable terminal sessions independently from renderer/WebSocket
 * lifetimes. The underlying PTY handle remains private and may be replaced by
 * adapters without changing the externally visible session ID.
 */
export class TerminalSessionRegistry {
  private readonly sessions = new Map<string, TerminalSessionRecord>();
  private readonly sessionIdByRawPtyId = new Map<string, string>();
  private readonly lifecycleSubscribers = new Set<TerminalSessionLifecycleSubscriber>();
  private readonly maxReplayBytesPerTerminal: number;
  private readonly maxReplayBytesTotal: number;
  private readonly createSessionId: () => string;
  private readonly now: () => number;
  private totalRetainedBytes = 0;
  private nextReplayOrder = 0;

  constructor(
    private readonly pty: TerminalPtyAdapter,
    options: TerminalSessionRegistryOptions = {}
  ) {
    const maxReplayBytes = options.maxReplayBytesPerTerminal ?? DEFAULT_TERMINAL_REPLAY_BYTES;
    if (!Number.isSafeInteger(maxReplayBytes) || maxReplayBytes < 0) {
      throw new RangeError('maxReplayBytesPerTerminal must be a non-negative safe integer');
    }

    this.maxReplayBytesPerTerminal = maxReplayBytes;
    const maxReplayBytesTotal = options.maxReplayBytesTotal ?? DEFAULT_TERMINAL_TOTAL_REPLAY_BYTES;
    if (!Number.isSafeInteger(maxReplayBytesTotal) || maxReplayBytesTotal < 0) {
      throw new RangeError('maxReplayBytesTotal must be a non-negative safe integer');
    }
    this.maxReplayBytesTotal = maxReplayBytesTotal;
    this.createSessionId = options.createSessionId ?? defaultSessionId;
    this.now = options.now ?? Date.now;
  }

  create(
    options: TerminalCreateOptions = {},
    metadata: TerminalSessionCreateMetadata = {}
  ): string {
    const sessionId = metadata.sessionId
      ? this.validateRequestedSessionId(metadata.sessionId)
      : this.nextSessionId();
    const session: TerminalSessionRecord = {
      id: sessionId,
      rawPtyId: null,
      title: metadata.title ?? 'Terminal',
      workspaceId: metadata.workspaceId,
      cwd: options.cwd ?? null,
      cols: options.cols ?? 80,
      rows: options.rows ?? 24,
      status: 'starting',
      createdAt: this.now(),
      streamSeq: 0,
      discardedThroughSeq: 0,
      retainedBytes: 0,
      replay: [],
      subscribers: new Map(),
    };
    this.sessions.set(sessionId, session);

    try {
      const rawPtyId = this.pty.create(
        options,
        (data) => this.handleData(sessionId, data),
        (exitCode, signal) => this.handleExit(sessionId, exitCode, signal)
      );
      session.rawPtyId = rawPtyId;
      if (session.status === 'starting') {
        session.status = 'running';
        this.sessionIdByRawPtyId.set(rawPtyId, sessionId);
      }
      return sessionId;
    } catch (error) {
      this.sessions.delete(sessionId);
      throw error;
    }
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  getRawPtyId(sessionId: string): string | undefined {
    const session = this.sessions.get(sessionId);
    return session?.status === 'running' ? (session.rawPtyId ?? undefined) : undefined;
  }

  getSessionIdByRawPtyId(rawPtyId: string): string | undefined {
    return this.sessionIdByRawPtyId.get(rawPtyId);
  }

  getMetadata(sessionId: string): TerminalSessionMetadata | undefined {
    const session = this.sessions.get(sessionId);
    return session ? this.toMetadata(session) : undefined;
  }

  list(): TerminalSessionMetadata[] {
    return [...this.sessions.values()]
      .map((session) => this.toMetadata(session))
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
  }

  subscribeLifecycle(listener: TerminalSessionLifecycleSubscriber): () => void {
    this.lifecycleSubscribers.add(listener);
    return () => this.lifecycleSubscribers.delete(listener);
  }

  attach(sessionId: string, request: TerminalAttachRequest): TerminalAttachResult {
    const session = this.requireSession(sessionId);
    const afterStreamSeq = request.afterStreamSeq ?? 0;
    if (!Number.isSafeInteger(afterStreamSeq) || afterStreamSeq < 0) {
      throw new RangeError('afterStreamSeq must be a non-negative safe integer');
    }

    const subscriber: SubscriberState = {
      onEvent: request.onEvent,
      replaying: true,
      pending: [],
    };
    session.subscribers.set(request.subscriberId, subscriber);

    const retainedFromSeq = this.retainedFromSeq(session);
    const resetReason =
      afterStreamSeq > session.streamSeq
        ? 'cursor-ahead'
        : afterStreamSeq < session.discardedThroughSeq
          ? 'overflow'
          : null;
    const replay = resetReason
      ? session.replay
      : session.replay.filter(({ event }) => event.streamSeq > afterStreamSeq);

    if (resetReason) {
      this.notify(subscriber, {
        type: 'stream.reset',
        sessionId,
        reason: resetReason,
        retainedFromSeq,
        currentStreamSeq: session.streamSeq,
      });
    }
    for (const { event } of replay) {
      this.notify(subscriber, event);
    }
    if (session.exitEvent) {
      this.notify(subscriber, session.exitEvent);
    }

    while (subscriber.pending.length > 0) {
      const event = subscriber.pending.shift();
      if (event) {
        this.notify(subscriber, event);
      }
    }
    subscriber.replaying = false;

    return {
      sessionId,
      reset: resetReason !== null,
      retainedFromSeq,
      currentStreamSeq: session.streamSeq,
      replayedEventCount: replay.length,
    };
  }

  detach(sessionId: string, subscriberId: string): boolean {
    return this.sessions.get(sessionId)?.subscribers.delete(subscriberId) ?? false;
  }

  /** Detach one renderer/device from every terminal without killing a PTY. */
  detachSubscriber(subscriberId: string): number {
    let detached = 0;
    for (const session of this.sessions.values()) {
      if (session.subscribers.delete(subscriberId)) {
        detached += 1;
      }
    }
    return detached;
  }

  write(sessionId: string, data: string): boolean {
    const session = this.runningSession(sessionId);
    if (!session?.rawPtyId) {
      return false;
    }
    this.pty.write(session.rawPtyId, data);
    return true;
  }

  resize(sessionId: string, cols: number, rows: number): boolean {
    if (!Number.isSafeInteger(cols) || cols <= 0 || !Number.isSafeInteger(rows) || rows <= 0) {
      throw new RangeError('terminal dimensions must be positive safe integers');
    }

    const session = this.runningSession(sessionId);
    if (!session?.rawPtyId) {
      return false;
    }
    this.pty.resize(session.rawPtyId, cols, rows);
    session.cols = cols;
    session.rows = rows;
    return true;
  }

  async getActivity(sessionId: string): Promise<boolean> {
    const session = this.runningSession(sessionId);
    if (!session?.rawPtyId) {
      return false;
    }
    return this.pty.getProcessActivity(session.rawPtyId);
  }

  destroy(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return false;
    }

    if (session.status === 'running' && session.rawPtyId) {
      session.status = 'destroying';
      try {
        this.pty.destroy(session.rawPtyId);
      } catch (error) {
        session.status = 'running';
        throw error;
      }

      this.publish(session, {
        type: 'stream.exit',
        sessionId,
        streamSeq: session.streamSeq,
        exitCode: null,
        reason: 'destroyed',
      });
    }

    this.publishLifecycle({ sessionId, processState: 'terminated', exitCode: null });
    this.removeSession(session);
    return true;
  }

  destroyAll(): void {
    for (const sessionId of [...this.sessions.keys()]) {
      this.destroy(sessionId);
    }
  }

  private nextSessionId(): string {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const candidate = this.createSessionId();
      if (candidate.length > 0 && !this.sessions.has(candidate)) {
        return candidate;
      }
    }
    throw new Error('Unable to allocate a unique terminal session ID');
  }

  private validateRequestedSessionId(sessionId: string): string {
    const normalized = sessionId.trim();
    if (!normalized || normalized.length > 256) {
      throw new Error('Invalid terminal session ID');
    }
    if (this.sessions.has(normalized)) {
      throw new Error(`Terminal session already exists: ${normalized}`);
    }
    return normalized;
  }

  private requireSession(sessionId: string): TerminalSessionRecord {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Unknown terminal session: ${sessionId}`);
    }
    return session;
  }

  private runningSession(sessionId: string): TerminalSessionRecord | undefined {
    const session = this.sessions.get(sessionId);
    return session?.status === 'running' ? session : undefined;
  }

  private handleData(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId);
    if (
      data.length === 0 ||
      !session ||
      (session.status !== 'starting' && session.status !== 'running')
    ) {
      return;
    }

    const event: TerminalStreamDataEvent = {
      type: 'stream.data',
      sessionId,
      streamSeq: ++session.streamSeq,
      data,
    };
    const bytes = Buffer.byteLength(data, 'utf8');

    if (bytes > this.maxReplayBytesPerTerminal) {
      this.totalRetainedBytes -= session.retainedBytes;
      session.replay = [];
      session.retainedBytes = 0;
      session.discardedThroughSeq = event.streamSeq;
    } else {
      session.replay.push({ event, bytes, order: ++this.nextReplayOrder });
      session.retainedBytes += bytes;
      this.totalRetainedBytes += bytes;
      while (session.retainedBytes > this.maxReplayBytesPerTerminal) {
        if (!this.discardOldestChunk(session)) break;
      }
      this.enforceTotalReplayLimit();
    }

    this.publish(session, event);
  }

  private handleExit(sessionId: string, exitCode: number, signal?: number): void {
    const session = this.sessions.get(sessionId);
    if (!session || (session.status !== 'starting' && session.status !== 'running')) {
      return;
    }

    session.status = 'exited';
    session.exitedAt = this.now();
    session.exitCode = exitCode;
    session.signal = signal;
    if (session.rawPtyId) {
      this.sessionIdByRawPtyId.delete(session.rawPtyId);
    }

    const event: TerminalStreamExitEvent = {
      type: 'stream.exit',
      sessionId,
      streamSeq: session.streamSeq,
      exitCode,
      signal,
      reason: 'process-exit',
    };
    session.exitEvent = event;
    this.publishLifecycle({ sessionId, processState: 'exited', exitCode });
    this.publish(session, event);
  }

  private retainedFromSeq(session: TerminalSessionRecord): number {
    return session.replay[0]?.event.streamSeq ?? session.streamSeq + 1;
  }

  private toMetadata(session: TerminalSessionRecord): TerminalSessionMetadata {
    return {
      id: session.id,
      title: session.title,
      workspaceId: session.workspaceId,
      cwd: session.cwd,
      cols: session.cols,
      rows: session.rows,
      status: session.status === 'exited' ? 'exited' : 'running',
      createdAt: session.createdAt,
      exitedAt: session.exitedAt,
      exitCode: session.exitCode,
      signal: session.signal,
      streamSeq: session.streamSeq,
      retainedFromSeq: this.retainedFromSeq(session),
      retainedBytes: session.retainedBytes,
      subscriberCount: session.subscribers.size,
    };
  }

  private publish(session: TerminalSessionRecord, event: TerminalStreamEvent): void {
    for (const subscriber of session.subscribers.values()) {
      if (subscriber.replaying) {
        subscriber.pending.push(event);
      } else {
        this.notify(subscriber, event);
      }
    }
  }

  private notify(subscriber: SubscriberState, event: TerminalStreamEvent): void {
    try {
      subscriber.onEvent(event);
    } catch {
      // One broken subscriber must not prevent delivery to the others.
    }
  }

  private publishLifecycle(event: TerminalSessionLifecycleEvent): void {
    for (const subscriber of this.lifecycleSubscribers) {
      try {
        subscriber(event);
      } catch {
        // Lifecycle projection must not interfere with PTY cleanup or stream delivery.
      }
    }
  }

  private enforceTotalReplayLimit(): void {
    while (this.totalRetainedBytes > this.maxReplayBytesTotal) {
      let oldestSession: TerminalSessionRecord | null = null;
      let oldestOrder = Number.POSITIVE_INFINITY;
      for (const session of this.sessions.values()) {
        const order = session.replay[0]?.order;
        if (order !== undefined && order < oldestOrder) {
          oldestOrder = order;
          oldestSession = session;
        }
      }
      if (!oldestSession || !this.discardOldestChunk(oldestSession)) break;
    }
  }

  private discardOldestChunk(session: TerminalSessionRecord): boolean {
    const discarded = session.replay.shift();
    if (!discarded) return false;
    session.retainedBytes -= discarded.bytes;
    this.totalRetainedBytes -= discarded.bytes;
    session.discardedThroughSeq = discarded.event.streamSeq;
    return true;
  }

  private removeSession(session: TerminalSessionRecord): void {
    if (session.rawPtyId) {
      this.sessionIdByRawPtyId.delete(session.rawPtyId);
    }
    session.subscribers.clear();
    this.totalRetainedBytes -= session.retainedBytes;
    session.replay = [];
    session.retainedBytes = 0;
    this.sessions.delete(session.id);
  }
}
