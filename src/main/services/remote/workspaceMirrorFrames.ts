import { createHash, randomUUID } from 'node:crypto';
import {
  type StateSnapshotBeginFrame,
  StateSnapshotBeginFrameSchema,
  type StateSnapshotChunkFrame,
  StateSnapshotChunkFrameSchema,
  type StateSnapshotEndFrame,
  StateSnapshotEndFrameSchema,
  WORKSPACE_MIRROR_MAX_SNAPSHOT_BYTES,
  WORKSPACE_MIRROR_MAX_SNAPSHOT_CHUNK_BYTES,
  type WorkspaceMirrorV2Frame,
  WorkspaceMirrorV2FrameSchema,
  type WorkspaceSceneSnapshot,
  WorkspaceSceneSnapshotSchema,
} from '@shared/types';

const MAX_V2_FRAME_BYTES = 2 * 1024 * 1024;

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function parseWorkspaceMirrorV2Frame(raw: string | Buffer): WorkspaceMirrorV2Frame {
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw, 'utf8');
  if (bytes.byteLength > MAX_V2_FRAME_BYTES) {
    throw new Error('workspace mirror frame exceeds size limit');
  }
  let candidate: unknown;
  try {
    candidate = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('workspace mirror frame is not valid JSON');
  }
  return WorkspaceMirrorV2FrameSchema.parse(candidate);
}

export interface WorkspaceSnapshotFrames {
  begin: StateSnapshotBeginFrame;
  chunks: StateSnapshotChunkFrame[];
  end: StateSnapshotEndFrame;
}

export function createWorkspaceSnapshotFrames(
  snapshot: WorkspaceSceneSnapshot,
  requestId: string,
  snapshotId: string = randomUUID()
): WorkspaceSnapshotFrames {
  const parsed = WorkspaceSceneSnapshotSchema.parse(snapshot);
  const serialized = Buffer.from(JSON.stringify(parsed), 'utf8');
  if (serialized.byteLength > WORKSPACE_MIRROR_MAX_SNAPSHOT_BYTES) {
    throw new Error('workspace snapshot exceeds the logical size limit');
  }
  const checksum = sha256(serialized);
  const chunks: StateSnapshotChunkFrame[] = [];
  for (let offset = 0, index = 0; offset < serialized.length; index += 1) {
    const bytes = serialized.subarray(
      offset,
      Math.min(offset + WORKSPACE_MIRROR_MAX_SNAPSHOT_CHUNK_BYTES, serialized.length)
    );
    chunks.push(
      StateSnapshotChunkFrameSchema.parse({
        t: 'state.snapshot.chunk',
        snapshotId,
        index,
        data: bytes.toString('base64'),
        checksum: sha256(bytes),
      })
    );
    offset += bytes.length;
  }
  if (chunks.length === 0) {
    const bytes = Buffer.from('{}');
    chunks.push(
      StateSnapshotChunkFrameSchema.parse({
        t: 'state.snapshot.chunk',
        snapshotId,
        index: 0,
        data: bytes.toString('base64'),
        checksum: sha256(bytes),
      })
    );
  }
  const begin = StateSnapshotBeginFrameSchema.parse({
    t: 'state.snapshot.begin',
    requestId,
    snapshotId,
    hostEpoch: parsed.hostEpoch,
    sceneId: parsed.sceneId,
    snapshotRevision: parsed.revision,
    schemaVersion: parsed.schemaVersion,
    totalChunks: chunks.length,
    totalBytes: serialized.length,
    checksum,
  });
  const end = StateSnapshotEndFrameSchema.parse({
    t: 'state.snapshot.end',
    snapshotId,
    totalChunks: chunks.length,
    checksum,
  });
  return { begin, chunks, end };
}

export class WorkspaceSnapshotAssembler {
  private begin: StateSnapshotBeginFrame | null = null;
  private chunks: Buffer[] = [];

  start(candidate: StateSnapshotBeginFrame): void {
    const begin = StateSnapshotBeginFrameSchema.parse(candidate);
    this.begin = begin;
    this.chunks = [];
  }

  add(candidate: StateSnapshotChunkFrame): void {
    const begin = this.begin;
    if (!begin) throw new Error('snapshot chunk arrived before begin');
    const chunk = StateSnapshotChunkFrameSchema.parse(candidate);
    if (chunk.snapshotId !== begin.snapshotId) throw new Error('snapshot id changed');
    if (chunk.index !== this.chunks.length) throw new Error('snapshot chunks are not contiguous');
    if (chunk.index >= begin.totalChunks) throw new Error('snapshot contains too many chunks');
    const bytes = Buffer.from(chunk.data, 'base64');
    if (bytes.byteLength > WORKSPACE_MIRROR_MAX_SNAPSHOT_CHUNK_BYTES) {
      throw new Error('snapshot chunk exceeds size limit');
    }
    if (sha256(bytes) !== chunk.checksum) throw new Error('snapshot chunk checksum mismatch');
    this.chunks.push(bytes);
  }

  finish(candidate: StateSnapshotEndFrame): WorkspaceSceneSnapshot {
    const begin = this.begin;
    if (!begin) throw new Error('snapshot end arrived before begin');
    const end = StateSnapshotEndFrameSchema.parse(candidate);
    if (end.snapshotId !== begin.snapshotId || end.checksum !== begin.checksum) {
      throw new Error('snapshot end does not match begin');
    }
    if (end.totalChunks !== begin.totalChunks || this.chunks.length !== begin.totalChunks) {
      throw new Error('snapshot is incomplete');
    }
    const bytes = Buffer.concat(this.chunks);
    if (bytes.byteLength !== begin.totalBytes || sha256(bytes) !== begin.checksum) {
      throw new Error('snapshot checksum mismatch');
    }
    let candidateSnapshot: unknown;
    try {
      candidateSnapshot = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new Error('snapshot payload is not valid JSON');
    } finally {
      this.begin = null;
      this.chunks = [];
    }
    const snapshot = WorkspaceSceneSnapshotSchema.parse(candidateSnapshot);
    if (
      snapshot.hostEpoch !== begin.hostEpoch ||
      snapshot.sceneId !== begin.sceneId ||
      snapshot.revision !== begin.snapshotRevision
    ) {
      throw new Error('snapshot identity does not match envelope');
    }
    return snapshot;
  }
}
