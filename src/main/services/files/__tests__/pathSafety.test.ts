import { describe, expect, it } from 'vitest';
import { validateBatchTargetName } from '../pathSafety';

describe('batch file target safety', () => {
  it('accepts one filename and rejects path traversal', () => {
    expect(validateBatchTargetName('renamed file.txt')).toBe('renamed file.txt');

    for (const candidate of ['', '.', '..', '../outside.txt', 'nested/outside.txt', 'bad\0name']) {
      expect(() => validateBatchTargetName(candidate)).toThrow(/Invalid conflict rename target/);
    }
  });
});
