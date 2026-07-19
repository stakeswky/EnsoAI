import {
  createEmptyWorkspaceSceneSnapshot,
  WorkspaceSceneEventSchema,
} from '@shared/types/workspaceMirror';
import { describe, expect, it } from 'vitest';
import { reduceWorkspaceSceneMutation } from '../WorkspaceMirrorService';
import {
  InMemoryWorkspaceStateRepository,
  type WorkspaceOperationRecord,
} from '../WorkspaceStateRepository';

const HOST_EPOCH = '11111111-1111-4111-8111-111111111111';
const REQUEST_DIGEST = 'a'.repeat(64);

function operation<TResult = unknown>(
  state: WorkspaceOperationRecord['state'],
  overrides: Partial<WorkspaceOperationRecord<TResult>> = {}
): WorkspaceOperationRecord<TResult> {
  return {
    operationId: 'operation1',
    intentKind: 'resources.invalidate',
    sceneId: 'scene1',
    clientId: 'client1',
    deviceId: 'device1',
    commandVersion: 1,
    requestDigest: REQUEST_DIGEST,
    state,
    baseRevision: 0,
    createdAt: 1,
    updatedAt: 1,
    ...(state === 'committed' ? { committedRevision: 1 } : {}),
    ...overrides,
  };
}

describe('InMemoryWorkspaceStateRepository', () => {
  it('clones reads and atomically stores snapshot, event, and committed operation', async () => {
    const repository = new InMemoryWorkspaceStateRepository();
    await repository.initialize();
    const initial = createEmptyWorkspaceSceneSnapshot({
      hostId: 'host1',
      sceneId: 'scene1',
      hostEpoch: HOST_EPOCH,
    });
    await repository.saveSnapshot(initial);
    await repository.saveOperation(operation('prepared'));
    await expect(
      repository.compareAndSwapOperation('operation1', 'prepared', operation('executing'))
    ).resolves.toBe(true);

    const mutation = {
      kind: 'resources.invalidate' as const,
      payload: {
        resourceKey: 'git-status:repo1',
        domain: 'git-status' as const,
        entityId: null,
        generation: 1,
        reason: 'changed' as const,
      },
    };
    const snapshot = reduceWorkspaceSceneMutation(initial, mutation);
    snapshot.revision = 1;
    const event = WorkspaceSceneEventSchema.parse({
      t: 'state.event',
      hostEpoch: HOST_EPOCH,
      sceneId: 'scene1',
      revision: 1,
      origin: {
        source: 'client',
        clientId: 'client1',
        deviceId: 'device1',
        operationId: 'operation1',
      },
      ...mutation,
    });
    await repository.commit({
      snapshot,
      event,
      operation: operation('committed'),
      committedAt: 2,
    });

    const storedSnapshot = await repository.loadSnapshot();
    expect(storedSnapshot).toMatchObject({ revision: 1 });
    storedSnapshot!.resources.invalidations = {};
    expect((await repository.loadSnapshot())?.resources.invalidations).toHaveProperty(
      'git-status:repo1'
    );
    expect(await repository.loadEvents()).toHaveLength(1);
    expect(await repository.loadOperation('operation1')).toMatchObject({
      state: 'committed',
      committedRevision: 1,
    });
  });

  it('rejects non-atomic revision mismatches and compacts retained events', async () => {
    const initial = createEmptyWorkspaceSceneSnapshot({
      hostId: 'host1',
      sceneId: 'scene1',
      hostEpoch: HOST_EPOCH,
    });
    const repository = new InMemoryWorkspaceStateRepository({ snapshot: initial });
    const event = WorkspaceSceneEventSchema.parse({
      t: 'state.event',
      hostEpoch: HOST_EPOCH,
      sceneId: 'scene1',
      revision: 1,
      origin: {
        source: 'client',
        clientId: 'client1',
        deviceId: 'device1',
        operationId: 'operation1',
      },
      kind: 'resources.invalidate',
      payload: {
        resourceKey: 'git-status:repo1',
        domain: 'git-status',
        entityId: null,
        generation: 1,
        reason: 'changed',
      },
    });

    await expect(
      repository.commit({
        snapshot: initial,
        event,
        operation: operation('committed'),
        committedAt: 2,
      })
    ).rejects.toThrow('revision mismatch');
    expect(await repository.loadEvents()).toHaveLength(0);

    const next = reduceWorkspaceSceneMutation(initial, event);
    next.revision = 1;
    await repository.commit({
      snapshot: next,
      event,
      operation: operation('committed'),
      committedAt: 2,
    });
    await repository.compactEventsThrough(1);
    expect(await repository.loadEvents()).toEqual([]);
  });

  it('enforces binding uniqueness and the legal compare-and-swap transition graph', async () => {
    const repository = new InMemoryWorkspaceStateRepository();
    await repository.saveOperation(operation('prepared'));

    await expect(
      repository.saveOperation(
        operation('prepared', {
          requestDigest: 'b'.repeat(64),
        })
      )
    ).rejects.toThrow(/binding conflict/);
    await expect(
      repository.compareAndSwapOperation('operation1', 'prepared', operation('committed'))
    ).rejects.toThrow(/Illegal.*prepared -> committed/);
    await expect(
      repository.compareAndSwapOperation('operation1', 'prepared', operation('executing'))
    ).resolves.toBe(true);
    await expect(
      repository.compareAndSwapOperation('operation1', 'prepared', operation('cancelled'))
    ).resolves.toBe(false);
    await expect(
      repository.compareAndSwapOperation('operation1', 'executing', operation('needs_reconcile'))
    ).resolves.toBe(true);
    await expect(
      repository.compareAndSwapOperation(
        'operation1',
        'needs_reconcile',
        operation('failed', { error: { code: 'UNKNOWN', message: 'reconciled failure' } })
      )
    ).resolves.toBe(true);
    await expect(repository.saveOperation(operation('executing'))).rejects.toThrow(
      /Illegal.*failed -> executing/
    );
  });

  it('lists only unfinished operations for the requested scene and cancels prepared work', async () => {
    const repository = new InMemoryWorkspaceStateRepository();
    const prepared = operation('prepared', { operationId: 'prepared' });
    const executing = operation('prepared', { operationId: 'executing', createdAt: 2 });
    const unknown = operation('prepared', { operationId: 'unknown', createdAt: 3 });
    const cancelled = operation('prepared', { operationId: 'cancelled', createdAt: 4 });
    await repository.saveOperation(prepared);
    await repository.saveOperation(executing);
    await repository.compareAndSwapOperation(executing.operationId, 'prepared', {
      ...executing,
      state: 'executing',
    });
    await repository.saveOperation(unknown);
    await repository.compareAndSwapOperation(unknown.operationId, 'prepared', {
      ...unknown,
      state: 'executing',
    });
    await repository.compareAndSwapOperation(unknown.operationId, 'executing', {
      ...unknown,
      state: 'needs_reconcile',
    });
    await repository.saveOperation(
      operation('prepared', { operationId: 'other-scene', sceneId: 'scene2', createdAt: 5 })
    );
    await repository.saveOperation(cancelled);
    await repository.compareAndSwapOperation(cancelled.operationId, 'prepared', {
      ...cancelled,
      state: 'cancelled',
    });

    expect(
      (await repository.listUnfinishedOperations('scene1')).map(({ operationId }) => operationId)
    ).toEqual(['prepared', 'executing', 'unknown']);
    await expect(
      repository.compareAndSwapOperation(
        'prepared',
        'prepared',
        operation('cancelled', {
          operationId: 'prepared',
          error: { code: 'NOT_EXECUTED', message: 'cancelled during recovery' },
        })
      )
    ).resolves.toBe(true);
    expect(
      (await repository.listUnfinishedOperations('scene1')).map(({ operationId }) => operationId)
    ).toEqual(['executing', 'unknown']);
  });

  it('compacts terminal results into immutable tombstones without permitting re-execution', async () => {
    const committed = operation<{ value: string }>('committed', {
      result: { value: 'safe-result' },
    });
    const repository = new InMemoryWorkspaceStateRepository({ operations: [committed] });

    await expect(repository.compactOperationResultsBefore(2, 10)).resolves.toBe(1);
    const tombstone = await repository.loadOperation<{ value: string }>('operation1');
    expect(tombstone).toMatchObject({
      state: 'committed',
      resultDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      resultCompactedAt: 10,
    });
    expect(tombstone?.result).toBeUndefined();

    await repository.saveOperation({
      ...committed,
      result: { value: 'late-overwrite' },
      updatedAt: 20,
    });
    expect((await repository.loadOperation('operation1'))?.result).toBeUndefined();
    await expect(repository.saveOperation(operation('executing'))).rejects.toThrow(
      /Illegal.*committed -> executing/
    );
  });

  it('rejects sensitive fields and absolute paths in reconciliation metadata', async () => {
    const repository = new InMemoryWorkspaceStateRepository();

    await expect(
      repository.saveOperation(
        operation('prepared', { reconcileMetadata: { content: 'private file body' } })
      )
    ).rejects.toThrow(/sensitive field/);
    await expect(
      repository.saveOperation(
        operation('prepared', {
          operationId: 'absolute-path',
          reconcileMetadata: { relativePath: '/private/workspace/file.ts' },
        })
      )
    ).rejects.toThrow(/unsafe path/);
    expect(await repository.loadOperation('operation1')).toBeNull();
    expect(await repository.loadOperation('absolute-path')).toBeNull();
  });
});
