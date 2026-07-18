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

function operation(state: WorkspaceOperationRecord['state']): WorkspaceOperationRecord {
  return {
    operationId: 'operation1',
    intentKind: 'resources.invalidate',
    clientId: 'client1',
    deviceId: 'device1',
    state,
    baseRevision: 0,
    createdAt: 1,
    updatedAt: 1,
    ...(state === 'committed' ? { committedRevision: 1 } : {}),
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
});
