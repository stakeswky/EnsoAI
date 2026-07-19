import {
  IPC_CHANNELS,
  JsonValueSchema,
  WorkspaceEntityAdoptionResultSchema,
  WorkspaceEntityReservationSchema,
} from '@shared/types';
import { z } from 'zod';
import type { WorkspaceCommandInvocationArgs } from '../WorkspaceCommandRegistry';

type CommandArgs = WorkspaceCommandInvocationArgs;

const path = z.string().min(1).max(32_768);
const text = z.string().max(256 * 1_024);
const name = z.string().min(1).max(1_024);
const flag = z.boolean();
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const paths = z.array(path).max(2_048);
const providerOptions = {
  provider: name,
  model: name,
  reasoningEffort: name.optional(),
  bareEnabled: flag.optional(),
  effortEnabled: flag.optional(),
  effortLevel: name.optional(),
} as const;

function args(schema: z.ZodType): z.ZodType<CommandArgs> {
  return schema as z.ZodType<CommandArgs>;
}

function tuple(...items: z.ZodType[]): z.ZodType<CommandArgs> {
  return args(z.tuple(items as [z.ZodType, ...z.ZodType[]]));
}

const conflict = z.strictObject({
  path,
  action: z.enum(['replace', 'skip', 'rename']),
  newName: name.optional(),
});
const terminalOptions = z.strictObject({
  cwd: path,
  shell: path.optional(),
  args: z.array(text).max(256).optional(),
  cols: z.number().int().positive().max(10_000).optional(),
  rows: z.number().int().positive().max(10_000).optional(),
  env: z.record(name, text).optional(),
  shellConfig: JsonValueSchema.optional(),
  initialCommand: text.optional(),
  sessionId: name,
  persistent: z.literal(true),
  title: name.optional(),
  workspaceId: name.optional(),
});

const operationResult = z.strictObject({
  success: flag,
  error: text.optional(),
});
const commitHash = z.string().regex(/^[a-f0-9]{4,64}$/i);
const worktreeMergeResult = z.strictObject({
  success: flag,
  merged: flag,
  conflicts: z
    .array(
      z.strictObject({
        file: path,
        type: z.enum(['content', 'binary', 'rename', 'delete']),
      })
    )
    .max(10_000)
    .optional(),
  commitHash: name.optional(),
  error: text.optional(),
  warnings: z.array(text).max(10_000).optional(),
  mainStashStatus: z.enum(['none', 'stashed', 'applied', 'conflict']).optional(),
  worktreeStashStatus: z.enum(['none', 'stashed', 'applied', 'conflict']).optional(),
  mainWorktreePath: path.optional(),
  worktreePath: path.optional(),
});
const tempWorkspaceFailure = z.strictObject({
  ok: z.literal(false),
  code: name,
  message: text,
});
const tempWorkspaceCreateResult = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    item: z.strictObject({
      id: name,
      path,
      folderName: name,
      title: name,
      createdAt: count,
    }),
  }),
  tempWorkspaceFailure,
]);
const tempWorkspaceOperationResult = z.discriminatedUnion('ok', [
  z.strictObject({ ok: z.literal(true) }),
  tempWorkspaceFailure,
]);
const batchFileResult = z.strictObject({
  success: paths,
  failed: z.array(z.strictObject({ path, error: text })).max(2_048),
});

const schemas = new Map<string, z.ZodType<CommandArgs>>([
  [IPC_CHANNELS.GIT_COMMIT, tuple(path, text, paths.optional())],
  [IPC_CHANNELS.GIT_PUSH, tuple(path, name.optional(), name.optional(), flag.optional())],
  [IPC_CHANNELS.GIT_PULL, tuple(path, name.optional(), name.optional())],
  [IPC_CHANNELS.GIT_FETCH, tuple(path, name.optional())],
  [IPC_CHANNELS.GIT_BRANCH_CREATE, tuple(path, name, name.optional())],
  [IPC_CHANNELS.GIT_BRANCH_CHECKOUT, tuple(path, name)],
  [IPC_CHANNELS.GIT_INIT, tuple(path)],
  [IPC_CHANNELS.GIT_STAGE, tuple(path, paths)],
  [IPC_CHANNELS.GIT_UNSTAGE, tuple(path, paths)],
  [IPC_CHANNELS.GIT_DISCARD, tuple(path, paths)],
  [IPC_CHANNELS.GIT_PR_FETCH, tuple(path, count, name)],
  [IPC_CHANNELS.GIT_CLONE, tuple(text, path)],
  [IPC_CHANNELS.GIT_REVERT, tuple(path, name)],
  [IPC_CHANNELS.GIT_RESET, tuple(path, name, z.enum(['soft', 'mixed', 'hard']).optional())],
  [IPC_CHANNELS.GIT_SUBMODULE_INIT, tuple(path, flag.optional())],
  [IPC_CHANNELS.GIT_SUBMODULE_UPDATE, tuple(path, flag.optional())],
  [IPC_CHANNELS.GIT_SUBMODULE_SYNC, tuple(path)],
  [IPC_CHANNELS.GIT_SUBMODULE_FETCH, tuple(path, path)],
  [IPC_CHANNELS.GIT_SUBMODULE_PULL, tuple(path, path)],
  [IPC_CHANNELS.GIT_SUBMODULE_PUSH, tuple(path, path)],
  [IPC_CHANNELS.GIT_SUBMODULE_COMMIT, tuple(path, path, text)],
  [IPC_CHANNELS.GIT_SUBMODULE_STAGE, tuple(path, path, paths)],
  [IPC_CHANNELS.GIT_SUBMODULE_UNSTAGE, tuple(path, path, paths)],
  [IPC_CHANNELS.GIT_SUBMODULE_DISCARD, tuple(path, path, paths)],
  [IPC_CHANNELS.GIT_SUBMODULE_CHECKOUT, tuple(path, path, name)],
  [
    IPC_CHANNELS.GIT_GENERATE_COMMIT_MSG,
    tuple(
      path,
      z.strictObject({
        maxDiffLines: count,
        timeout: count,
        ...providerOptions,
        prompt: text.optional(),
      })
    ),
  ],
  [
    IPC_CHANNELS.GIT_GENERATE_BRANCH_NAME,
    tuple(
      path,
      z.strictObject({
        prompt: text,
        ...providerOptions,
      })
    ),
  ],
  [
    IPC_CHANNELS.GIT_CODE_REVIEW_START,
    tuple(
      path,
      z.strictObject({
        ...providerOptions,
        language: name.optional(),
        reviewId: name,
        sessionId: name.optional(),
        prompt: text.optional(),
      })
    ),
  ],
  [IPC_CHANNELS.GIT_CODE_REVIEW_STOP, tuple(name)],
  [IPC_CHANNELS.GIT_AUTO_FETCH_SET_ENABLED, tuple(flag)],
  [
    IPC_CHANNELS.WORKTREE_ADD,
    tuple(
      path,
      z.strictObject({
        path,
        branch: name.optional(),
        newBranch: name.optional(),
        checkout: flag.optional(),
      })
    ),
  ],
  [
    IPC_CHANNELS.WORKTREE_REMOVE,
    tuple(
      path,
      z.strictObject({
        path,
        force: flag.optional(),
        deleteBranch: flag.optional(),
        branch: name.optional(),
      })
    ),
  ],
  [
    IPC_CHANNELS.WORKTREE_MERGE,
    tuple(
      path,
      z.strictObject({
        worktreePath: path,
        targetBranch: name,
        strategy: z.enum(['merge', 'squash', 'rebase']),
        noFf: flag.optional(),
        message: text.optional(),
        deleteWorktreeAfterMerge: flag.optional(),
        deleteBranchAfterMerge: flag.optional(),
        autoStash: flag.optional(),
      })
    ),
  ],
  [IPC_CHANNELS.WORKTREE_MERGE_RESOLVE, tuple(path, z.strictObject({ file: path, content: text }))],
  [IPC_CHANNELS.WORKTREE_MERGE_ABORT, tuple(path)],
  [
    IPC_CHANNELS.WORKTREE_MERGE_CONTINUE,
    tuple(
      path,
      text.optional(),
      z
        .strictObject({
          worktreePath: path.optional(),
          sourceBranch: name.optional(),
          deleteWorktreeAfterMerge: flag.optional(),
          deleteBranchAfterMerge: flag.optional(),
        })
        .optional()
    ),
  ],
  [IPC_CHANNELS.WORKTREE_ACTIVATE, tuple(paths)],
  [IPC_CHANNELS.TEMP_WORKSPACE_CREATE, tuple(path.optional())],
  [IPC_CHANNELS.TEMP_WORKSPACE_REMOVE, tuple(path, path.optional())],
  [IPC_CHANNELS.TEMP_WORKSPACE_CHECK_PATH, tuple(path)],
  [IPC_CHANNELS.FILE_WRITE, tuple(path, text, name.optional())],
  [
    IPC_CHANNELS.FILE_CREATE,
    tuple(path, text.optional(), z.strictObject({ overwrite: flag.optional() }).optional()),
  ],
  [IPC_CHANNELS.FILE_CREATE_DIR, tuple(path)],
  [IPC_CHANNELS.FILE_RENAME, tuple(path, path)],
  [IPC_CHANNELS.FILE_MOVE, tuple(path, path)],
  [IPC_CHANNELS.FILE_COPY, tuple(path, path)],
  [IPC_CHANNELS.FILE_BATCH_MOVE, tuple(paths, path, z.array(conflict).max(2_048))],
  [IPC_CHANNELS.FILE_BATCH_COPY, tuple(paths, path, z.array(conflict).max(2_048))],
  [
    IPC_CHANNELS.FILE_DELETE,
    tuple(path, z.strictObject({ recursive: flag.optional() }).optional()),
  ],
  [IPC_CHANNELS.TERMINAL_CREATE, tuple(terminalOptions)],
  [IPC_CHANNELS.TERMINAL_DESTROY, tuple(name)],
  [
    IPC_CHANNELS.TODO_AI_POLISH,
    tuple(
      z.strictObject({
        text,
        timeout: count,
        provider: name,
        model: name,
        reasoningEffort: name.optional(),
        bare: flag.optional(),
        claudeEffort: name.optional(),
        prompt: text.optional(),
      })
    ),
  ],
  [IPC_CHANNELS.TMUX_KILL_SESSION, tuple(z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/))],
  [IPC_CHANNELS.WORKSPACE_MIRROR_REGISTER_ENTITY, tuple(z.enum(['repository', 'worktree']), path)],
  [
    IPC_CHANNELS.WORKSPACE_MIRROR_ADOPT_ENTITY,
    tuple(z.enum(['repository', 'worktree']), name, path),
  ],
]);

const voidResultChannels = [
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
] as const;

const resultSchemas = new Map<string, z.ZodType>([
  ...voidResultChannels.map((channel) => [channel, z.undefined()] as const),
  [IPC_CHANNELS.GIT_COMMIT, commitHash],
  [IPC_CHANNELS.GIT_SUBMODULE_COMMIT, commitHash],
  [
    IPC_CHANNELS.GIT_CLONE,
    z.strictObject({
      success: flag,
      path,
      error: text.optional(),
    }),
  ],
  [IPC_CHANNELS.GIT_GENERATE_COMMIT_MSG, operationResult.extend({ message: text.optional() })],
  [IPC_CHANNELS.GIT_GENERATE_BRANCH_NAME, operationResult.extend({ branchName: name.optional() })],
  [IPC_CHANNELS.GIT_CODE_REVIEW_START, operationResult.extend({ sessionId: name.optional() })],
  [IPC_CHANNELS.WORKTREE_MERGE, worktreeMergeResult],
  [IPC_CHANNELS.WORKTREE_MERGE_CONTINUE, worktreeMergeResult],
  [IPC_CHANNELS.TEMP_WORKSPACE_CREATE, tempWorkspaceCreateResult],
  [IPC_CHANNELS.TEMP_WORKSPACE_REMOVE, tempWorkspaceOperationResult],
  [IPC_CHANNELS.TEMP_WORKSPACE_CHECK_PATH, tempWorkspaceOperationResult],
  [IPC_CHANNELS.FILE_BATCH_MOVE, batchFileResult],
  [IPC_CHANNELS.FILE_BATCH_COPY, batchFileResult],
  [IPC_CHANNELS.TERMINAL_CREATE, name],
  [
    IPC_CHANNELS.TODO_AI_POLISH,
    operationResult.extend({
      title: text.optional(),
      description: text.optional(),
    }),
  ],
  [IPC_CHANNELS.WORKSPACE_MIRROR_REGISTER_ENTITY, WorkspaceEntityReservationSchema],
  [IPC_CHANNELS.WORKSPACE_MIRROR_ADOPT_ENTITY, WorkspaceEntityAdoptionResultSchema],
]);

export function strictWorkspaceCommandSchemas(): ReadonlyMap<string, z.ZodType<CommandArgs>> {
  return schemas;
}

export function strictWorkspaceCommandResultSchemas(): ReadonlyMap<string, z.ZodType> {
  return resultSchemas;
}
