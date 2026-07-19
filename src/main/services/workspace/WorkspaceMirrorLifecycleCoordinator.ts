import { createHash } from 'node:crypto';
import type { WorkspaceMirrorLifecyclePhase, WorkspaceSceneSnapshot } from '@shared/types';
import { workspaceSceneHasVolatileData } from '../remote/RemoteHostServer';

export type LifecycleReason = 'disable' | 'host-stop' | 'graceful-quit' | 'forced-exit-recovery';

export type LifecycleTerminalPolicy = 'preserve-scene-runtimes' | 'destroy-after-handoff';

export interface VolatileHandoffPayload {
  targetRevision: number;
  dirtyBufferVersions: Array<{ worktreeId: string; path: string; version: number }>;
  agentDraftHashes: Array<{ sessionId: string; draftHash: string }>;
}

export interface LifecycleTransitionResult {
  ok: boolean;
  phase: WorkspaceMirrorLifecyclePhase;
  reason: LifecycleReason;
  blockedBy?: string;
  handoff?: VolatileHandoffPayload;
  timedOut?: boolean;
}

export interface LifecycleDependencies {
  getSnapshot: () => WorkspaceSceneSnapshot;
  freezeMutations: () => void;
  unfreezeMutations: () => void;
  drainOperations: (signal: AbortSignal) => Promise<'drained' | 'blocked' | 'timeout'>;
  requestHostHandoff: (
    handoff: VolatileHandoffPayload,
    signal: AbortSignal
  ) => Promise<'acked' | 'no-renderer' | 'mismatch' | 'timeout'>;
  detachTransport: () => Promise<void>;
  destroyRuntimes: () => Promise<void>;
  persistDisabled: () => Promise<void>;
  notifyClients: (phase: WorkspaceMirrorLifecyclePhase, reason: LifecycleReason) => void;
  releaseControllerLease: () => Promise<void>;
  now?: () => number;
  disableDeadlineMs?: number;
  quitDeadlineMs?: number;
}

const DEFAULT_DISABLE_DEADLINE_MS = 30_000;
const DEFAULT_QUIT_DEADLINE_MS = 5_000;

function hashDraft(text: string, resourceIds: string[]): string {
  return createHash('sha256')
    .update(text)
    .update('\0')
    .update(resourceIds.join('\0'))
    .digest('hex');
}

export function buildVolatileHandoff(snapshot: WorkspaceSceneSnapshot): VolatileHandoffPayload {
  const dirtyBufferVersions: VolatileHandoffPayload['dirtyBufferVersions'] = [];
  for (const [worktreeId, editor] of Object.entries(snapshot.editors)) {
    for (const buffer of Object.values(editor.buffers)) {
      if (buffer.isDirty || buffer.content !== undefined) {
        dirtyBufferVersions.push({
          worktreeId,
          path: buffer.path,
          version: buffer.version,
        });
      }
    }
  }
  const agentDraftHashes: VolatileHandoffPayload['agentDraftHashes'] = [];
  for (const session of Object.values(snapshot.agents.sessions)) {
    if (session.draft.text.length > 0 || session.draft.resources.length > 0) {
      agentDraftHashes.push({
        sessionId: session.id,
        draftHash: hashDraft(
          session.draft.text,
          session.draft.resources.map((resource) => resource.id)
        ),
      });
    }
  }
  return {
    targetRevision: snapshot.revision,
    dirtyBufferVersions,
    agentDraftHashes,
  };
}

/**
 * Unified lifecycle for Disable Live Mirror / Stop Remote Host / graceful quit.
 * State machine: enabled -> quiescing -> disabled.
 */
export class WorkspaceMirrorLifecycleCoordinator {
  private phase: WorkspaceMirrorLifecyclePhase = 'enabled';
  private activeAbort: AbortController | null = null;
  private lastIncompleteMarker: { at: number; reason: LifecycleReason } | null = null;
  private explicitDiscard = false;
  private explicitExportAck = false;

  constructor(private readonly deps: LifecycleDependencies) {}

  getPhase(): WorkspaceMirrorLifecyclePhase {
    return this.phase;
  }

  getForcedExitRecoveryWarning(): { at: number; reason: LifecycleReason } | null {
    return this.lastIncompleteMarker;
  }

  markForcedExitIncomplete(reason: LifecycleReason = 'forced-exit-recovery'): void {
    this.lastIncompleteMarker = { at: (this.deps.now ?? Date.now)(), reason };
  }

  clearForcedExitMarker(): void {
    this.lastIncompleteMarker = null;
  }

  acknowledgeExport(): void {
    this.explicitExportAck = true;
  }

  acknowledgeDiscard(): void {
    this.explicitDiscard = true;
  }

  isMutationFrozen(): boolean {
    return this.phase === 'quiescing' || this.phase === 'disabled';
  }

  async transitionToDisabled(
    reason: Exclude<LifecycleReason, 'forced-exit-recovery'>
  ): Promise<LifecycleTransitionResult> {
    if (this.phase === 'disabled') {
      return { ok: true, phase: 'disabled', reason };
    }
    if (this.phase === 'quiescing') {
      return { ok: false, phase: 'quiescing', reason, blockedBy: 'transition-in-progress' };
    }

    const deadlineMs =
      reason === 'graceful-quit'
        ? (this.deps.quitDeadlineMs ?? DEFAULT_QUIT_DEADLINE_MS)
        : (this.deps.disableDeadlineMs ?? DEFAULT_DISABLE_DEADLINE_MS);
    const terminalPolicy: LifecycleTerminalPolicy =
      reason === 'graceful-quit' ? 'destroy-after-handoff' : 'preserve-scene-runtimes';

    this.phase = 'quiescing';
    this.deps.freezeMutations();
    this.deps.notifyClients('quiescing', reason);
    this.activeAbort = new AbortController();
    const signal = this.activeAbort.signal;
    const timeout = setTimeout(() => this.activeAbort?.abort(), deadlineMs);

    try {
      const drain = await this.deps.drainOperations(signal);
      if (drain === 'timeout' || signal.aborted) {
        return this.rollback(reason, 'drain-timeout', true);
      }
      if (drain === 'blocked') {
        return this.rollback(reason, 'operations-unclassified');
      }

      const snapshot = this.deps.getSnapshot();
      const hasVolatile = workspaceSceneHasVolatileData(snapshot);
      const handoff = buildVolatileHandoff(snapshot);

      if (hasVolatile) {
        if (this.explicitDiscard) {
          // explicit discard allowed
        } else if (this.explicitExportAck) {
          // export completed
        } else {
          const handoffResult = await this.deps.requestHostHandoff(handoff, signal);
          if (handoffResult === 'timeout' || signal.aborted) {
            return this.rollback(reason, 'handoff-timeout', true);
          }
          if (handoffResult === 'no-renderer') {
            return this.rollback(reason, 'handoff-requires-export-or-discard', false, handoff);
          }
          if (handoffResult === 'mismatch') {
            return this.rollback(reason, 'handoff-ack-mismatch', false, handoff);
          }
        }
      }

      await this.deps.releaseControllerLease();
      await this.deps.detachTransport();
      if (terminalPolicy === 'destroy-after-handoff') {
        await this.deps.destroyRuntimes();
      }
      await this.deps.persistDisabled();
      this.phase = 'disabled';
      this.deps.notifyClients('disabled', reason);
      this.explicitDiscard = false;
      this.explicitExportAck = false;
      return { ok: true, phase: 'disabled', reason, handoff };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'lifecycle-failed';
      return this.rollback(reason, message);
    } finally {
      clearTimeout(timeout);
      this.activeAbort = null;
    }
  }

  async reEnable(): Promise<LifecycleTransitionResult> {
    if (this.phase === 'enabled') {
      return { ok: true, phase: 'enabled', reason: 'disable' };
    }
    if (this.phase === 'quiescing') {
      return {
        ok: false,
        phase: 'quiescing',
        reason: 'disable',
        blockedBy: 'transition-in-progress',
      };
    }
    this.phase = 'enabled';
    this.deps.unfreezeMutations();
    this.deps.notifyClients('enabled', 'disable');
    return { ok: true, phase: 'enabled', reason: 'disable' };
  }

  private rollback(
    reason: LifecycleReason,
    blockedBy: string,
    timedOut = false,
    handoff?: VolatileHandoffPayload
  ): LifecycleTransitionResult {
    this.phase = 'enabled';
    this.deps.unfreezeMutations();
    this.deps.notifyClients('enabled', reason);
    return {
      ok: false,
      phase: 'enabled',
      reason,
      blockedBy,
      timedOut,
      handoff,
    };
  }
}
