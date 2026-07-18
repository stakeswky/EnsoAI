import {
  IPC_CHANNELS,
  REMOTE_PROTOCOL_VERSION,
  REMOTE_TOKEN_HEADER,
  type RemoteClientStatus,
  type RemoteConnectOptions,
  type RemoteFrame,
  type RemoteHostInfo,
} from '@shared/types';
import type { WebContents } from 'electron';
import WebSocket from 'ws';

const CONNECT_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;

/**
 * Remote PTY ids are prefixed on the client so they can never collide with
 * local PtyManager ids (both sides use a plain `pty-<n>` counter).
 */
const REMOTE_PTY_PREFIX = 'remote:';
const TERMINAL_ID_ARG_CHANNELS = new Set<string>([
  IPC_CHANNELS.TERMINAL_WRITE,
  IPC_CHANNELS.TERMINAL_RESIZE,
  IPC_CHANNELS.TERMINAL_DESTROY,
  IPC_CHANNELS.TERMINAL_GET_ACTIVITY,
]);

function stripRemotePtyId(id: unknown): unknown {
  return typeof id === 'string' && id.startsWith(REMOTE_PTY_PREFIX)
    ? id.slice(REMOTE_PTY_PREFIX.length)
    : id;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

interface Connection {
  wc: WebContents;
  options: RemoteConnectOptions;
  ws: WebSocket | null;
  state: RemoteClientStatus['state'];
  hostInfo: RemoteHostInfo | null;
  error?: string;
  pending: Map<number, PendingRequest>;
  nextReqId: number;
  reconnectTimer: NodeJS.Timeout | null;
  reconnectAttempt: number;
  disposed: boolean;
}

/**
 * Manages outgoing connections to remote EnsoAI hosts. One connection per
 * window (webContents). While attached, whitelisted IPC invokes from that
 * window are forwarded here instead of executing locally.
 */
export class RemoteClientManager {
  private connections = new Map<number, Connection>();

  isAttached(senderId: number): boolean {
    return this.connections.has(senderId);
  }

  getStatus(senderId: number): RemoteClientStatus {
    const conn = this.connections.get(senderId);
    if (!conn) {
      return { state: 'disconnected', host: null, port: null, hostInfo: null };
    }
    return {
      state: conn.state,
      host: conn.options.host,
      port: conn.options.port,
      hostInfo: conn.hostInfo,
      error: conn.error,
    };
  }

  async connect(wc: WebContents, options: RemoteConnectOptions): Promise<RemoteClientStatus> {
    // Replace any existing connection for this window
    this.disconnect(wc.id);

    const conn: Connection = {
      wc,
      options,
      ws: null,
      state: 'connecting',
      hostInfo: null,
      pending: new Map(),
      nextReqId: 1,
      reconnectTimer: null,
      reconnectAttempt: 0,
      disposed: false,
    };
    this.connections.set(wc.id, conn);
    wc.once('destroyed', () => this.disconnect(wc.id));
    this.pushStatus(conn);

    try {
      await this.openSocket(conn);
      conn.state = 'connected';
      conn.error = undefined;
      conn.reconnectAttempt = 0;
      this.pushStatus(conn);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.disposeConnection(conn);
      this.connections.delete(wc.id);
      if (!wc.isDestroyed()) {
        conn.state = 'disconnected';
        conn.error = message;
        this.pushStatus(conn);
      }
      return {
        state: 'disconnected',
        host: options.host,
        port: options.port,
        hostInfo: null,
        error: message,
      };
    }

    return this.getStatus(wc.id);
  }

  disconnect(senderId: number): void {
    const conn = this.connections.get(senderId);
    if (!conn) {
      return;
    }
    this.connections.delete(senderId);
    this.disposeConnection(conn);
    if (!conn.wc.isDestroyed()) {
      conn.state = 'disconnected';
      this.pushStatus(conn);
    }
  }

  /** Whether any window currently has an active (or reconnecting) remote connection */
  hasActiveConnection(): boolean {
    for (const conn of this.connections.values()) {
      if (conn.ws && conn.ws.readyState === WebSocket.OPEN) {
        return true;
      }
    }
    return false;
  }

  /**
   * Send a request over any active connection. Used by main-process callers
   * without a renderer context (e.g. custom protocol handlers fetching
   * preview bytes for the attached window).
   */
  requestViaAnyConnection(channel: string, args: unknown[]): Promise<unknown> {
    for (const [senderId, conn] of this.connections) {
      if (conn.ws && conn.ws.readyState === WebSocket.OPEN) {
        return this.forward(senderId, channel, args);
      }
    }
    return Promise.reject(new Error(`no active remote connection (channel: ${channel})`));
  }

  forward(senderId: number, channel: string, args: unknown[]): Promise<unknown> {
    const conn = this.connections.get(senderId);
    if (!conn || !conn.ws || conn.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`remote host not connected (channel: ${channel})`));
    }

    // Translate client-side remote PTY ids back to the host's raw ids
    let sendArgs = args;
    if (TERMINAL_ID_ARG_CHANNELS.has(channel) && args.length > 0) {
      sendArgs = [stripRemotePtyId(args[0]), ...args.slice(1)];
    }

    const id = conn.nextReqId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        reject(new Error(`remote request timed out: ${channel}`));
      }, REQUEST_TIMEOUT_MS);
      conn.pending.set(id, {
        resolve: (value) => {
          // Prefix newly created remote PTY ids on the way back
          if (channel === IPC_CHANNELS.TERMINAL_CREATE && typeof value === 'string') {
            resolve(`${REMOTE_PTY_PREFIX}${value}`);
            return;
          }
          resolve(value);
        },
        reject,
        timer,
      });
      conn.ws?.send(JSON.stringify({ t: 'req', id, ch: channel, args: sendArgs }));
    });
  }

  disposeAll(): void {
    for (const senderId of [...this.connections.keys()]) {
      this.disconnect(senderId);
    }
  }

  private openSocket(conn: Connection): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://${conn.options.host}:${conn.options.port}/`, {
        headers: { [REMOTE_TOKEN_HEADER]: conn.options.token },
        handshakeTimeout: CONNECT_TIMEOUT_MS,
      });
      conn.ws = ws;

      let settled = false;
      const helloTimer = setTimeout(() => {
        if (!settled) {
          settled = true;
          ws.terminate();
          reject(new Error('handshake timed out'));
        }
      }, CONNECT_TIMEOUT_MS);

      ws.on('message', (raw) => {
        let frame: RemoteFrame | null = null;
        try {
          frame = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (!frame) {
          return;
        }

        if (frame.t === 'hello') {
          clearTimeout(helloTimer);
          if (frame.protocolVersion !== REMOTE_PROTOCOL_VERSION) {
            settled = true;
            ws.close();
            reject(
              new Error(
                `protocol version mismatch (host: ${frame.protocolVersion}, client: ${REMOTE_PROTOCOL_VERSION}); please update both apps`
              )
            );
            return;
          }
          conn.hostInfo = frame.host;
          if (!settled) {
            settled = true;
            resolve();
          }
          return;
        }

        if (frame.t === 'res') {
          const pending = conn.pending.get(frame.id);
          if (pending) {
            conn.pending.delete(frame.id);
            clearTimeout(pending.timer);
            if (frame.ok) {
              pending.resolve(frame.result);
            } else {
              pending.reject(new Error(frame.error ?? 'remote error'));
            }
          }
          return;
        }

        if (frame.t === 'ev' && !conn.wc.isDestroyed()) {
          let payload = frame.payload;
          // Prefix PTY ids in terminal push events to match client-side ids
          if (
            (frame.ch === IPC_CHANNELS.TERMINAL_DATA || frame.ch === IPC_CHANNELS.TERMINAL_EXIT) &&
            payload.length > 0 &&
            typeof payload[0] === 'object' &&
            payload[0] !== null
          ) {
            const event = payload[0] as { id?: unknown };
            if (typeof event.id === 'string') {
              payload = [{ ...event, id: `${REMOTE_PTY_PREFIX}${event.id}` }, ...payload.slice(1)];
            }
          }
          conn.wc.send(frame.ch, ...payload);
        }
      });

      ws.on('close', (code, reason) => {
        clearTimeout(helloTimer);
        this.rejectAllPending(conn, new Error('remote connection closed'));
        conn.ws = null;

        if (!settled) {
          settled = true;
          reject(
            code === 4401
              ? new Error('authentication failed: invalid token')
              : new Error(`connection closed (${code}) ${reason.toString()}`.trim())
          );
          return;
        }

        // Unexpected close after successful handshake -> auto-reconnect
        if (!conn.disposed && this.connections.get(conn.wc.id) === conn) {
          this.scheduleReconnect(conn);
        }
      });

      ws.on('error', (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(helloTimer);
          reject(err);
        }
      });
    });
  }

  private scheduleReconnect(conn: Connection): void {
    if (conn.disposed || conn.wc.isDestroyed()) {
      return;
    }
    conn.state = 'reconnecting';
    this.pushStatus(conn);

    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * 2 ** conn.reconnectAttempt,
      RECONNECT_MAX_DELAY_MS
    );
    conn.reconnectAttempt++;

    conn.reconnectTimer = setTimeout(async () => {
      conn.reconnectTimer = null;
      if (conn.disposed || this.connections.get(conn.wc.id) !== conn) {
        return;
      }
      try {
        await this.openSocket(conn);
        conn.state = 'connected';
        conn.error = undefined;
        conn.reconnectAttempt = 0;
        this.pushStatus(conn);
      } catch (err) {
        conn.error = err instanceof Error ? err.message : String(err);
        this.scheduleReconnect(conn);
      }
    }, delay);
  }

  private disposeConnection(conn: Connection): void {
    conn.disposed = true;
    if (conn.reconnectTimer) {
      clearTimeout(conn.reconnectTimer);
      conn.reconnectTimer = null;
    }
    this.rejectAllPending(conn, new Error('remote connection disposed'));
    if (conn.ws) {
      try {
        conn.ws.close();
      } catch {
        conn.ws.terminate();
      }
      conn.ws = null;
    }
  }

  private rejectAllPending(conn: Connection, error: Error): void {
    for (const pending of conn.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    conn.pending.clear();
  }

  private pushStatus(conn: Connection): void {
    if (!conn.wc.isDestroyed()) {
      conn.wc.send(IPC_CHANNELS.REMOTE_STATUS_CHANGED, this.getStatus(conn.wc.id));
    }
  }
}

export const remoteClientManager = new RemoteClientManager();
