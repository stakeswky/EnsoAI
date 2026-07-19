import { createHash, randomUUID } from 'node:crypto';
import { basename, posix, win32 } from 'node:path';
import {
  type ControllerLease,
  ControllerLeaseSchema,
  canonicalizeWorkspaceScene,
  canonicalJson,
  createEmptyWorkspaceSceneSnapshot,
  digestWorkspaceScene,
  type JsonValue,
  type StateIntentResultFrame,
  type StateReplayFrame,
  type StateResyncRequiredFrame,
  WORKSPACE_MIRROR_SCHEMA_VERSION,
  type WorkspaceCoordFrame,
  type WorkspaceMirrorError,
  type WorkspaceMirrorErrorCode,
  type WorkspaceResourceInvalidation,
  type WorkspaceResumeCursor,
  type WorkspaceSceneEvent,
  WorkspaceSceneEventSchema,
  type WorkspaceSceneIntent,
  WorkspaceSceneIntentSchema,
  type WorkspaceSceneMutation,
  WorkspaceSceneMutationSchema,
  type WorkspaceSceneSnapshot,
  WorkspaceSceneSnapshotSchema,
} from '@shared/types/workspaceMirror';
import {
  normalizeWorkspaceEntityPath,
  type WorkspaceHostPathCasePolicy,
  type WorkspaceHostPathPlatform,
  workspaceEntityPathCollisionKey,
  workspaceEntityPathLookupKey,
} from './WorkspaceEntityRegistry';
import {
  InMemoryWorkspaceStateRepository,
  type WorkspaceOperationRecord,
  type WorkspacePersistedEvent,
  type WorkspaceStateRepository,
} from './WorkspaceStateRepository';

const DEFAULT_LEASE_DURATION_MS = 30_000;
const DEFAULT_DISCONNECT_GRACE_MS = 5_000;
const DEFAULT_MINIMUM_RETAINED_EVENTS = 10_000;
const DEFAULT_EVENT_RETENTION_MS = 30 * 60 * 1_000;
const DEFAULT_EVENT_RETENTION_BYTES = 64 * 1024 * 1024;

export interface WorkspaceClock {
  now(): number;
}

export type WorkspaceIdKind = 'hostEpoch' | 'lease';
export type WorkspaceIdGenerator = (kind: WorkspaceIdKind) => string;

export interface WorkspaceIntentActor {
  clientId: string;
  deviceId: string;
  leaseId?: string;
}

export type WorkspaceSceneEntityUpsert =
  | {
      kind: 'repository';
      entityId: string;
      path: string;
    }
  | {
      kind: 'worktree';
      entityId: string;
      repositoryId: string;
      path: string;
      branch: string | null;
    };

export interface WorkspaceIntentEffectContext {
  intent: WorkspaceSceneIntent;
  actor: WorkspaceIntentActor;
  previousSnapshot: WorkspaceSceneSnapshot;
  nextSnapshot: WorkspaceSceneSnapshot;
}

export interface WorkspaceIntentEffectExecutor {
  execute(context: WorkspaceIntentEffectContext): Promise<JsonValue | undefined>;
}

export interface WorkspaceMirrorServiceOptions {
  hostId: string;
  sceneId: string;
  hostEpoch?: string;
  repository?: WorkspaceStateRepository;
  clock?: WorkspaceClock;
  idGenerator?: WorkspaceIdGenerator;
  initialSnapshot?: WorkspaceSceneSnapshot;
  effectExecutor?: WorkspaceIntentEffectExecutor;
  leaseDurationMs?: number;
  disconnectGraceMs?: number;
  retention?: {
    minimumEvents?: number;
    maxAgeMs?: number;
    maxBytes?: number;
  };
  canRebase?: (intent: WorkspaceSceneIntent) => boolean;
  bootstrapReady?: boolean;
}

export type WorkspaceIntentDispatchResult = StateIntentResultFrame;
type WorkspaceIntentRejectedResult = Extract<WorkspaceIntentDispatchResult, { accepted: false }>;

export interface WorkspaceReplayUpToDate {
  t: 'state.upToDate';
  hostEpoch: string;
  sceneId: string;
  revision: number;
}

export type WorkspaceReplayResult =
  | StateReplayFrame
  | StateResyncRequiredFrame
  | WorkspaceReplayUpToDate;

export type WorkspaceControlEvent = Extract<
  WorkspaceCoordFrame,
  { t: 'control.granted' | 'control.released' | 'control.revoked' }
>;

export type WorkspaceControlResult =
  | { granted: true; lease: ControllerLease }
  | { granted: false; error: WorkspaceMirrorError };

export type WorkspaceEventApplication =
  | { status: 'applied'; snapshot: WorkspaceSceneSnapshot }
  | { status: 'duplicate'; snapshot: WorkspaceSceneSnapshot }
  | { status: 'resyncRequired'; error: WorkspaceMirrorError };

export interface WorkspaceStateValidationResult {
  valid: boolean;
  errors: string[];
}

interface RetainedWorkspaceEvent extends WorkspacePersistedEvent {
  bytes: number;
}

class WorkspaceStateConflictError extends Error {}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function hostPathSegments(
  path: string,
  platform: WorkspaceHostPathPlatform
): {
  root: string;
  segments: string[];
} {
  const pathApi = platform === 'win32' ? win32 : posix;
  const root = pathApi.parse(path).root;
  return {
    root,
    segments: path
      .slice(root.length)
      .split(pathApi.sep)
      .filter((segment) => segment.length > 0),
  };
}

function hostPathPartMatches(
  left: string,
  right: string,
  casePolicy: WorkspaceHostPathCasePolicy
): boolean {
  return (
    workspaceEntityPathLookupKey(left, casePolicy) ===
    workspaceEntityPathLookupKey(right, casePolicy)
  );
}

function rewriteHostPathRoot(
  candidatePath: string,
  oldRootPath: string,
  newRootPath: string,
  platform: WorkspaceHostPathPlatform,
  casePolicy: WorkspaceHostPathCasePolicy
): string {
  const pathApi = platform === 'win32' ? win32 : posix;
  if (!pathApi.isAbsolute(candidatePath)) return candidatePath;
  const candidate = normalizeWorkspaceEntityPath(candidatePath, platform);
  const oldRoot = normalizeWorkspaceEntityPath(oldRootPath, platform);
  const newRoot = normalizeWorkspaceEntityPath(newRootPath, platform);
  const candidateParts = hostPathSegments(candidate.path, platform);
  const oldRootParts = hostPathSegments(oldRoot.path, platform);
  if (
    !hostPathPartMatches(candidateParts.root, oldRootParts.root, casePolicy) ||
    candidateParts.segments.length < oldRootParts.segments.length ||
    oldRootParts.segments.some(
      (segment, index) =>
        !hostPathPartMatches(segment, candidateParts.segments[index] ?? '', casePolicy)
    )
  ) {
    return candidatePath;
  }
  const suffix = candidateParts.segments.slice(oldRootParts.segments.length);
  return normalizeWorkspaceEntityPath(pathApi.join(newRoot.path, ...suffix), platform).path;
}

function rewriteWorkspaceScenePaths(
  snapshot: WorkspaceSceneSnapshot,
  oldRootPath: string,
  newRootPath: string,
  platform: WorkspaceHostPathPlatform,
  casePolicy: WorkspaceHostPathCasePolicy
): void {
  const rewrite = (path: string): string =>
    rewriteHostPathRoot(path, oldRootPath, newRootPath, platform, casePolicy);

  for (const editor of Object.values(snapshot.editors)) {
    for (const tab of editor.tabs) tab.path = rewrite(tab.path);
    if (editor.activeFile !== null) editor.activeFile = rewrite(editor.activeFile);
    const nextBuffers: typeof editor.buffers = {};
    const bufferOwners = new Map<string, string>();
    for (const [bufferKey, buffer] of Object.entries(editor.buffers)) {
      const nextKey = rewrite(bufferKey);
      const collisionKey = workspaceEntityPathCollisionKey(nextKey, casePolicy);
      const owner = bufferOwners.get(collisionKey);
      if (owner !== undefined && owner !== bufferKey) {
        throw new WorkspaceStateConflictError(
          `Workspace editor buffers collide after path adoption: ${owner} and ${bufferKey}`
        );
      }
      bufferOwners.set(collisionKey, bufferKey);
      nextBuffers[nextKey] = { ...buffer, path: rewrite(buffer.path) };
    }
    editor.buffers = nextBuffers;
  }
  for (const terminal of Object.values(snapshot.terminals.sessions)) {
    terminal.cwd = rewrite(terminal.cwd);
  }
  for (const selections of [
    snapshot.selections.selectedFileByWorktree,
    snapshot.selections.selectedDiffByWorktree,
  ]) {
    for (const [worktreeId, path] of Object.entries(selections)) {
      if (path !== null) selections[worktreeId] = rewrite(path);
    }
  }
}

function recoverRuntimeStateAfterHostRestart(
  snapshot: WorkspaceSceneSnapshot
): WorkspaceSceneSnapshot {
  const result = clone(snapshot);
  for (const terminal of Object.values(result.terminals.sessions)) {
    if (terminal.processState === 'starting' || terminal.processState === 'running') {
      terminal.processState = 'terminated';
      terminal.exitCode = null;
    }
  }
  return result;
}

function defaultIdGenerator(): string {
  return randomUUID();
}

function eventBytes(event: WorkspaceSceneEvent): number {
  return Buffer.byteLength(JSON.stringify(event), 'utf8');
}

function digestWorkspaceRequest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function createError(
  code: WorkspaceMirrorErrorCode,
  message: string,
  retryable: boolean,
  details?: WorkspaceMirrorError['details']
): WorkspaceMirrorError {
  return details ? { code, message, retryable, details } : { code, message, retryable };
}

function rejectedResult(
  operationId: string,
  currentRevision: number,
  error: WorkspaceMirrorError
): WorkspaceIntentRejectedResult {
  return {
    t: 'state.intentResult',
    operationId,
    accepted: false,
    currentRevision,
    error,
  };
}

function validateRecordIdentity(
  errors: string[],
  domain: string,
  records: Record<string, { id: string }>
): void {
  for (const [key, value] of Object.entries(records)) {
    if (key !== value.id) {
      errors.push(`${domain} key ${key} does not match entity id ${value.id}`);
    }
  }
}

function validateReference(
  errors: string[],
  message: string,
  id: string | null | undefined,
  records: Record<string, unknown>
): void {
  if (id !== null && id !== undefined && !(id in records)) {
    errors.push(`${message}: ${id}`);
  }
}

export function validateWorkspaceScene(
  candidate: WorkspaceSceneSnapshot
): WorkspaceStateValidationResult {
  const parsed = WorkspaceSceneSnapshotSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      valid: false,
      errors: parsed.error.issues.map(
        (issue) => `${issue.path.join('.') || 'snapshot'}: ${issue.message}`
      ),
    };
  }

  const scene = parsed.data;
  const errors: string[] = [];
  const { groups, repositories, worktrees } = scene.catalog;

  validateRecordIdentity(errors, 'catalog.groups', groups);
  validateRecordIdentity(errors, 'catalog.repositories', repositories);
  validateRecordIdentity(errors, 'catalog.worktrees', worktrees);

  for (const repository of Object.values(repositories)) {
    validateReference(
      errors,
      `Repository ${repository.id} references unknown group`,
      repository.groupId,
      groups
    );
  }
  for (const worktree of Object.values(worktrees)) {
    validateReference(
      errors,
      `Worktree ${worktree.id} references unknown repository`,
      worktree.repositoryId,
      repositories
    );
  }

  validateReference(
    errors,
    'Navigation references unknown repository',
    scene.navigation.selectedRepositoryId,
    repositories
  );
  validateReference(
    errors,
    'Navigation references unknown group',
    scene.navigation.activeGroupId,
    groups
  );
  validateReference(
    errors,
    'Navigation references unknown worktree',
    scene.navigation.activeWorktreeId,
    worktrees
  );

  for (const [worktreeId, panel] of Object.entries(scene.navigation.activePanelByWorktree)) {
    validateReference(
      errors,
      `Active panel ${panel} references unknown worktree`,
      worktreeId,
      worktrees
    );
  }
  for (const [worktreeId, panelOrder] of Object.entries(scene.navigation.panelOrderByWorktree)) {
    validateReference(errors, 'Panel order references unknown worktree', worktreeId, worktrees);
    if (new Set(panelOrder).size !== panelOrder.length) {
      errors.push(`Panel order for ${worktreeId} contains duplicate panels`);
    }
  }

  for (const [worktreeId, editor] of Object.entries(scene.editors)) {
    validateReference(errors, 'Editor references unknown worktree', worktreeId, worktrees);
    const tabIds = new Set<string>();
    const tabPaths = new Set<string>();
    for (const tab of editor.tabs) {
      if (tabIds.has(tab.id))
        errors.push(`Editor ${worktreeId} contains duplicate tab id ${tab.id}`);
      if (tabPaths.has(tab.path)) {
        errors.push(`Editor ${worktreeId} contains duplicate tab path ${tab.path}`);
      }
      tabIds.add(tab.id);
      tabPaths.add(tab.path);
    }
    if (editor.activeFile !== null && !tabPaths.has(editor.activeFile)) {
      errors.push(`Editor ${worktreeId} active file is not an open tab: ${editor.activeFile}`);
    }
    for (const [path, buffer] of Object.entries(editor.buffers)) {
      if (path !== buffer.path) {
        errors.push(`Editor ${worktreeId} buffer key does not match path: ${path}`);
      }
      if (!tabPaths.has(path)) {
        errors.push(`Editor ${worktreeId} buffer has no open tab: ${path}`);
      }
    }
  }

  validateRecordIdentity(errors, 'agents.sessions', scene.agents.sessions);
  validateRecordIdentity(errors, 'agents.groups', scene.agents.groups);
  for (const session of Object.values(scene.agents.sessions)) {
    validateReference(
      errors,
      `Agent session ${session.id} references unknown repository`,
      session.repositoryId,
      repositories
    );
    validateReference(
      errors,
      `Agent session ${session.id} references unknown worktree`,
      session.worktreeId,
      worktrees
    );
    validateReference(
      errors,
      `Agent session ${session.id} references unknown terminal`,
      session.terminalSessionId,
      scene.terminals.sessions
    );
  }
  for (const group of Object.values(scene.agents.groups)) {
    validateReference(
      errors,
      `Agent group ${group.id} references unknown worktree`,
      group.worktreeId,
      worktrees
    );
    for (const sessionId of group.sessionIds) {
      validateReference(
        errors,
        `Agent group ${group.id} references unknown session`,
        sessionId,
        scene.agents.sessions
      );
    }
    if (group.activeSessionId !== null && !group.sessionIds.includes(group.activeSessionId)) {
      errors.push(`Agent group ${group.id} active session is not in the group`);
    }
  }
  for (const [worktreeId, sessionId] of Object.entries(scene.agents.activeSessionByWorktree)) {
    validateReference(
      errors,
      'Agent active-session map references unknown worktree',
      worktreeId,
      worktrees
    );
    validateReference(
      errors,
      'Agent active-session map references unknown session',
      sessionId,
      scene.agents.sessions
    );
  }

  validateRecordIdentity(errors, 'terminals.sessions', scene.terminals.sessions);
  validateRecordIdentity(errors, 'terminals.groups', scene.terminals.groups);
  for (const session of Object.values(scene.terminals.sessions)) {
    validateReference(
      errors,
      `Terminal session ${session.id} references unknown repository`,
      session.repositoryId,
      repositories
    );
    validateReference(
      errors,
      `Terminal session ${session.id} references unknown worktree`,
      session.worktreeId,
      worktrees
    );
    validateReference(
      errors,
      `Terminal session ${session.id} references unknown group`,
      session.groupId,
      scene.terminals.groups
    );
  }
  for (const group of Object.values(scene.terminals.groups)) {
    validateReference(
      errors,
      `Terminal group ${group.id} references unknown worktree`,
      group.worktreeId,
      worktrees
    );
    for (const sessionId of group.sessionIds) {
      validateReference(
        errors,
        `Terminal group ${group.id} references unknown session`,
        sessionId,
        scene.terminals.sessions
      );
    }
    if (group.activeSessionId !== null && !group.sessionIds.includes(group.activeSessionId)) {
      errors.push(`Terminal group ${group.id} active session is not in the group`);
    }
  }
  for (const [worktreeId, sessionId] of Object.entries(scene.terminals.activeSessionByWorktree)) {
    validateReference(
      errors,
      'Terminal active-session map references unknown worktree',
      worktreeId,
      worktrees
    );
    validateReference(
      errors,
      'Terminal active-session map references unknown session',
      sessionId,
      scene.terminals.sessions
    );
  }
  for (const [worktreeId, sessionId] of Object.entries(scene.terminals.quickSessionByWorktree)) {
    validateReference(
      errors,
      'Quick-terminal map references unknown worktree',
      worktreeId,
      worktrees
    );
    validateReference(
      errors,
      'Quick-terminal map references unknown session',
      sessionId,
      scene.terminals.sessions
    );
  }

  for (const [repositoryId, board] of Object.entries(scene.todos.boardsByRepository)) {
    validateReference(
      errors,
      'Todo board references unknown repository',
      repositoryId,
      repositories
    );
    validateRecordIdentity(errors, `todos.${repositoryId}.tasks`, board.tasks);
    for (const task of Object.values(board.tasks)) {
      validateReference(
        errors,
        `Todo task ${task.id} references unknown agent session`,
        task.sessionId,
        scene.agents.sessions
      );
    }
    for (const taskId of board.autoExecution.queue) {
      validateReference(errors, 'Todo queue references unknown task', taskId, board.tasks);
    }
    validateReference(
      errors,
      'Todo auto-execution references unknown current task',
      board.autoExecution.currentTaskId,
      board.tasks
    );
    validateReference(
      errors,
      'Todo auto-execution references unknown current session',
      board.autoExecution.currentSessionId,
      scene.agents.sessions
    );
  }

  for (const worktreeId of Object.keys(scene.selections.selectedFileByWorktree)) {
    validateReference(errors, 'File selection references unknown worktree', worktreeId, worktrees);
  }
  for (const worktreeId of Object.keys(scene.selections.selectedDiffByWorktree)) {
    validateReference(errors, 'Diff selection references unknown worktree', worktreeId, worktrees);
  }
  for (const [repositoryId, taskId] of Object.entries(scene.selections.selectedTaskByRepository)) {
    validateReference(
      errors,
      'Task selection references unknown repository',
      repositoryId,
      repositories
    );
    if (
      taskId !== null &&
      !(taskId in (scene.todos.boardsByRepository[repositoryId]?.tasks ?? {}))
    ) {
      errors.push(`Task selection references unknown task: ${taskId}`);
    }
  }
  for (const [resourceKey, invalidation] of Object.entries(scene.resources.invalidations)) {
    if (resourceKey !== invalidation.resourceKey) {
      errors.push(`Resource invalidation key does not match payload: ${resourceKey}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

function requireValidScene(scene: WorkspaceSceneSnapshot): WorkspaceSceneSnapshot {
  const validation = validateWorkspaceScene(scene);
  if (!validation.valid) {
    throw new WorkspaceStateConflictError(validation.errors.join('; '));
  }
  return WorkspaceSceneSnapshotSchema.parse(scene);
}

export function reduceWorkspaceSceneMutation(
  snapshot: WorkspaceSceneSnapshot,
  mutation: WorkspaceSceneMutation
): WorkspaceSceneSnapshot {
  const next = clone(snapshot);

  switch (mutation.kind) {
    case 'scene.replace':
      next.catalog = clone(mutation.payload.catalog);
      next.navigation = clone(mutation.payload.navigation);
      next.editors = clone(mutation.payload.editors);
      next.agents = clone(mutation.payload.agents);
      next.terminals = clone(mutation.payload.terminals);
      next.todos = clone(mutation.payload.todos);
      next.selections = clone(mutation.payload.selections);
      break;
    case 'catalog.replace':
      next.catalog = clone(mutation.payload.catalog);
      break;
    case 'navigation.replace':
      next.navigation = clone(mutation.payload.navigation);
      break;
    case 'editor.replace':
      next.editors[mutation.payload.worktreeId] = clone(mutation.payload.editor);
      break;
    case 'editor.remove':
      delete next.editors[mutation.payload.worktreeId];
      break;
    case 'editor.buffer.update': {
      const editor = next.editors[mutation.payload.worktreeId];
      if (!editor) {
        throw new WorkspaceStateConflictError(
          `Editor does not exist for worktree ${mutation.payload.worktreeId}`
        );
      }
      const current = editor.buffers[mutation.payload.path];
      const currentVersion = current?.version ?? 0;
      if (currentVersion !== mutation.payload.baseVersion) {
        throw new WorkspaceStateConflictError(
          `Editor buffer version mismatch: expected ${currentVersion}, received ${mutation.payload.baseVersion}`
        );
      }
      if (!editor.tabs.some((tab) => tab.path === mutation.payload.path)) {
        throw new WorkspaceStateConflictError(
          `Editor buffer is not an open tab: ${mutation.payload.path}`
        );
      }
      editor.buffers[mutation.payload.path] = {
        path: mutation.payload.path,
        isDirty: mutation.payload.isDirty,
        version: mutation.payload.nextVersion,
        hasExternalChange: mutation.payload.hasExternalChange,
        ...(mutation.payload.content === undefined ? {} : { content: mutation.payload.content }),
        ...(mutation.payload.externalContent === undefined
          ? {}
          : { externalContent: mutation.payload.externalContent }),
      };
      if (mutation.payload.encoding !== undefined) {
        editor.tabs = editor.tabs.map((tab) =>
          tab.path === mutation.payload.path
            ? { ...tab, encoding: mutation.payload.encoding ?? tab.encoding }
            : tab
        );
      }
      break;
    }
    case 'agents.replace':
      next.agents = clone(mutation.payload.agents);
      break;
    case 'terminals.replace':
      next.terminals = clone(mutation.payload.terminals);
      break;
    case 'todos.replace':
      next.todos = clone(mutation.payload.todos);
      break;
    case 'selections.replace':
      next.selections = clone(mutation.payload.selections);
      break;
    case 'resources.invalidate': {
      const current = next.resources.invalidations[mutation.payload.resourceKey];
      if (current && mutation.payload.generation <= current.generation) {
        throw new WorkspaceStateConflictError(
          `Resource generation must advance beyond ${current.generation}`
        );
      }
      next.resources.invalidations[mutation.payload.resourceKey] = clone(mutation.payload);
      break;
    }
  }

  return requireValidScene(next);
}

export function applyWorkspaceSceneEvent(
  snapshot: WorkspaceSceneSnapshot,
  event: WorkspaceSceneEvent
): WorkspaceEventApplication {
  const parsedEvent = WorkspaceSceneEventSchema.safeParse(event);
  if (!parsedEvent.success) {
    return {
      status: 'resyncRequired',
      error: createError('INVALID_FRAME', 'Workspace event is invalid', false),
    };
  }
  if (event.hostEpoch !== snapshot.hostEpoch) {
    return {
      status: 'resyncRequired',
      error: createError('STALE_EPOCH', 'Workspace host epoch changed', false, {
        expectedHostEpoch: snapshot.hostEpoch,
        actualHostEpoch: event.hostEpoch,
        resyncReason: 'epoch-changed',
      }),
    };
  }
  if (event.sceneId !== snapshot.sceneId) {
    return {
      status: 'resyncRequired',
      error: createError('RESYNC_REQUIRED', 'Workspace scene changed', false, {
        resyncReason: 'revision-gap',
      }),
    };
  }
  if (event.revision <= snapshot.revision) {
    return { status: 'duplicate', snapshot: clone(snapshot) };
  }
  if (event.revision !== snapshot.revision + 1) {
    return {
      status: 'resyncRequired',
      error: createError('REVISION_GAP', 'Workspace event revision is not contiguous', true, {
        expectedRevision: snapshot.revision + 1,
        actualRevision: event.revision,
        resyncReason: 'revision-gap',
      }),
    };
  }

  try {
    const next = reduceWorkspaceSceneMutation(snapshot, event);
    next.revision = event.revision;
    return { status: 'applied', snapshot: requireValidScene(next) };
  } catch {
    return {
      status: 'resyncRequired',
      error: createError('CONFLICT', 'Workspace event conflicts with the current scene', false, {
        actualRevision: snapshot.revision,
      }),
    };
  }
}

function isDefaultRebaseable(intent: WorkspaceSceneIntent): boolean {
  return (
    intent.kind === 'navigation.replace' ||
    intent.kind === 'selections.replace' ||
    intent.kind === 'resources.invalidate'
  );
}

export class WorkspaceMirrorService {
  private readonly repository: WorkspaceStateRepository;
  private readonly clock: WorkspaceClock;
  private readonly idGenerator: WorkspaceIdGenerator;
  private readonly effectExecutor?: WorkspaceIntentEffectExecutor;
  private readonly leaseDurationMs: number;
  private readonly disconnectGraceMs: number;
  private readonly minimumRetainedEvents: number;
  private readonly eventRetentionMs: number;
  private readonly eventRetentionBytes: number;
  private readonly canRebase: (intent: WorkspaceSceneIntent) => boolean;
  private readonly hostId: string;
  private readonly sceneId: string;
  private readonly hostEpoch: string;
  private readonly initialSnapshot?: WorkspaceSceneSnapshot;
  private initialized = false;
  private bootstrapReady: boolean;
  private scene!: WorkspaceSceneSnapshot;
  private retainedEvents: RetainedWorkspaceEvent[] = [];
  private retainedEventBytes = 0;
  private compactionFloor = 0;
  private coordinationSequence = 0;
  private controllerLease: ControllerLease | null = null;
  private readonly clientSequences = new Map<string, number>();
  private readonly eventSubscribers = new Set<(event: WorkspaceSceneEvent) => void>();
  private readonly controlSubscribers = new Set<(event: WorkspaceControlEvent) => void>();
  private readonly bootstrapSubscribers = new Set<() => void>();
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(options: WorkspaceMirrorServiceOptions) {
    this.repository = options.repository ?? new InMemoryWorkspaceStateRepository();
    this.clock = options.clock ?? { now: () => Date.now() };
    this.idGenerator = options.idGenerator ?? defaultIdGenerator;
    this.effectExecutor = options.effectExecutor;
    this.hostId = options.hostId;
    this.sceneId = options.sceneId;
    this.hostEpoch = options.hostEpoch ?? this.idGenerator('hostEpoch');
    this.initialSnapshot = options.initialSnapshot ? clone(options.initialSnapshot) : undefined;
    this.leaseDurationMs = options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS;
    this.disconnectGraceMs = options.disconnectGraceMs ?? DEFAULT_DISCONNECT_GRACE_MS;
    this.minimumRetainedEvents =
      options.retention?.minimumEvents ?? DEFAULT_MINIMUM_RETAINED_EVENTS;
    this.eventRetentionMs = options.retention?.maxAgeMs ?? DEFAULT_EVENT_RETENTION_MS;
    this.eventRetentionBytes = options.retention?.maxBytes ?? DEFAULT_EVENT_RETENTION_BYTES;
    this.canRebase = options.canRebase ?? isDefaultRebaseable;
    this.bootstrapReady = options.bootstrapReady ?? true;

    for (const [name, value] of [
      ['leaseDurationMs', this.leaseDurationMs],
      ['disconnectGraceMs', this.disconnectGraceMs],
      ['minimumEvents', this.minimumRetainedEvents],
      ['maxAgeMs', this.eventRetentionMs],
      ['maxBytes', this.eventRetentionBytes],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new RangeError(`${name} must be a non-negative safe integer`);
      }
    }
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.repository.initialize();
    const persisted = await this.repository.loadSnapshot();
    const source = persisted ?? this.initialSnapshot;
    if (source && (source.hostId !== this.hostId || source.sceneId !== this.sceneId)) {
      throw new Error('Persisted workspace scene identity does not match service identity');
    }

    this.scene = source
      ? requireValidScene(
          recoverRuntimeStateAfterHostRestart({ ...clone(source), hostEpoch: this.hostEpoch })
        )
      : createEmptyWorkspaceSceneSnapshot({
          hostId: this.hostId,
          sceneId: this.sceneId,
          hostEpoch: this.hostEpoch,
        });

    await this.repository.saveSnapshot(this.scene);
    const persistedEvents = await this.repository.loadEvents();
    const sameEpochEvents = persistedEvents.filter(
      ({ event }) => event.hostEpoch === this.hostEpoch && event.sceneId === this.sceneId
    );
    if (sameEpochEvents.length !== persistedEvents.length) {
      await this.repository.compactEventsThrough(Number.MAX_SAFE_INTEGER);
    }
    this.restoreRetainedEvents(sameEpochEvents);
    await this.recoverUnfinishedOperations();
    this.initialized = true;
  }

  getSnapshot(): WorkspaceSceneSnapshot {
    this.assertInitialized();
    return clone(this.scene);
  }

  getCanonicalNormalizedScene(): string {
    this.assertInitialized();
    return canonicalizeWorkspaceScene(this.scene);
  }

  async getNormalizedDigest(): Promise<string> {
    this.assertInitialized();
    return digestWorkspaceScene(this.scene);
  }

  getCompactionFloor(): number {
    this.assertInitialized();
    return this.compactionFloor;
  }

  subscribe(listener: (event: WorkspaceSceneEvent) => void): () => void {
    this.eventSubscribers.add(listener);
    return () => this.eventSubscribers.delete(listener);
  }

  subscribeControl(listener: (event: WorkspaceControlEvent) => void): () => void {
    this.controlSubscribers.add(listener);
    return () => this.controlSubscribers.delete(listener);
  }

  isBootstrapReady(): boolean {
    this.assertInitialized();
    return this.bootstrapReady;
  }

  completeBootstrap(): boolean {
    this.assertInitialized();
    if (this.bootstrapReady) return false;
    this.bootstrapReady = true;
    for (const listener of this.bootstrapSubscribers) listener();
    return true;
  }

  /**
   * Serialize the legacy cutover with scene mutations. The callback receives
   * the last committed snapshot after all previously queued imports have
   * drained; a failed callback leaves the service gated for a safe retry.
   */
  completeBootstrapAfter(
    finalize: (snapshot: WorkspaceSceneSnapshot) => Promise<void>
  ): Promise<void> {
    return this.enqueue(async () => {
      this.assertInitialized();
      if (this.bootstrapReady) return;
      await finalize(this.getSnapshot());
      this.completeBootstrap();
    });
  }

  subscribeBootstrap(listener: () => void): () => void {
    this.bootstrapSubscribers.add(listener);
    return () => this.bootstrapSubscribers.delete(listener);
  }

  dispatchIntent(
    intent: WorkspaceSceneIntent,
    actor: WorkspaceIntentActor
  ): Promise<WorkspaceIntentDispatchResult> {
    return this.enqueue(() => this.dispatchIntentNow(intent, actor));
  }

  dispatchHostMutation(
    candidate: WorkspaceSceneMutation,
    source: 'host' | 'migration' | 'reconcile' = 'host'
  ): Promise<WorkspaceSceneEvent> {
    return this.enqueue(() =>
      this.commitHostMutationNow(WorkspaceSceneMutationSchema.parse(candidate), source)
    );
  }

  dispatchHostMutationFactory<TResult>(
    factory: (snapshot: WorkspaceSceneSnapshot) => {
      mutation: WorkspaceSceneMutation;
      result: TResult;
    },
    source: 'host' | 'migration' | 'reconcile' = 'host'
  ): Promise<TResult> {
    return this.enqueue(async () => {
      const built = factory(this.getSnapshot());
      await this.commitHostMutationNow(WorkspaceSceneMutationSchema.parse(built.mutation), source);
      return built.result;
    });
  }

  upsertWorkspaceEntity(entity: WorkspaceSceneEntityUpsert): Promise<void> {
    return this.enqueue(async () => {
      this.assertInitialized();
      const snapshot = clone(this.scene);
      const catalog = snapshot.catalog;
      let rewrittenRoot: { oldPath: string; newPath: string } | null = null;
      if (entity.kind === 'repository') {
        if (catalog.worktrees[entity.entityId]) {
          throw new WorkspaceStateConflictError(
            `Workspace entity ${entity.entityId} is already a worktree`
          );
        }
        const existing = catalog.repositories[entity.entityId];
        if (existing?.path === entity.path) return;
        const nextOrder =
          Math.max(-1, ...Object.values(catalog.repositories).map(({ order }) => order)) + 1;
        catalog.repositories[entity.entityId] = existing
          ? { ...existing, path: entity.path }
          : {
              id: entity.entityId,
              path: entity.path,
              name: basename(entity.path),
              groupId: null,
              order: nextOrder,
              settings: { autoInitWorktree: false, initScript: '', hidden: false },
            };
        if (existing) {
          rewrittenRoot = { oldPath: existing.path, newPath: entity.path };
          const oldNormalized = normalizeWorkspaceEntityPath(
            existing.path,
            this.repository.entityPathPlatform
          );
          const oldLookupKey = workspaceEntityPathLookupKey(
            oldNormalized.normalizedPath,
            this.repository.entityPathCasePolicy
          );
          for (const worktree of Object.values(catalog.worktrees)) {
            if (!worktree.isMain || worktree.repositoryId !== entity.entityId) continue;
            const worktreePath = normalizeWorkspaceEntityPath(
              worktree.path,
              this.repository.entityPathPlatform
            );
            if (
              workspaceEntityPathLookupKey(
                worktreePath.normalizedPath,
                this.repository.entityPathCasePolicy
              ) === oldLookupKey
            ) {
              worktree.path = entity.path;
            }
          }
        }
      } else {
        if (catalog.repositories[entity.entityId]) {
          throw new WorkspaceStateConflictError(
            `Workspace entity ${entity.entityId} is already a repository`
          );
        }
        if (!catalog.repositories[entity.repositoryId]) {
          throw new WorkspaceStateConflictError(
            `Workspace repository ${entity.repositoryId} does not exist`
          );
        }
        const existing = catalog.worktrees[entity.entityId];
        if (
          existing?.path === entity.path &&
          existing.repositoryId === entity.repositoryId &&
          existing.branch === entity.branch
        ) {
          return;
        }
        const nextOrder =
          Math.max(-1, ...Object.values(catalog.worktrees).map(({ order }) => order)) + 1;
        catalog.worktrees[entity.entityId] = existing
          ? {
              ...existing,
              repositoryId: entity.repositoryId,
              path: entity.path,
              branch: entity.branch,
            }
          : {
              id: entity.entityId,
              repositoryId: entity.repositoryId,
              path: entity.path,
              name: basename(entity.path),
              branch: entity.branch,
              order: nextOrder,
              isMain: false,
            };
        if (existing && existing.path !== entity.path) {
          rewrittenRoot = { oldPath: existing.path, newPath: entity.path };
        }
      }
      if (rewrittenRoot) {
        rewriteWorkspaceScenePaths(
          snapshot,
          rewrittenRoot.oldPath,
          rewrittenRoot.newPath,
          this.repository.entityPathPlatform,
          this.repository.entityPathCasePolicy
        );
        await this.commitHostMutationNow(
          WorkspaceSceneMutationSchema.parse({
            kind: 'scene.replace',
            payload: {
              catalog: snapshot.catalog,
              navigation: snapshot.navigation,
              editors: snapshot.editors,
              agents: snapshot.agents,
              terminals: snapshot.terminals,
              todos: snapshot.todos,
              selections: snapshot.selections,
            },
          }),
          'reconcile'
        );
        return;
      }
      await this.commitHostMutationNow(
        WorkspaceSceneMutationSchema.parse({ kind: 'catalog.replace', payload: { catalog } }),
        'reconcile'
      );
    });
  }

  removeWorkspaceWorktree(entityId: string): Promise<void> {
    return this.enqueue(async () => {
      this.assertInitialized();
      if (!this.scene.catalog.worktrees[entityId]) return;
      const snapshot = clone(this.scene);
      delete snapshot.catalog.worktrees[entityId];
      if (snapshot.navigation.activeWorktreeId === entityId) {
        snapshot.navigation.activeWorktreeId = null;
      }
      delete snapshot.navigation.activePanelByWorktree[entityId];
      delete snapshot.navigation.panelOrderByWorktree[entityId];
      delete snapshot.editors[entityId];

      for (const session of Object.values(snapshot.agents.sessions)) {
        if (session.worktreeId === entityId) session.worktreeId = null;
      }
      for (const [groupId, group] of Object.entries(snapshot.agents.groups)) {
        if (group.worktreeId === entityId) delete snapshot.agents.groups[groupId];
      }
      delete snapshot.agents.activeSessionByWorktree[entityId];

      for (const session of Object.values(snapshot.terminals.sessions)) {
        if (session.worktreeId === entityId) session.worktreeId = null;
      }
      for (const [groupId, group] of Object.entries(snapshot.terminals.groups)) {
        if (group.worktreeId === entityId) delete snapshot.terminals.groups[groupId];
      }
      delete snapshot.terminals.activeSessionByWorktree[entityId];
      delete snapshot.terminals.quickSessionByWorktree[entityId];
      delete snapshot.selections.selectedFileByWorktree[entityId];
      delete snapshot.selections.selectedDiffByWorktree[entityId];

      await this.commitHostMutationNow(
        WorkspaceSceneMutationSchema.parse({
          kind: 'scene.replace',
          payload: {
            catalog: snapshot.catalog,
            navigation: snapshot.navigation,
            editors: snapshot.editors,
            agents: snapshot.agents,
            terminals: snapshot.terminals,
            todos: snapshot.todos,
            selections: snapshot.selections,
          },
        }),
        'reconcile'
      );
    });
  }

  invalidateResource(
    invalidation: Omit<WorkspaceResourceInvalidation, 'generation'>
  ): Promise<WorkspaceSceneEvent> {
    return this.enqueue(async () => {
      this.assertInitialized();
      const currentGeneration =
        this.scene.resources.invalidations[invalidation.resourceKey]?.generation ?? 0;
      const mutation = WorkspaceSceneMutationSchema.parse({
        kind: 'resources.invalidate',
        payload: { ...invalidation, generation: currentGeneration + 1 },
      });
      return this.commitHostMutationNow(mutation, 'host');
    });
  }

  private async commitHostMutationNow(
    mutation: WorkspaceSceneMutation,
    source: 'host' | 'migration' | 'reconcile'
  ): Promise<WorkspaceSceneEvent> {
    this.assertInitialized();
    const nextSnapshot = requireValidScene({
      ...reduceWorkspaceSceneMutation(this.scene, mutation),
      revision: this.scene.revision + 1,
    });
    const operationId = `${source}-${randomUUID()}`;
    const event = WorkspaceSceneEventSchema.parse({
      t: 'state.event',
      hostEpoch: this.hostEpoch,
      sceneId: this.sceneId,
      revision: nextSnapshot.revision,
      origin: {
        source,
        clientId: null,
        deviceId: null,
        operationId,
      },
      ...mutation,
    });
    const now = this.clock.now();
    const operation: WorkspaceOperationRecord = {
      operationId,
      intentKind: mutation.kind,
      sceneId: this.sceneId,
      clientId: source,
      deviceId: 'host',
      commandVersion: WORKSPACE_MIRROR_SCHEMA_VERSION,
      requestDigest: digestWorkspaceRequest({ source, mutation }),
      state: 'committed',
      baseRevision: this.scene.revision,
      committedRevision: nextSnapshot.revision,
      createdAt: now,
      updatedAt: now,
    };
    await this.repository.commit({ snapshot: nextSnapshot, event, operation, committedAt: now });
    this.scene = nextSnapshot;
    this.appendRetainedEvent(event, now);
    this.publishEvent(event);
    return clone(event);
  }

  resume(cursor: WorkspaceResumeCursor): WorkspaceReplayResult {
    this.assertInitialized();
    if (cursor.hostEpoch !== this.hostEpoch) {
      return this.resyncRequired('epoch-changed');
    }
    if (cursor.sceneId !== this.sceneId || cursor.revision > this.scene.revision) {
      return this.resyncRequired('revision-gap');
    }
    if (cursor.revision === this.scene.revision) {
      return {
        t: 'state.upToDate',
        hostEpoch: this.hostEpoch,
        sceneId: this.sceneId,
        revision: this.scene.revision,
      };
    }
    if (cursor.revision < this.compactionFloor) {
      return this.resyncRequired('retention-floor');
    }

    const events = this.retainedEvents
      .filter(({ event }) => event.revision > cursor.revision)
      .map(({ event }) => clone(event));
    const fromRevision = cursor.revision + 1;
    if (
      events.length === 0 ||
      events[0]?.revision !== fromRevision ||
      events.at(-1)?.revision !== this.scene.revision ||
      events.some((event, index) => event.revision !== fromRevision + index)
    ) {
      return this.resyncRequired('revision-gap');
    }
    return {
      t: 'state.replay',
      hostEpoch: this.hostEpoch,
      sceneId: this.sceneId,
      fromRevision,
      toRevision: this.scene.revision,
      events,
    };
  }

  compactEventsThrough(revision: number): Promise<void> {
    return this.enqueue(async () => {
      this.assertInitialized();
      if (!Number.isSafeInteger(revision) || revision < 0) {
        throw new RangeError('Compaction revision must be a non-negative safe integer');
      }
      await this.repository.compactEventsThrough(revision);
      this.dropRetainedEventsThrough(revision);
    });
  }

  requestControl(actor: Omit<WorkspaceIntentActor, 'leaseId'>): Promise<WorkspaceControlResult> {
    return this.enqueue(async () => this.requestControlNow(actor));
  }

  requestControlTransfer(
    target: Omit<WorkspaceIntentActor, 'leaseId'>,
    knownCoordSeq: number
  ): Promise<WorkspaceControlResult> {
    return this.enqueue(async () => {
      this.assertInitialized();
      this.expireControllerLease();
      const current = this.controllerLease;
      if (
        !current ||
        (current.holderClientId === target.clientId && current.holderDeviceId === target.deviceId)
      ) {
        return this.requestControlNow(target);
      }
      if (knownCoordSeq !== current.coordSeq) {
        return {
          granted: false,
          error: createError(
            'CONFLICT',
            'Controller state changed; refresh before transfer',
            true,
            {
              leaseId: current.leaseId,
            }
          ),
        };
      }
      return this.transferControlNow(
        {
          clientId: current.holderClientId,
          deviceId: current.holderDeviceId,
          leaseId: current.leaseId,
        },
        target,
        current.graceUntil !== null
      );
    });
  }

  private requestControlNow(actor: Omit<WorkspaceIntentActor, 'leaseId'>): WorkspaceControlResult {
    this.assertInitialized();
    this.expireControllerLease();
    const current = this.controllerLease;
    if (
      current &&
      (current.holderClientId !== actor.clientId || current.holderDeviceId !== actor.deviceId)
    ) {
      return {
        granted: false,
        error: createError('LEASE_REQUIRED', 'Workspace control is held by another client', true, {
          leaseId: current.leaseId,
        }),
      };
    }

    const now = this.clock.now();
    const lease: ControllerLease = current
      ? {
          ...current,
          expiresAt: now + this.leaseDurationMs,
          graceUntil: null,
          coordSeq: this.nextCoordinationSequence(),
        }
      : {
          leaseId: this.idGenerator('lease'),
          holderDeviceId: actor.deviceId,
          holderClientId: actor.clientId,
          acquiredAt: now,
          expiresAt: now + this.leaseDurationMs,
          graceUntil: null,
          coordSeq: this.nextCoordinationSequence(),
        };
    this.controllerLease = ControllerLeaseSchema.parse(lease);
    this.publishControl({
      t: 'control.granted',
      coordSeq: lease.coordSeq,
      lease: clone(lease),
    });
    return { granted: true, lease: clone(lease) };
  }

  transferControl(
    actor: WorkspaceIntentActor,
    target: Omit<WorkspaceIntentActor, 'leaseId'>
  ): Promise<WorkspaceControlResult> {
    return this.enqueue(async () => this.transferControlNow(actor, target));
  }

  private transferControlNow(
    actor: WorkspaceIntentActor,
    target: Omit<WorkspaceIntentActor, 'leaseId'>,
    allowGrace = false
  ): WorkspaceControlResult {
    this.assertInitialized();
    const authorization = this.authorizeControl(actor, allowGrace);
    if (authorization) return { granted: false, error: authorization };

    const previous = this.controllerLease!;
    const revokedSequence = this.nextCoordinationSequence();
    this.publishControl({
      t: 'control.revoked',
      coordSeq: revokedSequence,
      leaseId: previous.leaseId,
      reason: 'transferred',
    });

    const now = this.clock.now();
    const lease = ControllerLeaseSchema.parse({
      leaseId: this.idGenerator('lease'),
      holderDeviceId: target.deviceId,
      holderClientId: target.clientId,
      acquiredAt: now,
      expiresAt: now + this.leaseDurationMs,
      graceUntil: null,
      coordSeq: this.nextCoordinationSequence(),
    });
    this.controllerLease = lease;
    this.publishControl({ t: 'control.granted', coordSeq: lease.coordSeq, lease: clone(lease) });
    return { granted: true, lease: clone(lease) };
  }

  releaseControl(actor: WorkspaceIntentActor): Promise<WorkspaceMirrorError | null> {
    return this.enqueue(async () => this.releaseControlNow(actor));
  }

  private releaseControlNow(actor: WorkspaceIntentActor): WorkspaceMirrorError | null {
    this.assertInitialized();
    const authorization = this.authorizeControl(actor);
    if (authorization) return authorization;
    const lease = this.controllerLease!;
    this.controllerLease = null;
    const coordSeq = this.nextCoordinationSequence();
    this.publishControl({
      t: 'control.released',
      coordSeq,
      leaseId: lease.leaseId,
      reason: 'released',
    });
    return null;
  }

  revokeControl(
    reason: 'host-revoked' | 'credential-revoked' | 'expired' = 'host-revoked'
  ): Promise<boolean> {
    return this.enqueue(async () => this.revokeControlNow(reason));
  }

  private revokeControlNow(reason: 'host-revoked' | 'credential-revoked' | 'expired'): boolean {
    this.assertInitialized();
    const lease = this.controllerLease;
    if (!lease) return false;
    this.controllerLease = null;
    const coordSeq = this.nextCoordinationSequence();
    this.publishControl({
      t: 'control.revoked',
      coordSeq,
      leaseId: lease.leaseId,
      reason,
    });
    return true;
  }

  markControllerDisconnected(actor: WorkspaceIntentActor): Promise<boolean> {
    return this.enqueue(async () => this.markControllerDisconnectedNow(actor));
  }

  markControllerDisconnectedForClient(
    actor: Omit<WorkspaceIntentActor, 'leaseId'>
  ): Promise<boolean> {
    return this.enqueue(async () => {
      this.assertInitialized();
      const lease = this.controllerLease;
      if (
        !lease ||
        lease.holderClientId !== actor.clientId ||
        lease.holderDeviceId !== actor.deviceId
      ) {
        return false;
      }
      return this.markControllerDisconnectedNow({ ...actor, leaseId: lease.leaseId });
    });
  }

  private markControllerDisconnectedNow(actor: WorkspaceIntentActor): boolean {
    this.assertInitialized();
    const authorization = this.authorizeControl(actor);
    if (authorization) return false;
    const lease = this.controllerLease!;
    const graceUntil = this.clock.now() + this.disconnectGraceMs;
    const updated = ControllerLeaseSchema.parse({
      ...lease,
      graceUntil,
      coordSeq: this.nextCoordinationSequence(),
    });
    this.controllerLease = updated;
    this.publishControl({
      t: 'control.granted',
      coordSeq: updated.coordSeq,
      lease: clone(updated),
    });
    return true;
  }

  markControllerReconnected(actor: WorkspaceIntentActor): Promise<WorkspaceControlResult> {
    return this.enqueue(async () => this.markControllerReconnectedNow(actor));
  }

  private markControllerReconnectedNow(actor: WorkspaceIntentActor): WorkspaceControlResult {
    this.assertInitialized();
    const authorization = this.authorizeControl(actor, true);
    if (authorization) return { granted: false, error: authorization };
    return this.requestControlNow({ clientId: actor.clientId, deviceId: actor.deviceId });
  }

  sweepExpiredLease(): Promise<boolean> {
    return this.enqueue(async () => {
      this.assertInitialized();
      return this.expireControllerLease();
    });
  }

  getControllerLease(): Promise<ControllerLease | null> {
    return this.enqueue(async () => {
      this.assertInitialized();
      this.expireControllerLease();
      return this.controllerLease ? clone(this.controllerLease) : null;
    });
  }

  getCoordinationSequence(): number {
    return this.coordinationSequence;
  }

  private async dispatchIntentNow(
    candidate: WorkspaceSceneIntent,
    actor: WorkspaceIntentActor
  ): Promise<WorkspaceIntentDispatchResult> {
    this.assertInitialized();
    const parsed = WorkspaceSceneIntentSchema.safeParse(candidate);
    if (!parsed.success) {
      return rejectedResult(
        candidate.operationId,
        this.scene.revision,
        createError('INVALID_FRAME', 'Workspace intent is invalid', false)
      );
    }
    const intent = parsed.data;
    const requestDigest = digestWorkspaceRequest({
      clientSeq: intent.clientSeq,
      baseRevision: intent.baseRevision,
      kind: intent.kind,
      payload: intent.payload,
    });

    let existing: WorkspaceOperationRecord<WorkspaceIntentDispatchResult> | null;
    try {
      existing = await this.repository.loadOperation(intent.operationId);
    } catch {
      return rejectedResult(
        intent.operationId,
        this.scene.revision,
        createError('INTERNAL', 'Workspace operation ledger is unavailable', true)
      );
    }
    if (existing) return this.resolveExistingOperation(existing, actor, requestDigest);

    const leaseError = this.authorizeControl(actor);
    if (leaseError) return rejectedResult(intent.operationId, this.scene.revision, leaseError);

    const previousClientSequence = this.clientSequences.get(actor.clientId) ?? 0;
    if (intent.clientSeq <= previousClientSequence) {
      return rejectedResult(
        intent.operationId,
        this.scene.revision,
        createError('CONFLICT', 'Client intent sequence is stale', false)
      );
    }
    if (intent.baseRevision > this.scene.revision) {
      return rejectedResult(
        intent.operationId,
        this.scene.revision,
        createError('CONFLICT', 'Intent base revision is ahead of the host', true, {
          expectedRevision: this.scene.revision,
          actualRevision: intent.baseRevision,
        })
      );
    }
    if (intent.baseRevision < this.scene.revision && !this.canRebase(intent)) {
      return rejectedResult(
        intent.operationId,
        this.scene.revision,
        createError('CONFLICT', 'Intent base revision is stale', true, {
          expectedRevision: this.scene.revision,
          actualRevision: intent.baseRevision,
        })
      );
    }

    const previousSnapshot = clone(this.scene);
    let nextSnapshot: WorkspaceSceneSnapshot;
    try {
      nextSnapshot = reduceWorkspaceSceneMutation(previousSnapshot, intent);
      nextSnapshot.revision = previousSnapshot.revision + 1;
      nextSnapshot = requireValidScene(nextSnapshot);
    } catch {
      return rejectedResult(
        intent.operationId,
        this.scene.revision,
        createError('CONFLICT', 'Intent conflicts with the current workspace scene', false, {
          actualRevision: this.scene.revision,
        })
      );
    }

    const now = this.clock.now();
    let operation: WorkspaceOperationRecord<WorkspaceIntentDispatchResult> = {
      operationId: intent.operationId,
      intentKind: intent.kind,
      sceneId: this.sceneId,
      clientId: actor.clientId,
      deviceId: actor.deviceId,
      commandVersion: WORKSPACE_MIRROR_SCHEMA_VERSION,
      requestDigest,
      state: 'prepared',
      baseRevision: intent.baseRevision,
      createdAt: now,
      updatedAt: now,
    };
    try {
      await this.repository.saveOperation(operation);
      operation = { ...operation, state: 'executing', updatedAt: this.clock.now() };
      if (
        !(await this.repository.compareAndSwapOperation(intent.operationId, 'prepared', operation))
      ) {
        const raced = await this.repository.loadOperation<WorkspaceIntentDispatchResult>(
          intent.operationId
        );
        if (raced) return this.resolveExistingOperation(raced, actor, requestDigest);
        throw new Error('Workspace operation disappeared during preparation');
      }
    } catch {
      return rejectedResult(
        intent.operationId,
        this.scene.revision,
        createError('INTERNAL', 'Workspace operation could not be prepared', true)
      );
    }

    let effectResult: JsonValue | undefined;
    try {
      effectResult = await this.effectExecutor?.execute({
        intent,
        actor: clone(actor),
        previousSnapshot,
        nextSnapshot: clone(nextSnapshot),
      });
    } catch {
      const failure = rejectedResult(
        intent.operationId,
        this.scene.revision,
        createError('UNKNOWN', 'Workspace operation requires reconciliation', false)
      );
      operation = {
        ...operation,
        state: 'needs_reconcile',
        result: failure,
        error: { code: failure.error.code, message: failure.error.message },
        updatedAt: this.clock.now(),
      };
      try {
        await this.repository.compareAndSwapOperation(intent.operationId, 'executing', operation);
      } catch {}
      return failure;
    }

    const postEffectLeaseError = this.authorizeControl(actor);
    if (postEffectLeaseError) {
      const failure = rejectedResult(
        intent.operationId,
        this.scene.revision,
        createError('UNKNOWN', 'Control changed while the operation was executing', false)
      );
      operation = {
        ...operation,
        state: 'needs_reconcile',
        result: failure,
        error: { code: failure.error.code, message: failure.error.message },
        updatedAt: this.clock.now(),
      };
      try {
        await this.repository.compareAndSwapOperation(intent.operationId, 'executing', operation);
      } catch {}
      return failure;
    }

    const event = WorkspaceSceneEventSchema.parse({
      t: 'state.event',
      hostEpoch: this.hostEpoch,
      sceneId: this.sceneId,
      revision: nextSnapshot.revision,
      origin: {
        source: 'client',
        clientId: actor.clientId,
        deviceId: actor.deviceId,
        operationId: intent.operationId,
      },
      kind: intent.kind,
      payload: clone(intent.payload),
    });
    const success: WorkspaceIntentDispatchResult = {
      t: 'state.intentResult',
      operationId: intent.operationId,
      accepted: true,
      committedRevision: nextSnapshot.revision,
      ...(effectResult === undefined ? {} : { result: effectResult }),
    };
    operation = {
      ...operation,
      state: 'committed',
      committedRevision: nextSnapshot.revision,
      result: success,
      updatedAt: this.clock.now(),
    };

    const committedAt = this.clock.now();
    try {
      await this.repository.commit({
        snapshot: nextSnapshot,
        event,
        operation,
        committedAt,
      });
    } catch {
      const failure = rejectedResult(
        intent.operationId,
        this.scene.revision,
        createError('UNKNOWN', 'Workspace operation requires reconciliation', false)
      );
      const reconcileRecord: WorkspaceOperationRecord<WorkspaceIntentDispatchResult> = {
        ...operation,
        state: 'needs_reconcile',
        committedRevision: undefined,
        result: failure,
        error: { code: failure.error.code, message: failure.error.message },
        updatedAt: this.clock.now(),
      };
      try {
        await this.repository.compareAndSwapOperation(
          intent.operationId,
          'executing',
          reconcileRecord
        );
      } catch {}
      return failure;
    }

    this.scene = nextSnapshot;
    this.clientSequences.set(actor.clientId, intent.clientSeq);
    this.appendRetainedEvent(event, committedAt);
    this.publishEvent(event);
    return clone(success);
  }

  private resolveExistingOperation(
    operation: WorkspaceOperationRecord<WorkspaceIntentDispatchResult>,
    actor: WorkspaceIntentActor,
    requestDigest: string
  ): WorkspaceIntentDispatchResult {
    if (
      operation.sceneId !== this.sceneId ||
      operation.clientId !== actor.clientId ||
      operation.deviceId !== actor.deviceId ||
      operation.commandVersion !== WORKSPACE_MIRROR_SCHEMA_VERSION ||
      operation.requestDigest !== requestDigest
    ) {
      return rejectedResult(
        operation.operationId,
        this.scene.revision,
        createError('CONFLICT', 'Operation ID is bound to a different request', false)
      );
    }
    if (operation.resultCompactedAt !== undefined) {
      return rejectedResult(
        operation.operationId,
        this.scene.revision,
        createError('RESULT_EXPIRED', 'Workspace operation result has expired', false)
      );
    }
    if (operation.result) return clone(operation.result);
    if (operation.state === 'committed' && operation.committedRevision !== undefined) {
      return {
        t: 'state.intentResult',
        operationId: operation.operationId,
        accepted: true,
        committedRevision: operation.committedRevision,
      };
    }
    const persistedCode =
      operation.error?.code === 'NOT_EXECUTED'
        ? 'NOT_EXECUTED'
        : operation.state === 'needs_reconcile'
          ? 'UNKNOWN'
          : 'UNKNOWN_OPERATION';
    return rejectedResult(
      operation.operationId,
      this.scene.revision,
      createError(
        persistedCode,
        persistedCode === 'UNKNOWN'
          ? 'Workspace operation requires reconciliation'
          : persistedCode === 'NOT_EXECUTED'
            ? 'Workspace operation did not begin before host restart'
            : 'Workspace operation has not committed',
        false
      )
    );
  }

  private async recoverUnfinishedOperations(): Promise<void> {
    const operations = await this.repository.listUnfinishedOperations(this.sceneId);
    for (const operation of operations) {
      if (operation.state === 'prepared') {
        await this.repository.compareAndSwapOperation(operation.operationId, 'prepared', {
          ...operation,
          state: 'cancelled',
          error: { code: 'NOT_EXECUTED', message: 'Operation did not begin before host restart' },
          updatedAt: this.clock.now(),
        });
      } else if (operation.state === 'executing') {
        await this.repository.compareAndSwapOperation(operation.operationId, 'executing', {
          ...operation,
          state: 'needs_reconcile',
          error: { code: 'UNKNOWN', message: 'Operation outcome is unknown after host restart' },
          updatedAt: this.clock.now(),
        });
      }
    }
  }

  private authorizeControl(
    actor: WorkspaceIntentActor,
    allowGrace = false
  ): WorkspaceMirrorError | null {
    const expired = this.expireControllerLease();
    if (expired) {
      return createError('LEASE_EXPIRED', 'Workspace controller lease expired', true);
    }
    const lease = this.controllerLease;
    if (!lease)
      return createError('LEASE_REQUIRED', 'Workspace controller lease is required', true);
    if (
      lease.holderClientId !== actor.clientId ||
      lease.holderDeviceId !== actor.deviceId ||
      lease.leaseId !== actor.leaseId
    ) {
      return createError('LEASE_REQUIRED', 'Workspace controller lease does not match', false, {
        leaseId: lease.leaseId,
      });
    }
    if (!allowGrace && lease.graceUntil !== null) {
      return createError('LEASE_EXPIRED', 'Disconnected controller cannot mutate the scene', true, {
        leaseId: lease.leaseId,
      });
    }
    return null;
  }

  private expireControllerLease(): boolean {
    const lease = this.controllerLease;
    if (!lease) return false;
    const now = this.clock.now();
    const disconnectedExpired = lease.graceUntil !== null && now >= lease.graceUntil;
    const regularExpired = lease.graceUntil === null && now >= lease.expiresAt;
    if (!disconnectedExpired && !regularExpired) return false;

    this.controllerLease = null;
    const coordSeq = this.nextCoordinationSequence();
    this.publishControl({
      t: 'control.released',
      coordSeq,
      leaseId: lease.leaseId,
      reason: disconnectedExpired ? 'disconnect-timeout' : 'expired',
    });
    return true;
  }

  private nextCoordinationSequence(): number {
    this.coordinationSequence += 1;
    return this.coordinationSequence;
  }

  private publishEvent(event: WorkspaceSceneEvent): void {
    for (const listener of this.eventSubscribers) {
      try {
        listener(clone(event));
      } catch {}
    }
  }

  private publishControl(event: WorkspaceControlEvent): void {
    for (const listener of this.controlSubscribers) {
      try {
        listener(clone(event));
      } catch {}
    }
  }

  private appendRetainedEvent(event: WorkspaceSceneEvent, committedAt: number): void {
    const retained = { event: clone(event), committedAt, bytes: eventBytes(event) };
    this.retainedEvents.push(retained);
    this.retainedEventBytes += retained.bytes;
    this.compactRetention();
  }

  private compactRetention(): void {
    const cutoff = this.clock.now() - this.eventRetentionMs;
    let compactThrough = this.compactionFloor;
    while (
      this.retainedEvents.length > this.minimumRetainedEvents &&
      this.retainedEvents[0]!.committedAt < cutoff
    ) {
      const removed = this.retainedEvents.shift()!;
      this.retainedEventBytes -= removed.bytes;
      compactThrough = Math.max(compactThrough, removed.event.revision);
    }
    while (this.retainedEventBytes > this.eventRetentionBytes && this.retainedEvents.length > 0) {
      const removed = this.retainedEvents.shift()!;
      this.retainedEventBytes -= removed.bytes;
      compactThrough = Math.max(compactThrough, removed.event.revision);
    }
    if (compactThrough > this.compactionFloor) {
      this.compactionFloor = compactThrough;
      void this.repository.compactEventsThrough(compactThrough).catch(() => undefined);
    }
  }

  private dropRetainedEventsThrough(revision: number): void {
    let removedRevision = this.compactionFloor;
    while (this.retainedEvents[0]?.event.revision <= revision) {
      const removed = this.retainedEvents.shift()!;
      this.retainedEventBytes -= removed.bytes;
      removedRevision = Math.max(removedRevision, removed.event.revision);
    }
    this.compactionFloor = Math.max(this.compactionFloor, removedRevision);
  }

  private restoreRetainedEvents(events: WorkspacePersistedEvent[]): void {
    const sorted = [...events].sort((left, right) => left.event.revision - right.event.revision);
    const suffix: RetainedWorkspaceEvent[] = [];
    let expectedRevision = this.scene.revision;
    for (let index = sorted.length - 1; index >= 0; index -= 1) {
      const persisted = sorted[index]!;
      if (persisted.event.revision !== expectedRevision) break;
      suffix.unshift({
        event: clone(persisted.event),
        committedAt: persisted.committedAt,
        bytes: eventBytes(persisted.event),
      });
      expectedRevision -= 1;
    }
    this.retainedEvents = suffix;
    this.retainedEventBytes = suffix.reduce((total, retained) => total + retained.bytes, 0);
    this.compactionFloor = suffix[0]?.event.revision
      ? suffix[0].event.revision - 1
      : this.scene.revision;
    this.compactRetention();
  }

  private resyncRequired(reason: StateResyncRequiredFrame['reason']): StateResyncRequiredFrame {
    return {
      t: 'state.resyncRequired',
      reason,
      hostEpoch: this.hostEpoch,
      sceneId: this.sceneId,
      currentRevision: this.scene.revision,
    };
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationQueue.then(operation, operation);
    this.operationQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new Error('WorkspaceMirrorService is not initialized');
  }
}
