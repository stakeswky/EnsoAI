import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createEmptyWorkspaceSceneSnapshot,
  type WorkspacePanelId,
} from '@shared/types/workspaceMirror';
import sqlite3 from 'sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SQLITE_WORKSPACE_SCHEMA_VERSION,
  SqliteWorkspaceStateRepository,
} from '../SqliteWorkspaceStateRepository';
import type {
  WorkspaceOperationRecord,
  WorkspaceRepositoryCommit,
} from '../WorkspaceStateRepository';

const HOST_EPOCH = '11111111-1111-4111-8111-111111111111';

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
      clientId: 'client-1',
      deviceId: 'device-1',
      state: 'committed',
      baseRevision: revision - 1,
      committedRevision: revision,
      result: { panel: activePrimaryPanel },
      createdAt: committedAt,
      updatedAt: committedAt,
    },
    committedAt,
  };
}

async function createVersionOneDatabase(path: string): Promise<void> {
  const database = await openRawDatabase(path);
  const snapshot = createEmptyWorkspaceSceneSnapshot({
    hostId: 'host-1',
    sceneId: 'scene-1',
    hostEpoch: HOST_EPOCH,
  });
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

  function createRepository(path = databasePath): SqliteWorkspaceStateRepository {
    const repository = new SqliteWorkspaceStateRepository(path);
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
        clientId: 'client-1',
        deviceId: 'device-1',
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
    await expect(repository.commit(conflicting)).rejects.toThrow();

    expect(await repository.loadSnapshot()).toEqual(committed.snapshot);
    expect(await repository.loadEvents()).toEqual([
      { event: committed.event, committedAt: committed.committedAt },
    ]);
    expect(await repository.loadOperation('operation-2')).toBeNull();
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
    await repository.saveOperation(attemptedOverwrite);

    expect(await repository.loadOperation('operation-1')).toEqual(commit.operation);
    await expect(repository.commit(commit)).rejects.toThrow(/already committed/);
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

  it('migrates a version-one database additively without replacing prior data', async () => {
    await createVersionOneDatabase(databasePath);
    const repository = createRepository();
    await repository.initialize();

    expect((await repository.loadSnapshot())?.revision).toBe(0);
    await repository.saveOperation({
      operationId: 'prepared-operation',
      intentKind: 'navigation.replace',
      clientId: 'client-1',
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
