import { describe, expect, it } from 'vitest';
import { GitService } from '../GitService';

describe('GitService object ID validation', () => {
  it('rejects option-like revisions before invoking Git', async () => {
    const service = new GitService(process.cwd());

    await expect(service.showCommit('--output=/tmp/escaped')).rejects.toThrow(
      'Invalid Git object ID'
    );
    await expect(service.getCommitFiles('-p')).rejects.toThrow('Invalid Git object ID');
    await expect(service.getCommitDiff('--output=/tmp/escaped', 'file.ts')).rejects.toThrow(
      'Invalid Git object ID'
    );
  });
});
