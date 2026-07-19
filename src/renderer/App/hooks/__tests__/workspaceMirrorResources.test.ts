import { createEmptyWorkspaceSceneSnapshot } from '@shared/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAgentSessionsStore } from '@/stores/agentSessions';
import { loadSnapshot as loadAgentTaskSnapshot, useAgentTasksStore } from '@/stores/agentTasks';
import {
  buildAgents,
  buildNavigation,
  buildWorkspaceCatalog,
  stageAndMaterializeWorkspaceResources,
  unwrapWorkspaceEntityAdoptionResult,
  WorkspaceEntityAdoptionConflictError,
  workspaceInvalidationQueryKey,
} from '../useWorkspaceMirrorBridge';

beforeEach(() => {
  vi.stubGlobal('localStorage', {
    getItem: () => null,
    setItem: vi.fn(),
    removeItem: vi.fn(),
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('workspace mirror Agent resources', () => {
  it('replaces client-local temp paths with materialized opaque references', async () => {
    const stageResource = vi
      .fn()
      .mockResolvedValueOnce({
        id: 'resource-1',
        displayName: 'one.png',
        mime: 'image/png',
        size: 10,
        checksum: 'a'.repeat(64),
      })
      .mockResolvedValueOnce({
        id: 'resource-2',
        displayName: 'two.png',
        mime: 'image/png',
        size: 20,
        checksum: 'b'.repeat(64),
      });
    const materializeResource = vi
      .fn()
      .mockResolvedValueOnce('enso-resource://resource-1')
      .mockResolvedValueOnce('enso-resource://resource-2');

    const result = await stageAndMaterializeWorkspaceResources(
      ['/client/tmp/one.png', '/client/tmp/two.png'],
      { stageResource, materializeResource }
    );

    expect(stageResource.mock.calls).toEqual([['/client/tmp/one.png'], ['/client/tmp/two.png']]);
    expect(materializeResource.mock.calls).toEqual([['resource-1'], ['resource-2']]);
    expect(result.paths).toEqual(['enso-resource://resource-1', 'enso-resource://resource-2']);
    expect(result.paths).not.toContain('/client/tmp/one.png');
  });
});

describe('workspace mirror resource invalidation', () => {
  it('maps versioned resource domains to derived query families', () => {
    expect(workspaceInvalidationQueryKey('file-tree')).toEqual(['file', 'list']);
    expect(workspaceInvalidationQueryKey('git-status')).toEqual(['git']);
    expect(workspaceInvalidationQueryKey('diff')).toEqual(['git']);
    expect(workspaceInvalidationQueryKey('search')).toEqual(['search']);
  });
});

describe('workspace mirror entity adoption', () => {
  it('unwraps success and preserves typed conflict metadata', () => {
    const reservation = {
      sceneId: 'scene-1',
      entityId: 'entity-1',
      kind: 'repository' as const,
      path: '/host/repository',
      normalizedPath: '/host/repository',
      disposition: 'adopted' as const,
    };
    expect(unwrapWorkspaceEntityAdoptionResult({ ok: true, reservation })).toEqual(reservation);

    let thrown: unknown;
    try {
      unwrapWorkspaceEntityAdoptionResult({
        ok: false,
        error: {
          code: 'ENTITY_ADOPTION_CONFLICT',
          message: 'Workspace path belongs to another entity',
          conflictingEntityIds: ['entity-2'],
        },
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WorkspaceEntityAdoptionConflictError);
    expect(thrown).toMatchObject({
      code: 'ENTITY_ADOPTION_CONFLICT',
      message: 'Workspace path belongs to another entity',
      conflictingEntityIds: ['entity-2'],
    });
  });
});

describe('workspace mirror atomic catalog navigation', () => {
  it('uses resolved opaque IDs and preserves them when host paths change', () => {
    const previous = createEmptyWorkspaceSceneSnapshot({
      hostId: 'host',
      sceneId: 'scene',
      hostEpoch: '11111111-1111-4111-8111-111111111111',
    }).catalog;
    const catalog = buildWorkspaceCatalog(
      [{ id: 'repository-stable', name: 'repo', path: '/renamed/repo' }],
      [],
      [
        {
          id: 'worktree-stable',
          path: '/renamed/repo/worktree',
          head: 'abc',
          branch: 'main',
          isMainWorktree: false,
          isLocked: false,
          prunable: false,
        },
      ],
      '/renamed/repo',
      {},
      previous
    );

    expect(Object.keys(catalog.repositories)).toEqual(['repository-stable']);
    expect(Object.keys(catalog.worktrees)).toEqual(['worktree-stable']);
    expect(catalog.worktrees['worktree-stable']?.repositoryId).toBe('repository-stable');
  });

  it.each([
    ['MacIntel', 'C:\\Host\\Repository', 'C:\\Host\\Repository\\worktree'],
    ['Win32', '/srv/host/repository', '/srv/host/repository/worktree'],
    ['Linux x86_64', 'C:\\Host\\Repository', 'C:\\Host\\Repository\\worktree'],
  ])('keeps host-issued IDs independent of the %s client platform', (platform, repoPath, worktreePath) => {
    vi.stubGlobal('navigator', { platform });
    const previous = createEmptyWorkspaceSceneSnapshot({
      hostId: 'host',
      sceneId: 'scene',
      hostEpoch: '11111111-1111-4111-8111-111111111111',
    }).catalog;
    const catalog = buildWorkspaceCatalog(
      [{ id: 'host-repository-id', name: 'repo', path: repoPath }],
      [],
      [
        {
          id: 'host-worktree-id',
          path: worktreePath,
          head: 'abc',
          branch: 'main',
          isMainWorktree: false,
          isLocked: false,
          prunable: false,
        },
      ],
      repoPath,
      {},
      previous
    );

    expect(Object.keys(catalog.repositories)).toEqual(['host-repository-id']);
    expect(Object.keys(catalog.worktrees)).toEqual(['host-worktree-id']);
    expect(catalog.worktrees['host-worktree-id']?.repositoryId).toBe('host-repository-id');
  });

  it('blocks path-only entities before scene publication', () => {
    const previous = createEmptyWorkspaceSceneSnapshot({
      hostId: 'host',
      sceneId: 'scene',
      hostEpoch: '11111111-1111-4111-8111-111111111111',
    }).catalog;
    expect(() =>
      buildWorkspaceCatalog([{ name: 'repo', path: '/unresolved' }], [], [], null, {}, previous)
    ).toThrow(/identity is unresolved/);
  });

  it('drops selections whose repository, group, or worktree was removed', () => {
    const previous = createEmptyWorkspaceSceneSnapshot({
      hostId: 'host',
      sceneId: 'scene',
      hostEpoch: '11111111-1111-4111-8111-111111111111',
    }).navigation;
    const navigation = buildNavigation(
      {
        repositories: [],
        selectedRepo: '/removed/repo',
        groups: [],
        activeGroupId: 'removed-group',
        setRepositories: vi.fn(),
        saveRepositories: vi.fn(),
        setGroups: vi.fn(),
        setSelectedRepo: vi.fn(),
        setActiveGroupId: vi.fn(),
      },
      {
        worktreeTabMap: {},
        repoWorktreeMap: {},
        worktreeOrderMap: {},
        tabOrder: ['chat'],
        activeTab: 'chat',
        activeWorktree: {
          path: '/removed/repo',
          head: '',
          branch: 'main',
          isMainWorktree: true,
          isLocked: false,
          prunable: false,
        },
        setWorktreeTabMap: vi.fn(),
        setRepoWorktreeMap: vi.fn(),
        setWorktreeOrderMap: vi.fn(),
        setTabOrder: vi.fn(),
        setActiveTab: vi.fn(),
      },
      { groups: {}, repositories: {}, worktrees: {} },
      previous
    );

    expect(navigation).toMatchObject({
      selectedRepositoryId: null,
      activeGroupId: null,
      activeWorktreeId: null,
    });
  });
});

describe('workspace mirror Agent semantic state', () => {
  it('preserves provider resume identity and task waiting state', () => {
    const repositoryPath = '/host/repo';
    const worktreePath = '/host/repo/worktree';
    const repositoryId = 'opaque-repository-id';
    const worktreeId = 'opaque-worktree-id';
    useAgentSessionsStore.setState({
      sessions: [
        {
          id: 'ui-session',
          sessionId: 'provider-resume-session',
          name: 'Review',
          agentId: 'claude',
          agentCommand: 'claude',
          initialized: true,
          activated: true,
          repoPath: repositoryPath,
          cwd: worktreePath,
          environment: 'native',
          displayOrder: 0,
        },
      ],
      activeIds: {},
      groupStates: {},
      runtimeStates: {
        'ui-session': {
          outputState: 'idle',
          lastActivityAt: 1,
          wasActiveWhenOutputting: false,
        },
      },
      enhancedInputStates: {},
    });
    loadAgentTaskSnapshot({
      'ui-session': {
        sessionId: 'ui-session',
        sessionName: 'Review',
        repoPath: repositoryPath,
        repoName: 'repo',
        cwd: worktreePath,
        status: 'waiting',
        description: 'Review the patch',
        startedAt: 10,
        waitingReason: 'Choose an option',
      },
    });

    const agents = buildAgents({
      groups: {},
      repositories: {
        [repositoryId]: {
          id: repositoryId,
          path: repositoryPath,
          name: 'repo',
          groupId: null,
          order: 0,
          settings: { autoInitWorktree: false, initScript: '', hidden: false },
        },
      },
      worktrees: {
        [worktreeId]: {
          id: worktreeId,
          repositoryId,
          path: worktreePath,
          name: 'worktree',
          branch: 'main',
          order: 0,
          isMain: false,
        },
      },
    });

    expect(agents.sessions['ui-session']).toMatchObject({
      providerSessionId: 'provider-resume-session',
      status: 'waiting',
      waitingReason: 'Choose an option',
      task: {
        status: 'waiting',
        description: 'Review the patch',
        waitingReason: 'Choose an option',
      },
    });
    useAgentSessionsStore.setState({ sessions: [] });
    useAgentTasksStore.setState({ tasks: {} });
  });
});
