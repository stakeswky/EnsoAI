import { randomUUID } from 'node:crypto';
import { posix, win32 } from 'node:path';
import type { WorkspaceSceneSnapshot } from '@shared/types/workspaceMirror';
import type { WorkspaceStateRepository } from './WorkspaceStateRepository';

export type WorkspaceEntityKind = 'repository' | 'worktree';
export type WorkspaceEntityStatus = 'active' | 'retired';
export type WorkspaceHostPathPlatform = 'darwin' | 'linux' | 'win32';
export type WorkspaceHostPathCasePolicy = 'sensitive' | 'insensitive' | 'exact';

export interface WorkspaceEntityRecord {
  sceneId: string;
  entityId: string;
  kind: WorkspaceEntityKind;
  currentPath: string;
  normalizedPath: string;
  status: WorkspaceEntityStatus;
  createdAt: number;
  updatedAt: number;
}

export interface WorkspaceEntityAliasRecord {
  sceneId: string;
  entityId: string;
  kind: WorkspaceEntityKind;
  path: string;
  normalizedPath: string;
  createdAt: number;
  lastSeenAt: number;
}

export interface WorkspaceEntityReservationRecord {
  sceneId: string;
  entityId: string;
  kind: WorkspaceEntityKind;
  path: string;
  normalizedPath: string;
  disposition: 'new' | 'adopted';
  createdAt: number;
  updatedAt: number;
}

export interface WorkspaceEntityRegistryState {
  entities: WorkspaceEntityRecord[];
  aliases: WorkspaceEntityAliasRecord[];
  reservations: WorkspaceEntityReservationRecord[];
}

export interface NormalizedWorkspaceEntityPath {
  path: string;
  normalizedPath: string;
}

export type WorkspaceEntityResolution =
  | {
      status: 'resolved';
      sceneId: string;
      entityId: string;
      kind: WorkspaceEntityKind;
      currentPath: string;
      normalizedPath: string;
      aliases: string[];
      entityStatus: WorkspaceEntityStatus;
      match: 'current' | 'alias' | 'reservation';
      durable: boolean;
    }
  | {
      status: 'unresolved';
      sceneId: string;
      kind: WorkspaceEntityKind;
      path: string;
      normalizedPath: string;
    }
  | {
      status: 'ambiguous';
      sceneId: string;
      kind: WorkspaceEntityKind;
      path: string;
      normalizedPath: string;
      entityIds: string[];
    };

export interface WorkspaceEntityReservation {
  sceneId: string;
  entityId: string;
  kind: WorkspaceEntityKind;
  path: string;
  normalizedPath: string;
  disposition: 'existing' | 'new' | 'adopted';
}

export type WorkspaceEntityRegistryErrorCode =
  | 'ENTITY_NOT_FOUND'
  | 'ENTITY_KIND_CONFLICT'
  | 'ENTITY_PATH_CONFLICT'
  | 'ENTITY_ADOPTION_REQUIRED'
  | 'ENTITY_ADOPTION_CONFLICT';

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class WorkspaceEntityRegistryError extends Error {
  constructor(
    readonly code: WorkspaceEntityRegistryErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {}
  ) {
    super(message);
    this.name = 'WorkspaceEntityRegistryError';
  }
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function compareEntityRecords(left: WorkspaceEntityRecord, right: WorkspaceEntityRecord): number {
  return left.kind.localeCompare(right.kind) || left.entityId.localeCompare(right.entityId);
}

function compareAliasRecords(
  left: WorkspaceEntityAliasRecord,
  right: WorkspaceEntityAliasRecord
): number {
  return (
    left.kind.localeCompare(right.kind) ||
    left.normalizedPath.localeCompare(right.normalizedPath) ||
    left.entityId.localeCompare(right.entityId)
  );
}

function compareReservationRecords(
  left: WorkspaceEntityReservationRecord,
  right: WorkspaceEntityReservationRecord
): number {
  return left.kind.localeCompare(right.kind) || left.entityId.localeCompare(right.entityId);
}

function validateTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('Workspace entity timestamp must be a non-negative safe integer');
  }
}

export function toWorkspaceHostPathPlatform(
  platform: NodeJS.Platform = process.platform
): WorkspaceHostPathPlatform {
  if (platform === 'darwin' || platform === 'linux' || platform === 'win32') return platform;
  throw new Error(`Unsupported workspace host platform: ${platform}`);
}

export function toWorkspaceHostPathCasePolicy(casePolicy: unknown): WorkspaceHostPathCasePolicy {
  if (casePolicy === 'sensitive' || casePolicy === 'insensitive' || casePolicy === 'exact') {
    return casePolicy;
  }
  return 'exact';
}

export function normalizeWorkspaceEntityPath(
  input: string,
  platform: WorkspaceHostPathPlatform
): NormalizedWorkspaceEntityPath {
  if (!input || input.length > 32_768 || input.includes('\0')) {
    throw new Error('Workspace entity path must contain 1-32768 safe characters');
  }

  const pathApi = platform === 'win32' ? win32 : posix;
  if (!pathApi.isAbsolute(input)) {
    throw new Error('Workspace entity path must be absolute on the host platform');
  }

  let path = pathApi.normalize(input).normalize('NFC');
  const root = pathApi.parse(path).root;
  while (path.length > root.length && (path.endsWith('/') || path.endsWith('\\'))) {
    path = path.slice(0, -1);
  }
  const normalizedPath = path;
  return { path, normalizedPath };
}

function catalogEntities(snapshot: WorkspaceSceneSnapshot): Array<{
  entityId: string;
  kind: WorkspaceEntityKind;
  path: string;
}> {
  const entities: Array<{ entityId: string; kind: WorkspaceEntityKind; path: string }> = [];
  for (const [entityId, repository] of Object.entries(snapshot.catalog.repositories)) {
    if (repository.id !== entityId) {
      throw new Error(`Workspace repository record key does not match ID: ${entityId}`);
    }
    entities.push({ entityId, kind: 'repository', path: repository.path });
  }
  for (const [entityId, worktree] of Object.entries(snapshot.catalog.worktrees)) {
    if (worktree.id !== entityId) {
      throw new Error(`Workspace worktree record key does not match ID: ${entityId}`);
    }
    entities.push({ entityId, kind: 'worktree', path: worktree.path });
  }
  return entities;
}

function aliasKey(alias: Pick<WorkspaceEntityAliasRecord, 'entityId' | 'normalizedPath'>): string {
  return `${alias.entityId}\0${alias.normalizedPath}`;
}

function foldWorkspaceEntityPath(normalizedPath: string): string {
  return normalizedPath.toLocaleLowerCase('en-US').normalize('NFC');
}

export function workspaceEntityPathLookupKey(
  normalizedPath: string,
  casePolicy: WorkspaceHostPathCasePolicy
): string {
  return casePolicy === 'insensitive' ? foldWorkspaceEntityPath(normalizedPath) : normalizedPath;
}

export function workspaceEntityPathCollisionKey(
  normalizedPath: string,
  casePolicy: WorkspaceHostPathCasePolicy
): string {
  return casePolicy === 'sensitive' ? normalizedPath : foldWorkspaceEntityPath(normalizedPath);
}

function workspaceEntityPathsMatch(
  left: string,
  right: string,
  casePolicy: WorkspaceHostPathCasePolicy
): boolean {
  return (
    workspaceEntityPathLookupKey(left, casePolicy) ===
    workspaceEntityPathLookupKey(right, casePolicy)
  );
}

export function syncWorkspaceEntityRegistryState(
  previous: WorkspaceEntityRegistryState,
  snapshot: WorkspaceSceneSnapshot,
  platform: WorkspaceHostPathPlatform,
  casePolicy: WorkspaceHostPathCasePolicy,
  timestamp: number
): WorkspaceEntityRegistryState {
  validateTimestamp(timestamp);
  const existingEntities = new Map(
    previous.entities
      .filter((entity) => entity.sceneId === snapshot.sceneId)
      .map((entity) => [entity.entityId, entity])
  );
  const nextEntities = new Map<string, WorkspaceEntityRecord>();
  const nextAliases = new Map<string, WorkspaceEntityAliasRecord>();
  const nextReservations = new Map(
    previous.reservations
      .filter((reservation) => reservation.sceneId === snapshot.sceneId)
      .map((reservation) => [reservation.entityId, clone(reservation)])
  );

  for (const alias of previous.aliases) {
    if (alias.sceneId !== snapshot.sceneId) continue;
    nextAliases.set(aliasKey(alias), clone(alias));
  }

  const activePathOwners = new Map<string, string>();
  for (const candidate of catalogEntities(snapshot)) {
    const normalized = normalizeWorkspaceEntityPath(candidate.path, platform);
    const existing = existingEntities.get(candidate.entityId);
    const target = nextEntities.get(candidate.entityId);
    if (target && target.kind !== candidate.kind) {
      throw new WorkspaceEntityRegistryError(
        'ENTITY_KIND_CONFLICT',
        `Workspace entity ${candidate.entityId} cannot represent multiple kinds`,
        { entityId: candidate.entityId, kinds: [target.kind, candidate.kind] }
      );
    }
    if (existing && existing.kind !== candidate.kind) {
      throw new WorkspaceEntityRegistryError(
        'ENTITY_KIND_CONFLICT',
        `Workspace entity ${candidate.entityId} cannot change kind`,
        { entityId: candidate.entityId, existingKind: existing.kind, nextKind: candidate.kind }
      );
    }

    const reservation = nextReservations.get(candidate.entityId);
    if (reservation) {
      if (reservation.kind !== candidate.kind) {
        throw new WorkspaceEntityRegistryError(
          'ENTITY_KIND_CONFLICT',
          `Workspace entity ${candidate.entityId} reservation has a different kind`,
          {
            entityId: candidate.entityId,
            reservedKind: reservation.kind,
            committedKind: candidate.kind,
          }
        );
      }
      if (
        !workspaceEntityPathsMatch(
          reservation.normalizedPath,
          normalized.normalizedPath,
          casePolicy
        )
      ) {
        throw new WorkspaceEntityRegistryError(
          'ENTITY_PATH_CONFLICT',
          `Workspace entity ${candidate.entityId} was committed at an unreserved path`,
          {
            entityId: candidate.entityId,
            reservedPath: reservation.path,
            committedPath: normalized.path,
          }
        );
      }
    }
    const reservationPathOwner = [...nextReservations.values()].find(
      (candidateReservation) =>
        candidateReservation.entityId !== candidate.entityId &&
        candidateReservation.kind === candidate.kind &&
        workspaceEntityPathCollisionKey(candidateReservation.normalizedPath, casePolicy) ===
          workspaceEntityPathCollisionKey(normalized.normalizedPath, casePolicy)
    );
    if (reservationPathOwner) {
      throw new WorkspaceEntityRegistryError(
        'ENTITY_PATH_CONFLICT',
        `Workspace ${candidate.kind} path is reserved by another entity`,
        {
          path: normalized.path,
          entityIds: [reservationPathOwner.entityId, candidate.entityId].sort(),
        }
      );
    }

    const pathKey = `${candidate.kind}\0${workspaceEntityPathCollisionKey(
      normalized.normalizedPath,
      casePolicy
    )}`;
    const pathOwner = activePathOwners.get(pathKey);
    if (pathOwner && pathOwner !== candidate.entityId) {
      throw new WorkspaceEntityRegistryError(
        'ENTITY_PATH_CONFLICT',
        `Workspace ${candidate.kind} path is already active`,
        {
          path: normalized.path,
          entityIds: [pathOwner, candidate.entityId].sort(),
        }
      );
    }
    activePathOwners.set(pathKey, candidate.entityId);

    const pathChanged =
      existing !== undefined &&
      (existing.currentPath !== normalized.path ||
        existing.normalizedPath !== normalized.normalizedPath);
    if (existing) {
      const oldAlias: WorkspaceEntityAliasRecord = {
        sceneId: snapshot.sceneId,
        entityId: existing.entityId,
        kind: existing.kind,
        path: existing.currentPath,
        normalizedPath: existing.normalizedPath,
        createdAt: existing.createdAt,
        lastSeenAt: pathChanged ? timestamp : existing.updatedAt,
      };
      const priorAlias = nextAliases.get(aliasKey(oldAlias));
      nextAliases.set(aliasKey(oldAlias), {
        ...(priorAlias ?? oldAlias),
        lastSeenAt: pathChanged ? timestamp : (priorAlias?.lastSeenAt ?? oldAlias.lastSeenAt),
      });
    }

    const changed = !existing || existing.status !== 'active' || pathChanged;
    const entity: WorkspaceEntityRecord = {
      sceneId: snapshot.sceneId,
      entityId: candidate.entityId,
      kind: candidate.kind,
      currentPath: normalized.path,
      normalizedPath: normalized.normalizedPath,
      status: 'active',
      createdAt: existing?.createdAt ?? reservation?.createdAt ?? timestamp,
      updatedAt: changed ? timestamp : (existing?.updatedAt ?? timestamp),
    };
    nextEntities.set(entity.entityId, entity);
    nextReservations.delete(entity.entityId);

    const currentAliasKey = aliasKey(entity);
    const currentAlias = nextAliases.get(currentAliasKey);
    nextAliases.set(currentAliasKey, {
      sceneId: snapshot.sceneId,
      entityId: entity.entityId,
      kind: entity.kind,
      path: entity.currentPath,
      normalizedPath: entity.normalizedPath,
      createdAt: currentAlias?.createdAt ?? timestamp,
      lastSeenAt: changed ? timestamp : (currentAlias?.lastSeenAt ?? timestamp),
    });
  }

  for (const existing of previous.entities) {
    if (existing.sceneId !== snapshot.sceneId || nextEntities.has(existing.entityId)) continue;
    nextEntities.set(existing.entityId, {
      ...clone(existing),
      status: 'retired',
      updatedAt: existing.status === 'active' ? timestamp : existing.updatedAt,
    });
    const currentAliasKey = aliasKey(existing);
    nextAliases.set(
      currentAliasKey,
      nextAliases.get(currentAliasKey) ?? {
        sceneId: existing.sceneId,
        entityId: existing.entityId,
        kind: existing.kind,
        path: existing.currentPath,
        normalizedPath: existing.normalizedPath,
        createdAt: existing.createdAt,
        lastSeenAt: existing.updatedAt,
      }
    );
  }

  return {
    entities: [...nextEntities.values()].sort(compareEntityRecords),
    aliases: [...nextAliases.values()].sort(compareAliasRecords),
    reservations: [...nextReservations.values()].sort(compareReservationRecords),
  };
}

export function addWorkspaceEntityReservationToState(
  previous: WorkspaceEntityRegistryState,
  reservation: WorkspaceEntityReservationRecord,
  platform: WorkspaceHostPathPlatform,
  casePolicy: WorkspaceHostPathCasePolicy
): WorkspaceEntityRegistryState {
  validateTimestamp(reservation.createdAt);
  validateTimestamp(reservation.updatedAt);
  if (
    !reservation.sceneId ||
    reservation.sceneId.length > 256 ||
    !reservation.entityId ||
    reservation.entityId.length > 256
  ) {
    throw new Error('Workspace entity reservation identity must contain 1-256 characters');
  }
  const normalized = normalizeWorkspaceEntityPath(reservation.path, platform);
  if (
    normalized.path !== reservation.path ||
    normalized.normalizedPath !== reservation.normalizedPath
  ) {
    throw new Error('Workspace entity reservation path is not normalized');
  }

  const existingReservation = previous.reservations.find(
    (candidate) =>
      candidate.sceneId === reservation.sceneId && candidate.entityId === reservation.entityId
  );
  if (existingReservation) {
    if (
      existingReservation.kind !== reservation.kind ||
      existingReservation.normalizedPath !== reservation.normalizedPath ||
      existingReservation.disposition !== reservation.disposition ||
      existingReservation.createdAt !== reservation.createdAt
    ) {
      throw new WorkspaceEntityRegistryError(
        'ENTITY_PATH_CONFLICT',
        `Workspace entity ${reservation.entityId} already has a different reservation`,
        { entityId: reservation.entityId }
      );
    }
    return clone(previous);
  }

  const existingEntity = previous.entities.find(
    (candidate) =>
      candidate.sceneId === reservation.sceneId && candidate.entityId === reservation.entityId
  );
  if (existingEntity?.kind !== undefined && existingEntity.kind !== reservation.kind) {
    throw new WorkspaceEntityRegistryError(
      'ENTITY_KIND_CONFLICT',
      `Workspace entity ${reservation.entityId} has kind ${existingEntity.kind}`,
      {
        entityId: reservation.entityId,
        existingKind: existingEntity.kind,
        requestedKind: reservation.kind,
      }
    );
  }
  if (reservation.disposition === 'new' && existingEntity) {
    throw new WorkspaceEntityRegistryError(
      'ENTITY_PATH_CONFLICT',
      `Workspace entity ${reservation.entityId} is already durable`,
      { entityId: reservation.entityId }
    );
  }

  const collisionKey = workspaceEntityPathCollisionKey(reservation.normalizedPath, casePolicy);
  const conflictingEntity = previous.entities.find(
    (candidate) =>
      candidate.sceneId === reservation.sceneId &&
      candidate.entityId !== reservation.entityId &&
      candidate.kind === reservation.kind &&
      candidate.status === 'active' &&
      workspaceEntityPathCollisionKey(candidate.normalizedPath, casePolicy) === collisionKey
  );
  const conflictingReservation = previous.reservations.find(
    (candidate) =>
      candidate.sceneId === reservation.sceneId &&
      candidate.entityId !== reservation.entityId &&
      candidate.kind === reservation.kind &&
      workspaceEntityPathCollisionKey(candidate.normalizedPath, casePolicy) === collisionKey
  );
  const conflictingAliasIds = [
    ...new Set(
      previous.aliases
        .filter(
          (candidate) =>
            candidate.sceneId === reservation.sceneId &&
            candidate.entityId !== reservation.entityId &&
            candidate.kind === reservation.kind &&
            workspaceEntityPathCollisionKey(candidate.normalizedPath, casePolicy) === collisionKey
        )
        .map(({ entityId }) => entityId)
    ),
  ];
  const conflictingEntityIds = [
    ...(conflictingEntity ? [conflictingEntity.entityId] : []),
    ...(conflictingReservation ? [conflictingReservation.entityId] : []),
    ...conflictingAliasIds,
  ].sort();
  if (conflictingEntityIds.length > 0) {
    throw new WorkspaceEntityRegistryError(
      'ENTITY_PATH_CONFLICT',
      `Workspace ${reservation.kind} path belongs to another entity`,
      { path: reservation.path, entityIds: conflictingEntityIds }
    );
  }

  return {
    entities: clone(previous.entities),
    aliases: clone(previous.aliases),
    reservations: [...clone(previous.reservations), clone(reservation)].sort(
      compareReservationRecords
    ),
  };
}

export interface WorkspaceEntityRegistryOptions {
  generateId?: () => string;
  now?: () => number;
}

export class WorkspaceEntityRegistry {
  private readonly generateId: () => string;
  private readonly now: () => number;

  constructor(
    private readonly repository: WorkspaceStateRepository,
    private readonly sceneId: string,
    options: WorkspaceEntityRegistryOptions = {}
  ) {
    this.generateId = options.generateId ?? randomUUID;
    this.now = options.now ?? Date.now;
  }

  async resolveEntity(
    kind: WorkspaceEntityKind,
    inputPath: string
  ): Promise<WorkspaceEntityResolution> {
    const normalized = normalizeWorkspaceEntityPath(inputPath, this.repository.entityPathPlatform);
    const state = await this.loadState();
    const lookupKey = workspaceEntityPathLookupKey(
      normalized.normalizedPath,
      this.repository.entityPathCasePolicy
    );
    const current = state.entities.filter(
      (entity) =>
        entity.kind === kind &&
        entity.status === 'active' &&
        workspaceEntityPathLookupKey(
          entity.normalizedPath,
          this.repository.entityPathCasePolicy
        ) === lookupKey
    );
    if (current.length === 1) {
      return this.resolvedFromRecord(state, current[0], normalized.normalizedPath, 'current');
    }
    if (current.length > 1) {
      return {
        status: 'ambiguous',
        sceneId: this.sceneId,
        kind,
        path: normalized.path,
        normalizedPath: normalized.normalizedPath,
        entityIds: current.map(({ entityId }) => entityId).sort(),
      };
    }

    const reservations = state.reservations.filter(
      (reservation) =>
        reservation.kind === kind &&
        workspaceEntityPathLookupKey(
          reservation.normalizedPath,
          this.repository.entityPathCasePolicy
        ) === lookupKey
    );
    if (reservations.length === 1) {
      const reservation = reservations[0];
      return {
        status: 'resolved',
        sceneId: this.sceneId,
        entityId: reservation.entityId,
        kind,
        currentPath: reservation.path,
        normalizedPath: normalized.normalizedPath,
        aliases: [],
        entityStatus: 'active',
        match: 'reservation',
        durable: true,
      };
    }
    if (reservations.length > 1) {
      return {
        status: 'ambiguous',
        sceneId: this.sceneId,
        kind,
        path: normalized.path,
        normalizedPath: normalized.normalizedPath,
        entityIds: reservations.map(({ entityId }) => entityId).sort(),
      };
    }

    const aliasEntityIds = [
      ...new Set(
        state.aliases
          .filter(
            (alias) =>
              alias.kind === kind &&
              workspaceEntityPathLookupKey(
                alias.normalizedPath,
                this.repository.entityPathCasePolicy
              ) === lookupKey
          )
          .map((alias) => alias.entityId)
      ),
    ].sort();
    if (aliasEntityIds.length === 1) {
      const entity = state.entities.find(({ entityId }) => entityId === aliasEntityIds[0]);
      if (entity) {
        return this.resolvedFromRecord(state, entity, normalized.normalizedPath, 'alias');
      }
    }
    if (aliasEntityIds.length > 1) {
      return {
        status: 'ambiguous',
        sceneId: this.sceneId,
        kind,
        path: normalized.path,
        normalizedPath: normalized.normalizedPath,
        entityIds: aliasEntityIds,
      };
    }
    return {
      status: 'unresolved',
      sceneId: this.sceneId,
      kind,
      path: normalized.path,
      normalizedPath: normalized.normalizedPath,
    };
  }

  async resolveEntities(
    requests: ReadonlyArray<{ kind: WorkspaceEntityKind; path: string }>
  ): Promise<WorkspaceEntityResolution[]> {
    return Promise.all(requests.map(({ kind, path }) => this.resolveEntity(kind, path)));
  }

  async listEntityPaths(entityId: string): Promise<string[]> {
    const state = await this.loadState();
    const entity = state.entities.find((candidate) => candidate.entityId === entityId);
    if (!entity) return [];
    return [
      ...new Set([
        entity.currentPath,
        ...state.aliases.filter((alias) => alias.entityId === entityId).map((alias) => alias.path),
      ]),
    ].sort();
  }

  async reserveEntity(
    kind: WorkspaceEntityKind,
    inputPath: string
  ): Promise<WorkspaceEntityReservation> {
    const resolution = await this.resolveEntity(kind, inputPath);
    if (resolution.status === 'ambiguous') {
      throw new WorkspaceEntityRegistryError(
        'ENTITY_ADOPTION_CONFLICT',
        `Workspace ${kind} path matches multiple historical entities`,
        { path: resolution.path, entityIds: resolution.entityIds }
      );
    }
    if (resolution.status === 'resolved') {
      if (resolution.match === 'reservation') {
        const state = await this.loadState();
        const reservation = state.reservations.find(
          (candidate) => candidate.entityId === resolution.entityId
        );
        if (!reservation) throw new Error('Workspace entity reservation disappeared');
        return this.publicReservation(reservation);
      }
      if (resolution.match !== 'current') {
        throw new WorkspaceEntityRegistryError(
          'ENTITY_ADOPTION_REQUIRED',
          `Workspace ${kind} path is a historical alias and requires explicit adoption`,
          { path: resolution.currentPath, entityId: resolution.entityId }
        );
      }
      return {
        sceneId: this.sceneId,
        entityId: resolution.entityId,
        kind,
        path: resolution.currentPath,
        normalizedPath: resolution.normalizedPath,
        disposition: 'existing',
      };
    }

    const state = await this.loadState();
    let entityId = '';
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const candidate = this.generateId();
      if (
        UUID_V4_PATTERN.test(candidate) &&
        !state.reservations.some((reservation) => reservation.entityId === candidate) &&
        !state.entities.some((entity) => entity.entityId === candidate)
      ) {
        entityId = candidate;
        break;
      }
    }
    if (!entityId) throw new Error('Unable to allocate a unique workspace entity ID');

    const timestamp = this.now();
    const reservation: WorkspaceEntityReservationRecord = {
      sceneId: this.sceneId,
      entityId,
      kind,
      path: resolution.path,
      normalizedPath: resolution.normalizedPath,
      disposition: 'new',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.repository.saveEntityReservation(reservation);
    return this.publicReservation(reservation);
  }

  registerEntity(
    kind: WorkspaceEntityKind,
    inputPath: string
  ): Promise<WorkspaceEntityReservation> {
    return this.reserveEntity(kind, inputPath);
  }

  async restoreReservation(
    kind: WorkspaceEntityKind,
    entityId: string,
    inputPath: string
  ): Promise<WorkspaceEntityReservation> {
    if (!UUID_V4_PATTERN.test(entityId)) {
      throw new WorkspaceEntityRegistryError(
        'ENTITY_NOT_FOUND',
        'Only a previously allocated UUID can restore a workspace reservation',
        { entityId }
      );
    }
    const normalized = normalizeWorkspaceEntityPath(inputPath, this.repository.entityPathPlatform);
    const state = await this.loadState();
    const durable = state.entities.find((candidate) => candidate.entityId === entityId);
    if (durable) return this.adoptEntity(kind, entityId, normalized.path);

    const reservation = state.reservations.find((candidate) => candidate.entityId === entityId);
    if (reservation) {
      if (reservation.kind !== kind || reservation.normalizedPath !== normalized.normalizedPath) {
        throw new WorkspaceEntityRegistryError(
          'ENTITY_PATH_CONFLICT',
          `Workspace entity ${entityId} already has a different reservation`,
          { entityId }
        );
      }
      return this.publicReservation(reservation);
    }

    const resolution = await this.resolveEntity(kind, normalized.path);
    if (resolution.status === 'ambiguous') {
      throw new WorkspaceEntityRegistryError(
        'ENTITY_ADOPTION_CONFLICT',
        `Workspace ${kind} path matches multiple historical entities`,
        { path: normalized.path, entityIds: resolution.entityIds }
      );
    }
    if (resolution.status === 'resolved') {
      throw new WorkspaceEntityRegistryError(
        'ENTITY_PATH_CONFLICT',
        `Workspace ${kind} path belongs to another entity`,
        { path: normalized.path, entityId: resolution.entityId }
      );
    }

    const timestamp = this.now();
    const restored: WorkspaceEntityReservationRecord = {
      sceneId: this.sceneId,
      entityId,
      kind,
      path: normalized.path,
      normalizedPath: normalized.normalizedPath,
      disposition: 'new',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.repository.saveEntityReservation(restored);
    return this.publicReservation(restored);
  }

  async adoptEntity(
    kind: WorkspaceEntityKind,
    entityId: string,
    inputPath: string
  ): Promise<WorkspaceEntityReservation> {
    const normalized = normalizeWorkspaceEntityPath(inputPath, this.repository.entityPathPlatform);
    const state = await this.loadState();
    const entity = state.entities.find((candidate) => candidate.entityId === entityId);
    const existingReservation = state.reservations.find(
      (candidate) => candidate.entityId === entityId
    );
    if (!entity && !existingReservation) {
      throw new WorkspaceEntityRegistryError(
        'ENTITY_NOT_FOUND',
        `Workspace entity does not exist: ${entityId}`,
        { entityId }
      );
    }
    const existingKind = entity?.kind ?? existingReservation?.kind;
    if (existingKind !== kind) {
      throw new WorkspaceEntityRegistryError(
        'ENTITY_KIND_CONFLICT',
        `Workspace entity ${entityId} has kind ${existingKind}`,
        { entityId, existingKind, requestedKind: kind }
      );
    }

    const collisionKey = workspaceEntityPathCollisionKey(
      normalized.normalizedPath,
      this.repository.entityPathCasePolicy
    );
    const conflictingEntityIds = [
      ...new Set([
        ...state.entities
          .filter(
            (candidate) =>
              candidate.entityId !== entityId &&
              candidate.kind === kind &&
              candidate.status === 'active' &&
              workspaceEntityPathCollisionKey(
                candidate.normalizedPath,
                this.repository.entityPathCasePolicy
              ) === collisionKey
          )
          .map(({ entityId: candidateId }) => candidateId),
        ...state.reservations
          .filter(
            (candidate) =>
              candidate.entityId !== entityId &&
              candidate.kind === kind &&
              workspaceEntityPathCollisionKey(
                candidate.normalizedPath,
                this.repository.entityPathCasePolicy
              ) === collisionKey
          )
          .map(({ entityId: candidateId }) => candidateId),
        ...state.aliases
          .filter(
            (candidate) =>
              candidate.entityId !== entityId &&
              candidate.kind === kind &&
              workspaceEntityPathCollisionKey(
                candidate.normalizedPath,
                this.repository.entityPathCasePolicy
              ) === collisionKey
          )
          .map(({ entityId: candidateId }) => candidateId),
      ]),
    ].sort();
    if (conflictingEntityIds.length > 0) {
      throw new WorkspaceEntityRegistryError(
        'ENTITY_ADOPTION_CONFLICT',
        `Workspace ${kind} path belongs to another entity`,
        { path: normalized.path, entityId, conflictingEntityIds }
      );
    }

    const resolution = await this.resolveEntity(kind, normalized.path);
    if (
      resolution.status === 'ambiguous' ||
      (resolution.status === 'resolved' && resolution.entityId !== entityId)
    ) {
      throw new WorkspaceEntityRegistryError(
        'ENTITY_ADOPTION_CONFLICT',
        `Workspace ${kind} path belongs to another entity`,
        {
          path: normalized.path,
          entityId,
          conflictingEntityIds:
            resolution.status === 'ambiguous' ? resolution.entityIds : [resolution.entityId],
        }
      );
    }
    if (resolution.status === 'resolved' && resolution.entityId === entityId) {
      if (resolution.durable && resolution.match === 'current') {
        return {
          sceneId: this.sceneId,
          entityId,
          kind,
          path: normalized.path,
          normalizedPath: normalized.normalizedPath,
          disposition: 'existing',
        };
      }
      if (resolution.match === 'reservation') {
        if (existingReservation) return this.publicReservation(existingReservation);
      }
    }

    if (existingReservation && existingReservation.normalizedPath !== normalized.normalizedPath) {
      throw new WorkspaceEntityRegistryError(
        'ENTITY_PATH_CONFLICT',
        `Workspace entity ${entityId} already has a pending path`,
        { entityId, pendingPath: existingReservation.path, requestedPath: normalized.path }
      );
    }

    const timestamp = this.now();
    const reservation: WorkspaceEntityReservationRecord = {
      sceneId: this.sceneId,
      entityId,
      kind,
      path: normalized.path,
      normalizedPath: normalized.normalizedPath,
      disposition: 'adopted',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.repository.saveEntityReservation(reservation);
    return this.publicReservation(reservation);
  }

  renameEntity(
    kind: WorkspaceEntityKind,
    entityId: string,
    nextPath: string
  ): Promise<WorkspaceEntityReservation> {
    return this.adoptEntity(kind, entityId, nextPath);
  }

  discardReservation(entityId: string): Promise<void> {
    return this.repository.deleteEntityReservation(this.sceneId, entityId);
  }

  private async loadState(): Promise<WorkspaceEntityRegistryState> {
    return this.repository.loadEntityRegistry(this.sceneId);
  }

  private resolvedFromRecord(
    state: WorkspaceEntityRegistryState,
    entity: WorkspaceEntityRecord,
    normalizedPath: string,
    match: 'current' | 'alias'
  ): WorkspaceEntityResolution {
    return {
      status: 'resolved',
      sceneId: this.sceneId,
      entityId: entity.entityId,
      kind: entity.kind,
      currentPath: entity.currentPath,
      normalizedPath,
      aliases: state.aliases
        .filter((alias) => alias.entityId === entity.entityId)
        .map((alias) => alias.path)
        .sort(),
      entityStatus: entity.status,
      match,
      durable: true,
    };
  }

  private publicReservation(
    reservation: WorkspaceEntityReservationRecord
  ): WorkspaceEntityReservation {
    return {
      sceneId: reservation.sceneId,
      entityId: reservation.entityId,
      kind: reservation.kind,
      path: reservation.path,
      normalizedPath: reservation.normalizedPath,
      disposition: reservation.disposition,
    };
  }
}
