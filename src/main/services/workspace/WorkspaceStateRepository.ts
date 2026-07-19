import { createHash } from 'node:crypto';
import { posix, win32 } from 'node:path';
import type {
  JsonValue,
  WorkspaceSceneEvent,
  WorkspaceSceneSnapshot,
} from '@shared/types/workspaceMirror';
import {
  addWorkspaceEntityReservationToState,
  syncWorkspaceEntityRegistryState,
  toWorkspaceHostPathCasePolicy,
  toWorkspaceHostPathPlatform,
  type WorkspaceEntityRegistryState,
  type WorkspaceEntityReservationRecord,
  type WorkspaceHostPathCasePolicy,
  type WorkspaceHostPathPlatform,
} from './WorkspaceEntityRegistry';

export type WorkspaceCommandState =
  | 'prepared'
  | 'executing'
  | 'committed'
  | 'failed'
  | 'needs_reconcile'
  | 'cancelled';

const TERMINAL_COMMAND_STATES = new Set<WorkspaceCommandState>([
  'committed',
  'failed',
  'cancelled',
]);
const SHA256_DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const SENSITIVE_RECONCILE_KEY =
  /(?:content|prompt|token|secret|password|credential|environment|bytes)/i;

const LEGAL_COMMAND_TRANSITIONS: Readonly<
  Record<WorkspaceCommandState, ReadonlySet<WorkspaceCommandState>>
> = {
  prepared: new Set(['executing', 'cancelled']),
  executing: new Set(['committed', 'failed', 'needs_reconcile']),
  needs_reconcile: new Set(['committed', 'failed']),
  committed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

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
  sceneId: string;
  clientId: string;
  deviceId: string;
  commandVersion: number;
  requestDigest: string;
  state: WorkspaceCommandState;
  baseRevision: number;
  committedRevision?: number;
  result?: TResult;
  reconcileMetadata?: JsonValue;
  resultDigest?: string;
  resultCompactedAt?: number;
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
  readonly entityPathPlatform: WorkspaceHostPathPlatform;
  readonly entityPathCasePolicy: WorkspaceHostPathCasePolicy;
  initialize(): Promise<void>;
  loadSnapshot(): Promise<WorkspaceSceneSnapshot | null>;
  loadEvents(): Promise<WorkspacePersistedEvent[]>;
  loadEntityRegistry(sceneId: string): Promise<WorkspaceEntityRegistryState>;
  saveEntityReservation(reservation: WorkspaceEntityReservationRecord): Promise<void>;
  deleteEntityReservation(sceneId: string, entityId: string): Promise<void>;
  loadOperation<TResult = unknown>(
    operationId: string
  ): Promise<WorkspaceOperationRecord<TResult> | null>;
  listUnfinishedOperations<TResult = unknown>(
    sceneId: string
  ): Promise<WorkspaceOperationRecord<TResult>[]>;
  saveSnapshot(snapshot: WorkspaceSceneSnapshot): Promise<void>;
  saveOperation<TResult = unknown>(operation: WorkspaceOperationRecord<TResult>): Promise<void>;
  compareAndSwapOperation<TResult = unknown>(
    operationId: string,
    expectedState: WorkspaceCommandState,
    operation: WorkspaceOperationRecord<TResult>
  ): Promise<boolean>;
  compactOperationResultsBefore(cutoff: number, compactedAt?: number): Promise<number>;
  commit<TResult = unknown>(commit: WorkspaceRepositoryCommit<TResult>): Promise<void>;
  compactEventsThrough(revision: number): Promise<void>;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export function isTerminalWorkspaceCommandState(state: WorkspaceCommandState): boolean {
  return TERMINAL_COMMAND_STATES.has(state);
}

export function isLegalWorkspaceCommandTransition(
  from: WorkspaceCommandState,
  to: WorkspaceCommandState
): boolean {
  return LEGAL_COMMAND_TRANSITIONS[from].has(to);
}

export function assertValidWorkspaceOperationRecord(operation: WorkspaceOperationRecord): void {
  for (const [label, value] of [
    ['operationId', operation.operationId],
    ['intentKind', operation.intentKind],
    ['sceneId', operation.sceneId],
    ['clientId', operation.clientId],
    ['deviceId', operation.deviceId],
  ] as const) {
    if (!value || value.length > 256) {
      throw new Error(`Workspace operation ${label} must contain 1-256 characters`);
    }
  }
  if (!Number.isSafeInteger(operation.commandVersion) || operation.commandVersion <= 0) {
    throw new Error('Workspace operation commandVersion must be a positive safe integer');
  }
  if (!SHA256_DIGEST_PATTERN.test(operation.requestDigest)) {
    throw new Error('Workspace operation requestDigest must be a lowercase SHA-256 digest');
  }
  if (operation.resultDigest && !SHA256_DIGEST_PATTERN.test(operation.resultDigest)) {
    throw new Error('Workspace operation resultDigest must be a lowercase SHA-256 digest');
  }
  if (operation.reconcileMetadata !== undefined) {
    digestWorkspaceOperationResult(operation.reconcileMetadata);
    assertSafeReconcileMetadata(operation.reconcileMetadata);
  }
  for (const [label, value] of [
    ['baseRevision', operation.baseRevision],
    ['createdAt', operation.createdAt],
    ['updatedAt', operation.updatedAt],
  ] as const) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`Workspace operation ${label} must be a non-negative safe integer`);
    }
  }
  if (
    operation.resultCompactedAt !== undefined &&
    (!Number.isSafeInteger(operation.resultCompactedAt) || operation.resultCompactedAt < 0)
  ) {
    throw new Error('Workspace operation resultCompactedAt must be a non-negative safe integer');
  }
  if (
    operation.resultCompactedAt !== undefined &&
    (operation.result !== undefined || !operation.resultDigest)
  ) {
    throw new Error('Workspace operation compacted result must retain only its digest');
  }
}

function assertSafeReconcileMetadata(value: JsonValue, depth = 0): void {
  if (depth > 16) throw new Error('Workspace operation reconciliation metadata is too deep');
  if (typeof value === 'string') {
    if (value.length > 32_768 || posix.isAbsolute(value) || win32.isAbsolute(value)) {
      throw new Error('Workspace operation reconciliation metadata contains an unsafe path');
    }
    return;
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return;
  if (Array.isArray(value)) {
    for (const item of value) assertSafeReconcileMetadata(item, depth + 1);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (
      SENSITIVE_RECONCILE_KEY.test(key) ||
      [
        'path',
        'absolutePath',
        'currentPath',
        'normalizedPath',
        'sourcePath',
        'targetPath',
      ].includes(key)
    ) {
      throw new Error('Workspace operation reconciliation metadata contains a sensitive field');
    }
    assertSafeReconcileMetadata(item, depth + 1);
  }
}

export function assertWorkspaceOperationBinding(
  existing: WorkspaceOperationRecord,
  candidate: WorkspaceOperationRecord
): void {
  if (
    existing.operationId !== candidate.operationId ||
    existing.sceneId !== candidate.sceneId ||
    existing.deviceId !== candidate.deviceId ||
    existing.clientId !== candidate.clientId ||
    existing.commandVersion !== candidate.commandVersion ||
    existing.requestDigest !== candidate.requestDigest
  ) {
    throw new Error('Workspace operation binding conflict');
  }
}

export function assertWorkspaceOperationMetadata(
  existing: WorkspaceOperationRecord,
  candidate: WorkspaceOperationRecord
): void {
  if (
    existing.intentKind !== candidate.intentKind ||
    existing.baseRevision !== candidate.baseRevision ||
    existing.createdAt !== candidate.createdAt ||
    digestWorkspaceOperationResult(existing.reconcileMetadata ?? null) !==
      digestWorkspaceOperationResult(candidate.reconcileMetadata ?? null)
  ) {
    throw new Error('Workspace operation metadata conflict');
  }
}

export function assertWorkspaceCommandTransition(
  from: WorkspaceCommandState,
  to: WorkspaceCommandState
): void {
  if (!isLegalWorkspaceCommandTransition(from, to)) {
    throw new Error(`Illegal workspace operation transition: ${from} -> ${to}`);
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new Error('Workspace operation result is not JSON serializable');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (typeof value !== 'object') {
    throw new Error('Workspace operation result is not JSON serializable');
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`;
}

export function digestWorkspaceOperationResult(result: unknown): string {
  return createHash('sha256').update(canonicalJson(result)).digest('hex');
}

function withResultDigest<TResult>(
  operation: WorkspaceOperationRecord<TResult>
): WorkspaceOperationRecord<TResult> {
  assertValidWorkspaceOperationRecord(operation);
  const result = clone(operation);
  if (result.result !== undefined && !result.resultDigest) {
    result.resultDigest = digestWorkspaceOperationResult(result.result);
  }
  return result;
}

/**
 * Transactional in-memory repository used by tests and the first integration
 * slice. It is deliberately API-compatible with a future SQLite repository.
 */
export class InMemoryWorkspaceStateRepository implements WorkspaceStateRepository {
  readonly entityPathPlatform: WorkspaceHostPathPlatform;
  readonly entityPathCasePolicy: WorkspaceHostPathCasePolicy;
  private snapshot: WorkspaceSceneSnapshot | null = null;
  private events: WorkspacePersistedEvent[] = [];
  private readonly operations = new Map<string, WorkspaceOperationRecord>();
  private readonly entityRegistries = new Map<string, WorkspaceEntityRegistryState>();

  constructor(
    seed?: {
      snapshot?: WorkspaceSceneSnapshot;
      events?: WorkspacePersistedEvent[];
      operations?: WorkspaceOperationRecord[];
      entityRegistry?: WorkspaceEntityRegistryState;
    },
    options: {
      entityPathPlatform?: WorkspaceHostPathPlatform;
      entityPathCasePolicy?: WorkspaceHostPathCasePolicy;
    } = {}
  ) {
    this.entityPathPlatform =
      options.entityPathPlatform ?? toWorkspaceHostPathPlatform(process.platform);
    this.entityPathCasePolicy = toWorkspaceHostPathCasePolicy(options.entityPathCasePolicy);
    this.snapshot = seed?.snapshot ? clone(seed.snapshot) : null;
    this.events = seed?.events ? clone(seed.events) : [];
    for (const operation of seed?.operations ?? []) {
      this.operations.set(operation.operationId, withResultDigest(operation));
    }
    if (seed?.entityRegistry) {
      const sceneIds = new Set([
        ...seed.entityRegistry.entities.map(({ sceneId }) => sceneId),
        ...seed.entityRegistry.aliases.map(({ sceneId }) => sceneId),
        ...seed.entityRegistry.reservations.map(({ sceneId }) => sceneId),
      ]);
      for (const sceneId of sceneIds) {
        this.entityRegistries.set(sceneId, {
          entities: clone(
            seed.entityRegistry.entities.filter((entity) => entity.sceneId === sceneId)
          ),
          aliases: clone(seed.entityRegistry.aliases.filter((alias) => alias.sceneId === sceneId)),
          reservations: clone(
            seed.entityRegistry.reservations.filter(
              (reservation) => reservation.sceneId === sceneId
            )
          ),
        });
      }
    }
    if (this.snapshot) {
      const previous = this.entityRegistries.get(this.snapshot.sceneId) ?? {
        entities: [],
        aliases: [],
        reservations: [],
      };
      this.entityRegistries.set(
        this.snapshot.sceneId,
        syncWorkspaceEntityRegistryState(
          previous,
          this.snapshot,
          this.entityPathPlatform,
          this.entityPathCasePolicy,
          0
        )
      );
    }
  }

  async initialize(): Promise<void> {}

  async loadSnapshot(): Promise<WorkspaceSceneSnapshot | null> {
    return this.snapshot ? clone(this.snapshot) : null;
  }

  async loadEvents(): Promise<WorkspacePersistedEvent[]> {
    return clone(this.events);
  }

  async loadEntityRegistry(sceneId: string): Promise<WorkspaceEntityRegistryState> {
    return clone(
      this.entityRegistries.get(sceneId) ?? { entities: [], aliases: [], reservations: [] }
    );
  }

  async saveEntityReservation(reservation: WorkspaceEntityReservationRecord): Promise<void> {
    const previous = this.entityRegistries.get(reservation.sceneId) ?? {
      entities: [],
      aliases: [],
      reservations: [],
    };
    const next = addWorkspaceEntityReservationToState(
      previous,
      clone(reservation),
      this.entityPathPlatform,
      this.entityPathCasePolicy
    );
    this.entityRegistries.set(reservation.sceneId, next);
  }

  async deleteEntityReservation(sceneId: string, entityId: string): Promise<void> {
    const previous = this.entityRegistries.get(sceneId);
    if (!previous) return;
    this.entityRegistries.set(sceneId, {
      entities: clone(previous.entities),
      aliases: clone(previous.aliases),
      reservations: previous.reservations
        .filter((reservation) => reservation.entityId !== entityId)
        .map((reservation) => clone(reservation)),
    });
  }

  async loadOperation<TResult = unknown>(
    operationId: string
  ): Promise<WorkspaceOperationRecord<TResult> | null> {
    const operation = this.operations.get(operationId);
    return operation ? (clone(operation) as WorkspaceOperationRecord<TResult>) : null;
  }

  async listUnfinishedOperations<TResult = unknown>(
    sceneId: string
  ): Promise<WorkspaceOperationRecord<TResult>[]> {
    return [...this.operations.values()]
      .filter(
        (operation) =>
          operation.sceneId === sceneId && !isTerminalWorkspaceCommandState(operation.state)
      )
      .sort(
        (left, right) =>
          left.createdAt - right.createdAt || left.operationId.localeCompare(right.operationId)
      )
      .map((operation) => clone(operation) as WorkspaceOperationRecord<TResult>);
  }

  async saveSnapshot(snapshot: WorkspaceSceneSnapshot): Promise<void> {
    const nextSnapshot = clone(snapshot);
    const nextEntityRegistry = syncWorkspaceEntityRegistryState(
      this.entityRegistries.get(snapshot.sceneId) ?? {
        entities: [],
        aliases: [],
        reservations: [],
      },
      nextSnapshot,
      this.entityPathPlatform,
      this.entityPathCasePolicy,
      Date.now()
    );
    this.snapshot = nextSnapshot;
    this.entityRegistries.set(snapshot.sceneId, nextEntityRegistry);
  }

  async saveOperation<TResult = unknown>(
    operation: WorkspaceOperationRecord<TResult>
  ): Promise<void> {
    const next = withResultDigest(operation);
    const existing = this.operations.get(next.operationId);
    if (!existing) {
      if (next.state !== 'prepared') {
        throw new Error('New workspace operation must be prepared');
      }
      this.operations.set(next.operationId, clone(next));
      return;
    }
    assertWorkspaceOperationBinding(existing, next);
    assertWorkspaceOperationMetadata(existing, next);
    if (existing.state === next.state) return;
    assertWorkspaceCommandTransition(existing.state, next.state);
    this.operations.set(next.operationId, clone(next));
  }

  async compareAndSwapOperation<TResult = unknown>(
    operationId: string,
    expectedState: WorkspaceCommandState,
    operation: WorkspaceOperationRecord<TResult>
  ): Promise<boolean> {
    if (operation.operationId !== operationId) {
      throw new Error('Workspace operation ID mismatch');
    }
    const existing = this.operations.get(operationId);
    if (!existing) return false;
    assertWorkspaceOperationBinding(existing, operation);
    assertWorkspaceOperationMetadata(existing, operation);
    if (existing.state !== expectedState) return false;
    assertWorkspaceCommandTransition(expectedState, operation.state);
    this.operations.set(operationId, withResultDigest(operation));
    return true;
  }

  async compactOperationResultsBefore(cutoff: number, compactedAt = Date.now()): Promise<number> {
    if (
      !Number.isSafeInteger(cutoff) ||
      cutoff < 0 ||
      !Number.isSafeInteger(compactedAt) ||
      compactedAt < 0
    ) {
      throw new Error(
        'Workspace operation compaction timestamps must be non-negative safe integers'
      );
    }
    let compacted = 0;
    for (const [operationId, operation] of this.operations) {
      if (
        !isTerminalWorkspaceCommandState(operation.state) ||
        operation.updatedAt >= cutoff ||
        operation.result === undefined
      ) {
        continue;
      }
      const tombstone = withResultDigest(operation);
      delete tombstone.result;
      tombstone.resultCompactedAt = compactedAt;
      this.operations.set(operationId, tombstone);
      compacted += 1;
    }
    return compacted;
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
    if (existingOperation) {
      assertWorkspaceOperationBinding(existingOperation, commit.operation);
      assertWorkspaceOperationMetadata(existingOperation, commit.operation);
      if (isTerminalWorkspaceCommandState(existingOperation.state)) {
        throw new Error('Repository operation is already terminal');
      }
      assertWorkspaceCommandTransition(existingOperation.state, 'committed');
    }

    const nextSnapshot = clone(commit.snapshot);
    const nextEvents = [
      ...this.events,
      { event: clone(commit.event), committedAt: commit.committedAt },
    ];
    const nextOperation = withResultDigest(commit.operation);
    const nextEntityRegistry = syncWorkspaceEntityRegistryState(
      this.entityRegistries.get(commit.snapshot.sceneId) ?? {
        entities: [],
        aliases: [],
        reservations: [],
      },
      nextSnapshot,
      this.entityPathPlatform,
      this.entityPathCasePolicy,
      commit.committedAt
    );

    this.snapshot = nextSnapshot;
    this.events = nextEvents;
    this.operations.set(nextOperation.operationId, nextOperation);
    this.entityRegistries.set(commit.snapshot.sceneId, nextEntityRegistry);
  }

  async compactEventsThrough(revision: number): Promise<void> {
    this.events = this.events.filter(({ event }) => event.revision > revision);
  }
}
