import { describe, expect, it } from 'vitest';
import { parseWorkspaceMirrorV2Frame } from '../workspaceMirrorFrames';

const invalidFrames: Array<[string, unknown]> = [
  ['unknown type', { t: 'root.shell', command: 'rm -rf /' }],
  [
    'extra privileged field',
    {
      t: 'clientHello',
      protocolVersions: [2],
      schemaVersions: [1],
      deviceId: 'device',
      clientId: 'client',
      capabilities: [],
      resumeCursor: null,
      token: 'canary-secret',
    },
  ],
  [
    'negative revision',
    {
      t: 'state.subscribe',
      requestId: 'request',
      mode: 'resume',
      cursor: { hostEpoch: '11111111-1111-4111-8111-111111111111', sceneId: 'scene', revision: -1 },
    },
  ],
  [
    'forged stream dimensions',
    {
      t: 'stream.resize',
      streamId: 'stream',
      streamKind: 'terminal',
      entityId: 'terminal',
      entityGeneration: 1,
      operationId: 'operation',
      cols: 0,
      rows: 1001,
    },
  ],
  [
    'invalid public key encoding',
    {
      t: 'auth.proof',
      deviceId: 'device',
      nonce: 'n'.repeat(32),
      signature: 's'.repeat(64),
      publicKey: '../../../private-key',
    },
  ],
  ['unexpected response before handshake', { t: 'state.intentResult', accepted: true }],
];

describe('Remote Mirror malformed protocol corpus', () => {
  it.each(invalidFrames)('rejects %s without returning a parsed command', (_name, frame) => {
    expect(() => parseWorkspaceMirrorV2Frame(JSON.stringify(frame))).toThrow();
  });

  it('rejects invalid JSON, binary-shaped data, and oversized frames', () => {
    expect(() => parseWorkspaceMirrorV2Frame('{')).toThrow(/valid JSON/);
    expect(() => parseWorkspaceMirrorV2Frame(Buffer.from([0, 255, 1]))).toThrow();
    expect(() => parseWorkspaceMirrorV2Frame('x'.repeat(2 * 1024 * 1024 + 1))).toThrow(
      /size limit/
    );
  });
});
