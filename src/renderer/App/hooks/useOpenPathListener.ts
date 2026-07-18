import { getPathBasename } from '@shared/utils/path';
import { useEffect } from 'react';
import type { Repository, TabId } from '../constants';
import { pathsEqual } from '../storage';

interface UseOpenPathListenerOptions {
  repositories: Repository[];
  saveRepositories: (repos: Repository[]) => void;
  setSelectedRepo: (repo: string) => void;
  onSwitchWorktree: (path: string) => void;
  onSwitchTab: (tab: TabId) => void;
  tempWorkspaces: Array<{ path: string }>;
}

/**
 * Legacy deep-link listener for the APP_OPEN_PATH channel (--open-path / CLI).
 *
 * Mirrors useOpenContextListener's path branch for a single path: a temp
 * workspace switches the active worktree, a known repo is selected, and an
 * unknown path is registered as a new repository on the fly. Always lands the
 * user on the chat tab so an externally-opened path surfaces the agent.
 */
export function useOpenPathListener({
  repositories,
  saveRepositories,
  setSelectedRepo,
  onSwitchWorktree,
  onSwitchTab,
  tempWorkspaces,
}: UseOpenPathListenerOptions) {
  useEffect(() => {
    const cleanup = window.electronAPI.app.onOpenPath((rawPath) => {
      const path = rawPath.replace(/[\\/]+$/, '').replace(/^["']|["']$/g, '');
      if (!path) return;

      const tempMatch = tempWorkspaces.find((item) => item.path === path);
      if (tempMatch) {
        onSwitchWorktree(tempMatch.path);
      } else {
        const existingRepo = repositories.find((r) => pathsEqual(r.path, path));
        if (existingRepo) {
          setSelectedRepo(existingRepo.path);
        } else {
          const name = getPathBasename(path);
          const newRepo: Repository = { name, path };
          const updated = [...repositories, newRepo];
          saveRepositories(updated);
          setSelectedRepo(path);
        }
      }

      onSwitchTab('chat');
    });
    return cleanup;
  }, [
    repositories,
    saveRepositories,
    setSelectedRepo,
    onSwitchWorktree,
    onSwitchTab,
    tempWorkspaces,
  ]);
}
