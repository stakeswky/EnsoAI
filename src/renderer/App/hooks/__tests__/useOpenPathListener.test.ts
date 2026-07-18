import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

// Regression guard for the APP_OPEN_PATH deep-link listener.
//
// useOpenPathListener must accept the same options-object signature as its
// sibling useOpenContextListener. A positional-arg signature silently breaks
// the object-form call site in App.tsx — tsc reports
// "Expected 3 arguments, but got 1" and the hook would crash at runtime
// (the options object gets bound to the `repositories` array param).
describe('useOpenPathListener signature', () => {
  const source = fs.readFileSync(path.join(__dirname, '../useOpenPathListener.ts'), 'utf-8');

  it('accepts a destructured options object rather than positional arguments', () => {
    expect(source).toMatch(/useOpenPathListener\(\{/);
  });

  it('handles the worktree / tab / temp-workspace inputs the call site passes', () => {
    expect(source).toContain('onSwitchWorktree');
    expect(source).toContain('onSwitchTab');
    expect(source).toContain('tempWorkspaces');
  });
});
