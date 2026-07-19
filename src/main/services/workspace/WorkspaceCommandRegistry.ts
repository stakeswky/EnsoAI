import { createHash } from 'node:crypto';
import {
  canonicalJson,
  decodeWorkspaceCommandArgs,
  type JsonValue,
  JsonValueSchema,
  type WorkspaceCommandExecuteFrame,
  type WorkspaceCommandResultFrame,
  type WorkspaceMirrorError,
  WorkspaceMirrorErrorSchema,
} from '@shared/types/workspaceMirror';
import type { z } from 'zod';
import {
  type DurableRemoteCommandDescriptor,
  REMOTE_COMMAND_MANIFEST,
} from '../remote/remoteCommandManifest';
import {
  createFileWorkspaceCommandAdapters,
  type FileWorkspaceCommandAdapterContext,
} from './commands/FileWorkspaceCommandAdapters';
import {
  createLifecycleWorkspaceCommandAdapters,
  type LifecycleWorkspaceCommandAdapterContext,
} from './commands/LifecycleWorkspaceCommandAdapters';
import {
  strictWorkspaceCommandResultSchemas,
  strictWorkspaceCommandSchemas,
} from './commands/StrictWorkspaceCommandSchemas';
import type {
  WorkspaceOperationRecord,
  WorkspaceStateRepository,
} from './WorkspaceStateRepository';
import { digestWorkspaceOperationResult } from './WorkspaceStateRepository';

export const WORKSPACE_COMMAND_VERSION = 1;
export const WORKSPACE_COMMAND_RESULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
export const WORKSPACE_COMMAND_VOLATILE_RESULT_TTL_MS = 5 * 60 * 1_000;
export const WORKSPACE_COMMAND_VOLATILE_RESULT_MAX_ENTRIES = 256;
export const WORKSPACE_COMMAND_VOLATILE_RESULT_MAX_BYTES = 32 * 1024 * 1024;

const SENSITIVE_COMMAND_METADATA_KEY =
  /(?:content|draft|prompt|token|secret|password|credential|attachment|resource|environment|env|raw|bytes|path)/i;

function redactCommandMetadata(value: unknown, depth = 0): unknown {
  if (depth > 8) return undefined;
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return value.length <= 4_096 ? value : undefined;
  if (Array.isArray(value)) {
    return value
      .slice(0, 128)
      .map((item) => redactCommandMetadata(item, depth + 1))
      .filter((item) => item !== undefined);
  }
  if (!value || typeof value !== 'object') return undefined;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (key.length > 128 || SENSITIVE_COMMAND_METADATA_KEY.test(key)) continue;
    const redacted = redactCommandMetadata(item, depth + 1);
    if (redacted !== undefined) result[key] = redacted;
  }
  return result;
}

export interface WorkspaceCommandActor {
  clientId: string;
  deviceId: string;
}

export interface WorkspaceCommandReconcileResult {
  state: 'committed' | 'failed';
  result?: unknown;
  error?: WorkspaceMirrorError;
}

export interface WorkspaceCommandDescriptor {
  command: string;
  version: number;
  manifest: DurableRemoteCommandDescriptor;
  requestSchema: z.ZodType<WorkspaceCommandInvocationArgs>;
  resultSchema: z.ZodType<unknown>;
  prepare?: (args: WorkspaceCommandInvocationArgs) => Promise<unknown>;
  cancel?: (operation: WorkspaceOperationRecord) => Promise<void>;
  verify?: (
    operation: WorkspaceOperationRecord,
    result: unknown
  ) => Promise<WorkspaceCommandReconcileResult | null>;
  reconcile?: (
    operation: WorkspaceOperationRecord
  ) => Promise<WorkspaceCommandReconcileResult | null>;
}

export type WorkspaceCommandInvocationArgs = unknown[];

export type WorkspaceCommandAdapter = Pick<
  WorkspaceCommandDescriptor,
  'requestSchema' | 'resultSchema' | 'prepare' | 'cancel' | 'verify' | 'reconcile'
>;

export interface RemoteWorkspaceCommandRegistryOptions
  extends Partial<FileWorkspaceCommandAdapterContext>,
    Partial<LifecycleWorkspaceCommandAdapterContext> {}

export class WorkspaceCommandRegistry {
  private readonly descriptors = new Map<string, WorkspaceCommandDescriptor>();

  register(descriptor: WorkspaceCommandDescriptor): void {
    if (descriptor.command !== descriptor.manifest.channel) {
      throw new Error('Workspace command descriptor channel mismatch');
    }
    if (!Number.isSafeInteger(descriptor.version) || descriptor.version <= 0) {
      throw new Error('Workspace command descriptor version must be a positive safe integer');
    }
    if (this.descriptors.has(descriptor.command)) {
      throw new Error(`Duplicate workspace command descriptor: ${descriptor.command}`);
    }
    this.descriptors.set(descriptor.command, descriptor);
  }

  lookup(command: string): WorkspaceCommandDescriptor | undefined {
    return this.descriptors.get(command);
  }

  list(): WorkspaceCommandDescriptor[] {
    return [...this.descriptors.values()];
  }
}

export function createRemoteWorkspaceCommandRegistry(
  options: RemoteWorkspaceCommandRegistryOptions = {}
): WorkspaceCommandRegistry {
  const registry = new WorkspaceCommandRegistry();
  const adapters = new Map<string, Partial<WorkspaceCommandAdapter>>();
  const resultSchemas = strictWorkspaceCommandResultSchemas();
  const hasRuntimeAdapterContext = Boolean(
    options.getSnapshot &&
      options.entityRegistry &&
      options.commitEntity &&
      options.removeWorktree &&
      options.terminalSessionExists &&
      options.tmuxSessionExists
  );
  for (const [channel, requestSchema] of strictWorkspaceCommandSchemas()) {
    const resultSchema = resultSchemas.get(channel);
    if (!resultSchema) {
      throw new Error(`Workspace command is missing a strict result schema: ${channel}`);
    }
    adapters.set(channel, {
      requestSchema,
      resultSchema,
    });
  }
  if (options.getSnapshot) {
    for (const [channel, adapter] of createFileWorkspaceCommandAdapters({
      getSnapshot: options.getSnapshot,
    })) {
      adapters.set(channel, { ...adapters.get(channel), ...adapter });
    }
  }
  if (
    options.getSnapshot &&
    options.entityRegistry &&
    options.commitEntity &&
    options.removeWorktree &&
    options.terminalSessionExists &&
    options.tmuxSessionExists
  ) {
    for (const [channel, adapter] of createLifecycleWorkspaceCommandAdapters({
      getSnapshot: options.getSnapshot,
      entityRegistry: options.entityRegistry,
      commitEntity: options.commitEntity,
      removeWorktree: options.removeWorktree,
      terminalSessionExists: options.terminalSessionExists,
      tmuxSessionExists: options.tmuxSessionExists,
    })) {
      adapters.set(channel, { ...adapters.get(channel), ...adapter });
    }
  }
  for (const descriptor of Object.values(REMOTE_COMMAND_MANIFEST)) {
    if (descriptor.route !== 'durable-command') continue;
    const adapter = adapters.get(descriptor.channel);
    if (!adapter?.requestSchema) {
      throw new Error(
        `Workspace command is missing a strict request schema: ${descriptor.channel}`
      );
    }
    if (!adapter.resultSchema) {
      throw new Error(`Workspace command is missing a strict result schema: ${descriptor.channel}`);
    }
    if (
      hasRuntimeAdapterContext &&
      descriptor.reconciliation === 'reconcilable' &&
      !adapter.reconcile
    ) {
      throw new Error(
        `Reconcilable workspace command is missing an adapter: ${descriptor.channel}`
      );
    }
    registry.register({
      command: descriptor.channel,
      version: WORKSPACE_COMMAND_VERSION,
      manifest: descriptor,
      requestSchema: adapter.requestSchema,
      resultSchema: adapter.resultSchema,
      ...(adapter?.prepare ? { prepare: adapter.prepare } : {}),
      ...(adapter?.cancel ? { cancel: adapter.cancel } : {}),
      ...(adapter?.verify ? { verify: adapter.verify } : {}),
      ...(adapter?.reconcile ? { reconcile: adapter.reconcile } : {}),
    });
  }
  return registry;
}

export function digestWorkspaceCommandRequest(
  command: string,
  commandVersion: number,
  args: WorkspaceCommandExecuteFrame['args']
): string {
  return createHash('sha256')
    .update(canonicalJson({ command, commandVersion, args }))
    .digest('hex');
}

function commandError(
  code: WorkspaceMirrorError['code'],
  message: string,
  retryable = false
): WorkspaceMirrorError {
  return { code, message, retryable };
}

function persistedError(operation: WorkspaceOperationRecord): WorkspaceMirrorError {
  const parsed = WorkspaceMirrorErrorSchema.safeParse({
    code: operation.error?.code,
    message: operation.error?.message,
    retryable: false,
  });
  return parsed.success
    ? parsed.data
    : commandError('UNKNOWN', 'Workspace command requires reconciliation');
}

function operationResult(
  operation: WorkspaceOperationRecord,
  requestId?: string,
  volatileResult?: VolatileWorkspaceCommandResult
): WorkspaceCommandResultFrame {
  const envelope = {
    t: 'command.result' as const,
    ...(requestId ? { requestId } : {}),
    operationId: operation.operationId,
    command: operation.intentKind,
    commandVersion: operation.commandVersion,
    requestDigest: operation.requestDigest,
  };
  if (operation.state === 'prepared' || operation.state === 'executing') {
    return { ...envelope, state: operation.state };
  }
  if (operation.state === 'committed') {
    const resultDigest =
      operation.resultDigest ?? digestWorkspaceOperationResult(operation.result ?? null);
    if (operation.resultCompactedAt !== undefined && !volatileResult) {
      return {
        ...envelope,
        state: 'committed',
        resultDigest,
        resultExpired: true,
        error: {
          code: 'RESULT_EXPIRED',
          message: 'Workspace command committed, but its result is no longer available',
          retryable: false,
        },
      };
    }
    const result = volatileResult?.result ?? operation.result;
    return {
      ...envelope,
      state: 'committed',
      ...(result === undefined ? {} : { result: structuredClone(JsonValueSchema.parse(result)) }),
      resultDigest,
      resultExpired: false,
    };
  }
  return {
    ...envelope,
    state: operation.state,
    error: persistedError(operation),
  };
}

function requestFailure(
  frame: WorkspaceCommandExecuteFrame,
  error: WorkspaceMirrorError
): WorkspaceCommandResultFrame {
  return {
    t: 'command.result',
    operationId: frame.operationId,
    command: frame.command,
    commandVersion: frame.commandVersion,
    requestDigest: frame.requestDigest,
    state: 'failed',
    error,
  };
}

function bindingMatches(
  operation: WorkspaceOperationRecord,
  sceneId: string,
  actor: WorkspaceCommandActor,
  frame: WorkspaceCommandExecuteFrame
): boolean {
  return (
    operation.sceneId === sceneId &&
    operation.intentKind === frame.command &&
    operation.clientId === actor.clientId &&
    operation.deviceId === actor.deviceId &&
    operation.commandVersion === frame.commandVersion &&
    operation.requestDigest === frame.requestDigest
  );
}

interface WorkspaceCommandExecutorOptions {
  repository: WorkspaceStateRepository;
  registry: WorkspaceCommandRegistry;
  sceneId: string;
  getRevision: () => number;
  clock?: { now(): number };
  volatileResultCache?: {
    ttlMs?: number;
    maxEntries?: number;
    maxBytes?: number;
  };
}

interface VolatileWorkspaceCommandResult {
  result: JsonValue;
  resultDigest: string;
  expiresAt: number;
  bytes: number;
}

export interface WorkspaceCommandExecution {
  frame: WorkspaceCommandExecuteFrame;
  actor: WorkspaceCommandActor;
  authorize: () => Promise<WorkspaceMirrorError | null>;
  invoke: (command: string, args: WorkspaceCommandInvocationArgs) => Promise<unknown>;
}

export type WorkspaceCommandStatus =
  | { result: WorkspaceCommandResultFrame }
  | { error: WorkspaceMirrorError };

export class WorkspaceCommandExecutor {
  private readonly repository: WorkspaceStateRepository;
  private readonly registry: WorkspaceCommandRegistry;
  private readonly sceneId: string;
  private readonly getRevision: () => number;
  private readonly clock: { now(): number };
  private readonly volatileResultTtlMs: number;
  private readonly volatileResultMaxEntries: number;
  private readonly volatileResultMaxBytes: number;
  private readonly volatileResults = new Map<string, VolatileWorkspaceCommandResult>();
  private volatileResultBytes = 0;

  constructor(options: WorkspaceCommandExecutorOptions) {
    this.repository = options.repository;
    this.registry = options.registry;
    this.sceneId = options.sceneId;
    this.getRevision = options.getRevision;
    this.clock = options.clock ?? { now: () => Date.now() };
    this.volatileResultTtlMs =
      options.volatileResultCache?.ttlMs ?? WORKSPACE_COMMAND_VOLATILE_RESULT_TTL_MS;
    this.volatileResultMaxEntries =
      options.volatileResultCache?.maxEntries ?? WORKSPACE_COMMAND_VOLATILE_RESULT_MAX_ENTRIES;
    this.volatileResultMaxBytes =
      options.volatileResultCache?.maxBytes ?? WORKSPACE_COMMAND_VOLATILE_RESULT_MAX_BYTES;
    if (
      !Number.isSafeInteger(this.volatileResultTtlMs) ||
      this.volatileResultTtlMs <= 0 ||
      !Number.isSafeInteger(this.volatileResultMaxEntries) ||
      this.volatileResultMaxEntries <= 0 ||
      !Number.isSafeInteger(this.volatileResultMaxBytes) ||
      this.volatileResultMaxBytes <= 0
    ) {
      throw new Error('Workspace command volatile result cache limits must be positive integers');
    }
  }

  async execute(execution: WorkspaceCommandExecution): Promise<WorkspaceCommandResultFrame> {
    const { frame, actor } = execution;
    const expectedDigest = digestWorkspaceCommandRequest(
      frame.command,
      frame.commandVersion,
      frame.args
    );
    if (expectedDigest !== frame.requestDigest) {
      return requestFailure(
        frame,
        commandError('CONFLICT', 'Workspace command request digest does not match')
      );
    }

    const existing = await this.repository.loadOperation(frame.operationId);
    if (existing) {
      if (!bindingMatches(existing, this.sceneId, actor, frame)) {
        return requestFailure(
          frame,
          commandError('CONFLICT', 'Workspace command operation binding conflicts')
        );
      }
      return this.operationResult(existing);
    }

    const descriptor = this.registry.lookup(frame.command);
    if (!descriptor || descriptor.version !== frame.commandVersion) {
      return requestFailure(
        frame,
        commandError('UPGRADE_REQUIRED', 'Workspace command version is not supported')
      );
    }

    const parsedArgs = descriptor.requestSchema.safeParse(decodeWorkspaceCommandArgs(frame.args));
    if (!parsedArgs.success) {
      return requestFailure(frame, commandError('INVALID_FRAME', 'Workspace command is invalid'));
    }

    const authorization = await execution.authorize();
    if (authorization) return requestFailure(frame, authorization);

    let reconcileMetadata: WorkspaceOperationRecord['reconcileMetadata'];
    try {
      const preparedMetadata = await descriptor.prepare?.(parsedArgs.data);
      reconcileMetadata =
        preparedMetadata === undefined ? undefined : JsonValueSchema.parse(preparedMetadata);
    } catch {
      return requestFailure(
        frame,
        commandError('CONFLICT', 'Workspace command preconditions are not satisfied')
      );
    }

    const now = this.clock.now();
    const prepared: WorkspaceOperationRecord = {
      operationId: frame.operationId,
      intentKind: frame.command,
      sceneId: this.sceneId,
      clientId: actor.clientId,
      deviceId: actor.deviceId,
      commandVersion: frame.commandVersion,
      requestDigest: frame.requestDigest,
      ...(reconcileMetadata === undefined ? {} : { reconcileMetadata }),
      state: 'prepared',
      baseRevision: this.getRevision(),
      createdAt: now,
      updatedAt: now,
    };

    try {
      await this.repository.saveOperation(prepared);
    } catch {
      await descriptor.cancel?.(prepared).catch(() => undefined);
      const raced = await this.repository.loadOperation(frame.operationId);
      if (raced && bindingMatches(raced, this.sceneId, actor, frame)) {
        return this.operationResult(raced);
      }
      return requestFailure(
        frame,
        commandError('CONFLICT', 'Workspace command operation binding conflicts')
      );
    }

    const finalAuthorization = await execution.authorize();
    if (finalAuthorization) {
      const cancelled: WorkspaceOperationRecord = {
        ...prepared,
        state: 'cancelled',
        error: { code: finalAuthorization.code, message: finalAuthorization.message },
        updatedAt: this.clock.now(),
      };
      const cancelledLedger = await this.repository.compareAndSwapOperation(
        frame.operationId,
        'prepared',
        cancelled
      );
      if (cancelledLedger) {
        await descriptor.cancel?.(cancelled).catch(() => undefined);
        return this.operationResult(cancelled);
      }
      const raced = await this.repository.loadOperation(frame.operationId);
      return raced
        ? this.operationResult(raced)
        : requestFailure(
            frame,
            commandError('INTERNAL', 'Workspace command ledger is unavailable')
          );
    }

    const executing: WorkspaceOperationRecord = {
      ...prepared,
      state: 'executing',
      updatedAt: this.clock.now(),
    };
    const started = await this.repository.compareAndSwapOperation(
      frame.operationId,
      'prepared',
      executing
    );
    if (!started) {
      const raced = await this.repository.loadOperation(frame.operationId);
      return raced
        ? this.operationResult(raced)
        : requestFailure(
            frame,
            commandError('INTERNAL', 'Workspace command ledger is unavailable')
          );
    }

    let result: unknown;
    try {
      result = descriptor.resultSchema.parse(
        await execution.invoke(frame.command, parsedArgs.data)
      );
    } catch {
      return this.finishExecutionFailure(frame, executing, descriptor);
    }

    if (descriptor.verify) {
      const verification = await descriptor.verify(executing, result).catch(() => null);
      if (!verification) return this.markUnknown(frame, executing);
      if (verification.state === 'failed') {
        return this.finishVerifiedFailure(frame, executing, verification.error);
      }
    }

    const parsedResult = result === undefined ? undefined : JsonValueSchema.parse(result);
    const completedAt = this.clock.now();
    const persistResult = descriptor.manifest.redaction.persistedResult === 'redacted-metadata';
    const durableResult =
      persistResult && parsedResult !== undefined
        ? JsonValueSchema.parse(redactCommandMetadata(parsedResult))
        : undefined;
    const committed: WorkspaceOperationRecord = {
      ...executing,
      state: 'committed',
      ...(durableResult === undefined ? {} : { result: durableResult }),
      resultDigest: digestWorkspaceOperationResult(parsedResult ?? null),
      ...(!persistResult && parsedResult !== undefined ? { resultCompactedAt: completedAt } : {}),
      updatedAt: completedAt,
    };

    try {
      const committedLedger = await this.repository.compareAndSwapOperation(
        frame.operationId,
        'executing',
        committed
      );
      if (!committedLedger) {
        const raced = await this.repository.loadOperation(frame.operationId);
        return raced
          ? this.operationResult(raced)
          : requestFailure(
              frame,
              commandError('UNKNOWN', 'Workspace command requires reconciliation')
            );
      }
    } catch {
      return this.markUnknown(frame, executing);
    }

    if (!persistResult && parsedResult !== undefined) {
      this.rememberVolatileResult(frame.operationId, parsedResult, committed.resultDigest!);
    }

    return {
      t: 'command.result',
      operationId: frame.operationId,
      command: frame.command,
      commandVersion: frame.commandVersion,
      requestDigest: frame.requestDigest,
      state: 'committed',
      ...(parsedResult === undefined ? {} : { result: parsedResult }),
      resultDigest: committed.resultDigest!,
      resultExpired: false,
    };
  }

  async status(
    operationId: string,
    actor: WorkspaceCommandActor,
    requestId?: string
  ): Promise<WorkspaceCommandStatus> {
    const operation = await this.repository.loadOperation(operationId);
    if (!operation || operation.sceneId !== this.sceneId) {
      return { error: commandError('UNKNOWN_OPERATION', 'Workspace command operation is unknown') };
    }
    if (operation.clientId !== actor.clientId || operation.deviceId !== actor.deviceId) {
      return { error: commandError('FORBIDDEN', 'Workspace command belongs to another client') };
    }
    return { result: this.operationResult(operation, requestId) };
  }

  async recover(): Promise<void> {
    const operations = await this.repository.listUnfinishedOperations(this.sceneId);
    for (const operation of operations) {
      const descriptor = this.registry.lookup(operation.intentKind);
      if (operation.state === 'prepared') {
        const cancelled = await this.repository.compareAndSwapOperation(
          operation.operationId,
          'prepared',
          {
            ...operation,
            state: 'cancelled',
            error: { code: 'NOT_EXECUTED', message: 'Command did not begin before host restart' },
            updatedAt: this.clock.now(),
          }
        );
        if (cancelled) await descriptor?.cancel?.(operation).catch(() => undefined);
        continue;
      }

      if (descriptor?.reconcile) {
        const reconciliation = await descriptor.reconcile(operation).catch(() => null);
        if (reconciliation) {
          try {
            await this.storeReconciliation(operation, operation.state, descriptor, reconciliation);
            continue;
          } catch {
            // Keep or enter UNKNOWN below when the reconciliation ledger write fails.
          }
        }
      }

      if (operation.state === 'executing') {
        await this.repository.compareAndSwapOperation(operation.operationId, 'executing', {
          ...operation,
          state: 'needs_reconcile',
          error: { code: 'UNKNOWN', message: 'Command outcome is unknown after host restart' },
          updatedAt: this.clock.now(),
        });
      }
    }
  }

  compactExpiredResults(): Promise<number> {
    return this.repository.compactOperationResultsBefore(
      this.clock.now() - WORKSPACE_COMMAND_RESULT_RETENTION_MS,
      this.clock.now()
    );
  }

  private async finishExecutionFailure(
    frame: WorkspaceCommandExecuteFrame,
    executing: WorkspaceOperationRecord,
    descriptor: WorkspaceCommandDescriptor
  ): Promise<WorkspaceCommandResultFrame> {
    if (descriptor.reconcile) {
      const reconciliation = await descriptor.reconcile(executing).catch(() => null);
      if (reconciliation) {
        try {
          const stored = await this.storeReconciliation(
            executing,
            'executing',
            descriptor,
            reconciliation
          );
          if (stored) return this.operationResult(stored);
        } catch {
          return this.markUnknown(frame, executing);
        }
      }
    }
    if (descriptor.manifest.reconciliation !== 'idempotent') {
      return this.markUnknown(frame, executing);
    }
    const failed: WorkspaceOperationRecord = {
      ...executing,
      state: 'failed',
      error: { code: 'INTERNAL', message: 'Workspace command failed' },
      updatedAt: this.clock.now(),
    };
    try {
      const failedLedger = await this.repository.compareAndSwapOperation(
        frame.operationId,
        'executing',
        failed
      );
      if (!failedLedger) {
        const raced = await this.repository.loadOperation(frame.operationId);
        return raced
          ? this.operationResult(raced)
          : requestFailure(
              frame,
              commandError('UNKNOWN', 'Workspace command requires reconciliation')
            );
      }
    } catch {
      return this.markUnknown(frame, executing);
    }
    return this.operationResult(failed);
  }

  private async storeReconciliation(
    operation: WorkspaceOperationRecord,
    expectedState: WorkspaceOperationRecord['state'],
    descriptor: WorkspaceCommandDescriptor,
    reconciliation: WorkspaceCommandReconcileResult
  ): Promise<WorkspaceOperationRecord | null> {
    const next = structuredClone(operation);
    delete next.result;
    delete next.resultDigest;
    delete next.resultCompactedAt;
    delete next.error;
    next.state = reconciliation.state;
    next.updatedAt = this.clock.now();
    let volatileResult: JsonValue | undefined;
    if (reconciliation.state === 'committed') {
      const result =
        reconciliation.result === undefined
          ? undefined
          : JsonValueSchema.parse(reconciliation.result);
      next.resultDigest = digestWorkspaceOperationResult(result ?? null);
      if (result !== undefined) {
        if (descriptor.manifest.redaction.persistedResult === 'redacted-metadata') {
          next.result = JsonValueSchema.parse(redactCommandMetadata(result));
        } else {
          next.resultCompactedAt = next.updatedAt;
          volatileResult = result;
        }
      }
    } else {
      next.error = {
        code: reconciliation.error?.code ?? 'UNKNOWN',
        message: reconciliation.error?.message ?? 'Workspace command reconciliation failed',
      };
    }
    const stored = await this.repository.compareAndSwapOperation(
      operation.operationId,
      expectedState,
      next
    );
    if (stored) {
      if (volatileResult !== undefined) {
        this.rememberVolatileResult(operation.operationId, volatileResult, next.resultDigest!);
      }
      return next;
    }
    return this.repository.loadOperation(operation.operationId);
  }

  private async finishVerifiedFailure(
    frame: WorkspaceCommandExecuteFrame,
    executing: WorkspaceOperationRecord,
    error?: WorkspaceMirrorError
  ): Promise<WorkspaceCommandResultFrame> {
    const failed: WorkspaceOperationRecord = {
      ...executing,
      state: 'failed',
      error: {
        code: error?.code ?? 'CONFLICT',
        message: error?.message ?? 'Workspace command postcondition was not satisfied',
      },
      updatedAt: this.clock.now(),
    };
    try {
      const stored = await this.repository.compareAndSwapOperation(
        frame.operationId,
        'executing',
        failed
      );
      if (!stored) {
        const raced = await this.repository.loadOperation(frame.operationId);
        return raced
          ? this.operationResult(raced)
          : requestFailure(
              frame,
              commandError('UNKNOWN', 'Workspace command requires reconciliation')
            );
      }
    } catch {
      return this.markUnknown(frame, executing);
    }
    const result = this.operationResult(failed);
    return error && result.state === 'failed' ? { ...result, error } : result;
  }

  private async markUnknown(
    frame: WorkspaceCommandExecuteFrame,
    executing: WorkspaceOperationRecord
  ): Promise<WorkspaceCommandResultFrame> {
    const unknown: WorkspaceOperationRecord = {
      ...executing,
      state: 'needs_reconcile',
      error: { code: 'UNKNOWN', message: 'Workspace command requires reconciliation' },
      updatedAt: this.clock.now(),
    };
    try {
      await this.repository.compareAndSwapOperation(frame.operationId, 'executing', unknown);
    } catch {
      // The response remains UNKNOWN even when the ledger is temporarily unavailable.
    }
    return operationResult(unknown);
  }

  private operationResult(
    operation: WorkspaceOperationRecord,
    requestId?: string
  ): WorkspaceCommandResultFrame {
    return operationResult(operation, requestId, this.loadVolatileResult(operation));
  }

  private loadVolatileResult(
    operation: WorkspaceOperationRecord
  ): VolatileWorkspaceCommandResult | undefined {
    this.pruneVolatileResults(this.clock.now());
    const cached = this.volatileResults.get(operation.operationId);
    if (!cached) return undefined;
    if (operation.resultDigest !== cached.resultDigest) {
      this.deleteVolatileResult(operation.operationId, cached);
      return undefined;
    }
    this.volatileResults.delete(operation.operationId);
    this.volatileResults.set(operation.operationId, cached);
    return cached;
  }

  private rememberVolatileResult(
    operationId: string,
    result: JsonValue,
    resultDigest: string
  ): void {
    const now = this.clock.now();
    this.pruneVolatileResults(now);
    const cloned = structuredClone(result);
    const bytes = new TextEncoder().encode(canonicalJson(cloned)).byteLength;
    const existing = this.volatileResults.get(operationId);
    if (existing) this.deleteVolatileResult(operationId, existing);
    if (bytes > this.volatileResultMaxBytes) return;
    const cached: VolatileWorkspaceCommandResult = {
      result: cloned,
      resultDigest,
      expiresAt: now + this.volatileResultTtlMs,
      bytes,
    };
    this.volatileResults.set(operationId, cached);
    this.volatileResultBytes += bytes;
    while (
      this.volatileResults.size > this.volatileResultMaxEntries ||
      this.volatileResultBytes > this.volatileResultMaxBytes
    ) {
      const oldest = this.volatileResults.entries().next().value as
        | [string, VolatileWorkspaceCommandResult]
        | undefined;
      if (!oldest) break;
      this.deleteVolatileResult(oldest[0], oldest[1]);
    }
  }

  private pruneVolatileResults(now: number): void {
    for (const [operationId, cached] of this.volatileResults) {
      if (cached.expiresAt > now) continue;
      this.deleteVolatileResult(operationId, cached);
    }
  }

  private deleteVolatileResult(operationId: string, cached: VolatileWorkspaceCommandResult): void {
    if (!this.volatileResults.delete(operationId)) return;
    this.volatileResultBytes -= cached.bytes;
  }
}
