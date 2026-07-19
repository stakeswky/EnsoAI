import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createEmptyWorkspaceSceneSnapshot,
  IPC_CHANNELS,
  JsonValueSchema,
  type WorkspaceCommandExecuteFrame,
  type WorkspaceSceneSnapshot,
} from '@shared/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createRemoteWorkspaceCommandRegistry,
  digestWorkspaceCommandRequest,
  WORKSPACE_COMMAND_VERSION,
  WorkspaceCommandExecutor,
  type WorkspaceCommandRegistry,
} from '../WorkspaceCommandRegistry';
import {
  InMemoryWorkspaceStateRepository,
  type WorkspaceCommandState,
  type WorkspaceOperationRecord,
  type WorkspaceStateRepository,
} from '../WorkspaceStateRepository';

const ACTOR = { clientId: 'client-file-adapter', deviceId: 'device-file-adapter' };
const HOST_EPOCH = '11111111-1111-4111-8111-111111111111';
const ROOT_ENTITY_ID = 'repository-file-adapter';

class FailCommittedLedgerOnceRepository extends InMemoryWorkspaceStateRepository {
  private shouldFailCommittedLedger = true;

  override async compareAndSwapOperation<TResult = unknown>(
    operationId: string,
    expectedState: WorkspaceCommandState,
    operation: WorkspaceOperationRecord<TResult>
  ): Promise<boolean> {
    if (
      this.shouldFailCommittedLedger &&
      expectedState === 'executing' &&
      operation.state === 'committed'
    ) {
      this.shouldFailCommittedLedger = false;
      throw new Error('injected ledger commit failure');
    }
    return super.compareAndSwapOperation(operationId, expectedState, operation);
  }
}

function commandFrame(
  operationId: string,
  command: string,
  args: WorkspaceCommandExecuteFrame['args']
): WorkspaceCommandExecuteFrame {
  return {
    t: 'command.execute',
    operationId,
    clientSeq: 1,
    command,
    commandVersion: WORKSPACE_COMMAND_VERSION,
    requestDigest: digestWorkspaceCommandRequest(command, WORKSPACE_COMMAND_VERSION, args),
    args,
  };
}

function createSnapshot(rootPath: string): WorkspaceSceneSnapshot {
  const snapshot = createEmptyWorkspaceSceneSnapshot({
    hostId: 'host-file-adapter',
    sceneId: 'scene-file-adapter',
    hostEpoch: HOST_EPOCH,
  });
  snapshot.catalog.repositories[ROOT_ENTITY_ID] = {
    id: ROOT_ENTITY_ID,
    path: rootPath,
    name: 'file-adapter',
    groupId: null,
    order: 0,
    settings: { autoInitWorktree: false, initScript: '', hidden: false },
  };
  return snapshot;
}

function createHarness(
  snapshot: WorkspaceSceneSnapshot,
  repository: WorkspaceStateRepository = new InMemoryWorkspaceStateRepository({ snapshot })
): {
  executor: WorkspaceCommandExecutor;
  registry: WorkspaceCommandRegistry;
  repository: WorkspaceStateRepository;
} {
  const registry = createRemoteWorkspaceCommandRegistry({ getSnapshot: () => snapshot });
  let now = 100;
  return {
    repository,
    registry,
    executor: new WorkspaceCommandExecutor({
      repository,
      registry,
      sceneId: snapshot.sceneId,
      getRevision: () => snapshot.revision,
      clock: { now: () => now++ },
    }),
  };
}

async function seedExecutingOperation(
  harness: ReturnType<typeof createHarness>,
  frame: WorkspaceCommandExecuteFrame
): Promise<WorkspaceOperationRecord> {
  const descriptor = harness.registry.lookup(frame.command);
  if (!descriptor?.prepare) throw new Error(`missing file command adapter: ${frame.command}`);
  const reconcileMetadata = JsonValueSchema.parse(await descriptor.prepare(frame.args));
  const prepared: WorkspaceOperationRecord = {
    operationId: frame.operationId,
    intentKind: frame.command,
    sceneId: 'scene-file-adapter',
    ...ACTOR,
    commandVersion: frame.commandVersion,
    requestDigest: frame.requestDigest,
    reconcileMetadata,
    state: 'prepared',
    baseRevision: 0,
    createdAt: 1,
    updatedAt: 1,
  };
  await harness.repository.saveOperation(prepared);
  const executing: WorkspaceOperationRecord = { ...prepared, state: 'executing', updatedAt: 2 };
  await expect(
    harness.repository.compareAndSwapOperation(frame.operationId, 'prepared', executing)
  ).resolves.toBe(true);
  return executing;
}

async function copyDirectoryMerge(source: string, target: string): Promise<void> {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name);
    const targetPath = join(target, entry.name);
    if (entry.isDirectory()) {
      await copyDirectoryMerge(sourcePath, targetPath);
    } else {
      await copyFile(sourcePath, targetPath);
    }
  }
}

describe('FileWorkspaceCommandAdapters', () => {
  let temporaryDirectory: string;
  let workspaceRoot: string;
  let snapshot: WorkspaceSceneSnapshot;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'enso-file-command-adapter-'));
    workspaceRoot = join(temporaryDirectory, 'repository');
    await mkdir(workspaceRoot);
    snapshot = createSnapshot(workspaceRoot);
  });

  afterEach(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it('commits a verified write, returns a lost acknowledgement without replay, and stores safe metadata', async () => {
    const target = join(workspaceRoot, 'notes.txt');
    const content = 'file-content-canary-that-must-not-enter-the-ledger';
    await writeFile(target, 'before');
    const harness = createHarness(snapshot);
    const frame = commandFrame('write-lost-ack', IPC_CHANNELS.FILE_WRITE, [target, content]);
    const invoke = vi.fn(async () => writeFile(target, content));
    const execution = { frame, actor: ACTOR, authorize: async () => null, invoke };

    await expect(harness.executor.execute(execution)).resolves.toMatchObject({
      state: 'committed',
      resultExpired: false,
    });
    await expect(harness.executor.execute(execution)).resolves.toMatchObject({
      state: 'committed',
      resultExpired: false,
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    await expect(readFile(target, 'utf8')).resolves.toBe(content);

    const operation = await harness.repository.loadOperation(frame.operationId);
    expect(operation?.reconcileMetadata).toMatchObject({
      domain: 'file',
      effects: [
        {
          effect: 'replace',
          target: { rootEntityId: ROOT_ENTITY_ID, relativePath: 'notes.txt' },
          expected: { kind: 'file', size: Buffer.byteLength(content), digest: expect.any(String) },
        },
      ],
    });
    const serialized = JSON.stringify(operation);
    expect(serialized).not.toContain(workspaceRoot);
    expect(serialized).not.toContain(content);
  });

  it('adopts a verified effect after the committed-ledger write fails', async () => {
    const target = join(workspaceRoot, 'recover-write.txt');
    await writeFile(target, 'before');
    const repository = new FailCommittedLedgerOnceRepository({ snapshot });
    const first = createHarness(snapshot, repository);
    const frame = commandFrame('write-recover', IPC_CHANNELS.FILE_WRITE, [target, 'after']);
    const invoke = vi.fn(async () => writeFile(target, 'after'));

    await expect(
      first.executor.execute({ frame, actor: ACTOR, authorize: async () => null, invoke })
    ).resolves.toMatchObject({ state: 'needs_reconcile', error: { code: 'UNKNOWN' } });
    expect(await repository.loadOperation(frame.operationId)).toMatchObject({
      state: 'needs_reconcile',
    });

    const restarted = createHarness(snapshot, repository);
    await restarted.executor.recover();
    expect(await repository.loadOperation(frame.operationId)).toMatchObject({ state: 'committed' });
    expect(invoke).toHaveBeenCalledTimes(1);
    await expect(readFile(target, 'utf8')).resolves.toBe('after');
  });

  it('reconciles rename and move effects as committed, failed, or unknown without replay', async () => {
    const committedSource = join(workspaceRoot, 'rename-source.txt');
    const committedTarget = join(workspaceRoot, 'rename-target.txt');
    const failedSource = join(workspaceRoot, 'move-source.txt');
    const failedTarget = join(workspaceRoot, 'move-target.txt');
    const unknownSource = join(workspaceRoot, 'unknown-source.txt');
    const unknownTarget = join(workspaceRoot, 'unknown-target.txt');
    await Promise.all([
      writeFile(committedSource, 'rename-content'),
      writeFile(failedSource, 'move-content'),
      writeFile(unknownSource, 'unknown-source-content'),
    ]);
    const harness = createHarness(snapshot);
    const committed = commandFrame('rename-committed', IPC_CHANNELS.FILE_RENAME, [
      committedSource,
      committedTarget,
    ]);
    const failed = commandFrame('move-failed', IPC_CHANNELS.FILE_MOVE, [
      failedSource,
      failedTarget,
    ]);
    const unknown = commandFrame('rename-unknown', IPC_CHANNELS.FILE_RENAME, [
      unknownSource,
      unknownTarget,
    ]);
    await seedExecutingOperation(harness, committed);
    await seedExecutingOperation(harness, failed);
    await seedExecutingOperation(harness, unknown);

    await rename(committedSource, committedTarget);
    await writeFile(unknownTarget, 'unexpected-third-party-content');
    await harness.executor.recover();

    expect(await harness.repository.loadOperation(committed.operationId)).toMatchObject({
      state: 'committed',
    });
    expect(await harness.repository.loadOperation(failed.operationId)).toMatchObject({
      state: 'failed',
      error: { code: 'CONFLICT' },
    });
    expect(await harness.repository.loadOperation(unknown.operationId)).toMatchObject({
      state: 'needs_reconcile',
      error: { code: 'UNKNOWN' },
    });
    await expect(readFile(committedTarget, 'utf8')).resolves.toBe('rename-content');
    await expect(readFile(failedSource, 'utf8')).resolves.toBe('move-content');
    await expect(readFile(unknownSource, 'utf8')).resolves.toBe('unknown-source-content');
  });

  it('verifies the merged digest when copying a directory over an existing directory', async () => {
    const source = join(workspaceRoot, 'copy-source');
    const target = join(workspaceRoot, 'copy-target');
    await Promise.all([
      mkdir(join(source, 'nested'), { recursive: true }),
      mkdir(join(target, 'nested'), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(source, 'source.txt'), 'source'),
      writeFile(join(source, 'nested', 'replace.txt'), 'replacement'),
      writeFile(join(target, 'retained.txt'), 'retained'),
      writeFile(join(target, 'nested', 'replace.txt'), 'old'),
      writeFile(join(target, 'nested', 'retained-nested.txt'), 'retained-nested'),
    ]);
    const harness = createHarness(snapshot);
    const frame = commandFrame('copy-directory-merge', IPC_CHANNELS.FILE_COPY, [source, target]);

    await expect(
      harness.executor.execute({
        frame,
        actor: ACTOR,
        authorize: async () => null,
        invoke: async () => copyDirectoryMerge(source, target),
      })
    ).resolves.toMatchObject({ state: 'committed' });
    await expect(readFile(join(target, 'source.txt'), 'utf8')).resolves.toBe('source');
    await expect(readFile(join(target, 'retained.txt'), 'utf8')).resolves.toBe('retained');
    await expect(readFile(join(target, 'nested', 'replace.txt'), 'utf8')).resolves.toBe(
      'replacement'
    );
    await expect(readFile(join(target, 'nested', 'retained-nested.txt'), 'utf8')).resolves.toBe(
      'retained-nested'
    );
    expect(await harness.repository.loadOperation(frame.operationId)).toMatchObject({
      reconcileMetadata: {
        effects: [
          { expected: { kind: 'directory', digest: expect.stringMatching(/^[a-f0-9]{64}$/) } },
        ],
      },
    });
  });

  it('commits a delete postcondition and never invokes it again', async () => {
    const target = join(workspaceRoot, 'delete-me.txt');
    await writeFile(target, 'delete-content');
    const harness = createHarness(snapshot);
    const frame = commandFrame('delete-file', IPC_CHANNELS.FILE_DELETE, [target]);
    const invoke = vi.fn(async () => rm(target));
    const execution = { frame, actor: ACTOR, authorize: async () => null, invoke };

    await expect(harness.executor.execute(execution)).resolves.toMatchObject({
      state: 'committed',
    });
    await expect(harness.executor.execute(execution)).resolves.toMatchObject({
      state: 'committed',
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    await expect(readFile(target, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('records a partially applied batch move as failed without moving the remaining source', async () => {
    const firstSource = join(workspaceRoot, 'batch-first.txt');
    const secondSource = join(workspaceRoot, 'batch-second.txt');
    const targetDirectory = join(workspaceRoot, 'batch-target');
    await mkdir(targetDirectory);
    await Promise.all([writeFile(firstSource, 'first'), writeFile(secondSource, 'second')]);
    const harness = createHarness(snapshot);
    const frame = commandFrame('batch-partial', IPC_CHANNELS.FILE_BATCH_MOVE, [
      [firstSource, secondSource],
      targetDirectory,
      [],
    ]);
    await seedExecutingOperation(harness, frame);

    await rename(firstSource, join(targetDirectory, 'batch-first.txt'));
    await harness.executor.recover();

    expect(await harness.repository.loadOperation(frame.operationId)).toMatchObject({
      state: 'failed',
      error: { code: 'CONFLICT' },
    });
    await expect(readFile(join(targetDirectory, 'batch-first.txt'), 'utf8')).resolves.toBe('first');
    await expect(readFile(secondSource, 'utf8')).resolves.toBe('second');
  });

  it('rejects a symbolic-link target during prepare without saving or invoking the command', async () => {
    const outside = join(temporaryDirectory, 'outside.txt');
    const link = join(workspaceRoot, 'linked.txt');
    await writeFile(outside, 'outside-content');
    await symlink(outside, link, 'file');
    const harness = createHarness(snapshot);
    const frame = commandFrame('symlink-write', IPC_CHANNELS.FILE_WRITE, [link, 'replacement']);
    const invoke = vi.fn();

    await expect(
      harness.executor.execute({ frame, actor: ACTOR, authorize: async () => null, invoke })
    ).resolves.toMatchObject({ state: 'failed', error: { code: 'CONFLICT' } });
    await expect(harness.repository.loadOperation(frame.operationId)).resolves.toBeNull();
    expect(invoke).not.toHaveBeenCalled();
    await expect(readFile(outside, 'utf8')).resolves.toBe('outside-content');
  });
});
