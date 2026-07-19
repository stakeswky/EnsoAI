import { createHash } from 'node:crypto';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type WorkspaceMirrorMetricSample, WorkspaceMirrorMetricSampleSchema } from '@shared/types';

export interface MetricCounters {
  revision: number;
  revisionLag: number;
  snapshotDurationMs: number;
  replayDurationMs: number;
  queuedBytes: number;
  resyncReason:
    | 'epoch-changed'
    | 'scene-changed'
    | 'revision-gap'
    | 'retention-floor'
    | 'overflow'
    | null;
  operations: {
    prepared: number;
    executing: number;
    committed: number;
    failed: number;
    needsReconcile: number;
    cancelled: number;
  };
  sockets: number;
  subscribers: number;
  watchers: number;
  ptys: number;
  replayRingBytes: number;
  resourceLeases: number;
  hostEpoch: string;
}

const SENSITIVE_PATTERN =
  /(token|secret|password|private[_-]?key|authorization|cookie|prompt|draft|env)/i;

/**
 * Payload-free metrics collector. Never records paths, frame payloads, terminal
 * bytes, prompts, drafts, credentials or environment values.
 */
export class RemoteMirrorMetrics {
  private readonly samples: WorkspaceMirrorMetricSample[] = [];
  private artifactDirectory: string | null = null;
  private runId: string | null = null;

  async beginRun(artifactRoot: string, runId: string): Promise<string> {
    this.runId = runId;
    this.artifactDirectory = join(artifactRoot, runId);
    await mkdir(this.artifactDirectory, { recursive: true });
    this.samples.length = 0;
    return this.artifactDirectory;
  }

  getArtifactDirectory(): string | null {
    return this.artifactDirectory;
  }

  record(counters: MetricCounters): WorkspaceMirrorMetricSample {
    const sample = WorkspaceMirrorMetricSampleSchema.parse({
      timestamp: Date.now(),
      hostEpochDigest: createHash('sha256').update(counters.hostEpoch).digest('hex'),
      revision: counters.revision,
      revisionLag: counters.revisionLag,
      snapshotDurationMs: counters.snapshotDurationMs,
      replayDurationMs: counters.replayDurationMs,
      queuedBytes: counters.queuedBytes,
      resyncReason: counters.resyncReason,
      operations: counters.operations,
      sockets: counters.sockets,
      subscribers: counters.subscribers,
      watchers: counters.watchers,
      ptys: counters.ptys,
      replayRingBytes: counters.replayRingBytes,
      resourceLeases: counters.resourceLeases,
    });
    this.assertPayloadFree(sample);
    this.samples.push(sample);
    void this.appendNdjson(sample);
    return sample;
  }

  async finalizeSummary(extra: Record<string, unknown> = {}): Promise<string | null> {
    if (!this.artifactDirectory || !this.runId) return null;
    const summary = {
      schemaVersion: 1,
      runId: this.runId,
      sampleCount: this.samples.length,
      lastSample: this.samples.at(-1) ?? null,
      ...extra,
    };
    this.assertPayloadFree(summary);
    const path = join(this.artifactDirectory, 'summary.json');
    await writeFile(path, `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
    return path;
  }

  getSamples(): readonly WorkspaceMirrorMetricSample[] {
    return this.samples;
  }

  private async appendNdjson(sample: WorkspaceMirrorMetricSample): Promise<void> {
    if (!this.artifactDirectory) return;
    const path = join(this.artifactDirectory, 'metrics.ndjson');
    await appendFile(path, `${JSON.stringify(sample)}\n`, 'utf8');
  }

  private assertPayloadFree(value: unknown): void {
    const json = JSON.stringify(value);
    if (SENSITIVE_PATTERN.test(json)) {
      throw new Error('metrics payload contains a sensitive key name');
    }
  }
}

export const remoteMirrorMetrics = new RemoteMirrorMetrics();
