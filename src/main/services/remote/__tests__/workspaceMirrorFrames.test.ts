import { createEmptyWorkspaceSceneSnapshot } from '@shared/types';
import { describe, expect, it } from 'vitest';
import {
  createWorkspaceSnapshotFrames,
  parseWorkspaceMirrorV2Frame,
  WorkspaceSnapshotAssembler,
} from '../workspaceMirrorFrames';

const snapshot = createEmptyWorkspaceSceneSnapshot({
  hostId: 'host-1',
  sceneId: 'scene-1',
  hostEpoch: '11111111-1111-4111-8111-111111111111',
});

describe('workspace mirror snapshot frames', () => {
  it('round-trips a validated atomic snapshot', () => {
    const frames = createWorkspaceSnapshotFrames(snapshot, 'request-1', 'snapshot-1');
    const assembler = new WorkspaceSnapshotAssembler();
    assembler.start(frames.begin);
    for (const chunk of frames.chunks) assembler.add(chunk);
    expect(assembler.finish(frames.end)).toEqual(snapshot);
  });

  it('rejects out-of-order and corrupted chunks', () => {
    const frames = createWorkspaceSnapshotFrames(snapshot, 'request-1', 'snapshot-1');
    const assembler = new WorkspaceSnapshotAssembler();
    assembler.start(frames.begin);
    expect(() => assembler.add({ ...frames.chunks[0], index: 1 })).toThrow(/not contiguous/);
    expect(() => assembler.add({ ...frames.chunks[0], checksum: '0'.repeat(64) })).toThrow(
      /checksum mismatch/
    );
  });

  it('validates standalone V2 frames before state changes', () => {
    expect(
      parseWorkspaceMirrorV2Frame(
        JSON.stringify({ ...createWorkspaceSnapshotFrames(snapshot, 'r').begin })
      )
    ).toMatchObject({
      t: 'state.snapshot.begin',
      sceneId: 'scene-1',
    });
    expect(() => parseWorkspaceMirrorV2Frame('{"t":"state.subscribe","extra":true}')).toThrow();
  });
});
