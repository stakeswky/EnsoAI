import { describe, expect, it } from 'vitest';
import { generateClonePath } from '../gitClone';

describe('generateClonePath', () => {
  it('uses the remote host path separator when one is supplied', () => {
    expect(
      generateClonePath(
        'https://github.com/enso-ai/enso.git',
        'C:\\Users\\host\\ensoai\\repos',
        [],
        true,
        '\\'
      )
    ).toMatchObject({
      targetDir: 'C:\\Users\\host\\ensoai\\repos\\github.com\\enso-ai',
      fullPath: 'C:\\Users\\host\\ensoai\\repos\\github.com\\enso-ai\\enso',
    });
  });
});
