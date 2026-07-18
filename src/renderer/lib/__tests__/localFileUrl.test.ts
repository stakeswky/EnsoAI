import { describe, expect, it } from 'vitest';
import { toLocalFileUrl } from '../localFileUrl';

describe('local-file URL conversion', () => {
  it('maps opaque workspace resources to the reserved resource endpoint', () => {
    expect(toLocalFileUrl('enso-resource://resource-abc:1')).toBe(
      'local-file://resource/resource-abc%3A1'
    );
  });

  it('does not reinterpret malformed opaque references as filesystem paths', () => {
    const url = toLocalFileUrl('enso-resource://../../secret');
    expect(url).toBe('local-file://resource/');
    expect(url).not.toContain('secret');
  });
});
