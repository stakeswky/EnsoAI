import { describe, expect, it } from 'vitest';
import {
  IPC_CHANNELS,
  isRemoteForwardedChannel,
  REMOTE_FS_READ_FILE_CHANNEL,
} from '../../../../shared/types';
import {
  createRemoteCommandRegistry,
  isV1RemoteCommandChannel,
  V1_REMOTE_COMMAND_CHANNELS,
} from '../remoteCommandRegistry';

describe('remote command registry', () => {
  it('contains only explicit concrete V1 command channels', () => {
    expect(new Set(V1_REMOTE_COMMAND_CHANNELS).size).toBe(V1_REMOTE_COMMAND_CHANNELS.length);
    expect(V1_REMOTE_COMMAND_CHANNELS).toContain(REMOTE_FS_READ_FILE_CHANNEL);

    for (const channel of V1_REMOTE_COMMAND_CHANNELS) {
      expect(
        channel === REMOTE_FS_READ_FILE_CHANNEL || isRemoteForwardedChannel(channel),
        `unexpected non-forwarded V1 channel: ${channel}`
      ).toBe(true);
    }

    expect(isV1RemoteCommandChannel(IPC_CHANNELS.GIT_STATUS)).toBe(true);
    expect(isV1RemoteCommandChannel(IPC_CHANNELS.TERMINAL_CREATE)).toBe(true);
    expect(isV1RemoteCommandChannel(IPC_CHANNELS.SEARCH_CONTENT)).toBe(true);
    expect(isV1RemoteCommandChannel(IPC_CHANNELS.TERMINAL_DATA)).toBe(false);
  });

  it('rejects unknown channels even when they share an approved prefix', async () => {
    let invocations = 0;
    const registry = createRemoteCommandRegistry<(...args: unknown[]) => Promise<void>>();
    const handler = async (): Promise<void> => {
      invocations += 1;
    };

    expect(registry.register('git:future-command', handler)).toBe(false);
    const lookedUp = registry.lookup('git:future-command');
    expect(lookedUp).toBeUndefined();
    if (lookedUp) {
      await lookedUp();
    }
    expect(invocations).toBe(0);
  });

  it('rejects sensitive local-only channels before handler lookup', async () => {
    let invocations = 0;
    const registry = createRemoteCommandRegistry<(...args: unknown[]) => Promise<void>>();
    const handler = async (): Promise<void> => {
      invocations += 1;
    };

    for (const channel of [
      IPC_CHANNELS.SETTINGS_READ,
      IPC_CHANNELS.SETTINGS_WRITE,
      IPC_CHANNELS.UPDATER_CHECK,
      IPC_CHANNELS.WINDOW_CLOSE,
      IPC_CHANNELS.REMOTE_HOST_START,
      IPC_CHANNELS.CLAUDE_PROVIDER_APPLY,
    ]) {
      expect(registry.register(channel, handler)).toBe(false);
      const lookedUp = registry.lookup(channel);
      expect(lookedUp).toBeUndefined();
      if (lookedUp) {
        await lookedUp();
      }
    }

    expect(invocations).toBe(0);
  });

  it('allows registered commands and removes them deterministically', async () => {
    const registry = createRemoteCommandRegistry<(...args: unknown[]) => Promise<string>>();
    const handler = async (): Promise<string> => 'ok';

    expect(registry.register(IPC_CHANNELS.GIT_STATUS, handler)).toBe(true);
    expect(registry.lookup(IPC_CHANNELS.GIT_STATUS)).toBe(handler);
    await expect(registry.lookup(IPC_CHANNELS.GIT_STATUS)?.()).resolves.toBe('ok');

    registry.remove(IPC_CHANNELS.GIT_STATUS);
    expect(registry.lookup(IPC_CHANNELS.GIT_STATUS)).toBeUndefined();
  });

  it('supports an injected allowlist without Electron dependencies', () => {
    const registry = createRemoteCommandRegistry<symbol>((channel) => channel === 'allowed');
    const handler = Symbol('handler');

    expect(registry.register('allowed', handler)).toBe(true);
    expect(registry.lookup('allowed')).toBe(handler);
    expect(registry.register('denied', handler)).toBe(false);
    expect(registry.lookup('denied')).toBeUndefined();
  });
});
