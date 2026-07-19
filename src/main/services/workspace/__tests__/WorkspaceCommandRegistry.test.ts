import {
  encodeWorkspaceCommandArgs,
  IPC_CHANNELS,
  type WorkspaceCommandExecuteFrame,
} from '@shared/types';
import { describe, expect, it, vi } from 'vitest';
import {
  createRemoteWorkspaceCommandRegistry,
  digestWorkspaceCommandRequest,
  WORKSPACE_COMMAND_VERSION,
  WorkspaceCommandExecutor,
} from '../WorkspaceCommandRegistry';
import {
  InMemoryWorkspaceStateRepository,
  type WorkspaceCommandState,
  type WorkspaceOperationRecord,
} from '../WorkspaceStateRepository';

const ACTOR = { clientId: 'client-1', deviceId: 'device-1' };

function commandFrame(
  operationId: string,
  command: string = IPC_CHANNELS.FILE_CREATE_DIR,
  args: WorkspaceCommandExecuteFrame['args'] = ['/host/repository/new-directory']
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

function operation(
  operationId: string,
  state: WorkspaceOperationRecord['state']
): WorkspaceOperationRecord {
  const frame = commandFrame(operationId, IPC_CHANNELS.FILE_CREATE);
  return {
    operationId,
    intentKind: frame.command,
    sceneId: 'scene-1',
    ...ACTOR,
    commandVersion: frame.commandVersion,
    requestDigest: frame.requestDigest,
    state,
    baseRevision: 0,
    createdAt: 1,
    updatedAt: 1,
  };
}

function harness(
  repository = new InMemoryWorkspaceStateRepository(),
  options: {
    clock?: { now(): number };
    volatileResultCache?: { ttlMs?: number; maxEntries?: number; maxBytes?: number };
  } = {}
) {
  let now = 10;
  return {
    repository,
    executor: new WorkspaceCommandExecutor({
      repository,
      registry: createRemoteWorkspaceCommandRegistry(),
      sceneId: 'scene-1',
      getRevision: () => 4,
      clock: options.clock ?? { now: () => now++ },
      volatileResultCache: options.volatileResultCache,
    }),
  };
}

class ThrowAfterCommittedLedgerRepository extends InMemoryWorkspaceStateRepository {
  private throwAfterCommit = true;

  override async compareAndSwapOperation<TResult = unknown>(
    operationId: string,
    expectedState: WorkspaceCommandState,
    candidate: WorkspaceOperationRecord<TResult>
  ): Promise<boolean> {
    const stored = await super.compareAndSwapOperation(operationId, expectedState, candidate);
    if (
      stored &&
      this.throwAfterCommit &&
      expectedState === 'executing' &&
      candidate.state === 'committed'
    ) {
      this.throwAfterCommit = false;
      throw new Error('injected crash after committed ledger write');
    }
    return stored;
  }
}

describe('WorkspaceCommandExecutor', () => {
  it('returns the volatile result after a lost acknowledgement without repeating the effect', async () => {
    const { executor, repository } = harness();
    const frame = commandFrame('lost-ack', IPC_CHANNELS.TEMP_WORKSPACE_CHECK_PATH, [
      '/host/repository/new-directory',
    ]);
    const invoke = vi.fn(async () => ({ ok: true as const }));
    const execution = {
      frame,
      actor: ACTOR,
      authorize: async () => null,
      invoke,
    };

    await expect(executor.execute(execution)).resolves.toMatchObject({
      state: 'committed',
      result: { ok: true },
      resultExpired: false,
    });
    await expect(executor.execute(execution)).resolves.toMatchObject({
      state: 'committed',
      result: { ok: true },
      resultExpired: false,
    });
    await expect(
      executor.status(frame.operationId, ACTOR, 'status-lost-ack')
    ).resolves.toMatchObject({
      result: {
        requestId: 'status-lost-ack',
        state: 'committed',
        result: { ok: true },
        resultExpired: false,
      },
    });

    const restarted = harness(repository).executor;
    await expect(restarted.execute(execution)).resolves.toMatchObject({
      state: 'committed',
      resultExpired: true,
      error: { code: 'RESULT_EXPIRED', retryable: false },
    });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('expires volatile command results after their TTL', async () => {
    let now = 100;
    const { executor } = harness(new InMemoryWorkspaceStateRepository(), {
      clock: { now: () => now },
      volatileResultCache: { ttlMs: 10 },
    });
    const frame = commandFrame('ttl-result', IPC_CHANNELS.TEMP_WORKSPACE_CHECK_PATH, [
      '/host/repository',
    ]);
    const execution = {
      frame,
      actor: ACTOR,
      authorize: async () => null,
      invoke: vi.fn(async () => ({ ok: true as const })),
    };

    await expect(executor.execute(execution)).resolves.toMatchObject({ resultExpired: false });
    now = 111;
    await expect(executor.status(frame.operationId, ACTOR)).resolves.toMatchObject({
      result: {
        state: 'committed',
        resultExpired: true,
        error: { code: 'RESULT_EXPIRED' },
      },
    });
    expect(execution.invoke).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['entry', { maxEntries: 1, maxBytes: 1_024 }],
    ['byte', { maxEntries: 10, maxBytes: 15 }],
  ] as const)('bounds the volatile cache by %s budget', async (_budget, limits) => {
    const { executor } = harness(new InMemoryWorkspaceStateRepository(), {
      volatileResultCache: { ttlMs: 1_000, ...limits },
    });
    const firstFrame = commandFrame(
      `bounded-${_budget}-first`,
      IPC_CHANNELS.TEMP_WORKSPACE_CHECK_PATH,
      ['/host/first']
    );
    const secondFrame = commandFrame(
      `bounded-${_budget}-second`,
      IPC_CHANNELS.TEMP_WORKSPACE_CHECK_PATH,
      ['/host/second']
    );
    const firstInvoke = vi.fn(async () => ({ ok: true as const }));
    const secondInvoke = vi.fn(async () => ({ ok: true as const }));
    const firstExecution = {
      frame: firstFrame,
      actor: ACTOR,
      authorize: async () => null,
      invoke: firstInvoke,
    };
    const secondExecution = {
      frame: secondFrame,
      actor: ACTOR,
      authorize: async () => null,
      invoke: secondInvoke,
    };

    await executor.execute(firstExecution);
    await executor.execute(secondExecution);
    await expect(executor.execute(firstExecution)).resolves.toMatchObject({
      state: 'committed',
      resultExpired: true,
      error: { code: 'RESULT_EXPIRED' },
    });
    await expect(executor.execute(secondExecution)).resolves.toMatchObject({
      state: 'committed',
      result: { ok: true },
      resultExpired: false,
    });
    expect(firstInvoke).toHaveBeenCalledTimes(1);
    expect(secondInvoke).toHaveBeenCalledTimes(1);
  });

  it('retains a validated commit object ID for lost-ack recovery', async () => {
    const { executor } = harness();
    const args = encodeWorkspaceCommandArgs(['/host/repository', 'Commit message']);
    const frame = commandFrame('commit-lost-ack', IPC_CHANNELS.GIT_COMMIT, args);
    const invoke = vi.fn(async () => '0123456789abcdef0123456789abcdef01234567');
    const execution = { frame, actor: ACTOR, authorize: async () => null, invoke };

    await expect(executor.execute(execution)).resolves.toMatchObject({
      state: 'committed',
      result: '0123456789abcdef0123456789abcdef01234567',
      resultExpired: false,
    });
    await expect(executor.execute(execution)).resolves.toMatchObject({
      state: 'committed',
      result: '0123456789abcdef0123456789abcdef01234567',
      resultExpired: false,
    });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('adopts a committed ledger after a crash before the result was sent', async () => {
    const repository = new ThrowAfterCommittedLedgerRepository();
    const { executor } = harness(repository);
    const frame = commandFrame('after-ledger-before-result');
    const invoke = vi.fn(async () => undefined);
    const execution = { frame, actor: ACTOR, authorize: async () => null, invoke };

    await expect(executor.execute(execution)).resolves.toMatchObject({
      state: 'needs_reconcile',
      error: { code: 'UNKNOWN' },
    });
    await expect(executor.execute(execution)).resolves.toMatchObject({ state: 'committed' });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('keeps an uncertain Todo AI effect UNKNOWN and never replays it automatically', async () => {
    const { executor } = harness();
    const args = encodeWorkspaceCommandArgs([
      {
        text: 'Improve this task',
        timeout: 30_000,
        provider: 'claude-code',
        model: 'default',
      },
    ]);
    const frame = commandFrame('todo-ai-unknown', IPC_CHANNELS.TODO_AI_POLISH, args);
    const invoke = vi.fn(async () => {
      throw new Error('injected lost external-service acknowledgement');
    });
    const execution = { frame, actor: ACTOR, authorize: async () => null, invoke };

    await expect(executor.execute(execution)).resolves.toMatchObject({
      state: 'needs_reconcile',
      error: { code: 'UNKNOWN' },
    });
    await expect(executor.execute(execution)).resolves.toMatchObject({
      state: 'needs_reconcile',
      error: { code: 'UNKNOWN' },
    });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('rejects operation ID collisions before invoking a handler', async () => {
    const { executor } = harness();
    const first = commandFrame('collision', IPC_CHANNELS.FILE_CREATE_DIR, ['/host/a']);
    const second = commandFrame('collision', IPC_CHANNELS.FILE_CREATE_DIR, ['/host/b']);
    const invoke = vi.fn(async () => true);

    await executor.execute({ frame: first, actor: ACTOR, authorize: async () => null, invoke });
    await expect(
      executor.execute({ frame: second, actor: ACTOR, authorize: async () => null, invoke })
    ).resolves.toMatchObject({ state: 'failed', error: { code: 'CONFLICT' } });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('treats every immutable binding dimension as a conflict before version dispatch', async () => {
    const repository = new InMemoryWorkspaceStateRepository({
      operations: [operation('bound-operation', 'committed')],
    });
    const base = commandFrame('bound-operation', IPC_CHANNELS.FILE_CREATE);
    const invoke = vi.fn();
    const cases: Array<{
      executor: WorkspaceCommandExecutor;
      frame: WorkspaceCommandExecuteFrame;
      actor: typeof ACTOR;
    }> = [
      { ...harness(repository), frame: base, actor: { ...ACTOR, clientId: 'client-2' } },
      { ...harness(repository), frame: base, actor: { ...ACTOR, deviceId: 'device-2' } },
      {
        ...harness(repository),
        frame: {
          ...base,
          commandVersion: 2,
          requestDigest: digestWorkspaceCommandRequest(base.command, 2, base.args),
        },
        actor: ACTOR,
      },
      {
        ...harness(repository),
        frame: commandFrame('bound-operation', IPC_CHANNELS.FILE_CREATE_DIR, ['/host/other']),
        actor: ACTOR,
      },
      {
        executor: new WorkspaceCommandExecutor({
          repository,
          registry: createRemoteWorkspaceCommandRegistry(),
          sceneId: 'scene-2',
          getRevision: () => 0,
        }),
        frame: base,
        actor: ACTOR,
      },
    ];

    for (const candidate of cases) {
      await expect(
        candidate.executor.execute({
          frame: candidate.frame,
          actor: candidate.actor,
          authorize: async () => null,
          invoke,
        })
      ).resolves.toMatchObject({ state: 'failed', error: { code: 'CONFLICT' } });
    }
    expect(invoke).not.toHaveBeenCalled();
  });

  it('allows only one concurrent effect for the same operation binding', async () => {
    const { executor } = harness();
    const frame = commandFrame('concurrent-operation');
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const invoke = vi.fn(async () => {
      await blocked;
      return undefined;
    });
    const execution = { frame, actor: ACTOR, authorize: async () => null, invoke };

    const first = executor.execute(execution);
    const second = executor.execute(execution);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(1));
    release?.();

    await expect(first).resolves.toMatchObject({ state: 'committed' });
    await expect(second).resolves.toMatchObject({
      state: expect.stringMatching(/executing|committed/),
    });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('decodes an interior optional argument only after checking the wire digest', async () => {
    const { executor } = harness();
    const args = encodeWorkspaceCommandArgs(['/host/repository', undefined, 'main', true]);
    const frame = commandFrame('optional-arguments', IPC_CHANNELS.GIT_PUSH, args);
    const invoke = vi.fn(async () => undefined);

    await expect(
      executor.execute({ frame, actor: ACTOR, authorize: async () => null, invoke })
    ).resolves.toMatchObject({ state: 'committed' });
    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.GIT_PUSH, [
      '/host/repository',
      undefined,
      'main',
      true,
    ]);
  });

  it('persists only redacted entity metadata for acknowledgement recovery', async () => {
    const { executor } = harness();
    const frame = commandFrame(
      'entity-registration',
      IPC_CHANNELS.WORKSPACE_MIRROR_REGISTER_ENTITY,
      ['repository', '/host/private/repository']
    );
    const invoke = vi.fn(async () => ({
      sceneId: 'scene-1',
      entityId: 'opaque-entity-id',
      kind: 'repository',
      path: '/host/private/repository',
      normalizedPath: '/host/private/repository',
      disposition: 'new',
    }));
    const execution = { frame, actor: ACTOR, authorize: async () => null, invoke };

    await expect(executor.execute(execution)).resolves.toMatchObject({
      state: 'committed',
      result: { entityId: 'opaque-entity-id', path: '/host/private/repository' },
    });
    await expect(executor.execute(execution)).resolves.toMatchObject({
      state: 'committed',
      resultExpired: false,
      result: {
        sceneId: 'scene-1',
        entityId: 'opaque-entity-id',
        kind: 'repository',
        disposition: 'new',
      },
    });
    expect(await executor.execute(execution)).not.toHaveProperty('result.path');
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('keeps a compacted result tombstone from ever repeating the effect', async () => {
    const { executor, repository } = harness();
    const frame = commandFrame('compacted-result', IPC_CHANNELS.WORKSPACE_MIRROR_REGISTER_ENTITY, [
      'repository',
      '/host/repository',
    ]);
    const invoke = vi.fn(async () => ({
      sceneId: 'scene-1',
      entityId: 'opaque-id',
      kind: 'repository',
      path: '/host/repository',
      normalizedPath: '/host/repository',
      disposition: 'new',
    }));
    const execution = { frame, actor: ACTOR, authorize: async () => null, invoke };

    await expect(executor.execute(execution)).resolves.toMatchObject({ state: 'committed' });
    await expect(repository.compactOperationResultsBefore(10_000, 10_001)).resolves.toBe(1);
    await expect(executor.execute(execution)).resolves.toMatchObject({
      state: 'committed',
      resultExpired: true,
      error: { code: 'RESULT_EXPIRED', retryable: false },
    });
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('does not prepare or invoke a command when control authorization fails', async () => {
    const { executor, repository } = harness();
    const frame = commandFrame('denied');
    const invoke = vi.fn();

    await expect(
      executor.execute({
        frame,
        actor: ACTOR,
        authorize: async () => ({
          code: 'LEASE_REQUIRED',
          message: 'Workspace control is required',
          retryable: true,
        }),
        invoke,
      })
    ).resolves.toMatchObject({ state: 'failed', error: { code: 'LEASE_REQUIRED' } });
    expect(await repository.loadOperation(frame.operationId)).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('recovers prepared work as not executed and executing work as unknown', async () => {
    const repository = new InMemoryWorkspaceStateRepository({
      operations: [
        operation('prepared-command', 'prepared'),
        operation('executing-command', 'executing'),
        operation('unknown-command', 'needs_reconcile'),
      ],
    });
    const { executor } = harness(repository);

    await executor.recover();

    expect(await repository.loadOperation('prepared-command')).toMatchObject({
      state: 'cancelled',
      error: { code: 'NOT_EXECUTED' },
    });
    expect(await repository.loadOperation('executing-command')).toMatchObject({
      state: 'needs_reconcile',
      error: { code: 'UNKNOWN' },
    });
    expect(await repository.loadOperation('unknown-command')).toMatchObject({
      state: 'needs_reconcile',
    });
  });

  it('returns operation status only to the bound client and device', async () => {
    const repository = new InMemoryWorkspaceStateRepository({
      operations: [operation('owned-command', 'executing')],
    });
    const { executor } = harness(repository);

    await expect(executor.status('owned-command', ACTOR, 'status-1')).resolves.toMatchObject({
      result: { requestId: 'status-1', state: 'executing' },
    });
    await expect(
      executor.status('owned-command', { ...ACTOR, deviceId: 'device-2' })
    ).resolves.toMatchObject({ error: { code: 'FORBIDDEN' } });
    await expect(executor.status('missing-command', ACTOR)).resolves.toMatchObject({
      error: { code: 'UNKNOWN_OPERATION' },
    });
  });
});
