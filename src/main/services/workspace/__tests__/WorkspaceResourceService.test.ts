import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorkspaceResourceService } from '../WorkspaceResourceService';

describe('WorkspaceResourceService', () => {
  let directory: string | null = null;

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = null;
  });

  it('stages verified bytes and permits referenced observers to materialize them', async () => {
    directory = await mkdtemp(join(tmpdir(), 'enso-resource-'));
    const service = new WorkspaceResourceService(directory, {
      createId: () => 'resource-1',
    });
    await service.initialize();
    const reference = await service.stageBuffer(
      Buffer.from('attachment'),
      'screen.png',
      'controller'
    );
    expect(reference).toMatchObject({
      id: 'resource-1',
      displayName: 'screen.png',
      mime: 'image/png',
      size: 10,
    });
    await expect(service.fetch(reference.id, 'observer')).rejects.toThrow(/not available/);

    service.setReferencedResourceIds(new Set([reference.id]));
    const materialized = service.materialize(reference.id, 'observer');
    await expect(readFile(materialized, 'utf8')).resolves.toBe('attachment');
    await expect(service.fetch(reference.id, 'observer')).resolves.toMatchObject({
      reference,
      data: Buffer.from('attachment').toString('base64'),
    });
    expect(service.materializeForRemote(reference.id, 'observer')).toBe(
      `enso-resource://${reference.id}`
    );
    expect(service.resolveRemoteUris(`@enso-resource://${reference.id}`, 'observer')).toBe(
      `@${materialized}`
    );
  });

  it('does not resolve an unreferenced resource for another requester', async () => {
    directory = await mkdtemp(join(tmpdir(), 'enso-resource-'));
    const service = new WorkspaceResourceService(directory, { createId: () => 'resource-1' });
    await service.initialize();
    const reference = await service.stageBuffer(Buffer.from('private'), 'private.txt', 'owner');
    expect(service.materializeForRemote(reference.id, 'owner')).toBe(
      `enso-resource://${reference.id}`
    );
    expect(() => service.resolveRemoteUris(`enso-resource://${reference.id}`, 'observer')).toThrow(
      /not available/
    );
  });

  it('rejects traversal and retains active references during garbage collection', async () => {
    directory = await mkdtemp(join(tmpdir(), 'enso-resource-'));
    let now = 1_000;
    let sequence = 0;
    const service = new WorkspaceResourceService(directory, {
      createId: () => `resource-${++sequence}`,
      leaseMs: 10,
      gcGraceMs: 10,
      now: () => now,
    });
    await service.initialize();
    await expect(
      service.stageBuffer(Buffer.from('x'), '../secret.txt', 'controller')
    ).rejects.toThrow(/display name/);
    const retained = await service.stageBuffer(Buffer.from('keep'), 'keep.txt', 'controller');
    const expired = await service.stageBuffer(Buffer.from('drop'), 'drop.txt', 'controller');
    service.setReferencedResourceIds(new Set([retained.id]));
    now += 100;
    await expect(service.garbageCollect()).resolves.toBe(1);
    expect(service.getReference(retained.id)).toEqual(retained);
    expect(service.getReference(expired.id)).toBeNull();
  });

  it('cleans volatile payloads left by a previous process on startup', async () => {
    directory = await mkdtemp(join(tmpdir(), 'enso-resource-restart-'));
    const first = new WorkspaceResourceService(directory, {
      createId: () => 'resource-stale',
    });
    await first.initialize();
    const reference = await first.stageBuffer(Buffer.from('stale'), 'stale.txt', 'owner');
    const materialized = first.materialize(reference.id, 'owner');

    const restarted = new WorkspaceResourceService(directory);
    await restarted.initialize();
    await expect(restarted.fetch(reference.id, 'owner')).rejects.toThrow(
      'Unknown workspace resource'
    );
    await expect(readFile(materialized)).rejects.toThrow();
  });
});
