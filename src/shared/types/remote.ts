/**
 * Remote development protocol types.
 * A client EnsoAI window attaches to a host EnsoAI instance over WebSocket
 * (Tailscale LAN) and forwards whitelisted IPC channels to the host.
 */
import type { ControllerLease, WorkspaceSyncPhase } from './workspaceMirror';

export const REMOTE_PROTOCOL_VERSION = 1;
export const REMOTE_DEFAULT_PORT = 48925;
export const REMOTE_TOKEN_HEADER = 'x-enso-remote-token';

/** Request frame: client -> host */
export interface RemoteReqFrame {
  t: 'req';
  id: number;
  ch: string;
  args: unknown[];
}

/** Response frame: host -> client */
export interface RemoteResFrame {
  t: 'res';
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** Push event frame: host -> client (mirrors event.sender.send) */
export interface RemoteEvFrame {
  t: 'ev';
  ch: string;
  payload: unknown[];
}

/** Handshake frame: host -> client, sent right after auth succeeds */
export interface RemoteHelloFrame {
  t: 'hello';
  protocolVersion: number;
  host: RemoteHostInfo;
}

/** Stable transport-level failure sent before a V1 session becomes active. */
export interface RemoteProtocolErrorFrame {
  t: 'protocol.error';
  code: 'UPGRADE_REQUIRED';
  message: string;
}

export type RemoteFrame =
  | RemoteReqFrame
  | RemoteResFrame
  | RemoteEvFrame
  | RemoteHelloFrame
  | RemoteProtocolErrorFrame;

export interface RemoteHostInfo {
  platform: 'darwin' | 'win32' | 'linux';
  home: string;
  hostname: string;
  appVersion: string;
}

/** Host server status (for host-side settings UI) */
export interface RemoteHostStatus {
  running: boolean;
  port: number;
  /** Address the server is bound to */
  bindAddress: string | null;
  /** Detected Tailscale interface address, if any */
  tailscaleAddress: string | null;
  token: string | null;
  clientCount: number;
  mirrorV2Enabled?: boolean;
  error?: string;
}

export interface RemotePairedDeviceInfo {
  deviceId: string;
  scopes: Array<'mirror.read' | 'mirror.control'>;
  pairedAt: number;
  revokedAt: number | null;
}

/** Client connection status (for client-side UI) */
export type RemoteConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export interface RemoteClientStatus {
  state: RemoteConnectionState;
  host: string | null;
  port: number | null;
  hostInfo: RemoteHostInfo | null;
  mirrorSyncPhase?: WorkspaceSyncPhase;
  mirrorRevision?: number;
  mirrorProtocol?: 'v1' | 'v2';
  mirrorController?: ControllerLease | null;
  mirrorOwnsControl?: boolean;
  mirrorLastResyncReason?: string;
  error?: string;
}

export interface RemoteConnectOptions {
  host: string;
  port: number;
  token: string;
  deviceId?: string;
  clientId?: string;
  mirrorV2?: boolean;
}

/** Settings persisted on the host side (settings.json -> remoteHost) */
export interface RemoteHostSettings {
  enabled: boolean;
  port: number;
  /** 'tailscale' (auto-detect) | 'all' (0.0.0.0) | 'localhost' */
  bind: 'tailscale' | 'all' | 'localhost';
  token: string;
  /** Experimental V2 live mirror. MUST remain default false until P16 promotion. */
  mirrorV2Enabled?: boolean;
  /**
   * Canary stage for measured rollout. Independent of default-on.
   * disabled | observer-canary | controller-canary | terminal-runtime-canary | fully-enabled | enabled
   */
  mirrorV2CanaryStage?:
    | 'disabled'
    | 'observer-canary'
    | 'controller-canary'
    | 'terminal-runtime-canary'
    | 'fully-enabled'
    | 'enabled';
}

/**
 * Channel prefixes forwarded to the remote host when a window is attached.
 * Phase 1: terminal + shell. Phase 2: file/search/git/worktree/temp workspace.
 */
export const REMOTE_FORWARDED_PREFIXES = [
  'terminal:',
  'shell:',
  'file:',
  'search:',
  'git:',
  'worktree:',
  'temp:',
  'todo:',
  'agent:',
  'tmux:',
  'workspaceMirror:',
] as const;

export function isRemoteForwardedChannel(channel: string): boolean {
  return REMOTE_FORWARDED_PREFIXES.some((prefix) => channel.startsWith(prefix));
}

/**
 * WS-only channel used by the client's custom protocol handlers to fetch
 * preview bytes (images/PDF) from the host. Registered as a regular IPC
 * handler on the host so it lands in the handler registry, but never
 * invoked via renderer IPC.
 */
export const REMOTE_FS_READ_FILE_CHANNEL = 'remoteFs:readFile';

export interface RemoteFileReadResult {
  /** Base64-encoded file bytes */
  data: string;
  mime: string;
  size: number;
}
