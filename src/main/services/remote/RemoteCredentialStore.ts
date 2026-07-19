import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';

interface EncryptedCredentialFile {
  version: 1;
  credentials: Record<string, string>;
}

export interface RemoteCredentialEncryption {
  isAvailable(): boolean;
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}

function emptyFile(): EncryptedCredentialFile {
  return { version: 1, credentials: {} };
}

function targetKey(host: string, port: number): string {
  return createHash('sha256').update(`${host.trim().toLowerCase()}:${port}`).digest('hex');
}

export class RemoteCredentialStore {
  private operationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly encryption: RemoteCredentialEncryption
  ) {}

  isPersistentEncryptionAvailable(): boolean {
    return this.encryption.isAvailable();
  }

  load(host: string, port: number): Promise<string | null> {
    return this.exclusive(async () => {
      if (!this.encryption.isAvailable()) return null;
      const file = await this.read();
      const encrypted = file.credentials[targetKey(host, port)];
      if (!encrypted) return null;
      try {
        return this.encryption.decrypt(Buffer.from(encrypted, 'base64'));
      } catch {
        return null;
      }
    });
  }

  save(host: string, port: number, token: string): Promise<boolean> {
    return this.exclusive(async () => {
      if (!this.encryption.isAvailable()) return false;
      const file = await this.read();
      file.credentials[targetKey(host, port)] = this.encryption.encrypt(token).toString('base64');
      await this.write(file);
      return true;
    });
  }

  remove(host: string, port: number): Promise<void> {
    return this.exclusive(async () => {
      const file = await this.read();
      delete file.credentials[targetKey(host, port)];
      await this.write(file);
    });
  }

  private async read(): Promise<EncryptedCredentialFile> {
    try {
      const candidate = JSON.parse(await readFile(this.filePath, 'utf8')) as unknown;
      if (
        !candidate ||
        typeof candidate !== 'object' ||
        (candidate as { version?: unknown }).version !== 1 ||
        typeof (candidate as { credentials?: unknown }).credentials !== 'object'
      ) {
        return emptyFile();
      }
      const credentials = Object.fromEntries(
        Object.entries((candidate as EncryptedCredentialFile).credentials).filter(
          ([key, value]) => /^[a-f0-9]{64}$/.test(key) && typeof value === 'string'
        )
      );
      return { version: 1, credentials };
    } catch {
      return emptyFile();
    }
  }

  private async write(file: EncryptedCredentialFile): Promise<void> {
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
