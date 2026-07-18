import type { WorkspaceSceneEvent, WorkspaceSceneSnapshot } from '@shared/types/workspaceMirror';

export type WorkspaceCommandState =
  | 'prepared'
  | 'executing'
  | 'committed'
  | 'failed'
  | 'needs_reconcile';

export interface WorkspaceOperationError {
  code: string;
  message: string;
}

/**
 * Durable command metadata. Repository implementations must redact sensitive
 * payloads before persisting this record.
 */
export interface WorkspaceOperationRecord<TResult = unknown> {
  operationId: string;
  intentKind: string;
  clientId: string;
  deviceId?: string;
  state: WorkspaceCommandState;
  baseRevision: number;
  committedRevision?: number;
  result?: TResult;
  error?: WorkspaceOperationError;
  createdAt: number;
  updatedAt: number;
}

export interface WorkspacePersistedEvent {
  event: WorkspaceSceneEvent;
  committedAt: number;
}

export interface WorkspaceRepositoryCommit<TResult = unknown> {
  snapshot: WorkspaceSceneSnapshot;
  event: WorkspaceSceneEvent;
  operation: WorkspaceOperationRecord<TResult>;
  committedAt: number;
}

/**
 * Persistence boundary for the scene engine. The methods intentionally map to
 * transactions a SQLite implementation can provide without changing service
 * semantics.
 */
export interface WorkspaceStateRepository {
  initialize(): Promise<void>;
  loadSnapshot(): Promise<WorkspaceSceneSnapshot | null>;
  loadEvents(): Promise<WorkspacePersistedEvent[]>;
  loadOperation<TResult = unknown>(
    operationId: string
  ): Promise<WorkspaceOperationRecord<TResult> | null>;
  saveSnapshot(snapshot: WorkspaceSceneSnapshot): Promise<void>;
  saveOperation<TResult = unknown>(operation: WorkspaceOperationRecord<TResult>): Promise<void>;
  commit<TResult = unknown>(commit: WorkspaceRepositoryCommit<TResult>): Promise<void>;
  compactEventsThrough(revision: number): Promise<void>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

/**
 * Transactional in-memory repository used by tests and the first integration
 * slice. It is deliberately API-compatible with a future SQLite repository.
 */
export class InMemoryWorkspaceStateRepository implements WorkspaceStateRepository {
  private snapshot: WorkspaceSceneSnapshot | null = null;
  private events: WorkspacePersistedEvent[] = [];
  private readonly operations = new Map<string, WorkspaceOperationRecord>();

  constructor(seed?: {
    snapshot?: WorkspaceSceneSnapshot;
    events?: WorkspacePersistedEvent[];
    operations?: WorkspaceOperationRecord[];
  }) {
    this.snapshot = seed?.snapshot ? clone(seed.snapshot) : null;
    this.events = seed?.events ? clone(seed.events) : [];
    for (const operation of seed?.operations ?? []) {
      this.operations.set(operation.operationId, clone(operation));
    }
  }

  async initialize(): Promise<void> {}

  async loadSnapshot(): Promise<WorkspaceSceneSnapshot | null> {
    return this.snapshot ? clone(this.snapshot) : null;
  }

  async loadEvents(): Promise<WorkspacePersistedEvent[]> {
    return clone(this.events);
  }

  async loadOperation<TResult = unknown>(
    operationId: string
  ): Promise<WorkspaceOperationRecord<TResult> | null> {
    const operation = this.operations.get(operationId);
    return operation ? (clone(operation) as WorkspaceOperationRecord<TResult>) : null;
  }

  async saveSnapshot(snapshot: WorkspaceSceneSnapshot): Promise<void> {
    this.snapshot = clone(snapshot);
  }

  async saveOperation<TResult = unknown>(
    operation: WorkspaceOperationRecord<TResult>
  ): Promise<void> {
    this.operations.set(operation.operationId, clone(operation));
  }

  async commit<TResult = unknown>(commit: WorkspaceRepositoryCommit<TResult>): Promise<void> {
    if (commit.snapshot.revision !== commit.event.revision) {
      throw new Error('Repository commit revision mismatch');
    }
    if (
      commit.snapshot.hostEpoch !== commit.event.hostEpoch ||
      commit.snapshot.sceneId !== commit.event.sceneId
    ) {
      throw new Error('Repository commit scene identity mismatch');
    }
    if (
      this.snapshot &&
      this.snapshot.hostEpoch === commit.snapshot.hostEpoch &&
      this.snapshot.sceneId === commit.snapshot.sceneId &&
      commit.event.revision !== this.snapshot.revision + 1
    ) {
      throw new Error('Repository commit must advance exactly one revision');
    }
    if (commit.operation.state !== 'committed') {
      throw new Error('Repository commit requires a committed operation');
    }
    if (commit.operation.committedRevision !== commit.event.revision) {
      throw new Error('Repository operation revision mismatch');
    }
    if (
      commit.event.origin.source === 'client' &&
      (commit.event.origin.operationId !== commit.operation.operationId ||
        commit.event.origin.clientId !== commit.operation.clientId ||
        commit.event.origin.deviceId !== commit.operation.deviceId)
    ) {
      throw new Error('Repository operation origin mismatch');
    }
    const existingOperation = this.operations.get(commit.operation.operationId);
    if (existingOperation?.state === 'committed') {
      throw new Error('Repository operation is already committed');
    }

    const nextSnapshot = clone(commit.snapshot);
    const nextEvents = [
      ...this.events,
      { event: clone(commit.event), committedAt: commit.committedAt },
    ];
    const nextOperation = clone(commit.operation);

    this.snapshot = nextSnapshot;
    this.events = nextEvents;
    this.operations.set(nextOperation.operationId, nextOperation);
  }

  async compactEventsThrough(revision: number): Promise<void> {
    this.events = this.events.filter(({ event }) => event.revision > revision);
  }
}
