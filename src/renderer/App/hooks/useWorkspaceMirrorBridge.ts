import {
  canonicalJson,
  type EditorScene,
  type GitWorktree,
  type NavigationScene,
  type TerminalScene,
  type TodoScene,
  type WorkspaceCatalogScene,
  type WorkspaceEntityAdoptionResult,
  type WorkspaceEntityReservation,
  type WorkspacePanelId,
  type WorkspaceResourceInvalidation,
  type WorkspaceSceneMutation,
  WorkspaceSceneMutationSchema,
  type WorkspaceSceneSnapshot,
} from '@shared/types';
import { joinPath, normalizePath as normalizeHostPath } from '@shared/utils/path';
import { useQueryClient } from '@tanstack/react-query';
import type { Dispatch, SetStateAction } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { Session } from '@/components/chat/SessionBar';
import type { AgentGroupState } from '@/components/chat/types';
import type { TodoTask } from '@/components/todo/types';
import { useAgentSessionsStore } from '@/stores/agentSessions';
import { loadSnapshot as loadAgentTaskSnapshot, useAgentTasksStore } from '@/stores/agentTasks';
import { type EditorTab, useEditorStore } from '@/stores/editor';
import { useRemoteStore } from '@/stores/remote';
import { useSourceControlStore } from '@/stores/sourceControl';
import { type TerminalWorktreeGroupStates, useTerminalStore } from '@/stores/terminal';
import { getTodoStoreKey, migrateTodoLocalStorage, useTodoStore } from '@/stores/todo';
import { useWorkspaceMirrorStore } from '@/stores/workspaceMirror';
import { useWorktreeStore } from '@/stores/worktree';
import { ALL_GROUP_ID, type Repository, type RepositoryGroup, type TabId } from '../constants';
import {
  getRepositorySettings,
  getRepositorySettingsRevision,
  normalizePath,
  projectRepositorySettings,
  subscribeRepositorySettings,
} from '../storage';

export interface RepositoryBridgeState {
  repositories: Repository[];
  selectedRepo: string | null;
  groups: RepositoryGroup[];
  activeGroupId: string;
  setRepositories: Dispatch<SetStateAction<Repository[]>>;
  saveRepositories: (repositories: Repository[]) => void;
  setGroups: Dispatch<SetStateAction<RepositoryGroup[]>>;
  setSelectedRepo: Dispatch<SetStateAction<string | null>>;
  setActiveGroupId: Dispatch<SetStateAction<string>>;
}

export interface WorktreeBridgeState {
  worktreeTabMap: Record<string, TabId>;
  repoWorktreeMap: Record<string, string>;
  worktreeOrderMap: Record<string, Record<string, number>>;
  tabOrder: TabId[];
  activeTab: TabId;
  activeWorktree: GitWorktree | null;
  setWorktreeTabMap: Dispatch<SetStateAction<Record<string, TabId>>>;
  setRepoWorktreeMap: Dispatch<SetStateAction<Record<string, string>>>;
  setWorktreeOrderMap: Dispatch<SetStateAction<Record<string, Record<string, number>>>>;
  setTabOrder: Dispatch<SetStateAction<TabId[]>>;
  setActiveTab: Dispatch<SetStateAction<TabId>>;
}

type EditorStoreState = ReturnType<typeof useEditorStore.getState>;

export interface EditorDeviceOverlay {
  viewStates: Record<string, Record<string, unknown>>;
  pendingCursor: EditorStoreState['pendingCursor'];
  currentCursorLine: EditorStoreState['currentCursorLine'];
  navBackStack: EditorStoreState['navBackStack'];
  navForwardStack: EditorStoreState['navForwardStack'];
}

function captureEditorDeviceOverlay(): EditorDeviceOverlay {
  const state = useEditorStore.getState();
  const worktreeStates = { ...state.worktreeStates };
  if (state.currentWorktreePath) {
    worktreeStates[state.currentWorktreePath] = {
      tabs: state.tabs,
      activeTabPath: state.activeTabPath,
    };
  }
  const viewStates: Record<string, Record<string, unknown>> = {};
  for (const [worktreePath, editor] of Object.entries(worktreeStates)) {
    for (const tab of editor.tabs) {
      if (tab.viewState === undefined) continue;
      viewStates[worktreePath] ??= {};
      viewStates[worktreePath][tab.path] = tab.viewState;
    }
  }
  return {
    viewStates,
    pendingCursor: state.pendingCursor,
    currentCursorLine: state.currentCursorLine,
    navBackStack: state.navBackStack,
    navForwardStack: state.navForwardStack,
  };
}

function emptyEditorDeviceOverlay(): EditorDeviceOverlay {
  return {
    viewStates: {},
    pendingCursor: null,
    currentCursorLine: null,
    navBackStack: [],
    navForwardStack: [],
  };
}

function hashPath(value: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ code, 0x85ebca6b) >>> 0;
  }
  return `${first.toString(16).padStart(8, '0')}${second.toString(16).padStart(8, '0')}`;
}

function hostPathKey(hostPath: string): string {
  return normalizeHostPath(hostPath).replace(/\/$/, '');
}

export class WorkspaceEntityAdoptionConflictError extends Error {
  readonly code = 'ENTITY_ADOPTION_CONFLICT' as const;

  constructor(
    message: string,
    readonly conflictingEntityIds?: string[]
  ) {
    super(message);
    this.name = 'WorkspaceEntityAdoptionConflictError';
  }
}

export function unwrapWorkspaceEntityAdoptionResult(
  result: WorkspaceEntityAdoptionResult
): WorkspaceEntityReservation {
  if (result.ok) return result.reservation;
  throw new WorkspaceEntityAdoptionConflictError(
    result.error.message,
    result.error.conflictingEntityIds
  );
}

function repositoryIdForPath(catalog: WorkspaceCatalogScene, path: string): string | null {
  const key = hostPathKey(path);
  return (
    Object.values(catalog.repositories).find((repository) => hostPathKey(repository.path) === key)
      ?.id ?? null
  );
}

function worktreeIdForPath(catalog: WorkspaceCatalogScene, path: string): string | null {
  const key = hostPathKey(path);
  return (
    Object.values(catalog.worktrees).find((worktree) => hostPathKey(worktree.path) === key)?.id ??
    null
  );
}

export async function stageAndMaterializeWorkspaceResources(
  imagePaths: string[],
  workspaceMirror: Pick<
    typeof window.electronAPI.workspaceMirror,
    'stageResource' | 'materializeResource'
  >
) {
  const resources = await Promise.all(
    imagePaths.map((path) => workspaceMirror.stageResource(path))
  );
  const paths = await Promise.all(
    resources.map((resource) => workspaceMirror.materializeResource(resource.id))
  );
  return { resources, paths };
}

export function workspaceInvalidationQueryKey(
  domain: WorkspaceResourceInvalidation['domain']
): string[] {
  if (domain === 'file-tree') return ['file', 'list'];
  if (domain === 'git-status' || domain === 'diff') return ['git'];
  return [domain];
}

function basename(hostPath: string): string {
  return hostPath.split(/[/\\]/).filter(Boolean).at(-1) ?? hostPath;
}

function sharedPanel(tab: TabId, fallback: WorkspacePanelId = 'chat'): WorkspacePanelId {
  return tab === 'settings' ? fallback : tab;
}

export function buildWorkspaceCatalog(
  repositories: Repository[],
  groups: RepositoryGroup[],
  worktrees: GitWorktree[],
  selectedRepo: string | null,
  worktreeOrderMap: Record<string, Record<string, number>>,
  previous: WorkspaceCatalogScene
): WorkspaceCatalogScene {
  const repositoryRecords: WorkspaceCatalogScene['repositories'] = {};
  repositories.forEach((repository, order) => {
    if (!repository.id) throw new Error(`Repository identity is unresolved: ${repository.path}`);
    const id = repository.id;
    repositoryRecords[id] = {
      id,
      path: repository.path,
      name: repository.name,
      groupId: repository.groupId ?? null,
      order,
      settings: getRepositorySettings(repository.path),
    };
  });

  const groupRecords: WorkspaceCatalogScene['groups'] = {};
  for (const group of groups) groupRecords[group.id] = { ...group };

  const worktreeRecords: WorkspaceCatalogScene['worktrees'] = Object.fromEntries(
    Object.entries(previous.worktrees).filter(([, worktree]) =>
      Boolean(repositoryRecords[worktree.repositoryId])
    )
  );
  if (selectedRepo) {
    const repositoryId = repositories.find(
      (repository) => hostPathKey(repository.path) === hostPathKey(selectedRepo)
    )?.id;
    if (!repositoryId) throw new Error(`Repository identity is unresolved: ${selectedRepo}`);
    for (const [id, worktree] of Object.entries(worktreeRecords)) {
      if (worktree.repositoryId === repositoryId) delete worktreeRecords[id];
    }
    for (const worktree of worktrees) {
      if (!worktree.id) throw new Error(`Worktree identity is unresolved: ${worktree.path}`);
      const id = worktree.id;
      worktreeRecords[id] = {
        id,
        repositoryId,
        path: worktree.path,
        name: basename(worktree.path),
        branch: worktree.branch,
        order:
          worktreeOrderMap[selectedRepo]?.[worktree.path] ?? Object.keys(worktreeRecords).length,
        isMain: worktree.isMainWorktree,
      };
    }
  }
  return { groups: groupRecords, repositories: repositoryRecords, worktrees: worktreeRecords };
}

export function buildNavigation(
  repositoryState: RepositoryBridgeState,
  worktreeState: WorktreeBridgeState,
  catalog: WorkspaceCatalogScene,
  previous: NavigationScene
): NavigationScene {
  const activeWorktreePath = worktreeState.activeWorktree?.path ?? null;
  const activeWorktreeId = activeWorktreePath
    ? worktreeIdForPath(catalog, activeWorktreePath)
    : null;
  const selectedRepositoryId = repositoryState.selectedRepo
    ? repositoryIdForPath(catalog, repositoryState.selectedRepo)
    : null;
  const activePanelByWorktree: NavigationScene['activePanelByWorktree'] = {};
  for (const [path, tab] of Object.entries(worktreeState.worktreeTabMap)) {
    const id = worktreeIdForPath(catalog, path);
    if (!id) continue;
    if (catalog.worktrees[id]) activePanelByWorktree[id] = sharedPanel(tab);
  }
  const panelOrderByWorktree: NavigationScene['panelOrderByWorktree'] = {};
  for (const id of Object.keys(catalog.worktrees)) {
    panelOrderByWorktree[id] = worktreeState.tabOrder
      .filter((tab) => tab !== 'settings')
      .map((tab) => sharedPanel(tab));
  }
  return {
    selectedRepositoryId:
      selectedRepositoryId && catalog.repositories[selectedRepositoryId]
        ? selectedRepositoryId
        : null,
    activeGroupId:
      repositoryState.activeGroupId !== ALL_GROUP_ID &&
      catalog.groups[repositoryState.activeGroupId]
        ? repositoryState.activeGroupId
        : null,
    activeWorktreeId:
      activeWorktreeId && catalog.worktrees[activeWorktreeId] ? activeWorktreeId : null,
    activePrimaryPanel: sharedPanel(worktreeState.activeTab, previous.activePrimaryPanel),
    activePanelByWorktree,
    panelOrderByWorktree,
  };
}

function buildEditors(
  catalog: WorkspaceCatalogScene,
  previous: Record<string, EditorScene>
): Record<string, EditorScene> {
  const state = useEditorStore.getState();
  const states = { ...state.worktreeStates };
  if (state.currentWorktreePath) {
    states[state.currentWorktreePath] = { tabs: state.tabs, activeTabPath: state.activeTabPath };
  }
  const editors: Record<string, EditorScene> = {};
  for (const [path, editor] of Object.entries(states)) {
    const worktreeId = worktreeIdForPath(catalog, path);
    if (!worktreeId || !catalog.worktrees[worktreeId]) continue;
    editors[worktreeId] = {
      tabs: editor.tabs.map((tab, order) => ({
        id: `file-${hashPath(tab.path)}`,
        path: tab.path,
        title: tab.title,
        order,
        encoding: tab.encoding ?? 'utf-8',
        isUnsupported: tab.isUnsupported ?? false,
      })),
      activeFile: editor.activeTabPath,
      buffers: Object.fromEntries(
        editor.tabs.map((tab) => [
          tab.path,
          {
            path: tab.path,
            isDirty: tab.isDirty,
            version: previous[worktreeId]?.buffers[tab.path]?.version ?? 0,
            hasExternalChange: tab.hasExternalChange ?? false,
            ...(tab.isDirty ? { content: tab.content } : {}),
            ...(tab.externalContent === undefined ? {} : { externalContent: tab.externalContent }),
          },
        ])
      ),
    };
  }
  return editors;
}

export function buildAgents(
  catalog: WorkspaceCatalogScene,
  previous: WorkspaceSceneSnapshot['agents'] | undefined = undefined
): WorkspaceSceneSnapshot['agents'] {
  const state = useAgentSessionsStore.getState();
  const tasks = useAgentTasksStore.getState().tasks;
  const sessions: WorkspaceSceneSnapshot['agents']['sessions'] = {};
  for (const session of state.sessions) {
    const previousSession = previous?.sessions[session.id];
    const repositoryId = repositoryIdForPath(catalog, session.repoPath);
    const worktreeId = worktreeIdForPath(catalog, session.cwd);
    const runtimeState = state.runtimeStates[session.id]?.outputState ?? 'idle';
    const task = tasks[session.id];
    const projectedRuntimeState =
      runtimeState === 'idle' && previousSession?.runtimeState
        ? previousSession.runtimeState
        : runtimeState;
    sessions[session.id] = {
      id: session.id,
      providerSessionId: session.sessionId ?? session.id,
      generation: previousSession?.generation ?? 1,
      agentId: session.agentId,
      name: session.name,
      repositoryId: repositoryId && catalog.repositories[repositoryId] ? repositoryId : null,
      worktreeId: worktreeId && catalog.worktrees[worktreeId] ? worktreeId : null,
      terminalSessionId: previousSession?.terminalSessionId ?? session.id,
      environment: session.environment ?? 'native',
      initialized: session.initialized,
      activated: session.activated ?? false,
      displayOrder: session.displayOrder ?? 0,
      runtimeState: projectedRuntimeState,
      status:
        task?.status ??
        (runtimeState === 'idle'
          ? (previousSession?.status ?? 'idle')
          : runtimeState === 'outputting'
            ? 'running'
            : 'idle'),
      waitingReason: task?.waitingReason ?? previousSession?.waitingReason ?? null,
      draft: {
        text: state.enhancedInputStates[session.id]?.content ?? '',
        resources: state.enhancedInputStates[session.id]?.resources ?? [],
      },
      task: task
        ? {
            id: task.sessionId,
            status: task.status,
            description: task.description,
            waitingReason: task.waitingReason ?? null,
            startedAt: task.startedAt,
            completedAt: task.completedAt ?? null,
          }
        : (previousSession?.task ?? null),
    };
  }

  const groups: WorkspaceSceneSnapshot['agents']['groups'] = {};
  for (const [worktreePath, groupState] of Object.entries(state.groupStates)) {
    const worktreeId = worktreeIdForPath(catalog, worktreePath);
    if (!worktreeId || !catalog.worktrees[worktreeId]) continue;
    groupState.groups.forEach((group, order) => {
      groups[group.id] = {
        id: group.id,
        worktreeId,
        layout: groupState.groups.length > 1 ? 'horizontal' : 'tabs',
        sessionIds: group.sessionIds.filter((id) => Boolean(sessions[id])),
        activeSessionId: group.activeSessionId,
        order,
      };
    });
  }
  const activeSessionByWorktree: Record<string, string | null> = {};
  for (const activeId of Object.values(state.activeIds)) {
    const session = activeId ? sessions[activeId] : undefined;
    if (session?.worktreeId) activeSessionByWorktree[session.worktreeId] = session.id;
  }
  return { sessions, groups, activeSessionByWorktree };
}

function buildTerminals(
  catalog: WorkspaceCatalogScene,
  previous: TerminalScene = {
    sessions: {},
    groups: {},
    activeSessionByWorktree: {},
    quickSessionByWorktree: {},
  }
): TerminalScene {
  const state = useTerminalStore.getState();
  const sessions: TerminalScene['sessions'] = {};
  for (const session of state.sessions) {
    const previousSession = previous.sessions[session.id];
    const worktreeId = worktreeIdForPath(catalog, session.cwd);
    const worktree = worktreeId ? catalog.worktrees[worktreeId] : undefined;
    sessions[session.id] = {
      id: session.id,
      generation: previousSession?.generation ?? 1,
      repositoryId: worktree?.repositoryId ?? null,
      worktreeId: worktree && worktreeId ? worktreeId : null,
      title: session.title,
      cwd: session.cwd,
      groupId: null,
      order: Object.keys(sessions).length,
      // Lifecycle events are authoritative. A renderer refresh must not
      // turn an exited/terminated host session back into `running`.
      processState: previousSession?.processState ?? 'running',
      exitCode: previousSession?.exitCode ?? null,
    };
  }

  // Agent terminals use the Agent session ID as their stable persistent
  // terminal ID, but they are not part of the shell-terminal store. Include
  // them in the shared terminal plane so Agent references remain valid even
  // before a renderer attaches to the PTY.
  const agentState = useAgentSessionsStore.getState();
  for (const session of agentState.sessions) {
    if (sessions[session.id]) continue;
    const previousSession = previous.sessions[session.id];
    const worktreeId = worktreeIdForPath(catalog, session.cwd);
    const worktree = worktreeId ? catalog.worktrees[worktreeId] : undefined;
    sessions[session.id] = {
      id: session.id,
      generation: previousSession?.generation ?? 1,
      repositoryId: worktree?.repositoryId ?? null,
      worktreeId: worktree && worktreeId ? worktreeId : null,
      title: session.terminalTitle ?? session.name,
      cwd: session.cwd || '/',
      groupId: null,
      order: Object.keys(sessions).length,
      processState: previousSession?.processState ?? (session.initialized ? 'unknown' : 'starting'),
      exitCode: previousSession?.exitCode ?? null,
    };
  }

  // Preserve live descriptors across the short gap between a local store
  // update and a lifecycle event. Once a process is terminal and no renderer
  // or Agent references it, drop the descriptor so deleted worktrees and tabs
  // cannot be kept alive by stale canonical metadata.
  for (const [sessionId, previousSession] of Object.entries(previous.sessions)) {
    if (sessions[sessionId]) continue;
    if (
      previousSession.processState === 'exited' ||
      previousSession.processState === 'terminated'
    ) {
      continue;
    }
    sessions[sessionId] = {
      ...previousSession,
      repositoryId:
        previousSession.repositoryId && catalog.repositories[previousSession.repositoryId]
          ? previousSession.repositoryId
          : null,
      worktreeId:
        previousSession.worktreeId && catalog.worktrees[previousSession.worktreeId]
          ? previousSession.worktreeId
          : null,
      groupId: null,
    };
  }
  const quickSessionByWorktree: Record<string, string> = {};
  for (const [path, sessionId] of Object.entries(state.quickTerminalSessions)) {
    const worktreeId = worktreeIdForPath(catalog, path);
    if (worktreeId && catalog.worktrees[worktreeId] && sessions[sessionId]) {
      quickSessionByWorktree[worktreeId] = sessionId;
    }
  }
  const groups: TerminalScene['groups'] = {};
  const activeSessionByWorktree: Record<string, string | null> = {};
  for (const [storedPath, groupState] of Object.entries(state.worktreeGroupStates)) {
    const path = groupState.originalPath || storedPath;
    const worktree = Object.values(catalog.worktrees).find(
      (candidate) => normalizePath(candidate.path) === normalizePath(path)
    );
    if (!worktree) continue;
    groupState.groups.forEach((group, order) => {
      groups[group.id] = {
        id: group.id,
        worktreeId: worktree.id,
        layout: groupState.groups.length > 1 ? 'horizontal' : 'tabs',
        sessionIds: group.tabs.map((tab) => tab.id).filter((id) => Boolean(sessions[id])),
        activeSessionId: group.activeTabId,
        order,
      };
      for (const [tabOrder, tab] of group.tabs.entries()) {
        if (sessions[tab.id])
          sessions[tab.id] = { ...sessions[tab.id], groupId: group.id, order: tabOrder };
      }
      if (groupState.activeGroupId === group.id) {
        activeSessionByWorktree[worktree.id] = group.activeTabId;
      }
    });
  }
  return { sessions, groups, activeSessionByWorktree, quickSessionByWorktree };
}

export function buildTerminalPublishMutation(
  catalog: WorkspaceCatalogScene
): Extract<WorkspaceSceneMutation, { kind: 'terminals.replace' }> {
  return {
    kind: 'terminals.replace',
    payload: {
      terminals: buildTerminals(catalog, useWorkspaceMirrorStore.getState().snapshot?.terminals),
    },
  };
}

function buildTodos(catalog: WorkspaceCatalogScene): TodoScene {
  const state = useTodoStore.getState();
  const boardsByRepository: TodoScene['boardsByRepository'] = {};
  for (const repository of Object.values(catalog.repositories)) {
    const key = getTodoStoreKey(repository.path);
    const tasks = state.tasks[key] ?? [];
    const auto = state.autoExecute[key];
    if (tasks.length === 0 && !auto) continue;
    boardsByRepository[repository.id] = {
      tasks: Object.fromEntries(
        tasks.map((task) => [task.id, { ...task, sessionId: task.sessionId ?? null }])
      ),
      autoExecution: auto ?? {
        running: false,
        queue: [],
        currentTaskId: null,
        currentSessionId: null,
      },
    };
  }
  return { boardsByRepository };
}

function buildSelections(
  catalog: WorkspaceCatalogScene,
  previous: WorkspaceSceneSnapshot['selections'],
  activeWorktree: GitWorktree | null
): WorkspaceSceneSnapshot['selections'] {
  const editor = useEditorStore.getState();
  const selectedFileByWorktree: WorkspaceSceneSnapshot['selections']['selectedFileByWorktree'] = {};
  for (const [worktreeId, worktree] of Object.entries(catalog.worktrees)) {
    selectedFileByWorktree[worktreeId] =
      worktree.path === editor.currentWorktreePath
        ? editor.activeTabPath
        : (editor.worktreeStates[worktree.path]?.activeTabPath ?? null);
  }

  const selectedDiffByWorktree = Object.fromEntries(
    Object.entries(previous.selectedDiffByWorktree).filter(([worktreeId]) =>
      Boolean(catalog.worktrees[worktreeId])
    )
  );
  if (activeWorktree) {
    const worktreeId = worktreeIdForPath(catalog, activeWorktree.path);
    if (worktreeId && catalog.worktrees[worktreeId]) {
      const selectedDiff = useSourceControlStore.getState().selectedFile;
      selectedDiffByWorktree[worktreeId] = selectedDiff
        ? joinPath(activeWorktree.path, selectedDiff.path)
        : null;
    }
  }

  const todo = useTodoStore.getState();
  const selectedTaskByRepository = Object.fromEntries(
    Object.values(catalog.repositories).map((repository) => [
      repository.id,
      todo.autoExecute[getTodoStoreKey(repository.path)]?.currentTaskId ?? null,
    ])
  );
  return { selectedFileByWorktree, selectedDiffByWorktree, selectedTaskByRepository };
}

function buildSceneReplacement(
  catalog: WorkspaceCatalogScene,
  snapshot: WorkspaceSceneSnapshot,
  repositoryState: RepositoryBridgeState,
  worktreeState: WorktreeBridgeState
): Extract<WorkspaceSceneMutation, { kind: 'scene.replace' }>['payload'] {
  return {
    catalog,
    navigation: buildNavigation(repositoryState, worktreeState, catalog, snapshot.navigation),
    editors: buildEditors(catalog, snapshot.editors),
    agents: buildAgents(catalog, snapshot.agents),
    terminals: buildTerminals(catalog, snapshot.terminals),
    todos: buildTodos(catalog),
    selections: buildSelections(catalog, snapshot.selections, worktreeState.activeWorktree),
  };
}

export function catalogRequiresSceneReplacement(
  snapshot: WorkspaceSceneSnapshot,
  catalog: WorkspaceCatalogScene
): boolean {
  return canonicalJson(snapshot.catalog) !== canonicalJson(catalog);
}

function mutationMatches(
  snapshot: WorkspaceSceneSnapshot,
  mutation: WorkspaceSceneMutation
): boolean {
  switch (mutation.kind) {
    case 'scene.replace':
      return (
        canonicalJson({
          catalog: snapshot.catalog,
          navigation: snapshot.navigation,
          editors: snapshot.editors,
          agents: snapshot.agents,
          terminals: snapshot.terminals,
          todos: snapshot.todos,
          selections: snapshot.selections,
        }) === canonicalJson(mutation.payload)
      );
    case 'catalog.replace':
      return canonicalJson(snapshot.catalog) === canonicalJson(mutation.payload.catalog);
    case 'navigation.replace':
      return canonicalJson(snapshot.navigation) === canonicalJson(mutation.payload.navigation);
    case 'agents.replace':
      return canonicalJson(snapshot.agents) === canonicalJson(mutation.payload.agents);
    case 'terminals.replace':
      return canonicalJson(snapshot.terminals) === canonicalJson(mutation.payload.terminals);
    case 'todos.replace':
      return canonicalJson(snapshot.todos) === canonicalJson(mutation.payload.todos);
    case 'selections.replace':
      return canonicalJson(snapshot.selections) === canonicalJson(mutation.payload.selections);
    case 'editor.replace':
      return (
        canonicalJson(snapshot.editors[mutation.payload.worktreeId]) ===
        canonicalJson(mutation.payload.editor)
      );
    case 'editor.remove':
      return snapshot.editors[mutation.payload.worktreeId] === undefined;
    case 'editor.buffer.update':
    case 'resources.invalidate':
      return false;
  }
}

export function applySnapshotToRenderer(
  snapshot: WorkspaceSceneSnapshot,
  repositoryState: RepositoryBridgeState,
  worktreeState: WorktreeBridgeState,
  editorOverlay: EditorDeviceOverlay,
  preserveControllerRuntimeState = false
): void {
  projectRepositorySettings(
    Object.fromEntries(
      Object.values(snapshot.catalog.repositories).map((repository) => [
        normalizePath(repository.path),
        repository.settings,
      ])
    )
  );
  const repositories = Object.values(snapshot.catalog.repositories).sort(
    (a, b) => a.order - b.order
  );
  const groups = Object.values(snapshot.catalog.groups).sort((a, b) => a.order - b.order);
  repositoryState.saveRepositories(
    repositories.map((repository) => ({
      id: repository.id,
      name: repository.name,
      path: repository.path,
      ...(repository.groupId ? { groupId: repository.groupId } : {}),
    }))
  );
  repositoryState.setGroups(groups);
  repositoryState.setSelectedRepo(
    snapshot.navigation.selectedRepositoryId
      ? (snapshot.catalog.repositories[snapshot.navigation.selectedRepositoryId]?.path ?? null)
      : null
  );
  repositoryState.setActiveGroupId(snapshot.navigation.activeGroupId ?? ALL_GROUP_ID);

  const worktreeTabMap: Record<string, TabId> = {};
  for (const [id, panel] of Object.entries(snapshot.navigation.activePanelByWorktree)) {
    const path = snapshot.catalog.worktrees[id]?.path;
    if (path) worktreeTabMap[path] = panel;
  }
  const worktreeOrderMap: Record<string, Record<string, number>> = {};
  for (const worktree of Object.values(snapshot.catalog.worktrees)) {
    const repository = snapshot.catalog.repositories[worktree.repositoryId];
    if (!repository) continue;
    worktreeOrderMap[repository.path] ??= {};
    worktreeOrderMap[repository.path][worktree.path] = worktree.order;
  }
  const repoWorktreeMap: Record<string, string> = {};
  const activeWorktree = snapshot.navigation.activeWorktreeId
    ? snapshot.catalog.worktrees[snapshot.navigation.activeWorktreeId]
    : undefined;
  if (activeWorktree) {
    const repository = snapshot.catalog.repositories[activeWorktree.repositoryId];
    if (repository) repoWorktreeMap[repository.path] = activeWorktree.path;
  }
  worktreeState.setWorktreeTabMap(worktreeTabMap);
  worktreeState.setWorktreeOrderMap(worktreeOrderMap);
  worktreeState.setRepoWorktreeMap(repoWorktreeMap);
  worktreeState.setActiveTab(snapshot.navigation.activePrimaryPanel);
  const activeOrder = snapshot.navigation.activeWorktreeId
    ? snapshot.navigation.panelOrderByWorktree[snapshot.navigation.activeWorktreeId]
    : undefined;
  if (activeOrder?.length) worktreeState.setTabOrder(activeOrder);

  const editorStates: ReturnType<typeof useEditorStore.getState>['worktreeStates'] = {};
  for (const [worktreeId, editor] of Object.entries(snapshot.editors)) {
    const path = snapshot.catalog.worktrees[worktreeId]?.path;
    if (!path) continue;
    const tabs = [...editor.tabs]
      .sort((left, right) => left.order - right.order)
      .map((tab) => {
        const buffer = editor.buffers[tab.path];
        const viewState = editorOverlay.viewStates[path]?.[tab.path];
        return {
          path: tab.path,
          title: tab.title,
          content: buffer?.content ?? '',
          isDirty: buffer?.isDirty ?? false,
          encoding: tab.encoding,
          isUnsupported: tab.isUnsupported,
          hasExternalChange: buffer?.hasExternalChange ?? false,
          ...(viewState === undefined ? {} : { viewState }),
          ...(buffer?.externalContent === undefined
            ? {}
            : { externalContent: buffer.externalContent }),
        };
      });
    const selectedFile = snapshot.selections.selectedFileByWorktree[worktreeId];
    editorStates[path] = {
      tabs,
      activeTabPath:
        selectedFile && tabs.some((tab) => tab.path === selectedFile)
          ? selectedFile
          : editor.activeFile,
    };
  }
  const activeWorktreePath = activeWorktree?.path ?? null;
  const activeEditor = activeWorktreePath ? editorStates[activeWorktreePath] : undefined;
  useEditorStore.setState({
    worktreeStates: editorStates,
    currentWorktreePath: activeWorktreePath,
    tabs: activeEditor?.tabs ?? [],
    activeTabPath: activeEditor?.activeTabPath ?? null,
    pendingCursor: editorOverlay.pendingCursor,
    currentCursorLine: editorOverlay.currentCursorLine,
    navBackStack: editorOverlay.navBackStack,
    navForwardStack: editorOverlay.navForwardStack,
  });
  const selectedDiff = activeWorktree
    ? snapshot.selections.selectedDiffByWorktree[activeWorktree.id]
    : null;
  const normalizedWorktreePath = activeWorktree
    ? normalizeHostPath(activeWorktree.path).replace(/\/$/, '')
    : '';
  const normalizedDiffPath = selectedDiff ? normalizeHostPath(selectedDiff) : null;
  const relativeDiffPath =
    normalizedDiffPath && normalizedWorktreePath
      ? normalizedDiffPath.startsWith(`${normalizedWorktreePath}/`)
        ? normalizedDiffPath.slice(normalizedWorktreePath.length + 1)
        : normalizedDiffPath
      : null;
  const existingDiffSelection = useSourceControlStore.getState().selectedFile;
  useSourceControlStore.setState({
    selectedFile: relativeDiffPath
      ? {
          path: relativeDiffPath,
          staged:
            existingDiffSelection?.path === relativeDiffPath ? existingDiffSelection.staged : false,
        }
      : null,
  });

  // Agent and terminal stores are optimistic while this renderer controls the scene.
  // Replaying an older host snapshot here would erase state before its mutation is published.
  if (!preserveControllerRuntimeState) {
    const existingAgentState = useAgentSessionsStore.getState();
    const existingSessions = new Map(
      existingAgentState.sessions.map((session) => [session.id, session])
    );
    const agentSessions: Session[] = Object.values(snapshot.agents.sessions).map((session) => {
      const existing = existingSessions.get(session.id);
      const repositoryPath = session.repositoryId
        ? (snapshot.catalog.repositories[session.repositoryId]?.path ?? '')
        : '';
      const worktreePath = session.worktreeId
        ? (snapshot.catalog.worktrees[session.worktreeId]?.path ?? repositoryPath)
        : repositoryPath;
      return {
        id: session.id,
        sessionId: session.providerSessionId ?? existing?.sessionId ?? session.id,
        name: session.name,
        agentId: session.agentId,
        agentCommand: existing?.agentCommand ?? session.agentId,
        initialized: session.initialized,
        activated: session.activated,
        repoPath: repositoryPath,
        cwd: worktreePath,
        environment: session.environment,
        displayOrder: session.displayOrder,
        terminalTitle: existing?.terminalTitle,
        userRenamed: existing?.userRenamed,
      };
    });
    const agentGroupStates: Record<string, AgentGroupState> = {};
    for (const group of Object.values(snapshot.agents.groups)) {
      const path = snapshot.catalog.worktrees[group.worktreeId]?.path;
      if (!path) continue;
      const key = normalizePath(path);
      if (!agentGroupStates[key]) {
        agentGroupStates[key] = { groups: [], activeGroupId: null, flexPercents: [] };
      }
      const state = agentGroupStates[key];
      state.groups.push({
        id: group.id,
        sessionIds: group.sessionIds,
        activeSessionId: group.activeSessionId,
      });
      state.flexPercents = state.groups.map(() => 100 / state.groups.length);
      if (group.activeSessionId) state.activeGroupId = group.id;
    }
    const activeIds: Record<string, string | null> = {};
    for (const [worktreeId, sessionId] of Object.entries(snapshot.agents.activeSessionByWorktree)) {
      const worktree = snapshot.catalog.worktrees[worktreeId];
      const repository = worktree
        ? snapshot.catalog.repositories[worktree.repositoryId]
        : undefined;
      if (worktree && repository) {
        activeIds[`${normalizePath(repository.path)}::${normalizePath(worktree.path)}`] = sessionId;
      }
    }
    useAgentSessionsStore.setState({
      sessions: agentSessions,
      activeIds,
      groupStates: agentGroupStates,
      runtimeStates: Object.fromEntries(
        Object.values(snapshot.agents.sessions).map((session) => [
          session.id,
          {
            outputState: session.runtimeState,
            lastActivityAt: Date.now(),
            wasActiveWhenOutputting: false,
          },
        ])
      ),
      enhancedInputStates: Object.fromEntries(
        Object.values(snapshot.agents.sessions).map((session) => {
          const existing = existingAgentState.enhancedInputStates[session.id];
          const sameResources =
            canonicalJson(existing?.resources ?? []) === canonicalJson(session.draft.resources);
          return [
            session.id,
            {
              open: existing?.open ?? false,
              content: session.draft.text,
              imagePaths: sameResources ? (existing?.imagePaths ?? []) : [],
              resources: session.draft.resources,
            },
          ];
        })
      ),
    });
    loadAgentTaskSnapshot(
      Object.fromEntries(
        Object.values(snapshot.agents.sessions).flatMap((session) => {
          if (!session.task) return [];
          const repositoryPath = session.repositoryId
            ? (snapshot.catalog.repositories[session.repositoryId]?.path ?? '')
            : '';
          const worktreePath = session.worktreeId
            ? (snapshot.catalog.worktrees[session.worktreeId]?.path ?? repositoryPath)
            : repositoryPath;
          return [
            [
              session.id,
              {
                sessionId: session.id,
                sessionName: session.name,
                repoPath: repositoryPath,
                repoName: basename(repositoryPath),
                cwd: worktreePath,
                status: session.task.status,
                description: session.task.description,
                startedAt: session.task.startedAt ?? 0,
                ...(session.task.completedAt === null
                  ? {}
                  : { completedAt: session.task.completedAt }),
                ...(session.task.waitingReason === null
                  ? {}
                  : { waitingReason: session.task.waitingReason }),
              },
            ],
          ];
        })
      )
    );

    useTerminalStore.setState({
      sessions: Object.values(snapshot.terminals.sessions).map((session) => ({
        id: session.id,
        title: session.title,
        cwd: session.cwd,
      })),
      activeSessionId:
        (activeWorktree && snapshot.terminals.activeSessionByWorktree[activeWorktree.id]) ?? null,
      quickTerminalSessions: Object.fromEntries(
        Object.entries(snapshot.terminals.quickSessionByWorktree)
          .map(([worktreeId, sessionId]) => {
            const path = snapshot.catalog.worktrees[worktreeId]?.path;
            return path ? [path, sessionId] : null;
          })
          .filter((entry): entry is [string, string] => entry !== null)
      ),
    });
    const terminalGroupStates: TerminalWorktreeGroupStates = {};
    for (const group of Object.values(snapshot.terminals.groups).sort(
      (a, b) => a.order - b.order
    )) {
      const worktree = snapshot.catalog.worktrees[group.worktreeId];
      if (!worktree) continue;
      const key = normalizePath(worktree.path);
      if (!terminalGroupStates[key]) {
        terminalGroupStates[key] = {
          groups: [],
          activeGroupId: null,
          flexPercents: [],
          originalPath: worktree.path,
        };
      }
      const state = terminalGroupStates[key];
      state.groups.push({
        id: group.id,
        tabs: group.sessionIds
          .map((sessionId) => snapshot.terminals.sessions[sessionId])
          .filter((session) => Boolean(session))
          .map((session) => ({
            id: session.id,
            name: session.title,
            title: session.title,
            cwd: session.cwd,
          })),
        activeTabId: group.activeSessionId,
      });
      state.flexPercents = state.groups.map(() => 100 / state.groups.length);
      if (snapshot.terminals.activeSessionByWorktree[group.worktreeId] === group.activeSessionId) {
        state.activeGroupId = group.id;
      }
    }
    useTerminalStore.getState().setWorktreeGroupStates(terminalGroupStates);
  }

  const todoTasks: Record<string, TodoTask[]> = {};
  const autoExecute: ReturnType<typeof useTodoStore.getState>['autoExecute'] = {};
  for (const [repositoryId, board] of Object.entries(snapshot.todos.boardsByRepository)) {
    const repository = snapshot.catalog.repositories[repositoryId];
    if (!repository) continue;
    const key = getTodoStoreKey(repository.path);
    todoTasks[key] = Object.values(board.tasks)
      .sort((left, right) => left.order - right.order)
      .map((task) => {
        const { sessionId, ...rest } = task;
        return { ...rest, ...(sessionId ? { sessionId } : {}) };
      });
    autoExecute[key] = {
      ...board.autoExecution,
      currentTaskId:
        snapshot.selections.selectedTaskByRepository[repositoryId] ??
        board.autoExecution.currentTaskId,
    };
  }
  useTodoStore.setState({
    tasks: todoTasks,
    autoExecute,
    _loaded: new Set(Object.keys(todoTasks)),
  });
}

export function useWorkspaceMirrorBridge(
  repositoryState: RepositoryBridgeState,
  worktreeState: WorktreeBridgeState
): void {
  const remoteStatus = useRemoteStore((state) => state.status);
  const snapshot = useWorkspaceMirrorStore((state) => state.snapshot);
  const ownsControl = useWorkspaceMirrorStore((state) => state.ownsControl);
  const projectionTarget = useWorkspaceMirrorStore((state) => state.projectionTarget);
  const bootstrapReady = useWorkspaceMirrorStore((state) => state.bootstrapReady);
  const queryClient = useQueryClient();
  const worktrees = useWorktreeStore((state) => state.worktrees);
  const editorTabs = useEditorStore((state) => state.tabs);
  const editorWorktreeStates = useEditorStore((state) => state.worktreeStates);
  const agentSessions = useAgentSessionsStore((state) => state.sessions);
  const agentGroups = useAgentSessionsStore((state) => state.groupStates);
  const agentRuntime = useAgentSessionsStore((state) => state.runtimeStates);
  const agentDrafts = useAgentSessionsStore((state) => state.enhancedInputStates);
  const agentTasks = useAgentTasksStore((state) => state.tasks);
  const sourceControlSelection = useSourceControlStore((state) => state.selectedFile);
  const terminalSessions = useTerminalStore((state) => state.sessions);
  const terminalQuickSessions = useTerminalStore((state) => state.quickTerminalSessions);
  const terminalGroupStates = useTerminalStore((state) => state.worktreeGroupStates);
  const todoTasks = useTodoStore((state) => state.tasks);
  const todoAutoExecute = useTodoStore((state) => state.autoExecute);
  const repositorySettingsRevision = useSyncExternalStore(
    subscribeRepositorySettings,
    getRepositorySettingsRevision
  );
  const [legacyStateReady, setLegacyStateReady] = useState(false);
  const publishTail = useRef<Promise<void>>(Promise.resolve());
  const resourceSyncSignaturesRef = useRef(new Map<string, string>());
  const resourceInvalidationGenerationsRef = useRef(new Map<string, number>());
  const legacyImportCompletedRef = useRef(false);
  const repositoryStateRef = useRef(repositoryState);
  const worktreeStateRef = useRef(worktreeState);
  const activeProjectionKeyRef = useRef('local');
  const editorOverlaysRef = useRef(new Map<string, EditorDeviceOverlay>());
  const editorHydrationGenerationRef = useRef(0);
  const entityResolutionGenerationRef = useRef(0);
  repositoryStateRef.current = repositoryState;
  worktreeStateRef.current = worktreeState;

  useEffect(() => {
    const frame = requestAnimationFrame(() => setLegacyStateReady(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  const enqueueMutation = useCallback((candidate: unknown) => {
    const mutation = WorkspaceSceneMutationSchema.parse(candidate);
    const job = publishTail.current.then(async () => {
      const store = useWorkspaceMirrorStore.getState();
      if (!store.ownsControl || !store.snapshot || mutationMatches(store.snapshot, mutation)) {
        return;
      }
      const result = await store.dispatchMutation(mutation);
      if (!result.accepted) throw new Error(result.error.message);
      await useWorkspaceMirrorStore.getState().refresh();
    });
    publishTail.current = job.catch((error) => {
      console.warn('[workspace-mirror] failed to publish renderer state', error);
    });
    return job;
  }, []);

  useEffect(() => {
    if (!snapshot || projectionTarget === 'transitioning') return;
    if (projectionTarget === 'local' && snapshot.revision === 0) return;
    const projectionKey =
      projectionTarget === 'local'
        ? 'local'
        : `remote:${remoteStatus?.host ?? 'unknown'}:${remoteStatus?.port ?? 0}`;
    const projectionChanged = projectionKey !== activeProjectionKeyRef.current;
    if (projectionChanged) {
      editorOverlaysRef.current.set(activeProjectionKeyRef.current, captureEditorDeviceOverlay());
      activeProjectionKeyRef.current = projectionKey;
      queryClient.removeQueries({ queryKey: ['git'] });
      queryClient.removeQueries({ queryKey: ['worktree'] });
    }
    const editorOverlay =
      editorOverlaysRef.current.get(projectionKey) ?? emptyEditorDeviceOverlay();
    applySnapshotToRenderer(
      snapshot,
      repositoryStateRef.current,
      worktreeStateRef.current,
      editorOverlay,
      ownsControl && !projectionChanged
    );
  }, [
    snapshot,
    projectionTarget,
    ownsControl,
    remoteStatus?.host,
    remoteStatus?.port,
    queryClient,
  ]);

  useEffect(() => {
    if (!snapshot || projectionTarget === 'transitioning') return;
    const generation = ++editorHydrationGenerationRef.current;
    for (const [worktreeId, editor] of Object.entries(snapshot.editors)) {
      for (const tab of editor.tabs) {
        const buffer = editor.buffers[tab.path];
        if (!buffer || buffer.isDirty || buffer.content !== undefined) continue;
        void window.electronAPI.file
          .read(tab.path)
          .then(({ content, isBinary }) => {
            if (generation !== editorHydrationGenerationRef.current || isBinary) return;
            const currentSnapshot = useWorkspaceMirrorStore.getState().snapshot;
            const currentBuffer = currentSnapshot?.editors[worktreeId]?.buffers[tab.path];
            if (!currentBuffer || currentBuffer.isDirty || currentBuffer.content !== undefined)
              return;
            useEditorStore.setState((state) => {
              const worktreePath = currentSnapshot?.catalog.worktrees[worktreeId]?.path;
              if (!worktreePath) return state;
              const update = (candidate: EditorTab): EditorTab =>
                candidate.path === tab.path ? { ...candidate, content } : candidate;
              const worktreeState = state.worktreeStates[worktreePath];
              const nextWorktreeStates = worktreeState
                ? {
                    ...state.worktreeStates,
                    [worktreePath]: { ...worktreeState, tabs: worktreeState.tabs.map(update) },
                  }
                : state.worktreeStates;
              return {
                ...state,
                tabs: state.tabs.map(update),
                worktreeStates: nextWorktreeStates,
              };
            });
          })
          .catch(() => undefined);
      }
    }
  }, [snapshot, projectionTarget]);

  useEffect(() => {
    if (!snapshot || projectionTarget === 'transitioning') return;
    for (const invalidation of Object.values(snapshot.resources.invalidations)) {
      const key = `${snapshot.hostId}:${snapshot.sceneId}:${invalidation.resourceKey}`;
      const previousGeneration = resourceInvalidationGenerationsRef.current.get(key) ?? 0;
      if (invalidation.generation <= previousGeneration) continue;
      resourceInvalidationGenerationsRef.current.set(key, invalidation.generation);
      void queryClient.invalidateQueries({
        queryKey: workspaceInvalidationQueryKey(invalidation.domain),
      });
    }
  }, [snapshot, projectionTarget, queryClient]);

  useEffect(() => {
    const resolveResources = useAgentSessionsStore.getState().resolveEnhancedInputResources;
    for (const [sessionId, draft] of Object.entries(agentDrafts)) {
      const signature = canonicalJson({
        imagePaths: draft.imagePaths,
        resources: draft.resources.map((resource) => resource.id),
      });
      if (resourceSyncSignaturesRef.current.get(sessionId) === signature) continue;
      resourceSyncSignaturesRef.current.set(sessionId, signature);

      if (draft.imagePaths.length > 0 && draft.resources.length === 0) {
        void stageAndMaterializeWorkspaceResources(
          draft.imagePaths,
          window.electronAPI.workspaceMirror
        )
          .then(({ paths, resources }) => {
            const current = useAgentSessionsStore.getState().enhancedInputStates[sessionId];
            if (current && canonicalJson(current.imagePaths) === canonicalJson(draft.imagePaths)) {
              resolveResources(sessionId, paths, resources);
            }
          })
          .catch((error) => {
            resourceSyncSignaturesRef.current.delete(sessionId);
            console.warn('[workspace-mirror] failed to stage Agent resource', error);
          });
        continue;
      }

      if (draft.imagePaths.length === 0 && draft.resources.length > 0) {
        void Promise.all(
          draft.resources.map((resource) =>
            window.electronAPI.workspaceMirror.materializeResource(resource.id)
          )
        )
          .then((paths) => {
            const current = useAgentSessionsStore.getState().enhancedInputStates[sessionId];
            if (current && canonicalJson(current.resources) === canonicalJson(draft.resources)) {
              resolveResources(sessionId, paths, current.resources);
            }
          })
          .catch((error) => {
            resourceSyncSignaturesRef.current.delete(sessionId);
            console.warn('[workspace-mirror] failed to materialize Agent resource', error);
          });
      }
    }
  }, [agentDrafts]);

  useEffect(() => {
    if (!legacyStateReady || !ownsControl || projectionTarget === 'transitioning') return;
    const candidates = [
      ...repositoryState.repositories
        .filter((repository) => !repository.id)
        .map((repository) => ({ kind: 'repository' as const, path: repository.path })),
      ...worktrees
        .filter((worktree) => !worktree.id)
        .map((worktree) => ({ kind: 'worktree' as const, path: worktree.path })),
    ];
    if (candidates.length === 0) return;

    const generation = ++entityResolutionGenerationRef.current;
    void (async () => {
      const resolutions = await window.electronAPI.workspaceMirror.resolveEntities(candidates);
      const entityIds = new Map<string, string>();
      for (const [index, candidate] of candidates.entries()) {
        const resolution = resolutions[index];
        if (!resolution || resolution.status === 'ambiguous') {
          throw new Error(`Workspace entity path is ambiguous: ${candidate.path}`);
        }
        if (resolution.status === 'resolved') {
          if (
            resolution.match === 'alias' &&
            hostPathKey(resolution.currentPath) !== hostPathKey(candidate.path)
          ) {
            const adopted = unwrapWorkspaceEntityAdoptionResult(
              await window.electronAPI.workspaceMirror.adoptEntity(
                candidate.kind,
                resolution.entityId,
                candidate.path
              )
            );
            entityIds.set(`${candidate.kind}\0${hostPathKey(candidate.path)}`, adopted.entityId);
            continue;
          }
          entityIds.set(`${candidate.kind}\0${hostPathKey(candidate.path)}`, resolution.entityId);
          continue;
        }
        const projectedPaths = new Set(
          (candidate.kind === 'repository' ? repositoryState.repositories : worktrees).map(
            (entity) => hostPathKey(entity.path)
          )
        );
        const missingDurableEntities = snapshot
          ? Object.values(
              candidate.kind === 'repository'
                ? snapshot.catalog.repositories
                : snapshot.catalog.worktrees
            ).filter((entity) => !projectedPaths.has(hostPathKey(entity.path)))
          : [];
        if (missingDurableEntities.length > 0) {
          throw new Error(`Workspace entity path requires explicit adoption: ${candidate.path}`);
        }
        const reservation = await window.electronAPI.workspaceMirror.registerEntity(
          candidate.kind,
          candidate.path
        );
        entityIds.set(`${candidate.kind}\0${hostPathKey(candidate.path)}`, reservation.entityId);
      }
      if (generation !== entityResolutionGenerationRef.current) return;

      repositoryStateRef.current.saveRepositories(
        repositoryStateRef.current.repositories.map((repository) => ({
          ...repository,
          id: repository.id ?? entityIds.get(`repository\0${hostPathKey(repository.path)}`),
        }))
      );
      useWorktreeStore.setState((state) => ({
        worktrees: state.worktrees.map((worktree) => ({
          ...worktree,
          id: worktree.id ?? entityIds.get(`worktree\0${hostPathKey(worktree.path)}`),
        })),
        currentWorktree: state.currentWorktree
          ? {
              ...state.currentWorktree,
              id:
                state.currentWorktree.id ??
                entityIds.get(`worktree\0${hostPathKey(state.currentWorktree.path)}`),
            }
          : null,
      }));
    })().catch((error) => {
      console.warn('[workspace-mirror] entity resolution blocked scene publication', error);
    });
  }, [
    legacyStateReady,
    ownsControl,
    projectionTarget,
    snapshot,
    repositoryState.repositories,
    worktrees,
  ]);

  const snapshotCatalogSignature = snapshot ? canonicalJson(snapshot.catalog) : null;
  const entitiesResolved =
    repositoryState.repositories.every((repository) => Boolean(repository.id)) &&
    worktrees.every((worktree) => Boolean(worktree.id));
  const catalog = useMemo(() => {
    void repositorySettingsRevision;
    void snapshotCatalogSignature;
    const snapshotCatalog = useWorkspaceMirrorStore.getState().snapshot?.catalog;
    return snapshotCatalog && entitiesResolved
      ? buildWorkspaceCatalog(
          repositoryState.repositories,
          repositoryState.groups,
          worktrees,
          repositoryState.selectedRepo,
          worktreeState.worktreeOrderMap,
          snapshotCatalog
        )
      : null;
  }, [
    snapshotCatalogSignature,
    repositoryState.repositories,
    repositoryState.groups,
    repositoryState.selectedRepo,
    worktrees,
    worktreeState.worktreeOrderMap,
    repositorySettingsRevision,
    entitiesResolved,
  ]);
  const terminalCatalogRef = useRef(catalog);
  // Snapshot hydration recreates catalog objects, so publish terminals only on semantic changes.
  const terminalCatalogSignature = catalog ? canonicalJson(catalog) : null;
  terminalCatalogRef.current = catalog;

  useEffect(() => {
    if (!legacyStateReady || !ownsControl || !catalog) return;
    const currentSnapshot = useWorkspaceMirrorStore.getState().snapshot;
    if (!currentSnapshot || !catalogRequiresSceneReplacement(currentSnapshot, catalog)) return;
    enqueueMutation({
      kind: 'scene.replace',
      payload: buildSceneReplacement(
        catalog,
        currentSnapshot,
        repositoryStateRef.current,
        worktreeStateRef.current
      ),
    });
  }, [legacyStateReady, ownsControl, catalog, enqueueMutation]);

  useEffect(() => {
    if (!legacyStateReady || !ownsControl || !snapshot || !catalog) return;
    void repositoryState.selectedRepo;
    void repositoryState.activeGroupId;
    void worktreeState.worktreeTabMap;
    void worktreeState.tabOrder;
    void worktreeState.activeTab;
    void worktreeState.activeWorktree;
    enqueueMutation({
      kind: 'navigation.replace',
      payload: {
        navigation: buildNavigation(
          repositoryStateRef.current,
          worktreeStateRef.current,
          catalog,
          snapshot.navigation
        ),
      },
    });
  }, [
    legacyStateReady,
    ownsControl,
    snapshot,
    catalog,
    repositoryState.selectedRepo,
    repositoryState.activeGroupId,
    worktreeState.worktreeTabMap,
    worktreeState.tabOrder,
    worktreeState.activeTab,
    worktreeState.activeWorktree,
    enqueueMutation,
  ]);

  useEffect(() => {
    if (!legacyStateReady || !ownsControl || !catalog) return;
    void editorTabs;
    void editorWorktreeStates;
    const editors = buildEditors(catalog, snapshot?.editors ?? {});
    for (const [worktreeId, editor] of Object.entries(editors)) {
      const current = snapshot?.editors[worktreeId];
      if (
        !current ||
        canonicalJson(current.tabs) !== canonicalJson(editor.tabs) ||
        current.activeFile !== editor.activeFile
      ) {
        enqueueMutation({ kind: 'editor.replace', payload: { worktreeId, editor } });
        continue;
      }
      for (const [path, buffer] of Object.entries(editor.buffers)) {
        const previousBuffer = current.buffers[path];
        if (!previousBuffer || canonicalJson(previousBuffer) === canonicalJson(buffer)) continue;
        const encoding = editor.tabs.find((tab) => tab.path === path)?.encoding;
        enqueueMutation({
          kind: 'editor.buffer.update',
          payload: {
            worktreeId,
            path,
            baseVersion: previousBuffer.version,
            nextVersion: previousBuffer.version + 1,
            isDirty: buffer.isDirty,
            hasExternalChange: buffer.hasExternalChange,
            ...(buffer.isDirty ? { content: buffer.content ?? '' } : {}),
            ...(encoding ? { encoding } : {}),
            ...(buffer.externalContent === undefined
              ? {}
              : { externalContent: buffer.externalContent }),
          },
        });
      }
    }
    for (const worktreeId of Object.keys(snapshot?.editors ?? {})) {
      if (!editors[worktreeId]) {
        enqueueMutation({ kind: 'editor.remove', payload: { worktreeId } });
      }
    }
  }, [
    legacyStateReady,
    ownsControl,
    catalog,
    snapshot,
    editorTabs,
    editorWorktreeStates,
    enqueueMutation,
  ]);

  useEffect(() => {
    if (!legacyStateReady || !ownsControl || !catalog) return;
    void agentSessions;
    void agentGroups;
    void agentRuntime;
    void agentDrafts;
    void agentTasks;
    enqueueMutation({
      kind: 'agents.replace',
      payload: { agents: buildAgents(catalog, snapshot?.agents) },
    });
  }, [
    legacyStateReady,
    ownsControl,
    catalog,
    snapshot?.agents,
    agentSessions,
    agentGroups,
    agentRuntime,
    agentDrafts,
    agentTasks,
    enqueueMutation,
  ]);

  useEffect(() => {
    const terminalCatalog = terminalCatalogRef.current;
    if (!legacyStateReady || !ownsControl || !terminalCatalog || !terminalCatalogSignature) return;
    void agentSessions;
    void terminalSessions;
    void terminalQuickSessions;
    void terminalGroupStates;
    enqueueMutation(buildTerminalPublishMutation(terminalCatalog));
  }, [
    legacyStateReady,
    ownsControl,
    terminalCatalogSignature,
    agentSessions,
    terminalSessions,
    terminalQuickSessions,
    terminalGroupStates,
    enqueueMutation,
  ]);

  useEffect(() => {
    if (!legacyStateReady || !ownsControl || !catalog) return;
    void todoTasks;
    void todoAutoExecute;
    enqueueMutation({ kind: 'todos.replace', payload: { todos: buildTodos(catalog) } });
  }, [legacyStateReady, ownsControl, catalog, todoTasks, todoAutoExecute, enqueueMutation]);

  useEffect(() => {
    if (!legacyStateReady || !ownsControl || !catalog || !snapshot) return;
    void editorTabs;
    void editorWorktreeStates;
    void sourceControlSelection;
    void todoAutoExecute;
    enqueueMutation({
      kind: 'selections.replace',
      payload: {
        selections: buildSelections(catalog, snapshot.selections, worktreeState.activeWorktree),
      },
    });
  }, [
    legacyStateReady,
    ownsControl,
    catalog,
    snapshot,
    worktreeState.activeWorktree,
    editorTabs,
    editorWorktreeStates,
    sourceControlSelection,
    todoAutoExecute,
    enqueueMutation,
  ]);

  useEffect(() => {
    if (
      legacyImportCompletedRef.current ||
      bootstrapReady ||
      !legacyStateReady ||
      !ownsControl ||
      projectionTarget !== 'local' ||
      !catalog
    ) {
      return;
    }
    legacyImportCompletedRef.current = true;
    void (async () => {
      try {
        await migrateTodoLocalStorage();
        if (
          useWorkspaceMirrorStore.getState().projectionTarget !== 'local' ||
          !useWorkspaceMirrorStore.getState().ownsControl
        ) {
          throw new Error('workspace target changed during legacy import');
        }
        const todoStore = useTodoStore.getState();
        await Promise.all(
          Object.values(catalog.repositories).map((repository) =>
            todoStore.loadTasksForMigration(repository.path)
          )
        );
        if (useWorkspaceMirrorStore.getState().projectionTarget !== 'local') {
          throw new Error('workspace target changed while loading legacy Todo data');
        }
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        });
        await publishTail.current;
        if (useWorkspaceMirrorStore.getState().projectionTarget !== 'local') {
          throw new Error('workspace target changed while publishing legacy state');
        }
        const mirrorSnapshot = useWorkspaceMirrorStore.getState().snapshot;
        if (!mirrorSnapshot) throw new Error('workspace mirror is not hydrated');
        await enqueueMutation({
          kind: 'scene.replace',
          payload: buildSceneReplacement(
            catalog,
            mirrorSnapshot,
            repositoryStateRef.current,
            worktreeStateRef.current
          ),
        });
        if (useWorkspaceMirrorStore.getState().projectionTarget !== 'local') {
          throw new Error('workspace target changed before legacy import commit');
        }
        await window.electronAPI.workspaceMirror.completeLegacyImport();
        useWorkspaceMirrorStore.setState({ bootstrapReady: true });
      } catch (error) {
        legacyImportCompletedRef.current = false;
        console.warn('[workspace-mirror] failed to complete legacy import', error);
      }
    })();
  }, [legacyStateReady, ownsControl, projectionTarget, bootstrapReady, catalog, enqueueMutation]);
}
