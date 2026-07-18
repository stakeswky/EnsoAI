import type { FileEntry } from '@shared/types';
import { ArrowUp, Folder, Loader2 } from 'lucide-react';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogFooter, DialogPopup, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/i18n';
import { useEffectiveEnv } from '@/stores/remote';

interface RemoteDirectoryPickerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the selected absolute path on the remote host */
  onSelect: (path: string) => void;
  initialPath?: string;
}

function parentOf(dirPath: string, pathSep: string): string | null {
  const trimmed = dirPath.replace(/[/\\]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (idx <= 0) {
    return trimmed.length > 1 ? pathSep : null;
  }
  const parent = trimmed.slice(0, idx);
  // Keep drive root like "C:" navigable as "C:\"
  return parent.endsWith(':') ? parent + pathSep : parent;
}

function joinPath(dirPath: string, name: string, pathSep: string): string {
  return dirPath.endsWith(pathSep) ? `${dirPath}${name}` : `${dirPath}${pathSep}${name}`;
}

/**
 * Directory browser for the remote host, replacing the native directory
 * dialog while this window is attached (file:list is forwarded to the host).
 */
export function RemoteDirectoryPicker({
  open,
  onOpenChange,
  onSelect,
  initialPath,
}: RemoteDirectoryPickerProps) {
  const { t } = useI18n();
  const env = useEffectiveEnv();
  const [currentPath, setCurrentPath] = React.useState('');
  const [entries, setEntries] = React.useState<FileEntry[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const loadDir = React.useCallback(async (dirPath: string) => {
    setLoading(true);
    setError(null);
    try {
      const list = await window.electronAPI.file.list(dirPath);
      setEntries(
        list
          .filter((entry) => entry.isDirectory && !entry.name.startsWith('.'))
          .sort((a, b) => a.name.localeCompare(b.name))
      );
      setCurrentPath(dirPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  // (Re)load on open
  // biome-ignore lint/correctness/useExhaustiveDependencies: only reload when the dialog opens
  React.useEffect(() => {
    if (open) {
      void loadDir(initialPath || env.home || env.pathSep);
    }
  }, [open]);

  const parent = parentOf(currentPath, env.pathSep);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="sm:max-w-lg" showCloseButton={true}>
        <div className="border-b px-4 py-3">
          <DialogTitle className="text-base font-medium">
            {t('Select a folder on the remote host')}
          </DialogTitle>
        </div>
        <div className="space-y-2 p-4">
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 shrink-0"
              disabled={!parent || loading}
              onClick={() => parent && void loadDir(parent)}
              title={t('Parent directory')}
            >
              <ArrowUp className="h-4 w-4" />
            </Button>
            <Input
              value={currentPath}
              onChange={(e) => setCurrentPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void loadDir(currentPath);
                }
              }}
              className="h-7 flex-1 text-xs"
              spellCheck={false}
            />
          </div>
          <div className="h-64 overflow-y-auto rounded-md border">
            {loading ? (
              <div className="flex h-full items-center justify-center">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              </div>
            ) : error ? (
              <div className="p-3 text-sm text-destructive">{error}</div>
            ) : entries.length === 0 ? (
              <div className="p-3 text-sm text-muted-foreground">{t('No subfolders')}</div>
            ) : (
              <div className="p-1">
                {entries.map((entry) => (
                  <button
                    type="button"
                    key={entry.path}
                    onClick={() => void loadDir(joinPath(currentPath, entry.name, env.pathSep))}
                    className="flex h-7 w-full items-center gap-2 rounded px-2 text-sm hover:bg-accent/50"
                  >
                    <Folder className="h-4 w-4 shrink-0 text-yellow-500" />
                    <span className="min-w-0 flex-1 truncate text-left">{entry.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('Cancel')}
          </Button>
          <Button
            disabled={!currentPath || loading}
            onClick={() => {
              onSelect(currentPath);
              onOpenChange(false);
            }}
          >
            {t('Select this folder')}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
