import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  createEmptyWorkspaceSceneSnapshot,
  IPC_CHANNELS,
  JsonValueSchema,
  type WorkspaceSceneSnapshot,
} from '@shared/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSimpleGit } from '../../git/runtime';
import { WorktreeService } from '../../git/WorktreeService';
import {
  createRemoteWorkspaceCommandRegistry,
  WORKSPACE_COMMAND_VERSION,
  type WorkspaceCommandDescriptor,
  WorkspaceCommandExecutor,
} from '../WorkspaceCommandRegistry';
import { WorkspaceEntityRegistry } from '../WorkspaceEntityRegistry';
import {
  InMemoryWorkspaceStateRepository,
  type WorkspaceOperationRecord,
} from '../WorkspaceStateRepository';

const HOST_EPOCH = '11111111-1111-4111-8111-111111111111';
const SCENE_ID = 'scene-1';
const REPOSITORY_ID = 'repository-root';

function sceneWithRepository(repositoryPath: string): WorkspaceSceneSnapshot {
  const scene = createEmptyWorkspaceSceneSnapshot({
    hostId: 'host-1',
    sceneId: SCENE_ID,
    hostEpoch: HOST_EPOCH,
  });
  scene.catalog.repositories[REPOSITORY_ID] = {
    id: REPOSITORY_ID,
    path: repositoryPath,
    name: 'Repository',
    groupId: null,
    order: 0,
    settings: { autoInitWorktree: false, initScript: '', hidden: false },
  };
  return scene;
}

function operation(
  operationId: string,
  command: string,
  reconcileMetadata: unknown
): WorkspaceOperationRecord {
  return {
    operationId,
    intentKind: command,
    sceneId: SCENE_ID,
    clientId: 'client-1',
    deviceId: 'device-1',
    commandVersion: WORKSPACE_COMMAND_VERSION,
    requestDigest: createHash('sha256').update(operationId).digest('hex'),
    state: 'executing',
    baseRevision: 0,
    reconcileMetadata: JsonValueSchema.parse(reconcileMetadata),
    createdAt: 1,
    updatedAt: 2,
  };
}

function lifecycleHarness(
  repository: InMemoryWorkspaceStateRepository,
  scene: WorkspaceSceneSnapshot,
  liveTerminalIds: ReadonlySet<string> = new Set(),
  tmuxSessionExists: (sessionName: string) => Promise<boolean> = async () => false,
  throwAfterWorktreeRemoval = false
) {
  let currentScene = structuredClone(scene);
  const entityRegistry = new WorkspaceEntityRegistry(repository, SCENE_ID);
  const registry = createRemoteWorkspaceCommandRegistry({
    getSnapshot: () => currentScene,
    entityRegistry,
    commitEntity: async (entity) => {
      currentScene = structuredClone(currentScene);
      if (entity.kind === 'repository') {
        currentScene.catalog.repositories[entity.entityId] = {
          id: entity.entityId,
          path: entity.path,
          name: basename(entity.path),
          groupId: null,
          order: Object.keys(currentScene.catalog.repositories).length,
          settings: { autoInitWorktree: false, initScript: '', hidden: false },
        };
      } else {
        currentScene.catalog.worktrees[entity.entityId] = {
          id: entity.entityId,
          repositoryId: entity.repositoryId,
          path: entity.path,
          name: basename(entity.path),
          branch: entity.branch,
          order: Object.keys(currentScene.catalog.worktrees).length,
          isMain: false,
        };
      }
      await repository.saveSnapshot(currentScene);
    },
    removeWorktree: async (entityId) => {
      currentScene = structuredClone(currentScene);
      delete currentScene.catalog.worktrees[entityId];
      await repository.saveSnapshot(currentScene);
      if (throwAfterWorktreeRemoval) {
        throw new Error('injected crash after canonical worktree removal');
      }
    },
    terminalSessionExists: (sessionId) => liveTerminalIds.has(sessionId),
    tmuxSessionExists,
  });
  const executor = new WorkspaceCommandExecutor({
    repository,
    registry,
    sceneId: SCENE_ID,
    getRevision: () => scene.revision,
    clock: { now: () => 100 },
  });
  return { entityRegistry, registry, executor };
}

function descriptor(
  registry: ReturnType<typeof createRemoteWorkspaceCommandRegistry>,
  command: string
): WorkspaceCommandDescriptor {
  const value = registry.lookup(command);
  if (!value) throw new Error(`Missing command descriptor: ${command}`);
  return value;
}

async function prepare(
  registry: ReturnType<typeof createRemoteWorkspaceCommandRegistry>,
  command: string,
  args: unknown[]
): Promise<unknown> {
  const commandDescriptor = descriptor(registry, command);
  if (!commandDescriptor.prepare) throw new Error(`Missing command prepare hook: ${command}`);
  return commandDescriptor.prepare(JsonValueSchema.array().parse(args));
}

async function initializeGitRepository(repositoryPath: string, marker: string): Promise<void> {
  await mkdir(repositoryPath, { recursive: true });
  const git = createSimpleGit(repositoryPath);
  await git.init();
  await git.addConfig('user.name', 'EnsoAI Test');
  await git.addConfig('user.email', 'ensoai-test@example.invalid');
  await writeFile(join(repositoryPath, 'README.md'), `${marker}\n`, 'utf8');
  await git.add(['README.md']);
  await git.commit(`Initialize ${marker}`);
}

describe('LifecycleWorkspaceCommandAdapters', () => {
  let temporaryDirectory: string;

  beforeEach(async () => {
    temporaryDirectory = await realpath(
      await mkdtemp(join(tmpdir(), 'enso-lifecycle-command-adapters-'))
    );
  });

  afterEach(async () => {
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it('requires a client-preallocated persistent terminal ID and reconciles create/destroy', async () => {
    const repositoryPath = join(temporaryDirectory, 'repository');
    await mkdir(repositoryPath);
    const scene = sceneWithRepository(repositoryPath);
    const preparationRepository = new InMemoryWorkspaceStateRepository({ snapshot: scene });
    const preparation = lifecycleHarness(preparationRepository, scene);
    const createDescriptor = descriptor(preparation.registry, IPC_CHANNELS.TERMINAL_CREATE);

    expect(
      createDescriptor.requestSchema.safeParse([{ cwd: repositoryPath, persistent: true }]).success
    ).toBe(false);
    expect(
      createDescriptor.requestSchema.safeParse([
        { cwd: repositoryPath, sessionId: 'terminal-without-persistence' },
      ]).success
    ).toBe(false);
    expect(
      createDescriptor.requestSchema.safeParse([
        { cwd: repositoryPath, sessionId: 'terminal-live', persistent: true },
      ]).success
    ).toBe(true);

    const operations = await Promise.all([
      prepare(preparation.registry, IPC_CHANNELS.TERMINAL_CREATE, [
        { cwd: repositoryPath, sessionId: 'terminal-live', persistent: true },
      ]).then((metadata) =>
        operation('terminal-create-live', IPC_CHANNELS.TERMINAL_CREATE, metadata)
      ),
      prepare(preparation.registry, IPC_CHANNELS.TERMINAL_CREATE, [
        { cwd: repositoryPath, sessionId: 'terminal-missing', persistent: true },
      ]).then((metadata) =>
        operation('terminal-create-missing', IPC_CHANNELS.TERMINAL_CREATE, metadata)
      ),
      prepare(preparation.registry, IPC_CHANNELS.TERMINAL_DESTROY, ['terminal-gone']).then(
        (metadata) => operation('terminal-destroy-gone', IPC_CHANNELS.TERMINAL_DESTROY, metadata)
      ),
      prepare(preparation.registry, IPC_CHANNELS.TERMINAL_DESTROY, ['terminal-destroy-live']).then(
        (metadata) => operation('terminal-destroy-live', IPC_CHANNELS.TERMINAL_DESTROY, metadata)
      ),
    ]);
    const restartedRepository = new InMemoryWorkspaceStateRepository({
      snapshot: scene,
      operations,
    });
    const restarted = lifecycleHarness(
      restartedRepository,
      scene,
      new Set(['terminal-live', 'terminal-destroy-live'])
    );

    await restarted.executor.recover();

    await expect(restartedRepository.loadOperation('terminal-create-live')).resolves.toMatchObject({
      state: 'committed',
    });
    await expect(
      restartedRepository.loadOperation('terminal-create-missing')
    ).resolves.toMatchObject({ state: 'failed', error: { code: 'CONFLICT' } });
    await expect(restartedRepository.loadOperation('terminal-destroy-gone')).resolves.toMatchObject(
      {
        state: 'committed',
      }
    );
    await expect(restartedRepository.loadOperation('terminal-destroy-live')).resolves.toMatchObject(
      { state: 'failed', error: { code: 'CONFLICT' } }
    );
  });

  it('reconciles tmux kill only when the named session is absent', async () => {
    const repositoryPath = join(temporaryDirectory, 'repository');
    await mkdir(repositoryPath);
    const scene = sceneWithRepository(repositoryPath);
    const preparationRepository = new InMemoryWorkspaceStateRepository({ snapshot: scene });
    const preparation = lifecycleHarness(preparationRepository, scene);
    const removed = await prepare(preparation.registry, IPC_CHANNELS.TMUX_KILL_SESSION, [
      'removed-session',
    ]);
    const live = await prepare(preparation.registry, IPC_CHANNELS.TMUX_KILL_SESSION, [
      'live-session',
    ]);
    const unknown = await prepare(preparation.registry, IPC_CHANNELS.TMUX_KILL_SESSION, [
      'probe-error',
    ]);
    const restartedRepository = new InMemoryWorkspaceStateRepository({
      snapshot: scene,
      operations: [
        operation('tmux-removed', IPC_CHANNELS.TMUX_KILL_SESSION, removed),
        operation('tmux-live', IPC_CHANNELS.TMUX_KILL_SESSION, live),
        operation('tmux-unknown', IPC_CHANNELS.TMUX_KILL_SESSION, unknown),
      ],
    });
    const restarted = lifecycleHarness(
      restartedRepository,
      scene,
      new Set(),
      async (sessionName) => {
        if (sessionName === 'probe-error') throw new Error('tmux probe unavailable');
        return sessionName === 'live-session';
      }
    );

    await restarted.executor.recover();

    await expect(restartedRepository.loadOperation('tmux-removed')).resolves.toMatchObject({
      state: 'committed',
    });
    await expect(restartedRepository.loadOperation('tmux-live')).resolves.toMatchObject({
      state: 'failed',
    });
    await expect(restartedRepository.loadOperation('tmux-unknown')).resolves.toMatchObject({
      state: 'needs_reconcile',
      error: { code: 'UNKNOWN' },
    });
  });

  it('recovers entity registration and atomic adoption with their original identities', async () => {
    const repositoryPath = join(temporaryDirectory, 'repository');
    const registeredPath = join(temporaryDirectory, 'registered-repository');
    const adoptedPath = join(temporaryDirectory, 'repository-renamed');
    await mkdir(repositoryPath);
    const scene = sceneWithRepository(repositoryPath);
    const preparationRepository = new InMemoryWorkspaceStateRepository({ snapshot: scene });
    const preparation = lifecycleHarness(preparationRepository, scene);
    const registration = await prepare(
      preparation.registry,
      IPC_CHANNELS.WORKSPACE_MIRROR_REGISTER_ENTITY,
      ['repository', registeredPath]
    );
    const registeredEntityId = (registration as { targetEntityId: string }).targetEntityId;
    const adoption = await prepare(
      preparation.registry,
      IPC_CHANNELS.WORKSPACE_MIRROR_ADOPT_ENTITY,
      ['repository', REPOSITORY_ID, adoptedPath]
    );
    const adoptionDescriptor = preparation.registry.lookup(
      IPC_CHANNELS.WORKSPACE_MIRROR_ADOPT_ENTITY
    );
    await expect(
      adoptionDescriptor?.verify?.(
        operation('entity-adopt-conflict', IPC_CHANNELS.WORKSPACE_MIRROR_ADOPT_ENTITY, adoption),
        {
          ok: false,
          error: {
            code: 'ENTITY_ADOPTION_CONFLICT',
            message: 'Workspace path belongs to another entity',
            conflictingEntityIds: ['repository-other'],
          },
        }
      )
    ).resolves.toMatchObject({
      state: 'failed',
      error: {
        code: 'ENTITY_ADOPTION_CONFLICT',
        details: { conflictingEntityIds: ['repository-other'] },
      },
    });

    const adoptedScene = structuredClone(scene);
    adoptedScene.catalog.repositories[REPOSITORY_ID]!.path = adoptedPath;
    const restartedRepository = new InMemoryWorkspaceStateRepository({
      snapshot: adoptedScene,
      entityRegistry: await preparationRepository.loadEntityRegistry(SCENE_ID),
      operations: [
        operation('entity-register', IPC_CHANNELS.WORKSPACE_MIRROR_REGISTER_ENTITY, registration),
        operation('entity-adopt', IPC_CHANNELS.WORKSPACE_MIRROR_ADOPT_ENTITY, adoption),
      ],
    });
    const restarted = lifecycleHarness(restartedRepository, adoptedScene);

    await restarted.executor.recover();

    await expect(restartedRepository.loadOperation('entity-register')).resolves.toMatchObject({
      state: 'committed',
      result: { entityId: registeredEntityId, disposition: 'new' },
    });
    await expect(restartedRepository.loadOperation('entity-adopt')).resolves.toMatchObject({
      state: 'committed',
      result: {
        ok: true,
        reservation: { entityId: REPOSITORY_ID, disposition: 'adopted' },
      },
    });
    await expect(
      restarted.entityRegistry.resolveEntity('repository', registeredPath)
    ).resolves.toMatchObject({
      status: 'resolved',
      entityId: registeredEntityId,
      match: 'reservation',
      durable: true,
    });
    await expect(
      restarted.entityRegistry.resolveEntity('repository', adoptedPath)
    ).resolves.toMatchObject({
      status: 'resolved',
      entityId: REPOSITORY_ID,
      match: 'current',
      durable: true,
    });

    const committedSnapshot = await restartedRepository.loadSnapshot();
    expect(committedSnapshot).not.toBeNull();
    const secondRestartRepository = new InMemoryWorkspaceStateRepository({
      snapshot: committedSnapshot!,
      entityRegistry: await restartedRepository.loadEntityRegistry(SCENE_ID),
    });
    const secondRestartRegistry = new WorkspaceEntityRegistry(secondRestartRepository, SCENE_ID);
    await expect(
      secondRestartRegistry.resolveEntity('repository', registeredPath)
    ).resolves.toMatchObject({
      status: 'resolved',
      entityId: registeredEntityId,
      match: 'reservation',
      durable: true,
    });
    await expect(
      secondRestartRegistry.resolveEntity('repository', adoptedPath)
    ).resolves.toMatchObject({
      status: 'resolved',
      entityId: REPOSITORY_ID,
      match: 'current',
      durable: true,
    });
  });

  it('reconciles a real worktree add and restores the exact preallocated UUID after restart', async () => {
    const repositoryPath = join(temporaryDirectory, 'repository');
    const worktreePath = join(temporaryDirectory, 'feature-worktree');
    await initializeGitRepository(repositoryPath, 'worktree-add');
    const scene = sceneWithRepository(repositoryPath);
    const preparationRepository = new InMemoryWorkspaceStateRepository({ snapshot: scene });
    const preparation = lifecycleHarness(preparationRepository, scene);
    const metadata = await prepare(preparation.registry, IPC_CHANNELS.WORKTREE_ADD, [
      repositoryPath,
      { path: worktreePath, newBranch: 'feature/reconcile' },
    ]);
    const targetEntityId = (metadata as { targetEntityId: string }).targetEntityId;

    expect(targetEntityId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    await new WorktreeService(repositoryPath).add({
      path: worktreePath,
      newBranch: 'feature/reconcile',
    });

    const restartedRepository = new InMemoryWorkspaceStateRepository({
      snapshot: scene,
      entityRegistry: await preparationRepository.loadEntityRegistry(SCENE_ID),
      operations: [operation('worktree-add', IPC_CHANNELS.WORKTREE_ADD, metadata)],
    });
    const restarted = lifecycleHarness(restartedRepository, scene);

    await restarted.executor.recover();

    await expect(restartedRepository.loadOperation('worktree-add')).resolves.toMatchObject({
      state: 'committed',
    });
    await expect(
      restarted.entityRegistry.resolveEntity('worktree', worktreePath)
    ).resolves.toMatchObject({
      status: 'resolved',
      entityId: targetEntityId,
      match: 'current',
      durable: true,
    });
    const secondSnapshot = await restartedRepository.loadSnapshot();
    expect(secondSnapshot).not.toBeNull();
    const secondRepository = new InMemoryWorkspaceStateRepository({
      snapshot: secondSnapshot!,
      entityRegistry: await restartedRepository.loadEntityRegistry(SCENE_ID),
    });
    await expect(
      new WorkspaceEntityRegistry(secondRepository, SCENE_ID).resolveEntity(
        'worktree',
        worktreePath
      )
    ).resolves.toMatchObject({ entityId: targetEntityId, match: 'current', durable: true });
  });

  it('reconciles a real worktree removal only after Git and the filesystem agree', async () => {
    const repositoryPath = join(temporaryDirectory, 'repository');
    const worktreePath = join(temporaryDirectory, 'removed-worktree');
    await initializeGitRepository(repositoryPath, 'worktree-remove');
    await new WorktreeService(repositoryPath).add({
      path: worktreePath,
      newBranch: 'feature/remove',
    });
    const scene = sceneWithRepository(repositoryPath);
    scene.catalog.worktrees['worktree-to-remove'] = {
      id: 'worktree-to-remove',
      repositoryId: REPOSITORY_ID,
      path: worktreePath,
      name: 'Removed worktree',
      branch: 'feature/remove',
      order: 0,
      isMain: false,
    };
    const preparationRepository = new InMemoryWorkspaceStateRepository({ snapshot: scene });
    const preparation = lifecycleHarness(preparationRepository, scene);
    const metadata = await prepare(preparation.registry, IPC_CHANNELS.WORKTREE_REMOVE, [
      repositoryPath,
      { path: worktreePath, force: true },
    ]);

    await new WorktreeService(repositoryPath).remove({ path: worktreePath, force: true });
    await expect(lstat(worktreePath)).rejects.toMatchObject({ code: 'ENOENT' });

    const restartedRepository = new InMemoryWorkspaceStateRepository({
      snapshot: scene,
      operations: [operation('worktree-remove', IPC_CHANNELS.WORKTREE_REMOVE, metadata)],
    });
    const restarted = lifecycleHarness(
      restartedRepository,
      scene,
      new Set(),
      async () => false,
      true
    );

    await restarted.executor.recover();

    await expect(restartedRepository.loadOperation('worktree-remove')).resolves.toMatchObject({
      state: 'needs_reconcile',
    });
    await expect(restartedRepository.loadSnapshot()).resolves.not.toHaveProperty(
      'catalog.worktrees.worktree-to-remove'
    );
    const secondSnapshot = await restartedRepository.loadSnapshot();
    const unfinished = await restartedRepository.loadOperation('worktree-remove');
    expect(secondSnapshot).not.toBeNull();
    expect(unfinished).not.toBeNull();
    const secondRepository = new InMemoryWorkspaceStateRepository({
      snapshot: secondSnapshot!,
      entityRegistry: await restartedRepository.loadEntityRegistry(SCENE_ID),
      operations: [unfinished!],
    });
    await lifecycleHarness(secondRepository, secondSnapshot!).executor.recover();
    await expect(secondRepository.loadOperation('worktree-remove')).resolves.toMatchObject({
      state: 'committed',
    });
  });

  it('adopts a cloned repository with a matching origin digest and the same UUID', async () => {
    const anchorPath = join(temporaryDirectory, 'anchor');
    const originPath = join(temporaryDirectory, 'origin');
    const targetPath = join(temporaryDirectory, 'clone-match');
    await mkdir(anchorPath);
    await initializeGitRepository(originPath, 'clone-origin');
    const scene = sceneWithRepository(anchorPath);
    const preparationRepository = new InMemoryWorkspaceStateRepository({ snapshot: scene });
    const preparation = lifecycleHarness(preparationRepository, scene);
    const metadata = await prepare(preparation.registry, IPC_CHANNELS.GIT_CLONE, [
      originPath,
      targetPath,
    ]);
    const targetEntityId = (metadata as { targetEntityId: string }).targetEntityId;
    await createSimpleGit(temporaryDirectory).clone(originPath, targetPath);

    const restartedRepository = new InMemoryWorkspaceStateRepository({
      snapshot: scene,
      entityRegistry: await preparationRepository.loadEntityRegistry(SCENE_ID),
      operations: [operation('clone-match', IPC_CHANNELS.GIT_CLONE, metadata)],
    });
    const restarted = lifecycleHarness(restartedRepository, scene);

    await restarted.executor.recover();

    await expect(restartedRepository.loadOperation('clone-match')).resolves.toMatchObject({
      state: 'committed',
    });
    await expect(
      restarted.entityRegistry.resolveEntity('repository', targetPath)
    ).resolves.toMatchObject({
      status: 'resolved',
      entityId: targetEntityId,
      match: 'current',
      durable: true,
    });
    const secondSnapshot = await restartedRepository.loadSnapshot();
    expect(secondSnapshot).not.toBeNull();
    const secondRepository = new InMemoryWorkspaceStateRepository({
      snapshot: secondSnapshot!,
      entityRegistry: await restartedRepository.loadEntityRegistry(SCENE_ID),
    });
    await expect(
      new WorkspaceEntityRegistry(secondRepository, SCENE_ID).resolveEntity(
        'repository',
        targetPath
      )
    ).resolves.toMatchObject({ entityId: targetEntityId, match: 'current', durable: true });
  });

  it('keeps a clone with a mismatched origin digest in UNKNOWN', async () => {
    const anchorPath = join(temporaryDirectory, 'anchor');
    const expectedOriginPath = join(temporaryDirectory, 'expected-origin');
    const actualOriginPath = join(temporaryDirectory, 'actual-origin');
    const targetPath = join(temporaryDirectory, 'clone-mismatch');
    await mkdir(anchorPath);
    await initializeGitRepository(expectedOriginPath, 'expected-origin');
    await initializeGitRepository(actualOriginPath, 'actual-origin');
    const scene = sceneWithRepository(anchorPath);
    const preparationRepository = new InMemoryWorkspaceStateRepository({ snapshot: scene });
    const preparation = lifecycleHarness(preparationRepository, scene);
    const metadata = await prepare(preparation.registry, IPC_CHANNELS.GIT_CLONE, [
      expectedOriginPath,
      targetPath,
    ]);
    await createSimpleGit(temporaryDirectory).clone(actualOriginPath, targetPath);

    const restartedRepository = new InMemoryWorkspaceStateRepository({
      snapshot: scene,
      operations: [operation('clone-mismatch', IPC_CHANNELS.GIT_CLONE, metadata)],
    });
    const restarted = lifecycleHarness(restartedRepository, scene);

    await restarted.executor.recover();

    await expect(restartedRepository.loadOperation('clone-mismatch')).resolves.toMatchObject({
      state: 'needs_reconcile',
      error: { code: 'UNKNOWN' },
    });
  });

  it('rejects a clone target that cannot be rebuilt without persisting an absolute path', async () => {
    const anchorPath = join(temporaryDirectory, 'anchor');
    const originPath = join(temporaryDirectory, 'origin');
    const targetPath = join(temporaryDirectory, 'untracked-parent', 'clone');
    await mkdir(anchorPath);
    await initializeGitRepository(originPath, 'unlocatable-origin');
    const scene = sceneWithRepository(anchorPath);
    const preparationRepository = new InMemoryWorkspaceStateRepository({ snapshot: scene });
    const preparation = lifecycleHarness(preparationRepository, scene);
    await expect(
      prepare(preparation.registry, IPC_CHANNELS.GIT_CLONE, [originPath, targetPath])
    ).rejects.toThrow('cannot be reconciled safely');
  });
});
