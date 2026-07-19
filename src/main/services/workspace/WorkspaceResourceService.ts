import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { WORKSPACE_RESOURCE_URI_PREFIX, type WorkspaceResourceReference } from '@shared/types';

export const DEFAULT_WORKSPACE_RESOURCE_MAX_BYTES = 10 * 1024 * 1024;
export const DEFAULT_WORKSPACE_RESOURCE_LEASE_MS = 5 * 60 * 1_000;
export const DEFAULT_WORKSPACE_RESOURCE_GC_GRACE_MS = 60 * 1_000;
export function workspaceResourceUri(resourceId: string): string {
  return `${WORKSPACE_RESOURCE_URI_PREFIX}${resourceId}`;
}

interface WorkspaceResourceRecord {
  reference: WorkspaceResourceReference;
  path: string;
  ownerId: string;
  createdAt: number;
  expiresAt: number;
  referenced: boolean;
  lastAccessedAt: number;
}

export interface WorkspaceResourceServiceOptions {
  maxBytes?: number;
  leaseMs?: number;
  gcGraceMs?: number;
  now?: () => number;
  createId?: () => string;
}

export interface WorkspaceResourceFetchResult {
  reference: WorkspaceResourceReference;
  data: string;
}

function mimeForName(name: string): string {
  switch (extname(name).toLowerCase()) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.svg':
      return 'image/svg+xml';
    case '.txt':
    case '.md':
      return 'text/plain';
    default:
      return 'application/octet-stream';
  }
}

function validateDisplayName(candidate: string): string {
  const normalized = candidate.trim();
  if (
    normalized.length === 0 ||
    normalized.length > 512 ||
    basename(normalized) !== normalized ||
    normalized === '.' ||
    normalized === '..' ||
    /[\0\r\n]/.test(normalized)
  ) {
    throw new Error('Invalid workspace resource display name');
  }
  return normalized;
}

/** Host-owned staging area for mirrored Agent attachments. */
export class WorkspaceResourceService {
  private readonly records = new Map<string, WorkspaceResourceRecord>();
  private readonly maxBytes: number;
  private readonly leaseMs: number;
  private readonly gcGraceMs: number;
  private readonly now: () => number;
  private readonly createId: () => string;

  constructor(
    private readonly rootDirectory: string,
    options: WorkspaceResourceServiceOptions = {}
  ) {
    this.maxBytes = options.maxBytes ?? DEFAULT_WORKSPACE_RESOURCE_MAX_BYTES;
    this.leaseMs = options.leaseMs ?? DEFAULT_WORKSPACE_RESOURCE_LEASE_MS;
    this.gcGraceMs = options.gcGraceMs ?? DEFAULT_WORKSPACE_RESOURCE_GC_GRACE_MS;
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? (() => `resource-${randomUUID()}`);
  }

  async initialize(): Promise<void> {
    await mkdir(this.rootDirectory, { recursive: true, mode: 0o700 });
    // Resource payloads are intentionally volatile and their metadata is not
    // part of the durable scene. Remove files left by a prior crashed process
    // so an in-memory registry can never strand attachment bytes forever.
    const entries = await readdir(this.rootDirectory, { withFileTypes: true });
    await Promise.all(
      entries
        .filter((entry) => entry.isFile() && /^[A-Za-z0-9._:-]{1,256}\.bin$/.test(entry.name))
        .map((entry) => unlink(join(this.rootDirectory, entry.name)).catch(() => undefined))
    );
  }

  async stageFile(
    sourcePath: string,
    ownerId: string,
    mime?: string
  ): Promise<WorkspaceResourceReference> {
    const source = await stat(sourcePath);
    if (!source.isFile()) throw new Error('Workspace resource source is not a file');
    if (source.size > this.maxBytes) throw new Error('Workspace resource exceeds the size limit');
    return this.stageBuffer(await readFile(sourcePath), basename(sourcePath), ownerId, mime);
  }

  async stageBuffer(
    data: Buffer,
    displayName: string,
    ownerId: string,
    mime?: string
  ): Promise<WorkspaceResourceReference> {
    if (!ownerId.trim()) throw new Error('Workspace resource owner is required');
    if (data.byteLength > this.maxBytes)
      throw new Error('Workspace resource exceeds the size limit');
    const safeName = validateDisplayName(displayName);
    const id = this.nextId();
    const checksum = createHash('sha256').update(data).digest('hex');
    const reference: WorkspaceResourceReference = {
      id,
      displayName: safeName,
      mime: mime?.trim() || mimeForName(safeName),
      size: data.byteLength,
      checksum,
    };
    const targetPath = join(this.rootDirectory, `${id}.bin`);
    await writeFile(targetPath, data, { flag: 'wx', mode: 0o600 });
    const now = this.now();
    this.records.set(id, {
      reference,
      path: targetPath,
      ownerId,
      createdAt: now,
      expiresAt: now + this.leaseMs,
      referenced: false,
      lastAccessedAt: now,
    });
    return structuredClone(reference);
  }

  setReferencedResourceIds(resourceIds: ReadonlySet<string>): void {
    for (const record of this.records.values()) {
      record.referenced = resourceIds.has(record.reference.id);
      if (record.referenced) record.lastAccessedAt = this.now();
    }
  }

  materialize(resourceId: string, requesterId: string): string {
    const record = this.authorizeRead(resourceId, requesterId);
    record.lastAccessedAt = this.now();
    return record.path;
  }

  /**
   * Remote renderers receive an opaque reference instead of a host path. The
   * reference is resolved only when the host is about to write to a PTY.
   */
  materializeForRemote(resourceId: string, requesterId: string): string {
    this.materialize(resourceId, requesterId);
    return workspaceResourceUri(resourceId);
  }

  resolveRemoteUris(data: string, requesterId: string): string {
    return data.replace(
      /enso-resource:\/\/([A-Za-z0-9._:-]{1,256})/g,
      (_match, resourceId: string) => this.materialize(resourceId, requesterId)
    );
  }

  async fetch(resourceId: string, requesterId: string): Promise<WorkspaceResourceFetchResult> {
    const record = this.authorizeRead(resourceId, requesterId);
    const data = await readFile(record.path);
    const checksum = createHash('sha256').update(data).digest('hex');
    if (checksum !== record.reference.checksum || data.byteLength !== record.reference.size) {
      throw new Error('Workspace resource checksum mismatch');
    }
    record.lastAccessedAt = this.now();
    return { reference: structuredClone(record.reference), data: data.toString('base64') };
  }

  async garbageCollect(force = false): Promise<number> {
    const now = this.now();
    const expired = [...this.records.values()].filter(
      (record) =>
        !record.referenced &&
        (force || (now >= record.expiresAt && now - record.lastAccessedAt >= this.gcGraceMs))
    );
    for (const record of expired) {
      this.records.delete(record.reference.id);
      await unlink(record.path).catch(() => undefined);
    }
    return expired.length;
  }

  getReference(resourceId: string): WorkspaceResourceReference | null {
    const reference = this.records.get(resourceId)?.reference;
    return reference ? structuredClone(reference) : null;
  }

  private authorizeRead(resourceId: string, requesterId: string): WorkspaceResourceRecord {
    const record = this.records.get(resourceId);
    if (!record) throw new Error('Unknown workspace resource');
    if (!record.referenced && record.ownerId !== requesterId) {
      throw new Error('Workspace resource is not available to this client');
    }
    return record;
  }

  private nextId(): string {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const id = this.createId();
      if (/^[A-Za-z0-9._:-]{1,256}$/.test(id) && !this.records.has(id)) return id;
    }
    throw new Error('Unable to allocate a workspace resource ID');
  }
}
