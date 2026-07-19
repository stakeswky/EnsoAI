import { createHash } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import {
  IPC_CHANNELS,
  JsonValueSchema,
  WorkspaceEntityAdoptionResultSchema,
  type WorkspaceEntityKind,
  type WorkspaceSceneSnapshot,
} from '@shared/types';
import { z } from 'zod';
import { createSimpleGit } from '../../git/runtime';
import { WorktreeService } from '../../git/WorktreeService';
import type {
  WorkspaceCommandAdapter,
  WorkspaceCommandInvocationArgs,
  WorkspaceCommandReconcileResult,
} from '../WorkspaceCommandRegistry';
import type { WorkspaceEntityRegistry } from '../WorkspaceEntityRegistry';
import type { WorkspaceSceneEntityUpsert } from '../WorkspaceMirrorService';
import { remoteRepositoryBasePath, remoteWorktreeBasePath } from '../WorkspacePathPolicy';
import type { WorkspaceOperationRecord } from '../WorkspaceStateRepository';

const BOUNDED_PATH_SCHEMA = z.string().min(1).max(32_768);
const BOUNDED_ID_SCHEMA = z.string().min(1).max(256);
const SHA256_SCHEMA = z.string().regex(/^[a-f0-9]{64}$/);

const EntityPathReferenceSchema = z.strictObject({
  rootEntityId: BOUNDED_ID_SCHEMA,
  rootPathDigest: SHA256_SCHEMA,
  relativePath: z.string().min(1).max(32_768),
  relation: z.enum(['within', 'sibling', 'managed']),
});
const WorktreeAddMetadataSchema = z.strictObject({
  domain: z.literal('worktree-add'),
  repository: EntityPathReferenceSchema,
  target: EntityPathReferenceSchema,
  targetEntityId: BOUNDED_ID_SCHEMA,
  branch: z.string().min(1).max(1_024).nullable(),
});
const WorktreeRemoveMetadataSchema = z.strictObject({
  domain: z.literal('worktree-remove'),
  repository: EntityPathReferenceSchema,
  target: EntityPathReferenceSchema,
  targetEntityId: BOUNDED_ID_SCHEMA,
});
const CloneMetadataSchema = z.strictObject({
  domain: z.literal('git-clone'),
  target: EntityPathReferenceSchema,
  targetEntityId: BOUNDED_ID_SCHEMA,
  remoteDigest: SHA256_SCHEMA,
});
const TerminalCreateMetadataSchema = z.strictObject({
  domain: z.literal('terminal-create'),
  sessionId: BOUNDED_ID_SCHEMA,
});
const TerminalDestroyMetadataSchema = z.strictObject({
  domain: z.literal('terminal-destroy'),
  sessionId: BOUNDED_ID_SCHEMA,
});
const TmuxKillMetadataSchema = z.strictObject({
  domain: z.literal('tmux-kill'),
  sessionName: z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/),
});
const EntityRegisterMetadataSchema = z.strictObject({
  domain: z.literal('entity-register'),
  kind: z.enum(['repository', 'worktree']),
  target: EntityPathReferenceSchema,
  targetEntityId: BOUNDED_ID_SCHEMA,
  disposition: z.enum(['existing', 'new']),
});
const EntityAdoptMetadataSchema = z.strictObject({
  domain: z.literal('entity-adopt'),
  kind: z.enum(['repository', 'worktree']),
  target: EntityPathReferenceSchema,
  targetEntityId: BOUNDED_ID_SCHEMA,
});

const LifecycleMetadataSchema = z.discriminatedUnion('domain', [
  WorktreeAddMetadataSchema,
  WorktreeRemoveMetadataSchema,
  CloneMetadataSchema,
  TerminalCreateMetadataSchema,
  TerminalDestroyMetadataSchema,
  TmuxKillMetadataSchema,
  EntityRegisterMetadataSchema,
  EntityAdoptMetadataSchema,
]);

const WorktreeAddArgsSchema = z.tuple([
  BOUNDED_PATH_SCHEMA,
  z.strictObject({
    path: BOUNDED_PATH_SCHEMA,
    branch: z.string().min(1).max(1_024).optional(),
    newBranch: z.string().min(1).max(1_024).optional(),
    checkout: z.boolean().optional(),
  }),
]);
const WorktreeRemoveArgsSchema = z.tuple([
  BOUNDED_PATH_SCHEMA,
  z.strictObject({
    path: BOUNDED_PATH_SCHEMA,
    force: z.boolean().optional(),
    deleteBranch: z.boolean().optional(),
    branch: z.string().min(1).max(1_024).optional(),
  }),
]);
const CloneArgsSchema = z.tuple([z.string().min(1).max(32_768), BOUNDED_PATH_SCHEMA]);
const TerminalCreateOptionsSchema = z.strictObject({
  cwd: BOUNDED_PATH_SCHEMA,
  shell: z.string().min(1).max(32_768).optional(),
  args: z.array(z.string().max(32_768)).max(256).optional(),
  cols: z.number().int().positive().max(10_000).optional(),
  rows: z.number().int().positive().max(10_000).optional(),
  env: z.record(z.string().max(256), z.string().max(256 * 1_024)).optional(),
  shellConfig: JsonValueSchema.optional(),
  initialCommand: z
    .string()
    .max(256 * 1_024)
    .optional(),
  sessionId: BOUNDED_ID_SCHEMA,
  persistent: z.literal(true),
  title: z.string().max(1_024).optional(),
  workspaceId: BOUNDED_ID_SCHEMA.optional(),
});
const TerminalCreateArgsSchema = z.tuple([TerminalCreateOptionsSchema]);
const TerminalDestroyArgsSchema = z.tuple([BOUNDED_ID_SCHEMA]);
const TmuxKillSessionArgsSchema = z.tuple([z.string().regex(/^[a-zA-Z0-9_.:-]{1,128}$/)]);
const EntityRegisterArgsSchema = z.tuple([z.enum(['repository', 'worktree']), BOUNDED_PATH_SCHEMA]);
const EntityAdoptArgsSchema = z.tuple([
  z.enum(['repository', 'worktree']),
  BOUNDED_ID_SCHEMA,
  BOUNDED_PATH_SCHEMA,
]);

type CommandArgs = WorkspaceCommandInvocationArgs;
type CommandAdapter = Partial<WorkspaceCommandAdapter>;
type EntityPathReference = z.infer<typeof EntityPathReferenceSchema>;

interface WorkspaceRoot {
  entityId: string;
  kind: 'repository' | 'worktree';
  path: string;
}

function pathDigest(path: string): string {
  return createHash('sha256').update(resolve(path).normalize('NFC')).digest('hex');
}

export interface LifecycleWorkspaceCommandAdapterContext {
  getSnapshot: () => WorkspaceSceneSnapshot;
  entityRegistry: WorkspaceEntityRegistry;
  commitEntity: (entity: WorkspaceSceneEntityUpsert) => Promise<void>;
  removeWorktree: (entityId: string) => Promise<void>;
  terminalSessionExists: (sessionId: string) => boolean;
  tmuxSessionExists: (sessionName: string) => Promise<boolean>;
}

const MANAGED_REPOSITORY_ROOT_ID = 'managed:remote-repositories';
const MANAGED_WORKTREE_ROOT_ID = 'managed:remote-worktrees';

function commandArgsSchema(schema: z.ZodType): z.ZodType<CommandArgs> {
  return schema as z.ZodType<CommandArgs>;
}

function roots(snapshot: WorkspaceSceneSnapshot): WorkspaceRoot[] {
  return [
    ...Object.values(snapshot.catalog.repositories).map((repository) => ({
      entityId: repository.id,
      kind: 'repository' as const,
      path: resolve(repository.path),
    })),
    ...Object.values(snapshot.catalog.worktrees).map((worktree) => ({
      entityId: worktree.id,
      kind: 'worktree' as const,
      path: resolve(worktree.path),
    })),
  ].sort(
    (left, right) =>
      right.path.length - left.path.length ||
      (left.kind === right.kind
        ? left.entityId.localeCompare(right.entityId)
        : left.kind === 'repository'
          ? -1
          : 1)
  );
}

function isWithin(value: string): boolean {
  return value === '' || (value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value));
}

function withinReference(
  snapshot: WorkspaceSceneSnapshot,
  inputPath: string
): EntityPathReference | null {
  const target = resolve(inputPath);
  for (const root of roots(snapshot)) {
    const candidate = relative(root.path, target);
    if (!isWithin(candidate)) continue;
    return {
      rootEntityId: root.entityId,
      rootPathDigest: pathDigest(root.path),
      relativePath: candidate ? candidate.split(sep).join('/') : '.',
      relation: 'within',
    };
  }
  return null;
}

function siblingReference(
  snapshot: WorkspaceSceneSnapshot,
  anchorPath: string | null,
  inputPath: string
): EntityPathReference | null {
  const target = resolve(inputPath);
  const candidates = roots(snapshot).filter((root) =>
    anchorPath
      ? resolve(root.path) === resolve(anchorPath) && dirname(root.path) === dirname(target)
      : dirname(root.path) === dirname(target)
  );
  const root = candidates[0];
  if (!root) return null;
  const candidate = relative(root.path, target);
  const segments = candidate.split(sep);
  if (
    segments.length !== 2 ||
    segments[0] !== '..' ||
    !segments[1] ||
    segments[1] === '.' ||
    segments[1] === '..'
  ) {
    return null;
  }
  return {
    rootEntityId: root.entityId,
    rootPathDigest: pathDigest(root.path),
    relativePath: candidate.split(sep).join('/'),
    relation: 'sibling',
  };
}

function targetReference(
  snapshot: WorkspaceSceneSnapshot,
  inputPath: string,
  anchorPath: string | null,
  managedKind: 'repository' | 'worktree'
): EntityPathReference | null {
  const sceneReference =
    withinReference(snapshot, inputPath) ?? siblingReference(snapshot, anchorPath, inputPath);
  if (sceneReference) return sceneReference;
  const target = resolve(inputPath);
  const managedRoot = resolve(
    managedKind === 'repository' ? remoteRepositoryBasePath() : remoteWorktreeBasePath()
  );
  const managedRelative = relative(managedRoot, target);
  if (!managedRelative || !isWithin(managedRelative)) return null;
  return {
    rootEntityId:
      managedKind === 'repository' ? MANAGED_REPOSITORY_ROOT_ID : MANAGED_WORKTREE_ROOT_ID,
    rootPathDigest: pathDigest(managedRoot),
    relativePath: managedRelative.split(sep).join('/'),
    relation: 'managed',
  };
}

async function resolveReference(
  context: LifecycleWorkspaceCommandAdapterContext,
  reference: EntityPathReference
): Promise<string | null> {
  if (reference.relativePath.includes('\0')) return null;
  if (reference.relation === 'managed') {
    const managedRoot =
      reference.rootEntityId === MANAGED_REPOSITORY_ROOT_ID
        ? remoteRepositoryBasePath()
        : reference.rootEntityId === MANAGED_WORKTREE_ROOT_ID
          ? remoteWorktreeBasePath()
          : null;
    if (!managedRoot || pathDigest(managedRoot) !== reference.rootPathDigest) return null;
    const hostRelative = reference.relativePath.split('/').join(sep);
    if (!isWithin(hostRelative)) return null;
    return resolve(managedRoot, hostRelative);
  }
  const snapshotPaths = roots(context.getSnapshot())
    .filter(({ entityId }) => entityId === reference.rootEntityId)
    .map(({ path }) => path);
  const persistedPaths = await context.entityRegistry.listEntityPaths(reference.rootEntityId);
  const matchingRoots = [
    ...new Set(
      [...snapshotPaths, ...persistedPaths].filter(
        (path) => pathDigest(path) === reference.rootPathDigest
      )
    ),
  ];
  if (matchingRoots.length !== 1) return null;
  const rootPath = matchingRoots[0]!;
  if (reference.relation === 'within') {
    const hostRelative =
      reference.relativePath === '.' ? '' : reference.relativePath.split('/').join(sep);
    if (!isWithin(hostRelative)) return null;
    return resolve(rootPath, hostRelative);
  }
  const segments = reference.relativePath.split('/');
  if (segments.length !== 2 || segments[0] !== '..' || !segments[1]) return null;
  const target = resolve(rootPath, '..', segments[1]);
  return dirname(target) === dirname(rootPath) ? target : null;
}

function pathsEqual(left: string, right: string): boolean {
  const normalizedLeft = resolve(left).normalize('NFC');
  const normalizedRight = resolve(right).normalize('NFC');
  return normalizedLeft === normalizedRight;
}

async function pathKind(path: string): Promise<'missing' | 'directory' | 'other'> {
  try {
    const value = await lstat(path);
    return value.isDirectory() ? 'directory' : 'other';
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return 'missing';
    }
    throw error;
  }
}

function failure(message: string): WorkspaceCommandReconcileResult {
  return {
    state: 'failed',
    error: { code: 'CONFLICT', message, retryable: false },
  };
}

function adoptionConflictFailure(
  message: string,
  conflictingEntityIds?: string[]
): WorkspaceCommandReconcileResult {
  return {
    state: 'failed',
    error: {
      code: 'ENTITY_ADOPTION_CONFLICT',
      message,
      retryable: false,
      ...(conflictingEntityIds ? { details: { conflictingEntityIds } } : {}),
    },
  };
}

function entityReservationResult(
  sceneId: string,
  kind: WorkspaceEntityKind,
  entityId: string,
  path: string,
  normalizedPath: string,
  disposition: 'existing' | 'new' | 'adopted',
  adoption = false
): WorkspaceCommandReconcileResult {
  const reservation = { sceneId, kind, entityId, path, normalizedPath, disposition };
  return {
    state: 'committed',
    result: adoption
      ? WorkspaceEntityAdoptionResultSchema.parse({ ok: true, reservation })
      : reservation,
  };
}

async function reconcileWorktreeAdd(
  context: LifecycleWorkspaceCommandAdapterContext,
  metadata: z.infer<typeof WorktreeAddMetadataSchema>
): Promise<WorkspaceCommandReconcileResult | null> {
  const repositoryPath = await resolveReference(context, metadata.repository);
  const targetPath = await resolveReference(context, metadata.target);
  if (!repositoryPath || !targetPath) return null;
  let worktrees: Awaited<ReturnType<WorktreeService['list']>>;
  try {
    worktrees = await new WorktreeService(repositoryPath).list();
  } catch {
    return null;
  }
  const match = worktrees.find((worktree) => pathsEqual(worktree.path, targetPath));
  if (!match) {
    return (await pathKind(targetPath)) === 'missing'
      ? failure('Workspace worktree was not created')
      : null;
  }
  if (metadata.branch && match.branch !== metadata.branch) return null;
  await context.commitEntity({
    kind: 'worktree',
    entityId: metadata.targetEntityId,
    repositoryId: metadata.repository.rootEntityId,
    path: targetPath,
    branch: match.branch,
  });
  const resolution = await context.entityRegistry.resolveEntity('worktree', targetPath);
  if (
    resolution.status !== 'resolved' ||
    resolution.entityId !== metadata.targetEntityId ||
    !resolution.durable
  ) {
    return null;
  }
  return {
    state: 'committed',
    result: { entityId: metadata.targetEntityId, kind: 'worktree' },
  };
}

async function reconcileWorktreeRemove(
  context: LifecycleWorkspaceCommandAdapterContext,
  metadata: z.infer<typeof WorktreeRemoveMetadataSchema>
): Promise<WorkspaceCommandReconcileResult | null> {
  const repositoryPath = await resolveReference(context, metadata.repository);
  const targetPath = await resolveReference(context, metadata.target);
  if (!repositoryPath || !targetPath) return null;
  let registered: boolean;
  try {
    registered = (await new WorktreeService(repositoryPath).list()).some((worktree) =>
      pathsEqual(worktree.path, targetPath)
    );
  } catch {
    return null;
  }
  const kind = await pathKind(targetPath);
  if (!registered && kind === 'missing') {
    await context.removeWorktree(metadata.targetEntityId);
    return context.getSnapshot().catalog.worktrees[metadata.targetEntityId]
      ? null
      : { state: 'committed' };
  }
  if (registered && kind === 'directory') {
    return failure('Workspace worktree was not removed');
  }
  return null;
}

async function reconcileClone(
  context: LifecycleWorkspaceCommandAdapterContext,
  metadata: z.infer<typeof CloneMetadataSchema>
): Promise<WorkspaceCommandReconcileResult | null> {
  const targetPath = await resolveReference(context, metadata.target);
  if (!targetPath) return null;
  const kind = await pathKind(targetPath);
  if (kind === 'missing') return failure('Workspace repository was not cloned');
  if (kind !== 'directory') return null;
  try {
    const git = createSimpleGit(targetPath);
    if (!(await git.checkIsRepo())) return null;
    const origin = (await git.getRemotes(true)).find(({ name }) => name === 'origin');
    const remote = origin?.refs.fetch || origin?.refs.push;
    if (
      !remote ||
      createHash('sha256').update(remote.trim()).digest('hex') !== metadata.remoteDigest
    ) {
      return null;
    }
  } catch {
    return null;
  }
  await context.commitEntity({
    kind: 'repository',
    entityId: metadata.targetEntityId,
    path: targetPath,
  });
  const resolution = await context.entityRegistry.resolveEntity('repository', targetPath);
  if (
    resolution.status !== 'resolved' ||
    resolution.entityId !== metadata.targetEntityId ||
    !resolution.durable
  ) {
    return null;
  }
  return {
    state: 'committed',
    result: { success: true },
  };
}

function createReconciler(context: LifecycleWorkspaceCommandAdapterContext) {
  return async (
    operation: WorkspaceOperationRecord
  ): Promise<WorkspaceCommandReconcileResult | null> => {
    const parsed = LifecycleMetadataSchema.safeParse(operation.reconcileMetadata);
    if (!parsed.success) return null;
    const metadata = parsed.data;
    if (metadata.domain === 'worktree-add') return reconcileWorktreeAdd(context, metadata);
    if (metadata.domain === 'worktree-remove') return reconcileWorktreeRemove(context, metadata);
    if (metadata.domain === 'git-clone') return reconcileClone(context, metadata);
    if (metadata.domain === 'terminal-create') {
      return context.terminalSessionExists(metadata.sessionId)
        ? { state: 'committed', result: metadata.sessionId }
        : failure('Workspace terminal process is no longer running');
    }
    if (metadata.domain === 'tmux-kill') {
      return (await context.tmuxSessionExists(metadata.sessionName))
        ? failure('Workspace tmux session was not destroyed')
        : { state: 'committed' };
    }
    if (metadata.domain === 'entity-register' || metadata.domain === 'entity-adopt') {
      const targetPath = await resolveReference(context, metadata.target);
      if (!targetPath) return null;
      const resolution = await context.entityRegistry.resolveEntity(metadata.kind, targetPath);
      if (resolution.status === 'resolved' && resolution.entityId === metadata.targetEntityId) {
        return entityReservationResult(
          resolution.sceneId,
          metadata.kind,
          metadata.targetEntityId,
          resolution.currentPath,
          resolution.normalizedPath,
          metadata.domain === 'entity-register' ? metadata.disposition : 'adopted',
          metadata.domain === 'entity-adopt'
        );
      }
      if (metadata.domain === 'entity-adopt') {
        const snapshotEntity =
          metadata.kind === 'repository'
            ? context.getSnapshot().catalog.repositories[metadata.targetEntityId]
            : context.getSnapshot().catalog.worktrees[metadata.targetEntityId];
        return snapshotEntity
          ? adoptionConflictFailure('Workspace entity adoption was not committed')
          : null;
      }
      if (resolution.status !== 'unresolved') return null;
      const restored = await context.entityRegistry.restoreReservation(
        metadata.kind,
        metadata.targetEntityId,
        targetPath
      );
      return entityReservationResult(
        restored.sceneId,
        restored.kind,
        restored.entityId,
        restored.path,
        restored.normalizedPath,
        metadata.disposition
      );
    }
    return context.terminalSessionExists(metadata.sessionId)
      ? failure('Workspace terminal process was not destroyed')
      : { state: 'committed' };
  };
}

function adapter(
  schema: z.ZodType,
  prepare: (args: CommandArgs) => Promise<unknown>,
  options: {
    cancel?: WorkspaceCommandAdapter['cancel'];
    verify?: WorkspaceCommandAdapter['verify'];
    reconcile: WorkspaceCommandAdapter['reconcile'];
  }
): CommandAdapter {
  return {
    requestSchema: commandArgsSchema(schema),
    prepare,
    ...(options.cancel ? { cancel: options.cancel } : {}),
    ...(options.verify ? { verify: options.verify } : {}),
    reconcile: options.reconcile,
  };
}

export function createLifecycleWorkspaceCommandAdapters(
  context: LifecycleWorkspaceCommandAdapterContext
): ReadonlyMap<string, CommandAdapter> {
  const reconcile = createReconciler(context);
  const cancelReservation = async (operation: WorkspaceOperationRecord): Promise<void> => {
    const parsed = LifecycleMetadataSchema.safeParse(operation.reconcileMetadata);
    if (!parsed.success) return;
    if (
      parsed.data.domain === 'worktree-add' ||
      parsed.data.domain === 'git-clone' ||
      parsed.data.domain === 'entity-register'
    ) {
      context.entityRegistry.discardReservation(parsed.data.targetEntityId);
    }
  };
  const adapters = new Map<string, CommandAdapter>();

  adapters.set(
    IPC_CHANNELS.WORKTREE_ADD,
    adapter(
      WorktreeAddArgsSchema,
      async (args) => {
        const [repositoryPath, options] = WorktreeAddArgsSchema.parse(args);
        const snapshot = context.getSnapshot();
        const repository = withinReference(snapshot, repositoryPath);
        if (!repository || !snapshot.catalog.repositories[repository.rootEntityId]) {
          throw new Error('Workspace worktree repository is not canonical');
        }
        const reservation = await context.entityRegistry.reserveEntity('worktree', options.path);
        const target = targetReference(snapshot, options.path, repositoryPath, 'worktree');
        if (!target) throw new Error('Workspace worktree target cannot be reconciled safely');
        return WorktreeAddMetadataSchema.parse({
          domain: 'worktree-add',
          repository,
          target,
          targetEntityId: reservation.entityId,
          branch: options.newBranch ?? options.branch ?? null,
        });
      },
      {
        cancel: cancelReservation,
        verify: async (operation) => {
          const parsed = WorktreeAddMetadataSchema.safeParse(operation.reconcileMetadata);
          if (!parsed.success) return null;
          return reconcileWorktreeAdd(context, parsed.data);
        },
        reconcile,
      }
    )
  );
  adapters.set(
    IPC_CHANNELS.WORKTREE_REMOVE,
    adapter(
      WorktreeRemoveArgsSchema,
      async (args) => {
        const [repositoryPath, options] = WorktreeRemoveArgsSchema.parse(args);
        const snapshot = context.getSnapshot();
        const repository = withinReference(snapshot, repositoryPath);
        const target = withinReference(snapshot, options.path);
        const targetEntity = Object.values(snapshot.catalog.worktrees).find((worktree) =>
          pathsEqual(worktree.path, options.path)
        );
        if (!repository || !target || !targetEntity) {
          throw new Error('Workspace worktree removal is not canonical');
        }
        return WorktreeRemoveMetadataSchema.parse({
          domain: 'worktree-remove',
          repository,
          target,
          targetEntityId: targetEntity.id,
        });
      },
      { verify: reconcile, reconcile }
    )
  );
  adapters.set(
    IPC_CHANNELS.GIT_CLONE,
    adapter(
      CloneArgsSchema,
      async (args) => {
        const [remote, targetPath] = CloneArgsSchema.parse(args);
        const snapshot = context.getSnapshot();
        const reservation = await context.entityRegistry.reserveEntity('repository', targetPath);
        const target = targetReference(snapshot, targetPath, null, 'repository');
        if (!target) throw new Error('Workspace clone target cannot be reconciled safely');
        return CloneMetadataSchema.parse({
          domain: 'git-clone',
          target,
          targetEntityId: reservation.entityId,
          remoteDigest: createHash('sha256').update(remote.trim()).digest('hex'),
        });
      },
      {
        cancel: cancelReservation,
        verify: async (operation, result) => {
          const parsed = CloneMetadataSchema.safeParse(operation.reconcileMetadata);
          if (!parsed.success) return null;
          if (
            result &&
            typeof result === 'object' &&
            'success' in result &&
            result.success === false
          ) {
            return failure('Workspace repository clone failed');
          }
          return reconcileClone(context, parsed.data);
        },
        reconcile,
      }
    )
  );
  adapters.set(
    IPC_CHANNELS.TERMINAL_CREATE,
    adapter(
      TerminalCreateArgsSchema,
      async (args) => {
        const [options] = TerminalCreateArgsSchema.parse(args);
        return TerminalCreateMetadataSchema.parse({
          domain: 'terminal-create',
          sessionId: options.sessionId,
        });
      },
      { reconcile }
    )
  );
  adapters.set(
    IPC_CHANNELS.TERMINAL_DESTROY,
    adapter(
      TerminalDestroyArgsSchema,
      async (args) => {
        const [sessionId] = TerminalDestroyArgsSchema.parse(args);
        return TerminalDestroyMetadataSchema.parse({ domain: 'terminal-destroy', sessionId });
      },
      { verify: reconcile, reconcile }
    )
  );
  adapters.set(
    IPC_CHANNELS.TMUX_KILL_SESSION,
    adapter(
      TmuxKillSessionArgsSchema,
      async (args) => {
        const [sessionName] = TmuxKillSessionArgsSchema.parse(args);
        return TmuxKillMetadataSchema.parse({ domain: 'tmux-kill', sessionName });
      },
      { verify: reconcile, reconcile }
    )
  );
  adapters.set(
    IPC_CHANNELS.WORKSPACE_MIRROR_REGISTER_ENTITY,
    adapter(
      EntityRegisterArgsSchema,
      async (args) => {
        const [kind, path] = EntityRegisterArgsSchema.parse(args);
        const snapshot = context.getSnapshot();
        const target = targetReference(snapshot, path, null, kind);
        if (!target) throw new Error('Workspace entity target cannot be reconciled safely');
        const reservation = await context.entityRegistry.reserveEntity(kind, path);
        return EntityRegisterMetadataSchema.parse({
          domain: 'entity-register',
          kind,
          target,
          targetEntityId: reservation.entityId,
          disposition: reservation.disposition === 'existing' ? 'existing' : 'new',
        });
      },
      { cancel: cancelReservation, verify: reconcile, reconcile }
    )
  );
  adapters.set(
    IPC_CHANNELS.WORKSPACE_MIRROR_ADOPT_ENTITY,
    adapter(
      EntityAdoptArgsSchema,
      async (args) => {
        const [kind, entityId, path] = EntityAdoptArgsSchema.parse(args);
        const target = targetReference(context.getSnapshot(), path, null, kind);
        if (!target) throw new Error('Workspace adoption target cannot be reconciled safely');
        return EntityAdoptMetadataSchema.parse({
          domain: 'entity-adopt',
          kind,
          target,
          targetEntityId: entityId,
        });
      },
      {
        verify: async (operation, result) => {
          const adoption = WorkspaceEntityAdoptionResultSchema.parse(result);
          if (!adoption.ok) {
            return adoptionConflictFailure(
              adoption.error.message,
              adoption.error.conflictingEntityIds
            );
          }
          return reconcile(operation);
        },
        reconcile,
      }
    )
  );

  return adapters;
}
