import {
  type StreamAckFrame,
  WORKSPACE_MIRROR_FLOW_BUDGETS,
  type WorkspaceStreamKind,
} from '@shared/types';

export type FlowPlane = 'control' | 'state' | 'stream';

export interface StreamIdentity {
  streamId: string;
  streamKind: WorkspaceStreamKind;
  entityId: string;
  entityGeneration: number;
}

export interface QueuedStreamChunk extends StreamIdentity {
  streamSeq: number;
  byteLength: number;
  encoding: 'utf8' | 'base64';
  data: string;
  sceneRevision: number;
}

export type FlowDecision =
  | { action: 'send'; chunk: QueuedStreamChunk }
  | { action: 'hold' }
  | {
      action: 'reset';
      attachmentKey: string;
      reason: 'backpressure-overflow';
      nextStreamSeq: number;
      identity: StreamIdentity;
    };

interface AttachmentFlowState {
  identity: StreamIdentity;
  creditBytes: number;
  queuedBytes: number;
  highestSentSeq: number;
  lastAckedSeq: number;
  queue: QueuedStreamChunk[];
  paused: boolean;
}

interface ConnectionFlowState {
  connectionId: string;
  queuedBytes: number;
  attachments: Map<string, AttachmentFlowState>;
  /** Round-robin cursor over attachment keys. */
  rrIndex: number;
}

export interface FlowControllerSnapshot {
  connectionId: string;
  connectionQueuedBytes: number;
  attachmentCount: number;
  attachments: Array<{
    streamId: string;
    creditBytes: number;
    queuedBytes: number;
    highestSentSeq: number;
    lastAckedSeq: number;
    queueDepth: number;
  }>;
}

const budgets = WORKSPACE_MIRROR_FLOW_BUDGETS;

function attachmentKey(identity: StreamIdentity): string {
  return `${identity.streamKind}:${identity.entityId}:${identity.entityGeneration}:${identity.streamId}`;
}

function encodedByteLength(encoding: 'utf8' | 'base64', data: string): number {
  if (encoding === 'base64') {
    return Buffer.byteLength(data, 'base64');
  }
  return Buffer.byteLength(data, 'utf8');
}

/**
 * Per-connection / per-attachment stream flow controller.
 * Host PTY output is never paused — only the slow attachment is reset/detached.
 */
export class MirrorFlowController {
  private readonly connections = new Map<string, ConnectionFlowState>();
  private hostQueuedBytes = 0;

  getHostQueuedBytes(): number {
    return this.hostQueuedBytes;
  }

  ensureConnection(connectionId: string): void {
    if (!this.connections.has(connectionId)) {
      this.connections.set(connectionId, {
        connectionId,
        queuedBytes: 0,
        attachments: new Map(),
        rrIndex: 0,
      });
    }
  }

  dropConnection(connectionId: string): void {
    const conn = this.connections.get(connectionId);
    if (!conn) return;
    this.hostQueuedBytes = Math.max(0, this.hostQueuedBytes - conn.queuedBytes);
    this.connections.delete(connectionId);
  }

  attach(
    connectionId: string,
    identity: StreamIdentity
  ): { ok: true } | { ok: false; reason: string } {
    this.ensureConnection(connectionId);
    const conn = this.connections.get(connectionId);
    if (!conn) return { ok: false, reason: 'connection-missing' };
    if (conn.attachments.size >= budgets.maxAttachmentsPerConnection) {
      return { ok: false, reason: 'attachment-limit' };
    }
    const key = attachmentKey(identity);
    conn.attachments.set(key, {
      identity: { ...identity },
      creditBytes: budgets.attachmentInitialCreditBytes,
      queuedBytes: 0,
      highestSentSeq: 0,
      lastAckedSeq: 0,
      queue: [],
      paused: false,
    });
    return { ok: true };
  }

  detach(connectionId: string, identity: StreamIdentity): void {
    const conn = this.connections.get(connectionId);
    if (!conn) return;
    const key = attachmentKey(identity);
    const attachment = conn.attachments.get(key);
    if (!attachment) return;
    conn.queuedBytes = Math.max(0, conn.queuedBytes - attachment.queuedBytes);
    this.hostQueuedBytes = Math.max(0, this.hostQueuedBytes - attachment.queuedBytes);
    conn.attachments.delete(key);
  }

  /**
   * Enqueue a stream chunk for an attachment. Returns reset decision if budgets overflow.
   * Does not send — caller drains via flush().
   */
  enqueueChunk(
    connectionId: string,
    chunk: Omit<QueuedStreamChunk, 'byteLength'> & { byteLength?: number }
  ): FlowDecision {
    this.ensureConnection(connectionId);
    const conn = this.connections.get(connectionId);
    if (!conn) return { action: 'hold' };
    const key = attachmentKey(chunk);
    let attachment = conn.attachments.get(key);
    if (!attachment) {
      const attached = this.attach(connectionId, chunk);
      if (!attached.ok) {
        return {
          action: 'reset',
          attachmentKey: key,
          reason: 'backpressure-overflow',
          nextStreamSeq: chunk.streamSeq,
          identity: {
            streamId: chunk.streamId,
            streamKind: chunk.streamKind,
            entityId: chunk.entityId,
            entityGeneration: chunk.entityGeneration,
          },
        };
      }
      attachment = conn.attachments.get(key);
      if (!attachment) return { action: 'hold' };
    }

    const byteLength = chunk.byteLength ?? encodedByteLength(chunk.encoding, chunk.data);
    const queued: QueuedStreamChunk = {
      streamId: chunk.streamId,
      streamKind: chunk.streamKind,
      entityId: chunk.entityId,
      entityGeneration: chunk.entityGeneration,
      streamSeq: chunk.streamSeq,
      byteLength,
      encoding: chunk.encoding,
      data: chunk.data,
      sceneRevision: chunk.sceneRevision,
    };

    // Hard overflow: reset only this attachment.
    if (
      attachment.queuedBytes + byteLength > budgets.attachmentHardQueueBytes ||
      conn.queuedBytes + byteLength > budgets.connectionHardQueueBytes ||
      this.hostQueuedBytes + byteLength > budgets.hostHardQueueBytes
    ) {
      this.clearAttachmentQueue(conn, attachment, key);
      return {
        action: 'reset',
        attachmentKey: key,
        reason: 'backpressure-overflow',
        nextStreamSeq: Math.max(attachment.highestSentSeq, chunk.streamSeq),
        identity: { ...attachment.identity },
      };
    }

    attachment.queue.push(queued);
    attachment.queuedBytes += byteLength;
    conn.queuedBytes += byteLength;
    this.hostQueuedBytes += byteLength;

    if (
      attachment.queuedBytes > budgets.attachmentHardQueueBytes * 0.9 ||
      conn.queuedBytes >= budgets.connectionHighWaterBytes ||
      this.hostQueuedBytes >= budgets.hostHighWaterBytes
    ) {
      attachment.paused = true;
    }

    return { action: 'hold' };
  }

  /**
   * Apply a consumer ACK. Rejects forged/future/stale-generation ACKs without granting credit.
   */
  applyAck(
    connectionId: string,
    ack: Pick<
      StreamAckFrame,
      | 'streamId'
      | 'streamKind'
      | 'entityId'
      | 'entityGeneration'
      | 'consumedStreamSeq'
      | 'creditBytes'
    >
  ): { ok: true; grantedCredit: number } | { ok: false; reason: string } {
    const conn = this.connections.get(connectionId);
    if (!conn) return { ok: false, reason: 'connection-missing' };
    // Locate by streamId first so a stale generation cannot silently miss and
    // later attach under a forged identity with free credit.
    const attachment =
      conn.attachments.get(attachmentKey(ack)) ??
      [...conn.attachments.values()].find(
        (candidate) => candidate.identity.streamId === ack.streamId
      );
    if (!attachment) return { ok: false, reason: 'attachment-missing' };
    if (
      attachment.identity.streamKind !== ack.streamKind ||
      attachment.identity.entityId !== ack.entityId ||
      attachment.identity.entityGeneration !== ack.entityGeneration
    ) {
      return { ok: false, reason: 'generation-mismatch' };
    }
    if (ack.consumedStreamSeq < attachment.lastAckedSeq) {
      // Duplicate / stale ACK — harmless no-op.
      return { ok: true, grantedCredit: 0 };
    }
    if (ack.consumedStreamSeq > attachment.highestSentSeq) {
      return { ok: false, reason: 'future-seq' };
    }
    if (!Number.isFinite(ack.creditBytes) || ack.creditBytes < 0) {
      return { ok: false, reason: 'invalid-credit' };
    }

    attachment.lastAckedSeq = ack.consumedStreamSeq;
    const granted = Math.min(
      ack.creditBytes,
      budgets.attachmentInitialCreditBytes * 2 - attachment.creditBytes
    );
    const credit = Math.max(0, granted);
    attachment.creditBytes += credit;
    if (attachment.creditBytes > 0 && conn.queuedBytes <= budgets.connectionLowWaterBytes) {
      attachment.paused = false;
    }
    return { ok: true, grantedCredit: credit };
  }

  /**
   * Drain sendable chunks with plane priority reserved for control/state by the caller.
   * Fair round-robin across attachments with maxStreamBytesPerFlush per stream.
   */
  flush(
    connectionId: string,
    maxTotalBytes = budgets.maxStreamBytesPerFlush * 4
  ): QueuedStreamChunk[] {
    const conn = this.connections.get(connectionId);
    if (!conn || conn.attachments.size === 0) return [];

    const keys = [...conn.attachments.keys()];
    const sent: QueuedStreamChunk[] = [];
    let totalSent = 0;
    let idleRounds = 0;

    while (totalSent < maxTotalBytes && idleRounds < keys.length) {
      if (keys.length === 0) break;
      conn.rrIndex = conn.rrIndex % keys.length;
      const key = keys[conn.rrIndex]!;
      const attachment = conn.attachments.get(key);
      conn.rrIndex += 1;
      if (!attachment || attachment.queue.length === 0 || attachment.paused) {
        idleRounds += 1;
        continue;
      }

      let streamBudget = budgets.maxStreamBytesPerFlush;
      let progressed = false;
      while (
        attachment.queue.length > 0 &&
        streamBudget > 0 &&
        totalSent < maxTotalBytes &&
        attachment.creditBytes > 0
      ) {
        const next = attachment.queue[0]!;
        if (next.byteLength > attachment.creditBytes) break;
        if (next.byteLength > streamBudget && progressed) break;

        attachment.queue.shift();
        attachment.queuedBytes = Math.max(0, attachment.queuedBytes - next.byteLength);
        conn.queuedBytes = Math.max(0, conn.queuedBytes - next.byteLength);
        this.hostQueuedBytes = Math.max(0, this.hostQueuedBytes - next.byteLength);
        attachment.creditBytes = Math.max(0, attachment.creditBytes - next.byteLength);
        attachment.highestSentSeq = Math.max(attachment.highestSentSeq, next.streamSeq);
        sent.push(next);
        totalSent += next.byteLength;
        streamBudget -= next.byteLength;
        progressed = true;
      }

      if (progressed) idleRounds = 0;
      else idleRounds += 1;
    }

    return sent;
  }

  snapshot(connectionId: string): FlowControllerSnapshot | null {
    const conn = this.connections.get(connectionId);
    if (!conn) return null;
    return {
      connectionId,
      connectionQueuedBytes: conn.queuedBytes,
      attachmentCount: conn.attachments.size,
      attachments: [...conn.attachments.values()].map((attachment) => ({
        streamId: attachment.identity.streamId,
        creditBytes: attachment.creditBytes,
        queuedBytes: attachment.queuedBytes,
        highestSentSeq: attachment.highestSentSeq,
        lastAckedSeq: attachment.lastAckedSeq,
        queueDepth: attachment.queue.length,
      })),
    };
  }

  private clearAttachmentQueue(
    conn: ConnectionFlowState,
    attachment: AttachmentFlowState,
    key: string
  ): void {
    conn.queuedBytes = Math.max(0, conn.queuedBytes - attachment.queuedBytes);
    this.hostQueuedBytes = Math.max(0, this.hostQueuedBytes - attachment.queuedBytes);
    attachment.queue.length = 0;
    attachment.queuedBytes = 0;
    attachment.creditBytes = 0;
    attachment.paused = true;
    conn.attachments.delete(key);
  }
}

export function estimateFrameBytes(frame: unknown): number {
  return Buffer.byteLength(JSON.stringify(frame), 'utf8');
}
