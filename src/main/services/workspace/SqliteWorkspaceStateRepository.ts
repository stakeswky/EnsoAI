import {
  createEmptyWorkspaceSceneSnapshot,
  JsonValueSchema,
  type WorkspaceSceneEvent,
  WorkspaceSceneEventSchema,
  type WorkspaceSceneSnapshot,
  WorkspaceSceneSnapshotSchema,
} from '@shared/types/workspaceMirror';
import sqlite3 from 'sqlite3';
import { z } from 'zod';
import type {
  WorkspaceOperationRecord,
  WorkspacePersistedEvent,
  WorkspaceRepositoryCommit,
  WorkspaceStateRepository,
} from './WorkspaceStateRepository';

const BUSY_TIMEOUT_MS = 3_000;
export const SQLITE_WORKSPACE_SCHEMA_VERSION = 3;

const WorkspaceOperationRecordSchema = z.strictObject({
  operationId: z.string().min(1).max(256),
  intentKind: z.string().min(1).max(256),
  clientId: z.string().min(1).max(256),
  deviceId: z.string().min(1).max(256).optional(),
  state: z.enum(['prepared', 'executing', 'committed', 'failed', 'needs_reconcile']),
  baseRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  committedRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  result: JsonValueSchema.optional(),
  error: z
    .strictObject({
      code: z.string().min(1).max(256),
      message: z.string().min(1).max(512),
    })
    .optional(),
  createdAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  updatedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

interface SnapshotRow {
  snapshot_json: string;
}

interface EventRow {
  event_json: string;
  committed_at: number;
}

interface OperationRow {
  operation_json: string;
}

interface UserVersionRow {
  user_version: number;
}

interface RunResult {
  changes: number;
  lastID: number;
}

const migrations: ReadonlyArray<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS workspace_snapshot (
        singleton       INTEGER PRIMARY KEY CHECK (singleton = 1),
        revision        INTEGER NOT NULL,
        host_epoch      TEXT NOT NULL,
        scene_id        TEXT NOT NULL,
        snapshot_json   TEXT NOT NULL,
        updated_at      INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workspace_events (
        host_epoch      TEXT NOT NULL,
        scene_id        TEXT NOT NULL,
        revision        INTEGER NOT NULL,
        event_json      TEXT NOT NULL,
        committed_at    INTEGER NOT NULL,
        PRIMARY KEY (host_epoch, scene_id, revision)
      );

      CREATE INDEX IF NOT EXISTS idx_workspace_events_committed_at
        ON workspace_events (committed_at);
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS workspace_operations (
        operation_id       TEXT PRIMARY KEY,
        state              TEXT NOT NULL,
        committed_revision INTEGER,
        operation_json     TEXT NOT NULL,
        updated_at         INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_workspace_operations_state
        ON workspace_operations (state, updated_at);
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE IF NOT EXISTS workspace_todo_tasks (
        repository_id TEXT NOT NULL,
        task_id       TEXT NOT NULL,
        title         TEXT NOT NULL,
        description   TEXT NOT NULL,
        priority      TEXT NOT NULL,
        status        TEXT NOT NULL,
        task_order    INTEGER NOT NULL,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        session_id    TEXT,
        PRIMARY KEY (repository_id, task_id)
      );

      CREATE TABLE IF NOT EXISTS workspace_todo_auto_execution (
        repository_id     TEXT PRIMARY KEY,
        running           INTEGER NOT NULL,
        queue_json        TEXT NOT NULL,
        current_task_id   TEXT,
        current_session_id TEXT
      );

      CREATE TABLE IF NOT EXISTS workspace_migrations (
        migration_key TEXT PRIMARY KEY,
        completed_at  INTEGER NOT NULL,
        metadata_json TEXT NOT NULL
      );
    `,
  },
];

function openDatabase(databasePath: string): Promise<sqlite3.Database> {
  return new Promise((resolve, reject) => {
    const database = new sqlite3.Database(
      databasePath,
      sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE,
      (error) => {
        if (error) {
          reject(error);
          return;
        }
        database.configure('busyTimeout', BUSY_TIMEOUT_MS);
        resolve(database);
      }
    );
  });
}

function closeDatabase(database: sqlite3.Database): Promise<void> {
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

function exec(database: sqlite3.Database, sql: string): Promise<void> {
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

function run(
  database: sqlite3.Database,
  sql: string,
  parameters: readonly unknown[] = []
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    database.run(sql, parameters, function (error) {
      if (error) {
        reject(error);
        return;
      }
      resolve({ changes: this.changes, lastID: this.lastID });
    });
  });
}

function get<Row>(
  database: sqlite3.Database,
  sql: string,
  parameters: readonly unknown[] = []
): Promise<Row | undefined> {
  return new Promise((resolve, reject) => {
    database.get(sql, parameters, (error, row: Row | undefined) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(row);
    });
  });
}

function all<Row>(
  database: sqlite3.Database,
  sql: string,
  parameters: readonly unknown[] = []
): Promise<Row[]> {
  return new Promise((resolve, reject) => {
    database.all(sql, parameters, (error, rows: Row[]) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(rows ?? []);
    });
  });
}

function parseJson(serialized: string, label: string): unknown {
  try {
    return JSON.parse(serialized) as unknown;
  } catch {
    throw new Error(`Workspace database contains invalid ${label} JSON`);
  }
}

function serializeJson(value: unknown, label: string): string {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new TypeError('Value is not JSON serializable');
    }
    return serialized;
  } catch {
    throw new Error(`Cannot serialize workspace ${label}`);
  }
}

function parseSnapshot(serialized: string): WorkspaceSceneSnapshot {
  const result = WorkspaceSceneSnapshotSchema.safeParse(parseJson(serialized, 'snapshot'));
  if (!result.success) {
    throw new Error('Workspace database contains an invalid scene snapshot');
  }
  return result.data;
}

function durableSnapshot(snapshot: WorkspaceSceneSnapshot): WorkspaceSceneSnapshot {
  const result = structuredClone(snapshot);
  for (const editor of Object.values(result.editors)) {
    for (const buffer of Object.values(editor.buffers)) {
      delete buffer.content;
      delete buffer.externalContent;
      buffer.isDirty = false;
      buffer.hasExternalChange = false;
    }
  }
  for (const session of Object.values(result.agents.sessions)) {
    session.runtimeState = 'idle';
    session.status = 'idle';
    session.waitingReason = null;
    session.draft = { text: '', resources: [] };
    session.task = null;
  }
  return WorkspaceSceneSnapshotSchema.parse(result);
}

function durableEvent(event: WorkspaceSceneEvent): WorkspaceSceneEvent {
  const result = structuredClone(event);
  switch (result.kind) {
    case 'scene.replace': {
      const durable = durableSnapshot({
        ...createEmptyWorkspaceSceneSnapshot({
          hostId: result.hostEpoch,
          sceneId: result.sceneId,
          hostEpoch: result.hostEpoch,
        }),
        ...result.payload,
      });
      result.payload = {
        catalog: durable.catalog,
        navigation: durable.navigation,
        editors: durable.editors,
        agents: durable.agents,
        terminals: durable.terminals,
        todos: durable.todos,
        selections: durable.selections,
      };
      break;
    }
    case 'editor.replace':
      result.payload.editor = durableSnapshot({
        ...createEmptyWorkspaceSceneSnapshot({
          hostId: result.hostEpoch,
          sceneId: result.sceneId,
          hostEpoch: result.hostEpoch,
        }),
        editors: { [result.payload.worktreeId]: result.payload.editor },
      }).editors[result.payload.worktreeId]!;
      break;
    case 'editor.buffer.update':
      delete result.payload.content;
      result.payload.isDirty = false;
      result.payload.hasExternalChange = false;
      delete result.payload.externalContent;
      break;
    case 'agents.replace': {
      const agents = structuredClone(result.payload.agents);
      for (const session of Object.values(agents.sessions)) {
        session.runtimeState = 'idle';
        session.status = 'idle';
        session.waitingReason = null;
        session.draft = { text: '', resources: [] };
        session.task = null;
      }
      result.payload.agents = agents;
      break;
    }
    default:
      break;
  }
  return WorkspaceSceneEventSchema.parse(result);
}

function parseEvent(serialized: string): WorkspaceSceneEvent {
  const result = WorkspaceSceneEventSchema.safeParse(parseJson(serialized, 'event'));
  if (!result.success) {
    throw new Error('Workspace database contains an invalid scene event');
  }
  return result.data;
}

function parseOperation<TResult>(serialized: string): WorkspaceOperationRecord<TResult> {
  const result = WorkspaceOperationRecordSchema.safeParse(parseJson(serialized, 'operation'));
  if (!result.success) {
    throw new Error('Workspace database contains an invalid operation record');
  }
  return result.data as WorkspaceOperationRecord<TResult>;
}

const SENSITIVE_OPERATION_RESULT_KEY =
  /(?:content|draft|prompt|token|secret|password|credential|attachment|resource|environment|env|raw|bytes|path)/i;

function sanitizeOperationResult(value: unknown, depth = 0): unknown {
  if (depth > 8) return undefined;
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.length <= 4096 ? value : undefined;
  if (Array.isArray(value)) {
    const items = value
      .slice(0, 128)
      .map((item) => sanitizeOperationResult(item, depth + 1))
      .filter((item) => item !== undefined);
    return items;
  }
  if (typeof value !== 'object') return undefined;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_OPERATION_RESULT_KEY.test(key) || key.length > 128) continue;
    const sanitized = sanitizeOperationResult(item, depth + 1);
    if (sanitized !== undefined) output[key] = sanitized;
  }
  return output;
}

/** Persist idempotency metadata while redacting volatile command payloads. */
function durableOperation<TResult>(
  operation: WorkspaceOperationRecord<TResult>
): z.infer<typeof WorkspaceOperationRecordSchema> {
  const result = structuredClone(operation) as z.infer<typeof WorkspaceOperationRecordSchema>;
  if (result.result !== undefined) {
    const sanitized = sanitizeOperationResult(result.result);
    const parsed = JsonValueSchema.safeParse(sanitized);
    if (!parsed.success) delete result.result;
    else result.result = parsed.data;
  }
  return WorkspaceOperationRecordSchema.parse(result);
}

function validateTimestamp(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
}

/** SQLite-backed durable storage for one canonical workspace scene. */
export class SqliteWorkspaceStateRepository implements WorkspaceStateRepository {
  private database: sqlite3.Database | null = null;
  private operationTail: Promise<void> = Promise.resolve();

  constructor(private readonly databasePath: string) {}

  initialize(): Promise<void> {
    return this.exclusive(async () => {
      if (this.database) {
        return;
      }

      const database = await openDatabase(this.databasePath);
      this.database = database;
      try {
        await exec(database, 'PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;');
        await this.runMigrations(database);
      } catch (error) {
        this.database = null;
        await closeDatabase(database).catch(() => undefined);
        throw error;
      }
    });
  }

  loadSnapshot(): Promise<WorkspaceSceneSnapshot | null> {
    return this.exclusive(async () => {
      const row = await get<SnapshotRow>(
        this.requireDatabase(),
        'SELECT snapshot_json FROM workspace_snapshot WHERE singleton = 1'
      );
      return row ? parseSnapshot(row.snapshot_json) : null;
    });
  }

  loadEvents(): Promise<WorkspacePersistedEvent[]> {
    return this.exclusive(async () => {
      const database = this.requireDatabase();
      const rows = await all<EventRow>(
        database,
        `SELECT event_json, committed_at
         FROM workspace_events
         WHERE host_epoch = (SELECT host_epoch FROM workspace_snapshot WHERE singleton = 1)
           AND scene_id = (SELECT scene_id FROM workspace_snapshot WHERE singleton = 1)
         ORDER BY revision ASC`
      );
      return rows.map((row) => {
        validateTimestamp(row.committed_at, 'Event committedAt');
        return { event: parseEvent(row.event_json), committedAt: row.committed_at };
      });
    });
  }

  loadOperation<TResult = unknown>(
    operationId: string
  ): Promise<WorkspaceOperationRecord<TResult> | null> {
    return this.exclusive(async () => {
      const row = await get<OperationRow>(
        this.requireDatabase(),
        'SELECT operation_json FROM workspace_operations WHERE operation_id = ?',
        [operationId]
      );
      return row ? parseOperation<TResult>(row.operation_json) : null;
    });
  }

  saveSnapshot(snapshot: WorkspaceSceneSnapshot): Promise<void> {
    const parsed = WorkspaceSceneSnapshotSchema.parse(snapshot);
    const persisted = durableSnapshot(parsed);
    const serialized = serializeJson(persisted, 'snapshot');
    return this.exclusive(async () => {
      const database = this.requireDatabase();
      await exec(database, 'BEGIN IMMEDIATE');
      try {
        const previous = await get<{ host_epoch: string; scene_id: string }>(
          database,
          'SELECT host_epoch, scene_id FROM workspace_snapshot WHERE singleton = 1'
        );
        if (
          previous &&
          (previous.host_epoch !== parsed.hostEpoch || previous.scene_id !== parsed.sceneId)
        ) {
          await run(database, 'DELETE FROM workspace_events');
        }
        await this.upsertSnapshot(database, persisted, serialized, Date.now());
        await this.syncTodoTables(database, persisted);
        await exec(database, 'COMMIT');
      } catch (error) {
        await exec(database, 'ROLLBACK').catch(() => undefined);
        throw error;
      }
    });
  }

  saveOperation<TResult = unknown>(operation: WorkspaceOperationRecord<TResult>): Promise<void> {
    const parsed = WorkspaceOperationRecordSchema.parse(operation);
    const persisted = durableOperation(parsed);
    const serialized = serializeJson(persisted, 'operation');
    return this.exclusive(async () => {
      await this.upsertOperation(this.requireDatabase(), persisted, serialized);
    });
  }

  commit<TResult = unknown>(commit: WorkspaceRepositoryCommit<TResult>): Promise<void> {
    const validated = this.validateCommit(commit);
    const persistedSnapshot = durableSnapshot(validated.snapshot);
    const persistedEvent = durableEvent(validated.event);
    return this.exclusive(async () => {
      const database = this.requireDatabase();
      await exec(database, 'BEGIN IMMEDIATE');
      try {
        const existing = await get<{ state: string }>(
          database,
          'SELECT state FROM workspace_operations WHERE operation_id = ?',
          [validated.operation.operationId]
        );
        if (existing?.state === 'committed') {
          throw new Error('Repository operation is already committed');
        }

        await this.upsertSnapshot(
          database,
          persistedSnapshot,
          serializeJson(persistedSnapshot, 'snapshot'),
          validated.committedAt
        );
        await this.syncTodoTables(database, persistedSnapshot);
        await run(
          database,
          `INSERT INTO workspace_events
             (host_epoch, scene_id, revision, event_json, committed_at)
           VALUES (?, ?, ?, ?, ?)`,
          [
            validated.event.hostEpoch,
            validated.event.sceneId,
            validated.event.revision,
            serializeJson(persistedEvent, 'event'),
            validated.committedAt,
          ]
        );
        const persistedOperation = durableOperation(validated.operation);
        await this.upsertOperation(
          database,
          persistedOperation,
          serializeJson(persistedOperation, 'operation')
        );
        await exec(database, 'COMMIT');
      } catch (error) {
        await exec(database, 'ROLLBACK').catch(() => undefined);
        throw error;
      }
    });
  }

  compactEventsThrough(revision: number): Promise<void> {
    if (!Number.isSafeInteger(revision) || revision < 0) {
      return Promise.reject(new Error('Compaction revision must be a non-negative safe integer'));
    }
    return this.exclusive(async () => {
      await run(
        this.requireDatabase(),
        `DELETE FROM workspace_events
         WHERE host_epoch = (SELECT host_epoch FROM workspace_snapshot WHERE singleton = 1)
           AND scene_id = (SELECT scene_id FROM workspace_snapshot WHERE singleton = 1)
           AND revision <= ?`,
        [revision]
      );
    });
  }

  hasMigration(migrationKey: string): Promise<boolean> {
    return this.exclusive(async () => {
      const row = await get<{ migration_key: string }>(
        this.requireDatabase(),
        'SELECT migration_key FROM workspace_migrations WHERE migration_key = ?',
        [migrationKey]
      );
      return Boolean(row);
    });
  }

  loadMigrationMetadata(migrationKey: string): Promise<unknown | null> {
    return this.exclusive(async () => {
      const row = await get<{ metadata_json: string }>(
        this.requireDatabase(),
        'SELECT metadata_json FROM workspace_migrations WHERE migration_key = ?',
        [migrationKey]
      );
      return row ? parseJson(row.metadata_json, 'migration metadata') : null;
    });
  }

  markMigration(migrationKey: string, metadata: unknown = {}): Promise<void> {
    const serialized = serializeJson(metadata, 'migration metadata');
    return this.exclusive(async () => {
      await run(
        this.requireDatabase(),
        `INSERT OR IGNORE INTO workspace_migrations
           (migration_key, completed_at, metadata_json)
         VALUES (?, ?, ?)`,
        [migrationKey, Date.now(), serialized]
      );
    });
  }

  close(): Promise<void> {
    return this.exclusive(async () => {
      const database = this.database;
      this.database = null;
      if (database) {
        await closeDatabase(database);
      }
    });
  }

  private exclusive<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private requireDatabase(): sqlite3.Database {
    if (!this.database) {
      throw new Error('Workspace database is not initialized');
    }
    return this.database;
  }

  private async runMigrations(database: sqlite3.Database): Promise<void> {
    const row = await get<UserVersionRow>(database, 'PRAGMA user_version');
    const currentVersion = row?.user_version ?? 0;
    if (currentVersion > SQLITE_WORKSPACE_SCHEMA_VERSION) {
      throw new Error(`Workspace database schema ${currentVersion} is newer than this application`);
    }

    for (const migration of migrations) {
      if (migration.version <= currentVersion) {
        continue;
      }
      await exec(database, 'BEGIN IMMEDIATE');
      try {
        await exec(database, migration.sql);
        await exec(database, `PRAGMA user_version = ${migration.version}`);
        await exec(database, 'COMMIT');
      } catch (error) {
        await exec(database, 'ROLLBACK').catch(() => undefined);
        throw error;
      }
    }
  }

  private upsertSnapshot(
    database: sqlite3.Database,
    snapshot: WorkspaceSceneSnapshot,
    serialized: string,
    updatedAt: number
  ): Promise<RunResult> {
    validateTimestamp(updatedAt, 'Snapshot updatedAt');
    return run(
      database,
      `INSERT INTO workspace_snapshot
         (singleton, revision, host_epoch, scene_id, snapshot_json, updated_at)
       VALUES (1, ?, ?, ?, ?, ?)
       ON CONFLICT(singleton) DO UPDATE SET
         revision = excluded.revision,
         host_epoch = excluded.host_epoch,
         scene_id = excluded.scene_id,
         snapshot_json = excluded.snapshot_json,
         updated_at = excluded.updated_at`,
      [snapshot.revision, snapshot.hostEpoch, snapshot.sceneId, serialized, updatedAt]
    );
  }

  private upsertOperation(
    database: sqlite3.Database,
    operation: z.infer<typeof WorkspaceOperationRecordSchema>,
    serialized: string
  ): Promise<RunResult> {
    return run(
      database,
      `INSERT INTO workspace_operations
         (operation_id, state, committed_revision, operation_json, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(operation_id) DO UPDATE SET
         state = excluded.state,
         committed_revision = excluded.committed_revision,
         operation_json = excluded.operation_json,
         updated_at = excluded.updated_at
       WHERE workspace_operations.state <> 'committed'`,
      [
        operation.operationId,
        operation.state,
        operation.committedRevision ?? null,
        serialized,
        operation.updatedAt,
      ]
    );
  }

  private async syncTodoTables(
    database: sqlite3.Database,
    snapshot: WorkspaceSceneSnapshot
  ): Promise<void> {
    await run(database, 'DELETE FROM workspace_todo_tasks');
    await run(database, 'DELETE FROM workspace_todo_auto_execution');
    for (const [repositoryId, board] of Object.entries(snapshot.todos.boardsByRepository)) {
      for (const task of Object.values(board.tasks)) {
        await run(
          database,
          `INSERT INTO workspace_todo_tasks
             (repository_id, task_id, title, description, priority, status, task_order,
              created_at, updated_at, session_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            repositoryId,
            task.id,
            task.title,
            task.description,
            task.priority,
            task.status,
            task.order,
            task.createdAt,
            task.updatedAt,
            task.sessionId,
          ]
        );
      }
      await run(
        database,
        `INSERT INTO workspace_todo_auto_execution
           (repository_id, running, queue_json, current_task_id, current_session_id)
         VALUES (?, ?, ?, ?, ?)`,
        [
          repositoryId,
          board.autoExecution.running ? 1 : 0,
          serializeJson(board.autoExecution.queue, 'Todo auto-execution queue'),
          board.autoExecution.currentTaskId,
          board.autoExecution.currentSessionId,
        ]
      );
    }
  }

  private validateCommit<TResult>(commit: WorkspaceRepositoryCommit<TResult>): {
    snapshot: WorkspaceSceneSnapshot;
    event: WorkspaceSceneEvent;
    operation: z.infer<typeof WorkspaceOperationRecordSchema>;
    committedAt: number;
  } {
    const snapshot = WorkspaceSceneSnapshotSchema.parse(commit.snapshot);
    const event = WorkspaceSceneEventSchema.parse(commit.event);
    const operation = WorkspaceOperationRecordSchema.parse(commit.operation);
    validateTimestamp(commit.committedAt, 'Commit timestamp');

    if (snapshot.revision !== event.revision) {
      throw new Error('Repository commit revision mismatch');
    }
    if (snapshot.hostEpoch !== event.hostEpoch || snapshot.sceneId !== event.sceneId) {
      throw new Error('Repository commit scene identity mismatch');
    }
    if (operation.state !== 'committed') {
      throw new Error('Repository commit requires a committed operation');
    }
    if (operation.committedRevision !== event.revision) {
      throw new Error('Repository operation revision mismatch');
    }
    if (event.origin.operationId && event.origin.operationId !== operation.operationId) {
      throw new Error('Repository event operation mismatch');
    }

    return { snapshot, event, operation, committedAt: commit.committedAt };
  }
}
