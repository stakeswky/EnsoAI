import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEmptyWorkspaceSceneSnapshot, WorkspaceSceneSnapshotSchema } from '@shared/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const electronState = vi.hoisted(() => ({ userData: '' }));

vi.mock('electron', () => ({
  app: {
    getPath: () => electronState.userData,
  },
}));

async function loadService() {
  vi.resetModules();
  return import('../TodoService');
}

function migrationSnapshot(task: {
  id: string;
  title: string;
  description: string;
  priority: 'low' | 'medium' | 'high';
  status: 'todo' | 'in-progress' | 'done';
  order: number;
  createdAt: number;
  updatedAt: number;
  sessionId?: string | null;
  includeRepository?: boolean;
}) {
  const { includeRepository, ...taskData } = task;
  const snapshot = createEmptyWorkspaceSceneSnapshot({
    hostId: 'host-test',
    sceneId: 'scene-test',
    hostEpoch: '11111111-1111-4111-8111-111111111111',
  });
  if (includeRepository !== false) {
    snapshot.catalog.repositories['repo-1'] = {
      id: 'repo-1',
      path: '/repo',
      name: 'repo',
      groupId: null,
      order: 0,
      settings: { autoInitWorktree: false, initScript: '', hidden: false },
    };
  }
  snapshot.todos.boardsByRepository['repo-1'] = {
    tasks: {
      [taskData.id]: { ...taskData, sessionId: taskData.sessionId ?? null },
    },
    autoExecution: {
      running: false,
      queue: [],
      currentTaskId: null,
      currentSessionId: null,
    },
  };
  return WorkspaceSceneSnapshotSchema.parse(snapshot);
}

describe('TodoService workspace cutover', () => {
  let userData: string;

  beforeEach(async () => {
    userData = await mkdtemp(join(tmpdir(), 'enso-todo-service-'));
    electronState.userData = userData;
  });

  it('imports session relationships, creates a checksummed backup, and is read-only after restart', async () => {
    const service = await loadService();
    await service.initialize();
    const task = {
      id: 'task-1',
      title: 'Migrate',
      description: 'Verify cutover',
      priority: 'high' as const,
      status: 'todo' as const,
      order: 0,
      createdAt: 10,
      updatedAt: 11,
    };
    await service.migrateFromLocalStorage(
      JSON.stringify({ '/repo': { tasks: [{ ...task, sessionId: 'agent-1' }] } })
    );
    const loaded = await service.getTasks('/repo');
    expect(loaded[0]).toMatchObject({ id: 'task-1', sessionId: 'agent-1' });

    await service.finalizeWorkspaceMigration(migrationSnapshot({ ...task, sessionId: 'agent-1' }));
    expect(service.isWorkspaceMigrationComplete()).toBe(true);
    expect((await stat(join(userData, 'todo.db.legacy-backup'))).size).toBeGreaterThan(0);
    expect(
      JSON.parse(await readFile(join(userData, 'todo.db.workspace-migrated'), 'utf8'))
    ).toMatchObject({
      version: 1,
      backupChecksum: expect.any(String),
    });
    await expect(service.addTask('/repo', { ...task, id: 'task-2' })).rejects.toThrow('read-only');

    await service.close();
    const restarted = await loadService();
    await restarted.initialize();
    expect(restarted.isWorkspaceMigrationComplete()).toBe(true);
    await expect(restarted.updateTask('/repo', 'task-1', { title: 'blocked' })).rejects.toThrow(
      'read-only'
    );
    await restarted.close();
  });

  it('does not accept a corrupt backup marker and allows a safe retry', async () => {
    const service = await loadService();
    await service.initialize();
    const task = {
      id: 'task-1',
      title: 'Retry',
      description: '',
      priority: 'medium' as const,
      status: 'todo' as const,
      order: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    await service.migrateFromLocalStorage(JSON.stringify({ '/repo': { tasks: [task] } }));
    await expect(
      service.finalizeWorkspaceMigration(migrationSnapshot({ ...task, includeRepository: false }))
    ).rejects.toThrow('unknown repository');
    expect(service.isWorkspaceMigrationComplete()).toBe(false);
    await service.addTask('/repo', { ...task, id: 'task-2' });
    await service.close();

    const retry = await loadService();
    await retry.initialize();
    await retry.deleteTask('/repo', 'task-2');
    await retry.finalizeWorkspaceMigration(migrationSnapshot(task));
    await retry.close();
    await writeFile(join(userData, 'todo.db.legacy-backup'), 'corrupt');

    const recovered = await loadService();
    await recovered.initialize();
    expect(recovered.isWorkspaceMigrationComplete()).toBe(false);
    await recovered.finalizeWorkspaceMigration(migrationSnapshot(task));
    expect(recovered.isWorkspaceMigrationComplete()).toBe(true);
    await recovered.close();
    await rm(userData, { recursive: true, force: true });
  });
});
