import { createEmptyWorkspaceSceneSnapshot } from '@shared/types/workspaceMirror';
import { describe, expect, it } from 'vitest';
import {
  normalizeWorkspaceEntityPath,
  toWorkspaceHostPathCasePolicy,
  WorkspaceEntityRegistry,
  type WorkspaceEntityRegistryError,
} from '../WorkspaceEntityRegistry';
import { InMemoryWorkspaceStateRepository } from '../WorkspaceStateRepository';

const HOST_EPOCH = '11111111-1111-4111-8111-111111111111';

function snapshot() {
  return createEmptyWorkspaceSceneSnapshot({
    hostId: 'host-1',
    sceneId: 'scene-1',
    hostEpoch: HOST_EPOCH,
  });
}

function addRepository(
  scene: ReturnType<typeof snapshot>,
  id: string,
  path: string,
  order = 0
): void {
  scene.catalog.repositories[id] = {
    id,
    path,
    name: id,
    groupId: null,
    order,
    settings: { autoInitWorktree: false, initScript: '', hidden: false },
  };
}

describe('WorkspaceEntityRegistry', () => {
  it('imports opaque catalog IDs and keeps historical paths as aliases across a restart', async () => {
    const first = new InMemoryWorkspaceStateRepository(undefined, {
      entityPathPlatform: 'linux',
    });
    const initial = snapshot();
    addRepository(initial, 'legacy-path-hash-repository-id', '/workspace/project');
    initial.catalog.worktrees['legacy-path-hash-worktree-id'] = {
      id: 'legacy-path-hash-worktree-id',
      repositoryId: 'legacy-path-hash-repository-id',
      path: '/workspace/project',
      name: 'main',
      branch: 'main',
      order: 0,
      isMain: true,
    };
    await first.saveSnapshot(initial);

    const renamed = structuredClone(initial);
    renamed.catalog.repositories['legacy-path-hash-repository-id']!.path =
      '/workspace/project-renamed';
    renamed.catalog.worktrees['legacy-path-hash-worktree-id']!.path = '/workspace/project-renamed';
    await first.saveSnapshot(renamed);

    const firstRegistry = new WorkspaceEntityRegistry(first, 'scene-1');
    await expect(
      firstRegistry.resolveEntity('repository', '/workspace/project')
    ).resolves.toMatchObject({
      status: 'resolved',
      entityId: 'legacy-path-hash-repository-id',
      match: 'alias',
    });
    await expect(
      firstRegistry.resolveEntity('repository', '/workspace/project-renamed')
    ).resolves.toMatchObject({
      status: 'resolved',
      entityId: 'legacy-path-hash-repository-id',
      match: 'current',
    });
    await expect(
      firstRegistry.resolveEntity('worktree', '/workspace/project')
    ).resolves.toMatchObject({
      status: 'resolved',
      entityId: 'legacy-path-hash-worktree-id',
      match: 'alias',
    });

    const persistedRegistry = await first.loadEntityRegistry('scene-1');
    const restarted = new InMemoryWorkspaceStateRepository(
      { snapshot: renamed, entityRegistry: persistedRegistry },
      { entityPathPlatform: 'linux' }
    );
    const restartedRegistry = new WorkspaceEntityRegistry(restarted, 'scene-1');
    await expect(
      restartedRegistry.resolveEntity('repository', '/workspace/project')
    ).resolves.toMatchObject({
      status: 'resolved',
      entityId: 'legacy-path-hash-repository-id',
      match: 'alias',
    });
  });

  it('persists UUID reservations until the reserved ID is committed in a scene', async () => {
    const repository = new InMemoryWorkspaceStateRepository(undefined, {
      entityPathPlatform: 'linux',
    });
    const scene = snapshot();
    await repository.saveSnapshot(scene);
    const registry = new WorkspaceEntityRegistry(repository, 'scene-1');

    const reservation = await registry.registerEntity('repository', '/workspace/new-project');
    expect(reservation).toMatchObject({ disposition: 'new', kind: 'repository' });
    expect(reservation.entityId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect((await repository.loadEntityRegistry('scene-1')).entities).toEqual([]);
    expect((await repository.loadEntityRegistry('scene-1')).reservations).toMatchObject([
      { entityId: reservation.entityId, path: '/workspace/new-project', disposition: 'new' },
    ]);
    await expect(
      new WorkspaceEntityRegistry(repository, 'scene-1').resolveEntity(
        'repository',
        '/workspace/new-project'
      )
    ).resolves.toMatchObject({
      status: 'resolved',
      entityId: reservation.entityId,
      match: 'reservation',
      durable: true,
    });

    addRepository(scene, reservation.entityId, reservation.path);
    await repository.saveSnapshot(scene);
    expect((await repository.loadEntityRegistry('scene-1')).reservations).toEqual([]);
    await expect(
      registry.resolveEntity('repository', '/workspace/new-project')
    ).resolves.toMatchObject({
      status: 'resolved',
      entityId: reservation.entityId,
      match: 'current',
      durable: true,
    });

    const restarted = new InMemoryWorkspaceStateRepository(
      {
        snapshot: scene,
        entityRegistry: await repository.loadEntityRegistry('scene-1'),
      },
      { entityPathPlatform: 'linux' }
    );
    await expect(
      new WorkspaceEntityRegistry(restarted, 'scene-1').resolveEntity(
        'repository',
        '/workspace/new-project'
      )
    ).resolves.toMatchObject({
      entityId: reservation.entityId,
      match: 'current',
      durable: true,
    });
  });

  it('deletes a durable reservation when preparation is cancelled', async () => {
    const repository = new InMemoryWorkspaceStateRepository(undefined, {
      entityPathPlatform: 'linux',
    });
    await repository.saveSnapshot(snapshot());
    const registry = new WorkspaceEntityRegistry(repository, 'scene-1');
    const reservation = await registry.reserveEntity('repository', '/workspace/cancelled');

    await registry.discardReservation(reservation.entityId);

    expect((await repository.loadEntityRegistry('scene-1')).reservations).toEqual([]);
    await expect(
      new WorkspaceEntityRegistry(repository, 'scene-1').resolveEntity(
        'repository',
        '/workspace/cancelled'
      )
    ).resolves.toMatchObject({ status: 'unresolved' });
  });

  it('restores the same crash-recovery UUID without allocating a second reservation', async () => {
    const repository = new InMemoryWorkspaceStateRepository(undefined, {
      entityPathPlatform: 'linux',
    });
    const scene = snapshot();
    addRepository(scene, 'repository-root', '/workspace/project');
    await repository.saveSnapshot(scene);
    const registry = new WorkspaceEntityRegistry(repository, 'scene-1');
    const recoveredId = '11111111-1111-4111-8111-111111111112';

    await expect(
      registry.restoreReservation('worktree', recoveredId, '/workspace/project-feature')
    ).resolves.toMatchObject({ entityId: recoveredId, disposition: 'new' });
    await expect(
      registry.restoreReservation('worktree', recoveredId, '/workspace/project-feature')
    ).resolves.toMatchObject({ entityId: recoveredId, disposition: 'new' });
    await expect(
      registry.restoreReservation('worktree', recoveredId, '/workspace/other-feature')
    ).rejects.toMatchObject({ code: 'ENTITY_PATH_CONFLICT' });

    scene.catalog.worktrees[recoveredId] = {
      id: recoveredId,
      repositoryId: 'repository-root',
      path: '/workspace/project-feature',
      name: 'feature',
      branch: 'feature',
      order: 0,
      isMain: false,
    };
    await repository.saveSnapshot(scene);
    await expect(
      registry.resolveEntity('worktree', '/workspace/project-feature')
    ).resolves.toMatchObject({ entityId: recoveredId, durable: true, match: 'current' });
  });

  it('defaults to exact lookup and fails closed on case-folded collisions', async () => {
    const repository = new InMemoryWorkspaceStateRepository(undefined, {
      entityPathPlatform: 'win32',
    });
    const initial = snapshot();
    addRepository(initial, 'repository-a', 'C:\\Workspace\\Project');
    addRepository(initial, 'repository-b', 'C:\\Workspace\\Other', 1);
    initial.catalog.worktrees['worktree-a'] = {
      id: 'worktree-a',
      repositoryId: 'repository-a',
      path: 'C:\\Workspace\\Project',
      name: 'main',
      branch: 'main',
      order: 0,
      isMain: true,
    };
    await repository.saveSnapshot(initial);
    const registry = new WorkspaceEntityRegistry(repository, 'scene-1');
    expect(repository.entityPathCasePolicy).toBe('exact');
    expect(toWorkspaceHostPathCasePolicy(undefined)).toBe('exact');
    expect(toWorkspaceHostPathCasePolicy('unknown')).toBe('exact');

    expect(normalizeWorkspaceEntityPath('c:/WORKSPACE/project/', 'win32')).toEqual({
      path: 'c:\\WORKSPACE\\project',
      normalizedPath: 'c:\\WORKSPACE\\project',
    });
    await expect(
      registry.resolveEntity('repository', 'c:/WORKSPACE/project')
    ).resolves.toMatchObject({ status: 'unresolved' });
    await expect(
      registry.renameEntity('repository', 'repository-b', 'c:/workspace/PROJECT')
    ).rejects.toMatchObject({
      code: 'ENTITY_ADOPTION_CONFLICT',
    } satisfies Partial<WorkspaceEntityRegistryError>);

    const conflicting = structuredClone(initial);
    conflicting.catalog.repositories['repository-b']!.path = 'c:/workspace/PROJECT';
    await expect(repository.saveSnapshot(conflicting)).rejects.toMatchObject({
      code: 'ENTITY_PATH_CONFLICT',
    } satisfies Partial<WorkspaceEntityRegistryError>);
    expect(await repository.loadSnapshot()).toEqual(initial);
    await expect(
      registry.resolveEntity('repository', 'C:\\Workspace\\Other')
    ).resolves.toMatchObject({ status: 'resolved', entityId: 'repository-b' });
  });

  it('keeps case-distinct Linux paths as separate host entities', async () => {
    const repository = new InMemoryWorkspaceStateRepository(undefined, {
      entityPathPlatform: 'linux',
      entityPathCasePolicy: 'sensitive',
    });
    const scene = snapshot();
    addRepository(scene, 'repository-upper', '/workspace/Project');
    addRepository(scene, 'repository-lower', '/workspace/project', 1);
    await repository.saveSnapshot(scene);
    const registry = new WorkspaceEntityRegistry(repository, 'scene-1');

    await expect(registry.resolveEntity('repository', '/workspace/Project')).resolves.toMatchObject(
      { status: 'resolved', entityId: 'repository-upper' }
    );
    await expect(registry.resolveEntity('repository', '/workspace/project')).resolves.toMatchObject(
      { status: 'resolved', entityId: 'repository-lower' }
    );
  });

  it('uses case-folded lookup and collisions on insensitive hosts', async () => {
    const repository = new InMemoryWorkspaceStateRepository(undefined, {
      entityPathPlatform: 'linux',
      entityPathCasePolicy: 'insensitive',
    });
    const scene = snapshot();
    addRepository(scene, 'repository-a', '/workspace/Project');
    await repository.saveSnapshot(scene);
    const registry = new WorkspaceEntityRegistry(repository, 'scene-1');

    await expect(registry.resolveEntity('repository', '/WORKSPACE/project')).resolves.toMatchObject(
      { status: 'resolved', entityId: 'repository-a', match: 'current' }
    );
    await expect(registry.reserveEntity('repository', '/workspace/PROJECT')).resolves.toMatchObject(
      { entityId: 'repository-a', disposition: 'existing' }
    );

    const conflicting = structuredClone(scene);
    addRepository(conflicting, 'repository-b', '/WORKSPACE/PROJECT', 1);
    await expect(repository.saveSnapshot(conflicting)).rejects.toMatchObject({
      code: 'ENTITY_PATH_CONFLICT',
    } satisfies Partial<WorkspaceEntityRegistryError>);
  });

  it('surfaces ambiguous historical aliases instead of silently adopting one identity', async () => {
    const repository = new InMemoryWorkspaceStateRepository(undefined, {
      entityPathPlatform: 'linux',
    });
    const scene = snapshot();
    addRepository(scene, 'repository-a', '/workspace/one');
    await repository.saveSnapshot(scene);

    scene.catalog.repositories['repository-a']!.path = '/workspace/shared';
    await repository.saveSnapshot(scene);
    scene.catalog.repositories['repository-a']!.path = '/workspace/new';
    addRepository(scene, 'repository-b', '/workspace/shared', 1);
    await repository.saveSnapshot(scene);
    delete scene.catalog.repositories['repository-b'];
    await repository.saveSnapshot(scene);

    const registry = new WorkspaceEntityRegistry(repository, 'scene-1');
    await expect(registry.resolveEntity('repository', '/workspace/shared')).resolves.toEqual({
      status: 'ambiguous',
      sceneId: 'scene-1',
      kind: 'repository',
      path: '/workspace/shared',
      normalizedPath: '/workspace/shared',
      entityIds: ['repository-a', 'repository-b'],
    });
    await expect(
      registry.adoptEntity('repository', 'repository-a', '/workspace/shared')
    ).rejects.toMatchObject({
      code: 'ENTITY_ADOPTION_CONFLICT',
    } satisfies Partial<WorkspaceEntityRegistryError>);
  });
});
