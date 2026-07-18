import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RemoteDeviceIdentityStore } from '../RemoteDeviceIdentityStore';

describe('RemoteDeviceIdentityStore', () => {
  let directory: string | null = null;

  afterEach(async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
    directory = null;
  });

  it('persists an Ed25519 identity with only the encrypted private key on disk', async () => {
    directory = await mkdtemp(join(tmpdir(), 'enso-device-identity-'));
    const filePath = join(directory, 'identities.json');
    const encryption = {
      isAvailable: () => true,
      encrypt: (value: string) => Buffer.from(`encrypted:${value}`),
      decrypt: (value: Buffer) => value.toString().replace(/^encrypted:/, ''),
    };
    const store = new RemoteDeviceIdentityStore(filePath, encryption);
    const first = await store.loadOrCreate('device-1');
    const second = await store.loadOrCreate('device-1');
    expect(second).toEqual(first);
    const serialized = await readFile(filePath, 'utf8');
    expect(serialized).not.toContain(first.privateKey);
    expect(serialized).toContain(first.publicKey);
  });

  it('refuses persistent identities when safeStorage is unavailable', async () => {
    directory = await mkdtemp(join(tmpdir(), 'enso-device-identity-'));
    const store = new RemoteDeviceIdentityStore(join(directory, 'identities.json'), {
      isAvailable: () => false,
      encrypt: () => Buffer.alloc(0),
      decrypt: () => '',
    });
    await expect(store.loadOrCreate('device-1')).rejects.toThrow(/safeStorage/);
  });
});
