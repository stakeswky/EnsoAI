import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ControllerLeaseSchema,
  canonicalizeWorkspaceScene,
  canonicalJson,
  createEmptyWorkspaceSceneSnapshot,
  digestWorkspaceScene,
  getWorkspaceSceneDigestPayload,
  isWorkspaceResourceId,
  StateReplayFrameSchema,
  StateSnapshotChunkFrameSchema,
  StreamChunkFrameSchema,
  WorkspaceMirrorErrorSchema,
  WorkspaceMirrorV2FrameSchema,
  WorkspaceSceneEventSchema,
  WorkspaceSceneIntentSchema,
  WorkspaceSceneSnapshotSchema,
  WorkspaceStreamFrameSchema,
  workspaceResourceIdFromUri,
} from '../workspaceMirror';

const HOST_EPOCH = '11111111-1111-4111-8111-111111111111';
const NEXT_HOST_EPOCH = '22222222-2222-4222-8222-222222222222';
const CHECKSUM = 'a'.repeat(64);

function createScene() {
  const empty = createEmptyWorkspaceSceneSnapshot({
    hostId: 'host-1',
    sceneId: 'scene-1',
    hostEpoch: HOST_EPOCH,
  });

  return WorkspaceSceneSnapshotSchema.parse({
    ...empty,
    revision: 7,
    catalog: {
      groups: {
        'group-1': {
          id: 'group-1',
          name: 'Work',
          emoji: '',
          color: '#3b82f6',
          order: 0,
        },
      },
      repositories: {
        'repo-1': {
          id: 'repo-1',
          path: '/srv/enso',
          name: 'enso',
          groupId: 'group-1',
          order: 0,
          settings: {
            autoInitWorktree: true,
            initScript: 'pnpm install',
            hidden: false,
          },
        },
      },
      worktrees: {
        'worktree-1': {
          id: 'worktree-1',
          repositoryId: 'repo-1',
          path: '/srv/enso',
          name: 'main',
          branch: 'main',
          order: 0,
          isMain: true,
        },
      },
    },
    navigation: {
      selectedRepositoryId: 'repo-1',
      activeGroupId: 'group-1',
      activeWorktreeId: 'worktree-1',
      activePrimaryPanel: 'file',
      activePanelByWorktree: { 'worktree-1': 'file' },
      panelOrderByWorktree: {
        'worktree-1': ['chat', 'file', 'terminal', 'source-control', 'todo'],
      },
    },
    editors: {
      'worktree-1': {
        tabs: [
          {
            id: 'tab-1',
            path: '/srv/enso/src/index.ts',
            title: 'index.ts',
            order: 0,
            encoding: 'utf8',
            isUnsupported: false,
          },
        ],
        activeFile: '/srv/enso/src/index.ts',
        buffers: {
          '/srv/enso/src/index.ts': {
            path: '/srv/enso/src/index.ts',
            content: 'export const live = true;\n',
            isDirty: true,
            version: 3,
            hasExternalChange: false,
          },
        },
      },
    },
    agents: {
      sessions: {
        'agent-session-1': {
          id: 'agent-session-1',
          generation: 1,
          agentId: 'codex',
          name: 'Codex',
          repositoryId: 'repo-1',
          worktreeId: 'worktree-1',
          terminalSessionId: 'terminal-1',
          environment: 'native',
          initialized: true,
          activated: true,
          displayOrder: 0,
          runtimeState: 'outputting',
          status: 'running',
          waitingReason: null,
          draft: { text: 'continue from here', resources: [] },
          task: {
            id: 'task-1',
            status: 'running',
            description: 'Mirror workspace',
            waitingReason: null,
            startedAt: 1,
            completedAt: null,
          },
        },
      },
      groups: {},
      activeSessionByWorktree: { 'worktree-1': 'agent-session-1' },
    },
    terminals: {
      sessions: {
        'terminal-1': {
          id: 'terminal-1',
          generation: 1,
          repositoryId: 'repo-1',
          worktreeId: 'worktree-1',
          title: 'pnpm dev',
          cwd: '/srv/enso',
          groupId: null,
          order: 0,
          processState: 'running',
          exitCode: null,
        },
      },
      groups: {},
      activeSessionByWorktree: { 'worktree-1': 'terminal-1' },
      quickSessionByWorktree: {},
    },
    todos: {
      boardsByRepository: {
        'repo-1': {
          tasks: {
            'todo-1': {
              id: 'todo-1',
              title: 'Finish mirror',
              description: '',
              priority: 'high',
              status: 'in-progress',
              createdAt: 1,
              updatedAt: 2,
              order: 0,
              sessionId: 'agent-session-1',
            },
          },
          autoExecution: {
            running: true,
            queue: ['todo-1'],
            currentTaskId: 'todo-1',
            currentSessionId: 'agent-session-1',
          },
        },
      },
    },
    selections: {
      selectedFileByWorktree: { 'worktree-1': '/srv/enso/src/index.ts' },
      selectedDiffByWorktree: { 'worktree-1': '/srv/enso/src/index.ts' },
      selectedTaskByRepository: { 'repo-1': 'todo-1' },
    },
    resources: {
      invalidations: {
        'git-status:repo-1': {
          resourceKey: 'git-status:repo-1',
          domain: 'git-status',
          entityId: 'repo-1',
          generation: 1,
          reason: 'changed',
        },
      },
    },
  });
}

function createNavigationEvent(revision: number) {
  const scene = createScene();
  return WorkspaceSceneEventSchema.parse({
    t: 'state.event',
    hostEpoch: HOST_EPOCH,
    sceneId: scene.sceneId,
    revision,
    origin: {
      source: 'client',
      clientId: 'client-1',
      deviceId: 'device-1',
      operationId: `operation-${revision}`,
    },
    kind: 'navigation.replace',
    payload: { navigation: scene.navigation },
  });
}

describe('workspace mirror scene schema', () => {
  it('creates a valid normalized empty scene', () => {
    const scene = createEmptyWorkspaceSceneSnapshot({
      hostId: 'host-1',
      sceneId: 'scene-1',
      hostEpoch: HOST_EPOCH,
    });

    expect(scene.revision).toBe(0);
    expect(scene.catalog).toEqual({ groups: {}, repositories: {}, worktrees: {} });
    expect(scene.editors).toEqual({});
    expect(WorkspaceSceneSnapshotSchema.parse(scene)).toEqual(scene);
  });

  it('accepts dirty content but permits clean buffers to omit content', () => {
    const scene = createScene();
    const editor = scene.editors['worktree-1'];
    const cleanScene = {
      ...scene,
      editors: {
        'worktree-1': {
          ...editor,
          buffers: {
            '/srv/enso/src/index.ts': {
              path: '/srv/enso/src/index.ts',
              isDirty: false,
              version: 4,
              hasExternalChange: false,
            },
          },
        },
      },
    };

    expect(WorkspaceSceneSnapshotSchema.safeParse(cleanScene).success).toBe(true);

    const missingDirtyContent = {
      ...cleanScene,
      editors: {
        'worktree-1': {
          ...editor,
          buffers: {
            '/srv/enso/src/index.ts': {
              path: '/srv/enso/src/index.ts',
              isDirty: true,
              version: 4,
              hasExternalChange: false,
            },
          },
        },
      },
    };
    expect(WorkspaceSceneSnapshotSchema.safeParse(missingDirtyContent).success).toBe(false);
  });

  it('rejects device-local or privileged fields at every strict boundary', () => {
    const scene = createScene();
    expect(
      WorkspaceSceneSnapshotSchema.safeParse({ ...scene, remoteToken: 'canary-secret' }).success
    ).toBe(false);
    expect(
      WorkspaceSceneSnapshotSchema.safeParse({
        ...scene,
        catalog: {
          ...scene.catalog,
          repositories: {
            ...scene.catalog.repositories,
            'repo-1': {
              ...scene.catalog.repositories['repo-1'],
              providerCredential: 'canary-secret',
            },
          },
        },
      }).success
    ).toBe(false);
    expect(
      WorkspaceSceneSnapshotSchema.safeParse({
        ...scene,
        theme: 'device-local',
        windowBounds: { width: 100, height: 100 },
      }).success
    ).toBe(false);
  });
});

describe('workspace resource opaque URI validation', () => {
  it('accepts generated ids and extracts them without path semantics', () => {
    expect(isWorkspaceResourceId('resource-abc:1._-')).toBe(true);
    expect(workspaceResourceIdFromUri('enso-resource://resource-abc:1._-')).toBe(
      'resource-abc:1._-'
    );
    expect(workspaceResourceIdFromUri('ENSO-RESOURCE://resource-abc')).toBe('resource-abc');
  });

  it('rejects malformed or path-like opaque references', () => {
    expect(workspaceResourceIdFromUri('enso-resource://')).toBeNull();
    expect(workspaceResourceIdFromUri('enso-resource://../../secret')).toBeNull();
    expect(workspaceResourceIdFromUri('enso-resource://resource/id')).toBeNull();
    expect(isWorkspaceResourceId('resource/id')).toBe(false);
  });
});

describe('workspace mirror canonical digest', () => {
  it('sorts object keys while preserving array order', () => {
    expect(canonicalJson({ z: 1, a: { d: 4, b: 2 }, list: ['b', 'a'] })).toBe(
      '{"a":{"b":2,"d":4},"list":["b","a"],"z":1}'
    );
  });

  it('excludes identity and revision metadata but includes live dirty state', async () => {
    const scene = createScene();
    const sameStateAtAnotherRevision = {
      ...scene,
      hostId: 'host-2',
      sceneId: 'scene-2',
      hostEpoch: NEXT_HOST_EPOCH,
      revision: scene.revision + 1,
    };
    const changedDirtyContent = {
      ...scene,
      editors: {
        ...scene.editors,
        'worktree-1': {
          ...scene.editors['worktree-1'],
          buffers: {
            ...scene.editors['worktree-1'].buffers,
            '/srv/enso/src/index.ts': {
              ...scene.editors['worktree-1'].buffers['/srv/enso/src/index.ts'],
              content: 'export const live = false;\n',
            },
          },
        },
      },
    };

    expect(canonicalizeWorkspaceScene(sameStateAtAnotherRevision)).toBe(
      canonicalizeWorkspaceScene(scene)
    );
    expect(await digestWorkspaceScene(sameStateAtAnotherRevision)).toBe(
      await digestWorkspaceScene(scene)
    );
    expect(await digestWorkspaceScene(changedDirtyContent)).not.toBe(
      await digestWorkspaceScene(scene)
    );

    const expected = createHash('sha256').update(canonicalizeWorkspaceScene(scene)).digest('hex');
    expect(await digestWorkspaceScene(scene)).toBe(expected);
    expect(getWorkspaceSceneDigestPayload(scene)).not.toHaveProperty('revision');
    expect(getWorkspaceSceneDigestPayload(scene)).not.toHaveProperty('hostEpoch');
  });

  it('rejects unsupported values and cycles instead of producing ambiguous JSON', () => {
    expect(() => canonicalJson({ value: Number.NaN })).toThrow(/non-finite/);
    expect(() => canonicalJson({ value: undefined })).toThrow(/undefined/);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => canonicalJson(cyclic)).toThrow(/cycle/);
  });
});

describe('workspace mirror intent and event schemas', () => {
  it('round-trips a typed intent through the complete V2 frame schema', () => {
    const scene = createScene();
    const intent = {
      t: 'state.intent',
      operationId: 'operation-8',
      clientSeq: 8,
      baseRevision: 7,
      kind: 'navigation.replace',
      payload: { navigation: scene.navigation },
    } as const;

    expect(WorkspaceSceneIntentSchema.parse(intent)).toEqual(intent);
    expect(WorkspaceMirrorV2FrameSchema.parse(intent)).toEqual(intent);
  });

  it('rejects stale-shaped editor updates before they reach a reducer', () => {
    const invalidUpdate = {
      t: 'state.intent',
      operationId: 'operation-8',
      clientSeq: 8,
      baseRevision: 7,
      kind: 'editor.buffer.update',
      payload: {
        worktreeId: 'worktree-1',
        path: '/srv/enso/src/index.ts',
        baseVersion: 3,
        nextVersion: 5,
        content: 'invalid jump',
        isDirty: true,
        hasExternalChange: false,
      },
    };

    expect(WorkspaceSceneIntentSchema.safeParse(invalidUpdate).success).toBe(false);
    expect(
      WorkspaceSceneIntentSchema.safeParse({
        ...invalidUpdate,
        baseRevision: -1,
        payload: { ...invalidUpdate.payload, nextVersion: 4 },
      }).success
    ).toBe(false);
  });

  it('validates contiguous replay ranges and scene identity', () => {
    const validReplay = {
      t: 'state.replay',
      hostEpoch: HOST_EPOCH,
      sceneId: 'scene-1',
      fromRevision: 8,
      toRevision: 9,
      events: [createNavigationEvent(8), createNavigationEvent(9)],
    } as const;

    expect(StateReplayFrameSchema.safeParse(validReplay).success).toBe(true);
    expect(
      StateReplayFrameSchema.safeParse({
        ...validReplay,
        events: [createNavigationEvent(8), createNavigationEvent(10)],
      }).success
    ).toBe(false);
    expect(
      StateReplayFrameSchema.safeParse({
        ...validReplay,
        hostEpoch: NEXT_HOST_EPOCH,
      }).success
    ).toBe(false);
  });
});

describe('workspace mirror transport plane schemas', () => {
  it('rejects malformed snapshot chunks', () => {
    const validChunk = {
      t: 'state.snapshot.chunk',
      snapshotId: 'snapshot-1',
      index: 0,
      data: 'c25hcHNob3Q=',
      checksum: CHECKSUM,
    } as const;

    expect(StateSnapshotChunkFrameSchema.parse(validChunk)).toEqual(validChunk);
    expect(StateSnapshotChunkFrameSchema.safeParse({ ...validChunk, index: -1 }).success).toBe(
      false
    );
    expect(
      StateSnapshotChunkFrameSchema.safeParse({ ...validChunk, checksum: 'not-a-checksum' }).success
    ).toBe(false);
    expect(StateSnapshotChunkFrameSchema.safeParse({ ...validChunk, data: '***' }).success).toBe(
      false
    );
  });

  it('keeps controller and stream ordering separate from scene revisions', () => {
    const lease = ControllerLeaseSchema.parse({
      leaseId: 'lease-1',
      holderDeviceId: 'device-1',
      holderClientId: 'client-1',
      acquiredAt: 10,
      expiresAt: 20,
      graceUntil: null,
      coordSeq: 3,
    });
    const stream = StreamChunkFrameSchema.parse({
      t: 'stream.chunk',
      streamId: 'stream-1',
      streamKind: 'terminal',
      entityId: 'terminal-1',
      entityGeneration: 1,
      sceneRevision: 7,
      streamSeq: 99,
      encoding: 'utf8',
      data: 'hello',
    });

    expect(lease.coordSeq).toBe(3);
    expect(stream.streamSeq).toBe(99);
    expect(stream.sceneRevision).toBe(7);
    expect(WorkspaceStreamFrameSchema.safeParse({ ...stream, streamSeq: -1 }).success).toBe(false);
  });

  it('fails closed on stack traces and untyped error details', () => {
    const validError = {
      code: 'CONFLICT',
      message: 'The scene changed',
      retryable: true,
      details: { expectedRevision: 6, actualRevision: 7 },
    } as const;

    expect(WorkspaceMirrorErrorSchema.parse(validError)).toEqual(validError);
    expect(
      WorkspaceMirrorErrorSchema.safeParse({
        ...validError,
        stack: 'canary-secret',
      }).success
    ).toBe(false);
    expect(
      WorkspaceMirrorErrorSchema.safeParse({
        ...validError,
        details: { ...validError.details, token: 'canary-secret' },
      }).success
    ).toBe(false);
  });
});
