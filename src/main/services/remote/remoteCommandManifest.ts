import {
  IPC_CHANNELS,
  REMOTE_FS_READ_FILE_CHANNEL,
  type WorkspaceMirrorCapability,
  type WorkspaceMirrorScope,
  type WorkspaceMirrorV2Frame,
} from '../../../shared/types';
import type { V1RemoteCommandChannel } from './remoteCommandRegistry';

export type RemoteCommandRoute =
  | 'read-only'
  | 'durable-command'
  | 'stream/coordination'
  | 'v2-forbidden';

export const REMOTE_V2_FRAME_ROUTE_MANIFEST = {
  'auth.challenge': 'stream/coordination',
  'auth.proof': 'stream/coordination',
  clientHello: 'stream/coordination',
  serverHello: 'stream/coordination',
  'resource.upload.begin': 'stream/coordination',
  'resource.upload.chunk': 'stream/coordination',
  'resource.upload.end': 'stream/coordination',
  'resource.upload.result': 'stream/coordination',
  'state.subscribe': 'stream/coordination',
  'state.snapshot.begin': 'stream/coordination',
  'state.snapshot.chunk': 'stream/coordination',
  'state.snapshot.end': 'stream/coordination',
  'state.event': 'stream/coordination',
  'state.replay': 'stream/coordination',
  'state.resyncRequired': 'stream/coordination',
  'state.intent': 'stream/coordination',
  'state.intentResult': 'stream/coordination',
  'command.execute': 'durable-command',
  'command.status': 'stream/coordination',
  'command.result': 'stream/coordination',
  'control.request': 'stream/coordination',
  'control.granted': 'stream/coordination',
  'control.released': 'stream/coordination',
  'control.revoked': 'stream/coordination',
  'coord.presence': 'stream/coordination',
  'coord.sync': 'stream/coordination',
  'coord.command': 'stream/coordination',
  'coord.commandResult': 'stream/coordination',
  'stream.attach': 'stream/coordination',
  'stream.attached': 'stream/coordination',
  'stream.chunk': 'stream/coordination',
  'stream.ack': 'stream/coordination',
  'stream.input': 'stream/coordination',
  'stream.resize': 'stream/coordination',
  'stream.detach': 'stream/coordination',
  'stream.reset': 'stream/coordination',
  'stream.closed': 'stream/coordination',
  error: 'stream/coordination',
} as const satisfies Readonly<Record<WorkspaceMirrorV2Frame['t'], RemoteCommandRoute>>;

export type RemoteCommandRiskClass =
  | 'query'
  | 'workspace-state'
  | 'filesystem'
  | 'git-local'
  | 'git-remote'
  | 'process-runtime'
  | 'host-integration'
  | 'external-service';

export type RemoteCommandReconciliationClass =
  | 'read-only'
  | 'idempotent'
  | 'reconcilable'
  | 'unknown-on-crash'
  | 'native-plane'
  | 'forbidden';

export type RemoteSensitiveDataClass =
  | 'workspace-path'
  | 'file-content'
  | 'user-content'
  | 'terminal-bytes'
  | 'credential-adjacent'
  | 'process-output'
  | 'resource-bytes';

export type RemotePayloadPersistence = 'none' | 'digest-only' | 'redacted-metadata';

export const REMOTE_COMMAND_SCHEMA_VERSION = 1 as const;

export type RemoteCommandSchemaPayload = 'request' | 'result';

export type RemoteCommandSchemaId =
  `workspace-command/${V1RemoteCommandChannel}/${RemoteCommandSchemaPayload}@${typeof REMOTE_COMMAND_SCHEMA_VERSION}`;

export function getRemoteCommandSchemaId<
  Channel extends V1RemoteCommandChannel,
  Payload extends RemoteCommandSchemaPayload,
>(channel: Channel, payload: Payload): `workspace-command/${Channel}/${Payload}@1` {
  return `workspace-command/${channel}/${payload}@${REMOTE_COMMAND_SCHEMA_VERSION}`;
}

/**
 * Temporary V2 event bridge for host services that have not yet moved to a
 * revisioned or stream frame. Unlisted `ev` channels are rejected on V2.
 */
export const REMOTE_V2_EVENT_MANIFEST: Readonly<Record<string, WorkspaceMirrorCapability | null>> =
  {
    [IPC_CHANNELS.FILE_CHANGE]: 'scene.replay',
    [IPC_CHANNELS.GIT_CLONE_PROGRESS]: 'command.execute',
    [IPC_CHANNELS.GIT_CODE_REVIEW_DATA]: 'agent.stream',
    [IPC_CHANNELS.GIT_AUTO_FETCH_COMPLETED]: 'scene.replay',
    [IPC_CHANNELS.AGENT_STATUS_UPDATE]: 'agent.stream',
    [IPC_CHANNELS.AGENT_PRE_TOOL_USE_NOTIFICATION]: 'agent.stream',
    [IPC_CHANNELS.AGENT_USER_PROMPT_NOTIFICATION]: 'agent.stream',
    [IPC_CHANNELS.AGENT_ASK_USER_QUESTION_NOTIFICATION]: 'agent.stream',
    [IPC_CHANNELS.AGENT_STOP_NOTIFICATION]: 'agent.stream',
  };

export function getRemoteV2EventCapability(
  channel: string
): WorkspaceMirrorCapability | null | undefined {
  return REMOTE_V2_EVENT_MANIFEST[channel];
}

export interface RemoteCommandRedactionPolicy {
  /** Data classes that must never be emitted verbatim in logs or metrics. */
  readonly request: readonly RemoteSensitiveDataClass[];
  /** Data classes that must never be emitted verbatim in logs or metrics. */
  readonly result: readonly RemoteSensitiveDataClass[];
  readonly persistedRequest: RemotePayloadPersistence;
  readonly persistedResult: RemotePayloadPersistence;
  readonly errors: 'generic';
}

interface RemoteCommandDescriptorBase {
  readonly channel: V1RemoteCommandChannel;
  readonly requiredScope: WorkspaceMirrorScope | null;
  readonly requiredCapability: WorkspaceMirrorCapability | null;
  readonly requiresController: boolean;
  readonly risk: RemoteCommandRiskClass;
  readonly redaction: RemoteCommandRedactionPolicy;
}

export interface ReadOnlyRemoteCommandDescriptor extends RemoteCommandDescriptorBase {
  readonly route: 'read-only';
  readonly requiredScope: 'mirror.read';
  readonly requiresController: false;
  readonly reconciliation: 'read-only';
}

export interface DurableRemoteCommandDescriptor extends RemoteCommandDescriptorBase {
  readonly route: 'durable-command';
  readonly requiredScope: 'mirror.control';
  readonly requiresController: true;
  readonly reconciliation: 'idempotent' | 'reconcilable' | 'unknown-on-crash';
  readonly requestSchemaId: RemoteCommandSchemaId;
  readonly resultSchemaId: RemoteCommandSchemaId;
}

export interface NativeRemoteCommandDescriptor extends RemoteCommandDescriptorBase {
  readonly route: 'stream/coordination';
  readonly requiredScope: WorkspaceMirrorScope;
  readonly reconciliation: 'native-plane';
}

export interface ForbiddenRemoteCommandDescriptor extends RemoteCommandDescriptorBase {
  readonly route: 'v2-forbidden';
  readonly requiredScope: null;
  readonly requiredCapability: null;
  readonly requiresController: false;
  readonly reconciliation: 'forbidden';
}

export type RemoteCommandDescriptor =
  | ReadOnlyRemoteCommandDescriptor
  | DurableRemoteCommandDescriptor
  | NativeRemoteCommandDescriptor
  | ForbiddenRemoteCommandDescriptor;

type ManifestEntry = readonly [V1RemoteCommandChannel, RemoteCommandDescriptor];

const NO_PAYLOAD: RemoteCommandRedactionPolicy = {
  request: [],
  result: [],
  persistedRequest: 'none',
  persistedResult: 'none',
  errors: 'generic',
};

const PATH_QUERY: RemoteCommandRedactionPolicy = {
  request: ['workspace-path'],
  result: ['workspace-path'],
  persistedRequest: 'none',
  persistedResult: 'none',
  errors: 'generic',
};

const CONTENT_QUERY: RemoteCommandRedactionPolicy = {
  request: ['workspace-path'],
  result: ['workspace-path', 'file-content', 'user-content'],
  persistedRequest: 'none',
  persistedResult: 'none',
  errors: 'generic',
};

const USER_STATE_QUERY: RemoteCommandRedactionPolicy = {
  request: ['workspace-path'],
  result: ['workspace-path', 'user-content'],
  persistedRequest: 'none',
  persistedResult: 'none',
  errors: 'generic',
};

const DURABLE_PATHS: RemoteCommandRedactionPolicy = {
  request: ['workspace-path'],
  result: ['workspace-path'],
  persistedRequest: 'digest-only',
  persistedResult: 'digest-only',
  errors: 'generic',
};

const DURABLE_CONTENT: RemoteCommandRedactionPolicy = {
  request: ['workspace-path', 'file-content', 'user-content'],
  result: ['workspace-path', 'user-content', 'process-output'],
  persistedRequest: 'digest-only',
  persistedResult: 'digest-only',
  errors: 'generic',
};

const DURABLE_SAFE_COMMIT_RESULT: RemoteCommandRedactionPolicy = {
  ...DURABLE_CONTENT,
  result: [],
  persistedResult: 'redacted-metadata',
};

const DURABLE_ENTITY: RemoteCommandRedactionPolicy = {
  request: ['workspace-path'],
  result: ['workspace-path'],
  persistedRequest: 'digest-only',
  persistedResult: 'redacted-metadata',
  errors: 'generic',
};

const DURABLE_REMOTE_GIT: RemoteCommandRedactionPolicy = {
  request: ['workspace-path', 'credential-adjacent', 'user-content'],
  result: ['workspace-path', 'credential-adjacent', 'process-output'],
  persistedRequest: 'digest-only',
  persistedResult: 'digest-only',
  errors: 'generic',
};

const DURABLE_CLONE_RESULT: RemoteCommandRedactionPolicy = {
  ...DURABLE_REMOTE_GIT,
  persistedResult: 'redacted-metadata',
};

const TERMINAL_CONTROL: RemoteCommandRedactionPolicy = {
  request: ['workspace-path', 'terminal-bytes', 'credential-adjacent'],
  result: ['workspace-path', 'process-output'],
  persistedRequest: 'none',
  persistedResult: 'none',
  errors: 'generic',
};

const DURABLE_TERMINAL_CREATE: RemoteCommandRedactionPolicy = {
  request: ['workspace-path', 'user-content', 'credential-adjacent'],
  result: [],
  persistedRequest: 'digest-only',
  persistedResult: 'redacted-metadata',
  errors: 'generic',
};

const RESOURCE_TRANSFER: RemoteCommandRedactionPolicy = {
  request: ['workspace-path', 'resource-bytes', 'user-content'],
  result: ['resource-bytes', 'user-content'],
  persistedRequest: 'none',
  persistedResult: 'none',
  errors: 'generic',
};

const FORBIDDEN_SENSITIVE: RemoteCommandRedactionPolicy = {
  request: ['workspace-path', 'user-content', 'credential-adjacent'],
  result: ['workspace-path', 'user-content', 'process-output'],
  persistedRequest: 'none',
  persistedResult: 'none',
  errors: 'generic',
};

function readOnly<Channel extends V1RemoteCommandChannel>(
  channel: Channel,
  risk: RemoteCommandRiskClass,
  redaction: RemoteCommandRedactionPolicy = PATH_QUERY,
  requiredCapability: WorkspaceMirrorCapability | null = null
): readonly [Channel, ReadOnlyRemoteCommandDescriptor] {
  return [
    channel,
    {
      channel,
      route: 'read-only',
      requiredScope: 'mirror.read',
      requiredCapability,
      requiresController: false,
      risk,
      reconciliation: 'read-only',
      redaction,
    },
  ];
}

function durable<Channel extends V1RemoteCommandChannel>(
  channel: Channel,
  risk: RemoteCommandRiskClass,
  reconciliation: DurableRemoteCommandDescriptor['reconciliation'],
  redaction: RemoteCommandRedactionPolicy,
  requiredCapability: WorkspaceMirrorCapability | null = null
): readonly [Channel, DurableRemoteCommandDescriptor] {
  return [
    channel,
    {
      channel,
      route: 'durable-command',
      requiredScope: 'mirror.control',
      requiredCapability,
      requiresController: true,
      risk,
      reconciliation,
      redaction,
      requestSchemaId: getRemoteCommandSchemaId(channel, 'request'),
      resultSchemaId: getRemoteCommandSchemaId(channel, 'result'),
    },
  ];
}

function nativePlane<Channel extends V1RemoteCommandChannel>(
  channel: Channel,
  requiredScope: WorkspaceMirrorScope,
  requiresController: boolean,
  risk: RemoteCommandRiskClass,
  redaction: RemoteCommandRedactionPolicy,
  requiredCapability: WorkspaceMirrorCapability | null
): readonly [Channel, NativeRemoteCommandDescriptor] {
  return [
    channel,
    {
      channel,
      route: 'stream/coordination',
      requiredScope,
      requiredCapability,
      requiresController,
      risk,
      reconciliation: 'native-plane',
      redaction,
    },
  ];
}

function forbidden<Channel extends V1RemoteCommandChannel>(
  channel: Channel,
  risk: RemoteCommandRiskClass,
  redaction: RemoteCommandRedactionPolicy = FORBIDDEN_SENSITIVE
): readonly [Channel, ForbiddenRemoteCommandDescriptor] {
  return [
    channel,
    {
      channel,
      route: 'v2-forbidden',
      requiredScope: null,
      requiredCapability: null,
      requiresController: false,
      risk,
      reconciliation: 'forbidden',
      redaction,
    },
  ];
}

/**
 * Target V2 route for every channel reachable through the legacy remote
 * allowlist. The allowlist intentionally remains independent so the
 * completeness test fails when either surface changes without the other.
 */
export const REMOTE_COMMAND_MANIFEST_ENTRIES = [
  // Git queries
  readOnly(IPC_CHANNELS.GIT_STATUS, 'git-local'),
  readOnly(IPC_CHANNELS.GIT_BRANCH_LIST, 'git-local'),
  readOnly(IPC_CHANNELS.GIT_BRANCH_HEAD_INFO, 'git-local'),
  readOnly(IPC_CHANNELS.GIT_LOG, 'git-local', CONTENT_QUERY),
  readOnly(IPC_CHANNELS.GIT_DIFF, 'git-local', CONTENT_QUERY),
  readOnly(IPC_CHANNELS.GIT_FILE_CHANGES, 'git-local'),
  readOnly(IPC_CHANNELS.GIT_FILE_DIFF, 'git-local', CONTENT_QUERY),
  readOnly(IPC_CHANNELS.GIT_COMMIT_SHOW, 'git-local', CONTENT_QUERY),
  readOnly(IPC_CHANNELS.GIT_COMMIT_FILES, 'git-local'),
  readOnly(IPC_CHANNELS.GIT_COMMIT_DIFF, 'git-local', CONTENT_QUERY),
  readOnly(IPC_CHANNELS.GIT_DIFF_STATS, 'git-local'),
  readOnly(IPC_CHANNELS.GIT_GH_STATUS, 'external-service', FORBIDDEN_SENSITIVE),
  readOnly(IPC_CHANNELS.GIT_PR_LIST, 'external-service', USER_STATE_QUERY),
  readOnly(IPC_CHANNELS.GIT_VALIDATE_URL, 'query', FORBIDDEN_SENSITIVE),
  readOnly(IPC_CHANNELS.GIT_BLAME, 'git-local', CONTENT_QUERY),
  readOnly(IPC_CHANNELS.GIT_SUBMODULE_LIST, 'git-local'),
  readOnly(IPC_CHANNELS.GIT_SUBMODULE_CHANGES, 'git-local'),
  readOnly(IPC_CHANNELS.GIT_SUBMODULE_FILE_DIFF, 'git-local', CONTENT_QUERY),
  readOnly(IPC_CHANNELS.GIT_SUBMODULE_BRANCHES, 'git-local'),
  readOnly(IPC_CHANNELS.GIT_VALIDATE_LOCAL_PATH, 'query'),

  // Git effects
  durable(IPC_CHANNELS.GIT_COMMIT, 'git-local', 'unknown-on-crash', DURABLE_SAFE_COMMIT_RESULT),
  durable(IPC_CHANNELS.GIT_PUSH, 'git-remote', 'unknown-on-crash', DURABLE_REMOTE_GIT),
  durable(IPC_CHANNELS.GIT_PULL, 'git-remote', 'unknown-on-crash', DURABLE_REMOTE_GIT),
  durable(IPC_CHANNELS.GIT_FETCH, 'git-remote', 'unknown-on-crash', DURABLE_REMOTE_GIT),
  durable(IPC_CHANNELS.GIT_BRANCH_CREATE, 'git-local', 'unknown-on-crash', DURABLE_PATHS),
  durable(IPC_CHANNELS.GIT_BRANCH_CHECKOUT, 'git-local', 'unknown-on-crash', DURABLE_PATHS),
  durable(IPC_CHANNELS.GIT_INIT, 'git-local', 'unknown-on-crash', DURABLE_PATHS),
  durable(IPC_CHANNELS.GIT_STAGE, 'git-local', 'unknown-on-crash', DURABLE_PATHS),
  durable(IPC_CHANNELS.GIT_UNSTAGE, 'git-local', 'unknown-on-crash', DURABLE_PATHS),
  durable(IPC_CHANNELS.GIT_DISCARD, 'git-local', 'unknown-on-crash', DURABLE_PATHS),
  durable(IPC_CHANNELS.GIT_PR_FETCH, 'git-remote', 'unknown-on-crash', DURABLE_REMOTE_GIT),
  durable(IPC_CHANNELS.GIT_CLONE, 'git-remote', 'reconcilable', DURABLE_CLONE_RESULT),
  durable(IPC_CHANNELS.GIT_REVERT, 'git-local', 'unknown-on-crash', DURABLE_PATHS),
  durable(IPC_CHANNELS.GIT_RESET, 'git-local', 'unknown-on-crash', DURABLE_PATHS),
  durable(IPC_CHANNELS.GIT_SUBMODULE_INIT, 'git-local', 'unknown-on-crash', DURABLE_PATHS),
  durable(IPC_CHANNELS.GIT_SUBMODULE_UPDATE, 'git-remote', 'unknown-on-crash', DURABLE_REMOTE_GIT),
  durable(IPC_CHANNELS.GIT_SUBMODULE_SYNC, 'git-local', 'unknown-on-crash', DURABLE_PATHS),
  durable(IPC_CHANNELS.GIT_SUBMODULE_FETCH, 'git-remote', 'unknown-on-crash', DURABLE_REMOTE_GIT),
  durable(IPC_CHANNELS.GIT_SUBMODULE_PULL, 'git-remote', 'unknown-on-crash', DURABLE_REMOTE_GIT),
  durable(IPC_CHANNELS.GIT_SUBMODULE_PUSH, 'git-remote', 'unknown-on-crash', DURABLE_REMOTE_GIT),
  durable(IPC_CHANNELS.GIT_SUBMODULE_COMMIT, 'git-local', 'unknown-on-crash', DURABLE_CONTENT),
  durable(IPC_CHANNELS.GIT_SUBMODULE_STAGE, 'git-local', 'unknown-on-crash', DURABLE_PATHS),
  durable(IPC_CHANNELS.GIT_SUBMODULE_UNSTAGE, 'git-local', 'unknown-on-crash', DURABLE_PATHS),
  durable(IPC_CHANNELS.GIT_SUBMODULE_DISCARD, 'git-local', 'unknown-on-crash', DURABLE_PATHS),
  durable(IPC_CHANNELS.GIT_SUBMODULE_CHECKOUT, 'git-local', 'unknown-on-crash', DURABLE_PATHS),

  durable(
    IPC_CHANNELS.GIT_GENERATE_COMMIT_MSG,
    'external-service',
    'unknown-on-crash',
    DURABLE_CONTENT
  ),
  durable(
    IPC_CHANNELS.GIT_GENERATE_BRANCH_NAME,
    'external-service',
    'unknown-on-crash',
    DURABLE_CONTENT
  ),
  durable(
    IPC_CHANNELS.GIT_CODE_REVIEW_START,
    'external-service',
    'unknown-on-crash',
    DURABLE_CONTENT,
    'agent.stream'
  ),
  durable(
    IPC_CHANNELS.GIT_CODE_REVIEW_STOP,
    'process-runtime',
    'idempotent',
    DURABLE_PATHS,
    'agent.stream'
  ),
  durable(IPC_CHANNELS.GIT_AUTO_FETCH_SET_ENABLED, 'host-integration', 'idempotent', NO_PAYLOAD),

  // Worktrees
  readOnly(IPC_CHANNELS.WORKTREE_LIST, 'git-local'),
  readOnly(IPC_CHANNELS.WORKTREE_MERGE_STATE, 'git-local'),
  readOnly(IPC_CHANNELS.WORKTREE_MERGE_CONFLICTS, 'git-local'),
  readOnly(IPC_CHANNELS.WORKTREE_MERGE_CONFLICT_CONTENT, 'git-local', CONTENT_QUERY),
  durable(IPC_CHANNELS.WORKTREE_ADD, 'git-local', 'reconcilable', DURABLE_PATHS),
  durable(IPC_CHANNELS.WORKTREE_REMOVE, 'git-local', 'reconcilable', DURABLE_PATHS),
  durable(IPC_CHANNELS.WORKTREE_MERGE, 'git-local', 'unknown-on-crash', DURABLE_CONTENT),
  durable(IPC_CHANNELS.WORKTREE_MERGE_RESOLVE, 'git-local', 'unknown-on-crash', DURABLE_CONTENT),
  durable(IPC_CHANNELS.WORKTREE_MERGE_ABORT, 'git-local', 'unknown-on-crash', DURABLE_PATHS),
  durable(IPC_CHANNELS.WORKTREE_MERGE_CONTINUE, 'git-local', 'unknown-on-crash', DURABLE_CONTENT),
  durable(IPC_CHANNELS.WORKTREE_ACTIVATE, 'host-integration', 'idempotent', DURABLE_PATHS),

  // Temporary workspaces
  durable(IPC_CHANNELS.TEMP_WORKSPACE_CREATE, 'filesystem', 'unknown-on-crash', DURABLE_PATHS),
  durable(IPC_CHANNELS.TEMP_WORKSPACE_REMOVE, 'filesystem', 'unknown-on-crash', DURABLE_PATHS),
  durable(IPC_CHANNELS.TEMP_WORKSPACE_CHECK_PATH, 'filesystem', 'idempotent', DURABLE_PATHS),

  // Filesystem
  readOnly(IPC_CHANNELS.FILE_READ, 'filesystem', CONTENT_QUERY),
  readOnly(IPC_CHANNELS.FILE_LIST, 'filesystem'),
  readOnly(IPC_CHANNELS.FILE_EXISTS, 'filesystem'),
  readOnly(IPC_CHANNELS.FILE_CHECK_CONFLICTS, 'filesystem'),
  durable(IPC_CHANNELS.FILE_WRITE, 'filesystem', 'reconcilable', DURABLE_CONTENT),
  durable(IPC_CHANNELS.FILE_CREATE, 'filesystem', 'reconcilable', DURABLE_CONTENT),
  durable(IPC_CHANNELS.FILE_CREATE_DIR, 'filesystem', 'idempotent', DURABLE_PATHS),
  durable(IPC_CHANNELS.FILE_RENAME, 'filesystem', 'reconcilable', DURABLE_PATHS),
  durable(IPC_CHANNELS.FILE_MOVE, 'filesystem', 'reconcilable', DURABLE_PATHS),
  durable(IPC_CHANNELS.FILE_COPY, 'filesystem', 'reconcilable', DURABLE_PATHS),
  durable(IPC_CHANNELS.FILE_BATCH_MOVE, 'filesystem', 'reconcilable', DURABLE_PATHS),
  durable(IPC_CHANNELS.FILE_BATCH_COPY, 'filesystem', 'reconcilable', DURABLE_PATHS),
  durable(IPC_CHANNELS.FILE_DELETE, 'filesystem', 'reconcilable', DURABLE_PATHS),
  nativePlane(
    IPC_CHANNELS.FILE_WATCH_START,
    'mirror.read',
    false,
    'filesystem',
    PATH_QUERY,
    'scene.replay'
  ),
  nativePlane(
    IPC_CHANNELS.FILE_WATCH_STOP,
    'mirror.read',
    false,
    'filesystem',
    PATH_QUERY,
    'scene.replay'
  ),
  forbidden(IPC_CHANNELS.FILE_SAVE_TO_TEMP, 'filesystem'),
  forbidden(IPC_CHANNELS.FILE_REVEAL_IN_FILE_MANAGER, 'host-integration'),

  // Terminal stream and lifecycle
  durable(
    IPC_CHANNELS.TERMINAL_CREATE,
    'process-runtime',
    'reconcilable',
    DURABLE_TERMINAL_CREATE,
    'terminal.stream'
  ),
  durable(
    IPC_CHANNELS.TERMINAL_DESTROY,
    'process-runtime',
    'reconcilable',
    DURABLE_PATHS,
    'terminal.stream'
  ),
  readOnly(
    IPC_CHANNELS.TERMINAL_LIST_PERSISTENT,
    'process-runtime',
    USER_STATE_QUERY,
    'terminal.stream'
  ),
  readOnly(
    IPC_CHANNELS.TERMINAL_GET_ACTIVITY,
    'process-runtime',
    USER_STATE_QUERY,
    'terminal.stream'
  ),
  nativePlane(
    IPC_CHANNELS.TERMINAL_WRITE,
    'mirror.control',
    true,
    'process-runtime',
    TERMINAL_CONTROL,
    'terminal.stream'
  ),
  nativePlane(
    IPC_CHANNELS.TERMINAL_RESIZE,
    'mirror.control',
    true,
    'process-runtime',
    TERMINAL_CONTROL,
    'terminal.stream'
  ),
  nativePlane(
    IPC_CHANNELS.TERMINAL_ATTACH,
    'mirror.read',
    false,
    'process-runtime',
    TERMINAL_CONTROL,
    'terminal.stream'
  ),
  nativePlane(
    IPC_CHANNELS.TERMINAL_DETACH,
    'mirror.read',
    false,
    'process-runtime',
    TERMINAL_CONTROL,
    'terminal.stream'
  ),

  // Queries and canonical host-owned state
  readOnly(IPC_CHANNELS.SHELL_DETECT, 'query', PATH_QUERY),
  readOnly(IPC_CHANNELS.SHELL_RESOLVE_FOR_COMMAND, 'query', FORBIDDEN_SENSITIVE),
  readOnly(IPC_CHANNELS.SEARCH_FILES, 'filesystem', PATH_QUERY),
  readOnly(IPC_CHANNELS.SEARCH_CONTENT, 'filesystem', CONTENT_QUERY),
  readOnly(IPC_CHANNELS.AGENT_LIST, 'workspace-state', USER_STATE_QUERY, 'agent.stream'),
  readOnly(IPC_CHANNELS.TODO_GET_TASKS, 'workspace-state', USER_STATE_QUERY, 'todo.mirror'),
  readOnly(IPC_CHANNELS.TMUX_CHECK, 'process-runtime', PATH_QUERY),
  forbidden(IPC_CHANNELS.TODO_ADD_TASK, 'workspace-state'),
  forbidden(IPC_CHANNELS.TODO_UPDATE_TASK, 'workspace-state'),
  forbidden(IPC_CHANNELS.TODO_DELETE_TASK, 'workspace-state'),
  forbidden(IPC_CHANNELS.TODO_MOVE_TASK, 'workspace-state'),
  forbidden(IPC_CHANNELS.TODO_REORDER_TASKS, 'workspace-state'),
  durable(IPC_CHANNELS.TODO_AI_POLISH, 'external-service', 'unknown-on-crash', DURABLE_CONTENT),
  durable(IPC_CHANNELS.TMUX_KILL_SESSION, 'process-runtime', 'idempotent', DURABLE_PATHS),

  // Host-only preview and the native workspace planes
  readOnly(REMOTE_FS_READ_FILE_CHANNEL, 'filesystem', CONTENT_QUERY, 'resource.transfer'),
  nativePlane(
    IPC_CHANNELS.WORKSPACE_MIRROR_GET_SNAPSHOT,
    'mirror.read',
    false,
    'workspace-state',
    USER_STATE_QUERY,
    'scene.snapshot'
  ),
  nativePlane(
    IPC_CHANNELS.WORKSPACE_MIRROR_DISPATCH_INTENT,
    'mirror.control',
    true,
    'workspace-state',
    FORBIDDEN_SENSITIVE,
    'scene.intent'
  ),
  nativePlane(
    IPC_CHANNELS.WORKSPACE_MIRROR_REQUEST_CONTROL,
    'mirror.control',
    false,
    'workspace-state',
    NO_PAYLOAD,
    'control.lease'
  ),
  nativePlane(
    IPC_CHANNELS.WORKSPACE_MIRROR_RELEASE_CONTROL,
    'mirror.control',
    true,
    'workspace-state',
    NO_PAYLOAD,
    'control.lease'
  ),
  readOnly(
    IPC_CHANNELS.WORKSPACE_MIRROR_RESOLVE_ENTITIES,
    'workspace-state',
    PATH_QUERY,
    'scene.snapshot'
  ),
  durable(
    IPC_CHANNELS.WORKSPACE_MIRROR_REGISTER_ENTITY,
    'workspace-state',
    'reconcilable',
    DURABLE_ENTITY,
    'scene.intent'
  ),
  durable(
    IPC_CHANNELS.WORKSPACE_MIRROR_ADOPT_ENTITY,
    'workspace-state',
    'reconcilable',
    DURABLE_ENTITY,
    'scene.intent'
  ),
  nativePlane(
    IPC_CHANNELS.WORKSPACE_MIRROR_STAGE_RESOURCE,
    'mirror.control',
    true,
    'filesystem',
    RESOURCE_TRANSFER,
    'resource.transfer'
  ),
  nativePlane(
    IPC_CHANNELS.WORKSPACE_MIRROR_MATERIALIZE_RESOURCE,
    'mirror.control',
    true,
    'filesystem',
    RESOURCE_TRANSFER,
    'resource.transfer'
  ),
  readOnly(
    IPC_CHANNELS.WORKSPACE_MIRROR_FETCH_RESOURCE,
    'filesystem',
    RESOURCE_TRANSFER,
    'resource.transfer'
  ),
] as const satisfies readonly ManifestEntry[];

function createManifest(
  entries: readonly ManifestEntry[]
): Readonly<Record<V1RemoteCommandChannel, RemoteCommandDescriptor>> {
  const manifest: Partial<Record<V1RemoteCommandChannel, RemoteCommandDescriptor>> = {};
  for (const [channel, descriptor] of entries) {
    if (manifest[channel]) {
      throw new Error(`Duplicate remote command manifest entry: ${channel}`);
    }
    Object.freeze(descriptor.redaction.request);
    Object.freeze(descriptor.redaction.result);
    Object.freeze(descriptor.redaction);
    manifest[channel] = Object.freeze(descriptor);
  }
  return Object.freeze(manifest) as Readonly<
    Record<V1RemoteCommandChannel, RemoteCommandDescriptor>
  >;
}

export const REMOTE_COMMAND_MANIFEST = createManifest(REMOTE_COMMAND_MANIFEST_ENTRIES);

export function getRemoteCommandDescriptor(channel: string): RemoteCommandDescriptor | undefined {
  return REMOTE_COMMAND_MANIFEST[channel as V1RemoteCommandChannel];
}

export function isReadOnlyCompatibilityChannel(channel: string): boolean {
  return getRemoteCommandDescriptor(channel)?.route === 'read-only';
}
