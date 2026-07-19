import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IPC_CHANNELS } from '@shared/types';
import {
  createEmptyWorkspaceSceneSnapshot,
  encodeWorkspaceCommandArgs,
  type WorkspaceCommandExecuteFrame,
  type WorkspacePanelId,
  type WorkspaceSceneSnapshot,
} from '@shared/types/workspaceMirror';
import sqlite3 from 'sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SQLITE_WORKSPACE_SCHEMA_VERSION,
  SqliteWorkspaceStateRepository,
} from '../SqliteWorkspaceStateRepository';
import {
  createRemoteWorkspaceCommandRegistry,
  digestWorkspaceCommandRequest,
  WORKSPACE_COMMAND_VERSION,
  WorkspaceCommandExecutor,
} from '../WorkspaceCommandRegistry';
import { WorkspaceEntityRegistry } from '../WorkspaceEntityRegistry';
import type {
  WorkspaceOperationRecord,
  WorkspaceRepositoryCommit,
} from '../WorkspaceStateRepository';
import { digestWorkspaceOperationResult } from '../WorkspaceStateRepository';

const HOST_EPOCH = '11111111-1111-4111-8111-111111111111';
const REQUEST_DIGEST = 'a'.repeat(64);

function openRawDatabase(path: string): Promise<sqlite3.Database> {
  return new Promise((resolve, reject) => {
    const database = new sqlite3.Database(path, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(database);
    });
  });
}

function rawExec(database: sqlite3.Database, sql: string): Promise<void> {
  return new Promise((resolve, reject) => {
    database.exec(sql, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function rawRun(
  database: sqlite3.Database,
  sql: string,
  parameters: readonly unknown[] = []
): Promise<void> {
  return new Promise((resolve, reject) => {
    database.run(sql, parameters, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function rawGet<Row>(database: sqlite3.Database, sql: string): Promise<Row | undefined> {
  return new Promise((resolve, reject) => {
    database.get(sql, (error, row: Row | undefined) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(row);
    });
  });
}

function closeRawDatabase(database: sqlite3.Database): Promise<void> {
  return new Promise((resolve, reject) => {
    database.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function createCommit(
  revision: number,
  operationId: string,
  activePrimaryPanel: WorkspacePanelId = 'file'
): WorkspaceRepositoryCommit<{ panel: WorkspacePanelId }> {
  const empty = createEmptyWorkspaceSceneSnapshot({
    hostId: 'host-1',
    sceneId: 'scene-1',
    hostEpoch: HOST_EPOCH,
  });
  const snapshot = {
    ...empty,
    revision,
    navigation: { ...empty.navigation, activePrimaryPanel },
  };
  const committedAt = 1_000 + revision;

  return {
    snapshot,
    event: {
      t: 'state.event',
      hostEpoch: HOST_EPOCH,
      sceneId: 'scene-1',
      revision,
      origin: {
        source: 'client',
        clientId: 'client-1',
        deviceId: 'device-1',
        operationId,
      },
      kind: 'navigation.replace',
      payload: { navigation: snapshot.navigation },
    },
    operation: {
      operationId,
      intentKind: 'navigation.replace',
      sceneId: 'scene-1',
      clientId: 'client-1',
      deviceId: 'device-1',
      commandVersion: 1,
      requestDigest: REQUEST_DIGEST,
      state: 'committed',
      baseRevision: revision - 1,
      committedRevision: revision,
      result: { panel: activePrimaryPanel },
      resultDigest: digestWorkspaceOperationResult({ panel: activePrimaryPanel }),
      createdAt: committedAt,
      updatedAt: committedAt,
    },
    committedAt,
  };
}

function createOperation<TResult = unknown>(
  operationId: string,
  state: WorkspaceOperationRecord['state'],
  overrides: Partial<WorkspaceOperationRecord<TResult>> = {}
): WorkspaceOperationRecord<TResult> {
  return {
    operationId,
    intentKind: 'workspace.command',
    sceneId: 'scene-1',
    clientId: 'client-1',
    deviceId: 'device-1',
    commandVersion: 1,
    requestDigest: REQUEST_DIGEST,
    state,
    baseRevision: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

async function createVersionOneDatabase(
  path: string,
  configureSnapshot?: (snapshot: WorkspaceSceneSnapshot) => void
): Promise<void> {
  const database = await openRawDatabase(path);
  const snapshot = createEmptyWorkspaceSceneSnapshot({
    hostId: 'host-1',
    sceneId: 'scene-1',
    hostEpoch: HOST_EPOCH,
  });
  configureSnapshot?.(snapshot);
  try {
    await rawExec(
      database,
      `
        CREATE TABLE workspace_snapshot (
          singleton       INTEGER PRIMARY KEY CHECK (singleton = 1),
          revision        INTEGER NOT NULL,
          host_epoch      TEXT NOT NULL,
          scene_id        TEXT NOT NULL,
          snapshot_json   TEXT NOT NULL,
          updated_at      INTEGER NOT NULL
        );
        CREATE TABLE workspace_events (
          host_epoch      TEXT NOT NULL,
          scene_id        TEXT NOT NULL,
          revision        INTEGER NOT NULL,
          event_json      TEXT NOT NULL,
          committed_at    INTEGER NOT NULL,
          PRIMARY KEY (host_epoch, scene_id, revision)
        );
        CREATE TABLE legacy_marker (value TEXT NOT NULL);
        INSERT INTO legacy_marker (value) VALUES ('preserved');
        PRAGMA user_version = 1;
      `
    );
    await rawRun(
      database,
      `INSERT INTO workspace_snapshot
         (singleton, revision, host_epoch, scene_id, snapshot_json, updated_at)
       VALUES (1, ?, ?, ?, ?, ?)`,
      [snapshot.revision, snapshot.hostEpoch, snapshot.sceneId, JSON.stringify(snapshot), 1]
    );
  } finally {
    await closeRawDatabase(database);
  }
}

async function createVersionTwoDatabaseWithLegacyOperation(path: string): Promise<void> {
  await createVersionOneDatabase(path);
  const database = await openRawDatabase(path);
  const legacyOperation = {
    operationId: 'legacy-operation',
    intentKind: 'navigation.replace',
    clientId: 'legacy-client',
    deviceId: 'legacy-device',
    state: 'prepared',
    baseRevision: 0,
    createdAt: 1,
    updatedAt: 1,
  };
  try {
    await rawExec(
      database,
      `
        CREATE TABLE workspace_operations (
          operation_id       TEXT PRIMARY KEY,
          state              TEXT NOT NULL,
          committed_revision INTEGER,
          operation_json     TEXT NOT NULL,
          updated_at         INTEGER NOT NULL
        );
        CREATE INDEX idx_workspace_operations_state
          ON workspace_operations (state, updated_at);
        PRAGMA user_version = 2;
      `
    );
    await rawRun(
      database,
      `INSERT INTO workspace_operations
         (operation_id, state, committed_revision, operation_json, updated_at)
       VALUES (?, ?, NULL, ?, ?)`,
      [
        legacyOperation.operationId,
        legacyOperation.state,
        JSON.stringify(legacyOperation),
        legacyOperation.updatedAt,
      ]
    );
  } finally {
    await closeRawDatabase(database);
  }
}

describe('SqliteWorkspaceStateRepository', () => {
  let temporaryDirectory: string;
  let databasePath: string;
  let repositories: SqliteWorkspaceStateRepository[];

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), 'enso-workspace-state-'));
    databasePath = join(temporaryDirectory, 'workspace.db');
    repositories = [];
  });

  afterEach(async () => {
    await Promise.all(repositories.map((repository) => repository.close()));
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  function createRepository(
    path = databasePath,
    options: ConstructorParameters<typeof SqliteWorkspaceStateRepository>[1] = {}
  ): SqliteWorkspaceStateRepository {
    const repository = new SqliteWorkspaceStateRepository(path, options);
    repositories.push(repository);
    return repository;
  }

  it('restores the snapshot, event log, and operation ledger after restart', async () => {
    const first = createRepository();
    await first.initialize();
    const commit = createCommit(1, 'operation-1');
    await first.commit(commit);
    await first.close();

    const restarted = createRepository();
    await restarted.initialize();

    expect(await restarted.loadSnapshot()).toEqual(commit.snapshot);
    expect(await restarted.loadEvents()).toEqual([
      { event: commit.event, committedAt: commit.committedAt },
    ]);
    expect(await restarted.loadOperation('operation-1')).toEqual(commit.operation);
  });

  it('redacts volatile payloads from atomic scene replacement persistence', async () => {
    const repository = createRepository();
    await repository.initialize();
    const snapshot = createEmptyWorkspaceSceneSnapshot({
      hostId: 'host-1',
      sceneId: 'scene-1',
      hostEpoch: HOST_EPOCH,
    });
    snapshot.revision = 1;
    snapshot.catalog.repositories.repo = {
      id: 'repo',
      path: '/repo',
      name: 'repo',
      groupId: null,
      order: 0,
      settings: { autoInitWorktree: false, initScript: '', hidden: false },
    };
    snapshot.catalog.worktrees.worktree = {
      id: 'worktree',
      repositoryId: 'repo',
      path: '/repo',
      name: 'main',
      branch: 'main',
      order: 0,
      isMain: true,
    };
    snapshot.editors.worktree = {
      tabs: [
        {
          id: 'tab-draft',
          path: '/repo/draft.ts',
          title: 'draft.ts',
          order: 0,
          encoding: 'utf-8',
          isUnsupported: false,
        },
      ],
      activeFile: '/repo/draft.ts',
      buffers: {
        '/repo/draft.ts': {
          path: '/repo/draft.ts',
          content: 'volatile dirty source',
          isDirty: true,
          version: 1,
          hasExternalChange: false,
        },
      },
    };
    snapshot.agents.sessions.agent = {
      id: 'agent',
      providerSessionId: 'provider-session',
      generation: 1,
      agentId: 'claude',
      name: 'Agent',
      repositoryId: 'repo',
      worktreeId: 'worktree',
      terminalSessionId: null,
      environment: 'native',
      initialized: true,
      activated: true,
      displayOrder: 0,
      runtimeState: 'idle',
      status: 'idle',
      waitingReason: null,
      draft: { text: 'volatile prompt', resources: [] },
      task: null,
    };
    const payload = {
      catalog: snapshot.catalog,
      navigation: snapshot.navigation,
      editors: snapshot.editors,
      agents: snapshot.agents,
      terminals: snapshot.terminals,
      todos: snapshot.todos,
      selections: snapshot.selections,
    };
    await repository.commit({
      snapshot,
      event: {
        t: 'state.event',
        hostEpoch: HOST_EPOCH,
        sceneId: 'scene-1',
        revision: 1,
        origin: {
          source: 'client',
          clientId: 'client-1',
          deviceId: 'device-1',
          operationId: 'scene-replace',
        },
        kind: 'scene.replace',
        payload,
      },
      operation: {
        operationId: 'scene-replace',
        intentKind: 'scene.replace',
        sceneId: 'scene-1',
        clientId: 'client-1',
        deviceId: 'device-1',
        commandVersion: 1,
        requestDigest: REQUEST_DIGEST,
        state: 'committed',
        baseRevision: 0,
        committedRevision: 1,
        createdAt: 1,
        updatedAt: 1,
      },
      committedAt: 1,
    });

    const persistedSnapshot = await repository.loadSnapshot();
    const persistedEvent = (await repository.loadEvents())[0]?.event;
    expect(persistedSnapshot?.editors.worktree?.buffers['/repo/draft.ts']).toMatchObject({
      isDirty: false,
      hasExternalChange: false,
    });
    expect(persistedSnapshot?.editors.worktree?.buffers['/repo/draft.ts']?.content).toBeUndefined();
    expect(persistedSnapshot?.agents.sessions.agent?.draft).toEqual({ text: '', resources: [] });
    expect(persistedEvent?.kind).toBe('scene.replace');
    if (persistedEvent?.kind !== 'scene.replace')
      throw new Error('scene replacement event missing');
    expect(
      persistedEvent.payload.editors.worktree?.buffers['/repo/draft.ts']?.content
    ).toBeUndefined();
    expect(persistedEvent.payload.agents.sessions.agent?.draft).toEqual({
      text: '',
      resources: [],
    });
  });

  it('keeps request canaries, host paths, and thrown errors out of SQLite and logs', async () => {
    const repository = createRepository();
    await repository.initialize();
    const executor = new WorkspaceCommandExecutor({
      repository,
      registry: createRemoteWorkspaceCommandRegistry(),
      sceneId: 'scene-1',
      getRevision: () => 0,
      clock: { now: () => 100 },
    });
    const canary = 'remote-mirror-sensitive-canary-7f1f';
    const absolutePath = `/private/${canary}/repository`;
    const actor = { clientId: 'client-1', deviceId: 'device-1' };
    const commandFrame = (
      operationId: string,
      command: string,
      values: readonly unknown[]
    ): WorkspaceCommandExecuteFrame => {
      const args = encodeWorkspaceCommandArgs(values);
      return {
        t: 'command.execute',
        operationId,
        clientSeq: 1,
        command,
        commandVersion: WORKSPACE_COMMAND_VERSION,
        requestDigest: digestWorkspaceCommandRequest(command, WORKSPACE_COMMAND_VERSION, args),
        args,
      };
    };
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await executor.execute({
      frame: commandFrame('sensitive-register', IPC_CHANNELS.WORKSPACE_MIRROR_REGISTER_ENTITY, [
        'repository',
        absolutePath,
      ]),
      actor,
      authorize: async () => null,
      invoke: async () => ({
        sceneId: 'scene-1',
        entityId: 'opaque-entity-id',
        kind: 'repository',
        path: absolutePath,
        normalizedPath: absolutePath,
        disposition: 'new',
      }),
    });
    const failed = await executor.execute({
      frame: commandFrame('sensitive-todo', IPC_CHANNELS.TODO_AI_POLISH, [
        {
          text: canary,
          timeout: 30_000,
          provider: 'claude-code',
          model: 'default',
        },
      ]),
      actor,
      authorize: async () => null,
      invoke: async () => {
        throw new Error(`external failure: ${canary}`);
      },
    });
    expect(JSON.stringify(failed)).not.toContain(canary);

    await repository.close();
    const databaseBytes = Buffer.concat(
      await Promise.all(
        [databasePath, `${databasePath}-wal`, `${databasePath}-shm`].map((path) =>
          readFile(path).catch(() => Buffer.alloc(0))
        )
      )
    ).toString('latin1');
    expect(databaseBytes).not.toContain(canary);
    expect(databaseBytes).not.toContain(absolutePath);
    expect(
      JSON.stringify([...log.mock.calls, ...warn.mock.calls, ...error.mock.calls])
    ).not.toContain(canary);
    log.mockRestore();
    warn.mockRestore();
    error.mockRestore();
  });

  it('removes events atomically when a new host epoch replaces the snapshot', async () => {
    const repository = createRepository();
    await repository.initialize();
    const commit = createCommit(1, 'operation-1');
    await repository.commit(commit);

    const nextEpochSnapshot = {
      ...commit.snapshot,
      hostEpoch: '22222222-2222-4222-8222-222222222222',
      revision: 0,
    };
    await repository.saveSnapshot(nextEpochSnapshot);

    expect(await repository.loadEvents()).toEqual([]);
    await repository.close();
    const database = await openRawDatabase(databasePath);
    try {
      expect(
        (
          await rawGet<{ count: number }>(
            database,
            'SELECT COUNT(*) AS count FROM workspace_events'
          )
        )?.count
      ).toBe(0);
    } finally {
      await closeRawDatabase(database);
    }
  });

  it('rolls back snapshot and operation writes when an event insert fails', async () => {
    const repository = createRepository();
    await repository.initialize();
    const committed = createCommit(1, 'operation-1', 'file');
    await repository.commit(committed);

    const conflicting = createCommit(1, 'operation-2', 'terminal');
    conflicting.snapshot.catalog.repositories['rolled-back-repository'] = {
      id: 'rolled-back-repository',
      path: '/workspace/rolled-back',
      name: 'rolled-back',
      groupId: null,
      order: 0,
      settings: { autoInitWorktree: false, initScript: '', hidden: false },
    };
    await expect(repository.commit(conflicting)).rejects.toThrow();

    expect(await repository.loadSnapshot()).toEqual(committed.snapshot);
    expect(await repository.loadEvents()).toEqual([
      { event: committed.event, committedAt: committed.committedAt },
    ]);
    expect(await repository.loadOperation('operation-2')).toBeNull();
    expect((await repository.loadEntityRegistry('scene-1')).entities).toEqual([]);
  });

  it('keeps committed operation results immutable for idempotent lookup', async () => {
    const repository = createRepository();
    await repository.initialize();
    const commit = createCommit(1, 'operation-1');
    await repository.commit(commit);

    const attemptedOverwrite: WorkspaceOperationRecord = {
      ...commit.operation,
      state: 'failed',
      committedRevision: undefined,
      result: undefined,
      error: { code: 'LATE_FAILURE', message: 'must not replace committed state' },
      updatedAt: commit.operation.updatedAt + 1,
    };
    await expect(repository.saveOperation(attemptedOverwrite)).rejects.toThrow(
      /Illegal.*committed -> failed/
    );

    expect(await repository.loadOperation('operation-1')).toEqual(commit.operation);
    await expect(repository.commit(commit)).rejects.toThrow(/already terminal/);
  });

  it('enforces operation binding uniqueness and legal CAS transitions transactionally', async () => {
    const repository = createRepository();
    await repository.initialize();
    const prepared = createOperation('operation-1', 'prepared');
    await repository.saveOperation(prepared);

    await expect(
      repository.saveOperation({ ...prepared, requestDigest: 'b'.repeat(64) })
    ).rejects.toThrow(/binding conflict/);
    await expect(
      repository.compareAndSwapOperation(
        prepared.operationId,
        'prepared',
        createOperation(prepared.operationId, 'committed', { committedRevision: 1 })
      )
    ).rejects.toThrow(/Illegal.*prepared -> committed/);
    expect((await repository.loadOperation(prepared.operationId))?.state).toBe('prepared');

    await expect(
      repository.compareAndSwapOperation(
        prepared.operationId,
        'prepared',
        createOperation(prepared.operationId, 'executing', { updatedAt: 2 })
      )
    ).resolves.toBe(true);
    await expect(
      repository.compareAndSwapOperation(
        prepared.operationId,
        'prepared',
        createOperation(prepared.operationId, 'cancelled', {
          error: { code: 'NOT_EXECUTED', message: 'startup recovery' },
          updatedAt: 3,
        })
      )
    ).resolves.toBe(false);
    await expect(
      repository.compareAndSwapOperation(
        prepared.operationId,
        'executing',
        createOperation(prepared.operationId, 'needs_reconcile', { updatedAt: 3 })
      )
    ).resolves.toBe(true);
    await expect(
      repository.compareAndSwapOperation(
        prepared.operationId,
        'needs_reconcile',
        createOperation(prepared.operationId, 'failed', {
          error: { code: 'RECONCILED_FAILURE', message: 'effect was not adopted' },
          updatedAt: 4,
        })
      )
    ).resolves.toBe(true);
    await expect(
      repository.compareAndSwapOperation(
        prepared.operationId,
        'failed',
        createOperation(prepared.operationId, 'committed', { committedRevision: 1 })
      )
    ).rejects.toThrow(/Illegal.*failed -> committed/);
    expect(await repository.loadOperation(prepared.operationId)).toMatchObject({
      state: 'failed',
      error: { code: 'RECONCILED_FAILURE' },
    });
  });

  it('persists unfinished-operation enumeration and deterministic prepared cancellation', async () => {
    const first = createRepository();
    await first.initialize();
    const prepared = createOperation('prepared', 'prepared', { createdAt: 1 });
    const executing = createOperation('executing', 'prepared', {
      createdAt: 2,
      reconcileMetadata: {
        domain: 'file',
        rootEntityId: 'repository-1',
        relativePath: 'src/index.ts',
        digest: 'a'.repeat(64),
      },
    });
    const unknown = createOperation('unknown', 'prepared', { createdAt: 3 });
    const cancelled = createOperation('cancelled', 'prepared', { createdAt: 4 });
    await first.saveOperation(prepared);
    await first.saveOperation(executing);
    await first.compareAndSwapOperation(executing.operationId, 'prepared', {
      ...executing,
      state: 'executing',
    });
    await first.saveOperation(unknown);
    await first.compareAndSwapOperation(unknown.operationId, 'prepared', {
      ...unknown,
      state: 'executing',
    });
    await first.compareAndSwapOperation(unknown.operationId, 'executing', {
      ...unknown,
      state: 'needs_reconcile',
    });
    await first.saveOperation(cancelled);
    await first.compareAndSwapOperation(cancelled.operationId, 'prepared', {
      ...cancelled,
      state: 'cancelled',
    });
    await first.saveOperation(
      createOperation('other-scene', 'prepared', { sceneId: 'scene-2', createdAt: 5 })
    );
    await first.close();

    const restarted = createRepository();
    await restarted.initialize();
    expect(
      (await restarted.listUnfinishedOperations('scene-1')).map(({ operationId }) => operationId)
    ).toEqual(['prepared', 'executing', 'unknown']);
    expect(await restarted.loadOperation('executing')).toMatchObject({
      reconcileMetadata: {
        domain: 'file',
        rootEntityId: 'repository-1',
        relativePath: 'src/index.ts',
        digest: 'a'.repeat(64),
      },
    });

    await expect(
      restarted.compareAndSwapOperation(
        'prepared',
        'prepared',
        createOperation('prepared', 'cancelled', {
          error: { code: 'NOT_EXECUTED', message: 'effect never began' },
          updatedAt: 6,
        })
      )
    ).resolves.toBe(true);
    expect(await restarted.loadOperation('prepared')).toMatchObject({
      state: 'cancelled',
      error: { code: 'NOT_EXECUTED' },
    });
    await expect(
      restarted.saveOperation(createOperation('prepared', 'executing', { updatedAt: 7 }))
    ).rejects.toThrow(/Illegal.*cancelled -> executing/);
    expect(
      (await restarted.listUnfinishedOperations('scene-1')).map(({ operationId }) => operationId)
    ).toEqual(['executing', 'unknown']);
  });

  it('compacts terminal results into immutable tombstones without permitting re-execution', async () => {
    const repository = createRepository();
    await repository.initialize();
    const commit = createCommit(1, 'operation-1');
    await repository.commit(commit);
    const unknown = createOperation<{ status: string }>('unknown', 'prepared');
    await repository.saveOperation(unknown);
    await repository.compareAndSwapOperation(unknown.operationId, 'prepared', {
      ...unknown,
      state: 'executing',
    });
    await repository.compareAndSwapOperation(unknown.operationId, 'executing', {
      ...unknown,
      state: 'needs_reconcile',
      result: { status: 'inspect' },
    });

    await expect(repository.compactOperationResultsBefore(2_000, 3_000)).resolves.toBe(1);
    const tombstone = await repository.loadOperation<{ panel: WorkspacePanelId }>('operation-1');
    expect(tombstone).toMatchObject({
      state: 'committed',
      resultDigest: commit.operation.resultDigest,
      resultCompactedAt: 3_000,
    });
    expect(tombstone?.result).toBeUndefined();
    expect((await repository.loadOperation('unknown'))?.result).toEqual({ status: 'inspect' });

    await repository.saveOperation({
      ...commit.operation,
      result: { panel: 'terminal' },
      updatedAt: 4_000,
    });
    expect((await repository.loadOperation('operation-1'))?.result).toBeUndefined();
    await expect(
      repository.saveOperation({
        ...commit.operation,
        state: 'executing',
        committedRevision: undefined,
        result: undefined,
        resultDigest: undefined,
        updatedAt: 4_001,
      })
    ).rejects.toThrow(/Illegal.*committed -> executing/);

    await repository.close();
    const restarted = createRepository();
    await restarted.initialize();
    expect(await restarted.loadOperation('operation-1')).toMatchObject({
      state: 'committed',
      resultDigest: commit.operation.resultDigest,
      resultCompactedAt: 3_000,
    });
    expect((await restarted.loadOperation('operation-1'))?.result).toBeUndefined();
  });

  it('compacts only events through the requested current-scene revision', async () => {
    const repository = createRepository();
    await repository.initialize();
    await repository.commit(createCommit(1, 'operation-1'));
    await repository.commit(createCommit(2, 'operation-2', 'terminal'));
    await repository.commit(createCommit(3, 'operation-3', 'todo'));

    await repository.compactEventsThrough(2);

    const remaining = await repository.loadEvents();
    expect(remaining.map(({ event }) => event.revision)).toEqual([3]);
    await repository.close();

    const restarted = createRepository();
    await restarted.initialize();
    expect((await restarted.loadEvents()).map(({ event }) => event.revision)).toEqual([3]);
  });

  it('additively imports catalog IDs and persists rename aliases across restart', async () => {
    await createVersionOneDatabase(databasePath, (snapshot) => {
      snapshot.catalog.repositories['legacy-repository-id'] = {
        id: 'legacy-repository-id',
        path: '/workspace/original',
        name: 'project',
        groupId: null,
        order: 0,
        settings: { autoInitWorktree: false, initScript: '', hidden: false },
      };
      snapshot.catalog.worktrees['legacy-worktree-id'] = {
        id: 'legacy-worktree-id',
        repositoryId: 'legacy-repository-id',
        path: '/workspace/original',
        name: 'main',
        branch: 'main',
        order: 0,
        isMain: true,
      };
    });
    const first = createRepository();
    await first.initialize();
    expect(await first.loadEntityRegistry('scene-1')).toMatchObject({
      entities: [
        { entityId: 'legacy-repository-id', kind: 'repository', status: 'active' },
        { entityId: 'legacy-worktree-id', kind: 'worktree', status: 'active' },
      ],
    });

    const renamed = await first.loadSnapshot();
    if (!renamed) throw new Error('migrated snapshot missing');
    renamed.catalog.repositories['legacy-repository-id']!.path = '/workspace/renamed';
    renamed.catalog.worktrees['legacy-worktree-id']!.path = '/workspace/renamed';
    await first.saveSnapshot(renamed);
    await first.close();

    const restarted = createRepository();
    await restarted.initialize();
    const registry = new WorkspaceEntityRegistry(restarted, 'scene-1');
    await expect(
      registry.resolveEntity('repository', '/workspace/original')
    ).resolves.toMatchObject({
      status: 'resolved',
      entityId: 'legacy-repository-id',
      match: 'alias',
    });
    await expect(registry.resolveEntity('repository', '/workspace/renamed')).resolves.toMatchObject(
      {
        status: 'resolved',
        entityId: 'legacy-repository-id',
        match: 'current',
      }
    );
  });

  it('persists reservations, promotes them atomically, and keeps the UUID after two restarts', async () => {
    const reservedEntityId = '11111111-1111-4111-8111-111111111112';
    const first = createRepository();
    await first.initialize();
    const initial = createEmptyWorkspaceSceneSnapshot({
      hostId: 'host-1',
      sceneId: 'scene-1',
      hostEpoch: HOST_EPOCH,
    });
    await first.saveSnapshot(initial);
    const firstRegistry = new WorkspaceEntityRegistry(first, 'scene-1', {
      generateId: () => reservedEntityId,
      now: () => 10,
    });
    const reservation = await firstRegistry.reserveEntity('repository', '/workspace/reserved');
    expect(reservation.entityId).toBe(reservedEntityId);
    expect((await first.loadEntityRegistry('scene-1')).reservations).toMatchObject([
      { entityId: reservedEntityId, disposition: 'new' },
    ]);
    await first.close();

    const restarted = createRepository();
    await restarted.initialize();
    const restartedRegistry = new WorkspaceEntityRegistry(restarted, 'scene-1', {
      generateId: () => '22222222-2222-4222-8222-222222222222',
    });
    await expect(
      restartedRegistry.reserveEntity('repository', '/workspace/reserved')
    ).resolves.toMatchObject({ entityId: reservedEntityId, disposition: 'new' });

    const promotion = createCommit(1, 'promote-reservation');
    promotion.snapshot.catalog.repositories[reservedEntityId] = {
      id: reservedEntityId,
      path: '/workspace/reserved',
      name: 'reserved',
      groupId: null,
      order: 0,
      settings: { autoInitWorktree: false, initScript: '', hidden: false },
    };
    await restarted.commit(promotion);
    expect(await restarted.loadEntityRegistry('scene-1')).toMatchObject({
      entities: [
        expect.objectContaining({
          entityId: reservedEntityId,
          currentPath: '/workspace/reserved',
          status: 'active',
        }),
      ],
      reservations: [],
    });
    await restarted.close();

    const secondRestart = createRepository();
    await secondRestart.initialize();
    await expect(
      new WorkspaceEntityRegistry(secondRestart, 'scene-1').resolveEntity(
        'repository',
        '/workspace/reserved'
      )
    ).resolves.toMatchObject({
      entityId: reservedEntityId,
      match: 'current',
      durable: true,
    });
    expect((await secondRestart.loadEntityRegistry('scene-1')).reservations).toEqual([]);

    const rollbackReservation = await new WorkspaceEntityRegistry(secondRestart, 'scene-1', {
      generateId: () => '33333333-3333-4333-8333-333333333333',
      now: () => 20,
    }).reserveEntity('repository', '/workspace/rollback');
    const conflictingCommit = createCommit(2, 'conflicting-promotion');
    conflictingCommit.snapshot = structuredClone(promotion.snapshot);
    conflictingCommit.snapshot.revision = 2;
    conflictingCommit.snapshot.catalog.repositories['wrong-entity'] = {
      id: 'wrong-entity',
      path: '/workspace/rollback',
      name: 'wrong',
      groupId: null,
      order: 1,
      settings: { autoInitWorktree: false, initScript: '', hidden: false },
    };
    await expect(secondRestart.commit(conflictingCommit)).rejects.toMatchObject({
      code: 'ENTITY_PATH_CONFLICT',
    });
    expect(await secondRestart.loadSnapshot()).toEqual(promotion.snapshot);
    expect(await secondRestart.loadEntityRegistry('scene-1')).toMatchObject({
      entities: [expect.objectContaining({ entityId: reservedEntityId, status: 'active' })],
      reservations: [
        expect.objectContaining({ entityId: rollbackReservation.entityId, disposition: 'new' }),
      ],
    });
  });

  it('deletes a cancelled reservation durably', async () => {
    const first = createRepository();
    await first.initialize();
    await first.saveSnapshot(
      createEmptyWorkspaceSceneSnapshot({
        hostId: 'host-1',
        sceneId: 'scene-1',
        hostEpoch: HOST_EPOCH,
      })
    );
    const registry = new WorkspaceEntityRegistry(first, 'scene-1', {
      generateId: () => '44444444-4444-4444-8444-444444444444',
    });
    const reservation = await registry.reserveEntity('repository', '/workspace/cancelled');
    await registry.discardReservation(reservation.entityId);
    await first.close();

    const restarted = createRepository();
    await restarted.initialize();
    expect((await restarted.loadEntityRegistry('scene-1')).reservations).toEqual([]);
  });

  it('rolls back the scene and registry together when host-normalized paths collide', async () => {
    const repository = createRepository(databasePath, { entityPathPlatform: 'win32' });
    await repository.initialize();
    const initial = createEmptyWorkspaceSceneSnapshot({
      hostId: 'host-1',
      sceneId: 'scene-1',
      hostEpoch: HOST_EPOCH,
    });
    initial.catalog.repositories['repository-a'] = {
      id: 'repository-a',
      path: 'C:\\Workspace\\Project',
      name: 'project',
      groupId: null,
      order: 0,
      settings: { autoInitWorktree: false, initScript: '', hidden: false },
    };
    await repository.saveSnapshot(initial);

    const conflicting = structuredClone(initial);
    conflicting.catalog.repositories['repository-b'] = {
      id: 'repository-b',
      path: 'c:/workspace/PROJECT',
      name: 'duplicate',
      groupId: null,
      order: 1,
      settings: { autoInitWorktree: false, initScript: '', hidden: false },
    };
    await expect(repository.saveSnapshot(conflicting)).rejects.toMatchObject({
      code: 'ENTITY_PATH_CONFLICT',
    });
    expect(await repository.loadSnapshot()).toEqual(initial);
    expect((await repository.loadEntityRegistry('scene-1')).entities).toMatchObject([
      { entityId: 'repository-a', currentPath: 'C:\\Workspace\\Project', status: 'active' },
    ]);
  });

  it('migrates a version-one database additively without replacing prior data', async () => {
    await createVersionOneDatabase(databasePath);
    const repository = createRepository();
    await repository.initialize();

    expect((await repository.loadSnapshot())?.revision).toBe(0);
    await repository.saveOperation({
      operationId: 'prepared-operation',
      intentKind: 'navigation.replace',
      sceneId: 'scene-1',
      clientId: 'client-1',
      deviceId: 'device-1',
      commandVersion: 1,
      requestDigest: REQUEST_DIGEST,
      state: 'prepared',
      baseRevision: 0,
      createdAt: 1,
      updatedAt: 1,
    });
    expect((await repository.loadOperation('prepared-operation'))?.state).toBe('prepared');
    await repository.close();

    const database = await openRawDatabase(databasePath);
    try {
      expect(
        (await rawGet<{ user_version: number }>(database, 'PRAGMA user_version'))?.user_version
      ).toBe(SQLITE_WORKSPACE_SCHEMA_VERSION);
      expect(
        (await rawGet<{ value: string }>(database, 'SELECT value FROM legacy_marker'))?.value
      ).toBe('preserved');
    } finally {
      await closeRawDatabase(database);
    }
  });

  it('backfills legacy operation bindings during the additive version-four migration', async () => {
    await createVersionTwoDatabaseWithLegacyOperation(databasePath);
    const repository = createRepository();
    await repository.initialize();

    expect(await repository.loadOperation('legacy-operation')).toMatchObject({
      operationId: 'legacy-operation',
      sceneId: 'scene-1',
      clientId: 'legacy-client',
      deviceId: 'legacy-device',
      commandVersion: 1,
      requestDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      state: 'prepared',
    });
    await repository.close();

    const database = await openRawDatabase(databasePath);
    try {
      expect(
        await rawGet<{
          scene_id: string;
          device_id: string;
          client_id: string;
          command_version: number;
          request_digest: string;
        }>(
          database,
          `SELECT scene_id, device_id, client_id, command_version, request_digest
           FROM workspace_operations
           WHERE operation_id = 'legacy-operation'`
        )
      ).toMatchObject({
        scene_id: 'scene-1',
        device_id: 'legacy-device',
        client_id: 'legacy-client',
        command_version: 1,
        request_digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(
        (await rawGet<{ user_version: number }>(database, 'PRAGMA user_version'))?.user_version
      ).toBe(SQLITE_WORKSPACE_SCHEMA_VERSION);
    } finally {
      await closeRawDatabase(database);
    }
  });

  it('stores Todo rows and migration markers inside the workspace database', async () => {
    const repository = createRepository();
    await repository.initialize();
    const snapshot = createCommit(1, 'todo-operation').snapshot;
    snapshot.catalog.repositories['repo-1'] = {
      id: 'repo-1',
      path: '/repo',
      name: 'repo',
      groupId: null,
      order: 0,
      settings: { autoInitWorktree: false, initScript: '', hidden: false },
    };
    snapshot.todos.boardsByRepository['repo-1'] = {
      tasks: {
        'task-1': {
          id: 'task-1',
          title: 'Mirror Todo',
          description: 'Persist with the workspace scene',
          priority: 'high',
          status: 'in-progress',
          createdAt: 1,
          updatedAt: 2,
          order: 0,
          sessionId: null,
        },
      },
      autoExecution: {
        running: true,
        queue: ['task-1'],
        currentTaskId: 'task-1',
        currentSessionId: null,
      },
    };
    await repository.saveSnapshot(snapshot);
    await repository.markMigration('legacy-renderer-import-v1', { revision: 1 });
    await expect(repository.hasMigration('legacy-renderer-import-v1')).resolves.toBe(true);
    await repository.close();

    const database = await openRawDatabase(databasePath);
    try {
      expect(
        await rawGet<{ title: string; status: string }>(
          database,
          'SELECT title, status FROM workspace_todo_tasks WHERE task_id = "task-1"'
        )
      ).toEqual({ title: 'Mirror Todo', status: 'in-progress' });
      expect(
        await rawGet<{ running: number; queue_json: string }>(
          database,
          'SELECT running, queue_json FROM workspace_todo_auto_execution WHERE repository_id = "repo-1"'
        )
      ).toEqual({ running: 1, queue_json: '["task-1"]' });
    } finally {
      await closeRawDatabase(database);
    }
  });

  it('rejects persisted snapshot and event JSON that fails shared schemas', async () => {
    const snapshotDatabasePath = join(temporaryDirectory, 'corrupt-snapshot.db');
    const snapshotRepository = createRepository(snapshotDatabasePath);
    await snapshotRepository.initialize();
    await snapshotRepository.saveSnapshot(createCommit(1, 'operation-1').snapshot);
    await snapshotRepository.close();

    let database = await openRawDatabase(snapshotDatabasePath);
    await rawRun(database, 'UPDATE workspace_snapshot SET snapshot_json = ?', [
      JSON.stringify({ schemaVersion: 1, token: 'canary-secret' }),
    ]);
    await closeRawDatabase(database);

    const corruptSnapshotRepository = createRepository(snapshotDatabasePath);
    await corruptSnapshotRepository.initialize();
    await expect(corruptSnapshotRepository.loadSnapshot()).rejects.toThrow(
      /invalid scene snapshot/
    );

    const eventDatabasePath = join(temporaryDirectory, 'corrupt-event.db');
    const eventRepository = createRepository(eventDatabasePath);
    await eventRepository.initialize();
    await eventRepository.commit(createCommit(1, 'operation-1'));
    await eventRepository.close();

    database = await openRawDatabase(eventDatabasePath);
    await rawRun(database, 'UPDATE workspace_events SET event_json = ?', [
      JSON.stringify({ t: 'state.event', stack: 'canary-secret' }),
    ]);
    await closeRawDatabase(database);

    const corruptEventRepository = createRepository(eventDatabasePath);
    await corruptEventRepository.initialize();
    await expect(corruptEventRepository.loadEvents()).rejects.toThrow(/invalid scene event/);
  });
});
