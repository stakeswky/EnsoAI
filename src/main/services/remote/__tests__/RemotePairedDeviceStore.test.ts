import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RemotePairedDeviceStore } from '../RemotePairedDeviceStore';

describe('RemotePairedDeviceStore', () => {
  let directory: string | null = null;

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = null;
  });

  it('persists public pairing metadata and refuses key replacement', async () => {
    directory = await mkdtemp(join(tmpdir(), 'enso-paired-device-'));
    const filePath = join(directory, 'devices.json');
    const store = new RemotePairedDeviceStore(filePath, () => 100);
    await store.initialize();
    await expect(store.pair('device-1', 'public-key-1')).resolves.toMatchObject({
      deviceId: 'device-1',
      pairedAt: 100,
      revokedAt: null,
    });
    await expect(store.pair('device-1', 'public-key-2')).rejects.toThrow(/different public key/);

    const restarted = new RemotePairedDeviceStore(filePath, () => 200);
    await restarted.initialize();
    expect(restarted.get('device-1')?.publicKey).toBe('public-key-1');
    await expect(restarted.revoke('device-1')).resolves.toBe(true);
    expect(restarted.get('device-1')?.revokedAt).toBe(200);
  });
});
