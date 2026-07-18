import * as crypto from 'node:crypto';
import * as http from 'node:http';
import * as os from 'node:os';
import {
  IPC_CHANNELS,
  REMOTE_PROTOCOL_VERSION,
  REMOTE_TOKEN_HEADER,
  type RemoteFrame,
  type RemoteHostSettings,
  type RemoteHostStatus,
  type RemoteReqFrame,
} from '@shared/types';
import { app, BrowserWindow, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { type WebSocket, WebSocketServer } from 'ws';
import { getRegisteredHandler } from './handlerRegistry';

const HEARTBEAT_INTERVAL_MS = 15_000;
/** Synthetic sender ids start high to never collide with real webContents ids */
let nextVirtualSenderId = 1_000_000;

interface ClientConnection {
  ws: WebSocket;
  senderId: number;
  alive: boolean;
  destroyedCallbacks: Array<() => void>;
}

/** Detect a Tailscale IPv4 address (CGNAT range 100.64.0.0/10) */
export function detectTailscaleAddress(): string | null {
  const interfaces = os.networkInterfaces();
  for (const addrs of Object.values(interfaces)) {
    for (const addr of addrs ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) {
        continue;
      }
      const octets = addr.address.split('.').map(Number);
      if (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) {
        return addr.address;
      }
    }
  }
  return null;
}

export function generateRemoteToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Minimal WebContents stand-in for remote connections. Handlers only use
 * id / send / isDestroyed / once('destroyed'), which all map cleanly onto
 * the WebSocket connection lifecycle (e.g. PtyManager owner cleanup).
 */
function createVirtualSender(conn: ClientConnection): WebContents {
  const virtualSender = {
    id: conn.senderId,
    send: (channel: string, ...args: unknown[]): void => {
      if (conn.ws.readyState === conn.ws.OPEN) {
        conn.ws.send(JSON.stringify({ t: 'ev', ch: channel, payload: args }));
      }
    },
    isDestroyed: (): boolean => conn.ws.readyState !== conn.ws.OPEN,
    once: (event: string, callback: () => void) => {
      if (event === 'destroyed') {
        conn.destroyedCallbacks.push(callback);
      }
      return virtualSender;
    },
    on: (event: string, callback: () => void) => {
      if (event === 'destroyed') {
        conn.destroyedCallbacks.push(callback);
      }
      return virtualSender;
    },
  };
  return virtualSender as unknown as WebContents;
}

export class RemoteHostServer {
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private clients = new Set<ClientConnection>();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private config: RemoteHostSettings | null = null;
  private bindAddress: string | null = null;
  private lastError: string | undefined;

  isRunning(): boolean {
    return this.server !== null;
  }

  getStatus(): RemoteHostStatus {
    return {
      running: this.isRunning(),
      port: this.config?.port ?? 0,
      bindAddress: this.bindAddress,
      tailscaleAddress: detectTailscaleAddress(),
      token: this.config?.token ?? null,
      clientCount: this.clients.size,
      error: this.lastError,
    };
  }

  async start(config: RemoteHostSettings): Promise<RemoteHostStatus> {
    if (this.isRunning()) {
      await this.stop();
    }
    this.config = config;
    this.lastError = undefined;

    const bindAddress = this.resolveBindAddress(config.bind);

    try {
      await new Promise<void>((resolve, reject) => {
        const server = http.createServer((_req, res) => {
          res.writeHead(404);
          res.end();
        });
        const wss = new WebSocketServer({ server });

        wss.on('connection', (ws, req) => this.handleConnection(ws, req));

        server.on('error', (err) => {
          this.lastError = err.message;
          reject(err);
        });
        server.listen(config.port, bindAddress, () => {
          this.server = server;
          this.wss = wss;
          this.bindAddress = bindAddress;
          resolve();
        });
      });

      this.heartbeatTimer = setInterval(() => this.checkHeartbeats(), HEARTBEAT_INTERVAL_MS);
      console.log(`[remote-host] listening on ${bindAddress}:${config.port}`);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.server = null;
      this.wss = null;
      this.bindAddress = null;
    }

    this.broadcastStatus();
    return this.getStatus();
  }

  async stop(): Promise<void> {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const conn of [...this.clients]) {
      this.disposeConnection(conn);
    }
    this.clients.clear();

    const server = this.server;
    const wss = this.wss;
    this.server = null;
    this.wss = null;
    this.bindAddress = null;

    if (wss) {
      wss.close();
    }
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    this.broadcastStatus();
  }

  stopSync(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const conn of [...this.clients]) {
      this.disposeConnection(conn);
    }
    this.clients.clear();
    this.wss?.close();
    this.server?.close();
    this.wss = null;
    this.server = null;
    this.bindAddress = null;
  }

  /**
   * Fan a broadcast channel out to all connected remote clients. Used for
   * events that are normally sent to all BrowserWindows (agent notifications,
   * git auto-fetch completion) — virtual senders are not in getAllWindows().
   */
  broadcastToClients(channel: string, ...args: unknown[]): void {
    if (this.clients.size === 0) {
      return;
    }
    const frame = JSON.stringify({ t: 'ev', ch: channel, payload: args });
    for (const conn of this.clients) {
      if (conn.ws.readyState === conn.ws.OPEN) {
        conn.ws.send(frame);
      }
    }
  }

  /** Disconnect all clients (e.g. after token regeneration) */
  disconnectAllClients(): void {
    for (const conn of [...this.clients]) {
      conn.ws.close(4401, 'token changed');
      this.disposeConnection(conn);
    }
    this.clients.clear();
    this.broadcastStatus();
  }

  updateToken(token: string): void {
    if (this.config) {
      this.config.token = token;
    }
    this.disconnectAllClients();
  }

  private resolveBindAddress(bind: RemoteHostSettings['bind']): string {
    if (bind === 'all') {
      return '0.0.0.0';
    }
    if (bind === 'localhost') {
      return '127.0.0.1';
    }
    // Default: bind Tailscale interface only, fall back to localhost
    return detectTailscaleAddress() ?? '127.0.0.1';
  }

  private handleConnection(ws: WebSocket, req: http.IncomingMessage): void {
    const token = this.config?.token;
    const provided = req.headers[REMOTE_TOKEN_HEADER];
    if (!token || typeof provided !== 'string' || !timingSafeEqual(provided, token)) {
      ws.close(4401, 'unauthorized');
      return;
    }

    const conn: ClientConnection = {
      ws,
      senderId: nextVirtualSenderId++,
      alive: true,
      destroyedCallbacks: [],
    };
    this.clients.add(conn);
    const virtualSender = createVirtualSender(conn);
    const virtualEvent = { sender: virtualSender } as unknown as IpcMainInvokeEvent;

    ws.on('pong', () => {
      conn.alive = true;
    });

    ws.on('message', (raw) => {
      let frame: RemoteFrame | null = null;
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (frame?.t === 'req') {
        void this.dispatchRequest(conn, virtualEvent, frame);
      }
    });

    ws.on('close', () => {
      this.clients.delete(conn);
      this.disposeConnection(conn);
      this.broadcastStatus();
    });

    ws.on('error', () => {
      // 'close' follows; nothing to do
    });

    ws.send(
      JSON.stringify({
        t: 'hello',
        protocolVersion: REMOTE_PROTOCOL_VERSION,
        host: {
          platform: process.platform as 'darwin' | 'win32' | 'linux',
          home: os.homedir(),
          hostname: os.hostname(),
          appVersion: app.getVersion(),
        },
      })
    );

    console.log(`[remote-host] client connected (sender ${conn.senderId})`);
    this.broadcastStatus();
  }

  private async dispatchRequest(
    conn: ClientConnection,
    virtualEvent: IpcMainInvokeEvent,
    frame: RemoteReqFrame
  ): Promise<void> {
    const reply = (ok: boolean, result?: unknown, error?: string): void => {
      if (conn.ws.readyState === conn.ws.OPEN) {
        conn.ws.send(JSON.stringify({ t: 'res', id: frame.id, ok, result, error }));
      }
    };

    const handler = getRegisteredHandler(frame.ch);
    if (!handler) {
      reply(false, undefined, `no handler for channel: ${frame.ch}`);
      return;
    }

    try {
      const result = await handler(virtualEvent, ...frame.args);
      reply(true, result);
    } catch (err) {
      reply(false, undefined, err instanceof Error ? err.message : String(err));
    }
  }

  private disposeConnection(conn: ClientConnection): void {
    const callbacks = conn.destroyedCallbacks;
    conn.destroyedCallbacks = [];
    for (const callback of callbacks) {
      try {
        callback();
      } catch (err) {
        console.warn('[remote-host] destroyed callback error:', err);
      }
    }
    if (conn.ws.readyState === conn.ws.OPEN) {
      conn.ws.close();
    }
  }

  private checkHeartbeats(): void {
    for (const conn of [...this.clients]) {
      if (!conn.alive) {
        conn.ws.terminate();
        continue;
      }
      conn.alive = false;
      try {
        conn.ws.ping();
      } catch {
        conn.ws.terminate();
      }
    }
  }

  private broadcastStatus(): void {
    const status = this.getStatus();
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.webContents.isDestroyed()) {
        window.webContents.send(IPC_CHANNELS.REMOTE_HOST_STATUS_CHANGED, status);
      }
    }
  }
}

export const remoteHostServer = new RemoteHostServer();

/**
 * Convenience for broadcast call sites outside the remote module. Safe to
 * call whether or not the host server is running.
 */
export function broadcastToRemoteClients(channel: string, ...args: unknown[]): void {
  remoteHostServer.broadcastToClients(channel, ...args);
}
