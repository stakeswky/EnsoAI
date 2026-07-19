import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { normalizePath, STORAGE_KEYS } from '@/App/storage';
import type { AutoExecuteState, TaskStatus, TodoTask } from '@/components/todo/types';
import { useWorkspaceMirrorStore } from './workspaceMirror';

const EMPTY_TASKS: TodoTask[] = [];

interface TodoState {
  /** In-memory cache: key = normalized repoPath, value = tasks array */
  tasks: Record<string, TodoTask[]>;

  /** Track which repos have been loaded from DB */
  _loaded: Set<string>;

  /** Auto-execute state per repo path */
  autoExecute: Record<string, AutoExecuteState>;

  // Task Actions
  loadTasks: (repoPath: string) => Promise<void>;
  loadTasksForMigration: (repoPath: string) => Promise<void>;
  addTask: (
    repoPath: string,
    task: Omit<TodoTask, 'id' | 'createdAt' | 'updatedAt' | 'order'>
  ) => TodoTask | null;
  updateTask: (
    repoPath: string,
    taskId: string,
    updates: Partial<Pick<TodoTask, 'title' | 'description' | 'priority' | 'status' | 'sessionId'>>
  ) => void;
  deleteTask: (repoPath: string, taskId: string) => void;
  moveTask: (repoPath: string, taskId: string, newStatus: TaskStatus, newOrder: number) => void;
  reorderTasks: (repoPath: string, status: TaskStatus, orderedIds: string[]) => void;

  // Auto-Execute Actions
  startAutoExecute: (repoPath: string, taskIds: string[]) => void;
  stopAutoExecute: (repoPath: string) => void;
  setCurrentExecution: (repoPath: string, taskId: string | null, sessionId: string | null) => void;
  advanceQueue: (repoPath: string) => string | null;
  reorderAutoExecuteQueue: (repoPath: string, fromIndex: number, toIndex: number) => void;
  removeFromAutoExecuteQueue: (repoPath: string, taskId: string) => void;
}

/** Initial auto-execute state (exported for use in useAutoExecuteTask hook) */
export const INITIAL_AUTO_EXECUTE: AutoExecuteState = {
  running: false,
  queue: [],
  currentTaskId: null,
  currentSessionId: null,
};

export function getTodoStoreKey(repoPath: string): string {
  const mirror = useWorkspaceMirrorStore.getState();
  if (mirror.projectionTarget === 'remote' && mirror.snapshot) {
    const repository = Object.values(mirror.snapshot.catalog.repositories).find(
      (candidate) => candidate.path === repoPath
    );
    if (repository) {
      return `remote:${mirror.snapshot.hostId}:${mirror.snapshot.sceneId}:${repository.id}`;
    }
  }
  return normalizePath(repoPath);
}

/** Shared Todo writes require a live controller lease. */
export function canMutateTodo(): boolean {
  const mirror = useWorkspaceMirrorStore.getState();
  return (
    mirror.syncPhase === 'live' &&
    mirror.projectionTarget !== 'transitioning' &&
    mirror.ownsControl &&
    mirror.bootstrapReady
  );
}

function usesWorkspaceTodoAuthority(): boolean {
  const mirror = useWorkspaceMirrorStore.getState();
  // During target transitions, never fall back to the local compatibility DB.
  return mirror.projectionTarget !== 'local' || mirror.bootstrapReady;
}

/** One-time migration from localStorage to SQLite */
let localStorageMigration: Promise<void> | null = null;

export function migrateTodoLocalStorage(): Promise<void> {
  if (!localStorageMigration) {
    const attempt = (async () => {
      const saved = localStorage.getItem(STORAGE_KEYS.TODO_BOARDS);
      if (!saved) return;
      await window.electronAPI.todo.migrate(saved);
      localStorage.removeItem(STORAGE_KEYS.TODO_BOARDS);
      console.log('[TodoStore] Migrated localStorage data to SQLite');
    })();
    localStorageMigration = attempt.catch((error) => {
      localStorageMigration = null;
      throw error;
    });
  }
  return localStorageMigration;
}

async function loadTasksFromAuthority(repoPath: string, force: boolean): Promise<void> {
  const key = getTodoStoreKey(repoPath);
  const state = useTodoStore.getState();
  if (!force && state._loaded.has(key)) return;

  const fetched = (await window.electronAPI.todo.getTasks(repoPath)) as TodoTask[];
  useTodoStore.setState((current) => {
    const existingById = new Map((current.tasks[key] ?? []).map((task) => [task.id, task]));
    const tasks = fetched.map((task) => {
      const existingSessionId = existingById.get(task.id)?.sessionId;
      return task.sessionId || !existingSessionId
        ? task
        : { ...task, sessionId: existingSessionId };
    });
    const loaded = new Set(current._loaded);
    loaded.add(key);
    return { tasks: { ...current.tasks, [key]: tasks }, _loaded: loaded };
  });
}

export const useTodoStore = create<TodoState>()(
  subscribeWithSelector((set, get) => ({
    tasks: {},
    _loaded: new Set<string>(),
    autoExecute: {},

    loadTasks: async (repoPath) => {
      try {
        await loadTasksFromAuthority(repoPath, false);
      } catch (err) {
        console.error('[TodoStore] Failed to load tasks for', getTodoStoreKey(repoPath), err);
      }
    },

    loadTasksForMigration: async (repoPath) => {
      await loadTasksFromAuthority(repoPath, true);
    },

    addTask: (repoPath, taskData) => {
      if (!canMutateTodo()) return null;
      const key = getTodoStoreKey(repoPath);
      const existing = get().tasks[key] ?? [];
      const tasksInColumn = existing.filter((t) => t.status === taskData.status);
      const maxOrder = tasksInColumn.reduce((max, t) => Math.max(max, t.order), -1);

      const newTask: TodoTask = {
        id: crypto.randomUUID(),
        title: taskData.title,
        description: taskData.description,
        priority: taskData.priority,
        status: taskData.status,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        order: maxOrder + 1,
      };

      // Optimistic update
      set((state) => ({
        tasks: { ...state.tasks, [key]: [...(state.tasks[key] ?? []), newTask] },
      }));

      // Persist to SQLite
      if (!usesWorkspaceTodoAuthority()) {
        window.electronAPI.todo
          .addTask(repoPath, newTask)
          .catch((err) => console.error('[TodoStore] addTask IPC failed:', err));
      }

      return newTask;
    },

    updateTask: (repoPath, taskId, updates) => {
      if (!canMutateTodo()) return;
      const key = getTodoStoreKey(repoPath);
      const existing = get().tasks[key];
      if (!existing) return;

      const now = Date.now();
      set((state) => ({
        tasks: {
          ...state.tasks,
          [key]: (state.tasks[key] ?? []).map((t) =>
            t.id === taskId ? { ...t, ...updates, updatedAt: now } : t
          ),
        },
      }));

      if (!usesWorkspaceTodoAuthority()) {
        window.electronAPI.todo
          .updateTask(repoPath, taskId, updates)
          .catch((err) => console.error('[TodoStore] updateTask IPC failed:', err));
      }
    },

    deleteTask: (repoPath, taskId) => {
      if (!canMutateTodo()) return;
      const key = getTodoStoreKey(repoPath);
      const existing = get().tasks[key];
      if (!existing) return;

      set((state) => ({
        tasks: {
          ...state.tasks,
          [key]: (state.tasks[key] ?? []).filter((t) => t.id !== taskId),
        },
      }));

      if (!usesWorkspaceTodoAuthority()) {
        window.electronAPI.todo
          .deleteTask(repoPath, taskId)
          .catch((err) => console.error('[TodoStore] deleteTask IPC failed:', err));
      }
    },

    moveTask: (repoPath, taskId, newStatus, newOrder) => {
      if (!canMutateTodo()) return;
      const key = getTodoStoreKey(repoPath);
      const existing = get().tasks[key];
      if (!existing) return;

      const now = Date.now();
      set((state) => ({
        tasks: {
          ...state.tasks,
          [key]: (state.tasks[key] ?? []).map((t) =>
            t.id === taskId ? { ...t, status: newStatus, order: newOrder, updatedAt: now } : t
          ),
        },
      }));

      if (!usesWorkspaceTodoAuthority()) {
        window.electronAPI.todo
          .moveTask(repoPath, taskId, newStatus, newOrder)
          .catch((err) => console.error('[TodoStore] moveTask IPC failed:', err));
      }
    },

    reorderTasks: (repoPath, status, orderedIds) => {
      if (!canMutateTodo()) return;
      const key = getTodoStoreKey(repoPath);
      const existing = get().tasks[key];
      if (!existing) return;

      const orderMap = new Map(orderedIds.map((id, i) => [id, i]));
      const now = Date.now();
      set((state) => ({
        tasks: {
          ...state.tasks,
          [key]: (state.tasks[key] ?? []).map((t) => {
            if (t.status === status && orderMap.has(t.id)) {
              return { ...t, order: orderMap.get(t.id)!, updatedAt: now };
            }
            return t;
          }),
        },
      }));

      if (!usesWorkspaceTodoAuthority()) {
        window.electronAPI.todo
          .reorderTasks(repoPath, status, orderedIds)
          .catch((err) => console.error('[TodoStore] reorderTasks IPC failed:', err));
      }
    },

    // Auto-Execute Actions
    startAutoExecute: (repoPath, taskIds) => {
      if (!canMutateTodo()) return;
      const key = getTodoStoreKey(repoPath);

      set((state) => ({
        autoExecute: {
          ...state.autoExecute,
          [key]: {
            running: true,
            queue: taskIds,
            currentTaskId: null,
            currentSessionId: null,
          },
        },
      }));
    },

    stopAutoExecute: (repoPath) => {
      if (!canMutateTodo()) return;
      const key = getTodoStoreKey(repoPath);
      set((state) => ({
        autoExecute: {
          ...state.autoExecute,
          [key]: {
            running: false,
            queue: [],
            currentTaskId: null,
            currentSessionId: null,
          },
        },
      }));
    },

    setCurrentExecution: (repoPath, taskId, sessionId) => {
      if (!canMutateTodo()) return;
      const key = getTodoStoreKey(repoPath);
      set((state) => {
        const current = state.autoExecute[key];
        if (!current) return state;
        // Skip update if values haven't changed
        if (current.currentTaskId === taskId && current.currentSessionId === sessionId) {
          return state;
        }
        return {
          autoExecute: {
            ...state.autoExecute,
            [key]: { ...current, currentTaskId: taskId, currentSessionId: sessionId },
          },
        };
      });
    },

    advanceQueue: (repoPath) => {
      if (!canMutateTodo()) return null;
      const key = getTodoStoreKey(repoPath);
      const current = get().autoExecute[key];
      if (!current || current.queue.length === 0) {
        // No more tasks, stop auto-execute
        set((state) => ({
          autoExecute: {
            ...state.autoExecute,
            [key]: {
              running: false,
              queue: [],
              currentTaskId: null,
              currentSessionId: null,
            },
          },
        }));
        return null;
      }

      const [nextTaskId, ...remaining] = current.queue;
      set((state) => ({
        autoExecute: {
          ...state.autoExecute,
          [key]: {
            ...current,
            queue: remaining,
            currentTaskId: nextTaskId,
          },
        },
      }));

      return nextTaskId;
    },

    reorderAutoExecuteQueue: (repoPath, fromIndex, toIndex) => {
      if (!canMutateTodo()) return;
      const key = getTodoStoreKey(repoPath);
      set((state) => {
        const current = state.autoExecute[key];
        if (!current) return state;

        const queue = [...current.queue];
        const [removed] = queue.splice(fromIndex, 1);
        queue.splice(toIndex, 0, removed);

        return {
          autoExecute: {
            ...state.autoExecute,
            [key]: { ...current, queue },
          },
        };
      });
    },

    removeFromAutoExecuteQueue: (repoPath, taskId) => {
      if (!canMutateTodo()) return;
      const key = getTodoStoreKey(repoPath);
      set((state) => {
        const current = state.autoExecute[key];
        if (!current) return state;

        return {
          autoExecute: {
            ...state.autoExecute,
            [key]: {
              ...current,
              queue: current.queue.filter((id) => id !== taskId),
            },
          },
        };
      });
    },
  }))
);

/** Stable selector: returns cached EMPTY_TASKS when repo has no tasks */
export function selectTasks(state: TodoState, repoPath: string): TodoTask[] {
  const key = getTodoStoreKey(repoPath);
  return state.tasks[key] ?? EMPTY_TASKS;
}

/** Selector: get auto-execute state for a repo */
export function selectAutoExecute(state: TodoState, repoPath: string): AutoExecuteState {
  const key = getTodoStoreKey(repoPath);
  return state.autoExecute[key] ?? INITIAL_AUTO_EXECUTE;
}
