import { spawn, spawnSync } from 'node:child_process';
import { execInPty } from '../../utils/shell';

export interface TmuxCheckResult {
  installed: boolean;
  version?: string;
  error?: string;
}

type TmuxRunner = (args: string[]) => Promise<number>;

function runTmux(args: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn('tmux', args, { stdio: 'ignore' });
    let settled = false;
    let timer: NodeJS.Timeout;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new Error('tmux command timed out')));
    }, 5_000);
    child.once('error', (error) => {
      finish(() => reject(error));
    });
    child.once('close', (code) => {
      finish(() =>
        code === null
          ? reject(new Error('tmux command terminated without an exit code'))
          : resolve(code)
      );
    });
  });
}

export class TmuxDetector {
  private cache: TmuxCheckResult | null = null;
  private readonly isWindows: boolean;
  private readonly run: TmuxRunner;

  constructor(options: { platform?: NodeJS.Platform; run?: TmuxRunner } = {}) {
    this.isWindows = (options.platform ?? process.platform) === 'win32';
    this.run = options.run ?? runTmux;
  }

  async check(forceRefresh?: boolean): Promise<TmuxCheckResult> {
    if (this.isWindows) {
      return { installed: false };
    }

    if (this.cache && !forceRefresh) {
      return this.cache;
    }

    try {
      const stdout = await execInPty('tmux -V', { timeout: 5000 });
      const match = stdout.match(/tmux\s+(\d+\.\d+[a-z]?)/i);
      const result: TmuxCheckResult = {
        installed: true,
        version: match ? match[1] : undefined,
      };
      this.cache = result;
      return result;
    } catch {
      const result: TmuxCheckResult = { installed: false };
      this.cache = result;
      return result;
    }
  }

  async killSession(name: string): Promise<void> {
    if (this.isWindows) return;
    this.validateSessionName(name);
    const code = await this.run(['-L', 'enso', 'kill-session', '-t', name]);
    if (code !== 0 && code !== 1) {
      throw new Error(`tmux kill-session exited with code ${code}`);
    }
  }

  async hasSession(name: string): Promise<boolean> {
    if (this.isWindows) return false;
    this.validateSessionName(name);
    const code = await this.run(['-L', 'enso', 'has-session', '-t', name]);
    if (code === 0) return true;
    if (code === 1) return false;
    throw new Error(`tmux has-session exited with code ${code}`);
  }

  async killServer(): Promise<void> {
    if (this.isWindows) return;
    try {
      await execInPty('tmux -L enso kill-server', { timeout: 5000 });
    } catch {
      // Server may already be gone — ignore errors
    }
  }

  killServerSync(): void {
    if (this.isWindows) return;
    try {
      spawnSync('tmux', ['-L', 'enso', 'kill-server'], {
        timeout: 3000,
        stdio: 'ignore',
      });
    } catch {
      // Server may already be gone — ignore errors
    }
  }

  private validateSessionName(name: string): void {
    if (!/^[a-zA-Z0-9_.:-]{1,128}$/.test(name)) {
      throw new Error('Invalid tmux session name');
    }
  }
}

export const tmuxDetector = new TmuxDetector();
