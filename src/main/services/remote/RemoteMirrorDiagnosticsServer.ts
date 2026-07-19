import * as crypto from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import * as http from 'node:http';
import * as net from 'node:net';
import { z } from 'zod';

const DiagnosticsActionSchema = z.discriminatedUnion('action', [
  z.strictObject({
    action: z.literal('ping'),
    requestId: z.string().min(1).max(128),
  }),
  z.strictObject({
    action: z.literal('getHostDigest'),
    requestId: z.string().min(1).max(128),
  }),
  z.strictObject({
    action: z.literal('getClientDigest'),
    requestId: z.string().min(1).max(128),
  }),
  z.strictObject({
    action: z.literal('getMetrics'),
    requestId: z.string().min(1).max(128),
  }),
  z.strictObject({
    action: z.literal('getLifecyclePhase'),
    requestId: z.string().min(1).max(128),
  }),
  z.strictObject({
    action: z.literal('listConnections'),
    requestId: z.string().min(1).max(128),
  }),
  z.strictObject({
    action: z.literal('getRemoteHostStatus'),
    requestId: z.string().min(1).max(128),
  }),
  z.strictObject({
    action: z.literal('getRemoteClientStatus'),
    requestId: z.string().min(1).max(128),
  }),
  z.strictObject({
    action: z.literal('dispatchUserAction'),
    requestId: z.string().min(1).max(128),
    name: z.enum([
      'requestControl',
      'releaseControl',
      'selectRepository',
      'selectWorktree',
      'openEditorTab',
      'updateDirtyBuffer',
      'createTerminal',
      'writeTerminal',
      'createTodo',
      'disableLiveMirror',
      'stopRemoteHost',
      'exportVolatileHandoff',
      'discardVolatileHandoff',
      'startRemoteHost',
      'enableMirrorV2',
      'disableMirrorV2',
      'connectRemote',
      'disconnectRemote',
      'seedMinimalScene',
      'awaitReady',
    ]),
    args: z.record(z.string(), z.unknown()).default({}),
  }),
]);

export type DiagnosticsAction = z.infer<typeof DiagnosticsActionSchema>;

export interface DiagnosticsHandlers {
  getHostDigest: () => Promise<{ revision: number; digest: string; hostEpochDigest: string }>;
  getClientDigest: () => Promise<{
    revision: number | null;
    digest: string | null;
    phase: string | null;
    hostEpochDigest: string | null;
  }>;
  getMetrics: () => Promise<Record<string, number | string | null>>;
  getLifecyclePhase: () => Promise<string>;
  listConnections: () => Promise<
    Array<{ connectionId: string; protocol: string; deviceIdDigest: string | null }>
  >;
  getRemoteHostStatus: () => Promise<Record<string, unknown>>;
  getRemoteClientStatus: () => Promise<Record<string, unknown>>;
  dispatchUserAction: (
    action: Extract<DiagnosticsAction, { action: 'dispatchUserAction' }>
  ) => Promise<unknown>;
}

export interface DiagnosticsServerStatus {
  running: boolean;
  port: number | null;
  token: string | null;
  endpointFile: string | null;
}

/**
 * Loopback-only diagnostics surface for dual-Electron / harness tests.
 * Starts only when !app.isPackaged && ENSO_REMOTE_MIRROR_TEST=1.
 */
export class RemoteMirrorDiagnosticsServer {
  private server: http.Server | null = null;
  private token: string | null = null;
  private port: number | null = null;
  private handlers: DiagnosticsHandlers | null = null;
  private endpointFile: string | null = null;

  isRunning(): boolean {
    return this.server !== null;
  }

  getStatus(): DiagnosticsServerStatus {
    return {
      running: this.isRunning(),
      port: this.port,
      token: this.token,
      endpointFile: this.endpointFile,
    };
  }

  async start(options: {
    isPackaged: boolean;
    testFlag: string | undefined;
    handlers: DiagnosticsHandlers;
    preferredPort?: number;
    endpointFile?: string;
    fixedToken?: string;
  }): Promise<DiagnosticsServerStatus> {
    if (options.isPackaged) {
      throw new Error('diagnostics server is unavailable in packaged builds');
    }
    if (options.testFlag !== '1') {
      throw new Error('diagnostics server requires ENSO_REMOTE_MIRROR_TEST=1');
    }
    if (this.server) {
      return this.getStatus();
    }

    this.handlers = options.handlers;
    this.token = options.fixedToken ?? crypto.randomBytes(24).toString('hex');
    const server = http.createServer((req, res) => {
      void this.handleHttp(req, res);
    });

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.preferredPort ?? 0, '127.0.0.1', () => resolve());
    });

    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close();
      throw new Error('diagnostics server failed to bind loopback');
    }

    this.server = server;
    this.port = address.port;
    this.endpointFile = options.endpointFile ?? null;
    if (this.endpointFile && this.token && this.port) {
      const payload = {
        schemaVersion: 1,
        host: '127.0.0.1',
        port: this.port,
        token: this.token,
        pid: process.pid,
        startedAt: Date.now(),
      };
      await writeFile(this.endpointFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    }
    return this.getStatus();
  }

  async stop(): Promise<void> {
    const server = this.server;
    const endpointFile = this.endpointFile;
    this.server = null;
    this.port = null;
    this.token = null;
    this.handlers = null;
    this.endpointFile = null;
    if (endpointFile) {
      await unlink(endpointFile).catch(() => undefined);
    }
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  private async handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      if (!this.handlers || !this.token) {
        this.writeJson(res, 503, { ok: false, error: 'diagnostics unavailable' });
        return;
      }
      if (req.socket.remoteAddress && !isLoopback(req.socket.remoteAddress)) {
        this.writeJson(res, 403, { ok: false, error: 'loopback only' });
        return;
      }
      if (req.method === 'GET' && req.url === '/v1/health') {
        this.writeJson(res, 200, { ok: true, running: true });
        return;
      }
      if (req.method !== 'POST' || req.url !== '/v1/action') {
        this.writeJson(res, 404, { ok: false, error: 'not found' });
        return;
      }
      const auth = req.headers['x-enso-diagnostics-token'];
      if (typeof auth !== 'string' || !timingSafeEqual(auth, this.token)) {
        this.writeJson(res, 401, { ok: false, error: 'unauthorized' });
        return;
      }

      const body = await readBody(req, 64 * 1024);
      const parsedJson: unknown = JSON.parse(body);
      const parsed = DiagnosticsActionSchema.safeParse(parsedJson);
      if (!parsed.success) {
        this.writeJson(res, 400, { ok: false, error: 'invalid action schema' });
        return;
      }

      const result = await this.dispatch(parsed.data);
      this.writeJson(res, 200, { ok: true, requestId: parsed.data.requestId, result });
    } catch (error) {
      this.writeJson(res, 500, {
        ok: false,
        error: error instanceof Error ? error.message : 'internal error',
      });
    }
  }

  private async dispatch(action: DiagnosticsAction): Promise<unknown> {
    if (!this.handlers) throw new Error('handlers missing');
    switch (action.action) {
      case 'ping':
        return { pong: true };
      case 'getHostDigest':
        return this.handlers.getHostDigest();
      case 'getClientDigest':
        return this.handlers.getClientDigest();
      case 'getMetrics':
        return this.handlers.getMetrics();
      case 'getLifecyclePhase':
        return { phase: await this.handlers.getLifecyclePhase() };
      case 'listConnections':
        return this.handlers.listConnections();
      case 'getRemoteHostStatus':
        return this.handlers.getRemoteHostStatus();
      case 'getRemoteClientStatus':
        return this.handlers.getRemoteClientStatus();
      case 'dispatchUserAction':
        return this.handlers.dispatchUserAction(action);
      default: {
        const _exhaustive: never = action;
        return _exhaustive;
      }
    }
  }

  private writeJson(res: http.ServerResponse, status: number, body: unknown): void {
    const payload = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(payload),
    });
    res.end(payload);
  }
}

function isLoopback(address: string): boolean {
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1' ||
    address.endsWith('/127.0.0.1')
  );
}

function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function readBody(req: http.IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.byteLength;
      if (total > maxBytes) {
        reject(new Error('diagnostics body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export async function isLoopbackPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

export const remoteMirrorDiagnosticsServer = new RemoteMirrorDiagnosticsServer();
