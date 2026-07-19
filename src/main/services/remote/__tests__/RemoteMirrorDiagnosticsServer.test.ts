import { afterEach, describe, expect, it } from 'vitest';
import {
  type DiagnosticsHandlers,
  RemoteMirrorDiagnosticsServer,
} from '../RemoteMirrorDiagnosticsServer';

function stubHandlers(overrides: Partial<DiagnosticsHandlers> = {}): DiagnosticsHandlers {
  return {
    getHostDigest: async () => ({
      revision: 0,
      digest: 'x'.repeat(64),
      hostEpochDigest: 'y'.repeat(64),
    }),
    getClientDigest: async () => ({
      revision: null,
      digest: null,
      phase: null,
      hostEpochDigest: null,
    }),
    getMetrics: async () => ({}),
    getLifecyclePhase: async () => 'enabled',
    listConnections: async () => [],
    getRemoteHostStatus: async () => ({ running: false }),
    getRemoteClientStatus: async () => ({ state: 'disconnected' }),
    dispatchUserAction: async () => ({ ok: true }),
    ...overrides,
  };
}

async function postJson(
  port: number,
  token: string,
  body: unknown
): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${port}/v1/action`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-enso-diagnostics-token': token,
    },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    json: (await response.json()) as Record<string, unknown>,
  };
}

describe('RemoteMirrorDiagnosticsServer', () => {
  let server: RemoteMirrorDiagnosticsServer | null = null;

  afterEach(async () => {
    await server?.stop();
    server = null;
  });

  it('fails closed in packaged builds and without the test flag', async () => {
    server = new RemoteMirrorDiagnosticsServer();
    await expect(
      server.start({
        isPackaged: true,
        testFlag: '1',
        handlers: stubHandlers(),
      })
    ).rejects.toThrow(/packaged/);

    await expect(
      server.start({
        isPackaged: false,
        testFlag: undefined,
        handlers: stubHandlers(),
      })
    ).rejects.toThrow(/ENSO_REMOTE_MIRROR_TEST/);
  });

  it('serves authenticated loopback actions with strict schema', async () => {
    server = new RemoteMirrorDiagnosticsServer();
    const status = await server.start({
      isPackaged: false,
      testFlag: '1',
      handlers: stubHandlers({
        getHostDigest: async () => ({
          revision: 3,
          digest: 'a'.repeat(64),
          hostEpochDigest: 'b'.repeat(64),
        }),
      }),
    });
    expect(status.running).toBe(true);
    expect(status.port).toBeTypeOf('number');
    expect(status.token).toMatch(/^[a-f0-9]{48}$/);

    const unauthorized = await postJson(status.port!, 'wrong', {
      action: 'ping',
      requestId: 'r1',
    });
    expect(unauthorized.status).toBe(401);

    const invalid = await postJson(status.port!, status.token!, {
      action: 'eval',
      code: 'process.exit(1)',
    });
    expect(invalid.status).toBe(400);

    const ok = await postJson(status.port!, status.token!, {
      action: 'ping',
      requestId: 'r2',
    });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ ok: true, requestId: 'r2' });

    const digest = await postJson(status.port!, status.token!, {
      action: 'getHostDigest',
      requestId: 'r3',
    });
    expect(digest.json).toMatchObject({
      ok: true,
      result: { revision: 3 },
    });
    expect(JSON.stringify(digest.json)).not.toContain('token');
  });

  it('rejects non-action routes', async () => {
    server = new RemoteMirrorDiagnosticsServer();
    const status = await server.start({
      isPackaged: false,
      testFlag: '1',
      handlers: stubHandlers(),
    });
    const response = await fetch(`http://127.0.0.1:${status.port}/`, { method: 'GET' });
    expect(response.status).toBe(404);
  });
});
