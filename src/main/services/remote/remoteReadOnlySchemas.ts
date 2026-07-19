import {
  IPC_CHANNELS,
  JsonValueSchema,
  REMOTE_FS_READ_FILE_CHANNEL,
  WorkspaceEntityLookupSchema,
} from '@shared/types';
import { z } from 'zod';

const path = z.string().min(1).max(32_768);
const text = z.string().max(256 * 1_024);
const name = z.string().min(1).max(1_024);
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const objectId = z.string().regex(/^[a-f0-9]{4,64}$/i);
const revision = z
  .string()
  .min(1)
  .max(1_024)
  .refine(
    (value) =>
      !value.startsWith('-') &&
      !/[\0-\x20\x7f]/.test(value) &&
      !value.includes('..') &&
      !value.includes('@{') &&
      !value.endsWith('.')
  );
const paths = z.array(path).max(2_048);
const noArgs = z.tuple([]);

export const REMOTE_READ_ONLY_RESULT_SCHEMA = JsonValueSchema.optional();

export const REMOTE_READ_ONLY_REQUEST_SCHEMAS = new Map<string, z.ZodType<unknown[]>>([
  [IPC_CHANNELS.GIT_STATUS, z.tuple([path])],
  [IPC_CHANNELS.GIT_BRANCH_LIST, z.tuple([path])],
  [IPC_CHANNELS.GIT_BRANCH_HEAD_INFO, z.tuple([path, revision])],
  [
    IPC_CHANNELS.GIT_LOG,
    z.tuple([path, count.max(1_000).optional(), count.optional(), path.optional()]),
  ],
  [
    IPC_CHANNELS.GIT_DIFF,
    z.tuple([path, z.strictObject({ staged: z.boolean().optional() }).optional()]),
  ],
  [IPC_CHANNELS.GIT_FILE_CHANGES, z.tuple([path])],
  [IPC_CHANNELS.GIT_FILE_DIFF, z.tuple([path, path, z.boolean()])],
  [IPC_CHANNELS.GIT_COMMIT_SHOW, z.tuple([path, objectId])],
  [IPC_CHANNELS.GIT_COMMIT_FILES, z.tuple([path, objectId, path.optional()])],
  [
    IPC_CHANNELS.GIT_COMMIT_DIFF,
    z.tuple([
      path,
      objectId,
      path,
      z.enum(['M', 'A', 'D', 'R', 'C', 'U', 'X']).optional(),
      path.optional(),
    ]),
  ],
  [IPC_CHANNELS.GIT_DIFF_STATS, z.tuple([path])],
  [IPC_CHANNELS.GIT_GH_STATUS, z.tuple([path])],
  [IPC_CHANNELS.GIT_PR_LIST, z.tuple([path])],
  [IPC_CHANNELS.GIT_VALIDATE_URL, z.tuple([text])],
  [IPC_CHANNELS.GIT_BLAME, z.tuple([path, path])],
  [IPC_CHANNELS.GIT_SUBMODULE_LIST, z.tuple([path])],
  [IPC_CHANNELS.GIT_SUBMODULE_CHANGES, z.tuple([path, path])],
  [IPC_CHANNELS.GIT_SUBMODULE_FILE_DIFF, z.tuple([path, path, path, z.boolean()])],
  [IPC_CHANNELS.GIT_SUBMODULE_BRANCHES, z.tuple([path, path])],
  [IPC_CHANNELS.GIT_VALIDATE_LOCAL_PATH, z.tuple([path])],
  [IPC_CHANNELS.WORKTREE_LIST, z.tuple([path])],
  [IPC_CHANNELS.WORKTREE_MERGE_STATE, z.tuple([path])],
  [IPC_CHANNELS.WORKTREE_MERGE_CONFLICTS, z.tuple([path])],
  [IPC_CHANNELS.WORKTREE_MERGE_CONFLICT_CONTENT, z.tuple([path, path])],
  [IPC_CHANNELS.FILE_READ, z.tuple([path])],
  [IPC_CHANNELS.FILE_LIST, z.tuple([path, path.optional()])],
  [IPC_CHANNELS.FILE_EXISTS, z.tuple([path])],
  [IPC_CHANNELS.FILE_CHECK_CONFLICTS, z.tuple([paths, path])],
  [IPC_CHANNELS.TERMINAL_LIST_PERSISTENT, noArgs],
  [IPC_CHANNELS.TERMINAL_GET_ACTIVITY, z.tuple([name])],
  [IPC_CHANNELS.SHELL_DETECT, noArgs],
  [
    IPC_CHANNELS.SHELL_RESOLVE_FOR_COMMAND,
    z.tuple([
      z.strictObject({
        shellType: z.enum([
          'powershell7',
          'powershell',
          'cmd',
          'gitbash',
          'nushell',
          'wsl',
          'custom',
          'system',
          'zsh',
          'bash',
          'fish',
          'sh',
        ]),
        customShellPath: path.optional(),
        customShellArgs: z.array(text).max(256).optional(),
      }),
    ]),
  ],
  [
    IPC_CHANNELS.SEARCH_FILES,
    z.tuple([
      z.strictObject({
        rootPath: path,
        query: text,
        maxResults: count.optional(),
        useGitignore: z.boolean().optional(),
      }),
    ]),
  ],
  [
    IPC_CHANNELS.SEARCH_CONTENT,
    z.tuple([
      z.strictObject({
        rootPath: path,
        query: text,
        maxResults: count.optional(),
        caseSensitive: z.boolean().optional(),
        wholeWord: z.boolean().optional(),
        regex: z.boolean().optional(),
        filePattern: text.optional(),
        useGitignore: z.boolean().optional(),
      }),
    ]),
  ],
  [IPC_CHANNELS.AGENT_LIST, noArgs],
  [IPC_CHANNELS.TODO_GET_TASKS, z.tuple([path])],
  [IPC_CHANNELS.TMUX_CHECK, z.tuple([z.boolean().optional()])],
  [REMOTE_FS_READ_FILE_CHANNEL, z.tuple([path])],
  [
    IPC_CHANNELS.WORKSPACE_MIRROR_RESOLVE_ENTITIES,
    z.tuple([z.array(WorkspaceEntityLookupSchema).max(10_000)]),
  ],
  [IPC_CHANNELS.WORKSPACE_MIRROR_FETCH_RESOURCE, z.tuple([name])],
]);

export function getRemoteReadOnlyRequestSchema(channel: string): z.ZodType<unknown[]> | undefined {
  return REMOTE_READ_ONLY_REQUEST_SCHEMAS.get(channel);
}
