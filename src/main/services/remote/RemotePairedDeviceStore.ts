import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface RemotePairedDevice {
  deviceId: string;
  publicKey: string;
  scopes: Array<'mirror.read' | 'mirror.control'>;
  pairedAt: number;
  revokedAt: number | null;
}

interface PairedDeviceFile {
  version: 1;
  devices: Record<string, RemotePairedDevice>;
}

function emptyFile(): PairedDeviceFile {
  return { version: 1, devices: {} };
}

/** Public pairing metadata. Private device keys never enter this store. */
export class RemotePairedDeviceStore {
  private devices = new Map<string, RemotePairedDevice>();
  private initialized = false;
  private operationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath?: string,
    private readonly now: () => number = Date.now
  ) {}

  initialize(): Promise<void> {
    return this.exclusive(async () => {
      if (this.initialized) return;
      const file = await this.read();
      this.devices = new Map(
        Object.entries(file.devices)
          .filter(([deviceId, device]) => device.deviceId === deviceId)
          .map(([deviceId, device]) => [deviceId, structuredClone(device)])
      );
      this.initialized = true;
    });
  }

  get(deviceId: string): RemotePairedDevice | null {
    const device = this.devices.get(deviceId);
    return device ? structuredClone(device) : null;
  }

  list(): RemotePairedDevice[] {
    return [...this.devices.values()].map((device) => structuredClone(device));
  }

  pair(deviceId: string, publicKey: string): Promise<RemotePairedDevice> {
    return this.exclusive(async () => {
      this.assertInitialized();
      const existing = this.devices.get(deviceId);
      if (existing && existing.publicKey !== publicKey) {
        throw new Error('Device identity already exists with a different public key');
      }
      const device: RemotePairedDevice = existing ?? {
        deviceId,
        publicKey,
        scopes: ['mirror.read', 'mirror.control'],
        pairedAt: this.now(),
        revokedAt: null,
      };
      this.devices.set(deviceId, device);
      await this.write();
      return structuredClone(device);
    });
  }

  revoke(deviceId: string): Promise<boolean> {
    return this.exclusive(async () => {
      this.assertInitialized();
      const existing = this.devices.get(deviceId);
      if (!existing || existing.revokedAt !== null) return false;
      this.devices.set(deviceId, { ...existing, revokedAt: this.now() });
      await this.write();
      return true;
    });
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new Error('Remote paired-device store is not initialized');
  }

  private async read(): Promise<PairedDeviceFile> {
    if (!this.filePath) return emptyFile();
    try {
      const candidate = JSON.parse(await readFile(this.filePath, 'utf8')) as PairedDeviceFile;
      if (candidate.version !== 1 || !candidate.devices || typeof candidate.devices !== 'object') {
        return emptyFile();
      }
      return candidate;
    } catch {
      return emptyFile();
    }
  }

  private async write(): Promise<void> {
    if (!this.filePath) return;
    await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.filePath}.tmp`;
    const file: PairedDeviceFile = {
      version: 1,
      devices: Object.fromEntries(this.devices),
    };
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
