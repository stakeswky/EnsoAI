import {
  digestWorkspaceScene,
  type WorkspaceCatalogScene,
  type WorkspaceSceneIntent,
} from '@shared/types/workspaceMirror';
import { describe, expect, it, vi } from 'vitest';
import {
  applyWorkspaceSceneEvent,
  type WorkspaceClock,
  type WorkspaceIntentActor,
  WorkspaceMirrorService,
} from '../WorkspaceMirrorService';
import { InMemoryWorkspaceStateRepository } from '../WorkspaceStateRepository';

const HOST_EPOCH = '11111111-1111-4111-8111-111111111111';
const NEXT_HOST_EPOCH = '22222222-2222-4222-8222-222222222222';

function catalog(): WorkspaceCatalogScene {
  return {
    groups: {
      group1: { id: 'group1', name: 'Primary', emoji: '', color: '#ffffff', order: 0 },
    },
    repositories: {
      repo1: {
        id: 'repo1',
        path: '/host/repo',
        name: 'repo',
        groupId: 'group1',
        order: 0,
        settings: { autoInitWorktree: false, initScript: '', hidden: false },
      },
    },
    worktrees: {
      worktree1: {
        id: 'worktree1',
        repositoryId: 'repo1',
        path: '/host/repo',
        name: 'main',
        branch: 'main',
        order: 0,
        isMain: true,
      },
    },
  };
}

function createHarness(options?: {
  now?: number;
  effect?: () => Promise<{ ok: boolean }>;
  repository?: InMemoryWorkspaceStateRepository;
  hostEpoch?: string;
  retention?: { minimumEvents?: number; maxAgeMs?: number; maxBytes?: number };
}) {
  let now = options?.now ?? 1_000;
  let leaseId = 0;
  const clock: WorkspaceClock = { now: () => now };
  const service = new WorkspaceMirrorService({
    hostId: 'host1',
    sceneId: 'scene1',
    hostEpoch: options?.hostEpoch ?? HOST_EPOCH,
    repository: options?.repository,
    clock,
    idGenerator: (kind) => (kind === 'hostEpoch' ? HOST_EPOCH : `lease-${++leaseId}`),
    effectExecutor: options?.effect ? { execute: options.effect } : undefined,
    retention: options?.retention,
  });
  return {
    service,
    advance(ms: number) {
      now += ms;
    },
  };
}

async function gainControl(service: WorkspaceMirrorService, clientId = 'client1') {
  const actorBase = { clientId, deviceId: `device-${clientId}` };
  const result = await service.requestControl(actorBase);
  if (!result.granted) throw new Error(result.error.message);
  return { ...actorBase, leaseId: result.lease.leaseId } satisfies WorkspaceIntentActor;
}

function resourceIntent(
  operationId: string,
  clientSeq: number,
  baseRevision: number,
  generation = clientSeq
): Extract<WorkspaceSceneIntent, { kind: 'resources.invalidate' }> {
  return {
    t: 'state.intent',
    operationId,
    clientSeq,
    baseRevision,
    kind: 'resources.invalidate',
    payload: {
      resourceKey: `git-status:repo1:${generation}`,
      domain: 'git-status',
      entityId: null,
      generation,
      reason: 'changed',
    },
  };
}

describe('WorkspaceMirrorService', () => {
  it('initializes an empty authoritative scene with a stable normalized digest', async () => {
    const { service } = createHarness();
    await service.initialize();

    expect(service.getSnapshot()).toMatchObject({
      hostId: 'host1',
      sceneId: 'scene1',
      hostEpoch: HOST_EPOCH,
      revision: 0,
      editors: {},
    });
    expect(await service.getNormalizedDigest()).toHaveLength(64);
    expect(service.getCanonicalNormalizedScene()).not.toContain('hostEpoch');
  });

  it('serializes concurrent intents into monotonic revisions', async () => {
    const { service } = createHarness();
    await service.initialize();
    const actor = await gainControl(service);
    const revisions: number[] = [];
    service.subscribe((event) => revisions.push(event.revision));

    const [first, second] = await Promise.all([
      service.dispatchIntent(resourceIntent('op1', 1, 0), actor),
      service.dispatchIntent(resourceIntent('op2', 2, 0), actor),
    ]);

    expect(first).toMatchObject({ accepted: true, committedRevision: 1 });
    expect(second).toMatchObject({ accepted: true, committedRevision: 2 });
    expect(revisions).toEqual([1, 2]);
    expect(service.getSnapshot().revision).toBe(2);
  });

  it('atomically removes catalog entities and every dependent scene reference', async () => {
    const { service } = createHarness();
    await service.initialize();
    const actor = await gainControl(service);
    const initial = service.getSnapshot();
    const populated: Extract<WorkspaceSceneIntent, { kind: 'scene.replace' }> = {
      t: 'state.intent',
      operationId: 'populate-scene',
      clientSeq: 1,
      baseRevision: 0,
      kind: 'scene.replace',
      payload: {
        catalog: catalog(),
        navigation: {
          ...initial.navigation,
          selectedRepositoryId: 'repo1',
          activeWorktreeId: 'worktree1',
          activePanelByWorktree: { worktree1: 'terminal' },
          panelOrderByWorktree: { worktree1: ['chat', 'terminal'] },
        },
        editors: {},
        agents: initial.agents,
        terminals: initial.terminals,
        todos: initial.todos,
        selections: initial.selections,
      },
    };
    expect(await service.dispatchIntent(populated, actor)).toMatchObject({ accepted: true });

    const removeEverything: Extract<WorkspaceSceneIntent, { kind: 'scene.replace' }> = {
      t: 'state.intent',
      operationId: 'remove-scene',
      clientSeq: 2,
      baseRevision: 1,
      kind: 'scene.replace',
      payload: {
        catalog: initial.catalog,
        navigation: initial.navigation,
        editors: initial.editors,
        agents: initial.agents,
        terminals: initial.terminals,
        todos: initial.todos,
        selections: initial.selections,
      },
    };
    expect(await service.dispatchIntent(removeEverything, actor)).toMatchObject({
      accepted: true,
      committedRevision: 2,
    });
    expect(service.getSnapshot()).toMatchObject({
      revision: 2,
      catalog: { repositories: {}, worktrees: {} },
      navigation: { selectedRepositoryId: null, activeWorktreeId: null },
    });
  });

  it('returns the cached committed result without repeating effects or events', async () => {
    const effect = vi.fn(async () => ({ ok: true }));
    const { service } = createHarness({ effect });
    await service.initialize();
    const actor = await gainControl(service);
    const events = vi.fn();
    service.subscribe(events);
    const intent = resourceIntent('same-operation', 1, 0);

    const first = await service.dispatchIntent(intent, actor);
    const retry = await service.dispatchIntent(intent, actor);

    expect(retry).toEqual(first);
    expect(effect).toHaveBeenCalledTimes(1);
    expect(events).toHaveBeenCalledTimes(1);
    expect(service.getSnapshot().revision).toBe(1);
  });

  it('serializes control transfer behind an in-flight effect and commit', async () => {
    let finishEffect: ((value: { ok: boolean }) => void) | undefined;
    const effect = vi.fn(
      () =>
        new Promise<{ ok: boolean }>((resolve) => {
          finishEffect = resolve;
        })
    );
    const repository = new InMemoryWorkspaceStateRepository();
    const { service } = createHarness({ effect, repository });
    await service.initialize();
    const actor = await gainControl(service);

    const dispatch = service.dispatchIntent(resourceIntent('slow-operation', 1, 0), actor);
    await vi.waitFor(() => expect(effect).toHaveBeenCalledTimes(1));
    const transfer = service.transferControl(actor, {
      clientId: 'client2',
      deviceId: 'device-client2',
    });
    finishEffect?.({ ok: true });

    expect(await dispatch).toMatchObject({ accepted: true, committedRevision: 1 });
    expect(await transfer).toMatchObject({
      granted: true,
      lease: { holderClientId: 'client2' },
    });
    expect(service.getSnapshot().revision).toBe(1);
    expect(await repository.loadOperation('slow-operation')).toMatchObject({
      state: 'committed',
    });
  });

  it('allows declared safe rebases but rejects stale destructive scene replacements', async () => {
    const { service } = createHarness();
    await service.initialize();
    const actor = await gainControl(service);

    const catalogResult = await service.dispatchIntent(
      {
        t: 'state.intent',
        operationId: 'catalog',
        clientSeq: 1,
        baseRevision: 0,
        kind: 'catalog.replace',
        payload: { catalog: catalog() },
      },
      actor
    );
    expect(catalogResult.accepted).toBe(true);

    const navigationResult = await service.dispatchIntent(
      {
        t: 'state.intent',
        operationId: 'navigation',
        clientSeq: 2,
        baseRevision: 0,
        kind: 'navigation.replace',
        payload: {
          navigation: {
            selectedRepositoryId: 'repo1',
            activeGroupId: 'group1',
            activeWorktreeId: 'worktree1',
            activePrimaryPanel: 'file',
            activePanelByWorktree: { worktree1: 'file' },
            panelOrderByWorktree: { worktree1: ['file', 'chat'] },
          },
        },
      },
      actor
    );
    expect(navigationResult).toMatchObject({ accepted: true, committedRevision: 2 });

    const staleEditor = await service.dispatchIntent(
      {
        t: 'state.intent',
        operationId: 'stale-editor',
        clientSeq: 3,
        baseRevision: 1,
        kind: 'editor.replace',
        payload: {
          worktreeId: 'worktree1',
          editor: { tabs: [], activeFile: null, buffers: {} },
        },
      },
      actor
    );
    expect(staleEditor).toMatchObject({ accepted: false, error: { code: 'CONFLICT' } });
    expect(service.getSnapshot().revision).toBe(2);
  });

  it('enforces editor buffer versions and leaves state unchanged on conflict', async () => {
    const { service } = createHarness();
    await service.initialize();
    const actor = await gainControl(service);
    await service.dispatchIntent(
      {
        t: 'state.intent',
        operationId: 'catalog',
        clientSeq: 1,
        baseRevision: 0,
        kind: 'catalog.replace',
        payload: { catalog: catalog() },
      },
      actor
    );
    await service.dispatchIntent(
      {
        t: 'state.intent',
        operationId: 'editor',
        clientSeq: 2,
        baseRevision: 1,
        kind: 'editor.replace',
        payload: {
          worktreeId: 'worktree1',
          editor: {
            tabs: [
              {
                id: 'tab1',
                path: '/host/repo/a.ts',
                title: 'a.ts',
                order: 0,
                encoding: 'utf8',
                isUnsupported: false,
              },
            ],
            activeFile: '/host/repo/a.ts',
            buffers: {
              '/host/repo/a.ts': {
                path: '/host/repo/a.ts',
                content: 'one',
                isDirty: true,
                version: 1,
                hasExternalChange: false,
              },
            },
          },
        },
      },
      actor
    );

    const conflict = await service.dispatchIntent(
      {
        t: 'state.intent',
        operationId: 'buffer',
        clientSeq: 3,
        baseRevision: 2,
        kind: 'editor.buffer.update',
        payload: {
          worktreeId: 'worktree1',
          path: '/host/repo/a.ts',
          baseVersion: 0,
          nextVersion: 1,
          content: 'two',
          isDirty: true,
          hasExternalChange: false,
        },
      },
      actor
    );

    expect(conflict).toMatchObject({ accepted: false, error: { code: 'CONFLICT' } });
    expect(service.getSnapshot().editors.worktree1?.buffers['/host/repo/a.ts']?.content).toBe(
      'one'
    );
    expect(service.getSnapshot().revision).toBe(2);
  });

  it('replays a contiguous suffix and requires resync below the compaction floor', async () => {
    const { service } = createHarness();
    await service.initialize();
    const actor = await gainControl(service);
    await service.dispatchIntent(resourceIntent('op1', 1, 0), actor);
    await service.dispatchIntent(resourceIntent('op2', 2, 1), actor);
    await service.dispatchIntent(resourceIntent('op3', 3, 2), actor);

    expect(service.resume({ hostEpoch: HOST_EPOCH, sceneId: 'scene1', revision: 1 })).toMatchObject(
      {
        t: 'state.replay',
        fromRevision: 2,
        toRevision: 3,
      }
    );
    await service.compactEventsThrough(2);
    expect(service.getCompactionFloor()).toBe(2);
    expect(service.resume({ hostEpoch: HOST_EPOCH, sceneId: 'scene1', revision: 1 })).toMatchObject(
      { t: 'state.resyncRequired', reason: 'retention-floor' }
    );
    expect(service.resume({ hostEpoch: HOST_EPOCH, sceneId: 'scene1', revision: 2 })).toMatchObject(
      { t: 'state.replay', fromRevision: 3, toRevision: 3 }
    );
    expect(
      service.resume({ hostEpoch: NEXT_HOST_EPOCH, sceneId: 'scene1', revision: 3 })
    ).toMatchObject({ t: 'state.resyncRequired', reason: 'epoch-changed' });
  });

  it('automatically compacts events older than the retention window beyond the minimum tail', async () => {
    const { service, advance } = createHarness({
      retention: { minimumEvents: 1, maxAgeMs: 100, maxBytes: 1024 * 1024 },
    });
    await service.initialize();
    const actor = await gainControl(service);
    await service.dispatchIntent(resourceIntent('old-event', 1, 0), actor);
    advance(101);
    await service.dispatchIntent(resourceIntent('new-event', 2, 1), actor);

    expect(service.getCompactionFloor()).toBe(1);
    expect(service.resume({ hostEpoch: HOST_EPOCH, sceneId: 'scene1', revision: 0 })).toMatchObject(
      { t: 'state.resyncRequired', reason: 'retention-floor' }
    );
    expect(service.resume({ hostEpoch: HOST_EPOCH, sceneId: 'scene1', revision: 1 })).toMatchObject(
      { t: 'state.replay', fromRevision: 2, toRevision: 2 }
    );
  });

  it('rejects resource invalidations that move a generation backwards', async () => {
    const { service } = createHarness();
    await service.initialize();
    const actor = await gainControl(service);
    const first = resourceIntent('resource-new', 1, 0, 2);
    first.payload.resourceKey = 'git-status:repo1';
    const stale = resourceIntent('resource-stale', 2, 1, 1);
    stale.payload.resourceKey = 'git-status:repo1';

    expect(await service.dispatchIntent(first, actor)).toMatchObject({ accepted: true });
    expect(await service.dispatchIntent(stale, actor)).toMatchObject({
      accepted: false,
      error: { code: 'CONFLICT' },
    });
    expect(service.getSnapshot().revision).toBe(1);
  });

  it('commits host-derived invalidations without requiring a controller lease', async () => {
    const { service } = createHarness();
    await service.initialize();
    const first = await service.invalidateResource({
      resourceKey: 'file-tree:repo1',
      domain: 'file-tree',
      entityId: null,
      reason: 'changed',
    });
    const second = await service.invalidateResource({
      resourceKey: 'file-tree:repo1',
      domain: 'file-tree',
      entityId: null,
      reason: 'reset',
    });
    expect([first.revision, second.revision]).toEqual([1, 2]);
    expect(first.origin.source).toBe('host');
    expect(service.getSnapshot().resources.invalidations['file-tree:repo1']).toMatchObject({
      generation: 2,
      reason: 'reset',
    });
  });

  it('rebuilds the same normalized state by applying committed events', async () => {
    const { service } = createHarness();
    await service.initialize();
    const initial = service.getSnapshot();
    const actor = await gainControl(service);
    const events: Parameters<typeof applyWorkspaceSceneEvent>[1][] = [];
    service.subscribe((event) => events.push(event));

    await service.dispatchIntent(resourceIntent('op1', 1, 0), actor);
    await service.dispatchIntent(resourceIntent('op2', 2, 1), actor);

    let projection = initial;
    for (const event of events) {
      const application = applyWorkspaceSceneEvent(projection, event);
      expect(application.status).toBe('applied');
      if (application.status === 'applied') projection = application.snapshot;
    }
    expect(projection.revision).toBe(service.getSnapshot().revision);
    expect(await digestWorkspaceScene(projection)).toBe(await service.getNormalizedDigest());
    expect(applyWorkspaceSceneEvent(projection, events[1]!).status).toBe('duplicate');
  });

  it('transfers, revokes and expires controller leases without changing scene revision or digest', async () => {
    const { service, advance } = createHarness();
    await service.initialize();
    const beforeDigest = await service.getNormalizedDigest();
    const first = await gainControl(service, 'client1');
    const denied = await service.requestControl({
      clientId: 'client2',
      deviceId: 'device-client2',
    });
    expect(denied).toMatchObject({ granted: false, error: { code: 'LEASE_REQUIRED' } });

    const transferred = await service.transferControl(first, {
      clientId: 'client2',
      deviceId: 'device-client2',
    });
    expect(transferred).toMatchObject({ granted: true, lease: { holderClientId: 'client2' } });
    if (!transferred.granted) throw new Error('Expected transferred lease');
    const second = {
      clientId: 'client2',
      deviceId: 'device-client2',
      leaseId: transferred.lease.leaseId,
    };
    expect(await service.markControllerDisconnected(second)).toBe(true);
    advance(5_001);
    expect(await service.sweepExpiredLease()).toBe(true);
    expect(await service.getControllerLease()).toBeNull();

    const renewed = await service.requestControl({
      clientId: 'client1',
      deviceId: 'device-client1',
    });
    expect(renewed.granted).toBe(true);
    const renewedAgain = await service.requestControl({
      clientId: 'client1',
      deviceId: 'device-client1',
    });
    expect(renewedAgain).toMatchObject({
      granted: true,
      lease: { leaseId: renewed.granted ? renewed.lease.leaseId : '' },
    });
    advance(30_001);
    expect(await service.sweepExpiredLease()).toBe(true);
    expect(await service.getControllerLease()).toBeNull();

    expect(
      (
        await service.requestControl({
          clientId: 'client1',
          deviceId: 'device-client1',
        })
      ).granted
    ).toBe(true);
    expect(await service.revokeControl('host-revoked')).toBe(true);
    expect(service.getSnapshot().revision).toBe(0);
    expect(await service.getNormalizedDigest()).toBe(beforeDigest);
  });

  it('loads durable state under a new epoch and rejects old resume cursors', async () => {
    const repository = new InMemoryWorkspaceStateRepository();
    const firstHarness = createHarness({ repository });
    await firstHarness.service.initialize();
    const actor = await gainControl(firstHarness.service);
    await firstHarness.service.dispatchIntent(resourceIntent('op1', 1, 0), actor);

    const restarted = createHarness({ repository, hostEpoch: NEXT_HOST_EPOCH }).service;
    await restarted.initialize();

    expect(restarted.getSnapshot()).toMatchObject({ revision: 1, hostEpoch: NEXT_HOST_EPOCH });
    const restartedActor = await gainControl(restarted);
    expect(
      await restarted.dispatchIntent(resourceIntent('op1', 1, 0), restartedActor)
    ).toMatchObject({ accepted: true, committedRevision: 1 });
    expect(restarted.getSnapshot().revision).toBe(1);
    expect(
      restarted.resume({ hostEpoch: HOST_EPOCH, sceneId: 'scene1', revision: 1 })
    ).toMatchObject({ t: 'state.resyncRequired', reason: 'epoch-changed' });
  });

  it('rejects invalid cross-domain references without committing a revision', async () => {
    const { service } = createHarness();
    await service.initialize();
    const actor = await gainControl(service);
    const invalid = catalog();
    invalid.worktrees.worktree1!.repositoryId = 'missing';

    const result = await service.dispatchIntent(
      {
        t: 'state.intent',
        operationId: 'invalid-catalog',
        clientSeq: 1,
        baseRevision: 0,
        kind: 'catalog.replace',
        payload: { catalog: invalid },
      },
      actor
    );

    expect(result).toMatchObject({ accepted: false, error: { code: 'CONFLICT' } });
    expect(service.getSnapshot().revision).toBe(0);
  });
});
