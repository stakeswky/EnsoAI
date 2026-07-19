import { randomUUID } from 'node:crypto';
import {
  IPC_CHANNELS,
  type TerminalAttachOptions,
  type TerminalCreateOptions,
  type TerminalResizeOptions,
} from '@shared/types';
import { ipcMain, type WebContents } from 'electron';
import type { TerminalStreamEvent } from '../services/terminal/TerminalSessionRegistry';
import { ptyManager, terminalSessionRegistry } from '../services/terminal/terminalRuntime';
import { getWorkspaceMirrorService } from '../services/workspace/workspaceMirrorRuntime';

export { ptyManager, terminalSessionRegistry } from '../services/terminal/terminalRuntime';

const terminalCleanupOwners = new Set<number>();

function terminalSubscriberId(sender: WebContents): string {
  return `renderer:${sender.id}`;
}

function sendPersistentTerminalEvent(sender: WebContents, event: TerminalStreamEvent): void {
  if (sender.isDestroyed()) return;
  if (event.type === 'stream.data') {
    sender.send(IPC_CHANNELS.TERMINAL_DATA, {
      id: event.sessionId,
      data: event.data,
      streamSeq: event.streamSeq,
    });
    return;
  }
  if (event.type === 'stream.reset') {
    sender.send(IPC_CHANNELS.TERMINAL_STREAM_RESET, {
      id: event.sessionId,
      reason: event.reason,
      retainedFromSeq: event.retainedFromSeq,
      currentStreamSeq: event.currentStreamSeq,
    });
    return;
  }
  sender.send(IPC_CHANNELS.TERMINAL_EXIT, {
    id: event.sessionId,
    exitCode: event.exitCode ?? 0,
    signal: event.signal,
  });
}

function ensureTerminalCleanup(sender: WebContents): void {
  const ownerId = sender.id;
  if (terminalCleanupOwners.has(ownerId)) {
    return;
  }

  terminalCleanupOwners.add(ownerId);
  sender.once('destroyed', () => {
    terminalCleanupOwners.delete(ownerId);
    terminalSessionRegistry.detachSubscriber(terminalSubscriberId(sender));
    // V1/legacy sessions still retain sender-owned destruction semantics.
    ptyManager.destroyByOwner(ownerId);
  });
}

async function commitPersistentTerminalScene(
  sessionId: string,
  options: TerminalCreateOptions,
  processState: 'starting' | 'running' | 'exited' | 'terminated',
  exitCode: number | null = null
): Promise<void> {
  let service: ReturnType<typeof getWorkspaceMirrorService>;
  try {
    service = getWorkspaceMirrorService();
  } catch {
    // Keep the legacy adapter usable in isolated tests/embedded runtimes.
    return;
  }
  await service.dispatchHostMutationFactory((snapshot) => {
    const current = snapshot.terminals.sessions[sessionId];
    const normalizedCwd = (options.cwd ?? '').replace(/\\/g, '/').replace(/\/+$/, '');
    const worktree =
      (options.workspaceId ? snapshot.catalog.worktrees[options.workspaceId] : undefined) ??
      Object.values(snapshot.catalog.worktrees).find(
        (candidate) => candidate.path.replace(/\\/g, '/').replace(/\/+$/, '') === normalizedCwd
      );
    const terminals = structuredClone(snapshot.terminals);
    terminals.sessions[sessionId] = {
      ...(current ?? {
        id: sessionId,
        generation: 1,
        repositoryId: worktree?.repositoryId ?? null,
        worktreeId: worktree?.id ?? null,
        title: options.title ?? 'Terminal',
        cwd: options.cwd ?? '/',
        groupId: null,
        order: Object.keys(terminals.sessions).length,
        processState: 'starting',
        exitCode: null,
      }),
      processState,
      exitCode,
    };
    return { mutation: { kind: 'terminals.replace', payload: { terminals } }, result: undefined };
  }, 'host');
}

export function destroyAllTerminals(): void {
  terminalCleanupOwners.clear();
  terminalSessionRegistry.destroyAll();
  ptyManager.destroyAll();
}

/**
 * Destroy all terminals and wait for them to fully exit.
 * This should be used during app shutdown to prevent crashes.
 */
export async function destroyAllTerminalsAndWait(): Promise<void> {
  terminalCleanupOwners.clear();
  terminalSessionRegistry.destroyAll();
  await ptyManager.destroyAllAndWait();
}

export function registerTerminalHandlers(): void {
  ipcMain.handle(
    IPC_CHANNELS.TERMINAL_CREATE,
    async (event, options: TerminalCreateOptions = {}) => {
      ensureTerminalCleanup(event.sender);
      const ownerId = event.sender.id;

      if (options.persistent || options.sessionId) {
        const sessionId = options.sessionId ?? `terminal-${randomUUID()}`;
        const alreadyRegistered = terminalSessionRegistry.has(sessionId);
        if (!alreadyRegistered) {
          await commitPersistentTerminalScene(sessionId, options, 'starting');
        }
        try {
          const id = terminalSessionRegistry.create(options, {
            sessionId,
            title: options.title,
            workspaceId: options.workspaceId,
          });
          const metadata = terminalSessionRegistry.getMetadata(id);
          await commitPersistentTerminalScene(
            id,
            options,
            metadata?.status === 'exited' ? 'exited' : 'running',
            metadata?.status === 'exited' ? (metadata.exitCode ?? null) : null
          );
          return id;
        } catch (error) {
          if (!alreadyRegistered) {
            await commitPersistentTerminalScene(sessionId, options, 'terminated').catch(() => {});
          }
          throw error;
        }
      }

      const id = ptyManager.create(
        options,
        (data) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send(IPC_CHANNELS.TERMINAL_DATA, { id, data });
          }
        },
        (exitCode, signal) => {
          if (!event.sender.isDestroyed()) {
            event.sender.send(IPC_CHANNELS.TERMINAL_EXIT, { id, exitCode, signal });
          }
        },
        ownerId
      );

      return id;
    }
  );

  ipcMain.handle(
    IPC_CHANNELS.TERMINAL_ATTACH,
    async (event, id: string, options: TerminalAttachOptions = {}) => {
      ensureTerminalCleanup(event.sender);
      return terminalSessionRegistry.attach(id, {
        subscriberId: terminalSubscriberId(event.sender),
        afterStreamSeq: options.afterStreamSeq,
        onEvent: (streamEvent) => sendPersistentTerminalEvent(event.sender, streamEvent),
      });
    }
  );

  ipcMain.handle(IPC_CHANNELS.TERMINAL_DETACH, async (event, id: string) => {
    return terminalSessionRegistry.detach(id, terminalSubscriberId(event.sender));
  });

  ipcMain.handle(IPC_CHANNELS.TERMINAL_LIST_PERSISTENT, async () => {
    return terminalSessionRegistry.list();
  });

  ipcMain.handle(IPC_CHANNELS.TERMINAL_WRITE, async (_, id: string, data: string) => {
    if (!terminalSessionRegistry.write(id, data)) {
      ptyManager.write(id, data);
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.TERMINAL_RESIZE,
    async (_, id: string, size: TerminalResizeOptions) => {
      if (!terminalSessionRegistry.resize(id, size.cols, size.rows)) {
        ptyManager.resize(id, size.cols, size.rows);
      }
    }
  );

  ipcMain.handle(IPC_CHANNELS.TERMINAL_DESTROY, async (_, id: string) => {
    if (!terminalSessionRegistry.destroy(id)) {
      ptyManager.destroy(id);
    }
  });

  ipcMain.handle(IPC_CHANNELS.TERMINAL_GET_ACTIVITY, async (_, id: string) => {
    if (terminalSessionRegistry.has(id)) {
      return terminalSessionRegistry.getActivity(id);
    }
    return ptyManager.getProcessActivity(id);
  });

  ipcMain.on(
    IPC_CHANNELS.TERMINAL_STREAM_ACK,
    async (event, id: string, payload: { streamSeq: number; creditBytes: number }) => {
      if (typeof id === 'string' && id.startsWith('remote:')) {
        const { remoteClientManager } = await import('../services/remote/RemoteClientManager');
        remoteClientManager.ackStream(event.sender.id, id, payload);
      }
    }
  );
}
