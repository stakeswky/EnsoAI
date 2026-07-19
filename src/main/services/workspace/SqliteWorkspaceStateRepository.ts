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
import {
  addWorkspaceEntityReservationToState,
  syncWorkspaceEntityRegistryState,
  toWorkspaceHostPathCasePolicy,
  toWorkspaceHostPathPlatform,
  type WorkspaceEntityAliasRecord,
  type WorkspaceEntityKind,
  type WorkspaceEntityRecord,
  type WorkspaceEntityRegistryState,
  type WorkspaceEntityReservationRecord,
  type WorkspaceEntityStatus,
  type WorkspaceHostPathCasePolicy,
  type WorkspaceHostPathPlatform,
} from './WorkspaceEntityRegistry';
import type {
  WorkspaceCommandState,
  WorkspaceOperationRecord,
  WorkspacePersistedEvent,
  WorkspaceRepositoryCommit,
  WorkspaceStateRepository,
} from './WorkspaceStateRepository';
import {
  assertValidWorkspaceOperationRecord,
  assertWorkspaceCommandTransition,
  assertWorkspaceOperationBinding,
  assertWorkspaceOperationMetadata,
  digestWorkspaceOperationResult,
  isTerminalWorkspaceCommandState,
} from './WorkspaceStateRepository';

const BUSY_TIMEOUT_MS = 3_000;
export const SQLITE_WORKSPACE_SCHEMA_VERSION = 6;

const SHA256_DIGEST_PATTERN = /^[a-f0-9]{64}$/;

const WorkspaceOperationRecordSchema = z.strictObject({
  operationId: z.string().min(1).max(256),
  intentKind: z.string().min(1).max(256),
  sceneId: z.string().min(1).max(256),
  clientId: z.string().min(1).max(256),
  deviceId: z.string().min(1).max(256),
  commandVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  requestDigest: z.string().regex(SHA256_DIGEST_PATTERN),
  state: z.enum(['prepared', 'executing', 'committed', 'failed', 'needs_reconcile', 'cancelled']),
  baseRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  committedRevision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  result: JsonValueSchema.optional(),
  reconcileMetadata: JsonValueSchema.optional(),
  resultDigest: z.string().regex(SHA256_DIGEST_PATTERN).optional(),
  resultCompactedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  error: z
    .strictObject({
      code: z.string().min(1).max(256),
      message: z.string().min(1).max(512),
    })
    .optional(),
  createdAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  updatedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
});

const LegacyWorkspaceOperationRecordSchema = WorkspaceOperationRecordSchema.extend({
  sceneId: WorkspaceOperationRecordSchema.shape.sceneId.optional(),
  deviceId: WorkspaceOperationRecordSchema.shape.deviceId.optional(),
  commandVersion: WorkspaceOperationRecordSchema.shape.commandVersion.optional(),
  requestDigest: WorkspaceOperationRecordSchema.shape.requestDigest.optional(),
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

interface EntityRow {
  scene_id: string;
  entity_id: string;
  entity_kind: string;
  current_path: string;
  normalized_path: string;
  status: string;
  created_at: number;
  updated_at: number;
}

interface EntityAliasRow {
  scene_id: string;
  entity_id: string;
  entity_kind: string;
  alias_path: string;
  normalized_path: string;
  created_at: number;
  last_seen_at: number;
}

interface EntityReservationRow {
  scene_id: string;
  entity_id: string;
  entity_kind: string;
  reserved_path: string;
  normalized_path: string;
  disposition: string;
  created_at: number;
  updated_at: number;
}

interface SnapshotIdentityRow {
  scene_id: string;
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
  {
    version: 4,
    sql: `
      ALTER TABLE workspace_operations ADD COLUMN scene_id TEXT;
      ALTER TABLE workspace_operations ADD COLUMN device_id TEXT;
      ALTER TABLE workspace_operations ADD COLUMN client_id TEXT;
      ALTER TABLE workspace_operations ADD COLUMN command_version INTEGER;
      ALTER TABLE workspace_operations ADD COLUMN request_digest TEXT;
      ALTER TABLE workspace_operations ADD COLUMN result_digest TEXT;
      ALTER TABLE workspace_operations ADD COLUMN result_compacted_at INTEGER;

      CREATE INDEX IF NOT EXISTS idx_workspace_operations_scene_state
        ON workspace_operations (scene_id, state, updated_at);
    `,
  },
  {
    version: 5,
    sql: `
      CREATE TABLE IF NOT EXISTS workspace_entities (
        scene_id        TEXT NOT NULL,
        entity_id       TEXT NOT NULL,
        entity_kind     TEXT NOT NULL CHECK (entity_kind IN ('repository', 'worktree')),
        current_path    TEXT NOT NULL,
        normalized_path TEXT NOT NULL,
        status          TEXT NOT NULL CHECK (status IN ('active', 'retired')),
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL,
        PRIMARY KEY (scene_id, entity_id)
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_workspace_entities_active_path
        ON workspace_entities (scene_id, entity_kind, normalized_path)
        WHERE status = 'active';

      CREATE TABLE IF NOT EXISTS workspace_entity_aliases (
        scene_id        TEXT NOT NULL,
        entity_id       TEXT NOT NULL,
        entity_kind     TEXT NOT NULL CHECK (entity_kind IN ('repository', 'worktree')),
        alias_path      TEXT NOT NULL,
        normalized_path TEXT NOT NULL,
        created_at      INTEGER NOT NULL,
        last_seen_at    INTEGER NOT NULL,
        PRIMARY KEY (scene_id, entity_id, normalized_path),
        FOREIGN KEY (scene_id, entity_id)
          REFERENCES workspace_entities (scene_id, entity_id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_workspace_entity_aliases_path
        ON workspace_entity_aliases (scene_id, entity_kind, normalized_path);
    `,
  },
  {
    version: 6,
    sql: `
      CREATE TABLE IF NOT EXISTS workspace_entity_reservations (
        scene_id        TEXT NOT NULL,
        entity_id       TEXT NOT NULL,
        entity_kind     TEXT NOT NULL CHECK (entity_kind IN ('repository', 'worktree')),
        reserved_path   TEXT NOT NULL,
        normalized_path TEXT NOT NULL,
        disposition     TEXT NOT NULL CHECK (disposition IN ('new', 'adopted')),
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL,
        PRIMARY KEY (scene_id, entity_id)
      );

      CREATE INDEX IF NOT EXISTS idx_workspace_entity_reservations_path
        ON workspace_entity_reservations (scene_id, entity_kind, normalized_path);
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
  assertValidWorkspaceOperationRecord(result.data);
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
  assertValidWorkspaceOperationRecord(operation);
  const result = structuredClone(operation) as z.infer<typeof WorkspaceOperationRecordSchema>;
  if (result.result !== undefined) {
    const sanitized = sanitizeOperationResult(result.result);
    const parsed = JsonValueSchema.safeParse(sanitized);
    if (!parsed.success) {
      result.resultDigest ??= digestWorkspaceOperationResult(result.result);
      delete result.result;
    } else {
      result.result = parsed.data;
      result.resultDigest ??= digestWorkspaceOperationResult(parsed.data);
    }
  }
  return WorkspaceOperationRecordSchema.parse(result);
}

function validateTimestamp(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
}

function parseEntityKind(value: string): WorkspaceEntityKind {
  if (value === 'repository' || value === 'worktree') return value;
  throw new Error('Workspace database contains an invalid entity kind');
}

function parseEntityStatus(value: string): WorkspaceEntityStatus {
  if (value === 'active' || value === 'retired') return value;
  throw new Error('Workspace database contains an invalid entity status');
}

function parseEntityRow(row: EntityRow): WorkspaceEntityRecord {
  validateTimestamp(row.created_at, 'Workspace entity createdAt');
  validateTimestamp(row.updated_at, 'Workspace entity updatedAt');
  if (!row.scene_id || !row.entity_id || !row.current_path || !row.normalized_path) {
    throw new Error('Workspace database contains an invalid entity record');
  }
  return {
    sceneId: row.scene_id,
    entityId: row.entity_id,
    kind: parseEntityKind(row.entity_kind),
    currentPath: row.current_path,
    normalizedPath: row.normalized_path,
    status: parseEntityStatus(row.status),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseEntityAliasRow(row: EntityAliasRow): WorkspaceEntityAliasRecord {
  validateTimestamp(row.created_at, 'Workspace entity alias createdAt');
  validateTimestamp(row.last_seen_at, 'Workspace entity alias lastSeenAt');
  if (!row.scene_id || !row.entity_id || !row.alias_path || !row.normalized_path) {
    throw new Error('Workspace database contains an invalid entity alias');
  }
  return {
    sceneId: row.scene_id,
    entityId: row.entity_id,
    kind: parseEntityKind(row.entity_kind),
    path: row.alias_path,
    normalizedPath: row.normalized_path,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
  };
}

function parseEntityReservationRow(row: EntityReservationRow): WorkspaceEntityReservationRecord {
  validateTimestamp(row.created_at, 'Workspace entity reservation createdAt');
  validateTimestamp(row.updated_at, 'Workspace entity reservation updatedAt');
  if (!row.scene_id || !row.entity_id || !row.reserved_path || !row.normalized_path) {
    throw new Error('Workspace database contains an invalid entity reservation');
  }
  if (row.disposition !== 'new' && row.disposition !== 'adopted') {
    throw new Error('Workspace database contains an invalid entity reservation disposition');
  }
  return {
    sceneId: row.scene_id,
    entityId: row.entity_id,
    kind: parseEntityKind(row.entity_kind),
    path: row.reserved_path,
    normalizedPath: row.normalized_path,
    disposition: row.disposition,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function entityRegistryStatesEqual(
  left: WorkspaceEntityRegistryState,
  right: WorkspaceEntityRegistryState
): boolean {
  if (
    left.entities.length !== right.entities.length ||
    left.aliases.length !== right.aliases.length ||
    left.reservations.length !== right.reservations.length
  ) {
    return false;
  }
  const entitiesEqual = left.entities.every((entity, index) => {
    const other = right.entities[index];
    return (
      other !== undefined &&
      entity.sceneId === other.sceneId &&
      entity.entityId === other.entityId &&
      entity.kind === other.kind &&
      entity.currentPath === other.currentPath &&
      entity.normalizedPath === other.normalizedPath &&
      entity.status === other.status &&
      entity.createdAt === other.createdAt &&
      entity.updatedAt === other.updatedAt
    );
  });
  if (!entitiesEqual) return false;
  const aliasesEqual = left.aliases.every((alias, index) => {
    const other = right.aliases[index];
    return (
      other !== undefined &&
      alias.sceneId === other.sceneId &&
      alias.entityId === other.entityId &&
      alias.kind === other.kind &&
      alias.path === other.path &&
      alias.normalizedPath === other.normalizedPath &&
      alias.createdAt === other.createdAt &&
      alias.lastSeenAt === other.lastSeenAt
    );
  });
  if (!aliasesEqual) return false;
  return left.reservations.every((reservation, index) => {
    const other = right.reservations[index];
    return (
      other !== undefined &&
      reservation.sceneId === other.sceneId &&
      reservation.entityId === other.entityId &&
      reservation.kind === other.kind &&
      reservation.path === other.path &&
      reservation.normalizedPath === other.normalizedPath &&
      reservation.disposition === other.disposition &&
      reservation.createdAt === other.createdAt &&
      reservation.updatedAt === other.updatedAt
    );
  });
}

/** SQLite-backed durable storage for one canonical workspace scene. */
export class SqliteWorkspaceStateRepository implements WorkspaceStateRepository {
  readonly entityPathPlatform: WorkspaceHostPathPlatform;
  readonly entityPathCasePolicy: WorkspaceHostPathCasePolicy;
  private database: sqlite3.Database | null = null;
  private operationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly databasePath: string,
    options: {
      entityPathPlatform?: WorkspaceHostPathPlatform;
      entityPathCasePolicy?: WorkspaceHostPathCasePolicy;
    } = {}
  ) {
    this.entityPathPlatform =
      options.entityPathPlatform ?? toWorkspaceHostPathPlatform(process.platform);
    this.entityPathCasePolicy = toWorkspaceHostPathCasePolicy(options.entityPathCasePolicy);
  }

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
        await this.upgradeLegacyOperationRecords(database);
        await this.backfillEntityRegistry(database);
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

  loadEntityRegistry(sceneId: string): Promise<WorkspaceEntityRegistryState> {
    return this.exclusive(() =>
      this.loadEntityRegistryFromDatabase(this.requireDatabase(), sceneId)
    );
  }

  saveEntityReservation(reservation: WorkspaceEntityReservationRecord): Promise<void> {
    const candidate = structuredClone(reservation);
    return this.exclusive(async () => {
      const database = this.requireDatabase();
      await exec(database, 'BEGIN IMMEDIATE');
      try {
        const previous = await this.loadEntityRegistryFromDatabase(database, candidate.sceneId);
        const next = addWorkspaceEntityReservationToState(
          previous,
          candidate,
          this.entityPathPlatform,
          this.entityPathCasePolicy
        );
        if (previous.reservations.some((existing) => existing.entityId === candidate.entityId)) {
          await exec(database, 'COMMIT');
          return;
        }
        const persisted = next.reservations.find(
          (existing) => existing.entityId === candidate.entityId
        );
        if (!persisted) throw new Error('Workspace entity reservation was not persisted');
        await this.insertEntityReservation(database, persisted);
        await exec(database, 'COMMIT');
      } catch (error) {
        await exec(database, 'ROLLBACK').catch(() => undefined);
        throw error;
      }
    });
  }

  deleteEntityReservation(sceneId: string, entityId: string): Promise<void> {
    if (!sceneId || sceneId.length > 256 || !entityId || entityId.length > 256) {
      return Promise.reject(
        new Error('Workspace entity reservation identity must contain 1-256 characters')
      );
    }
    return this.exclusive(async () => {
      await run(
        this.requireDatabase(),
        `DELETE FROM workspace_entity_reservations
         WHERE scene_id = ? AND entity_id = ?`,
        [sceneId, entityId]
      );
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

  listUnfinishedOperations<TResult = unknown>(
    sceneId: string
  ): Promise<WorkspaceOperationRecord<TResult>[]> {
    return this.exclusive(async () => {
      const rows = await all<OperationRow>(
        this.requireDatabase(),
        `SELECT operation_json
         FROM workspace_operations
         WHERE scene_id = ?
           AND state IN ('prepared', 'executing', 'needs_reconcile')
         ORDER BY updated_at ASC, operation_id ASC`,
        [sceneId]
      );
      return rows
        .map(({ operation_json }) => parseOperation<TResult>(operation_json))
        .sort(
          (left, right) =>
            left.createdAt - right.createdAt || left.operationId.localeCompare(right.operationId)
        );
    });
  }

  saveSnapshot(snapshot: WorkspaceSceneSnapshot): Promise<void> {
    const parsed = WorkspaceSceneSnapshotSchema.parse(snapshot);
    const persisted = durableSnapshot(parsed);
    const serialized = serializeJson(persisted, 'snapshot');
    return this.exclusive(async () => {
      const database = this.requireDatabase();
      const updatedAt = Date.now();
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
        await this.upsertSnapshot(database, persisted, serialized, updatedAt);
        await this.syncTodoTables(database, persisted);
        await this.syncEntityRegistry(database, persisted, updatedAt);
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
      const database = this.requireDatabase();
      await exec(database, 'BEGIN IMMEDIATE');
      try {
        const row = await get<OperationRow>(
          database,
          'SELECT operation_json FROM workspace_operations WHERE operation_id = ?',
          [persisted.operationId]
        );
        if (row) {
          const existing = parseOperation(row.operation_json);
          assertWorkspaceOperationBinding(existing, persisted);
          assertWorkspaceOperationMetadata(existing, persisted);
          if (existing.state === persisted.state) {
            await exec(database, 'COMMIT');
            return;
          }
          assertWorkspaceCommandTransition(existing.state, persisted.state);
        } else if (persisted.state !== 'prepared') {
          throw new Error('New workspace operation must be prepared');
        }
        await this.upsertOperation(database, persisted, serialized);
        await exec(database, 'COMMIT');
      } catch (error) {
        await exec(database, 'ROLLBACK').catch(() => undefined);
        throw error;
      }
    });
  }

  compareAndSwapOperation<TResult = unknown>(
    operationId: string,
    expectedState: WorkspaceCommandState,
    operation: WorkspaceOperationRecord<TResult>
  ): Promise<boolean> {
    if (operation.operationId !== operationId) {
      return Promise.reject(new Error('Workspace operation ID mismatch'));
    }
    let parsed: z.infer<typeof WorkspaceOperationRecordSchema>;
    try {
      parsed = WorkspaceOperationRecordSchema.parse(operation);
      assertWorkspaceCommandTransition(expectedState, parsed.state);
    } catch (error) {
      return Promise.reject(error);
    }
    const persisted = durableOperation(parsed);
    const serialized = serializeJson(persisted, 'operation');
    return this.exclusive(async () => {
      const database = this.requireDatabase();
      await exec(database, 'BEGIN IMMEDIATE');
      try {
        const row = await get<OperationRow>(
          database,
          'SELECT operation_json FROM workspace_operations WHERE operation_id = ?',
          [operationId]
        );
        if (!row) {
          await exec(database, 'COMMIT');
          return false;
        }
        const existing = parseOperation(row.operation_json);
        assertWorkspaceOperationBinding(existing, persisted);
        assertWorkspaceOperationMetadata(existing, persisted);
        if (existing.state !== expectedState) {
          await exec(database, 'COMMIT');
          return false;
        }
        const result = await this.updateOperationState(
          database,
          expectedState,
          persisted,
          serialized
        );
        await exec(database, 'COMMIT');
        return result.changes === 1;
      } catch (error) {
        await exec(database, 'ROLLBACK').catch(() => undefined);
        throw error;
      }
    });
  }

  compactOperationResultsBefore(cutoff: number, compactedAt = Date.now()): Promise<number> {
    if (
      !Number.isSafeInteger(cutoff) ||
      cutoff < 0 ||
      !Number.isSafeInteger(compactedAt) ||
      compactedAt < 0
    ) {
      return Promise.reject(
        new Error('Workspace operation compaction timestamps must be non-negative safe integers')
      );
    }
    return this.exclusive(async () => {
      const database = this.requireDatabase();
      await exec(database, 'BEGIN IMMEDIATE');
      try {
        const rows = await all<OperationRow>(
          database,
          `SELECT operation_json
           FROM workspace_operations
           WHERE state IN ('committed', 'failed', 'cancelled')
             AND updated_at < ?
             AND result_compacted_at IS NULL`,
          [cutoff]
        );
        let compacted = 0;
        for (const row of rows) {
          const operation = durableOperation(parseOperation(row.operation_json));
          if (operation.result === undefined) continue;
          delete operation.result;
          operation.resultCompactedAt = compactedAt;
          await this.upsertOperation(database, operation, serializeJson(operation, 'operation'));
          compacted += 1;
        }
        await exec(database, 'COMMIT');
        return compacted;
      } catch (error) {
        await exec(database, 'ROLLBACK').catch(() => undefined);
        throw error;
      }
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
        const existing = await get<OperationRow>(
          database,
          'SELECT operation_json FROM workspace_operations WHERE operation_id = ?',
          [validated.operation.operationId]
        );
        if (existing) {
          const current = parseOperation(existing.operation_json);
          assertWorkspaceOperationBinding(current, validated.operation);
          assertWorkspaceOperationMetadata(current, validated.operation);
          if (isTerminalWorkspaceCommandState(current.state)) {
            throw new Error('Repository operation is already terminal');
          }
          assertWorkspaceCommandTransition(current.state, 'committed');
        }

        await this.upsertSnapshot(
          database,
          persistedSnapshot,
          serializeJson(persistedSnapshot, 'snapshot'),
          validated.committedAt
        );
        await this.syncTodoTables(database, persistedSnapshot);
        await this.syncEntityRegistry(database, persistedSnapshot, validated.committedAt);
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

  private async backfillEntityRegistry(database: sqlite3.Database): Promise<void> {
    const row = await get<{ snapshot_json: string; updated_at: number }>(
      database,
      'SELECT snapshot_json, updated_at FROM workspace_snapshot WHERE singleton = 1'
    );
    if (!row) return;
    validateTimestamp(row.updated_at, 'Snapshot updatedAt');
    let snapshot: WorkspaceSceneSnapshot;
    try {
      snapshot = parseSnapshot(row.snapshot_json);
    } catch {
      return;
    }
    await exec(database, 'BEGIN IMMEDIATE');
    try {
      await this.syncEntityRegistry(database, snapshot, row.updated_at);
      await exec(database, 'COMMIT');
    } catch (error) {
      await exec(database, 'ROLLBACK').catch(() => undefined);
      throw error;
    }
  }

  private async upgradeLegacyOperationRecords(database: sqlite3.Database): Promise<void> {
    const rows = await all<OperationRow>(
      database,
      'SELECT operation_json FROM workspace_operations'
    );
    if (rows.length === 0) return;
    const snapshot = await get<SnapshotIdentityRow>(
      database,
      'SELECT scene_id FROM workspace_snapshot WHERE singleton = 1'
    );

    await exec(database, 'BEGIN IMMEDIATE');
    try {
      for (const row of rows) {
        const parsed = LegacyWorkspaceOperationRecordSchema.safeParse(
          parseJson(row.operation_json, 'operation')
        );
        if (!parsed.success) {
          throw new Error('Workspace database contains an invalid operation record');
        }
        const legacy = parsed.data;
        const operation = durableOperation(
          WorkspaceOperationRecordSchema.parse({
            ...legacy,
            sceneId: legacy.sceneId ?? snapshot?.scene_id ?? 'legacy-scene',
            deviceId: legacy.deviceId ?? `legacy:${legacy.clientId}`.slice(0, 256),
            commandVersion: legacy.commandVersion ?? 1,
            requestDigest:
              legacy.requestDigest ??
              digestWorkspaceOperationResult({
                legacy: true,
                operationId: legacy.operationId,
                intentKind: legacy.intentKind,
                baseRevision: legacy.baseRevision,
              }),
          })
        );
        await this.upsertOperation(database, operation, serializeJson(operation, 'operation'));
      }
      await exec(database, 'COMMIT');
    } catch (error) {
      await exec(database, 'ROLLBACK').catch(() => undefined);
      throw error;
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
         (operation_id, state, committed_revision, operation_json, updated_at,
          scene_id, device_id, client_id, command_version, request_digest,
          result_digest, result_compacted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(operation_id) DO UPDATE SET
         state = excluded.state,
         committed_revision = excluded.committed_revision,
         operation_json = excluded.operation_json,
         updated_at = excluded.updated_at,
         scene_id = excluded.scene_id,
         device_id = excluded.device_id,
         client_id = excluded.client_id,
         command_version = excluded.command_version,
         request_digest = excluded.request_digest,
         result_digest = excluded.result_digest,
         result_compacted_at = excluded.result_compacted_at`,
      [
        operation.operationId,
        operation.state,
        operation.committedRevision ?? null,
        serialized,
        operation.updatedAt,
        operation.sceneId,
        operation.deviceId,
        operation.clientId,
        operation.commandVersion,
        operation.requestDigest,
        operation.resultDigest ?? null,
        operation.resultCompactedAt ?? null,
      ]
    );
  }

  private updateOperationState(
    database: sqlite3.Database,
    expectedState: WorkspaceCommandState,
    operation: z.infer<typeof WorkspaceOperationRecordSchema>,
    serialized: string
  ): Promise<RunResult> {
    return run(
      database,
      `UPDATE workspace_operations
       SET state = ?,
           committed_revision = ?,
           operation_json = ?,
           updated_at = ?,
           result_digest = ?,
           result_compacted_at = ?
       WHERE operation_id = ? AND state = ?`,
      [
        operation.state,
        operation.committedRevision ?? null,
        serialized,
        operation.updatedAt,
        operation.resultDigest ?? null,
        operation.resultCompactedAt ?? null,
        operation.operationId,
        expectedState,
      ]
    );
  }

  private async loadEntityRegistryFromDatabase(
    database: sqlite3.Database,
    sceneId: string
  ): Promise<WorkspaceEntityRegistryState> {
    const [entityRows, aliasRows, reservationRows] = await Promise.all([
      all<EntityRow>(
        database,
        `SELECT scene_id, entity_id, entity_kind, current_path, normalized_path,
                status, created_at, updated_at
         FROM workspace_entities
         WHERE scene_id = ?
         ORDER BY entity_kind ASC, entity_id ASC`,
        [sceneId]
      ),
      all<EntityAliasRow>(
        database,
        `SELECT scene_id, entity_id, entity_kind, alias_path, normalized_path,
                created_at, last_seen_at
         FROM workspace_entity_aliases
         WHERE scene_id = ?
         ORDER BY entity_kind ASC, normalized_path ASC, entity_id ASC`,
        [sceneId]
      ),
      all<EntityReservationRow>(
        database,
        `SELECT scene_id, entity_id, entity_kind, reserved_path, normalized_path,
                disposition, created_at, updated_at
         FROM workspace_entity_reservations
         WHERE scene_id = ?
         ORDER BY entity_kind ASC, entity_id ASC`,
        [sceneId]
      ),
    ]);
    return {
      entities: entityRows.map(parseEntityRow),
      aliases: aliasRows.map(parseEntityAliasRow),
      reservations: reservationRows.map(parseEntityReservationRow),
    };
  }

  private async syncEntityRegistry(
    database: sqlite3.Database,
    snapshot: WorkspaceSceneSnapshot,
    timestamp: number
  ): Promise<void> {
    const previous = await this.loadEntityRegistryFromDatabase(database, snapshot.sceneId);
    const next = syncWorkspaceEntityRegistryState(
      previous,
      snapshot,
      this.entityPathPlatform,
      this.entityPathCasePolicy,
      timestamp
    );
    if (entityRegistryStatesEqual(previous, next)) return;

    await run(database, 'DELETE FROM workspace_entity_reservations WHERE scene_id = ?', [
      snapshot.sceneId,
    ]);
    await run(database, 'DELETE FROM workspace_entity_aliases WHERE scene_id = ?', [
      snapshot.sceneId,
    ]);
    await run(database, 'DELETE FROM workspace_entities WHERE scene_id = ?', [snapshot.sceneId]);
    for (const entity of next.entities) {
      await run(
        database,
        `INSERT INTO workspace_entities
           (scene_id, entity_id, entity_kind, current_path, normalized_path,
            status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          entity.sceneId,
          entity.entityId,
          entity.kind,
          entity.currentPath,
          entity.normalizedPath,
          entity.status,
          entity.createdAt,
          entity.updatedAt,
        ]
      );
    }
    for (const alias of next.aliases) {
      await run(
        database,
        `INSERT INTO workspace_entity_aliases
           (scene_id, entity_id, entity_kind, alias_path, normalized_path,
            created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          alias.sceneId,
          alias.entityId,
          alias.kind,
          alias.path,
          alias.normalizedPath,
          alias.createdAt,
          alias.lastSeenAt,
        ]
      );
    }
    for (const reservation of next.reservations) {
      await this.insertEntityReservation(database, reservation);
    }
  }

  private insertEntityReservation(
    database: sqlite3.Database,
    reservation: WorkspaceEntityReservationRecord
  ): Promise<RunResult> {
    return run(
      database,
      `INSERT INTO workspace_entity_reservations
         (scene_id, entity_id, entity_kind, reserved_path, normalized_path,
          disposition, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        reservation.sceneId,
        reservation.entityId,
        reservation.kind,
        reservation.path,
        reservation.normalizedPath,
        reservation.disposition,
        reservation.createdAt,
        reservation.updatedAt,
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
    if (operation.sceneId !== snapshot.sceneId) {
      throw new Error('Repository operation scene identity mismatch');
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
    if (
      event.origin.source === 'client' &&
      (event.origin.clientId !== operation.clientId || event.origin.deviceId !== operation.deviceId)
    ) {
      throw new Error('Repository operation origin mismatch');
    }

    return { snapshot, event, operation, committedAt: commit.committedAt };
  }
}
