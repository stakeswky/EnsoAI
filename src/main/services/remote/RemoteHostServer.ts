import * as crypto from 'node:crypto';
import { realpath } from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import {
  type ClientHelloFrame,
  decodeWorkspaceCommandArgs,
  IPC_CHANNELS,
  JsonValueSchema,
  REMOTE_FS_READ_FILE_CHANNEL,
  REMOTE_PROTOCOL_VERSION,
  REMOTE_TOKEN_HEADER,
  type RemoteFrame,
  type RemoteHostSettings,
  type RemoteHostStatus,
  type RemoteReqFrame,
  WORKSPACE_MIRROR_MAX_RESOURCE_BYTES,
  WORKSPACE_MIRROR_MAX_RESOURCE_CHUNK_BYTES,
  WORKSPACE_MIRROR_PROTOCOL_VERSION,
  WORKSPACE_MIRROR_SCHEMA_VERSION,
  WORKSPACE_MIRROR_SUBPROTOCOL,
  type WorkspaceMirrorCapability,
  type WorkspaceMirrorError,
  type WorkspaceMirrorErrorCode,
  type WorkspaceMirrorScope,
  type WorkspaceMirrorV2Frame,
  type WorkspaceSceneSnapshot,
} from '@shared/types';
import { app, BrowserWindow, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { type WebSocket, WebSocketServer } from 'ws';
import type { TerminalStreamEvent } from '../terminal/TerminalSessionRegistry';
import { terminalSessionRegistry } from '../terminal/terminalRuntime';
import {
  isExistingOrWorkspacePath,
  isPathWithinRoots,
  remoteRepositoryBasePath,
  remoteWorktreeBasePath,
  resolveWorkspaceChild,
  workspaceRootPaths,
} from '../workspace/WorkspacePathPolicy';
import {
  getWorkspaceCommandExecutor,
  getWorkspaceMirrorService,
  getWorkspaceResourceService,
} from '../workspace/workspaceMirrorRuntime';
import { getRegisteredHandler } from './handlerRegistry';
import { MirrorFlowController } from './MirrorFlowController';
import { type RemotePairedDevice, RemotePairedDeviceStore } from './RemotePairedDeviceStore';
import {
  type DurableRemoteCommandDescriptor,
  getRemoteCommandDescriptor,
  getRemoteV2EventCapability,
} from './remoteCommandManifest';
import { parseRemoteFrame } from './remoteFrameCodec';
import {
  getRemoteReadOnlyRequestSchema,
  REMOTE_READ_ONLY_RESULT_SCHEMA,
} from './remoteReadOnlySchemas';
import {
  createWorkspaceSnapshotFrames,
  parseWorkspaceMirrorV2Frame,
} from './workspaceMirrorFrames';

const HEARTBEAT_INTERVAL_MS = 15_000;
const MAX_CONCURRENT_REQUESTS = 32;
const REQUEST_RATE_WINDOW_MS = 10_000;
const MAX_REQUESTS_PER_WINDOW = 256;
const MAX_WEBSOCKET_BUFFERED_BYTES = 64 * 1024 * 1024;
const MAX_REMOTE_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_STREAM_OPERATION_LEDGER = 10_000;
const AUTH_CHALLENGE_TTL_MS = 30_000;
const PAIRING_WINDOW_MS = 5 * 60 * 1_000;
const MAX_PAIRING_ATTEMPTS = 5;
const MAX_ACTIVE_RESOURCE_UPLOADS_PER_CLIENT = 4;
const RESOURCE_UPLOAD_TTL_MS = 2 * 60 * 1_000;
const MAX_RESOURCE_UPLOAD_BYTES_PER_CLIENT = 40 * 1024 * 1024;
const V2_COORDINATION_HANDLER_CHANNELS = new Set<string>([
  IPC_CHANNELS.FILE_WATCH_START,
  IPC_CHANNELS.FILE_WATCH_STOP,
  IPC_CHANNELS.WORKSPACE_MIRROR_MATERIALIZE_RESOURCE,
]);

export function workspaceSceneHasVolatileData(snapshot: WorkspaceSceneSnapshot): boolean {
  const hasDirtyBuffer = Object.values(snapshot.editors).some((editor) =>
    Object.values(editor.buffers).some(
      (buffer) =>
        buffer.isDirty || buffer.content !== undefined || buffer.externalContent !== undefined
    )
  );
  const hasAgentDraft = Object.values(snapshot.agents.sessions).some(
    (session) => session.draft.text.length > 0 || session.draft.resources.length > 0
  );
  return hasDirtyBuffer || hasAgentDraft;
}
const V2_WORKSPACE_ROOT_CHANNELS = new Set<string>([
  IPC_CHANNELS.GIT_STATUS,
  IPC_CHANNELS.GIT_BRANCH_LIST,
  IPC_CHANNELS.GIT_BRANCH_HEAD_INFO,
  IPC_CHANNELS.GIT_LOG,
  IPC_CHANNELS.GIT_DIFF,
  IPC_CHANNELS.GIT_FILE_CHANGES,
  IPC_CHANNELS.GIT_FILE_DIFF,
  IPC_CHANNELS.GIT_COMMIT_SHOW,
  IPC_CHANNELS.GIT_COMMIT_FILES,
  IPC_CHANNELS.GIT_COMMIT_DIFF,
  IPC_CHANNELS.GIT_DIFF_STATS,
  IPC_CHANNELS.GIT_GH_STATUS,
  IPC_CHANNELS.GIT_PR_LIST,
  IPC_CHANNELS.GIT_PR_FETCH,
  IPC_CHANNELS.GIT_GENERATE_COMMIT_MSG,
  IPC_CHANNELS.GIT_GENERATE_BRANCH_NAME,
  IPC_CHANNELS.GIT_CODE_REVIEW_START,
  IPC_CHANNELS.GIT_BLAME,
  IPC_CHANNELS.GIT_SUBMODULE_LIST,
  IPC_CHANNELS.GIT_SUBMODULE_CHANGES,
  IPC_CHANNELS.GIT_SUBMODULE_FILE_DIFF,
  IPC_CHANNELS.GIT_SUBMODULE_BRANCHES,
  IPC_CHANNELS.GIT_VALIDATE_LOCAL_PATH,
  IPC_CHANNELS.GIT_BRANCH_CREATE,
  IPC_CHANNELS.GIT_BRANCH_CHECKOUT,
  IPC_CHANNELS.GIT_COMMIT,
  IPC_CHANNELS.GIT_PUSH,
  IPC_CHANNELS.GIT_PULL,
  IPC_CHANNELS.GIT_FETCH,
  IPC_CHANNELS.GIT_INIT,
  IPC_CHANNELS.GIT_STAGE,
  IPC_CHANNELS.GIT_UNSTAGE,
  IPC_CHANNELS.GIT_DISCARD,
  IPC_CHANNELS.GIT_REVERT,
  IPC_CHANNELS.GIT_RESET,
  IPC_CHANNELS.GIT_SUBMODULE_INIT,
  IPC_CHANNELS.GIT_SUBMODULE_UPDATE,
  IPC_CHANNELS.GIT_SUBMODULE_SYNC,
  IPC_CHANNELS.GIT_SUBMODULE_FETCH,
  IPC_CHANNELS.GIT_SUBMODULE_PULL,
  IPC_CHANNELS.GIT_SUBMODULE_PUSH,
  IPC_CHANNELS.GIT_SUBMODULE_COMMIT,
  IPC_CHANNELS.GIT_SUBMODULE_STAGE,
  IPC_CHANNELS.GIT_SUBMODULE_UNSTAGE,
  IPC_CHANNELS.GIT_SUBMODULE_DISCARD,
  IPC_CHANNELS.GIT_SUBMODULE_CHECKOUT,
  IPC_CHANNELS.WORKTREE_LIST,
  IPC_CHANNELS.WORKTREE_ADD,
  IPC_CHANNELS.WORKTREE_REMOVE,
  IPC_CHANNELS.WORKTREE_MERGE,
  IPC_CHANNELS.WORKTREE_MERGE_STATE,
  IPC_CHANNELS.WORKTREE_MERGE_CONFLICTS,
  IPC_CHANNELS.WORKTREE_MERGE_CONFLICT_CONTENT,
  IPC_CHANNELS.WORKTREE_MERGE_RESOLVE,
  IPC_CHANNELS.WORKTREE_MERGE_ABORT,
  IPC_CHANNELS.WORKTREE_MERGE_CONTINUE,
  IPC_CHANNELS.FILE_READ,
  IPC_CHANNELS.FILE_WRITE,
  IPC_CHANNELS.FILE_CREATE,
  IPC_CHANNELS.FILE_CREATE_DIR,
  IPC_CHANNELS.FILE_RENAME,
  IPC_CHANNELS.FILE_MOVE,
  IPC_CHANNELS.FILE_COPY,
  IPC_CHANNELS.FILE_BATCH_MOVE,
  IPC_CHANNELS.FILE_BATCH_COPY,
  IPC_CHANNELS.FILE_DELETE,
  IPC_CHANNELS.FILE_REVEAL_IN_FILE_MANAGER,
  IPC_CHANNELS.FILE_LIST,
  IPC_CHANNELS.FILE_EXISTS,
  IPC_CHANNELS.FILE_WATCH_START,
  IPC_CHANNELS.FILE_WATCH_STOP,
  IPC_CHANNELS.TEMP_WORKSPACE_CHECK_PATH,
]);

function isPathValue(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isSafeGitObjectId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{4,64}$/i.test(value);
}

function isSafeGitRevision(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 1_024 &&
    !value.startsWith('-') &&
    !/[\0-\x20\x7f]/.test(value) &&
    !value.includes('..') &&
    !value.includes('@{') &&
    !value.endsWith('.')
  );
}

function normalizePathForComparison(value: string): string {
  return resolve(value).replace(/[\\/]+$/, '');
}

function pathsEqual(left: string, right: string): boolean {
  return normalizePathForComparison(left) === normalizePathForComparison(right);
}

async function resolveNearestExistingAncestor(value: string): Promise<string | null> {
  let candidate = resolve(value);
  for (;;) {
    try {
      return await realpath(candidate);
    } catch {
      const parent = dirname(candidate);
      if (parent === candidate) return null;
      candidate = parent;
    }
  }
}

async function isWorkspacePath(value: unknown, roots: readonly string[]): Promise<boolean> {
  return isPathValue(value) && (await isExistingOrWorkspacePath(value, roots));
}

/**
 * Authorize a possibly-new write target by resolving its nearest existing
 * ancestor. This closes the `workspace/link/new-file` escape where `link` is
 * a symlink outside the canonical roots and the final target does not exist.
 */
async function isWorkspaceWritePath(value: unknown, roots: readonly string[]): Promise<boolean> {
  if (!isPathValue(value) || !isPathWithinRoots(value, roots)) return false;
  const [ancestor, realRoots] = await Promise.all([
    resolveNearestExistingAncestor(value),
    Promise.all(roots.map((root) => realpath(root).catch(() => resolve(root)))),
  ]);
  return ancestor !== null && isPathWithinRoots(ancestor, realRoots);
}

/**
 * A new worktree/clone may be a direct sibling of its canonical repository.
 * The target must not already exist, and both lexical and real parents must
 * match so an arbitrary path or symlinked parent cannot be smuggled in.
 */
async function isNewWorkspaceSibling(
  anchor: unknown,
  candidate: unknown,
  roots: readonly string[]
): Promise<boolean> {
  if (
    !isPathValue(anchor) ||
    !isPathValue(candidate) ||
    !isAbsolute(candidate) ||
    !(await isWorkspacePath(anchor, roots))
  ) {
    return false;
  }
  const target = resolve(candidate);
  const anchorParent = dirname(resolve(anchor));
  const targetParent = dirname(target);
  if (!pathsEqual(anchorParent, targetParent)) return false;
  if (
    await realpath(target).then(
      () => true,
      () => false
    )
  )
    return false;
  const [realAnchorParent, realTargetParent] = await Promise.all([
    realpath(anchorParent).catch(() => null),
    realpath(targetParent).catch(() => null),
  ]);
  return Boolean(
    realAnchorParent && realTargetParent && pathsEqual(realAnchorParent, realTargetParent)
  );
}

async function isNewSiblingOfAnyWorkspace(
  candidate: unknown,
  roots: readonly string[]
): Promise<boolean> {
  for (const root of roots) {
    if (await isNewWorkspaceSibling(root, candidate, roots)) return true;
  }
  return false;
}

function defaultRemoteTempBase(): string {
  return join(os.homedir(), 'ensoai', 'temporary');
}

async function isAuthorizedNewWorkspacePath(
  value: unknown,
  configuredRoot: string
): Promise<boolean> {
  return isPathValue(value) && isExistingOrWorkspacePath(value, [configuredRoot]);
}

async function isAuthorizedWorkspaceBrowsePath(
  value: unknown,
  roots: readonly string[]
): Promise<boolean> {
  return (
    (await isWorkspacePath(value, roots)) ||
    (await isAuthorizedNewWorkspacePath(value, remoteRepositoryBasePath())) ||
    (await isAuthorizedNewWorkspacePath(value, remoteWorktreeBasePath()))
  );
}

async function isAuthorizedTempBase(value: unknown, roots: readonly string[]): Promise<boolean> {
  if (value === undefined || value === null || value === '') return true;
  if (!isPathValue(value)) return false;
  return pathsEqual(value, defaultRemoteTempBase()) || isWorkspaceWritePath(value, roots);
}

async function isAuthorizedTempChild(
  child: unknown,
  base: unknown,
  roots: readonly string[]
): Promise<boolean> {
  if (!isPathValue(child) || !(await isAuthorizedTempBase(base, roots))) return false;
  const basePath = isPathValue(base) ? resolve(base) : resolve(defaultRemoteTempBase());
  const childPath = resolve(child);
  if (!pathsEqual(dirname(childPath), basePath)) return false;
  const [realBase, realChild] = await Promise.all([
    realpath(basePath).catch(() => null),
    realpath(childPath).catch(() => null),
  ]);
  return Boolean(realBase && realChild && pathsEqual(dirname(realChild), realBase));
}

async function validateBatchFileOperation(
  args: unknown[],
  roots: readonly string[]
): Promise<boolean> {
  const sources = args[0];
  const targetDir = args[1];
  const conflicts = args[2];
  if (
    !Array.isArray(sources) ||
    !isPathValue(targetDir) ||
    !Array.isArray(conflicts) ||
    !(await areWorkspacePaths(sources, roots)) ||
    !(await isWorkspacePath(targetDir, roots))
  ) {
    return false;
  }
  const sourcePaths = new Set(sources.filter(isPathValue).map((source) => resolve(source)));
  for (const source of sources) {
    if (!isPathValue(source)) return false;
    if (!(await isWorkspaceWritePath(join(targetDir, basename(source)), roots))) return false;
  }
  for (const conflict of conflicts) {
    if (!conflict || typeof conflict !== 'object') return false;
    const candidate = conflict as { path?: unknown; action?: unknown; newName?: unknown };
    if (!isPathValue(candidate.path) || !sourcePaths.has(resolve(candidate.path))) return false;
    if (!['replace', 'skip', 'rename'].includes(String(candidate.action))) return false;
    if (candidate.action !== 'rename') continue;
    if (
      !isPathValue(candidate.newName) ||
      basename(candidate.newName) !== candidate.newName ||
      candidate.newName === '.' ||
      candidate.newName === '..' ||
      !(await isWorkspaceWritePath(join(targetDir, candidate.newName), roots))
    ) {
      return false;
    }
  }
  return true;
}

async function isWorkspaceChild(
  root: unknown,
  child: unknown,
  roots: readonly string[]
): Promise<boolean> {
  if (!(await isWorkspacePath(root, roots))) return false;
  if (child === undefined || child === null || child === '') return true;
  if (!isPathValue(child)) return false;
  const candidate = resolveWorkspaceChild(root as string, child);
  return candidate !== null && (await isExistingOrWorkspacePath(candidate, roots));
}

async function areWorkspacePaths(
  values: readonly unknown[],
  roots: readonly string[]
): Promise<boolean> {
  for (const value of values) {
    if (!(await isWorkspacePath(value, roots))) return false;
  }
  return true;
}

/**
 * Compatibility RPCs are still used by the renderer during migration. Their
 * path arguments must stay inside the host's canonical repository/worktree
 * roots, otherwise a read-scope device could turn a harmless preview/query
 * into an arbitrary host filesystem read.
 */
export async function validateV2WorkspaceRpcPaths(
  channel: string,
  args: unknown[],
  roots: readonly string[]
): Promise<boolean> {
  if (channel === REMOTE_FS_READ_FILE_CHANNEL) {
    return isWorkspacePath(args[0], roots);
  }
  if (channel === IPC_CHANNELS.SEARCH_FILES || channel === IPC_CHANNELS.SEARCH_CONTENT) {
    const params = args[0];
    return Boolean(
      params &&
        typeof params === 'object' &&
        'rootPath' in params &&
        (await isWorkspacePath((params as { rootPath?: unknown }).rootPath, roots))
    );
  }
  if (channel === IPC_CHANNELS.FILE_CHECK_CONFLICTS) {
    const sources = args[0];
    if (!Array.isArray(sources) || !(await isWorkspacePath(args[1], roots))) return false;
    for (const source of sources) {
      if (!(await isWorkspacePath(source, roots))) return false;
    }
    return true;
  }
  if (channel === IPC_CHANNELS.WORKTREE_ACTIVATE) {
    return Array.isArray(args[0]) && areWorkspacePaths(args[0], roots);
  }
  if (channel === IPC_CHANNELS.GIT_CLONE) {
    return (
      (await isWorkspaceWritePath(args[1], roots)) ||
      (await isNewSiblingOfAnyWorkspace(args[1], roots)) ||
      (await isAuthorizedNewWorkspacePath(args[1], remoteRepositoryBasePath()))
    );
  }
  if (channel === IPC_CHANNELS.TEMP_WORKSPACE_CHECK_PATH) {
    return isAuthorizedTempBase(args[0], roots);
  }
  if (channel === IPC_CHANNELS.TEMP_WORKSPACE_CREATE) {
    return isAuthorizedTempBase(args[0], roots);
  }
  if (channel === IPC_CHANNELS.TEMP_WORKSPACE_REMOVE) {
    return isAuthorizedTempChild(args[0], args[1], roots);
  }
  if (channel === IPC_CHANNELS.WORKSPACE_MIRROR_RESOLVE_ENTITIES) {
    const requests = args[0];
    if (!Array.isArray(requests) || requests.length > 10_000) return false;
    for (const request of requests) {
      if (
        !request ||
        typeof request !== 'object' ||
        !['repository', 'worktree'].includes(String((request as { kind?: unknown }).kind)) ||
        !(await isAuthorizedWorkspaceBrowsePath((request as { path?: unknown }).path, roots))
      ) {
        return false;
      }
    }
    return true;
  }
  if (
    channel === IPC_CHANNELS.WORKSPACE_MIRROR_REGISTER_ENTITY ||
    channel === IPC_CHANNELS.WORKSPACE_MIRROR_ADOPT_ENTITY
  ) {
    const pathIndex = channel === IPC_CHANNELS.WORKSPACE_MIRROR_ADOPT_ENTITY ? 2 : 1;
    return (
      ['repository', 'worktree'].includes(String(args[0])) &&
      (await isAuthorizedWorkspaceBrowsePath(args[pathIndex], roots))
    );
  }
  if (channel === IPC_CHANNELS.TERMINAL_CREATE) {
    const options = args[0];
    return Boolean(
      options &&
        typeof options === 'object' &&
        (await isWorkspacePath((options as { cwd?: unknown }).cwd, roots))
    );
  }
  if (channel === IPC_CHANNELS.GIT_VALIDATE_LOCAL_PATH || channel === IPC_CHANNELS.FILE_EXISTS) {
    return isAuthorizedWorkspaceBrowsePath(args[0], roots);
  }
  if (channel === IPC_CHANNELS.FILE_LIST) {
    return (
      (await isAuthorizedWorkspaceBrowsePath(args[0], roots)) &&
      (args[1] === undefined || (await isAuthorizedWorkspaceBrowsePath(args[1], roots)))
    );
  }
  if (
    channel === IPC_CHANNELS.FILE_WRITE ||
    channel === IPC_CHANNELS.FILE_CREATE ||
    channel === IPC_CHANNELS.FILE_CREATE_DIR
  ) {
    return isWorkspaceWritePath(args[0], roots);
  }
  if (
    channel === IPC_CHANNELS.FILE_DELETE ||
    channel === IPC_CHANNELS.FILE_REVEAL_IN_FILE_MANAGER
  ) {
    return isWorkspacePath(args[0], roots);
  }
  if (channel === IPC_CHANNELS.FILE_RENAME || channel === IPC_CHANNELS.FILE_MOVE) {
    return (await isWorkspacePath(args[0], roots)) && isWorkspaceWritePath(args[1], roots);
  }
  if (channel === IPC_CHANNELS.FILE_COPY) {
    return (await isWorkspacePath(args[0], roots)) && isWorkspaceWritePath(args[1], roots);
  }
  if (channel === IPC_CHANNELS.FILE_BATCH_MOVE || channel === IPC_CHANNELS.FILE_BATCH_COPY) {
    return validateBatchFileOperation(args, roots);
  }
  if (!V2_WORKSPACE_ROOT_CHANNELS.has(channel)) return true;

  if (!(await isWorkspacePath(args[0], roots))) return false;
  switch (channel) {
    case IPC_CHANNELS.GIT_LOG:
      return (
        (args[1] === undefined ||
          (Number.isSafeInteger(args[1]) && Number(args[1]) >= 0 && Number(args[1]) <= 1_000)) &&
        (args[2] === undefined || (Number.isSafeInteger(args[2]) && Number(args[2]) >= 0)) &&
        (await isWorkspaceChild(args[0], args[3], roots))
      );
    case IPC_CHANNELS.GIT_BRANCH_HEAD_INFO:
      return isSafeGitRevision(args[1]);
    case IPC_CHANNELS.GIT_COMMIT_SHOW:
      return isSafeGitObjectId(args[1]);
    case IPC_CHANNELS.GIT_COMMIT_FILES:
      return isSafeGitObjectId(args[1]) && isWorkspaceChild(args[0], args[2], roots);
    case IPC_CHANNELS.GIT_FILE_DIFF:
    case IPC_CHANNELS.GIT_BLAME:
      return isWorkspaceChild(args[0], args[1], roots);
    case IPC_CHANNELS.GIT_COMMIT_DIFF: {
      if (!isSafeGitObjectId(args[1])) return false;
      const submoduleRoot = resolveWorkspaceChild(args[0] as string, String(args[4] ?? ''));
      return (
        submoduleRoot !== null &&
        (await isExistingOrWorkspacePath(submoduleRoot, roots)) &&
        isWorkspaceChild(submoduleRoot, args[2], roots)
      );
    }
    case IPC_CHANNELS.GIT_SUBMODULE_FILE_DIFF: {
      const submoduleRoot = resolveWorkspaceChild(args[0] as string, String(args[1] ?? ''));
      return (
        submoduleRoot !== null &&
        (await isExistingOrWorkspacePath(submoduleRoot, roots)) &&
        isWorkspaceChild(submoduleRoot, args[2], roots)
      );
    }
    case IPC_CHANNELS.GIT_SUBMODULE_INIT:
    case IPC_CHANNELS.GIT_SUBMODULE_UPDATE:
      return args[1] === undefined || typeof args[1] === 'boolean';
    case IPC_CHANNELS.GIT_SUBMODULE_SYNC:
      return args[1] === undefined;
    case IPC_CHANNELS.GIT_SUBMODULE_CHANGES:
    case IPC_CHANNELS.GIT_SUBMODULE_BRANCHES:
    case IPC_CHANNELS.GIT_SUBMODULE_FETCH:
    case IPC_CHANNELS.GIT_SUBMODULE_PULL:
    case IPC_CHANNELS.GIT_SUBMODULE_PUSH:
    case IPC_CHANNELS.GIT_SUBMODULE_COMMIT:
    case IPC_CHANNELS.GIT_SUBMODULE_STAGE:
    case IPC_CHANNELS.GIT_SUBMODULE_UNSTAGE:
    case IPC_CHANNELS.GIT_SUBMODULE_DISCARD:
    case IPC_CHANNELS.GIT_SUBMODULE_CHECKOUT:
      return isWorkspaceChild(args[0], args[1], roots);
    case IPC_CHANNELS.WORKTREE_ADD: {
      const options = args[1];
      const target =
        options && typeof options === 'object' ? (options as { path?: unknown }).path : undefined;
      return (
        (await isWorkspaceWritePath(target, roots)) ||
        (await isNewWorkspaceSibling(args[0], target, roots)) ||
        (await isAuthorizedNewWorkspacePath(target, remoteWorktreeBasePath()))
      );
    }
    case IPC_CHANNELS.WORKTREE_REMOVE: {
      const options = args[1];
      return Boolean(
        options &&
          typeof options === 'object' &&
          (await isWorkspacePath((options as { path?: unknown }).path, roots))
      );
    }
    case IPC_CHANNELS.WORKTREE_MERGE: {
      const options = args[1];
      return Boolean(
        options &&
          typeof options === 'object' &&
          (await isWorkspacePath((options as { worktreePath?: unknown }).worktreePath, roots))
      );
    }
    case IPC_CHANNELS.WORKTREE_MERGE_RESOLVE: {
      const resolution = args[1];
      return Boolean(
        resolution &&
          typeof resolution === 'object' &&
          (await isWorkspaceChild(args[0], (resolution as { file?: unknown }).file, roots))
      );
    }
    case IPC_CHANNELS.WORKTREE_MERGE_CONTINUE: {
      const cleanup = args[2];
      return (
        cleanup === undefined ||
        (cleanup !== null &&
          typeof cleanup === 'object' &&
          ((cleanup as { worktreePath?: unknown }).worktreePath === undefined ||
            (await isWorkspacePath((cleanup as { worktreePath?: unknown }).worktreePath, roots))))
      );
    }
    case IPC_CHANNELS.WORKTREE_MERGE_CONFLICT_CONTENT:
      return isWorkspaceChild(args[0], args[1], roots);
    default:
      return true;
  }
}

function joinAppUserData(filename: string): string {
  return join(app.getPath('userData'), filename);
}

function connProtocolIsV2(ws: WebSocket): boolean {
  return ws.protocol === WORKSPACE_MIRROR_SUBPROTOCOL;
}
/** Synthetic sender ids start high to never collide with real webContents ids */
export const REMOTE_VIRTUAL_SENDER_ID_START = 1_000_000;
let nextVirtualSenderId = REMOTE_VIRTUAL_SENDER_ID_START;

/** Stable IPC identity used for a remote virtual sender's host-owned data. */
export function remoteVirtualClientId(senderId: number): string {
  return `renderer-${senderId}`;
}

interface ClientConnection {
  ws: WebSocket;
  senderId: number;
  alive: boolean;
  destroyedCallbacks: Array<() => void>;
  activeRequestIds: Set<number>;
  activeCoordRequestIds: Set<string>;
  requestWindowStartedAt: number;
  requestCount: number;
  protocol: 'v1' | 'v2';
  mirrorClient: ClientHelloFrame | null;
  mirrorStreams: Map<string, MirrorStreamAttachment>;
  mirrorUploads: Map<string, MirrorUploadState>;
  mirrorAuthenticated: boolean;
  revoked: boolean;
  mirrorDevice: RemotePairedDevice | null;
  authNonce: string | null;
  authExpiresAt: number;
  messageTail: Promise<void>;
}

interface MirrorStreamAttachment {
  streamId: string;
  streamKind: 'terminal' | 'agent';
  entityId: string;
  entityGeneration: number;
  terminalSessionId: string;
  subscriberId: string;
}

interface MirrorUploadState {
  requestId: string;
  displayName: string;
  mime?: string;
  totalBytes: number;
  totalChunks: number;
  checksum: string;
  chunks: Buffer[];
  receivedBytes: number;
  nextIndex: number;
  startedAt: number;
}

function canSendRemoteEvent(conn: ClientConnection, channel: string): boolean {
  if (conn.protocol === 'v1') return true;
  const capability = getRemoteV2EventCapability(channel);
  return (
    capability !== undefined &&
    (capability === null || conn.mirrorClient?.capabilities.includes(capability) === true)
  );
}

/** Detect a Tailscale IPv4 address (CGNAT range 100.64.0.0/10) */
export function detectTailscaleAddress(): string | null {
  const interfaces = os.networkInterfaces();
  for (const addrs of Object.values(interfaces)) {
    for (const addr of addrs ?? []) {
      if (addr.family !== 'IPv4' || addr.internal) {
        continue;
      }
      const octets = addr.address.split('.').map(Number);
      if (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) {
        return addr.address;
      }
    }
  }
  return null;
}

export function generateRemoteToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

function timingSafeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Minimal WebContents stand-in for remote connections. Handlers only use
 * id / send / isDestroyed / once('destroyed'), which all map cleanly onto
 * the WebSocket connection lifecycle (e.g. PtyManager owner cleanup).
 */
function createVirtualSender(conn: ClientConnection): WebContents {
  const virtualSender = {
    id: conn.senderId,
    send: (channel: string, ...args: unknown[]): void => {
      if (canSendRemoteEvent(conn, channel) && conn.ws.readyState === conn.ws.OPEN) {
        conn.ws.send(JSON.stringify({ t: 'ev', ch: channel, payload: args }));
      }
    },
    isDestroyed: (): boolean => conn.ws.readyState !== conn.ws.OPEN,
    once: (event: string, callback: () => void) => {
      if (event === 'destroyed') {
        conn.destroyedCallbacks.push(callback);
      }
      return virtualSender;
    },
    on: (event: string, callback: () => void) => {
      if (event === 'destroyed') {
        conn.destroyedCallbacks.push(callback);
      }
      return virtualSender;
    },
  };
  return virtualSender as unknown as WebContents;
}

export class RemoteHostServer {
  private server: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private clients = new Set<ClientConnection>();
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private config: RemoteHostSettings | null = null;
  private bindAddress: string | null = null;
  private lastError: string | undefined;
  private mirrorEventUnsubscribe: (() => void) | null = null;
  private mirrorControlUnsubscribe: (() => void) | null = null;
  private mirrorBootstrapUnsubscribe: (() => void) | null = null;
  private streamOperationLedger = new Map<string, true>();
  private deviceStore: RemotePairedDeviceStore | null;
  private pairingExpiresAt = 0;
  private pairingAttempts = 0;
  private flowController = new MirrorFlowController();

  constructor(deviceStore?: RemotePairedDeviceStore) {
    this.deviceStore = deviceStore ?? null;
  }

  isRunning(): boolean {
    return this.server !== null;
  }

  getStatus(): RemoteHostStatus {
    const address = this.server?.address();
    return {
      running: this.isRunning(),
      port: typeof address === 'object' && address ? address.port : (this.config?.port ?? 0),
      bindAddress: this.bindAddress,
      tailscaleAddress: detectTailscaleAddress(),
      token: this.config?.token ?? null,
      clientCount: this.clients.size,
      mirrorV2Enabled: this.config?.mirrorV2Enabled ?? false,
      error: this.lastError,
    };
  }

  async start(config: RemoteHostSettings): Promise<RemoteHostStatus> {
    if (this.isRunning()) {
      await this.stop();
    }
    this.config = { ...config, mirrorV2Enabled: config.mirrorV2Enabled ?? false };
    this.lastError = undefined;
    if (!this.deviceStore) {
      let deviceStorePath: string | undefined;
      try {
        deviceStorePath = joinAppUserData('remote-paired-devices.json');
      } catch {
        // Unit tests and embedded runtimes may not expose app.getPath.
      }
      this.deviceStore = new RemotePairedDeviceStore(deviceStorePath);
    }
    await this.deviceStore.initialize();
    if (this.deviceStore.list().every((device) => device.revokedAt !== null)) {
      this.openPairingWindow();
    }

    const bindAddress = this.resolveBindAddress(config.bind);

    try {
      await new Promise<void>((resolve, reject) => {
        const server = http.createServer((_req, res) => {
          res.writeHead(404);
          res.end();
        });
        const wss = new WebSocketServer({
          server,
          handleProtocols: (protocols) => {
            if (
              this.config?.mirrorV2Enabled === true &&
              this.config?.bind !== 'all' &&
              protocols.has(WORKSPACE_MIRROR_SUBPROTOCOL)
            ) {
              return WORKSPACE_MIRROR_SUBPROTOCOL;
            }
            return false;
          },
        });

        wss.on('connection', (ws, req) => this.handleConnection(ws, req));

        server.on('error', (err) => {
          this.lastError = err.message;
          reject(err);
        });
        server.listen(config.port, bindAddress, () => {
          this.server = server;
          this.wss = wss;
          this.bindAddress = bindAddress;
          resolve();
        });
      });

      this.heartbeatTimer = setInterval(() => this.checkHeartbeats(), HEARTBEAT_INTERVAL_MS);
      const mirrorService = getWorkspaceMirrorService();
      this.mirrorEventUnsubscribe = mirrorService.subscribe((event) => {
        this.broadcastMirrorFrame(event);
      });
      this.mirrorControlUnsubscribe = mirrorService.subscribeControl((event) => {
        this.broadcastMirrorFrame(event);
      });
      this.mirrorBootstrapUnsubscribe = mirrorService.subscribeBootstrap(() => {
        for (const conn of this.clients) {
          if (conn.protocol === 'v2' && conn.mirrorClient) this.sendMirrorServerHello(conn);
        }
      });
      console.log(`[remote-host] listening on ${bindAddress}:${this.getStatus().port}`);
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.server = null;
      this.wss = null;
      this.bindAddress = null;
    }

    this.broadcastStatus();
    return this.getStatus();
  }

  async stop(): Promise<void> {
    this.mirrorEventUnsubscribe?.();
    this.mirrorEventUnsubscribe = null;
    this.mirrorControlUnsubscribe?.();
    this.mirrorControlUnsubscribe = null;
    this.mirrorBootstrapUnsubscribe?.();
    this.mirrorBootstrapUnsubscribe = null;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const conn of [...this.clients]) {
      this.disposeConnection(conn);
    }
    this.clients.clear();

    const server = this.server;
    const wss = this.wss;
    this.server = null;
    this.wss = null;
    this.bindAddress = null;

    if (wss) {
      wss.close();
    }
    if (server) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    this.broadcastStatus();
  }

  stopSync(): void {
    this.mirrorEventUnsubscribe?.();
    this.mirrorEventUnsubscribe = null;
    this.mirrorControlUnsubscribe?.();
    this.mirrorControlUnsubscribe = null;
    this.mirrorBootstrapUnsubscribe?.();
    this.mirrorBootstrapUnsubscribe = null;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const conn of [...this.clients]) {
      this.disposeConnection(conn);
    }
    this.clients.clear();
    this.wss?.close();
    this.server?.close();
    this.wss = null;
    this.server = null;
    this.bindAddress = null;
  }

  /**
   * Fan a broadcast channel out to all connected remote clients. Used for
   * events that are normally sent to all BrowserWindows (agent notifications,
   * git auto-fetch completion) — virtual senders are not in getAllWindows().
   */
  broadcastToClients(channel: string, ...args: unknown[]): void {
    if (this.clients.size === 0) {
      return;
    }
    const frame = JSON.stringify({ t: 'ev', ch: channel, payload: args });
    for (const conn of this.clients) {
      if (channel.startsWith('workspaceMirror:')) continue;
      if (!canSendRemoteEvent(conn, channel)) continue;
      if (
        conn.protocol === 'v2' &&
        (!conn.mirrorAuthenticated ||
          !conn.mirrorClient ||
          !this.hasCurrentDeviceScope(conn, 'mirror.read'))
      ) {
        continue;
      }
      if (conn.ws.readyState === conn.ws.OPEN) {
        conn.ws.send(frame);
      }
    }
  }

  /** Disconnect all clients (e.g. after token regeneration) */
  disconnectAllClients(): void {
    for (const conn of [...this.clients]) {
      conn.ws.close(4401, 'token changed');
      this.disposeConnection(conn);
    }
    this.clients.clear();
    this.broadcastStatus();
  }

  updateToken(token: string): void {
    if (this.config) {
      this.config.token = token;
    }
    this.openPairingWindow();
    this.disconnectAllClients();
  }

  listPairedDevices(): Array<Omit<RemotePairedDevice, 'publicKey'>> {
    return (this.deviceStore?.list() ?? []).map(({ publicKey: _publicKey, ...device }) => device);
  }

  async revokePairedDevice(deviceId: string): Promise<boolean> {
    const revoked = await this.deviceStore?.revoke(deviceId);
    if (!revoked) return false;
    const affected = [...this.clients].filter((conn) => conn.mirrorDevice?.deviceId === deviceId);
    for (const conn of affected) {
      conn.revoked = true;
      conn.mirrorAuthenticated = false;
      for (const streamId of [...conn.mirrorStreams.keys()]) {
        this.detachMirrorStream(conn, streamId);
      }
    }
    const service = getWorkspaceMirrorService();
    const lease = await service.getControllerLease();
    if (lease?.holderDeviceId === deviceId) {
      await service.revokeControl('credential-revoked');
    }
    for (const conn of affected) {
      conn.ws.close(4401, 'device credential revoked');
      this.disposeConnection(conn);
      this.clients.delete(conn);
    }
    this.broadcastStatus();
    return true;
  }

  setMirrorV2Enabled(enabled: boolean, options?: { skipVolatileGuard?: boolean }): void {
    if (
      !enabled &&
      !options?.skipVolatileGuard &&
      workspaceSceneHasVolatileData(getWorkspaceMirrorService().getSnapshot())
    ) {
      throw new Error(
        'Live Mirror cannot be disabled while dirty editor buffers or Agent drafts require handoff'
      );
    }
    if (this.config) this.config.mirrorV2Enabled = enabled;
    if (!enabled) {
      for (const conn of [...this.clients]) {
        if (conn.protocol !== 'v2') continue;
        conn.ws.close(4410, 'workspace mirror disabled');
        this.disposeConnection(conn);
        this.clients.delete(conn);
      }
    }
    this.broadcastStatus();
  }

  private resolveBindAddress(bind: RemoteHostSettings['bind']): string {
    if (bind === 'all') {
      return '0.0.0.0';
    }
    if (bind === 'localhost') {
      return '127.0.0.1';
    }
    // Default: bind Tailscale interface only, fall back to localhost
    return detectTailscaleAddress() ?? '127.0.0.1';
  }

  private handleConnection(ws: WebSocket, req: http.IncomingMessage): void {
    // The shared legacy token has no device scope or controller proof. Keep
    // the compatibility plane available only when V2 is explicitly disabled;
    // otherwise a read-only paired device could reconnect without a
    // subprotocol and bypass all V2 authorization checks.
    if (ws.protocol !== WORKSPACE_MIRROR_SUBPROTOCOL && this.config?.mirrorV2Enabled === true) {
      ws.send(
        JSON.stringify({
          t: 'protocol.error',
          code: 'UPGRADE_REQUIRED',
          message: 'Legacy remote transport is disabled while workspace mirror V2 is enabled',
        }),
        () => ws.close(4406, 'workspace mirror V2 upgrade required')
      );
      return;
    }
    const token = this.config?.token;
    const provided = req.headers[REMOTE_TOKEN_HEADER];
    if (!token || typeof provided !== 'string' || !timingSafeEqual(provided, token)) {
      ws.close(4401, 'unauthorized');
      return;
    }

    const conn: ClientConnection = {
      ws,
      senderId: nextVirtualSenderId++,
      alive: true,
      destroyedCallbacks: [],
      activeRequestIds: new Set(),
      activeCoordRequestIds: new Set(),
      requestWindowStartedAt: Date.now(),
      requestCount: 0,
      protocol: ws.protocol === WORKSPACE_MIRROR_SUBPROTOCOL ? 'v2' : 'v1',
      mirrorClient: null,
      mirrorStreams: new Map(),
      mirrorUploads: new Map(),
      mirrorAuthenticated: !connProtocolIsV2(ws),
      revoked: false,
      mirrorDevice: null,
      authNonce: null,
      authExpiresAt: 0,
      messageTail: Promise.resolve(),
    };
    this.clients.add(conn);
    const virtualSender = createVirtualSender(conn);
    const virtualEvent = { sender: virtualSender } as unknown as IpcMainInvokeEvent;

    ws.on('pong', () => {
      conn.alive = true;
    });

    ws.on('message', (raw) => {
      if (conn.protocol === 'v2') {
        conn.messageTail = conn.messageTail
          .then(() => this.handleMirrorMessage(conn, virtualEvent, raw.toString()))
          .catch(() => {
            this.sendMirrorError(conn, 'INTERNAL', 'workspace mirror request failed');
          });
        return;
      }
      try {
        const frame: RemoteFrame = parseRemoteFrame(raw.toString());
        if (frame.t !== 'req') {
          ws.close(4400, 'invalid client frame');
          return;
        }
        void this.dispatchRequest(conn, virtualEvent, frame);
      } catch {
        ws.close(4400, 'invalid frame');
        return;
      }
    });

    ws.on('close', () => {
      this.clients.delete(conn);
      this.disposeConnection(conn);
      this.broadcastStatus();
    });

    ws.on('error', () => {
      // 'close' follows; nothing to do
    });

    ws.send(
      JSON.stringify({
        t: 'hello',
        protocolVersion: REMOTE_PROTOCOL_VERSION,
        host: {
          platform: process.platform as 'darwin' | 'win32' | 'linux',
          home: os.homedir(),
          hostname: os.hostname(),
          appVersion: app.getVersion(),
        },
      })
    );
    if (conn.protocol === 'v2') this.sendAuthChallenge(conn);

    console.log(`[remote-host] client connected (sender ${conn.senderId})`);
    this.broadcastStatus();
  }

  private sendMirrorFrame(conn: ClientConnection, frame: WorkspaceMirrorV2Frame): void {
    if (conn.ws.readyState === conn.ws.OPEN) {
      if (conn.ws.bufferedAmount > MAX_WEBSOCKET_BUFFERED_BYTES) {
        conn.ws.close(4408, 'workspace mirror client is too slow');
        return;
      }
      conn.ws.send(JSON.stringify(frame));
    }
  }

  private sendMirrorError(
    conn: ClientConnection,
    code: WorkspaceMirrorErrorCode,
    message: string,
    requestId?: string
  ): void {
    this.sendMirrorFrame(conn, {
      t: 'error',
      ...(requestId ? { requestId } : {}),
      error: { code, message, retryable: code === 'INTERNAL' || code === 'RATE_LIMITED' },
    });
  }

  private sendMirrorServerHello(conn: ClientConnection): void {
    const service = getWorkspaceMirrorService();
    const snapshot = service.getSnapshot();
    this.sendMirrorFrame(conn, {
      t: 'serverHello',
      protocolVersion: WORKSPACE_MIRROR_PROTOCOL_VERSION,
      schemaVersion: WORKSPACE_MIRROR_SCHEMA_VERSION,
      hostId: snapshot.hostId,
      hostEpoch: snapshot.hostEpoch,
      sceneId: snapshot.sceneId,
      currentRevision: snapshot.revision,
      capabilities: [
        'scene.snapshot',
        'scene.replay',
        'scene.intent',
        'command.execute',
        'control.lease',
        'terminal.stream',
        'agent.stream',
        'resource.transfer',
        'todo.mirror',
      ],
      scopes: conn.mirrorDevice?.scopes ?? ['mirror.read'],
      bootstrapPhase: service.isBootstrapReady() ? 'live' : 'bootstrapping',
    });
  }

  private async handleMirrorMessage(
    conn: ClientConnection,
    virtualEvent: IpcMainInvokeEvent,
    raw: string
  ): Promise<void> {
    if (conn.revoked) return;
    let frame: WorkspaceMirrorV2Frame;
    try {
      frame = parseWorkspaceMirrorV2Frame(raw);
    } catch {
      // V2 sockets retain the existing RPC plane while state migrates domain by domain.
      try {
        const legacy = parseRemoteFrame(raw);
        if (legacy.t === 'req') {
          if (
            !conn.mirrorAuthenticated ||
            !conn.mirrorClient ||
            !this.hasCurrentDeviceScope(conn, 'mirror.read')
          ) {
            this.sendMirrorError(conn, 'UNAUTHORIZED', 'device authentication is required');
            conn.ws.close(4401, 'authentication failed');
            return;
          }
          await this.dispatchRequest(conn, virtualEvent, legacy);
          return;
        }
      } catch {
        // Fall through to a typed V2 protocol failure.
      }
      this.sendMirrorError(conn, 'INVALID_FRAME', 'invalid workspace mirror frame');
      return;
    }

    const service = getWorkspaceMirrorService();
    if (frame.t === 'auth.proof') {
      await this.verifyAuthProof(conn, frame);
      return;
    }
    if (!conn.mirrorAuthenticated) {
      this.sendMirrorError(conn, 'UNAUTHORIZED', 'device authentication is required');
      return;
    }
    if (frame.t === 'clientHello') {
      if (conn.mirrorClient) {
        this.sendMirrorError(conn, 'INVALID_FRAME', 'duplicate client hello');
        return;
      }
      if (frame.deviceId !== conn.mirrorDevice?.deviceId) {
        this.sendMirrorError(
          conn,
          'FORBIDDEN',
          'client hello device identity does not match proof'
        );
        return;
      }
      if (
        !frame.protocolVersions.includes(WORKSPACE_MIRROR_PROTOCOL_VERSION) ||
        !frame.schemaVersions.includes(WORKSPACE_MIRROR_SCHEMA_VERSION)
      ) {
        this.sendMirrorError(conn, 'FORBIDDEN', 'no compatible workspace mirror version');
        conn.ws.close(4406, 'mirror version mismatch');
        return;
      }
      conn.mirrorClient = frame;
      this.sendMirrorServerHello(conn);
      const currentLease = await service.getControllerLease();
      if (currentLease) {
        if (
          currentLease.holderClientId === frame.clientId &&
          currentLease.holderDeviceId === frame.deviceId &&
          currentLease.graceUntil !== null
        ) {
          await service.markControllerReconnected({
            clientId: frame.clientId,
            deviceId: frame.deviceId,
            leaseId: currentLease.leaseId,
          });
        } else {
          this.sendMirrorFrame(conn, {
            t: 'control.granted',
            coordSeq: currentLease.coordSeq,
            lease: currentLease,
          });
        }
      }
      return;
    }

    const client = conn.mirrorClient;
    if (!client) {
      this.sendMirrorError(conn, 'FORBIDDEN', 'client hello is required');
      return;
    }
    if (!this.hasCurrentDeviceScope(conn, 'mirror.read')) {
      conn.revoked = true;
      conn.mirrorAuthenticated = false;
      this.sendMirrorError(conn, 'UNAUTHORIZED', 'device credential is no longer authorized');
      conn.ws.close(4401, 'device credential revoked');
      return;
    }
    if (!service.isBootstrapReady()) {
      this.sendMirrorError(conn, 'INTERNAL', 'workspace mirror is bootstrapping');
      return;
    }

    if (frame.t === 'command.execute') {
      const descriptor = getRemoteCommandDescriptor(frame.command);
      if (descriptor?.route !== 'durable-command') {
        this.sendMirrorError(
          conn,
          descriptor?.route === 'v2-forbidden' ? 'FORBIDDEN' : 'UPGRADE_REQUIRED',
          'Workspace command is not available on the durable command plane',
          frame.operationId
        );
        return;
      }
      if (
        !client.capabilities.includes('command.execute') ||
        (descriptor.requiredCapability !== null &&
          !client.capabilities.includes(descriptor.requiredCapability))
      ) {
        this.sendMirrorError(
          conn,
          'FORBIDDEN',
          'Workspace command capability was not negotiated',
          frame.operationId
        );
        return;
      }
      if (
        !(await validateV2WorkspaceRpcPaths(
          frame.command,
          frame.args,
          workspaceRootPaths(service.getSnapshot())
        ))
      ) {
        this.sendMirrorError(
          conn,
          'FORBIDDEN',
          'Workspace command path is not authorized',
          frame.operationId
        );
        return;
      }
      const result = await getWorkspaceCommandExecutor().execute({
        frame,
        actor: { clientId: client.clientId, deviceId: client.deviceId },
        authorize: () => this.workspaceCommandAuthorizationError(conn, descriptor),
        invoke: async (command, args) => {
          const handler = getRegisteredHandler(command);
          if (!handler) throw new Error('Workspace command handler is unavailable');
          return handler(virtualEvent, ...args);
        },
      });
      this.sendMirrorFrame(conn, result);
      return;
    }

    if (frame.t === 'command.status') {
      if (!this.authorizeMirrorAction(conn, 'mirror.read', 'command.execute', frame.requestId)) {
        return;
      }
      const status = await getWorkspaceCommandExecutor().status(
        frame.operationId,
        { clientId: client.clientId, deviceId: client.deviceId },
        frame.requestId
      );
      if ('error' in status) {
        this.sendMirrorError(conn, status.error.code, status.error.message, frame.requestId);
      } else {
        this.sendMirrorFrame(conn, status.result);
      }
      return;
    }

    if (frame.t === 'coord.command') {
      const descriptor = getRemoteCommandDescriptor(frame.command);
      if (
        descriptor?.route !== 'stream/coordination' ||
        !V2_COORDINATION_HANDLER_CHANNELS.has(frame.command)
      ) {
        this.sendMirrorError(
          conn,
          'FORBIDDEN',
          'Workspace coordination command is not available',
          frame.requestId
        );
        return;
      }
      if (
        !this.hasCurrentDeviceScope(conn, descriptor.requiredScope) ||
        (descriptor.requiredCapability !== null &&
          !client.capabilities.includes(descriptor.requiredCapability))
      ) {
        this.sendMirrorError(
          conn,
          'FORBIDDEN',
          'Workspace coordination capability is required',
          frame.requestId
        );
        return;
      }
      if (descriptor.requiresController && !(await this.hasActiveMirrorControl(conn))) {
        this.sendMirrorError(
          conn,
          'LEASE_REQUIRED',
          'Workspace control is required',
          frame.requestId
        );
        return;
      }
      if (
        conn.activeCoordRequestIds.size >= MAX_CONCURRENT_REQUESTS ||
        conn.activeCoordRequestIds.has(frame.requestId)
      ) {
        this.sendMirrorError(
          conn,
          'RATE_LIMITED',
          'Too many workspace coordination requests',
          frame.requestId
        );
        return;
      }
      if (
        !(await validateV2WorkspaceRpcPaths(
          frame.command,
          frame.args,
          workspaceRootPaths(service.getSnapshot())
        ))
      ) {
        this.sendMirrorError(
          conn,
          'FORBIDDEN',
          'Workspace coordination path is not authorized',
          frame.requestId
        );
        return;
      }
      const handler = getRegisteredHandler(frame.command);
      if (!handler) {
        this.sendMirrorError(
          conn,
          'INTERNAL',
          'Workspace coordination handler is unavailable',
          frame.requestId
        );
        return;
      }
      conn.activeCoordRequestIds.add(frame.requestId);
      try {
        const result = await handler(virtualEvent, ...decodeWorkspaceCommandArgs(frame.args));
        const parsedResult = result === undefined ? undefined : JsonValueSchema.parse(result);
        this.sendMirrorFrame(conn, {
          t: 'coord.commandResult',
          requestId: frame.requestId,
          command: frame.command,
          ok: true,
          ...(parsedResult === undefined ? {} : { result: parsedResult }),
        });
      } catch {
        this.sendMirrorFrame(conn, {
          t: 'coord.commandResult',
          requestId: frame.requestId,
          command: frame.command,
          ok: false,
          error: {
            code: 'INTERNAL',
            message: 'Workspace coordination command failed',
            retryable: true,
          },
        });
      } finally {
        conn.activeCoordRequestIds.delete(frame.requestId);
      }
      return;
    }

    if (frame.t === 'resource.upload.begin') {
      if (
        !this.authorizeMirrorAction(conn, 'mirror.control', 'resource.transfer', frame.requestId)
      ) {
        return;
      }
      if (!(await this.hasActiveMirrorControl(conn))) {
        this.sendMirrorError(conn, 'FORBIDDEN', 'workspace control is required', frame.requestId);
        return;
      }
      this.beginResourceUpload(conn, frame);
      return;
    }
    if (frame.t === 'resource.upload.chunk') {
      if (
        !this.hasCurrentDeviceScope(conn, 'mirror.control') ||
        !conn.mirrorClient?.capabilities.includes('resource.transfer') ||
        !(await this.hasActiveMirrorControl(conn))
      ) {
        conn.mirrorUploads.delete(frame.uploadId);
        this.sendMirrorError(conn, 'FORBIDDEN', 'resource.transfer capability is required');
        return;
      }
      this.appendResourceUploadChunk(conn, frame);
      return;
    }
    if (frame.t === 'resource.upload.end') {
      if (
        !this.hasCurrentDeviceScope(conn, 'mirror.control') ||
        !conn.mirrorClient?.capabilities.includes('resource.transfer') ||
        !(await this.hasActiveMirrorControl(conn))
      ) {
        conn.mirrorUploads.delete(frame.uploadId);
        this.sendMirrorError(conn, 'FORBIDDEN', 'resource.transfer capability is required');
        return;
      }
      await this.finishResourceUpload(conn, frame);
      return;
    }

    if (frame.t === 'state.subscribe') {
      if (!this.authorizeMirrorAction(conn, 'mirror.read', 'scene.snapshot', frame.requestId))
        return;
      if (frame.mode !== 'snapshot' && frame.cursor) {
        const replay = service.resume(frame.cursor);
        if (replay.t === 'state.replay') {
          this.sendMirrorFrame(conn, replay);
          return;
        }
        if (replay.t === 'state.resyncRequired') {
          // The client will issue the explicit snapshot request after seeing
          // this marker. Sending a second snapshot here races that request
          // and can interleave two assemblers on one socket.
          this.sendMirrorFrame(conn, replay);
          return;
        }
      }
      const frames = createWorkspaceSnapshotFrames(service.getSnapshot(), frame.requestId);
      this.sendMirrorFrame(conn, frames.begin);
      for (const chunk of frames.chunks) this.sendMirrorFrame(conn, chunk);
      this.sendMirrorFrame(conn, frames.end);
      return;
    }

    if (frame.t === 'state.intent') {
      if (!this.authorizeMirrorAction(conn, 'mirror.control', 'scene.intent', frame.operationId)) {
        return;
      }
      const lease = await service.getControllerLease();
      const result = await service.dispatchIntent(frame, {
        clientId: client.clientId,
        deviceId: client.deviceId,
        ...(lease?.holderClientId === client.clientId && lease.holderDeviceId === client.deviceId
          ? { leaseId: lease.leaseId }
          : {}),
      });
      this.sendMirrorFrame(conn, result);
      return;
    }

    if (frame.t === 'control.request') {
      if (!this.authorizeMirrorAction(conn, 'mirror.control', 'control.lease', frame.requestId)) {
        return;
      }
      const result = await service.requestControlTransfer(
        { clientId: client.clientId, deviceId: client.deviceId },
        frame.knownCoordSeq
      );
      if (!result.granted) {
        this.sendMirrorFrame(conn, {
          t: 'error',
          requestId: frame.requestId,
          error: result.error,
        });
      }
      return;
    }

    if (frame.t === 'control.released') {
      if (!this.authorizeMirrorAction(conn, 'mirror.control', 'control.lease')) return;
      const lease = await service.getControllerLease();
      if (lease?.leaseId === frame.leaseId) {
        await service.releaseControl({
          clientId: client.clientId,
          deviceId: client.deviceId,
          leaseId: frame.leaseId,
        });
      }
      return;
    }

    if (frame.t === 'stream.attach') {
      if (!this.hasCurrentDeviceScope(conn, 'mirror.read')) {
        this.sendMirrorError(conn, 'FORBIDDEN', 'mirror.read scope is required');
        return;
      }
      this.attachMirrorStream(conn, frame);
      return;
    }

    if (frame.t === 'stream.detach') {
      this.detachMirrorStream(conn, frame.streamId);
      return;
    }

    if (frame.t === 'stream.ack') {
      const connectionKey = String(conn.senderId);
      const ackResult = this.flowController.applyAck(connectionKey, {
        streamId: frame.streamId,
        streamKind: frame.streamKind,
        entityId: frame.entityId,
        entityGeneration: frame.entityGeneration,
        consumedStreamSeq: frame.consumedStreamSeq,
        creditBytes: frame.creditBytes,
      });
      if (!ackResult.ok) {
        this.sendMirrorError(conn, 'INVALID_FRAME', ackResult.reason);
        return;
      }
      this.flushConnectionStreams(conn);
      return;
    }

    if (frame.t === 'stream.input' || frame.t === 'stream.resize') {
      if (!this.hasCurrentDeviceScope(conn, 'mirror.control')) {
        this.sendMirrorError(
          conn,
          'FORBIDDEN',
          'mirror.control scope is required',
          frame.operationId
        );
        return;
      }
      const attachment = conn.mirrorStreams.get(frame.streamId);
      if (!attachment || !this.matchesStreamAttachment(attachment, frame)) {
        this.sendMirrorError(conn, 'FORBIDDEN', 'stream is not attached', frame.operationId);
        return;
      }
      const lease = await service.getControllerLease();
      if (
        !lease ||
        lease.holderClientId !== client.clientId ||
        lease.holderDeviceId !== client.deviceId ||
        lease.graceUntil !== null
      ) {
        this.sendMirrorError(conn, 'FORBIDDEN', 'workspace control is required', frame.operationId);
        return;
      }
      if (!this.rememberStreamOperation(client.deviceId, frame.operationId)) return;
      const requesterId = remoteVirtualClientId(conn.senderId);
      const accepted =
        frame.t === 'stream.input'
          ? terminalSessionRegistry.write(
              attachment.terminalSessionId,
              getWorkspaceResourceService().resolveRemoteUris(frame.data, requesterId)
            )
          : terminalSessionRegistry.resize(attachment.terminalSessionId, frame.cols, frame.rows);
      if (!accepted) {
        this.sendMirrorError(
          conn,
          'INTERNAL',
          'terminal process is not running',
          frame.operationId
        );
      }
      return;
    }

    this.sendMirrorError(conn, 'FORBIDDEN', `unsupported client frame: ${frame.t}`);
  }

  private sendAuthChallenge(conn: ClientConnection): void {
    const nonce = crypto.randomBytes(32).toString('base64');
    const expiresAt = Date.now() + AUTH_CHALLENGE_TTL_MS;
    conn.authNonce = nonce;
    conn.authExpiresAt = expiresAt;
    this.sendMirrorFrame(conn, { t: 'auth.challenge', nonce, expiresAt });
  }

  private beginResourceUpload(
    conn: ClientConnection,
    frame: Extract<WorkspaceMirrorV2Frame, { t: 'resource.upload.begin' }>
  ): void {
    const expectedChunks = Math.max(
      1,
      Math.ceil(frame.totalBytes / WORKSPACE_MIRROR_MAX_RESOURCE_CHUNK_BYTES)
    );
    if (
      frame.totalBytes > WORKSPACE_MIRROR_MAX_RESOURCE_BYTES ||
      frame.totalChunks !== expectedChunks ||
      conn.mirrorUploads.has(frame.uploadId) ||
      conn.mirrorUploads.size >= MAX_ACTIVE_RESOURCE_UPLOADS_PER_CLIENT ||
      [...conn.mirrorUploads.values()].reduce((total, upload) => total + upload.totalBytes, 0) +
        frame.totalBytes >
        MAX_RESOURCE_UPLOAD_BYTES_PER_CLIENT
    ) {
      this.sendMirrorError(
        conn,
        'INVALID_FRAME',
        'workspace resource upload metadata is invalid',
        frame.requestId
      );
      return;
    }
    conn.mirrorUploads.set(frame.uploadId, {
      requestId: frame.requestId,
      displayName: frame.displayName,
      ...(frame.mime ? { mime: frame.mime } : {}),
      totalBytes: frame.totalBytes,
      totalChunks: frame.totalChunks,
      checksum: frame.checksum,
      chunks: [],
      receivedBytes: 0,
      nextIndex: 0,
      startedAt: Date.now(),
    });
  }

  private appendResourceUploadChunk(
    conn: ClientConnection,
    frame: Extract<WorkspaceMirrorV2Frame, { t: 'resource.upload.chunk' }>
  ): void {
    const upload = conn.mirrorUploads.get(frame.uploadId);
    if (!upload) {
      this.sendMirrorError(conn, 'INVALID_FRAME', 'unknown workspace resource upload');
      return;
    }
    try {
      if (frame.index !== upload.nextIndex || frame.index >= upload.totalChunks) {
        throw new Error('workspace resource chunks are not contiguous');
      }
      const data = Buffer.from(frame.data, 'base64');
      if (data.toString('base64') !== frame.data) {
        throw new Error('workspace resource chunk is not canonical base64');
      }
      if (
        data.byteLength > WORKSPACE_MIRROR_MAX_RESOURCE_CHUNK_BYTES ||
        upload.receivedBytes + data.byteLength > upload.totalBytes ||
        crypto.createHash('sha256').update(data).digest('hex') !== frame.checksum
      ) {
        throw new Error('workspace resource chunk checksum or size mismatch');
      }
      upload.chunks.push(data);
      upload.receivedBytes += data.byteLength;
      upload.nextIndex += 1;
    } catch (error) {
      conn.mirrorUploads.delete(frame.uploadId);
      this.sendMirrorError(
        conn,
        'INVALID_FRAME',
        error instanceof Error ? error.message : 'workspace resource chunk is invalid',
        upload.requestId
      );
    }
  }

  private async finishResourceUpload(
    conn: ClientConnection,
    frame: Extract<WorkspaceMirrorV2Frame, { t: 'resource.upload.end' }>
  ): Promise<void> {
    const upload = conn.mirrorUploads.get(frame.uploadId);
    if (!upload) {
      this.sendMirrorError(conn, 'INVALID_FRAME', 'unknown workspace resource upload');
      return;
    }
    conn.mirrorUploads.delete(frame.uploadId);
    if (
      frame.totalChunks !== upload.totalChunks ||
      upload.nextIndex !== upload.totalChunks ||
      upload.receivedBytes !== upload.totalBytes ||
      frame.checksum !== upload.checksum
    ) {
      this.sendMirrorError(
        conn,
        'INVALID_FRAME',
        'workspace resource upload is incomplete',
        upload.requestId
      );
      return;
    }
    const data = Buffer.concat(upload.chunks);
    if (crypto.createHash('sha256').update(data).digest('hex') !== upload.checksum) {
      this.sendMirrorError(
        conn,
        'INVALID_FRAME',
        'workspace resource upload checksum mismatch',
        upload.requestId
      );
      return;
    }
    try {
      const reference = await getWorkspaceResourceService().stageBuffer(
        data,
        upload.displayName,
        remoteVirtualClientId(conn.senderId),
        upload.mime
      );
      this.sendMirrorFrame(conn, {
        t: 'resource.upload.result',
        requestId: upload.requestId,
        uploadId: frame.uploadId,
        reference,
      });
    } catch (error) {
      console.warn('[remote-host] workspace resource upload failed:', error);
      this.sendMirrorError(conn, 'INTERNAL', 'workspace resource upload failed', upload.requestId);
    }
  }

  private async verifyAuthProof(
    conn: ClientConnection,
    frame: Extract<WorkspaceMirrorV2Frame, { t: 'auth.proof' }>
  ): Promise<void> {
    if (
      conn.mirrorAuthenticated ||
      !conn.authNonce ||
      frame.nonce !== conn.authNonce ||
      Date.now() > conn.authExpiresAt
    ) {
      this.sendMirrorError(conn, 'UNAUTHORIZED', 'authentication challenge is invalid or expired');
      conn.ws.close(4401, 'authentication failed');
      return;
    }
    const store = this.deviceStore;
    if (!store) {
      this.sendMirrorError(conn, 'INTERNAL', 'paired-device store is unavailable');
      return;
    }
    const existing = store.get(frame.deviceId);
    if (existing?.revokedAt) {
      this.sendMirrorError(conn, 'UNAUTHORIZED', 'device credential is revoked');
      conn.ws.close(4401, 'authentication failed');
      return;
    }
    const publicKey = existing?.publicKey ?? frame.publicKey;
    if (
      !existing &&
      (Date.now() > this.pairingExpiresAt || this.pairingAttempts >= MAX_PAIRING_ATTEMPTS)
    ) {
      this.sendMirrorError(conn, 'UNAUTHORIZED', 'device pairing window is closed');
      conn.ws.close(4401, 'authentication failed');
      return;
    }
    if (!existing) this.pairingAttempts += 1;
    if (!publicKey) {
      this.sendMirrorError(conn, 'UNAUTHORIZED', 'device is not paired');
      conn.ws.close(4401, 'authentication failed');
      return;
    }
    let verified = false;
    try {
      verified = crypto.verify(
        null,
        Buffer.from(frame.nonce, 'utf8'),
        crypto.createPublicKey({
          key: Buffer.from(publicKey, 'base64'),
          type: 'spki',
          format: 'der',
        }),
        Buffer.from(frame.signature, 'base64')
      );
    } catch {
      verified = false;
    }
    if (!verified) {
      this.sendMirrorError(conn, 'UNAUTHORIZED', 'device signature is invalid');
      conn.ws.close(4401, 'authentication failed');
      return;
    }
    const device = existing ?? (await store.pair(frame.deviceId, publicKey));
    if (!existing) this.pairingExpiresAt = 0;
    conn.authNonce = null;
    conn.authExpiresAt = 0;
    conn.mirrorDevice = device;
    conn.mirrorAuthenticated = true;
  }

  private openPairingWindow(): void {
    this.pairingExpiresAt = Date.now() + PAIRING_WINDOW_MS;
    this.pairingAttempts = 0;
  }

  private attachMirrorStream(
    conn: ClientConnection,
    frame: Extract<WorkspaceMirrorV2Frame, { t: 'stream.attach' }>
  ): void {
    const client = conn.mirrorClient;
    if (!client) return;
    const requiredCapability = frame.streamKind === 'terminal' ? 'terminal.stream' : 'agent.stream';
    if (!client.capabilities.includes(requiredCapability)) {
      this.sendMirrorError(
        conn,
        'FORBIDDEN',
        `${requiredCapability} was not negotiated`,
        frame.streamId
      );
      return;
    }

    const snapshot = getWorkspaceMirrorService().getSnapshot();
    const terminalSessionId =
      frame.streamKind === 'terminal'
        ? snapshot.terminals.sessions[frame.entityId]?.id
        : snapshot.agents.sessions[frame.entityId]?.terminalSessionId;
    const generation =
      frame.streamKind === 'terminal'
        ? snapshot.terminals.sessions[frame.entityId]?.generation
        : snapshot.agents.sessions[frame.entityId]?.generation;
    if (
      !terminalSessionId ||
      generation !== frame.entityGeneration ||
      !terminalSessionRegistry.has(terminalSessionId)
    ) {
      this.sendMirrorError(conn, 'CONFLICT', 'terminal process is not running', frame.streamId);
      return;
    }

    this.detachMirrorStream(conn, frame.streamId);
    const subscriberId = `remote:${conn.senderId}:${frame.streamId}`;
    const attachment: MirrorStreamAttachment = {
      streamId: frame.streamId,
      streamKind: frame.streamKind,
      entityId: frame.entityId,
      entityGeneration: frame.entityGeneration,
      terminalSessionId,
      subscriberId,
    };
    conn.mirrorStreams.set(frame.streamId, attachment);
    try {
      const connectionKey = String(conn.senderId);
      const flowAttach = this.flowController.attach(connectionKey, {
        streamId: frame.streamId,
        streamKind: frame.streamKind,
        entityId: frame.entityId,
        entityGeneration: frame.entityGeneration,
      });
      if (!flowAttach.ok) {
        conn.mirrorStreams.delete(frame.streamId);
        this.sendMirrorError(
          conn,
          'RATE_LIMITED',
          'stream attachment limit reached',
          frame.streamId
        );
        return;
      }
      const result = terminalSessionRegistry.attach(terminalSessionId, {
        subscriberId,
        afterStreamSeq: frame.fromStreamSeq,
        onEvent: (event) => this.sendTerminalStreamEvent(conn, attachment, event),
      });
      this.sendMirrorFrame(conn, {
        t: 'stream.attached',
        streamId: frame.streamId,
        streamKind: frame.streamKind,
        entityId: frame.entityId,
        entityGeneration: frame.entityGeneration,
        sceneRevision: snapshot.revision,
        reset: result.reset,
        retainedFromSeq: result.retainedFromSeq,
        currentStreamSeq: result.currentStreamSeq,
        replayedEventCount: result.replayedEventCount,
      });
      this.flushConnectionStreams(conn);
    } catch {
      conn.mirrorStreams.delete(frame.streamId);
      terminalSessionRegistry.detach(terminalSessionId, subscriberId);
      this.sendMirrorError(conn, 'CONFLICT', 'terminal attach failed', frame.streamId);
    }
  }

  private sendTerminalStreamEvent(
    conn: ClientConnection,
    attachment: MirrorStreamAttachment,
    event: TerminalStreamEvent
  ): void {
    if (conn.mirrorStreams.get(attachment.streamId) !== attachment) return;
    const sceneRevision = getWorkspaceMirrorService().getSnapshot().revision;
    const identity = {
      streamId: attachment.streamId,
      streamKind: attachment.streamKind,
      entityId: attachment.entityId,
      entityGeneration: attachment.entityGeneration,
    } as const;
    if (event.type === 'stream.data') {
      const connectionKey = String(conn.senderId);
      const decision = this.flowController.enqueueChunk(connectionKey, {
        streamId: attachment.streamId,
        streamKind: attachment.streamKind,
        entityId: attachment.entityId,
        entityGeneration: attachment.entityGeneration,
        streamSeq: event.streamSeq,
        encoding: 'utf8',
        data: event.data,
        sceneRevision,
      });
      if (decision.action === 'reset') {
        this.sendMirrorFrame(conn, {
          t: 'stream.reset',
          ...identity,
          reason: 'backpressure-overflow',
          nextStreamSeq: decision.nextStreamSeq,
          sceneRevision,
        });
        this.detachMirrorStream(conn, attachment.streamId);
        return;
      }
      if (decision.action === 'send') {
        this.sendMirrorFrame(conn, {
          t: 'stream.chunk',
          ...identity,
          sceneRevision,
          streamSeq: decision.chunk.streamSeq,
          encoding: decision.chunk.encoding,
          data: decision.chunk.data,
        });
        return;
      }
      this.flushConnectionStreams(conn);
      return;
    }
    if (event.type === 'stream.reset') {
      this.sendMirrorFrame(conn, {
        t: 'stream.reset',
        ...identity,
        reason: event.reason === 'overflow' ? 'retention-overflow' : 'sequence-gap',
        nextStreamSeq: event.retainedFromSeq,
        sceneRevision,
      });
      return;
    }
    this.sendMirrorFrame(conn, {
      t: 'stream.closed',
      ...identity,
      finalStreamSeq: event.streamSeq,
      reason: event.reason === 'destroyed' ? 'closed' : 'exited',
      exitCode: event.exitCode,
    });
  }

  private flushConnectionStreams(conn: ClientConnection): void {
    const connectionKey = String(conn.senderId);
    const chunks = this.flowController.flush(connectionKey);
    const sceneRevision = getWorkspaceMirrorService().getSnapshot().revision;
    for (const chunk of chunks) {
      this.sendMirrorFrame(conn, {
        t: 'stream.chunk',
        streamId: chunk.streamId,
        streamKind: chunk.streamKind,
        entityId: chunk.entityId,
        entityGeneration: chunk.entityGeneration,
        sceneRevision,
        streamSeq: chunk.streamSeq,
        encoding: chunk.encoding,
        data: chunk.data,
      });
    }
  }

  private matchesStreamAttachment(
    attachment: MirrorStreamAttachment,
    frame: Extract<WorkspaceMirrorV2Frame, { t: 'stream.input' | 'stream.resize' }>
  ): boolean {
    return (
      attachment.streamKind === frame.streamKind &&
      attachment.entityId === frame.entityId &&
      attachment.entityGeneration === frame.entityGeneration
    );
  }

  private detachMirrorStream(conn: ClientConnection, streamId: string): void {
    const attachment = conn.mirrorStreams.get(streamId);
    if (!attachment) return;
    conn.mirrorStreams.delete(streamId);
    terminalSessionRegistry.detach(attachment.terminalSessionId, attachment.subscriberId);
    const connectionKey = String(conn.senderId);
    this.flowController.detach(connectionKey, {
      streamId: attachment.streamId,
      streamKind: attachment.streamKind,
      entityId: attachment.entityId,
      entityGeneration: attachment.entityGeneration,
    });
  }

  private rememberStreamOperation(deviceId: string, operationId: string): boolean {
    const key = `${deviceId}:${operationId}`;
    if (this.streamOperationLedger.has(key)) return false;
    this.streamOperationLedger.set(key, true);
    while (this.streamOperationLedger.size > MAX_STREAM_OPERATION_LEDGER) {
      const oldest = this.streamOperationLedger.keys().next().value;
      if (oldest === undefined) break;
      this.streamOperationLedger.delete(oldest);
    }
    return true;
  }

  private broadcastMirrorFrame(frame: WorkspaceMirrorV2Frame): void {
    for (const conn of this.clients) {
      if (
        conn.protocol === 'v2' &&
        conn.mirrorClient &&
        this.hasCurrentDeviceScope(conn, 'mirror.read')
      ) {
        this.sendMirrorFrame(conn, frame);
      }
    }
  }

  private async dispatchRequest(
    conn: ClientConnection,
    virtualEvent: IpcMainInvokeEvent,
    frame: RemoteReqFrame
  ): Promise<void> {
    let dispatchArgs = frame.args;
    const reply = (ok: boolean, result?: unknown, error?: string): void => {
      if (conn.ws.readyState === conn.ws.OPEN) {
        const payload = JSON.stringify({ t: 'res', id: frame.id, ok, result, error });
        if (
          conn.protocol === 'v2' &&
          Buffer.byteLength(payload, 'utf8') > MAX_REMOTE_RESPONSE_BYTES
        ) {
          conn.ws.send(
            JSON.stringify({
              t: 'res',
              id: frame.id,
              ok: false,
              error: 'remote response exceeds the configured size limit',
            })
          );
          return;
        }
        conn.ws.send(payload);
      }
    };

    const now = Date.now();
    if (now - conn.requestWindowStartedAt >= REQUEST_RATE_WINDOW_MS) {
      conn.requestWindowStartedAt = now;
      conn.requestCount = 0;
    }
    conn.requestCount += 1;
    if (conn.requestCount > MAX_REQUESTS_PER_WINDOW) {
      reply(false, undefined, 'remote request rate limit exceeded');
      return;
    }
    if (conn.activeRequestIds.size >= MAX_CONCURRENT_REQUESTS) {
      reply(false, undefined, 'too many concurrent remote requests');
      return;
    }
    if (conn.activeRequestIds.has(frame.id)) {
      reply(false, undefined, 'duplicate active remote request id');
      return;
    }

    if (conn.protocol === 'v1' && frame.ch.startsWith('workspaceMirror:')) {
      reply(false, undefined, `no handler for channel: ${frame.ch}`);
      return;
    }
    if (conn.protocol === 'v2') {
      if (
        conn.revoked ||
        !conn.mirrorAuthenticated ||
        !conn.mirrorClient ||
        !this.hasCurrentDeviceScope(conn, 'mirror.read')
      ) {
        reply(false, undefined, 'device authentication is required');
        return;
      }
      const descriptor = getRemoteCommandDescriptor(frame.ch);
      if (!descriptor) {
        reply(false, undefined, `no remote command descriptor for channel: ${frame.ch}`);
        return;
      }
      if (descriptor.route === 'durable-command') {
        reply(false, undefined, 'use command.execute for durable workspace commands');
        return;
      }
      if (descriptor.route === 'stream/coordination') {
        reply(false, undefined, 'use the authenticated workspace coordination plane');
        return;
      }
      if (descriptor.route === 'v2-forbidden') {
        reply(false, undefined, 'channel is not available in workspace mirror V2');
        return;
      }
      if (!this.hasCurrentDeviceScope(conn, descriptor.requiredScope)) {
        reply(false, undefined, `${descriptor.requiredScope} scope is required`);
        return;
      }
      if (
        descriptor.requiredCapability !== null &&
        !conn.mirrorClient.capabilities.includes(descriptor.requiredCapability)
      ) {
        reply(false, undefined, `${descriptor.requiredCapability} capability was not negotiated`);
        return;
      }
      const wireArgs = JsonValueSchema.array().safeParse(frame.args);
      if (!wireArgs.success) {
        reply(false, undefined, 'remote request arguments are invalid');
        return;
      }
      const requestSchema = getRemoteReadOnlyRequestSchema(frame.ch);
      if (!requestSchema) {
        reply(false, undefined, `read-only request schema is missing for channel: ${frame.ch}`);
        return;
      }
      const parsedArgs = requestSchema.safeParse(decodeWorkspaceCommandArgs(wireArgs.data));
      if (!parsedArgs.success) {
        reply(false, undefined, 'remote request arguments are invalid');
        return;
      }
      dispatchArgs = parsedArgs.data;
      if (
        !(await validateV2WorkspaceRpcPaths(
          frame.ch,
          dispatchArgs,
          workspaceRootPaths(getWorkspaceMirrorService().getSnapshot())
        ))
      ) {
        reply(false, undefined, 'workspace path is not authorized');
        return;
      }
    }

    const handler = getRegisteredHandler(frame.ch);
    if (!handler) {
      reply(false, undefined, `no handler for channel: ${frame.ch}`);
      return;
    }
    conn.activeRequestIds.add(frame.id);
    try {
      const result = await handler(virtualEvent, ...dispatchArgs);
      if (conn.protocol === 'v2') {
        const wireResult = result === undefined ? undefined : JSON.parse(JSON.stringify(result));
        const parsedResult = REMOTE_READ_ONLY_RESULT_SCHEMA.safeParse(wireResult);
        if (!parsedResult.success) {
          reply(false, undefined, 'remote response failed schema validation');
          return;
        }
        reply(true, parsedResult.data);
      } else {
        reply(true, result);
      }
    } catch (err) {
      // V2 compatibility RPCs may execute filesystem/git handlers whose
      // native errors contain absolute paths, command output, or credentials.
      // Keep those details on the host and expose only a stable transport
      // error to the paired client.
      reply(
        false,
        undefined,
        conn.protocol === 'v2'
          ? 'remote request failed'
          : err instanceof Error
            ? err.message
            : String(err)
      );
    } finally {
      conn.activeRequestIds.delete(frame.id);
    }
  }

  private disposeConnection(conn: ClientConnection): void {
    if (conn.mirrorClient) {
      const client = conn.mirrorClient;
      let service: ReturnType<typeof getWorkspaceMirrorService> | null = null;
      try {
        service = getWorkspaceMirrorService();
      } catch {
        // Runtime teardown may complete before a final WebSocket close callback.
      }
      const hasReplacement = [...this.clients].some(
        (candidate) =>
          candidate !== conn &&
          candidate.mirrorClient?.clientId === client.clientId &&
          candidate.mirrorClient.deviceId === client.deviceId &&
          candidate.ws.readyState === candidate.ws.OPEN
      );
      if (service && !hasReplacement) {
        void service.markControllerDisconnectedForClient({
          clientId: client.clientId,
          deviceId: client.deviceId,
        });
      }
    }
    for (const streamId of [...conn.mirrorStreams.keys()]) {
      this.detachMirrorStream(conn, streamId);
    }
    const connectionKey = String(conn.senderId);
    this.flowController.dropConnection(connectionKey);
    conn.mirrorUploads.clear();
    const callbacks = conn.destroyedCallbacks;
    conn.destroyedCallbacks = [];
    for (const callback of callbacks) {
      try {
        callback();
      } catch (err) {
        console.warn('[remote-host] destroyed callback error:', err);
      }
    }
    if (conn.ws.readyState === conn.ws.OPEN) {
      conn.ws.close();
    }
  }

  private hasCurrentDeviceScope(conn: ClientConnection, scope: WorkspaceMirrorScope): boolean {
    if (conn.revoked || !conn.mirrorAuthenticated || !conn.mirrorDevice) return false;
    const current = this.deviceStore?.get(conn.mirrorDevice.deviceId);
    return Boolean(
      current &&
        current.revokedAt === null &&
        current.publicKey === conn.mirrorDevice.publicKey &&
        current.scopes.includes(scope)
    );
  }

  private authorizeMirrorAction(
    conn: ClientConnection,
    scope: WorkspaceMirrorScope,
    capability: WorkspaceMirrorCapability,
    requestId?: string
  ): boolean {
    if (!this.hasCurrentDeviceScope(conn, scope)) {
      this.sendMirrorError(conn, 'FORBIDDEN', `${scope} scope is required`, requestId);
      return false;
    }
    if (!conn.mirrorClient?.capabilities.includes(capability)) {
      this.sendMirrorError(
        conn,
        'FORBIDDEN',
        `${capability} capability was not negotiated`,
        requestId
      );
      return false;
    }
    return true;
  }

  private async workspaceCommandAuthorizationError(
    conn: ClientConnection,
    descriptor: DurableRemoteCommandDescriptor
  ): Promise<WorkspaceMirrorError | null> {
    if (!this.hasCurrentDeviceScope(conn, descriptor.requiredScope)) {
      return {
        code: 'FORBIDDEN',
        message: `${descriptor.requiredScope} scope is required`,
        retryable: false,
      };
    }
    if (
      !conn.mirrorClient?.capabilities.includes('command.execute') ||
      (descriptor.requiredCapability !== null &&
        !conn.mirrorClient.capabilities.includes(descriptor.requiredCapability))
    ) {
      return {
        code: 'FORBIDDEN',
        message: 'Workspace command capability was not negotiated',
        retryable: false,
      };
    }
    if (!(await this.hasActiveMirrorControl(conn))) {
      return {
        code: 'LEASE_REQUIRED',
        message: 'Workspace control is required',
        retryable: true,
      };
    }
    return null;
  }

  private async hasActiveMirrorControl(conn: ClientConnection): Promise<boolean> {
    const client = conn.mirrorClient;
    if (!client) return false;
    const lease = await getWorkspaceMirrorService().getControllerLease();
    return Boolean(
      lease &&
        lease.holderClientId === client.clientId &&
        lease.holderDeviceId === client.deviceId &&
        lease.graceUntil === null
    );
  }

  private checkHeartbeats(): void {
    for (const conn of [...this.clients]) {
      const now = Date.now();
      for (const [uploadId, upload] of conn.mirrorUploads) {
        if (now - upload.startedAt >= RESOURCE_UPLOAD_TTL_MS) {
          conn.mirrorUploads.delete(uploadId);
          this.sendMirrorError(
            conn,
            'INVALID_FRAME',
            'workspace resource upload expired',
            upload.requestId
          );
        }
      }
      if (!conn.alive) {
        conn.ws.terminate();
        continue;
      }
      conn.alive = false;
      try {
        conn.ws.ping();
      } catch {
        conn.ws.terminate();
      }
    }
  }

  private broadcastStatus(): void {
    const status = this.getStatus();
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.webContents.isDestroyed()) {
        window.webContents.send(IPC_CHANNELS.REMOTE_HOST_STATUS_CHANGED, status);
      }
    }
  }
}

export const remoteHostServer = new RemoteHostServer();

/**
 * Convenience for broadcast call sites outside the remote module. Safe to
 * call whether or not the host server is running.
 */
export function broadcastToRemoteClients(channel: string, ...args: unknown[]): void {
  remoteHostServer.broadcastToClients(channel, ...args);
}
