import type { TerminalSession } from '@shared/types';
import { create } from 'zustand';
import type { TerminalGroup } from '@/components/terminal/types';

export interface TerminalWorktreeGroupState {
  groups: TerminalGroup[];
  activeGroupId: string | null;
  flexPercents: number[];
  originalPath?: string;
}

export type TerminalWorktreeGroupStates = Record<string, TerminalWorktreeGroupState>;

export function createInitialTerminalGroupState(originalPath = ''): TerminalWorktreeGroupState {
  return { groups: [], activeGroupId: null, flexPercents: [], originalPath };
}

interface TerminalState {
  sessions: TerminalSession[];
  activeSessionId: string | null;
  quickTerminalSessions: Record<string, string>; // worktreePath -> sessionId
  worktreeGroupStates: TerminalWorktreeGroupStates;

  addSession: (session: TerminalSession) => void;
  removeSession: (id: string) => void;
  setActiveSession: (id: string | null) => void;
  updateSession: (id: string, updates: Partial<TerminalSession>) => void;
  syncSessions: (sessions: TerminalSession[]) => void;

  // Quick Terminal session management
  setQuickTerminalSession: (worktreePath: string, sessionId: string) => void;
  getQuickTerminalSession: (worktreePath: string) => string | undefined;
  getAllQuickTerminalCwds: () => string[];
  removeQuickTerminalSession: (worktreePath: string) => void;
  setWorktreeGroupStates: (
    updater:
      | TerminalWorktreeGroupStates
      | ((current: TerminalWorktreeGroupStates) => TerminalWorktreeGroupStates)
  ) => void;
}

export const useTerminalStore = create<TerminalState>((set, get) => ({
  sessions: [],
  activeSessionId: null,
  quickTerminalSessions: {},
  worktreeGroupStates: {},

  addSession: (session) =>
    set((state) => ({
      sessions: [...state.sessions, session],
      activeSessionId: session.id,
    })),
  removeSession: (id) =>
    set((state) => ({
      sessions: state.sessions.filter((s) => s.id !== id),
      activeSessionId:
        state.activeSessionId === id
          ? state.sessions.find((s) => s.id !== id)?.id || null
          : state.activeSessionId,
    })),
  setActiveSession: (id) => set({ activeSessionId: id }),
  updateSession: (id, updates) =>
    set((state) => ({
      sessions: state.sessions.map((s) => (s.id === id ? { ...s, ...updates } : s)),
    })),
  syncSessions: (sessions) => set({ sessions }),

  setQuickTerminalSession: (worktreePath, sessionId) =>
    set((state) => ({
      quickTerminalSessions: { ...state.quickTerminalSessions, [worktreePath]: sessionId },
    })),
  getQuickTerminalSession: (worktreePath) => get().quickTerminalSessions[worktreePath],
  getAllQuickTerminalCwds: () => Object.keys(get().quickTerminalSessions),
  removeQuickTerminalSession: (worktreePath) =>
    set((state) => {
      const { [worktreePath]: _, ...rest } = state.quickTerminalSessions;
      return { quickTerminalSessions: rest };
    }),
  setWorktreeGroupStates: (updater) =>
    set((state) => ({
      worktreeGroupStates:
        typeof updater === 'function' ? updater(state.worktreeGroupStates) : updater,
    })),
}));
