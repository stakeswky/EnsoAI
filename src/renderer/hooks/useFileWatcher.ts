import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { useRemoteStore } from '@/stores/remote';
import { useShouldPoll } from './useWindowFocus';

interface FileChangeEvent {
  type: 'create' | 'update' | 'delete';
  path: string;
}

export function useFileWatcher(dirPath: string | null) {
  const [changes, setChanges] = useState<FileChangeEvent[]>([]);
  const queryClient = useQueryClient();
  const shouldPoll = useShouldPoll();
  const remoteConnectionState = useRemoteStore((state) => state.status?.state);

  const handleChange = useCallback(
    (event: FileChangeEvent) => {
      setChanges((prev) => [...prev.slice(-99), event]);
      queryClient.invalidateQueries({ queryKey: ['file', 'list', dirPath] });
    },
    [dirPath, queryClient]
  );

  useEffect(() => {
    void remoteConnectionState;
    if (!dirPath || !shouldPoll) return;

    window.electronAPI.file.watchStart(dirPath);
    const unsubscribe = window.electronAPI.file.onChange(handleChange);

    return () => {
      unsubscribe();
      window.electronAPI.file.watchStop(dirPath);
    };
  }, [dirPath, handleChange, shouldPoll, remoteConnectionState]);

  const clearChanges = useCallback(() => {
    setChanges([]);
  }, []);

  return { changes, clearChanges };
}
