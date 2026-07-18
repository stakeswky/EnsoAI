export interface TerminalSession {
  id: string;
  title: string;
  cwd: string;
}

export interface TerminalCreateOptions {
  cwd?: string;
  shell?: string;
  args?: string[];
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
  shellConfig?: import('./shell').ShellConfig;
  /** Command to execute after shell is ready */
  initialCommand?: string;
  /** Stable scene-owned ID. Supplying it opts into persistent attach/detach semantics. */
  sessionId?: string;
  /** Keep the process alive when a renderer or remote socket detaches. */
  persistent?: boolean;
  title?: string;
  workspaceId?: string;
}

export interface TerminalResizeOptions {
  cols: number;
  rows: number;
}

export interface TerminalAttachOptions {
  afterStreamSeq?: number;
}

export interface TerminalAttachResult {
  sessionId: string;
  reset: boolean;
  retainedFromSeq: number;
  currentStreamSeq: number;
  replayedEventCount: number;
}

export interface TerminalStreamReset {
  id: string;
  reason: 'overflow' | 'cursor-ahead';
  retainedFromSeq: number;
  currentStreamSeq: number;
}

export interface TerminalPersistentSessionInfo {
  id: string;
  title: string;
  workspaceId?: string;
  cwd: string | null;
  cols: number;
  rows: number;
  status: 'running' | 'exited';
  createdAt: number;
  exitedAt?: number;
  exitCode?: number;
  signal?: number;
  streamSeq: number;
  retainedFromSeq: number;
  retainedBytes: number;
  subscriberCount: number;
}
