import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { WorkspaceSceneSnapshot } from '@shared/types';
import type { TerminalSessionLifecycleEvent } from '../terminal/TerminalSessionRegistry';
import { terminalSessionRegistry } from '../terminal/terminalRuntime';
import * as todoService from '../todo/TodoService';
import { SqliteWorkspaceStateRepository } from './SqliteWorkspaceStateRepository';
import { WorkspaceMirrorService } from './WorkspaceMirrorService';
import { WorkspaceResourceService } from './WorkspaceResourceService';

let service: WorkspaceMirrorService | null = null;
let repository: SqliteWorkspaceStateRepository | null = null;
let resourceService: WorkspaceResourceService | null = null;
let leaseSweepTimer: NodeJS.Timeout | null = null;
let resourceGcTimer: NodeJS.Timeout | null = null;
let resourceSubscription: (() => void) | null = null;
let terminalLifecycleSubscription: (() => void) | null = null;
let terminalLifecycleTail: Promise<void> = Promise.resolve();
const LEGACY_IMPORT_MIGRATION_KEY = 'legacy-renderer-import-v1';
const TERMINAL_LIFECYCLE_NOOP = Symbol('terminal-lifecycle-noop');

function migrationRevisionFromMetadata(metadata: unknown): number | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const candidate = metadata as Record<string, unknown>;
  return candidate.version === 1 &&
    typeof candidate.revision === 'number' &&
    Number.isSafeInteger(candidate.revision) &&
    candidate.revision >= 0
    ? candidate.revision
    : null;
}

function stableHostId(userDataPath: string): string {
  return `host-${createHash('sha256').update(userDataPath).digest('hex').slice(0, 24)}`;
}

async function reconcileTerminalLifecycle(
  activeService: WorkspaceMirrorService,
  lifecycle: TerminalSessionLifecycleEvent
): Promise<void> {
  try {
    await activeService.dispatchHostMutationFactory((snapshot) => {
      const current = snapshot.terminals.sessions[lifecycle.sessionId];
      const metadata = terminalSessionRegistry.getMetadata(lifecycle.sessionId);
      if (
        current &&
        current.processState === lifecycle.processState &&
        current.exitCode === lifecycle.exitCode
      ) {
        throw TERMINAL_LIFECYCLE_NOOP;
      }
      const terminals = structuredClone(snapshot.terminals);
      terminals.sessions[lifecycle.sessionId] = {
        ...(current ?? {
          id: lifecycle.sessionId,
          generation: 1,
          repositoryId: null,
          worktreeId: null,
          title: metadata?.title ?? 'Terminal',
          cwd: metadata?.cwd ?? '/',
          groupId: null,
          order: Object.keys(terminals.sessions).length,
        }),
        processState: lifecycle.processState,
        exitCode: lifecycle.exitCode,
      };
      return {
        mutation: { kind: 'terminals.replace', payload: { terminals } },
        result: undefined,
      };
    }, 'reconcile');
  } catch (error) {
    if (error !== TERMINAL_LIFECYCLE_NOOP) throw error;
  }
}

function enqueueTerminalLifecycle(
  activeService: WorkspaceMirrorService,
  lifecycle: TerminalSessionLifecycleEvent
): void {
  terminalLifecycleTail = terminalLifecycleTail
    .then(() => reconcileTerminalLifecycle(activeService, lifecycle))
    .catch(() => {
      console.warn('[workspace-mirror] failed to reconcile terminal lifecycle');
    });
}

export async function initializeWorkspaceMirrorRuntime(
  userDataPath: string
): Promise<WorkspaceMirrorService> {
  if (service) return service;

  const nextRepository = new SqliteWorkspaceStateRepository(
    join(userDataPath, 'workspace-mirror.db')
  );
  await nextRepository.initialize();
  const migrationMetadata = await nextRepository.loadMigrationMetadata(LEGACY_IMPORT_MIGRATION_KEY);
  const migrationRevision = migrationRevisionFromMetadata(migrationMetadata);
  const nextService = new WorkspaceMirrorService({
    hostId: stableHostId(userDataPath),
    sceneId: 'default-workspace',
    repository: nextRepository,
    // Do not trust the marker until it has been compared with the loaded
    // canonical snapshot below. A stale marker must leave the host gated.
    bootstrapReady: false,
  });
  await nextService.initialize();
  const canonicalRevision = nextService.getSnapshot().revision;
  const todoMigrationMarkerValid = await todoService.hasValidWorkspaceMigrationMarker(userDataPath);
  // The external Todo marker is written before the workspace database marker.
  // If the process dies in that narrow window, recover the canonical marker
  // before IPC handlers are registered so a renderer cannot write Todo data
  // while the host is still gated in `bootstrapping`.
  let effectiveMigrationRevision = migrationRevision;
  if (todoMigrationMarkerValid && migrationMetadata === null) {
    await nextRepository.markMigration(LEGACY_IMPORT_MIGRATION_KEY, {
      version: 1,
      revision: canonicalRevision,
      todoAuthority: 'workspace',
      recoveredAfterExternalMarker: true,
    });
    effectiveMigrationRevision = canonicalRevision;
  }
  if (
    todoMigrationMarkerValid &&
    effectiveMigrationRevision !== null &&
    effectiveMigrationRevision <= canonicalRevision
  ) {
    nextService.completeBootstrap();
  }
  const nextResourceService = new WorkspaceResourceService(
    join(userDataPath, 'workspace-resources')
  );
  await nextResourceService.initialize();
  const syncResourceReferences = (): void => {
    const referencedIds = new Set(
      Object.values(nextService.getSnapshot().agents.sessions).flatMap((session) =>
        session.draft.resources.map((resource) => resource.id)
      )
    );
    nextResourceService.setReferencedResourceIds(referencedIds);
  };
  syncResourceReferences();
  resourceSubscription = nextService.subscribe(syncResourceReferences);
  repository = nextRepository;
  resourceService = nextResourceService;
  service = nextService;
  terminalLifecycleTail = Promise.resolve();
  terminalLifecycleSubscription = terminalSessionRegistry.subscribeLifecycle((lifecycle) => {
    enqueueTerminalLifecycle(nextService, lifecycle);
  });
  leaseSweepTimer = setInterval(() => {
    void nextService.sweepExpiredLease();
  }, 1_000);
  resourceGcTimer = setInterval(() => {
    void nextResourceService.garbageCollect();
  }, 60_000);
  return nextService;
}

export function getWorkspaceResourceService(): WorkspaceResourceService {
  if (!resourceService) throw new Error('Workspace resource runtime is not initialized');
  return resourceService;
}

export async function completeWorkspaceMirrorBootstrap(
  finalize?: (snapshot: WorkspaceSceneSnapshot) => Promise<void>
): Promise<void> {
  const activeService = getWorkspaceMirrorService();
  const activeRepository = repository;
  if (!activeRepository) throw new Error('Workspace mirror runtime is not initialized');
  await activeService.completeBootstrapAfter(async (snapshot) => {
    await finalize?.(snapshot);
    await activeRepository.markMigration(LEGACY_IMPORT_MIGRATION_KEY, {
      version: 1,
      revision: snapshot.revision,
      todoAuthority: 'workspace',
    });
  });
}

export function getWorkspaceMirrorService(): WorkspaceMirrorService {
  if (!service) {
    throw new Error('Workspace mirror runtime is not initialized');
  }
  return service;
}

export async function cleanupWorkspaceMirrorRuntime(): Promise<void> {
  if (leaseSweepTimer) {
    clearInterval(leaseSweepTimer);
    leaseSweepTimer = null;
  }
  if (resourceGcTimer) {
    clearInterval(resourceGcTimer);
    resourceGcTimer = null;
  }
  resourceSubscription?.();
  resourceSubscription = null;
  terminalLifecycleSubscription?.();
  terminalLifecycleSubscription = null;
  await terminalLifecycleTail;
  terminalLifecycleTail = Promise.resolve();
  const activeRepository = repository;
  repository = null;
  const activeResourceService = resourceService;
  resourceService = null;
  service = null;
  await activeResourceService?.garbageCollect();
  await activeRepository?.close();
}
