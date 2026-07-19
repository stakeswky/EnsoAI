import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ALL_GROUP_ID } from '../../constants';

const mocks = vi.hoisted(() => ({
  isLocalWorkspaceProjection: vi.fn(),
  useEffect: vi.fn((effect: () => void) => effect()),
}));

vi.mock('react', () => ({ useEffect: mocks.useEffect }));
vi.mock('@/stores/workspaceMirror', () => ({
  isLocalWorkspaceProjection: mocks.isLocalWorkspaceProjection,
}));

import { useGroupSync } from '../useGroupSync';

beforeEach(() => {
  mocks.isLocalWorkspaceProjection.mockReset();
  mocks.useEffect.mockClear();
});

describe('useGroupSync projection persistence', () => {
  it('updates hidden-group UI state without persisting a non-local projection', () => {
    mocks.isLocalWorkspaceProjection.mockReturnValue(false);
    const setActiveGroupId = vi.fn();
    const saveActiveGroupId = vi.fn();

    useGroupSync(true, 'group-1', setActiveGroupId, saveActiveGroupId);

    expect(setActiveGroupId).toHaveBeenCalledWith(ALL_GROUP_ID);
    expect(saveActiveGroupId).not.toHaveBeenCalled();
  });

  it('persists the hidden-group reset for a local projection', () => {
    mocks.isLocalWorkspaceProjection.mockReturnValue(true);
    const setActiveGroupId = vi.fn();
    const saveActiveGroupId = vi.fn();

    useGroupSync(true, 'group-1', setActiveGroupId, saveActiveGroupId);

    expect(setActiveGroupId).toHaveBeenCalledWith(ALL_GROUP_ID);
    expect(saveActiveGroupId).toHaveBeenCalledWith(ALL_GROUP_ID);
  });
});
