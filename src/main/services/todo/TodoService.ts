import { createHash } from 'node:crypto';
import { access, copyFile, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TodoTaskSceneSchema, type WorkspaceSceneSnapshot } from '@shared/types';
import { app } from 'electron';
import sqlite3 from 'sqlite3';

const BUSY_TIMEOUT_MS = 3000;

export interface TodoTaskRow {
  id: string;
  repo_path: string;
  title: string;
  description: string;
  priority: string;
  status: string;
  order: number;
  created_at: number;
  updated_at: number;
  session_id: string | null;
}

function getDbPath(): string {
  return join(app.getPath('userData'), 'todo.db');
}

let db: sqlite3.Database | null = null;
let workspaceMigrationCompleted = false;
let initializePromise: Promise<void> | null = null;
let initialized = false;
let operationTail: Promise<void> = Promise.resolve();

function getMigrationMarkerPath(): string {
  return join(app.getPath('userData'), 'todo.db.workspace-migrated');
}

function getLegacyBackupPath(): string {
  return join(app.getPath('userData'), 'todo.db.legacy-backup');
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function hasValidMigrationMarkerAt(markerPath: string, backupPath: string): Promise<boolean> {
  try {
    const marker = JSON.parse(await readFile(markerPath, 'utf8')) as {
      version?: unknown;
      backupChecksum?: unknown;
    };
    const backup = await stat(backupPath);
    return (
      marker.version === 1 &&
      typeof marker.backupChecksum === 'string' &&
      /^[a-f0-9]{64}$/.test(marker.backupChecksum) &&
      backup.isFile() &&
      backup.size > 0 &&
      (await fileChecksum(backupPath)) === marker.backupChecksum
    );
  } catch {
    return false;
  }
}

export function hasValidWorkspaceMigrationMarker(userDataPath: string): Promise<boolean> {
  return hasValidMigrationMarkerAt(
    join(userDataPath, 'todo.db.workspace-migrated'),
    join(userDataPath, 'todo.db.legacy-backup')
  );
}

async function fileChecksum(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

function exclusive<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
  const result = operationTail.then(operation, operation);
  operationTail = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

function assertLegacyWritable(): void {
  if (workspaceMigrationCompleted) {
    throw new Error('[TodoService] Legacy Todo database is read-only after workspace migration.');
  }
}

function getDb(): sqlite3.Database {
  if (!db) {
    throw new Error('[TodoService] Database not initialized. Call initialize() first.');
  }
  return db;
}

/** Promisify db.run */
function dbRun(database: sqlite3.Database, sql: string, params: unknown[] = []): Promise<void> {
  return new Promise((resolve, reject) => {
    database.run(sql, params, (err: Error | null) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

/** Promisify db.all */
function dbAll<T>(database: sqlite3.Database, sql: string, params: unknown[] = []): Promise<T[]> {
  return new Promise((resolve, reject) => {
    database.all(sql, params, (err: Error | null, rows: T[]) => {
      if (err) return reject(err);
      resolve(rows ?? []);
    });
  });
}

/** Promisify db.exec */
function dbExec(database: sqlite3.Database, sql: string): Promise<void> {
  return new Promise((resolve, reject) => {
    database.exec(sql, (err: Error | null) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

/** Convert a DB row to the frontend TodoTask shape */
function rowToTask(row: TodoTaskRow): {
  id: string;
  title: string;
  description: string;
  priority: string;
  status: string;
  createdAt: number;
  updatedAt: number;
  order: number;
  sessionId?: string;
} {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    priority: row.priority,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    order: row.order,
    ...(row.session_id ? { sessionId: row.session_id } : {}),
  };
}

async function initializeNow(): Promise<void> {
  const dbPath = getDbPath();
  workspaceMigrationCompleted = await hasValidMigrationMarkerAt(
    getMigrationMarkerPath(),
    getLegacyBackupPath()
  );

  if (workspaceMigrationCompleted && !(await pathExists(dbPath))) {
    initialized = true;
    console.warn('[TodoService] Legacy database is unavailable; using workspace authority only.');
    return;
  }

  const opened = await new Promise<sqlite3.Database>((resolve, reject) => {
    const flags = workspaceMigrationCompleted
      ? sqlite3.OPEN_READONLY
      : sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE;
    const database = new sqlite3.Database(dbPath, flags, (err) => {
      if (err) return reject(err);
      database.configure('busyTimeout', BUSY_TIMEOUT_MS);
      resolve(database);
    });
  });
  db = opened;

  try {
    if (!workspaceMigrationCompleted) {
      await dbExec(
        opened,
        `
        CREATE TABLE IF NOT EXISTS tasks (
          id            TEXT PRIMARY KEY,
          repo_path     TEXT NOT NULL,
          title         TEXT NOT NULL,
          description   TEXT NOT NULL DEFAULT '',
          priority      TEXT NOT NULL DEFAULT 'medium',
          status        TEXT NOT NULL DEFAULT 'todo',
          "order"       INTEGER NOT NULL DEFAULT 0,
          created_at    INTEGER NOT NULL,
          updated_at    INTEGER NOT NULL,
          session_id    TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_tasks_repo_status ON tasks(repo_path, status);
        `
      );
      const columns = await dbAll<{ name: string }>(opened, 'PRAGMA table_info(tasks)');
      if (!columns.some((column) => column.name === 'session_id')) {
        await dbRun(opened, 'ALTER TABLE tasks ADD COLUMN session_id TEXT');
      }
    }

    initialized = true;
    console.log('[TodoService] Database initialized at', dbPath);
  } catch (error) {
    db = null;
    await new Promise<void>((resolve) => opened.close(() => resolve()));
    throw error;
  }
}

export function initialize(): Promise<void> {
  if (initialized) return Promise.resolve();
  initializePromise ??= initializeNow().finally(() => {
    initializePromise = null;
  });
  return initializePromise;
}

export async function getTasks(repoPath: string): Promise<ReturnType<typeof rowToTask>[]> {
  return exclusive(async () => {
    const rows = await dbAll<TodoTaskRow>(
      getDb(),
      'SELECT * FROM tasks WHERE repo_path = ? ORDER BY status, "order"',
      [repoPath]
    );
    return rows.map(rowToTask);
  });
}

export async function addTask(
  repoPath: string,
  task: {
    id: string;
    title: string;
    description: string;
    priority: string;
    status: string;
    order: number;
    createdAt: number;
    updatedAt: number;
    sessionId?: string;
  }
): Promise<ReturnType<typeof rowToTask>> {
  return exclusive(async () => {
    assertLegacyWritable();
    await dbRun(
      getDb(),
      `INSERT INTO tasks (id, repo_path, title, description, priority, status, "order", created_at, updated_at, session_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        task.id,
        repoPath,
        task.title,
        task.description,
        task.priority,
        task.status,
        task.order,
        task.createdAt,
        task.updatedAt,
        task.sessionId ?? null,
      ]
    );

    return { ...task };
  });
}

export async function updateTask(
  repoPath: string,
  taskId: string,
  updates: {
    title?: string;
    description?: string;
    priority?: string;
    status?: string;
    sessionId?: string | null;
  }
): Promise<void> {
  return exclusive(async () => {
    assertLegacyWritable();
    const fields: string[] = [];
    const values: unknown[] = [];

    if (updates.title !== undefined) {
      fields.push('title = ?');
      values.push(updates.title);
    }
    if (updates.description !== undefined) {
      fields.push('description = ?');
      values.push(updates.description);
    }
    if (updates.priority !== undefined) {
      fields.push('priority = ?');
      values.push(updates.priority);
    }
    if (updates.status !== undefined) {
      fields.push('status = ?');
      values.push(updates.status);
    }
    if (updates.sessionId !== undefined) {
      fields.push('session_id = ?');
      values.push(updates.sessionId);
    }

    if (fields.length === 0) return;

    fields.push('updated_at = ?');
    values.push(Date.now());
    values.push(repoPath, taskId);

    await dbRun(
      getDb(),
      `UPDATE tasks SET ${fields.join(', ')} WHERE repo_path = ? AND id = ?`,
      values
    );
  });
}

export async function deleteTask(repoPath: string, taskId: string): Promise<void> {
  return exclusive(async () => {
    assertLegacyWritable();
    await dbRun(getDb(), 'DELETE FROM tasks WHERE repo_path = ? AND id = ?', [repoPath, taskId]);
  });
}

export async function moveTask(
  repoPath: string,
  taskId: string,
  newStatus: string,
  newOrder: number
): Promise<void> {
  return exclusive(async () => {
    assertLegacyWritable();
    const now = Date.now();
    await dbRun(
      getDb(),
      'UPDATE tasks SET status = ?, "order" = ?, updated_at = ? WHERE repo_path = ? AND id = ?',
      [newStatus, newOrder, now, repoPath, taskId]
    );
  });
}

export async function reorderTasks(
  repoPath: string,
  status: string,
  orderedIds: string[]
): Promise<void> {
  return exclusive(async () => {
    assertLegacyWritable();
    const database = getDb();
    const now = Date.now();

    await dbRun(database, 'BEGIN TRANSACTION');
    try {
      for (let i = 0; i < orderedIds.length; i++) {
        await dbRun(
          database,
          'UPDATE tasks SET "order" = ?, updated_at = ? WHERE repo_path = ? AND id = ? AND status = ?',
          [i, now, repoPath, orderedIds[i], status]
        );
      }
      await dbRun(database, 'COMMIT');
    } catch (err) {
      await dbRun(database, 'ROLLBACK').catch(() => {});
      throw err;
    }
  });
}

export async function migrateFromLocalStorage(boardsJson: string): Promise<void> {
  return exclusive(async () => {
    assertLegacyWritable();
    const boards = JSON.parse(boardsJson) as Record<
      string,
      {
        tasks?: Array<{
          id?: unknown;
          title?: unknown;
          description?: unknown;
          priority?: unknown;
          status?: unknown;
          createdAt?: unknown;
          updatedAt?: unknown;
          order?: unknown;
          sessionId?: unknown;
        }>;
      }
    >;

    const database = getDb();
    await dbRun(database, 'BEGIN TRANSACTION');

    try {
      for (const [repoPath, board] of Object.entries(boards)) {
        if (!Array.isArray(board?.tasks)) continue;
        for (const candidate of board.tasks) {
          const task = TodoTaskSceneSchema.parse({
            id: candidate.id,
            title: candidate.title,
            description: candidate.description ?? '',
            priority: candidate.priority ?? 'medium',
            status: candidate.status ?? 'todo',
            order: candidate.order ?? 0,
            createdAt: candidate.createdAt ?? Date.now(),
            updatedAt: candidate.updatedAt ?? Date.now(),
            sessionId: candidate.sessionId ?? null,
          });
          await dbRun(
            database,
            `INSERT OR IGNORE INTO tasks (id, repo_path, title, description, priority, status, "order", created_at, updated_at, session_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              task.id,
              repoPath,
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
      }
      await dbRun(database, 'COMMIT');
      console.log('[TodoService] Migration from localStorage completed');
    } catch (err) {
      await dbRun(database, 'ROLLBACK').catch(() => {});
      throw err;
    }
  });
}

export function isWorkspaceMigrationComplete(): boolean {
  return workspaceMigrationCompleted;
}

function normalizeRepositoryPath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

async function validateWorkspaceMigrationNow(snapshot: WorkspaceSceneSnapshot): Promise<void> {
  const rows = await dbAll<TodoTaskRow>(getDb(), 'SELECT * FROM tasks ORDER BY repo_path, id');
  const repositoriesByPath = new Map(
    Object.values(snapshot.catalog.repositories).map((repository) => [
      normalizeRepositoryPath(repository.path),
      repository,
    ])
  );
  const repositoryIds = new Set(
    [...repositoriesByPath.values()].map((repository) => repository.id)
  );

  const canonicalTaskKeys = new Set<string>();
  for (const row of rows) {
    const repository = repositoriesByPath.get(normalizeRepositoryPath(row.repo_path));
    if (!repository) {
      throw new Error(
        `[TodoService] Cannot finalize migration: legacy tasks remain for unknown repository ${row.repo_path}`
      );
    }
    const canonical = snapshot.todos.boardsByRepository[repository.id]?.tasks[row.id];
    canonicalTaskKeys.add(`${repository.id}:${row.id}`);
    const legacy = TodoTaskSceneSchema.parse({
      ...rowToTask(row),
      sessionId: row.session_id,
    });
    if (
      !canonical ||
      canonical.title !== legacy.title ||
      canonical.description !== legacy.description ||
      canonical.priority !== legacy.priority ||
      canonical.status !== legacy.status ||
      canonical.order !== legacy.order ||
      canonical.createdAt !== legacy.createdAt ||
      canonical.updatedAt !== legacy.updatedAt ||
      canonical.sessionId !== legacy.sessionId
    ) {
      throw new Error(
        `[TodoService] Cannot finalize migration: canonical task ${row.id} is missing or stale`
      );
    }
  }

  // Also reject canonical rows that are absent from the legacy DB. Without
  // this reverse check a stale/partially imported snapshot could make the
  // cutover appear successful while silently dropping a task on rollback.
  for (const [repositoryId, board] of Object.entries(snapshot.todos.boardsByRepository)) {
    if (!repositoryIds.has(repositoryId)) {
      throw new Error(
        `[TodoService] Cannot finalize migration: canonical Todo board references unknown repository ${repositoryId}`
      );
    }
    for (const taskId of Object.keys(board.tasks)) {
      if (!canonicalTaskKeys.has(`${repositoryId}:${taskId}`)) {
        throw new Error(
          `[TodoService] Cannot finalize migration: canonical task ${taskId} is absent from the legacy database`
        );
      }
    }
  }
}

export async function validateWorkspaceMigration(snapshot: WorkspaceSceneSnapshot): Promise<void> {
  return exclusive(async () => {
    await initialize();
    if (db) await validateWorkspaceMigrationNow(snapshot);
  });
}

export async function finalizeWorkspaceMigration(snapshot: WorkspaceSceneSnapshot): Promise<void> {
  return exclusive(async () => {
    await initialize();
    if (workspaceMigrationCompleted) {
      // The legacy database is an immutable rollback backup after cutover;
      // subsequent canonical Todo mutations are expected to diverge from it.
      return;
    }
    await validateWorkspaceMigrationNow(snapshot);
    await close();
    const dbPath = getDbPath();
    const backupPath = getLegacyBackupPath();
    const backupTemporaryPath = `${backupPath}.tmp-${process.pid}`;
    const markerPath = getMigrationMarkerPath();
    const markerTemporaryPath = `${markerPath}.tmp-${process.pid}`;

    try {
      const sourceChecksum = await fileChecksum(dbPath);
      const existingBackup = await stat(backupPath).catch(() => null);
      const existingChecksum = existingBackup?.isFile()
        ? await fileChecksum(backupPath).catch(() => null)
        : null;
      if (existingBackup?.size === 0 || existingChecksum !== sourceChecksum) {
        await copyFile(dbPath, backupTemporaryPath);
        const copied = await stat(backupTemporaryPath);
        if (
          !copied.isFile() ||
          copied.size === 0 ||
          (await fileChecksum(backupTemporaryPath)) !== sourceChecksum
        ) {
          throw new Error('[TodoService] Legacy Todo backup is empty');
        }
        await unlink(backupPath).catch(() => undefined);
        await rename(backupTemporaryPath, backupPath);
      }

      await writeFile(
        markerTemporaryPath,
        JSON.stringify({
          version: 1,
          completedAt: Date.now(),
          backup: 'todo.db.legacy-backup',
          backupChecksum: sourceChecksum,
        }),
        { mode: 0o600 }
      );
      await rename(markerTemporaryPath, markerPath);
      workspaceMigrationCompleted = true;
      await initialize();
    } finally {
      await unlink(backupTemporaryPath).catch(() => undefined);
      await unlink(markerTemporaryPath).catch(() => undefined);
    }
  });
}

export function close(): Promise<void> {
  return new Promise((resolve) => {
    initialized = false;
    if (db) {
      const ref = db;
      db = null;
      ref.close((err) => {
        if (err) console.warn('[TodoService] Failed to close database:', err);
        resolve();
      });
    } else {
      resolve();
    }
  });
}

export function closeSync(): void {
  // Just null the reference; let the process exit handle the rest.
  // SQLite is crash-safe — the OS will release the file descriptor.
  // Calling db.close() with a callback here would leave an async
  // cleanup hook that fires during FreeEnvironment(), causing SIGABRT.
  db = null;
  initialized = false;
}
