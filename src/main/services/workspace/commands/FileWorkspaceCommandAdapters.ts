import { createHash } from 'node:crypto';
import { createReadStream, type Stats } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { IPC_CHANNELS, type WorkspaceSceneSnapshot } from '@shared/types';
import iconv from 'iconv-lite';
import { z } from 'zod';
import type {
  WorkspaceCommandAdapter,
  WorkspaceCommandInvocationArgs,
  WorkspaceCommandReconcileResult,
} from '../WorkspaceCommandRegistry';
import type { WorkspaceOperationRecord } from '../WorkspaceStateRepository';

const SHA256_SCHEMA = z.string().regex(/^[a-f0-9]{64}$/);
const BOUNDED_PATH_SCHEMA = z.string().min(1).max(32_768);
const SAFE_INTEGER_SCHEMA = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

const FilePathReferenceSchema = z.strictObject({
  rootEntityId: z.string().min(1).max(256),
  relativePath: z.string().min(1).max(32_768),
});

const MissingFingerprintSchema = z.strictObject({ kind: z.literal('missing') });
const PresentFingerprintSchema = z.strictObject({
  kind: z.enum(['file', 'directory']),
  size: SAFE_INTEGER_SCHEMA,
  digest: SHA256_SCHEMA,
});
const FileFingerprintSchema = z.discriminatedUnion('kind', [
  MissingFingerprintSchema,
  PresentFingerprintSchema,
]);

const ReplaceEffectSchema = z.strictObject({
  effect: z.literal('replace'),
  target: FilePathReferenceSchema,
  before: FileFingerprintSchema,
  expected: PresentFingerprintSchema,
});
const EnsureDirectoryEffectSchema = z.strictObject({
  effect: z.literal('ensure-directory'),
  target: FilePathReferenceSchema,
  before: FileFingerprintSchema,
});
const DeleteEffectSchema = z.strictObject({
  effect: z.literal('delete'),
  target: FilePathReferenceSchema,
  before: PresentFingerprintSchema,
});
const TransferEffectSchema = z.strictObject({
  effect: z.enum(['copy', 'move']),
  source: FilePathReferenceSchema,
  target: FilePathReferenceSchema,
  sourceBefore: PresentFingerprintSchema,
  targetBefore: FileFingerprintSchema,
  expected: PresentFingerprintSchema,
});
const FileEffectSchema = z.discriminatedUnion('effect', [
  ReplaceEffectSchema,
  EnsureDirectoryEffectSchema,
  DeleteEffectSchema,
  TransferEffectSchema,
]);
const FileReconcileMetadataSchema = z.strictObject({
  domain: z.literal('file'),
  effects: z.array(FileEffectSchema).max(2_048),
});

type FilePathReference = z.infer<typeof FilePathReferenceSchema>;
type FileFingerprint = z.infer<typeof FileFingerprintSchema>;
type PresentFingerprint = z.infer<typeof PresentFingerprintSchema>;
type FileEffect = z.infer<typeof FileEffectSchema>;

interface FileNode {
  kind: 'file' | 'directory';
  size: number;
  digest: string;
  children?: ReadonlyMap<string, FileNode>;
}

interface WorkspaceRoot {
  entityId: string;
  path: string;
}

export interface FileWorkspaceCommandAdapterContext {
  getSnapshot: () => WorkspaceSceneSnapshot;
}

type CommandArgs = WorkspaceCommandInvocationArgs;
type CommandAdapter = Partial<WorkspaceCommandAdapter>;

function commandArgsSchema(schema: z.ZodType): z.ZodType<CommandArgs> {
  return schema as z.ZodType<CommandArgs>;
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isNotFound(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

async function hashFile(path: string): Promise<string> {
  return new Promise((resolveDigest, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolveDigest(hash.digest('hex')));
  });
}

function digestDirectory(children: ReadonlyMap<string, FileNode>): string {
  const hash = createHash('sha256');
  for (const [name, child] of [...children.entries()].sort(([left], [right]) =>
    compareNames(left, right)
  )) {
    hash.update(String(Buffer.byteLength(name, 'utf8')));
    hash.update(':');
    hash.update(name);
    hash.update('\0');
    hash.update(child.kind);
    hash.update(':');
    hash.update(String(child.size));
    hash.update(':');
    hash.update(child.digest);
    hash.update('\0');
  }
  return hash.digest('hex');
}

async function readFileNode(path: string): Promise<FileNode | null> {
  let before: Stats;
  try {
    before = await lstat(path);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  if (before.isSymbolicLink()) {
    throw new Error('Workspace file reconciliation does not follow symbolic links');
  }
  if (before.isFile()) {
    const digest = await hashFile(path);
    const after = await lstat(path);
    if (
      !after.isFile() ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs
    ) {
      throw new Error('Workspace file changed while preparing command metadata');
    }
    return { kind: 'file', size: after.size, digest };
  }
  if (!before.isDirectory()) {
    throw new Error('Workspace file command supports regular files and directories only');
  }

  const entries = (await readdir(path, { withFileTypes: true })).sort((left, right) =>
    compareNames(left.name, right.name)
  );
  const children = new Map<string, FileNode>();
  let size = 0;
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      throw new Error('Workspace directory reconciliation does not follow symbolic links');
    }
    const child = await readFileNode(join(path, entry.name));
    if (!child) throw new Error('Workspace directory changed while preparing command metadata');
    children.set(entry.name, child);
    size += child.size;
    if (!Number.isSafeInteger(size)) {
      throw new Error('Workspace directory is too large to reconcile safely');
    }
  }
  const afterEntries = (await readdir(path)).sort(compareNames);
  if (
    afterEntries.length !== entries.length ||
    afterEntries.some((name, index) => name !== entries[index]?.name)
  ) {
    throw new Error('Workspace directory changed while preparing command metadata');
  }
  return { kind: 'directory', size, digest: digestDirectory(children), children };
}

function fingerprint(node: FileNode | null): FileFingerprint {
  return node ? { kind: node.kind, size: node.size, digest: node.digest } : { kind: 'missing' };
}

function mergeCopiedDirectory(source: FileNode, target: FileNode | null): FileNode {
  if (source.kind !== 'directory') return source;
  if (target && target.kind !== 'directory') {
    throw new Error('Cannot copy a directory over a non-directory target');
  }
  const children = new Map(target?.children ?? []);
  for (const [name, sourceChild] of source.children ?? []) {
    const targetChild = children.get(name) ?? null;
    children.set(
      name,
      sourceChild.kind === 'directory'
        ? mergeCopiedDirectory(sourceChild, targetChild)
        : sourceChild
    );
  }
  let size = 0;
  for (const child of children.values()) size += child.size;
  if (!Number.isSafeInteger(size)) {
    throw new Error('Workspace directory is too large to reconcile safely');
  }
  return { kind: 'directory', size, digest: digestDirectory(children), children };
}

function bufferFingerprint(buffer: Buffer): PresentFingerprint {
  return {
    kind: 'file',
    size: buffer.byteLength,
    digest: createHash('sha256').update(buffer).digest('hex'),
  };
}

function workspaceRoots(snapshot: WorkspaceSceneSnapshot): WorkspaceRoot[] {
  const roots: WorkspaceRoot[] = [];
  for (const repository of Object.values(snapshot.catalog.repositories)) {
    roots.push({ entityId: repository.id, path: resolve(repository.path) });
  }
  for (const worktree of Object.values(snapshot.catalog.worktrees)) {
    roots.push({ entityId: worktree.id, path: resolve(worktree.path) });
  }
  return roots.sort(
    (left, right) =>
      right.path.length - left.path.length || left.entityId.localeCompare(right.entityId)
  );
}

function isContainedRelativePath(value: string): boolean {
  return value !== '..' && !value.startsWith(`..${sep}`) && !isAbsolute(value);
}

function referencePath(snapshot: WorkspaceSceneSnapshot, inputPath: string): FilePathReference {
  const target = resolve(inputPath);
  for (const root of workspaceRoots(snapshot)) {
    const candidate = relative(root.path, target);
    if (!candidate || !isContainedRelativePath(candidate)) continue;
    return {
      rootEntityId: root.entityId,
      relativePath: candidate.split(sep).join('/'),
    };
  }
  throw new Error('Workspace file path is not below a canonical scene entity');
}

function resolveReference(
  snapshot: WorkspaceSceneSnapshot,
  reference: FilePathReference
): string | null {
  const roots = workspaceRoots(snapshot).filter(
    ({ entityId }) => entityId === reference.rootEntityId
  );
  if (roots.length !== 1 || reference.relativePath.includes('\0')) return null;
  const hostRelative = reference.relativePath.split('/').join(sep);
  if (!isContainedRelativePath(hostRelative)) return null;
  return resolve(roots[0]!.path, hostRelative);
}

function fingerprintsEqual(left: FileFingerprint, right: FileFingerprint): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'missing' || right.kind === 'missing') return true;
  return left.size === right.size && left.digest === right.digest;
}

function failedPostcondition(): WorkspaceCommandReconcileResult {
  return {
    state: 'failed',
    error: {
      code: 'CONFLICT',
      message: 'Workspace file command postcondition was not satisfied',
      retryable: false,
    },
  };
}

async function reconcileEffect(
  snapshot: WorkspaceSceneSnapshot,
  effect: FileEffect
): Promise<'committed' | 'failed' | null> {
  const targetPath = resolveReference(snapshot, effect.target);
  if (!targetPath) return null;
  const target = fingerprint(await readFileNode(targetPath));

  if (effect.effect === 'replace') {
    if (fingerprintsEqual(target, effect.expected)) return 'committed';
    return fingerprintsEqual(target, effect.before) ? 'failed' : null;
  }
  if (effect.effect === 'ensure-directory') {
    if (target.kind === 'directory') return 'committed';
    return fingerprintsEqual(target, effect.before) ? 'failed' : null;
  }
  if (effect.effect === 'delete') {
    if (target.kind === 'missing') return 'committed';
    return fingerprintsEqual(target, effect.before) ? 'failed' : null;
  }

  const sourcePath = resolveReference(snapshot, effect.source);
  if (!sourcePath) return null;
  const source = fingerprint(await readFileNode(sourcePath));
  if (effect.effect === 'copy') {
    if (fingerprintsEqual(target, effect.expected)) return 'committed';
    return fingerprintsEqual(target, effect.targetBefore) ? 'failed' : null;
  }
  if (fingerprintsEqual(target, effect.expected) && source.kind === 'missing') {
    return 'committed';
  }
  if (
    fingerprintsEqual(source, effect.sourceBefore) &&
    fingerprintsEqual(target, effect.targetBefore)
  ) {
    return 'failed';
  }
  return null;
}

function createReconciler(context: FileWorkspaceCommandAdapterContext) {
  return async (
    operation: WorkspaceOperationRecord
  ): Promise<WorkspaceCommandReconcileResult | null> => {
    const parsed = FileReconcileMetadataSchema.safeParse(operation.reconcileMetadata);
    if (!parsed.success) return null;
    const outcomes = await Promise.all(
      parsed.data.effects.map((effect) => reconcileEffect(context.getSnapshot(), effect))
    );
    if (outcomes.some((outcome) => outcome === null)) return null;
    return outcomes.every((outcome) => outcome === 'committed')
      ? { state: 'committed' }
      : failedPostcondition();
  };
}

async function replaceEffect(
  snapshot: WorkspaceSceneSnapshot,
  targetPath: string,
  expected: PresentFingerprint
): Promise<FileEffect> {
  return {
    effect: 'replace',
    target: referencePath(snapshot, targetPath),
    before: fingerprint(await readFileNode(targetPath)),
    expected,
  };
}

async function transferEffect(
  snapshot: WorkspaceSceneSnapshot,
  mode: 'copy' | 'move',
  sourcePath: string,
  targetPath: string
): Promise<FileEffect> {
  const [sourceNode, targetNode] = await Promise.all([
    readFileNode(sourcePath),
    readFileNode(targetPath),
  ]);
  if (!sourceNode) throw new Error('Workspace file command source does not exist');
  const expected = mode === 'copy' ? mergeCopiedDirectory(sourceNode, targetNode) : sourceNode;
  return {
    effect: mode,
    source: referencePath(snapshot, sourcePath),
    target: referencePath(snapshot, targetPath),
    sourceBefore: fingerprint(sourceNode) as PresentFingerprint,
    targetBefore: fingerprint(targetNode),
    expected: fingerprint(expected) as PresentFingerprint,
  };
}

const FileWriteArgsSchema = z.tuple([
  BOUNDED_PATH_SCHEMA,
  z.string(),
  z.string().min(1).max(64).optional(),
]);
const FileCreateArgsSchema = z.tuple([
  BOUNDED_PATH_SCHEMA,
  z.string().optional(),
  z.strictObject({ overwrite: z.boolean().optional() }).optional(),
]);
const FileCreateDirectoryArgsSchema = z.tuple([BOUNDED_PATH_SCHEMA]);
const FileRenameArgsSchema = z.tuple([BOUNDED_PATH_SCHEMA, BOUNDED_PATH_SCHEMA]);
const FileDeleteArgsSchema = z.tuple([
  BOUNDED_PATH_SCHEMA,
  z.strictObject({ recursive: z.boolean().optional() }).optional(),
]);
const BatchConflictSchema = z.strictObject({
  path: BOUNDED_PATH_SCHEMA,
  action: z.enum(['replace', 'skip', 'rename']),
  newName: z.string().min(1).max(1_024).optional(),
});
const FileBatchArgsSchema = z.tuple([
  z.array(BOUNDED_PATH_SCHEMA).max(2_048),
  BOUNDED_PATH_SCHEMA,
  z.array(BatchConflictSchema).max(2_048),
]);

function adapter(
  schema: z.ZodType,
  prepare: (args: CommandArgs) => Promise<unknown>,
  reconcile: (
    operation: WorkspaceOperationRecord
  ) => Promise<WorkspaceCommandReconcileResult | null>
): CommandAdapter {
  return {
    requestSchema: commandArgsSchema(schema),
    prepare,
    verify: reconcile,
    reconcile,
  };
}

export function createFileWorkspaceCommandAdapters(
  context: FileWorkspaceCommandAdapterContext
): ReadonlyMap<string, CommandAdapter> {
  const reconcile = createReconciler(context);
  const adapters = new Map<string, CommandAdapter>();

  adapters.set(
    IPC_CHANNELS.FILE_WRITE,
    adapter(
      FileWriteArgsSchema,
      async (args) => {
        const [targetPath, content, encoding] = FileWriteArgsSchema.parse(args);
        return FileReconcileMetadataSchema.parse({
          domain: 'file',
          effects: [
            await replaceEffect(
              context.getSnapshot(),
              targetPath,
              bufferFingerprint(iconv.encode(content, encoding ?? 'utf-8'))
            ),
          ],
        });
      },
      reconcile
    )
  );
  adapters.set(
    IPC_CHANNELS.FILE_CREATE,
    adapter(
      FileCreateArgsSchema,
      async (args) => {
        const [targetPath, content = '', options] = FileCreateArgsSchema.parse(args);
        const effect = await replaceEffect(
          context.getSnapshot(),
          targetPath,
          bufferFingerprint(Buffer.from(content, 'utf8'))
        );
        if (
          !options?.overwrite &&
          effect.effect === 'replace' &&
          effect.before.kind !== 'missing'
        ) {
          throw new Error('Workspace file already exists');
        }
        return FileReconcileMetadataSchema.parse({ domain: 'file', effects: [effect] });
      },
      reconcile
    )
  );
  adapters.set(
    IPC_CHANNELS.FILE_CREATE_DIR,
    adapter(
      FileCreateDirectoryArgsSchema,
      async (args) => {
        const [targetPath] = FileCreateDirectoryArgsSchema.parse(args);
        const before = fingerprint(await readFileNode(targetPath));
        if (before.kind === 'file') throw new Error('Workspace directory target is a file');
        return FileReconcileMetadataSchema.parse({
          domain: 'file',
          effects: [
            {
              effect: 'ensure-directory',
              target: referencePath(context.getSnapshot(), targetPath),
              before,
            },
          ],
        });
      },
      reconcile
    )
  );
  for (const channel of [IPC_CHANNELS.FILE_RENAME, IPC_CHANNELS.FILE_MOVE] as const) {
    adapters.set(
      channel,
      adapter(
        FileRenameArgsSchema,
        async (args) => {
          const [sourcePath, targetPath] = FileRenameArgsSchema.parse(args);
          if (resolve(sourcePath) === resolve(targetPath)) {
            throw new Error('Workspace file source and target must differ');
          }
          return FileReconcileMetadataSchema.parse({
            domain: 'file',
            effects: [await transferEffect(context.getSnapshot(), 'move', sourcePath, targetPath)],
          });
        },
        reconcile
      )
    );
  }
  adapters.set(
    IPC_CHANNELS.FILE_COPY,
    adapter(
      FileRenameArgsSchema,
      async (args) => {
        const [sourcePath, targetPath] = FileRenameArgsSchema.parse(args);
        if (resolve(sourcePath) === resolve(targetPath)) {
          throw new Error('Workspace file source and target must differ');
        }
        return FileReconcileMetadataSchema.parse({
          domain: 'file',
          effects: [await transferEffect(context.getSnapshot(), 'copy', sourcePath, targetPath)],
        });
      },
      reconcile
    )
  );
  adapters.set(
    IPC_CHANNELS.FILE_DELETE,
    adapter(
      FileDeleteArgsSchema,
      async (args) => {
        const [targetPath] = FileDeleteArgsSchema.parse(args);
        const before = fingerprint(await readFileNode(targetPath));
        if (before.kind === 'missing') throw new Error('Workspace file does not exist');
        return FileReconcileMetadataSchema.parse({
          domain: 'file',
          effects: [
            {
              effect: 'delete',
              target: referencePath(context.getSnapshot(), targetPath),
              before,
            },
          ],
        });
      },
      reconcile
    )
  );

  for (const [channel, mode] of [
    [IPC_CHANNELS.FILE_BATCH_COPY, 'copy'],
    [IPC_CHANNELS.FILE_BATCH_MOVE, 'move'],
  ] as const) {
    adapters.set(
      channel,
      adapter(
        FileBatchArgsSchema,
        async (args) => {
          const [sources, targetDirectory, conflicts] = FileBatchArgsSchema.parse(args);
          const conflictBySource = new Map(
            conflicts.map((conflict) => [resolve(conflict.path), conflict])
          );
          const targetPaths = new Set<string>();
          const effects: FileEffect[] = [];
          for (const sourcePath of sources) {
            const conflict = conflictBySource.get(resolve(sourcePath));
            if (conflict?.action === 'skip') continue;
            if (
              conflict?.action === 'rename' &&
              (!conflict.newName ||
                basename(conflict.newName) !== conflict.newName ||
                conflict.newName === '.' ||
                conflict.newName === '..')
            ) {
              throw new Error('Workspace batch target name is invalid');
            }
            const targetPath = join(
              targetDirectory,
              conflict?.action === 'rename' ? conflict.newName! : basename(sourcePath)
            );
            const targetKey = resolve(targetPath);
            if (targetPaths.has(targetKey)) {
              throw new Error('Workspace batch command contains duplicate targets');
            }
            targetPaths.add(targetKey);
            effects.push(await transferEffect(context.getSnapshot(), mode, sourcePath, targetPath));
          }
          return FileReconcileMetadataSchema.parse({ domain: 'file', effects });
        },
        reconcile
      )
    );
  }

  return adapters;
}
