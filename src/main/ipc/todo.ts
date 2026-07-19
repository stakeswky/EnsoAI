import { IPC_CHANNELS, TodoTaskSceneSchema, type WorkspaceSceneSnapshot } from '@shared/types';
import type { ClaudeEffort } from '@shared/types/ai';
import { ipcMain } from 'electron';
import type { AIProvider, ModelId, ReasoningEffort } from '../services/ai';
import { polishTodoTask } from '../services/ai';
import * as todoService from '../services/todo/TodoService';
import { getWorkspaceMirrorService } from '../services/workspace/workspaceMirrorRuntime';

let readyPromise: Promise<void>;
let workspaceTodoTail: Promise<void> = Promise.resolve();

/** Ensure DB is ready before processing any IPC call */
async function ensureReady(): Promise<void> {
  await readyPromise;
}

function normalizeRepositoryPath(path: string): string {
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function findWorkspaceRepository(snapshot: WorkspaceSceneSnapshot, repoPath: string) {
  const normalizedPath = normalizeRepositoryPath(repoPath);
  return Object.values(snapshot.catalog.repositories).find(
    (candidate) => normalizeRepositoryPath(candidate.path) === normalizedPath
  );
}

function getWorkspaceTasks(repoPath: string): unknown[] | null {
  const mirror = getWorkspaceMirrorService();
  if (!todoService.isWorkspaceMigrationComplete() || !mirror.isBootstrapReady()) return null;
  const snapshot = mirror.getSnapshot();
  const repository = findWorkspaceRepository(snapshot, repoPath);
  if (!repository) return [];
  const board = snapshot.todos.boardsByRepository[repository.id];
  if (!board) return [];
  return Object.values(board.tasks)
    .sort((left, right) => left.order - right.order)
    .map((task) => ({
      ...task,
      ...(task.sessionId === null ? { sessionId: undefined } : {}),
    }));
}

function assertWorkspaceTodoReady(): void {
  if (!getWorkspaceMirrorService().isBootstrapReady()) {
    throw new Error('Workspace Todo authority is still bootstrapping');
  }
}

function mutateWorkspaceTodo<TResult>(
  repoPath: string,
  mutate: (board: WorkspaceSceneSnapshot['todos']['boardsByRepository'][string]) => TResult
): Promise<TResult> {
  const result = workspaceTodoTail.then(async () => {
    const service = getWorkspaceMirrorService();
    return service.dispatchHostMutationFactory((snapshot) => {
      const repository = findWorkspaceRepository(snapshot, repoPath);
      if (!repository) throw new Error(`Workspace repository not found for Todo path: ${repoPath}`);
      const todos = structuredClone(snapshot.todos);
      let board = todos.boardsByRepository[repository.id];
      if (!board) {
        board = {
          tasks: {},
          autoExecution: {
            running: false,
            queue: [],
            currentTaskId: null,
            currentSessionId: null,
          },
        };
        todos.boardsByRepository[repository.id] = board;
      }
      const value = mutate(board);
      return { mutation: { kind: 'todos.replace', payload: { todos } }, result: value };
    });
  });
  workspaceTodoTail = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

export function registerTodoHandlers(): void {
  readyPromise = todoService.initialize();

  ipcMain.handle(IPC_CHANNELS.TODO_GET_TASKS, async (_, repoPath: string) => {
    await ensureReady();
    const workspaceTasks = getWorkspaceTasks(repoPath);
    if (workspaceTasks) return workspaceTasks;
    return todoService.getTasks(repoPath);
  });

  ipcMain.handle(
    IPC_CHANNELS.TODO_ADD_TASK,
    async (
      _,
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
    ) => {
      await ensureReady();
      if (todoService.isWorkspaceMigrationComplete()) {
        assertWorkspaceTodoReady();
        return mutateWorkspaceTodo(repoPath, (board) => {
          const canonical = TodoTaskSceneSchema.parse({
            ...task,
            sessionId: task.sessionId ?? null,
          });
          board.tasks[canonical.id] = canonical;
          const { sessionId, ...rest } = canonical;
          return { ...rest, ...(sessionId ? { sessionId } : {}) };
        });
      }
      return todoService.addTask(repoPath, task);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.TODO_UPDATE_TASK,
    async (
      _,
      repoPath: string,
      taskId: string,
      updates: {
        title?: string;
        description?: string;
        priority?: string;
        status?: string;
        sessionId?: string | null;
      }
    ) => {
      await ensureReady();
      if (todoService.isWorkspaceMigrationComplete()) {
        assertWorkspaceTodoReady();
        return mutateWorkspaceTodo(repoPath, (board) => {
          const current = board.tasks[taskId];
          if (!current) return;
          board.tasks[taskId] = TodoTaskSceneSchema.parse({
            ...current,
            ...updates,
            updatedAt: Date.now(),
          });
        });
      }
      return todoService.updateTask(repoPath, taskId, updates);
    }
  );

  ipcMain.handle(IPC_CHANNELS.TODO_DELETE_TASK, async (_, repoPath: string, taskId: string) => {
    await ensureReady();
    if (todoService.isWorkspaceMigrationComplete()) {
      assertWorkspaceTodoReady();
      return mutateWorkspaceTodo(repoPath, (board) => {
        delete board.tasks[taskId];
      });
    }
    return todoService.deleteTask(repoPath, taskId);
  });

  ipcMain.handle(
    IPC_CHANNELS.TODO_MOVE_TASK,
    async (_, repoPath: string, taskId: string, newStatus: string, newOrder: number) => {
      await ensureReady();
      if (todoService.isWorkspaceMigrationComplete()) {
        assertWorkspaceTodoReady();
        return mutateWorkspaceTodo(repoPath, (board) => {
          const current = board.tasks[taskId];
          if (!current) return;
          board.tasks[taskId] = TodoTaskSceneSchema.parse({
            ...current,
            status: newStatus,
            order: newOrder,
            updatedAt: Date.now(),
          });
        });
      }
      return todoService.moveTask(repoPath, taskId, newStatus, newOrder);
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.TODO_REORDER_TASKS,
    async (_, repoPath: string, status: string, orderedIds: string[]) => {
      await ensureReady();
      if (todoService.isWorkspaceMigrationComplete()) {
        assertWorkspaceTodoReady();
        return mutateWorkspaceTodo(repoPath, (board) => {
          const orderById = new Map(orderedIds.map((id, order) => [id, order]));
          const updatedAt = Date.now();
          for (const task of Object.values(board.tasks)) {
            const order = orderById.get(task.id);
            if (task.status === status && order !== undefined) {
              board.tasks[task.id] = { ...task, order, updatedAt };
            }
          }
        });
      }
      return todoService.reorderTasks(repoPath, status, orderedIds);
    }
  );

  ipcMain.handle(IPC_CHANNELS.TODO_MIGRATE, async (_, boardsJson: string) => {
    await ensureReady();
    if (todoService.isWorkspaceMigrationComplete()) return;
    return todoService.migrateFromLocalStorage(boardsJson);
  });

  ipcMain.handle(
    IPC_CHANNELS.TODO_AI_POLISH,
    async (
      _,
      options: {
        text: string;
        timeout: number;
        provider: string;
        model: string;
        reasoningEffort?: string;
        bare?: boolean;
        claudeEffort?: string;
        prompt?: string;
      }
    ): Promise<{ success: boolean; title?: string; description?: string; error?: string }> => {
      return polishTodoTask({
        text: options.text,
        timeout: options.timeout,
        provider: (options.provider ?? 'claude-code') as AIProvider,
        model: options.model as ModelId,
        reasoningEffort: options.reasoningEffort as ReasoningEffort | undefined,
        bare: options.bare,
        claudeEffort: options.claudeEffort as ClaudeEffort | undefined,
        prompt: options.prompt,
      });
    }
  );
}

export function cleanupTodo(): Promise<void> {
  return todoService.close();
}

export function cleanupTodoSync(): void {
  todoService.closeSync();
}
