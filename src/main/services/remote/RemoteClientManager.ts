import { createHash, createPrivateKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, posix, win32 } from 'node:path';
import {
  type ControllerLease,
  canonicalJson,
  decodeWorkspaceCommandArgs,
  encodeWorkspaceCommandArgs,
  IPC_CHANNELS,
  REMOTE_FS_READ_FILE_CHANNEL,
  REMOTE_PROTOCOL_VERSION,
  REMOTE_TOKEN_HEADER,
  type RemoteClientStatus,
  type RemoteConnectOptions,
  type RemoteFrame,
  type RemoteHostInfo,
  type StateIntentResultFrame,
  type TerminalAttachResult,
  WORKSPACE_MIRROR_MAX_RESOURCE_BYTES,
  WORKSPACE_MIRROR_MAX_RESOURCE_CHUNK_BYTES,
  WORKSPACE_MIRROR_PROTOCOL_VERSION,
  WORKSPACE_MIRROR_SCHEMA_VERSION,
  WORKSPACE_MIRROR_SUBPROTOCOL,
  type WorkspaceCommandExecuteFrame,
  type WorkspaceMirrorError,
  type WorkspaceMirrorV2Frame,
  type WorkspaceResourceReference,
  type WorkspaceSceneEvent,
  type WorkspaceSceneIntent,
  WorkspaceSceneIntentSchema,
  type WorkspaceSceneSnapshot,
} from '@shared/types';
import type { WebContents } from 'electron';
import WebSocket from 'ws';
import { applyWorkspaceSceneEvent } from '../workspace/WorkspaceMirrorService';
import type { RemoteDeviceIdentity } from './RemoteDeviceIdentityStore';
import { getRemoteCommandDescriptor, getRemoteV2EventCapability } from './remoteCommandManifest';
import { parseRemoteFrame } from './remoteFrameCodec';
import { parseWorkspaceMirrorV2Frame, WorkspaceSnapshotAssembler } from './workspaceMirrorFrames';

const CONNECT_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 30_000;
const MAX_BUFFERED_MIRROR_EVENTS = 10_000;
const WORKSPACE_COMMAND_VERSION = 1;
const MIRROR_CLIENT_CAPABILITIES = [
  'scene.snapshot',
  'scene.replay',
  'scene.intent',
  'command.execute',
  'control.lease',
  'terminal.stream',
  'agent.stream',
  'resource.transfer',
  'todo.mirror',
] as const;
const MIRROR_CLIENT_CAPABILITY_SET = new Set<string>(MIRROR_CLIENT_CAPABILITIES);
const MIRROR_COORDINATION_COMMAND_CHANNELS = new Set<string>([
  IPC_CHANNELS.FILE_WATCH_START,
  IPC_CHANNELS.FILE_WATCH_STOP,
  IPC_CHANNELS.WORKSPACE_MIRROR_MATERIALIZE_RESOURCE,
]);

/**
 * Remote PTY ids are prefixed on the client so they can never collide with
 * local PtyManager ids (both sides use a plain `pty-<n>` counter).
 */
const REMOTE_PTY_PREFIX = 'remote:';
const TERMINAL_ID_ARG_CHANNELS = new Set<string>([
  IPC_CHANNELS.TERMINAL_WRITE,
  IPC_CHANNELS.TERMINAL_RESIZE,
  IPC_CHANNELS.TERMINAL_DESTROY,
  IPC_CHANNELS.TERMINAL_ATTACH,
  IPC_CHANNELS.TERMINAL_DETACH,
  IPC_CHANNELS.TERMINAL_GET_ACTIVITY,
]);

function stripRemotePtyId(id: unknown): unknown {
  return typeof id === 'string' && id.startsWith(REMOTE_PTY_PREFIX)
    ? id.slice(REMOTE_PTY_PREFIX.length)
    : id;
}

export class RemoteWorkspaceCommandError extends Error {
  readonly code: WorkspaceMirrorError['code'];
  readonly retryable: boolean;
  readonly details: WorkspaceMirrorError['details'];

  constructor(error: WorkspaceMirrorError) {
    super(`${error.code}: ${error.message}`);
    this.name = 'RemoteWorkspaceCommandError';
    this.code = error.code;
    this.retryable = error.retryable;
    this.details = error.details ? structuredClone(error.details) : undefined;
  }
}

function digestWorkspaceCommand(
  command: string,
  commandVersion: number,
  args: WorkspaceCommandExecuteFrame['args']
): string {
  return createHash('sha256')
    .update(canonicalJson({ command, commandVersion, args }))
    .digest('hex');
}

export function isRemoteHostPathWithinRoot(
  candidate: string,
  root: string,
  platform: RemoteHostInfo['platform']
): boolean {
  const pathApi = platform === 'win32' ? win32 : posix;
  if (!pathApi.isAbsolute(candidate) || !pathApi.isAbsolute(root)) return false;
  const resolvedCandidate = pathApi.normalize(pathApi.resolve(candidate));
  const resolvedRoot = pathApi.normalize(pathApi.resolve(root));
  if (resolvedCandidate === resolvedRoot) return true;
  const rootPrefix = resolvedRoot.endsWith(pathApi.sep)
    ? resolvedRoot
    : `${resolvedRoot}${pathApi.sep}`;
  return resolvedCandidate.startsWith(rootPrefix);
}

export function restoreMirrorCommandResult(
  frame: WorkspaceCommandExecuteFrame,
  result: unknown
): unknown {
  if (
    frame.command === IPC_CHANNELS.WORKSPACE_MIRROR_ADOPT_ENTITY &&
    result &&
    typeof result === 'object' &&
    !Array.isArray(result) &&
    'ok' in result &&
    result.ok === true &&
    'reservation' in result &&
    result.reservation &&
    typeof result.reservation === 'object' &&
    !Array.isArray(result.reservation) &&
    'entityId' in result.reservation &&
    !('path' in result.reservation)
  ) {
    const path = decodeWorkspaceCommandArgs(frame.args)[2];
    if (typeof path !== 'string') {
      throw new Error('remote entity adoption result is missing its target path');
    }
    return {
      ...result,
      reservation: { ...result.reservation, path, normalizedPath: path },
    };
  }
  if (
    frame.command === IPC_CHANNELS.WORKSPACE_MIRROR_REGISTER_ENTITY &&
    result &&
    typeof result === 'object' &&
    !Array.isArray(result) &&
    'entityId' in result &&
    !('path' in result)
  ) {
    const args = decodeWorkspaceCommandArgs(frame.args);
    const path = args[1];
    if (typeof path !== 'string') {
      throw new Error('remote entity result is missing its target path');
    }
    return { ...result, path, normalizedPath: path };
  }
  if (
    frame.command !== IPC_CHANNELS.GIT_CLONE ||
    !result ||
    typeof result !== 'object' ||
    Array.isArray(result) ||
    !('success' in result) ||
    result.success !== true ||
    'path' in result
  ) {
    return result;
  }
  const targetPath = decodeWorkspaceCommandArgs(frame.args)[1];
  if (typeof targetPath !== 'string') {
    throw new Error('remote clone result is missing its target path');
  }
  return { ...result, path: targetPath };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

interface PendingMirrorIntent {
  intent: WorkspaceSceneIntent;
  resolve: (value: StateIntentResultFrame) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

interface PendingMirrorCommand {
  frame: WorkspaceCommandExecuteFrame;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout | null;
}

interface PendingMirrorCoordination {
  command: string;
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

interface PendingMirrorControl {
  requestId: string;
  resolve: (value: ControllerLease) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

interface PendingResourceUpload {
  uploadId: string;
  resolve: (value: WorkspaceResourceReference) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

interface MirrorStreamAttachment {
  streamId: string;
  streamKind: 'terminal' | 'agent';
  entityId: string;
  entityGeneration: number;
  terminalSessionId: string;
  lastStreamSeq: number;
  pendingAttach?: {
    resolve: (value: TerminalAttachResult) => void;
    reject: (reason: Error) => void;
    timer: NodeJS.Timeout;
  };
  closedDuringAttach?: boolean;
}

interface Connection {
  wc: WebContents;
  options: RemoteConnectOptions;
  ws: WebSocket | null;
  state: RemoteClientStatus['state'];
  hostInfo: RemoteHostInfo | null;
  error?: string;
  pending: Map<number, PendingRequest>;
  nextReqId: number;
  reconnectTimer: NodeJS.Timeout | null;
  reconnectAttempt: number;
  disposed: boolean;
  mirrorClientId: string;
  mirrorDeviceId: string;
  mirrorSyncPhase: RemoteClientStatus['mirrorSyncPhase'];
  mirrorSnapshot: WorkspaceSceneSnapshot | null;
  mirrorAssembler: WorkspaceSnapshotAssembler;
  mirrorSnapshotInProgress: boolean;
  mirrorBufferedEvents: WorkspaceSceneEvent[];
  mirrorCoordSeq: number;
  mirrorLease: ControllerLease | null;
  mirrorPendingIntents: Map<string, PendingMirrorIntent>;
  mirrorPendingCommands: Map<string, PendingMirrorCommand>;
  mirrorPendingCoordination: Map<string, PendingMirrorCoordination>;
  mirrorCommandSequence: number;
  mirrorPendingControls: Map<string, PendingMirrorControl>;
  mirrorPendingResourceUploads: Map<string, PendingResourceUpload>;
  mirrorStreams: Map<string, MirrorStreamAttachment>;
  terminalStreamCursors: Map<string, number>;
  mirrorLastResyncReason?: string;
  negotiatedProtocol?: 'v1' | 'v2';
  mirrorIdentity: RemoteDeviceIdentity;
  persistentRequests: Map<string, { channel: string; args: unknown[] }>;
  /** Incremented for every socket attempt so stale callbacks are inert. */
  socketGeneration: number;
}

function createEphemeralIdentity(deviceId: string): RemoteDeviceIdentity {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    deviceId,
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  };
}

/**
 * Manages outgoing connections to remote EnsoAI hosts. One connection per
 * window (webContents). While attached, whitelisted IPC invokes from that
 * window are forwarded here instead of executing locally.
 */
export class RemoteClientManager {
  private connections = new Map<number, Connection>();
  private resourceConnectionById = new Map<string, number>();

  isAttached(senderId: number): boolean {
    return this.connections.has(senderId);
  }

  shouldForward(senderId: number, channel: string): boolean {
    const conn = this.connections.get(senderId);
    if (!conn) return false;
    if (
      channel === IPC_CHANNELS.WORKSPACE_MIRROR_GET_BOOTSTRAP_STATUS ||
      channel === IPC_CHANNELS.WORKSPACE_MIRROR_COMPLETE_LEGACY_IMPORT ||
      channel === IPC_CHANNELS.FILE_SAVE_TO_TEMP ||
      channel === IPC_CHANNELS.TODO_MIGRATE
    ) {
      return false;
    }
    if (channel.startsWith('workspaceMirror:')) {
      return conn.negotiatedProtocol === 'v2';
    }
    return true;
  }

  getStatus(senderId: number): RemoteClientStatus {
    const conn = this.connections.get(senderId);
    if (!conn) {
      return { state: 'disconnected', host: null, port: null, hostInfo: null };
    }
    return {
      state: conn.state,
      host: conn.options.host,
      port: conn.options.port,
      hostInfo: conn.hostInfo,
      mirrorSyncPhase: conn.mirrorSyncPhase,
      mirrorRevision: conn.mirrorSnapshot?.revision,
      mirrorProtocol: conn.negotiatedProtocol,
      mirrorController: conn.mirrorLease,
      mirrorOwnsControl: Boolean(
        conn.mirrorLease?.holderClientId === conn.mirrorClientId &&
          conn.mirrorLease.holderDeviceId === conn.mirrorDeviceId &&
          conn.mirrorLease.graceUntil === null
      ),
      mirrorLastResyncReason: conn.mirrorLastResyncReason,
      error: conn.error,
    };
  }

  /** First live/remote-attached connection snapshot (diagnostics / e2e). */
  getPrimaryRemoteSnapshot(): {
    status: RemoteClientStatus;
    snapshot: WorkspaceSceneSnapshot | null;
  } | null {
    for (const conn of this.connections.values()) {
      if (conn.state !== 'connected') continue;
      return {
        status: this.getStatus(conn.wc.id),
        snapshot: conn.mirrorSnapshot ? structuredClone(conn.mirrorSnapshot) : null,
      };
    }
    return null;
  }

  listConnectionStatuses(): RemoteClientStatus[] {
    return [...this.connections.keys()].map((id) => this.getStatus(id));
  }

  async connect(
    wc: WebContents,
    options: RemoteConnectOptions,
    identity?: RemoteDeviceIdentity
  ): Promise<RemoteClientStatus> {
    // Replace any existing connection for this window
    this.disconnect(wc.id);

    const deviceId = options.deviceId ?? identity?.deviceId ?? `device-${randomUUID()}`;
    const mirrorIdentity = identity ?? createEphemeralIdentity(deviceId);
    if (mirrorIdentity.deviceId !== deviceId) throw new Error('Remote device identity mismatch');
    const conn: Connection = {
      wc,
      options,
      ws: null,
      state: 'connecting',
      hostInfo: null,
      pending: new Map(),
      nextReqId: 1,
      reconnectTimer: null,
      reconnectAttempt: 0,
      disposed: false,
      mirrorClientId: options.clientId ?? `client-${randomUUID()}`,
      mirrorDeviceId: deviceId,
      mirrorSyncPhase: 'disconnected',
      mirrorSnapshot: null,
      mirrorAssembler: new WorkspaceSnapshotAssembler(),
      mirrorSnapshotInProgress: false,
      mirrorBufferedEvents: [],
      mirrorCoordSeq: 0,
      mirrorLease: null,
      mirrorPendingIntents: new Map(),
      mirrorPendingCommands: new Map(),
      mirrorPendingCoordination: new Map(),
      mirrorCommandSequence: 0,
      mirrorPendingControls: new Map(),
      mirrorPendingResourceUploads: new Map(),
      mirrorStreams: new Map(),
      terminalStreamCursors: new Map(),
      mirrorLastResyncReason: undefined,
      negotiatedProtocol: undefined,
      mirrorIdentity,
      persistentRequests: new Map(),
      socketGeneration: 0,
    };
    this.connections.set(wc.id, conn);
    wc.once('destroyed', () => this.disconnect(wc.id));
    this.pushStatus(conn);

    try {
      await this.openSocket(conn);
      conn.state = 'connected';
      conn.error = undefined;
      conn.reconnectAttempt = 0;
      this.pushStatus(conn);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.disposeConnection(conn);
      this.connections.delete(wc.id);
      if (!wc.isDestroyed()) {
        conn.state = 'disconnected';
        conn.error = message;
        this.pushStatus(conn);
      }
      return {
        state: 'disconnected',
        host: options.host,
        port: options.port,
        hostInfo: null,
        error: message,
      };
    }

    return this.getStatus(wc.id);
  }

  disconnect(senderId: number): void {
    const conn = this.connections.get(senderId);
    if (!conn) {
      return;
    }
    this.connections.delete(senderId);
    this.disposeConnection(conn);
    if (!conn.wc.isDestroyed()) {
      conn.state = 'disconnected';
      this.pushStatus(conn);
    }
  }

  /** Whether any window currently has an active (or reconnecting) remote connection */
  hasActiveConnection(): boolean {
    for (const conn of this.connections.values()) {
      if (conn.ws && conn.ws.readyState === WebSocket.OPEN) {
        return true;
      }
    }
    return false;
  }

  /**
   * Send a request over any active connection. Used by main-process callers
   * without a renderer context (e.g. custom protocol handlers fetching
   * preview bytes for the attached window).
   */
  requestViaAnyConnection(channel: string, args: unknown[]): Promise<unknown> {
    for (const [senderId, conn] of this.connections) {
      if (conn.ws && conn.ws.readyState === WebSocket.OPEN) {
        return this.forward(senderId, channel, args);
      }
    }
    return Promise.reject(new Error(`no active remote connection (channel: ${channel})`));
  }

  requestRemoteFile(filePath: string): Promise<unknown> {
    const matchingSenderIds: number[] = [];
    const activeSenderIds: number[] = [];
    for (const [senderId, conn] of this.connections) {
      if (!conn.ws || conn.ws.readyState !== WebSocket.OPEN) continue;
      activeSenderIds.push(senderId);
      if (!conn.mirrorSnapshot || !conn.hostInfo) continue;
      const remotePlatform = conn.hostInfo.platform;
      const roots = [
        ...Object.values(conn.mirrorSnapshot.catalog.repositories).map(({ path }) => path),
        ...Object.values(conn.mirrorSnapshot.catalog.worktrees).map(({ path }) => path),
      ];
      if (roots.some((root) => isRemoteHostPathWithinRoot(filePath, root, remotePlatform))) {
        matchingSenderIds.push(senderId);
      }
    }
    if (matchingSenderIds.length === 1) {
      const matchingSenderId = matchingSenderIds[0];
      if (matchingSenderId !== undefined) {
        return this.forward(matchingSenderId, REMOTE_FS_READ_FILE_CHANNEL, [filePath]);
      }
    }
    if (matchingSenderIds.length > 1) {
      return Promise.reject(new Error('remote file preview host is ambiguous'));
    }
    if (activeSenderIds.length === 1) {
      const onlySenderId = activeSenderIds[0];
      if (onlySenderId !== undefined) {
        return this.forward(onlySenderId, REMOTE_FS_READ_FILE_CHANNEL, [filePath]);
      }
    }
    return Promise.reject(
      new Error(
        activeSenderIds.length === 0
          ? 'no active remote connection for file preview'
          : 'remote file preview host is ambiguous'
      )
    );
  }

  requestWorkspaceResource(resourceId: string): Promise<unknown> {
    const preferredSenderId = this.resourceConnectionById.get(resourceId);
    if (preferredSenderId !== undefined) {
      const preferred = this.connections.get(preferredSenderId);
      if (preferred?.ws && preferred.ws.readyState === WebSocket.OPEN) {
        return this.forward(preferredSenderId, IPC_CHANNELS.WORKSPACE_MIRROR_FETCH_RESOURCE, [
          resourceId,
        ]);
      }
    }
    const activeSenderIds: number[] = [];
    const matchingSenderIds: number[] = [];
    for (const [senderId, conn] of this.connections) {
      if (!conn.ws || conn.ws.readyState !== WebSocket.OPEN) continue;
      activeSenderIds.push(senderId);
      if (
        conn.mirrorSnapshot &&
        Object.values(conn.mirrorSnapshot.agents.sessions).some((session) =>
          session.draft.resources.some((resource) => resource.id === resourceId)
        )
      ) {
        matchingSenderIds.push(senderId);
      }
    }
    const senderId =
      matchingSenderIds.length === 1
        ? matchingSenderIds[0]
        : matchingSenderIds.length === 0 && activeSenderIds.length === 1
          ? activeSenderIds[0]
          : undefined;
    if (senderId !== undefined) {
      return this.forward(senderId, IPC_CHANNELS.WORKSPACE_MIRROR_FETCH_RESOURCE, [resourceId]);
    }
    return Promise.reject(new Error('workspace resource host is unavailable or ambiguous'));
  }

  forward(senderId: number, channel: string, args: unknown[]): Promise<unknown> {
    const conn = this.connections.get(senderId);
    if (!conn || !conn.ws || conn.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error(`remote host not connected (channel: ${channel})`));
    }

    // Translate client-side remote PTY ids back to the host's raw ids
    let sendArgs = args;
    if (TERMINAL_ID_ARG_CHANNELS.has(channel) && args.length > 0) {
      sendArgs = [stripRemotePtyId(args[0]), ...args.slice(1)];
    }

    if (this.hasMirrorSocket(conn)) {
      if (channel === IPC_CHANNELS.WORKSPACE_MIRROR_GET_SNAPSHOT && conn.mirrorSnapshot) {
        return Promise.resolve(structuredClone(conn.mirrorSnapshot));
      }
      if (channel === IPC_CHANNELS.WORKSPACE_MIRROR_GET_SNAPSHOT) {
        return Promise.reject(new Error('remote workspace snapshot is not synchronized'));
      }
      if (channel === IPC_CHANNELS.WORKSPACE_MIRROR_STAGE_RESOURCE) {
        return this.forwardResourceUpload(conn, sendArgs);
      }
      if (channel === IPC_CHANNELS.WORKSPACE_MIRROR_DISPATCH_INTENT && sendArgs[0]) {
        return this.dispatchMirrorIntent(conn, WorkspaceSceneIntentSchema.parse(sendArgs[0]));
      }
      if (channel === IPC_CHANNELS.WORKSPACE_MIRROR_REQUEST_CONTROL) {
        return this.requestMirrorControl(conn);
      }
      if (channel === IPC_CHANNELS.WORKSPACE_MIRROR_RELEASE_CONTROL) {
        return this.releaseMirrorControl(conn);
      }

      const terminalSessionId = typeof sendArgs[0] === 'string' ? sendArgs[0] : null;
      const attachment = terminalSessionId ? conn.mirrorStreams.get(terminalSessionId) : undefined;
      if (channel === IPC_CHANNELS.TERMINAL_ATTACH && terminalSessionId) {
        return this.forwardTerminalAttach(conn, terminalSessionId, sendArgs.slice(1));
      }
      if (channel === IPC_CHANNELS.TERMINAL_WRITE && attachment) {
        this.sendMirrorStreamInput(conn, attachment, String(sendArgs[1] ?? ''));
        return Promise.resolve(undefined);
      }
      if (channel === IPC_CHANNELS.TERMINAL_RESIZE && attachment) {
        const size = sendArgs[1] as { cols?: unknown; rows?: unknown } | undefined;
        if (typeof size?.cols === 'number' && typeof size.rows === 'number') {
          this.sendMirrorStreamResize(conn, attachment, size.cols, size.rows);
          return Promise.resolve(undefined);
        }
      }
      if (channel === IPC_CHANNELS.TERMINAL_DETACH && attachment) {
        this.detachMirrorStream(conn, attachment);
        return Promise.resolve(true);
      }

      const descriptor = getRemoteCommandDescriptor(channel);
      if (!descriptor) {
        return Promise.reject(new Error(`remote channel is not classified: ${channel}`));
      }
      if (descriptor.route === 'v2-forbidden') {
        return Promise.reject(new Error(`remote channel is unavailable in mirror V2: ${channel}`));
      }
      if (descriptor.route === 'durable-command') {
        return this.executeMirrorCommand(conn, channel, sendArgs).then((value) =>
          channel === IPC_CHANNELS.TERMINAL_CREATE && typeof value === 'string'
            ? `${REMOTE_PTY_PREFIX}${value}`
            : value
        );
      }
      if (descriptor.route === 'stream/coordination') {
        if (MIRROR_COORDINATION_COMMAND_CHANNELS.has(channel)) {
          if (channel === IPC_CHANNELS.FILE_WATCH_STOP) {
            conn.persistentRequests.delete(
              this.persistentRequestKey(IPC_CHANNELS.FILE_WATCH_START, sendArgs)
            );
          }
          return this.forwardMirrorCoordination(conn, channel, sendArgs).then((value) => {
            if (channel === IPC_CHANNELS.FILE_WATCH_START) {
              conn.persistentRequests.set(this.persistentRequestKey(channel, sendArgs), {
                channel,
                args: structuredClone(sendArgs),
              });
            }
            return value;
          });
        }
        return Promise.reject(
          new Error(`remote channel requires its workspace coordination plane: ${channel}`)
        );
      }
      return this.forwardLegacy(conn, channel, encodeWorkspaceCommandArgs(sendArgs));
    }

    if (channel === IPC_CHANNELS.FILE_WATCH_STOP) {
      conn.persistentRequests.delete(
        this.persistentRequestKey(IPC_CHANNELS.FILE_WATCH_START, sendArgs)
      );
    }
    return this.forwardLegacy(conn, channel, sendArgs).then((value) => {
      if (channel === IPC_CHANNELS.FILE_WATCH_START) {
        conn.persistentRequests.set(this.persistentRequestKey(channel, sendArgs), {
          channel,
          args: structuredClone(sendArgs),
        });
      }
      if (channel === IPC_CHANNELS.TERMINAL_CREATE && typeof value === 'string') {
        return `${REMOTE_PTY_PREFIX}${value}`;
      }
      return value;
    });
  }

  private forwardLegacy(conn: Connection, channel: string, args: unknown[]): Promise<unknown> {
    const id = conn.nextReqId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.pending.delete(id);
        reject(new Error(`remote request timed out: ${channel}`));
      }, REQUEST_TIMEOUT_MS);
      conn.pending.set(id, {
        resolve,
        reject,
        timer,
      });
      conn.ws?.send(JSON.stringify({ t: 'req', id, ch: channel, args }));
    });
  }

  private executeMirrorCommand(
    conn: Connection,
    command: string,
    args: unknown[]
  ): Promise<unknown> {
    const durableArgs =
      command === IPC_CHANNELS.TERMINAL_CREATE &&
      args[0] !== null &&
      typeof args[0] === 'object' &&
      !Array.isArray(args[0])
        ? [
            {
              ...(args[0] as Record<string, unknown>),
              sessionId:
                typeof (args[0] as Record<string, unknown>).sessionId === 'string'
                  ? (args[0] as Record<string, unknown>).sessionId
                  : `terminal-${randomUUID()}`,
              persistent: true,
            },
            ...args.slice(1),
          ]
        : args;
    const commandArgs = encodeWorkspaceCommandArgs(durableArgs);
    const commandVersion = WORKSPACE_COMMAND_VERSION;
    const frame: WorkspaceCommandExecuteFrame = {
      t: 'command.execute',
      operationId: `command-${randomUUID()}`,
      clientSeq: ++conn.mirrorCommandSequence,
      command,
      commandVersion,
      requestDigest: digestWorkspaceCommand(command, commandVersion, commandArgs),
      args: commandArgs,
    };
    return new Promise((resolve, reject) => {
      const pending: PendingMirrorCommand = { frame, resolve, reject, timer: null };
      conn.mirrorPendingCommands.set(frame.operationId, pending);
      this.armMirrorCommandStatus(conn, pending);
      conn.ws?.send(JSON.stringify(frame));
    });
  }

  private armMirrorCommandStatus(conn: Connection, pending: PendingMirrorCommand): void {
    if (pending.timer) clearTimeout(pending.timer);
    pending.timer = setTimeout(() => {
      if (conn.mirrorPendingCommands.get(pending.frame.operationId) !== pending) return;
      this.sendMirrorCommandStatus(conn, pending.frame.operationId);
      this.armMirrorCommandStatus(conn, pending);
    }, REQUEST_TIMEOUT_MS);
  }

  private sendMirrorCommandStatus(conn: Connection, operationId: string): void {
    if (!this.hasMirrorSocket(conn)) return;
    conn.ws?.send(
      JSON.stringify({
        t: 'command.status',
        requestId: operationId,
        operationId,
      })
    );
  }

  private resendPendingMirrorCommands(conn: Connection): void {
    for (const operationId of conn.mirrorPendingCommands.keys()) {
      this.sendMirrorCommandStatus(conn, operationId);
    }
  }

  private forwardMirrorCoordination(
    conn: Connection,
    command: string,
    args: unknown[]
  ): Promise<unknown> {
    const requestId = `coord-${randomUUID()}`;
    const commandArgs = encodeWorkspaceCommandArgs(args);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.mirrorPendingCoordination.delete(requestId);
        reject(new Error(`workspace coordination request timed out: ${command}`));
      }, REQUEST_TIMEOUT_MS);
      conn.mirrorPendingCoordination.set(requestId, { command, resolve, reject, timer });
      conn.ws?.send(
        JSON.stringify({
          t: 'coord.command',
          requestId,
          command,
          args: commandArgs,
        })
      );
    });
  }

  private async forwardResourceUpload(
    conn: Connection,
    args: unknown[]
  ): Promise<WorkspaceResourceReference> {
    const sourcePath = args[0];
    if (typeof sourcePath !== 'string' || !sourcePath.trim()) {
      throw new Error('Workspace resource source path is required');
    }
    const fileStat = await stat(sourcePath);
    if (!fileStat.isFile() || fileStat.size > WORKSPACE_MIRROR_MAX_RESOURCE_BYTES) {
      throw new Error('Workspace resource exceeds the size limit');
    }
    const data = await readFile(sourcePath);
    if (
      data.byteLength !== fileStat.size ||
      data.byteLength > WORKSPACE_MIRROR_MAX_RESOURCE_BYTES
    ) {
      throw new Error('Workspace resource changed while reading');
    }
    const totalChunks = Math.max(
      1,
      Math.ceil(data.byteLength / WORKSPACE_MIRROR_MAX_RESOURCE_CHUNK_BYTES)
    );
    const requestId = `resource-request-${randomUUID()}`;
    const uploadId = `resource-upload-${randomUUID()}`;
    const checksum = createHash('sha256').update(data).digest('hex');

    const referencePromise = new Promise<WorkspaceResourceReference>((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.mirrorPendingResourceUploads.delete(requestId);
        reject(new Error('workspace resource upload timed out'));
      }, REQUEST_TIMEOUT_MS);
      conn.mirrorPendingResourceUploads.set(requestId, {
        uploadId,
        resolve,
        reject,
        timer,
      });
    });

    const mime = typeof args[1] === 'string' && args[1].trim() ? args[1].trim() : undefined;
    try {
      conn.ws?.send(
        JSON.stringify({
          t: 'resource.upload.begin',
          requestId,
          uploadId,
          displayName: basename(sourcePath),
          ...(mime ? { mime } : {}),
          totalBytes: data.byteLength,
          totalChunks,
          checksum,
        })
      );
      for (let index = 0; index < totalChunks; index += 1) {
        const chunk = data.subarray(
          index * WORKSPACE_MIRROR_MAX_RESOURCE_CHUNK_BYTES,
          Math.min((index + 1) * WORKSPACE_MIRROR_MAX_RESOURCE_CHUNK_BYTES, data.byteLength)
        );
        conn.ws?.send(
          JSON.stringify({
            t: 'resource.upload.chunk',
            uploadId,
            index,
            data: chunk.toString('base64'),
            checksum: createHash('sha256').update(chunk).digest('hex'),
          })
        );
      }
      conn.ws?.send(
        JSON.stringify({
          t: 'resource.upload.end',
          uploadId,
          totalChunks,
          checksum,
        })
      );
    } catch (error) {
      const pending = conn.mirrorPendingResourceUploads.get(requestId);
      if (pending) {
        conn.mirrorPendingResourceUploads.delete(requestId);
        clearTimeout(pending.timer);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
    return referencePromise.then((reference) => {
      this.resourceConnectionById.set(reference.id, conn.wc.id);
      return reference;
    });
  }

  private hasMirrorSocket(conn: Connection): boolean {
    return (
      conn.ws?.readyState === WebSocket.OPEN &&
      conn.ws.protocol === WORKSPACE_MIRROR_SUBPROTOCOL &&
      conn.mirrorSyncPhase !== 'disconnected'
    );
  }

  private dispatchMirrorIntent(
    conn: Connection,
    intent: WorkspaceSceneIntent
  ): Promise<StateIntentResultFrame> {
    const existing = conn.mirrorPendingIntents.get(intent.operationId);
    if (existing) {
      return Promise.reject(
        new Error(`workspace operation is already pending: ${intent.operationId}`)
      );
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.mirrorPendingIntents.delete(intent.operationId);
        reject(new Error(`workspace intent timed out: ${intent.kind}`));
      }, REQUEST_TIMEOUT_MS);
      conn.mirrorPendingIntents.set(intent.operationId, { intent, resolve, reject, timer });
      conn.ws?.send(JSON.stringify(intent));
    });
  }

  private requestMirrorControl(conn: Connection): Promise<ControllerLease> {
    const requestId = `control-${randomUUID()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        conn.mirrorPendingControls.delete(requestId);
        reject(new Error('workspace control request timed out'));
      }, REQUEST_TIMEOUT_MS);
      conn.mirrorPendingControls.set(requestId, { requestId, resolve, reject, timer });
      conn.ws?.send(
        JSON.stringify({
          t: 'control.request',
          requestId,
          knownCoordSeq: conn.mirrorCoordSeq,
        })
      );
    });
  }

  private releaseMirrorControl(conn: Connection): Promise<void> {
    const lease = conn.mirrorLease;
    if (!lease) return Promise.resolve();
    conn.ws?.send(
      JSON.stringify({
        t: 'control.released',
        coordSeq: Math.max(1, conn.mirrorCoordSeq + 1),
        leaseId: lease.leaseId,
        reason: 'released',
      })
    );
    conn.mirrorLease = null;
    return Promise.resolve();
  }

  private forwardTerminalAttach(
    conn: Connection,
    terminalSessionId: string,
    args: unknown[]
  ): Promise<TerminalAttachResult> {
    const streamIdentity = this.resolveMirrorStreamIdentity(conn, terminalSessionId);
    if (!streamIdentity) {
      return Promise.reject(new Error('remote terminal is not present in the workspace scene'));
    }
    const options = args[0];
    const requestedCursor =
      options &&
      typeof options === 'object' &&
      Number.isSafeInteger((options as { afterStreamSeq?: unknown }).afterStreamSeq)
        ? Math.max(0, (options as { afterStreamSeq: number }).afterStreamSeq)
        : (conn.terminalStreamCursors.get(terminalSessionId) ?? 0);
    const attachment = this.attachMirrorStream(
      conn,
      terminalSessionId,
      streamIdentity,
      requestedCursor
    );
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (attachment.pendingAttach?.timer !== timer) return;
        delete attachment.pendingAttach;
        conn.mirrorStreams.delete(terminalSessionId);
        reject(new Error('remote terminal attach timed out'));
      }, REQUEST_TIMEOUT_MS);
      attachment.pendingAttach = { resolve, reject, timer };
    });
  }

  private resolveMirrorStreamIdentity(
    conn: Connection,
    terminalSessionId: string
  ): Pick<MirrorStreamAttachment, 'streamKind' | 'entityId' | 'entityGeneration'> | null {
    const snapshot = conn.mirrorSnapshot;
    if (!snapshot) return null;
    const terminal = snapshot.terminals.sessions[terminalSessionId];
    if (terminal) {
      return {
        streamKind: 'terminal',
        entityId: terminal.id,
        entityGeneration: terminal.generation,
      };
    }
    const agent = Object.values(snapshot.agents.sessions).find(
      (candidate) => candidate.terminalSessionId === terminalSessionId
    );
    return agent
      ? { streamKind: 'agent', entityId: agent.id, entityGeneration: agent.generation }
      : null;
  }

  private attachMirrorStream(
    conn: Connection,
    terminalSessionId: string,
    identity: Pick<MirrorStreamAttachment, 'streamKind' | 'entityId' | 'entityGeneration'>,
    fromStreamSeq?: number
  ): MirrorStreamAttachment {
    const previous = conn.mirrorStreams.get(terminalSessionId);
    if (previous) this.detachMirrorStream(conn, previous);
    const attachment: MirrorStreamAttachment = {
      streamId: `stream-${randomUUID()}`,
      ...identity,
      terminalSessionId,
      lastStreamSeq: fromStreamSeq ?? conn.terminalStreamCursors.get(terminalSessionId) ?? 0,
    };
    conn.mirrorStreams.set(terminalSessionId, attachment);
    this.sendMirrorStreamAttach(conn, attachment);
    return attachment;
  }

  private sendMirrorStreamAttach(conn: Connection, attachment: MirrorStreamAttachment): void {
    const snapshot = conn.mirrorSnapshot;
    if (!snapshot || !this.hasMirrorSocket(conn)) return;
    conn.ws?.send(
      JSON.stringify({
        t: 'stream.attach',
        streamId: attachment.streamId,
        streamKind: attachment.streamKind,
        entityId: attachment.entityId,
        entityGeneration: attachment.entityGeneration,
        sceneRevision: snapshot.revision,
        fromStreamSeq: attachment.lastStreamSeq,
      })
    );
  }

  private sendMirrorStreamInput(
    conn: Connection,
    attachment: MirrorStreamAttachment,
    data: string
  ): void {
    conn.ws?.send(
      JSON.stringify({
        t: 'stream.input',
        streamId: attachment.streamId,
        streamKind: attachment.streamKind,
        entityId: attachment.entityId,
        entityGeneration: attachment.entityGeneration,
        operationId: `stream-input-${randomUUID()}`,
        data,
      })
    );
  }

  private sendMirrorStreamResize(
    conn: Connection,
    attachment: MirrorStreamAttachment,
    cols: number,
    rows: number
  ): void {
    conn.ws?.send(
      JSON.stringify({
        t: 'stream.resize',
        streamId: attachment.streamId,
        streamKind: attachment.streamKind,
        entityId: attachment.entityId,
        entityGeneration: attachment.entityGeneration,
        operationId: `stream-resize-${randomUUID()}`,
        cols,
        rows,
      })
    );
  }

  private detachMirrorStream(conn: Connection, attachment: MirrorStreamAttachment): void {
    conn.mirrorStreams.delete(attachment.terminalSessionId);
    if (attachment.pendingAttach) {
      clearTimeout(attachment.pendingAttach.timer);
      attachment.pendingAttach.reject(new Error('remote terminal attach was detached'));
      delete attachment.pendingAttach;
    }
    if (!this.hasMirrorSocket(conn)) return;
    conn.ws?.send(
      JSON.stringify({
        t: 'stream.detach',
        streamId: attachment.streamId,
        streamKind: attachment.streamKind,
        entityId: attachment.entityId,
        entityGeneration: attachment.entityGeneration,
      })
    );
  }

  private reattachMirrorStreams(conn: Connection): void {
    for (const attachment of conn.mirrorStreams.values()) {
      const identity = this.resolveMirrorStreamIdentity(conn, attachment.terminalSessionId);
      if (!identity) continue;
      attachment.streamId = `stream-${randomUUID()}`;
      attachment.streamKind = identity.streamKind;
      attachment.entityId = identity.entityId;
      attachment.entityGeneration = identity.entityGeneration;
      attachment.lastStreamSeq =
        conn.terminalStreamCursors.get(attachment.terminalSessionId) ?? attachment.lastStreamSeq;
      this.sendMirrorStreamAttach(conn, attachment);
    }
  }

  ackStream(
    senderId: number,
    id: string,
    payload: { streamSeq: number; creditBytes: number }
  ): void {
    const conn = this.connections.get(senderId);
    if (!conn) return;
    const remotePtyId = id.startsWith('remote:') ? id.slice('remote:'.length) : id;
    const attachment = conn.mirrorStreams.get(remotePtyId);
    if (!attachment) return;
    if (!this.hasMirrorSocket(conn)) return;
    conn.ws?.send(
      JSON.stringify({
        t: 'stream.ack',
        streamId: attachment.streamId,
        streamKind: attachment.streamKind,
        entityId: attachment.entityId,
        entityGeneration: attachment.entityGeneration,
        consumedStreamSeq: payload.streamSeq,
        creditBytes: payload.creditBytes,
      })
    );
  }

  private rejectPendingMirrorStreamAttaches(conn: Connection, error: Error): void {
    for (const attachment of conn.mirrorStreams.values()) {
      if (!attachment.pendingAttach) continue;
      clearTimeout(attachment.pendingAttach.timer);
      attachment.pendingAttach.reject(error);
      delete attachment.pendingAttach;
    }
  }

  private resendPendingMirrorIntents(conn: Connection): void {
    for (const pending of conn.mirrorPendingIntents.values()) {
      conn.ws?.send(JSON.stringify(pending.intent));
    }
  }

  disposeAll(): void {
    for (const senderId of [...this.connections.keys()]) {
      this.disconnect(senderId);
    }
  }

  private async openSocket(conn: Connection): Promise<void> {
    // A reconnect starts a new transport epoch. Keep the last snapshot for
    // resume, but stop routing mirror writes until a new protocol is chosen.
    this.resetMirrorAssembly(conn);
    conn.negotiatedProtocol = undefined;
    conn.mirrorSyncPhase = conn.mirrorSnapshot ? 'stale' : 'disconnected';
    if (conn.options.mirrorV2 !== false) {
      try {
        await this.openSocketAttempt(conn, true);
        return;
      } catch (error) {
        const failedSocket = conn.ws;
        if (failedSocket && failedSocket === conn.ws) {
          conn.ws = null;
          failedSocket.terminate();
        }
        if (
          conn.disposed ||
          (error instanceof Error && /authentication failed/.test(error.message))
        ) {
          throw error;
        }
      }
    }
    await this.openSocketAttempt(conn, false);
  }

  private openSocketAttempt(conn: Connection, useMirrorV2: boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `ws://${conn.options.host}:${conn.options.port}/`;
      const socketOptions = {
        headers: { [REMOTE_TOKEN_HEADER]: conn.options.token },
        handshakeTimeout: CONNECT_TIMEOUT_MS,
      };
      const ws = useMirrorV2
        ? new WebSocket(url, WORKSPACE_MIRROR_SUBPROTOCOL, socketOptions)
        : new WebSocket(url, socketOptions);
      const generation = conn.socketGeneration + 1;
      conn.socketGeneration = generation;
      conn.ws = ws;
      const isCurrentSocket = (): boolean => conn.socketGeneration === generation && conn.ws === ws;

      let settled = false;
      const helloTimer = setTimeout(() => {
        if (!settled) {
          settled = true;
          ws.terminate();
          reject(new Error('handshake timed out'));
        }
      }, CONNECT_TIMEOUT_MS);

      ws.on('open', () => {
        if (!isCurrentSocket()) return;
        if (ws.protocol !== WORKSPACE_MIRROR_SUBPROTOCOL) return;
        conn.mirrorSyncPhase = 'bootstrapping';
      });

      ws.on('message', (raw) => {
        if (!isCurrentSocket()) return;
        if (ws.protocol === WORKSPACE_MIRROR_SUBPROTOCOL) {
          try {
            const mirrorFrame = parseWorkspaceMirrorV2Frame(raw.toString());
            this.handleMirrorServerFrame(conn, mirrorFrame);
            if (mirrorFrame.t === 'serverHello' && !settled) {
              settled = true;
              clearTimeout(helloTimer);
              resolve();
            }
            return;
          } catch {
            // V2 sockets also carry legacy RPC responses/events during migration.
          }
        }
        let frame: RemoteFrame;
        try {
          frame = parseRemoteFrame(raw.toString());
        } catch {
          ws.close(4400, 'invalid frame');
          return;
        }

        if (frame.t === 'protocol.error') {
          if (!settled) {
            settled = true;
            clearTimeout(helloTimer);
            reject(new Error(`${frame.code}: ${frame.message}`));
          }
          ws.close(4406, frame.code);
          return;
        }

        if (frame.t === 'hello') {
          if (settled) {
            ws.close(4400, 'duplicate handshake');
            return;
          }
          clearTimeout(helloTimer);
          if (frame.protocolVersion !== REMOTE_PROTOCOL_VERSION) {
            settled = true;
            ws.close();
            reject(
              new Error(
                `protocol version mismatch (host: ${frame.protocolVersion}, client: ${REMOTE_PROTOCOL_VERSION}); please update both apps`
              )
            );
            return;
          }
          conn.hostInfo = frame.host;
          if (!settled && ws.protocol !== WORKSPACE_MIRROR_SUBPROTOCOL) {
            conn.negotiatedProtocol = 'v1';
            conn.mirrorSyncPhase = 'disconnected';
            conn.mirrorLease = null;
            conn.mirrorSnapshot = null;
            this.rejectPendingMirrorStreamAttaches(
              conn,
              new Error('workspace mirror stream is unavailable in legacy mode')
            );
            conn.mirrorStreams.clear();
            this.resetMirrorAssembly(conn);
            settled = true;
            resolve();
          }
          return;
        }

        if (!settled) {
          settled = true;
          clearTimeout(helloTimer);
          ws.close(4400, 'frame received before handshake');
          reject(new Error('invalid remote handshake sequence'));
          return;
        }

        if (frame.t === 'res') {
          const pending = conn.pending.get(frame.id);
          if (pending) {
            conn.pending.delete(frame.id);
            clearTimeout(pending.timer);
            if (frame.ok) {
              pending.resolve(frame.result);
            } else {
              pending.reject(new Error(frame.error ?? 'remote error'));
            }
          }
          return;
        }

        if (frame.t === 'ev' && !conn.wc.isDestroyed()) {
          if (ws.protocol === WORKSPACE_MIRROR_SUBPROTOCOL) {
            const capability = getRemoteV2EventCapability(frame.ch);
            if (
              capability === undefined ||
              (capability !== null && !MIRROR_CLIENT_CAPABILITY_SET.has(capability))
            ) {
              ws.close(4400, 'unclassified V2 event');
              return;
            }
          }
          let payload = frame.payload;
          // Prefix PTY ids in terminal push events to match client-side ids
          if (
            (frame.ch === IPC_CHANNELS.TERMINAL_DATA ||
              frame.ch === IPC_CHANNELS.TERMINAL_EXIT ||
              frame.ch === IPC_CHANNELS.TERMINAL_STREAM_RESET) &&
            payload.length > 0 &&
            typeof payload[0] === 'object' &&
            payload[0] !== null
          ) {
            const event = payload[0] as { id?: unknown };
            if (typeof event.id === 'string') {
              if (
                frame.ch === IPC_CHANNELS.TERMINAL_DATA &&
                typeof (event as { streamSeq?: unknown }).streamSeq === 'number'
              ) {
                conn.terminalStreamCursors.set(
                  event.id,
                  Math.max(
                    conn.terminalStreamCursors.get(event.id) ?? 0,
                    (event as { streamSeq: number }).streamSeq
                  )
                );
              }
              payload = [{ ...event, id: `${REMOTE_PTY_PREFIX}${event.id}` }, ...payload.slice(1)];
            }
          }
          conn.wc.send(frame.ch, ...payload);
          return;
        }

        ws.close(4400, 'invalid server frame');
      });

      ws.on('close', (code, reason) => {
        clearTimeout(helloTimer);
        const wasActiveSocket = isCurrentSocket();
        if (wasActiveSocket) {
          this.rejectAllPending(conn, new Error('remote connection closed'));
          conn.ws = null;
        }
        if (wasActiveSocket && ws.protocol === WORKSPACE_MIRROR_SUBPROTOCOL) {
          conn.mirrorSyncPhase = 'stale';
        }

        if (!settled) {
          settled = true;
          reject(
            code === 4401
              ? new Error('authentication failed: invalid token')
              : new Error(`connection closed (${code}) ${reason.toString()}`.trim())
          );
          return;
        }

        if (!wasActiveSocket) return;

        if (code === 4401) {
          this.stopReconnecting(conn, reason.toString() || 'remote authorization revoked');
          return;
        }

        // Unexpected close after successful handshake -> auto-reconnect
        if (!conn.disposed && this.connections.get(conn.wc.id) === conn) {
          this.scheduleReconnect(conn);
        }
      });

      ws.on('error', (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(helloTimer);
          reject(err);
        }
      });
    });
  }

  private sendMirrorSubscribe(conn: Connection, forceSnapshot = false): void {
    const ws = conn.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || ws.protocol !== WORKSPACE_MIRROR_SUBPROTOCOL) {
      return;
    }
    const cursor =
      forceSnapshot || !conn.mirrorSnapshot
        ? null
        : {
            hostEpoch: conn.mirrorSnapshot.hostEpoch,
            sceneId: conn.mirrorSnapshot.sceneId,
            revision: conn.mirrorSnapshot.revision,
          };
    ws.send(
      JSON.stringify({
        t: 'state.subscribe',
        requestId: `snapshot-${randomUUID()}`,
        mode: forceSnapshot ? 'snapshot' : cursor ? 'resume' : 'auto',
        cursor,
      })
    );
  }

  private resetMirrorAssembly(conn: Connection): void {
    conn.mirrorAssembler = new WorkspaceSnapshotAssembler();
    conn.mirrorSnapshotInProgress = false;
    conn.mirrorBufferedEvents = [];
  }

  private applyMirrorEvent(conn: Connection, event: WorkspaceSceneEvent, emit: boolean): boolean {
    if (!conn.mirrorSnapshot) return false;
    const applied = applyWorkspaceSceneEvent(conn.mirrorSnapshot, event);
    if (applied.status === 'resyncRequired') return false;
    if (applied.status === 'duplicate') return true;
    conn.mirrorSnapshot = applied.snapshot;
    this.rememberSnapshotResources(conn);
    if (emit && !conn.wc.isDestroyed()) {
      conn.wc.send(IPC_CHANNELS.WORKSPACE_MIRROR_EVENT, event);
    }
    return true;
  }

  private rememberSnapshotResources(conn: Connection): void {
    if (!conn.mirrorSnapshot) return;
    for (const session of Object.values(conn.mirrorSnapshot.agents.sessions)) {
      for (const resource of session.draft.resources) {
        this.resourceConnectionById.set(resource.id, conn.wc.id);
      }
    }
  }

  private handleMirrorServerFrame(conn: Connection, frame: WorkspaceMirrorV2Frame): void {
    if (frame.t === 'auth.challenge') {
      try {
        const signature = sign(
          null,
          Buffer.from(frame.nonce, 'utf8'),
          createPrivateKey({
            key: Buffer.from(conn.mirrorIdentity.privateKey, 'base64'),
            type: 'pkcs8',
            format: 'der',
          })
        ).toString('base64');
        conn.ws?.send(
          JSON.stringify({
            t: 'auth.proof',
            deviceId: conn.mirrorDeviceId,
            nonce: frame.nonce,
            signature,
            publicKey: conn.mirrorIdentity.publicKey,
          })
        );
        this.sendMirrorClientHello(conn);
      } catch {
        conn.error = 'device authentication failed';
        conn.mirrorSyncPhase = 'stale';
        conn.ws?.close(4401, 'authentication failed');
      }
      return;
    }
    if (frame.t === 'serverHello') {
      conn.negotiatedProtocol = 'v2';
      conn.mirrorSyncPhase = frame.bootstrapPhase;
      if (frame.bootstrapPhase === 'live') {
        conn.mirrorSyncPhase = 'syncing';
        this.sendMirrorSubscribe(conn);
        this.restorePersistentRequests(conn);
        this.resendPendingMirrorCommands(conn);
      }
      this.pushStatus(conn);
      return;
    }
    if (frame.t === 'state.snapshot.begin') {
      try {
        conn.mirrorAssembler.start(frame);
        conn.mirrorSnapshotInProgress = true;
        conn.mirrorSyncPhase = conn.mirrorSnapshot ? 'resyncing' : 'syncing';
      } catch {
        this.sendMirrorSubscribe(conn, true);
      }
      return;
    }
    if (frame.t === 'state.snapshot.chunk') {
      try {
        conn.mirrorAssembler.add(frame);
      } catch {
        conn.mirrorSnapshotInProgress = false;
        this.sendMirrorSubscribe(conn, true);
      }
      return;
    }
    if (frame.t === 'state.snapshot.end') {
      try {
        conn.mirrorSnapshot = conn.mirrorAssembler.finish(frame);
        this.rememberSnapshotResources(conn);
        conn.mirrorSnapshotInProgress = false;
        const buffered = [...conn.mirrorBufferedEvents].sort((a, b) => a.revision - b.revision);
        conn.mirrorBufferedEvents = [];
        for (const event of buffered) {
          if (!this.applyMirrorEvent(conn, event, false)) {
            this.sendMirrorSubscribe(conn, true);
            return;
          }
        }
        conn.mirrorSyncPhase = 'live';
        conn.mirrorLastResyncReason = undefined;
        if (!conn.wc.isDestroyed()) {
          conn.wc.send(IPC_CHANNELS.WORKSPACE_MIRROR_SNAPSHOT, conn.mirrorSnapshot);
        }
        this.reattachMirrorStreams(conn);
        this.pushStatus(conn);
      } catch {
        conn.mirrorSnapshotInProgress = false;
        this.sendMirrorSubscribe(conn, true);
      }
      return;
    }
    if (frame.t === 'state.event') {
      if (
        conn.mirrorSnapshotInProgress ||
        !conn.mirrorSnapshot ||
        conn.mirrorSyncPhase !== 'live'
      ) {
        if (conn.mirrorBufferedEvents.length >= MAX_BUFFERED_MIRROR_EVENTS) {
          conn.mirrorBufferedEvents = [];
          conn.mirrorSnapshotInProgress = false;
          conn.mirrorSyncPhase = 'resyncing';
          this.sendMirrorSubscribe(conn, true);
          this.pushStatus(conn);
          return;
        }
        conn.mirrorBufferedEvents.push(frame);
        return;
      }
      if (!this.applyMirrorEvent(conn, frame, true)) {
        conn.mirrorSyncPhase = 'resyncing';
        this.sendMirrorSubscribe(conn, true);
      } else {
        conn.mirrorSyncPhase = 'live';
      }
      this.pushStatus(conn);
      return;
    }
    if (frame.t === 'state.replay') {
      for (const event of frame.events) {
        if (!this.applyMirrorEvent(conn, event, true)) {
          conn.mirrorSyncPhase = 'resyncing';
          this.sendMirrorSubscribe(conn, true);
          return;
        }
      }
      const buffered = [...conn.mirrorBufferedEvents].sort((a, b) => a.revision - b.revision);
      conn.mirrorBufferedEvents = [];
      for (const event of buffered) {
        if (!this.applyMirrorEvent(conn, event, true)) {
          conn.mirrorSyncPhase = 'resyncing';
          this.sendMirrorSubscribe(conn, true);
          this.pushStatus(conn);
          return;
        }
      }
      conn.mirrorSyncPhase = 'live';
      conn.mirrorLastResyncReason = undefined;
      this.reattachMirrorStreams(conn);
      this.pushStatus(conn);
      return;
    }
    if (frame.t === 'state.resyncRequired') {
      conn.mirrorSyncPhase = 'resyncing';
      conn.mirrorLastResyncReason = frame.reason;
      this.sendMirrorSubscribe(conn, true);
      this.pushStatus(conn);
      return;
    }
    if (frame.t === 'control.granted') {
      conn.mirrorCoordSeq = Math.max(conn.mirrorCoordSeq, frame.coordSeq);
      conn.mirrorLease = frame.lease;
      if (
        frame.lease.holderClientId === conn.mirrorClientId &&
        frame.lease.holderDeviceId === conn.mirrorDeviceId
      ) {
        for (const pending of conn.mirrorPendingControls.values()) {
          clearTimeout(pending.timer);
          pending.resolve(frame.lease);
        }
        conn.mirrorPendingControls.clear();
        this.resendPendingMirrorIntents(conn);
      }
      if (!conn.wc.isDestroyed()) {
        conn.wc.send(IPC_CHANNELS.WORKSPACE_MIRROR_CONTROL_CHANGED, frame.lease);
      }
      this.pushStatus(conn);
      return;
    }
    if (frame.t === 'control.released' || frame.t === 'control.revoked') {
      conn.mirrorCoordSeq = Math.max(conn.mirrorCoordSeq, frame.coordSeq);
      if (conn.mirrorLease?.leaseId === frame.leaseId) conn.mirrorLease = null;
      if (!conn.wc.isDestroyed()) {
        conn.wc.send(IPC_CHANNELS.WORKSPACE_MIRROR_CONTROL_CHANGED, null);
      }
      this.pushStatus(conn);
      return;
    }
    if (frame.t === 'state.intentResult') {
      const pending = conn.mirrorPendingIntents.get(frame.operationId);
      if (pending) {
        conn.mirrorPendingIntents.delete(frame.operationId);
        clearTimeout(pending.timer);
        pending.resolve(frame);
      }
      return;
    }
    if (frame.t === 'command.result') {
      const pending = conn.mirrorPendingCommands.get(frame.operationId);
      if (!pending) return;
      if (
        frame.command !== pending.frame.command ||
        frame.commandVersion !== pending.frame.commandVersion ||
        frame.requestDigest !== pending.frame.requestDigest
      ) {
        conn.mirrorPendingCommands.delete(frame.operationId);
        if (pending.timer) clearTimeout(pending.timer);
        pending.reject(new Error('remote command result binding mismatch'));
        return;
      }
      if (frame.state === 'prepared' || frame.state === 'executing') {
        this.armMirrorCommandStatus(conn, pending);
        return;
      }
      conn.mirrorPendingCommands.delete(frame.operationId);
      if (pending.timer) clearTimeout(pending.timer);
      if (frame.state === 'committed') {
        if (frame.resultExpired) {
          pending.reject(new RemoteWorkspaceCommandError(frame.error));
        } else {
          try {
            pending.resolve(restoreMirrorCommandResult(pending.frame, frame.result));
          } catch (error) {
            pending.reject(error instanceof Error ? error : new Error(String(error)));
          }
        }
      } else {
        pending.reject(new RemoteWorkspaceCommandError(frame.error));
      }
      return;
    }
    if (frame.t === 'coord.commandResult') {
      const pending = conn.mirrorPendingCoordination.get(frame.requestId);
      if (!pending) return;
      conn.mirrorPendingCoordination.delete(frame.requestId);
      clearTimeout(pending.timer);
      if (pending.command !== frame.command) {
        pending.reject(new Error('workspace coordination result binding mismatch'));
      } else if (frame.ok) {
        pending.resolve(frame.result);
      } else {
        pending.reject(new Error(`${frame.error.code}: ${frame.error.message}`));
      }
      return;
    }
    if (frame.t === 'stream.attached') {
      const attachment = [...conn.mirrorStreams.values()].find(
        (candidate) => candidate.streamId === frame.streamId
      );
      const pending = attachment?.pendingAttach;
      if (attachment && pending) {
        clearTimeout(pending.timer);
        delete attachment.pendingAttach;
        attachment.lastStreamSeq = frame.currentStreamSeq;
        conn.terminalStreamCursors.set(attachment.terminalSessionId, frame.currentStreamSeq);
        pending.resolve({
          sessionId: `${REMOTE_PTY_PREFIX}${attachment.terminalSessionId}`,
          reset: frame.reset,
          retainedFromSeq: frame.retainedFromSeq,
          currentStreamSeq: frame.currentStreamSeq,
          replayedEventCount: frame.replayedEventCount,
        });
        if (attachment.closedDuringAttach) {
          conn.mirrorStreams.delete(attachment.terminalSessionId);
        }
      }
      return;
    }
    if (frame.t === 'stream.chunk' && !conn.wc.isDestroyed()) {
      const attachment = [...conn.mirrorStreams.values()].find(
        (candidate) => candidate.streamId === frame.streamId
      );
      const terminalSessionId = attachment?.terminalSessionId ?? frame.entityId;
      if (attachment) attachment.lastStreamSeq = frame.streamSeq;
      conn.terminalStreamCursors.set(terminalSessionId, frame.streamSeq);
      conn.wc.send(IPC_CHANNELS.TERMINAL_DATA, {
        id: `${REMOTE_PTY_PREFIX}${terminalSessionId}`,
        data:
          frame.encoding === 'base64'
            ? Buffer.from(frame.data, 'base64').toString('utf8')
            : frame.data,
        streamSeq: frame.streamSeq,
      });
      return;
    }
    if (frame.t === 'stream.reset' && !conn.wc.isDestroyed()) {
      const attachment = [...conn.mirrorStreams.values()].find(
        (candidate) => candidate.streamId === frame.streamId
      );
      const terminalSessionId = attachment?.terminalSessionId ?? frame.entityId;
      const resumeAfter = Math.max(0, frame.nextStreamSeq - 1);
      if (attachment) attachment.lastStreamSeq = resumeAfter;
      conn.terminalStreamCursors.set(terminalSessionId, resumeAfter);
      conn.wc.send(IPC_CHANNELS.TERMINAL_STREAM_RESET, {
        id: `${REMOTE_PTY_PREFIX}${terminalSessionId}`,
        reason: frame.reason === 'retention-overflow' ? 'overflow' : 'cursor-ahead',
        retainedFromSeq: frame.nextStreamSeq,
        currentStreamSeq: frame.nextStreamSeq,
      });
      return;
    }
    if (frame.t === 'stream.closed' && !conn.wc.isDestroyed()) {
      const attachment = [...conn.mirrorStreams.values()].find(
        (candidate) => candidate.streamId === frame.streamId
      );
      const terminalSessionId = attachment?.terminalSessionId ?? frame.entityId;
      if (attachment?.pendingAttach) {
        attachment.closedDuringAttach = true;
      } else if (attachment) {
        conn.mirrorStreams.delete(attachment.terminalSessionId);
      }
      conn.wc.send(IPC_CHANNELS.TERMINAL_EXIT, {
        id: `${REMOTE_PTY_PREFIX}${terminalSessionId}`,
        exitCode: frame.exitCode ?? 0,
      });
      return;
    }
    if (frame.t === 'resource.upload.result') {
      const pending = conn.mirrorPendingResourceUploads.get(frame.requestId);
      if (pending && pending.uploadId === frame.uploadId) {
        conn.mirrorPendingResourceUploads.delete(frame.requestId);
        clearTimeout(pending.timer);
        pending.resolve(frame.reference);
      }
      return;
    }
    if (frame.t === 'error') {
      let matchedRequest = false;
      if (frame.requestId) {
        const control = conn.mirrorPendingControls.get(frame.requestId);
        if (control) {
          matchedRequest = true;
          conn.mirrorPendingControls.delete(frame.requestId);
          clearTimeout(control.timer);
          control.reject(new Error(frame.error.message));
        }
        const intent = conn.mirrorPendingIntents.get(frame.requestId);
        if (intent) {
          matchedRequest = true;
          conn.mirrorPendingIntents.delete(frame.requestId);
          clearTimeout(intent.timer);
          intent.reject(new Error(frame.error.message));
        }
        const command = conn.mirrorPendingCommands.get(frame.requestId);
        if (command) {
          matchedRequest = true;
          if (frame.error.code === 'UNKNOWN_OPERATION' && this.hasMirrorSocket(conn)) {
            conn.ws?.send(JSON.stringify(command.frame));
            this.armMirrorCommandStatus(conn, command);
          } else {
            conn.mirrorPendingCommands.delete(frame.requestId);
            if (command.timer) clearTimeout(command.timer);
            command.reject(new Error(`${frame.error.code}: ${frame.error.message}`));
          }
        }
        const coordination = conn.mirrorPendingCoordination.get(frame.requestId);
        if (coordination) {
          matchedRequest = true;
          conn.mirrorPendingCoordination.delete(frame.requestId);
          clearTimeout(coordination.timer);
          coordination.reject(new Error(`${frame.error.code}: ${frame.error.message}`));
        }
        const upload = conn.mirrorPendingResourceUploads.get(frame.requestId);
        if (upload) {
          matchedRequest = true;
          conn.mirrorPendingResourceUploads.delete(frame.requestId);
          clearTimeout(upload.timer);
          upload.reject(new Error(frame.error.message));
        }
        const attachment = [...conn.mirrorStreams.values()].find(
          (candidate) => candidate.streamId === frame.requestId
        );
        if (attachment?.pendingAttach) {
          matchedRequest = true;
          clearTimeout(attachment.pendingAttach.timer);
          attachment.pendingAttach.reject(new Error(frame.error.message));
          delete attachment.pendingAttach;
          conn.mirrorStreams.delete(attachment.terminalSessionId);
        }
      }
      conn.error = frame.error.message;
      // Request-level denials (including stream input/resize errors) do not
      // invalidate an otherwise contiguous scene. Only an uncorrelated
      // protocol error requires a resync.
      const isSnapshotRequest = frame.requestId?.startsWith('snapshot-') ?? false;
      if (!matchedRequest && (!frame.requestId || isSnapshotRequest)) {
        conn.mirrorSyncPhase = 'stale';
        this.sendMirrorSubscribe(conn, true);
      }
      this.pushStatus(conn);
    }
  }

  private sendMirrorClientHello(conn: Connection): void {
    const resumeCursor = conn.mirrorSnapshot
      ? {
          hostEpoch: conn.mirrorSnapshot.hostEpoch,
          sceneId: conn.mirrorSnapshot.sceneId,
          revision: conn.mirrorSnapshot.revision,
        }
      : null;
    conn.ws?.send(
      JSON.stringify({
        t: 'clientHello',
        protocolVersions: [WORKSPACE_MIRROR_PROTOCOL_VERSION],
        schemaVersions: [WORKSPACE_MIRROR_SCHEMA_VERSION],
        deviceId: conn.mirrorDeviceId,
        clientId: conn.mirrorClientId,
        capabilities: MIRROR_CLIENT_CAPABILITIES,
        resumeCursor,
      })
    );
  }

  private persistentRequestKey(channel: string, args: unknown[]): string {
    return `${channel}:${JSON.stringify(args)}`;
  }

  private restorePersistentRequests(conn: Connection): void {
    for (const request of conn.persistentRequests.values()) {
      const descriptor = getRemoteCommandDescriptor(request.channel);
      const restored =
        descriptor?.route === 'stream/coordination'
          ? this.forwardMirrorCoordination(conn, request.channel, request.args)
          : this.forwardLegacy(conn, request.channel, request.args);
      void restored.catch(() => undefined);
    }
  }

  private scheduleReconnect(conn: Connection): void {
    if (conn.disposed || conn.wc.isDestroyed()) {
      return;
    }
    conn.state = 'reconnecting';
    if (conn.mirrorSnapshot) conn.mirrorSyncPhase = 'stale';
    this.pushStatus(conn);

    const delay = Math.min(
      RECONNECT_BASE_DELAY_MS * 2 ** conn.reconnectAttempt,
      RECONNECT_MAX_DELAY_MS
    );
    conn.reconnectAttempt++;

    conn.reconnectTimer = setTimeout(async () => {
      conn.reconnectTimer = null;
      if (conn.disposed || this.connections.get(conn.wc.id) !== conn) {
        return;
      }
      try {
        await this.openSocket(conn);
        conn.state = 'connected';
        conn.error = undefined;
        conn.reconnectAttempt = 0;
        this.pushStatus(conn);
      } catch (err) {
        conn.error = err instanceof Error ? err.message : String(err);
        if (/authentication failed|authorization revoked/.test(conn.error)) {
          this.stopReconnecting(conn, conn.error);
          return;
        }
        this.scheduleReconnect(conn);
      }
    }, delay);
  }

  private disposeConnection(conn: Connection): void {
    conn.disposed = true;
    conn.socketGeneration += 1;
    if (conn.reconnectTimer) {
      clearTimeout(conn.reconnectTimer);
      conn.reconnectTimer = null;
    }
    this.rejectAllPending(conn, new Error('remote connection disposed'));
    for (const pending of conn.mirrorPendingIntents.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('remote connection disposed'));
    }
    conn.mirrorPendingIntents.clear();
    for (const pending of conn.mirrorPendingCommands.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new Error('remote connection disposed'));
    }
    conn.mirrorPendingCommands.clear();
    for (const pending of conn.mirrorPendingCoordination.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('remote connection disposed'));
    }
    conn.mirrorPendingCoordination.clear();
    for (const pending of conn.mirrorPendingControls.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('remote connection disposed'));
    }
    conn.mirrorPendingControls.clear();
    for (const pending of conn.mirrorPendingResourceUploads.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('remote connection disposed'));
    }
    conn.mirrorPendingResourceUploads.clear();
    this.rejectPendingMirrorStreamAttaches(conn, new Error('remote connection disposed'));
    conn.mirrorStreams.clear();
    conn.persistentRequests.clear();
    this.forgetConnectionResources(conn.wc.id);
    this.resetMirrorAssembly(conn);
    if (conn.ws) {
      const socket = conn.ws;
      conn.ws = null;
      try {
        socket.close();
      } catch {
        socket.terminate();
      }
    }
  }

  private stopReconnecting(conn: Connection, error: string): void {
    if (this.connections.get(conn.wc.id) === conn) {
      this.connections.delete(conn.wc.id);
    }
    conn.disposed = true;
    conn.socketGeneration += 1;
    conn.state = 'disconnected';
    conn.error = error;
    conn.mirrorSyncPhase = 'disconnected';
    conn.mirrorLease = null;
    conn.mirrorSnapshot = null;
    conn.negotiatedProtocol = undefined;
    if (conn.reconnectTimer) {
      clearTimeout(conn.reconnectTimer);
      conn.reconnectTimer = null;
    }
    this.rejectAllPending(conn, new Error(error));
    for (const pending of conn.mirrorPendingIntents.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(error));
    }
    conn.mirrorPendingIntents.clear();
    for (const pending of conn.mirrorPendingCommands.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(new Error(error));
    }
    conn.mirrorPendingCommands.clear();
    for (const pending of conn.mirrorPendingCoordination.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(error));
    }
    conn.mirrorPendingCoordination.clear();
    for (const pending of conn.mirrorPendingControls.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(error));
    }
    conn.mirrorPendingControls.clear();
    for (const pending of conn.mirrorPendingResourceUploads.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(error));
    }
    conn.mirrorPendingResourceUploads.clear();
    this.rejectPendingMirrorStreamAttaches(conn, new Error(error));
    conn.mirrorStreams.clear();
    this.forgetConnectionResources(conn.wc.id);
    this.resetMirrorAssembly(conn);
    if (conn.ws) {
      const socket = conn.ws;
      conn.ws = null;
      try {
        socket.close();
      } catch {
        socket.terminate();
      }
    }
    if (!conn.wc.isDestroyed()) this.pushStatus(conn);
  }

  private rejectAllPending(conn: Connection, error: Error): void {
    for (const pending of conn.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    conn.pending.clear();
  }

  private forgetConnectionResources(senderId: number): void {
    for (const [resourceId, ownerSenderId] of this.resourceConnectionById) {
      if (ownerSenderId === senderId) this.resourceConnectionById.delete(resourceId);
    }
  }

  private pushStatus(conn: Connection): void {
    if (!conn.wc.isDestroyed()) {
      conn.wc.send(IPC_CHANNELS.REMOTE_STATUS_CHANGED, this.getStatus(conn.wc.id));
    }
  }
}

export const remoteClientManager = new RemoteClientManager();
