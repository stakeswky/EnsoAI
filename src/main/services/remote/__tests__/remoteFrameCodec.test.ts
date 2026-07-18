import { describe, expect, it } from 'vitest';
import {
  isRemoteHelloFrame,
  isRemoteRequestFrame,
  parseRemoteFrame,
  REMOTE_MAX_FRAME_BYTES,
} from '../remoteFrameCodec';

describe('remote frame codec', () => {
  it('parses a valid request without invoking any handler', () => {
    const frame = parseRemoteFrame(
      JSON.stringify({ t: 'req', id: 3, ch: 'git:status', args: ['/repo'] })
    );
    expect(isRemoteRequestFrame(frame)).toBe(true);
    expect(frame).toEqual({ t: 'req', id: 3, ch: 'git:status', args: ['/repo'] });
  });

  it('rejects malformed, unknown, and extra frame fields', () => {
    expect(() => parseRemoteFrame('{"t":"req","id":1,"ch":"git:status"}')).toThrow(
      /schema validation/
    );
    expect(() => parseRemoteFrame('{"t":"secret","payload":[]}')).toThrow(/schema validation/);
    expect(() =>
      parseRemoteFrame(
        '{"t":"hello","protocolVersion":1,"host":{"platform":"darwin","home":"/","hostname":"h","appVersion":"1"},"extra":true}'
      )
    ).toThrow(/schema validation/);
  });

  it('rejects invalid JSON and oversized frames before decoding', () => {
    expect(() => parseRemoteFrame('{broken')).toThrow(/valid JSON/);
    expect(() => parseRemoteFrame('x'.repeat(REMOTE_MAX_FRAME_BYTES + 1))).toThrow(/size limit/);
  });

  it('keeps hello validation strict and typed', () => {
    const frame = parseRemoteFrame(
      JSON.stringify({
        t: 'hello',
        protocolVersion: 1,
        host: { platform: 'linux', home: '/home/enso', hostname: 'host', appVersion: '0.2.44' },
      })
    );
    expect(isRemoteHelloFrame(frame)).toBe(true);
  });
});
