import { describe, expect, it, vi } from 'vitest';
import { TmuxDetector } from '../TmuxDetector';

describe('TmuxDetector session proof', () => {
  it('distinguishes present, absent, and indeterminate session checks', async () => {
    await expect(
      new TmuxDetector({ platform: 'linux', run: async () => 0 }).hasSession('session-1')
    ).resolves.toBe(true);
    await expect(
      new TmuxDetector({ platform: 'linux', run: async () => 1 }).hasSession('session-1')
    ).resolves.toBe(false);
    await expect(
      new TmuxDetector({ platform: 'linux', run: async () => 2 }).hasSession('session-1')
    ).rejects.toThrow('exited with code 2');
    await expect(
      new TmuxDetector({
        platform: 'linux',
        run: async () => {
          throw new Error('spawn unavailable');
        },
      }).hasSession('session-1')
    ).rejects.toThrow('spawn unavailable');
  });

  it('accepts only explicit success or already-absent kill results', async () => {
    await expect(
      new TmuxDetector({ platform: 'linux', run: async () => 0 }).killSession('session-1')
    ).resolves.toBeUndefined();
    await expect(
      new TmuxDetector({ platform: 'linux', run: async () => 1 }).killSession('session-1')
    ).resolves.toBeUndefined();
    await expect(
      new TmuxDetector({ platform: 'linux', run: async () => 9 }).killSession('session-1')
    ).rejects.toThrow('exited with code 9');
  });

  it('rejects unsafe names before spawning tmux', async () => {
    const run = vi.fn(async () => 0);
    const detector = new TmuxDetector({ platform: 'linux', run });

    await expect(detector.killSession('session;touch /tmp/file')).rejects.toThrow(
      'Invalid tmux session name'
    );
    expect(run).not.toHaveBeenCalled();
  });
});
