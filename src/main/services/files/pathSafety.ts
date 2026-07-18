import { basename } from 'node:path';

/** Keep conflict-renamed batch targets inside the selected destination directory. */
export function validateBatchTargetName(candidate: string | undefined): string {
  const normalized = candidate?.trim();
  if (
    !normalized ||
    normalized === '.' ||
    normalized === '..' ||
    basename(normalized) !== normalized ||
    /[\0\r\n]/.test(normalized)
  ) {
    throw new Error('Invalid conflict rename target');
  }
  return normalized;
}
