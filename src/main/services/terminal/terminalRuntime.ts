import { PtyManager } from './PtyManager';
import { TerminalSessionRegistry } from './TerminalSessionRegistry';

/** Shared terminal authority used by local IPC and Remote Mirror V2 streams. */
export const ptyManager = new PtyManager();
export const terminalSessionRegistry = new TerminalSessionRegistry(ptyManager);
