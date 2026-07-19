import { spawn } from 'node:child_process';
import { access, readFile, mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

export function resolveElectronBinary() {
  try {
    return require('electron');
  } catch {
    return null;
  }
}

export async function ensureAppBuilt() {
  const mainEntry = join(root, 'out/main/index.js');
  try {
    await access(mainEntry);
    return mainEntry;
  } catch {
    throw new Error('out/main/index.js missing — run pnpm build first');
  }
}

export async function waitForEndpointFile(filePath, timeoutMs = 45_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const raw = await readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed?.port && parsed?.token) return parsed;
    } catch {
      // not ready
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`timed out waiting for diagnostics endpoint file: ${filePath}`);
}

export async function diagnosticsAction(endpoint, action, args = {}) {
  const requestId = `req-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  const body =
    action === 'dispatchUserAction' || action.startsWith('dispatch')
      ? {
          action: 'dispatchUserAction',
          requestId,
          name: typeof args.name === 'string' ? args.name : action,
          args: args.args ?? args,
        }
      : action === 'ping' ||
          action === 'getHostDigest' ||
          action === 'getClientDigest' ||
          action === 'getMetrics' ||
          action === 'getLifecyclePhase' ||
          action === 'listConnections' ||
          action === 'getRemoteHostStatus' ||
          action === 'getRemoteClientStatus'
        ? { action, requestId }
        : {
            action: 'dispatchUserAction',
            requestId,
            name: action,
            args,
          };

  const response = await fetch(`http://127.0.0.1:${endpoint.port}/v1/action`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-enso-diagnostics-token': endpoint.token,
    },
    body: JSON.stringify(body),
  });
  const json = await response.json();
  if (!response.ok || json.ok !== true) {
    throw new Error(
      `diagnostics ${action} failed: ${json.error ?? response.status} ${JSON.stringify(json)}`
    );
  }
  return json.result;
}

export function launchElectronInstance(options) {
  const electronBinary = resolveElectronBinary();
  if (!electronBinary) {
    throw new Error('electron binary not found');
  }
  const logs = { stdout: '', stderr: '' };
  const child = spawn(electronBinary, [root], {
    cwd: root,
    env: {
      ...process.env,
      ...options.env,
      ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      // Keep chromium from treating multiple instances as the same app lock when profiles differ.
      ENSOAI_PROFILE: options.profile,
      ENSO_REMOTE_MIRROR_TEST: '1',
      ENSO_REMOTE_MIRROR_ENDPOINT_FILE: options.endpointFile,
      ...(options.diagPort
        ? { ENSO_REMOTE_MIRROR_DIAG_PORT: String(options.diagPort) }
        : {}),
      ...(options.diagToken ? { ENSO_REMOTE_MIRROR_DIAG_TOKEN: options.diagToken } : {}),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => {
    logs.stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    logs.stderr += chunk.toString();
  });
  return {
    child,
    logs,
    async stop() {
      if (child.exitCode !== null || child.killed) return;
      child.kill('SIGTERM');
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // ignore
          }
          resolve();
        }, 5_000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

export async function createInstanceWorkspace(label) {
  const dir = join(tmpdir(), `enso-mirror-e2e-${label}-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  const endpointFile = join(dir, 'diagnostics.json');
  return {
    dir,
    endpointFile,
    profile: `mirror-e2e-${label}-${Date.now()}`,
    async cleanup() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}
