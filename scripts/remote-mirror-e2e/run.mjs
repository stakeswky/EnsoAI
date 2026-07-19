#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { appendMetric, assertNoSecrets, createRunArtifactDir, writeSummary } from './fixtures.mjs';
import { buildPromotionManifest } from './promotion-manifest.mjs';
import { createTcpProxy } from './tcp-proxy.mjs';
import { runDualElectronScenario } from './scenarios/dual-electron.mjs';

const suite = process.argv.includes('--suite')
  ? process.argv[process.argv.indexOf('--suite') + 1]
  : 'e2e';

const started = Date.now();
const { runId, dir } = await createRunArtifactDir();
const results = [];

function run(command, args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: process.cwd(),
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => {
      stdout += c.toString();
    });
    child.stderr.on('data', (c) => {
      stderr += c.toString();
    });
    child.on('close', (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

async function record(name, fn) {
  const begin = Date.now();
  try {
    const value = await fn();
    results.push({
      name,
      result: value?.result ?? 'passed',
      detail: value?.detail ?? null,
      ms: Date.now() - begin,
    });
  } catch (error) {
    results.push({
      name,
      result: 'failed',
      detail: error instanceof Error ? error.message : String(error),
      ms: Date.now() - begin,
    });
  }
}

await record('unit-transport', async () => {
  const out = await run('pnpm', [
    'exec',
    'vitest',
    'run',
    'src/main/services/remote/__tests__/MirrorFlowController.test.ts',
    'src/main/services/remote/__tests__/RemoteMirrorDiagnosticsServer.test.ts',
    'src/main/services/workspace/__tests__/WorkspaceMirrorLifecycleCoordinator.test.ts',
  ]);
  if (out.code !== 0) throw new Error(out.stderr || out.stdout || 'vitest failed');
  return { result: 'passed' };
});

if (suite === 'e2e' || suite === 'transport' || suite === 'reconnect' || suite === 'performance') {
  await record('tcp-proxy-smoke', async () => {
    const proxy = createTcpProxy({ targetHost: '127.0.0.1', targetPort: 9 });
    const port = await proxy.listen(0);
    if (!port) throw new Error('proxy failed to bind');
    await proxy.close();
    return { result: 'passed', detail: { port } };
  });
}

if (suite === 'reconnect') {
  await record('reconnect-cycles-scripted', async () => {
    const out = await run('pnpm', [
      'exec',
      'vitest',
      'run',
      'src/main/services/remote/__tests__/RemoteMirrorSecurity.integration.test.ts',
      'src/main/services/remote/__tests__/RemoteMirrorWebSocket.integration.test.ts',
    ]);
    if (out.code !== 0) throw new Error(out.stderr || out.stdout || 'reconnect suite failed');
    return { result: 'passed' };
  });
}

if (suite === 'performance') {
  await record('convergence-10k', async () => {
    const out = await run('pnpm', [
      'exec',
      'vitest',
      'run',
      'src/main/services/workspace/__tests__/WorkspaceConvergence.test.ts',
    ]);
    if (out.code !== 0) throw new Error(out.stderr || out.stdout || 'performance suite failed');
    return { result: 'passed' };
  });
}

if (suite === 'soak30m' || suite === 'soak8h') {
  await record(suite, async () => ({
    result: 'blocked',
    detail:
      suite === 'soak8h'
        ? '8h soak requires self-hosted runner / manual dispatch; not executed in this environment'
        : '30m soak requires long-running CI job; script contract present, execution pending environment',
  }));
}

if (suite === 'e2e') {
  await record('electron-multi-instance', async () =>
    runDualElectronScenario({ artifactDir: dir })
  );
  await record('tailnet', async () => ({
    result: 'blocked',
    detail: 'Real Tailnet dual-machine validation not executed in this environment',
  }));
}

const failed = results.some((item) => item.result === 'failed');
const blocked = results.some((item) => item.result === 'blocked');
const status = failed ? 'failed' : blocked ? 'blocked' : 'passed';

await appendMetric(dir, {
  timestamp: Date.now(),
  suite,
  durationMs: Date.now() - started,
  queuedBytes: 0,
  result: status,
});

const summary = {
  schemaVersion: 1,
  runId,
  suite,
  scope:
    suite === 'e2e'
      ? ['P12', 'P13', 'P14', 'P15', 'P16']
      : suite === 'reconnect' || suite === 'performance'
        ? ['P15']
        : suite.startsWith('soak')
          ? ['P15']
          : ['P12', 'P14'],
  branch: process.env.GITHUB_REF_NAME ?? null,
  result: status,
  durationMs: Date.now() - started,
  results,
  rollout: {
    v2DefaultEnabled: false,
    canaryStage: 'disabled',
    defaultOnDecision: 'blocked',
  },
  verification: {
    notes:
      'V2 remains default-off. blocked items require external devices, long soak, or Tailnet dual-machine.',
  },
};

const summaryJson = JSON.stringify(summary, null, 2);
assertNoSecrets(summaryJson);
await writeSummary(dir, summary);

const manifest = await buildPromotionManifest({
  outPath: join(dir, 'promotion-manifest.json'),
  tailnetValidated: false,
  soak8hValidated: false,
  crossPlatformValidated: false,
  securityReviewer: 'pending',
  verifier: 'local-harness',
});
await writeFile(join(dir, 'promotion-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

console.log(
  JSON.stringify(
    {
      runId,
      dir,
      result: status,
      failed: results.filter((r) => r.result === 'failed').map((r) => r.name),
      blocked: results.filter((r) => r.result === 'blocked').map((r) => r.name),
      promotionDecision: manifest.decision,
    },
    null,
    2
  )
);

process.exit(failed ? 1 : 0);
