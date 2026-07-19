import { WORKSPACE_MIRROR_FLOW_BUDGETS } from '@shared/types';
import { describe, expect, it } from 'vitest';
import { MirrorFlowController } from '../MirrorFlowController';

const identity = {
  streamId: 's1',
  streamKind: 'terminal' as const,
  entityId: 'term-1',
  entityGeneration: 1,
};

function chunk(seq: number, bytes: number, streamId = 's1') {
  return {
    ...identity,
    streamId,
    streamSeq: seq,
    encoding: 'utf8' as const,
    data: 'x'.repeat(bytes),
    sceneRevision: 1,
    byteLength: bytes,
  };
}

describe('MirrorFlowController', () => {
  it('grants initial credit and flushes until credit is exhausted', () => {
    const controller = new MirrorFlowController();
    expect(controller.attach('c1', identity)).toEqual({ ok: true });
    controller.enqueueChunk('c1', chunk(1, 100));
    controller.enqueueChunk('c1', chunk(2, 100));
    const first = controller.flush('c1');
    expect(first).toHaveLength(2);
    expect(first.map((item) => item.streamSeq)).toEqual([1, 2]);

    controller.enqueueChunk(
      'c1',
      chunk(3, WORKSPACE_MIRROR_FLOW_BUDGETS.attachmentInitialCreditBytes)
    );
    const held = controller.flush('c1');
    expect(held).toHaveLength(0);

    const ack = controller.applyAck('c1', {
      ...identity,
      consumedStreamSeq: 2,
      creditBytes: WORKSPACE_MIRROR_FLOW_BUDGETS.attachmentInitialCreditBytes,
    });
    expect(ack).toMatchObject({ ok: true });
    const second = controller.flush('c1');
    expect(second).toHaveLength(1);
    expect(second[0]?.streamSeq).toBe(3);
  });

  it('rejects future and generation-mismatched ACKs without granting credit', () => {
    const controller = new MirrorFlowController();
    controller.attach('c1', identity);
    controller.enqueueChunk('c1', chunk(1, 10));
    controller.flush('c1');

    expect(
      controller.applyAck('c1', {
        ...identity,
        consumedStreamSeq: 99,
        creditBytes: 1000,
      })
    ).toEqual({ ok: false, reason: 'future-seq' });

    expect(
      controller.applyAck('c1', {
        ...identity,
        entityGeneration: 9,
        consumedStreamSeq: 1,
        creditBytes: 1000,
      })
    ).toEqual({ ok: false, reason: 'generation-mismatch' });

    // duplicate ACK is harmless
    expect(
      controller.applyAck('c1', {
        ...identity,
        consumedStreamSeq: 1,
        creditBytes: 0,
      })
    ).toEqual({ ok: true, grantedCredit: 0 });
  });

  it('resets only the overflowing attachment and keeps sibling attachments', () => {
    const controller = new MirrorFlowController();
    const a = { ...identity, streamId: 'a' };
    const b = { ...identity, streamId: 'b', entityId: 'term-2' };
    controller.attach('c1', a);
    controller.attach('c1', b);

    const overflow = controller.enqueueChunk('c1', {
      ...a,
      streamSeq: 1,
      encoding: 'utf8',
      data: 'x'.repeat(WORKSPACE_MIRROR_FLOW_BUDGETS.attachmentHardQueueBytes + 1),
      sceneRevision: 1,
      byteLength: WORKSPACE_MIRROR_FLOW_BUDGETS.attachmentHardQueueBytes + 1,
    });
    expect(overflow).toMatchObject({
      action: 'reset',
      reason: 'backpressure-overflow',
      identity: { streamId: 'a' },
    });

    controller.enqueueChunk('c1', {
      ...b,
      streamSeq: 1,
      encoding: 'utf8',
      data: 'ok',
      sceneRevision: 1,
      byteLength: 2,
    });
    const flushed = controller.flush('c1');
    expect(flushed).toHaveLength(1);
    expect(flushed[0]?.streamId).toBe('b');
  });

  it('round-robins active streams within the per-flush budget', () => {
    const controller = new MirrorFlowController();
    const a = { ...identity, streamId: 'a' };
    const b = { ...identity, streamId: 'b', entityId: 'term-2' };
    controller.attach('c1', a);
    controller.attach('c1', b);

    const piece = Math.floor(WORKSPACE_MIRROR_FLOW_BUDGETS.maxStreamBytesPerFlush / 2);
    for (let i = 1; i <= 4; i += 1) {
      controller.enqueueChunk('c1', {
        ...a,
        streamSeq: i,
        encoding: 'utf8',
        data: 'a'.repeat(piece),
        sceneRevision: 1,
        byteLength: piece,
      });
      controller.enqueueChunk('c1', {
        ...b,
        streamSeq: i,
        encoding: 'utf8',
        data: 'b'.repeat(piece),
        sceneRevision: 1,
        byteLength: piece,
      });
    }

    const flushed = controller.flush(
      'c1',
      WORKSPACE_MIRROR_FLOW_BUDGETS.maxStreamBytesPerFlush * 2
    );
    const ids = flushed.map((item) => item.streamId);
    expect(ids.includes('a')).toBe(true);
    expect(ids.includes('b')).toBe(true);
    // fairness: neither stream monopolizes the entire flush window
    const aCount = ids.filter((id) => id === 'a').length;
    const bCount = ids.filter((id) => id === 'b').length;
    expect(Math.abs(aCount - bCount)).toBeLessThanOrEqual(2);
  });

  it('enforces max attachments per connection', () => {
    const controller = new MirrorFlowController();
    for (let i = 0; i < WORKSPACE_MIRROR_FLOW_BUDGETS.maxAttachmentsPerConnection; i += 1) {
      expect(
        controller.attach('c1', {
          ...identity,
          streamId: `s-${i}`,
          entityId: `e-${i}`,
        })
      ).toEqual({ ok: true });
    }
    expect(
      controller.attach('c1', {
        ...identity,
        streamId: 'overflow',
        entityId: 'overflow',
      })
    ).toEqual({ ok: false, reason: 'attachment-limit' });
  });
});
