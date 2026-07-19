import { describe, expect, it } from 'vitest';
import {
  IPC_CHANNELS,
  isRemoteForwardedChannel,
  REMOTE_FS_READ_FILE_CHANNEL,
} from '../../../../shared/types';
import { createRemoteWorkspaceCommandRegistry } from '../../workspace/WorkspaceCommandRegistry';
import {
  getRemoteCommandDescriptor,
  isReadOnlyCompatibilityChannel,
  REMOTE_COMMAND_MANIFEST,
  REMOTE_COMMAND_MANIFEST_ENTRIES,
  REMOTE_V2_EVENT_MANIFEST,
  REMOTE_V2_FRAME_ROUTE_MANIFEST,
  type RemoteCommandRoute,
} from '../remoteCommandManifest';
import {
  createRemoteCommandRegistry,
  isClassifiedRemoteCommandChannel,
  isV1RemoteCommandChannel,
  V1_REMOTE_COMMAND_CHANNELS,
} from '../remoteCommandRegistry';
import {
  REMOTE_READ_ONLY_REQUEST_SCHEMAS,
  REMOTE_READ_ONLY_RESULT_SCHEMA,
} from '../remoteReadOnlySchemas';

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

  it('classifies every remotely reachable channel exactly once', () => {
    const allowedChannels = new Set<string>(V1_REMOTE_COMMAND_CHANNELS);
    const manifestChannels = REMOTE_COMMAND_MANIFEST_ENTRIES.map(([channel]) => channel);
    const knownRoutes = new Set<RemoteCommandRoute>([
      'read-only',
      'durable-command',
      'stream/coordination',
      'v2-forbidden',
    ]);

    expect(new Set(manifestChannels).size).toBe(manifestChannels.length);
    expect(manifestChannels).toHaveLength(V1_REMOTE_COMMAND_CHANNELS.length);
    expect([...new Set(manifestChannels)].sort()).toEqual([...allowedChannels].sort());
    expect(Object.keys(REMOTE_COMMAND_MANIFEST).sort()).toEqual([...allowedChannels].sort());

    for (const channel of V1_REMOTE_COMMAND_CHANNELS) {
      const descriptor = getRemoteCommandDescriptor(channel);
      expect(
        descriptor,
        `missing manifest entry for allowlisted channel: ${channel}`
      ).toBeDefined();
      expect(descriptor?.channel).toBe(channel);
      expect(knownRoutes.has(descriptor?.route as RemoteCommandRoute)).toBe(true);
      expect(descriptor?.redaction.errors).toBe('generic');
      expect(isClassifiedRemoteCommandChannel(channel)).toBe(true);
    }
  });

  it('classifies every V2 frame discriminant exactly once', () => {
    expect(Object.keys(REMOTE_V2_FRAME_ROUTE_MANIFEST).sort()).toEqual(
      [
        'auth.challenge',
        'auth.proof',
        'clientHello',
        'serverHello',
        'resource.upload.begin',
        'resource.upload.chunk',
        'resource.upload.end',
        'resource.upload.result',
        'state.subscribe',
        'state.snapshot.begin',
        'state.snapshot.chunk',
        'state.snapshot.end',
        'state.event',
        'state.replay',
        'state.resyncRequired',
        'state.intent',
        'state.intentResult',
        'command.execute',
        'command.status',
        'command.result',
        'control.request',
        'control.granted',
        'control.released',
        'control.revoked',
        'coord.presence',
        'coord.sync',
        'coord.command',
        'coord.commandResult',
        'stream.attach',
        'stream.attached',
        'stream.chunk',
        'stream.ack',
        'stream.input',
        'stream.resize',
        'stream.detach',
        'stream.reset',
        'stream.closed',
        'error',
      ].sort()
    );
    expect(REMOTE_V2_FRAME_ROUTE_MANIFEST['command.execute']).toBe('durable-command');
    expect(REMOTE_V2_FRAME_ROUTE_MANIFEST['stream.input']).toBe('stream/coordination');
  });

  it('never exposes durable commands through the generic read-only route', () => {
    const durableCommands = Object.values(REMOTE_COMMAND_MANIFEST).filter(
      (descriptor) => descriptor.route === 'durable-command'
    );

    expect(durableCommands.length).toBeGreaterThan(0);
    for (const descriptor of durableCommands) {
      expect(isReadOnlyCompatibilityChannel(descriptor.channel)).toBe(false);
      expect(descriptor.requiredScope).toBe('mirror.control');
      expect(descriptor.requiresController).toBe(true);
      expect(descriptor.reconciliation).not.toBe('read-only');
      expect(descriptor.redaction.persistedRequest).not.toBe('redacted-metadata');
    }

    expect(getRemoteCommandDescriptor(IPC_CHANNELS.GIT_STATUS)?.route).toBe('read-only');
    expect(getRemoteCommandDescriptor(IPC_CHANNELS.GIT_COMMIT)?.route).toBe('durable-command');
    expect(getRemoteCommandDescriptor(IPC_CHANNELS.FILE_WRITE)?.route).toBe('durable-command');
    expect(getRemoteCommandDescriptor(IPC_CHANNELS.TERMINAL_CREATE)?.route).toBe('durable-command');
  });

  it('installs a bounded request schema for every generic read-only channel', () => {
    const readOnlyChannels = Object.values(REMOTE_COMMAND_MANIFEST)
      .filter((descriptor) => descriptor.route === 'read-only')
      .map(({ channel }) => channel)
      .sort();

    expect([...REMOTE_READ_ONLY_REQUEST_SCHEMAS.keys()].sort()).toEqual(readOnlyChannels);
    for (const channel of readOnlyChannels) {
      expect(
        REMOTE_READ_ONLY_REQUEST_SCHEMAS.get(channel)?.safeParse([
          { __unclassified: 'canary-secret' },
        ]).success,
        `read-only channel accepted an unclassified request: ${channel}`
      ).toBe(false);
    }
    expect(
      REMOTE_READ_ONLY_REQUEST_SCHEMAS.get(IPC_CHANNELS.GIT_COMMIT_SHOW)?.safeParse([
        '/host/repository',
        '--output=/host/escaped',
      ]).success
    ).toBe(false);
    expect(REMOTE_READ_ONLY_RESULT_SCHEMA.safeParse({ value: 'bounded' }).success).toBe(true);
  });

  it('installs a strict request schema for every durable command', () => {
    const registry = createRemoteWorkspaceCommandRegistry();
    const durableCommands = Object.values(REMOTE_COMMAND_MANIFEST).filter(
      (descriptor) => descriptor.route === 'durable-command'
    );

    expect(registry.list()).toHaveLength(durableCommands.length);
    for (const descriptor of durableCommands) {
      const command = registry.lookup(descriptor.channel);
      expect(command, `missing strict descriptor for ${descriptor.channel}`).toBeDefined();
      expect(
        command?.requestSchema.safeParse([{ __unclassified: true }]).success,
        `durable command accepted unclassified arguments: ${descriptor.channel}`
      ).toBe(false);
    }
  });

  it('allows only classified legacy events on a V2 socket', () => {
    expect(Object.keys(REMOTE_V2_EVENT_MANIFEST).sort()).toEqual(
      [
        IPC_CHANNELS.FILE_CHANGE,
        IPC_CHANNELS.GIT_CLONE_PROGRESS,
        IPC_CHANNELS.GIT_CODE_REVIEW_DATA,
        IPC_CHANNELS.GIT_AUTO_FETCH_COMPLETED,
        IPC_CHANNELS.AGENT_STATUS_UPDATE,
        IPC_CHANNELS.AGENT_PRE_TOOL_USE_NOTIFICATION,
        IPC_CHANNELS.AGENT_USER_PROMPT_NOTIFICATION,
        IPC_CHANNELS.AGENT_ASK_USER_QUESTION_NOTIFICATION,
        IPC_CHANNELS.AGENT_STOP_NOTIFICATION,
      ].sort()
    );
    expect(REMOTE_V2_EVENT_MANIFEST[IPC_CHANNELS.TERMINAL_DATA]).toBeUndefined();
    expect(REMOTE_V2_EVENT_MANIFEST['unknown:event']).toBeUndefined();
  });

  it('keeps stream bytes and canonical coordination outside the durable ledger', () => {
    for (const channel of [
      IPC_CHANNELS.TERMINAL_WRITE,
      IPC_CHANNELS.TERMINAL_RESIZE,
      IPC_CHANNELS.TERMINAL_ATTACH,
      IPC_CHANNELS.TERMINAL_DETACH,
      IPC_CHANNELS.FILE_WATCH_START,
      IPC_CHANNELS.FILE_WATCH_STOP,
      IPC_CHANNELS.WORKSPACE_MIRROR_GET_SNAPSHOT,
      IPC_CHANNELS.WORKSPACE_MIRROR_DISPATCH_INTENT,
      IPC_CHANNELS.WORKSPACE_MIRROR_REQUEST_CONTROL,
      IPC_CHANNELS.WORKSPACE_MIRROR_RELEASE_CONTROL,
      IPC_CHANNELS.WORKSPACE_MIRROR_STAGE_RESOURCE,
      IPC_CHANNELS.WORKSPACE_MIRROR_MATERIALIZE_RESOURCE,
    ]) {
      const descriptor = getRemoteCommandDescriptor(channel);
      expect(descriptor?.route, `expected native-plane route for ${channel}`).toBe(
        'stream/coordination'
      );
      expect(descriptor?.reconciliation).toBe('native-plane');
      expect(descriptor?.redaction.persistedRequest).toBe('none');
    }

    expect(getRemoteCommandDescriptor(IPC_CHANNELS.TERMINAL_WRITE)?.redaction.request).toContain(
      'terminal-bytes'
    );
  });

  it('fails closed for host-global and canonical-state compatibility writes', () => {
    for (const channel of [
      IPC_CHANNELS.FILE_REVEAL_IN_FILE_MANAGER,
      IPC_CHANNELS.TODO_ADD_TASK,
      IPC_CHANNELS.TODO_UPDATE_TASK,
      IPC_CHANNELS.TODO_DELETE_TASK,
      IPC_CHANNELS.TODO_MOVE_TASK,
      IPC_CHANNELS.TODO_REORDER_TASKS,
    ]) {
      const descriptor = getRemoteCommandDescriptor(channel);
      expect(descriptor?.route, `expected V2 forbidden route for ${channel}`).toBe('v2-forbidden');
      expect(descriptor?.requiredScope).toBeNull();
      expect(descriptor?.requiresController).toBe(false);
      expect(descriptor?.reconciliation).toBe('forbidden');
    }
  });

  it('keeps normal host workflows on the durable command plane', () => {
    for (const channel of [
      IPC_CHANNELS.GIT_GENERATE_COMMIT_MSG,
      IPC_CHANNELS.GIT_GENERATE_BRANCH_NAME,
      IPC_CHANNELS.GIT_CODE_REVIEW_START,
      IPC_CHANNELS.GIT_CODE_REVIEW_STOP,
      IPC_CHANNELS.GIT_AUTO_FETCH_SET_ENABLED,
      IPC_CHANNELS.WORKTREE_ACTIVATE,
      IPC_CHANNELS.TEMP_WORKSPACE_CHECK_PATH,
      IPC_CHANNELS.TODO_AI_POLISH,
      IPC_CHANNELS.TMUX_KILL_SESSION,
    ]) {
      const descriptor = getRemoteCommandDescriptor(channel);
      expect(descriptor?.route, `expected durable route for ${channel}`).toBe('durable-command');
      expect(descriptor?.requiresController).toBe(true);
      expect(descriptor?.requiredScope).toBe('mirror.control');
    }
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
