import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspaceMirrorStore } from '../../stores/workspaceMirror';
import {
  getRepositorySettings,
  projectRepositorySettings,
  STORAGE_KEYS,
  saveRepositorySettings,
} from '../storage';

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => values.set(key, value),
  };
}

describe('repository settings workspace projection', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', memoryStorage());
    projectRepositorySettings(null);
    useWorkspaceMirrorStore.setState({ projectionTarget: 'local', ownsControl: false });
  });

  it('imports legacy settings before cutover and stops dual-writing after projection', () => {
    saveRepositorySettings('/repo', {
      autoInitWorktree: true,
      initScript: 'pnpm install',
      hidden: false,
    });
    expect(localStorage.getItem(STORAGE_KEYS.REPOSITORY_SETTINGS)).toContain('pnpm install');

    projectRepositorySettings({
      '/repo': { autoInitWorktree: false, initScript: '', hidden: true },
    });
    saveRepositorySettings('/repo', {
      autoInitWorktree: true,
      initScript: 'pnpm test',
      hidden: false,
    });

    expect(getRepositorySettings('/repo')).toEqual({
      autoInitWorktree: true,
      initScript: 'pnpm test',
      hidden: false,
    });
    expect(localStorage.getItem(STORAGE_KEYS.REPOSITORY_SETTINGS)).toContain('pnpm install');
  });

  it('rejects remote observer writes but accepts controller writes', () => {
    projectRepositorySettings({
      '/remote/repo': { autoInitWorktree: false, initScript: '', hidden: false },
    });
    useWorkspaceMirrorStore.setState({ projectionTarget: 'remote', ownsControl: false });
    saveRepositorySettings('/remote/repo', {
      autoInitWorktree: false,
      initScript: '',
      hidden: true,
    });
    expect(getRepositorySettings('/remote/repo').hidden).toBe(false);

    useWorkspaceMirrorStore.setState({ projectionTarget: 'transitioning', ownsControl: true });
    saveRepositorySettings('/remote/repo', {
      autoInitWorktree: false,
      initScript: '',
      hidden: true,
    });
    expect(getRepositorySettings('/remote/repo').hidden).toBe(false);

    useWorkspaceMirrorStore.setState({ projectionTarget: 'remote', ownsControl: true });
    saveRepositorySettings('/remote/repo', {
      autoInitWorktree: false,
      initScript: '',
      hidden: true,
    });
    expect(getRepositorySettings('/remote/repo').hidden).toBe(true);
  });
});
