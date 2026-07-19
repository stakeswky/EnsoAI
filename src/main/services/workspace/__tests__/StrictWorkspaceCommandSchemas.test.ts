import { IPC_CHANNELS } from '@shared/types';
import { describe, expect, it } from 'vitest';
import {
  getRemoteCommandSchemaId,
  REMOTE_COMMAND_MANIFEST,
} from '../../remote/remoteCommandManifest';
import {
  strictWorkspaceCommandResultSchemas,
  strictWorkspaceCommandSchemas,
} from '../commands/StrictWorkspaceCommandSchemas';

const reservation = {
  sceneId: 'scene-1',
  entityId: 'repository-1',
  kind: 'repository' as const,
  path: '/workspace/repository',
  normalizedPath: '/workspace/repository',
  disposition: 'new' as const,
};

describe('strict workspace command schemas', () => {
  it('covers the durable manifest exactly for both requests and results', () => {
    const durableChannels = Object.values(REMOTE_COMMAND_MANIFEST)
      .filter((descriptor) => descriptor.route === 'durable-command')
      .map((descriptor) => descriptor.channel)
      .sort();

    expect([...strictWorkspaceCommandSchemas().keys()].sort()).toEqual(durableChannels);
    expect([...strictWorkspaceCommandResultSchemas().keys()].sort()).toEqual(durableChannels);
  });

  it('assigns stable, direction-specific schema identities to every durable command', () => {
    for (const descriptor of Object.values(REMOTE_COMMAND_MANIFEST)) {
      if (descriptor.route !== 'durable-command') continue;

      expect(descriptor.requestSchemaId).toBe(
        getRemoteCommandSchemaId(descriptor.channel, 'request')
      );
      expect(descriptor.resultSchemaId).toBe(
        getRemoteCommandSchemaId(descriptor.channel, 'result')
      );
      expect(descriptor.requestSchemaId).not.toBe(descriptor.resultSchemaId);
    }
  });

  it('uses undefined for every void IPC result instead of a generic JSON fallback', () => {
    const schemas = strictWorkspaceCommandResultSchemas();
    const voidChannels = [
      IPC_CHANNELS.GIT_PUSH,
      IPC_CHANNELS.GIT_PULL,
      IPC_CHANNELS.GIT_FETCH,
      IPC_CHANNELS.GIT_BRANCH_CREATE,
      IPC_CHANNELS.GIT_BRANCH_CHECKOUT,
      IPC_CHANNELS.GIT_INIT,
      IPC_CHANNELS.GIT_STAGE,
      IPC_CHANNELS.GIT_UNSTAGE,
      IPC_CHANNELS.GIT_DISCARD,
      IPC_CHANNELS.GIT_PR_FETCH,
      IPC_CHANNELS.GIT_REVERT,
      IPC_CHANNELS.GIT_RESET,
      IPC_CHANNELS.GIT_SUBMODULE_INIT,
      IPC_CHANNELS.GIT_SUBMODULE_UPDATE,
      IPC_CHANNELS.GIT_SUBMODULE_SYNC,
      IPC_CHANNELS.GIT_SUBMODULE_FETCH,
      IPC_CHANNELS.GIT_SUBMODULE_PULL,
      IPC_CHANNELS.GIT_SUBMODULE_PUSH,
      IPC_CHANNELS.GIT_SUBMODULE_STAGE,
      IPC_CHANNELS.GIT_SUBMODULE_UNSTAGE,
      IPC_CHANNELS.GIT_SUBMODULE_DISCARD,
      IPC_CHANNELS.GIT_SUBMODULE_CHECKOUT,
      IPC_CHANNELS.GIT_CODE_REVIEW_STOP,
      IPC_CHANNELS.GIT_AUTO_FETCH_SET_ENABLED,
      IPC_CHANNELS.WORKTREE_ADD,
      IPC_CHANNELS.WORKTREE_REMOVE,
      IPC_CHANNELS.WORKTREE_MERGE_RESOLVE,
      IPC_CHANNELS.WORKTREE_MERGE_ABORT,
      IPC_CHANNELS.WORKTREE_ACTIVATE,
      IPC_CHANNELS.FILE_WRITE,
      IPC_CHANNELS.FILE_CREATE,
      IPC_CHANNELS.FILE_CREATE_DIR,
      IPC_CHANNELS.FILE_RENAME,
      IPC_CHANNELS.FILE_MOVE,
      IPC_CHANNELS.FILE_COPY,
      IPC_CHANNELS.FILE_DELETE,
      IPC_CHANNELS.TERMINAL_DESTROY,
      IPC_CHANNELS.TMUX_KILL_SESSION,
    ];

    for (const channel of voidChannels) {
      const schema = schemas.get(channel);
      expect(schema?.safeParse(undefined).success, `expected void result for ${channel}`).toBe(
        true
      );
      expect(schema?.safeParse(null).success, `accepted null result for ${channel}`).toBe(false);
      expect(schema?.safeParse({}).success, `accepted object result for ${channel}`).toBe(false);
    }
  });

  it('validates every non-void durable result using its concrete IPC shape', () => {
    const schemas = strictWorkspaceCommandResultSchemas();
    const samples = new Map<string, unknown>([
      [IPC_CHANNELS.GIT_COMMIT, '0123abcd'],
      [IPC_CHANNELS.GIT_SUBMODULE_COMMIT, '89abcdef'],
      [IPC_CHANNELS.GIT_CLONE, { success: true, path: '/workspace/repository' }],
      [IPC_CHANNELS.GIT_GENERATE_COMMIT_MSG, { success: true, message: 'Commit message' }],
      [IPC_CHANNELS.GIT_GENERATE_BRANCH_NAME, { success: true, branchName: 'feature/name' }],
      [IPC_CHANNELS.GIT_CODE_REVIEW_START, { success: true, sessionId: 'session-1' }],
      [IPC_CHANNELS.WORKTREE_MERGE, { success: true, merged: true, commitHash: '0123abcd' }],
      [
        IPC_CHANNELS.WORKTREE_MERGE_CONTINUE,
        { success: false, merged: false, conflicts: [{ file: 'src/a.ts', type: 'content' }] },
      ],
      [
        IPC_CHANNELS.TEMP_WORKSPACE_CREATE,
        {
          ok: true,
          item: {
            id: 'temp-1',
            path: '/workspace/temp-1',
            folderName: 'temp-1',
            title: 'temp-1',
            createdAt: 1,
          },
        },
      ],
      [IPC_CHANNELS.TEMP_WORKSPACE_REMOVE, { ok: true }],
      [
        IPC_CHANNELS.TEMP_WORKSPACE_CHECK_PATH,
        { ok: false, code: 'EACCES', message: 'Not writable' },
      ],
      [
        IPC_CHANNELS.FILE_BATCH_COPY,
        { success: ['/workspace/a'], failed: [{ path: '/workspace/b', error: 'failed' }] },
      ],
      [IPC_CHANNELS.FILE_BATCH_MOVE, { success: [], failed: [] }],
      [IPC_CHANNELS.TERMINAL_CREATE, 'terminal-1'],
      [IPC_CHANNELS.TODO_AI_POLISH, { success: true, title: 'Title', description: 'Body' }],
      [IPC_CHANNELS.WORKSPACE_MIRROR_REGISTER_ENTITY, reservation],
      [IPC_CHANNELS.WORKSPACE_MIRROR_ADOPT_ENTITY, { ok: true, reservation }],
    ]);

    const nonVoidChannels = [...schemas.entries()]
      .filter(([, schema]) => !schema.safeParse(undefined).success)
      .map(([channel]) => channel)
      .sort();
    expect([...samples.keys()].sort()).toEqual(nonVoidChannels);

    for (const [channel, sample] of samples) {
      const schema = schemas.get(channel);
      expect(schema?.safeParse(sample).success, `rejected valid result for ${channel}`).toBe(true);
      expect(
        schema?.safeParse({ ...((sample as object) ?? {}), __unclassified: true }).success,
        `accepted unclassified result for ${channel}`
      ).toBe(false);
    }
  });

  it('preserves typed entity adoption conflicts', () => {
    const schema = strictWorkspaceCommandResultSchemas().get(
      IPC_CHANNELS.WORKSPACE_MIRROR_ADOPT_ENTITY
    );
    const conflict = {
      ok: false,
      error: {
        code: 'ENTITY_ADOPTION_CONFLICT',
        message: 'Path is already owned',
        conflictingEntityIds: ['repository-2'],
      },
    };

    expect(schema?.safeParse(conflict).success).toBe(true);
    expect(
      schema?.safeParse({ ...conflict, error: { ...conflict.error, code: 'UNKNOWN' } }).success
    ).toBe(false);
  });
});
