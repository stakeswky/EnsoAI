import { useEffect } from 'react';
import { isLocalWorkspaceProjection } from '@/stores/workspaceMirror';
import { ALL_GROUP_ID } from '../constants';

export function useGroupSync(
  hideGroups: boolean,
  activeGroupId: string,
  setActiveGroupId: (id: string) => void,
  saveActiveGroupId: (id: string) => void
) {
  useEffect(() => {
    if (hideGroups && activeGroupId !== ALL_GROUP_ID) {
      setActiveGroupId(ALL_GROUP_ID);
      if (isLocalWorkspaceProjection()) {
        saveActiveGroupId(ALL_GROUP_ID);
      }
    }
  }, [hideGroups, activeGroupId, setActiveGroupId, saveActiveGroupId]);
}
