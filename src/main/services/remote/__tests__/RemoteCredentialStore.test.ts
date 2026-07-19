import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type RemoteCredentialEncryption, RemoteCredentialStore } from '../RemoteCredentialStore';

class FakeEncryption implements RemoteCredentialEncryption {
  available = true;

  isAvailable(): boolean {
    return this.available;
  }

  encrypt(value: string): Buffer {
    return Buffer.from(`encrypted:${value}`, 'utf8');
  }

  decrypt(value: Buffer): string {
    const decoded = value.toString('utf8');
    if (!decoded.startsWith('encrypted:')) throw new Error('invalid ciphertext');
    return decoded.slice('encrypted:'.length);
  }
}

describe('RemoteCredentialStore', () => {
  let directory: string;
  let path: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'enso-remote-credentials-'));
    path = join(directory, 'credentials.json');
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('persists only encrypted token bytes under a hashed target key', async () => {
    const encryption = new FakeEncryption();
    const store = new RemoteCredentialStore(path, encryption);
    await expect(store.save('host.tailnet', 48925, 'plain-secret')).resolves.toBe(true);
    await expect(store.load('host.tailnet', 48925)).resolves.toBe('plain-secret');

    const raw = await readFile(path, 'utf8');
    expect(raw).not.toContain('plain-secret');
    expect(raw).not.toContain('host.tailnet');
  });

  it('refuses persistent storage when encryption is unavailable', async () => {
    const encryption = new FakeEncryption();
    encryption.available = false;
    const store = new RemoteCredentialStore(path, encryption);
    await expect(store.save('host', 48925, 'secret')).resolves.toBe(false);
    await expect(store.load('host', 48925)).resolves.toBeNull();
  });
});
