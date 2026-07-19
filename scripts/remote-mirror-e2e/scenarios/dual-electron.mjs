import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  createInstanceWorkspace,
  diagnosticsAction,
  ensureAppBuilt,
  launchElectronInstance,
  resolveElectronBinary,
  waitForEndpointFile,
} from '../electron-launch.mjs';

const execFileAsync = promisify(execFile);

/**
 * Dual Electron E2E:
 * 1. Host process starts remote host + V2 + seeds catalog
 * 2. Client process connects over real WS
 * 3. Digests/revisions converge
 * 4. Kill switch / disconnect restores client independence
 */
export async function runDualElectronScenario(options = {}) {
  const artifactDir = options.artifactDir;
  const bind = options.bind ?? 'localhost';
  const connectHost = options.connectHost ?? '127.0.0.1';
  const electronBinary = resolveElectronBinary();
  if (!electronBinary) {
    return {
      result: 'blocked',
      detail: 'electron binary unavailable in this environment',
    };
  }

  try {
    await ensureAppBuilt();
  } catch (error) {
    return {
      result: 'blocked',
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  const hostWs = await createInstanceWorkspace('host');
  const clientWs = await createInstanceWorkspace('client');
  const hostProc = launchElectronInstance({
    profile: hostWs.profile,
    endpointFile: hostWs.endpointFile,
  });
  const clientProc = launchElectronInstance({
    profile: clientWs.profile,
    endpointFile: clientWs.endpointFile,
  });

  const cleanup = async () => {
    await hostProc.stop();
    await clientProc.stop();
    await hostWs.cleanup();
    await clientWs.cleanup();
  };

  try {
    const hostEndpoint = await waitForEndpointFile(hostWs.endpointFile, 60_000);
    const clientEndpoint = await waitForEndpointFile(clientWs.endpointFile, 60_000);

    await diagnosticsAction(hostEndpoint, 'awaitReady', { timeoutMs: 30_000 });
    await diagnosticsAction(clientEndpoint, 'awaitReady', { timeoutMs: 30_000 });
    await new Promise((resolve) => setTimeout(resolve, 1_000));

    const hostStart = await diagnosticsAction(hostEndpoint, 'startRemoteHost', {
      port: 0,
      mirrorV2: true,
      bind,
    });
    if (!hostStart?.running || !hostStart?.token || !hostStart?.port) {
      throw new Error(`host start failed: ${JSON.stringify(hostStart)}`);
    }

    const repositoryPath = join(hostWs.dir, 'repo');
    await mkdir(repositoryPath, { recursive: true });
    await execFileAsync('git', ['init', '--initial-branch=main'], { cwd: repositoryPath });
    const seed = await diagnosticsAction(hostEndpoint, 'seedMinimalScene', { repositoryPath });
    if (!seed?.ok) {
      throw new Error(`seed failed: ${JSON.stringify(seed)}`);
    }

    const hostDigestBefore = await diagnosticsAction(hostEndpoint, 'getHostDigest');
    if (!hostDigestBefore?.digest || hostDigestBefore.revision < 1) {
      throw new Error(`host digest invalid: ${JSON.stringify(hostDigestBefore)}`);
    }

    const connect = await diagnosticsAction(clientEndpoint, 'connectRemote', {
      host: connectHost,
      port: hostStart.port,
      token: hostStart.token,
      deviceId: `e2e-client-${Date.now()}`,
    });
    if (connect?.state !== 'connected') {
      throw new Error(`client connect failed: ${JSON.stringify(connect)}`);
    }

    // Wait for client mirror to become live with matching revision.
    const deadline = Date.now() + 30_000;
    let clientDigest = null;
    let clientStatus = null;
    while (Date.now() < deadline) {
      clientStatus = await diagnosticsAction(clientEndpoint, 'getRemoteClientStatus');
      clientDigest = await diagnosticsAction(clientEndpoint, 'getClientDigest');
      if (
        clientStatus?.mirrorSyncPhase === 'live' &&
        clientDigest?.digest &&
        clientDigest.revision === hostDigestBefore.revision
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    const hostDigestAfter = await diagnosticsAction(hostEndpoint, 'getHostDigest');
    if (!clientDigest?.digest) {
      throw new Error(
        `client never reached live digest; status=${JSON.stringify(clientStatus)} digest=${JSON.stringify(clientDigest)}`
      );
    }
    if (clientDigest.digest !== hostDigestAfter.digest) {
      throw new Error(
        `digest divergence host=${hostDigestAfter.digest} client=${clientDigest.digest}`
      );
    }
    if (clientDigest.revision !== hostDigestAfter.revision) {
      throw new Error(
        `revision divergence host=${hostDigestAfter.revision} client=${clientDigest.revision}`
      );
    }

    let observerCreateRejected = false;
    try {
      await diagnosticsAction(clientEndpoint, 'createTerminal', {
        cwd: seed.repositoryPath,
        workspaceId: 'worktree-e2e',
        sessionId: `e2e-observer-terminal-${Date.now()}`,
      });
    } catch {
      observerCreateRejected = true;
    }
    if (!observerCreateRejected) {
      throw new Error('observer terminal creation unexpectedly succeeded without control');
    }

    const control = await diagnosticsAction(clientEndpoint, 'requestControl', {});
    if (!control?.ok || !control?.ownsControl) {
      throw new Error(`client control transfer failed: ${JSON.stringify(control)}`);
    }
    const terminal = await diagnosticsAction(clientEndpoint, 'createTerminal', {
      cwd: seed.repositoryPath,
      workspaceId: 'worktree-e2e',
      sessionId: `e2e-controller-terminal-${Date.now()}`,
    });
    if (!terminal?.ok || typeof terminal.sessionId !== 'string') {
      throw new Error(`controller terminal creation failed: ${JSON.stringify(terminal)}`);
    }

    const terminalDeadline = Date.now() + 30_000;
    let terminalHostDigest = hostDigestAfter;
    let terminalClientDigest = clientDigest;
    while (Date.now() < terminalDeadline) {
      terminalHostDigest = await diagnosticsAction(hostEndpoint, 'getHostDigest');
      terminalClientDigest = await diagnosticsAction(clientEndpoint, 'getClientDigest');
      if (
        terminalHostDigest.revision > hostDigestAfter.revision &&
        terminalClientDigest.revision === terminalHostDigest.revision &&
        terminalClientDigest.digest === terminalHostDigest.digest
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (
      terminalClientDigest.revision !== terminalHostDigest.revision ||
      terminalClientDigest.digest !== terminalHostDigest.digest
    ) {
      throw new Error('terminal scene did not converge after controller creation');
    }

    // Disconnect client — local scene must not retain remote projection authority.
    await diagnosticsAction(clientEndpoint, 'disconnectRemote', {});
    await new Promise((resolve) => setTimeout(resolve, 500));
    const afterDisconnect = await diagnosticsAction(clientEndpoint, 'getRemoteClientStatus');
    if (afterDisconnect?.state === 'connected') {
      throw new Error('client still connected after disconnect');
    }

    // Host remains up; disable live mirror via lifecycle path.
    const disable = await diagnosticsAction(hostEndpoint, 'disableLiveMirror', {});
    if (disable && disable.ok === false) {
      // empty scene without volatile may still succeed as ok true; blocked is failure only if unexpected
      throw new Error(`disableLiveMirror blocked: ${JSON.stringify(disable)}`);
    }

    const summary = {
      result: 'passed',
      hostRevision: hostDigestAfter.revision,
      clientRevision: clientDigest.revision,
      digestMatch: true,
      hostPort: hostStart.port,
      hostBindAddress: hostStart.bindAddress,
      connectHost,
      observerCreateRejected,
      controllerTerminalCreated: true,
      terminalRevision: terminalHostDigest.revision,
      clientFinalState: afterDisconnect?.state ?? null,
    };

    if (artifactDir) {
      await writeFile(
        join(artifactDir, 'dual-electron.json'),
        `${JSON.stringify(
          {
            ...summary,
            hostStdoutTail: hostProc.logs.stdout.slice(-4000),
            hostStderrTail: hostProc.logs.stderr.slice(-4000),
            clientStdoutTail: clientProc.logs.stdout.slice(-4000),
            clientStderrTail: clientProc.logs.stderr.slice(-4000),
          },
          null,
          2
        )}\n`,
        'utf8'
      );
    }

    return summary;
  } catch (error) {
    if (artifactDir) {
      await writeFile(
        join(artifactDir, 'dual-electron-failure.json'),
        `${JSON.stringify(
          {
            error: error instanceof Error ? error.message : String(error),
            hostStdoutTail: hostProc.logs.stdout.slice(-8000),
            hostStderrTail: hostProc.logs.stderr.slice(-8000),
            clientStdoutTail: clientProc.logs.stdout.slice(-8000),
            clientStderrTail: clientProc.logs.stderr.slice(-8000),
          },
          null,
          2
        )}\n`,
        'utf8'
      );
    }
    throw error;
  } finally {
    await cleanup();
  }
}
