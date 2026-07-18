import { IPC_CHANNELS } from '@shared/types';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  isBinaryFile: vi.fn(),
  readFile: vi.fn(),
  stat: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { getPath: vi.fn() },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler);
    }),
  },
  shell: {},
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
    readFile: mocks.readFile,
    stat: mocks.stat,
  };
});

vi.mock('isbinaryfile', () => ({ isBinaryFile: mocks.isBinaryFile }));

import { MAX_FILE_READ_BYTES, registerFileHandlers } from '../files';

function fileReadHandler(): (...args: unknown[]) => unknown {
  const handler = mocks.handlers.get(IPC_CHANNELS.FILE_READ);
  if (!handler) throw new Error('FILE_READ handler was not registered');
  return handler;
}

beforeAll(() => {
  registerFileHandlers();
});

beforeEach(() => {
  mocks.isBinaryFile.mockReset();
  mocks.readFile.mockReset();
  mocks.stat.mockReset();
});

describe('FILE_READ bounds', () => {
  it('rejects non-regular targets before binary detection or reading', async () => {
    mocks.stat.mockResolvedValue({ isFile: () => false, size: 0 });

    await expect(fileReadHandler()({}, '/private/secret-directory')).rejects.toThrow(
      'File read target must be a regular file'
    );
    expect(mocks.isBinaryFile).not.toHaveBeenCalled();
    expect(mocks.readFile).not.toHaveBeenCalled();
  });

  it('rejects oversized targets before binary detection or reading', async () => {
    mocks.stat.mockResolvedValue({ isFile: () => true, size: MAX_FILE_READ_BYTES + 1 });

    await expect(fileReadHandler()({}, '/private/oversized.txt')).rejects.toThrow(
      'File exceeds the 16 MiB read limit'
    );
    expect(mocks.isBinaryFile).not.toHaveBeenCalled();
    expect(mocks.readFile).not.toHaveBeenCalled();
  });

  it('allows a file at the limit to reach binary detection', async () => {
    mocks.stat.mockResolvedValue({ isFile: () => true, size: MAX_FILE_READ_BYTES });
    mocks.isBinaryFile.mockResolvedValue(true);

    await expect(fileReadHandler()({}, '/private/at-limit.bin')).resolves.toMatchObject({
      encoding: 'binary',
      isBinary: true,
    });
    expect(mocks.isBinaryFile).toHaveBeenCalledWith('/private/at-limit.bin');
    expect(mocks.readFile).not.toHaveBeenCalled();
  });
});
