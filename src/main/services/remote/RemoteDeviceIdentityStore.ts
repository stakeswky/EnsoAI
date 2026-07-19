import { generateKeyPairSync } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface RemoteDeviceIdentity {
  deviceId: string;
  publicKey: string;
  privateKey: string;
}

interface StoredIdentity {
  publicKey: string;
  encryptedPrivateKey: string;
}

interface IdentityFile {
  version: 1;
  identities: Record<string, StoredIdentity>;
}

export interface RemoteIdentityEncryption {
  isAvailable(): boolean;
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}

function emptyFile(): IdentityFile {
  return { version: 1, identities: {} };
}

function createIdentity(deviceId: string): RemoteDeviceIdentity {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    deviceId,
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  };
}

/** Device private keys encrypted by Electron safeStorage. */
export class RemoteDeviceIdentityStore {
  private operationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly encryption: RemoteIdentityEncryption
  ) {}

  loadOrCreate(deviceId: string): Promise<RemoteDeviceIdentity> {
    return this.exclusive(async () => {
      if (!this.encryption.isAvailable()) {
        throw new Error('Persistent Remote Mirror pairing requires safeStorage');
      }
      if (!/^[A-Za-z0-9._:-]{1,256}$/.test(deviceId)) throw new Error('Invalid remote device ID');
      const file = await this.read();
      const existing = file.identities[deviceId];
      if (existing) {
        try {
          return {
            deviceId,
            publicKey: existing.publicKey,
            privateKey: this.encryption.decrypt(
              Buffer.from(existing.encryptedPrivateKey, 'base64')
            ),
          };
        } catch {
          throw new Error('Remote device identity could not be decrypted');
        }
      }

      const identity = createIdentity(deviceId);
      file.identities[deviceId] = {
        publicKey: identity.publicKey,
        encryptedPrivateKey: this.encryption.encrypt(identity.privateKey).toString('base64'),
      };
      await this.write(file);
      return identity;
    });
  }

  private async read(): Promise<IdentityFile> {
    try {
      const candidate = JSON.parse(await readFile(this.filePath, 'utf8')) as IdentityFile;
      return candidate.version === 1 &&
        candidate.identities &&
        typeof candidate.identities === 'object'
        ? candidate
        : emptyFile();
    } catch {
      return emptyFile();
    }
  }

  private async write(file: IdentityFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(file, null, 2), { mode: 0o600 });
    await rename(temporaryPath, this.filePath);
  }

  private exclusive<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
    const result = this.operationTail.then(operation, operation);
    this.operationTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }
}
