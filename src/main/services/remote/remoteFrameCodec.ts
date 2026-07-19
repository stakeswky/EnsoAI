import type {
  RemoteEvFrame,
  RemoteFrame,
  RemoteHelloFrame,
  RemoteReqFrame,
  RemoteResFrame,
} from '@shared/types';
import { z } from 'zod';

/**
 * V1 keeps a large ceiling because the preview channel can carry a bounded
 * base64 file body. V2 uses much smaller chunk frames and has its own limits.
 */
export const REMOTE_MAX_FRAME_BYTES = 96 * 1024 * 1024;
export const REMOTE_MAX_ARGS = 128;
export const REMOTE_MAX_PAYLOAD_ITEMS = 128;

const hostInfoSchema = z
  .object({
    platform: z.enum(['darwin', 'win32', 'linux']),
    home: z.string().max(4096),
    hostname: z.string().min(1).max(255),
    appVersion: z.string().max(128),
  })
  .strict();

const reqSchema = z
  .object({
    t: z.literal('req'),
    id: z.number().int().nonnegative(),
    ch: z.string().min(1).max(256),
    args: z.array(z.unknown()).max(REMOTE_MAX_ARGS),
  })
  .strict();

const resSchema = z
  .object({
    t: z.literal('res'),
    id: z.number().int().nonnegative(),
    ok: z.boolean(),
    result: z.unknown().optional(),
    error: z.string().max(4096).optional(),
  })
  .strict();

const evSchema = z
  .object({
    t: z.literal('ev'),
    ch: z.string().min(1).max(256),
    payload: z.array(z.unknown()).max(REMOTE_MAX_PAYLOAD_ITEMS),
  })
  .strict();

const helloSchema = z
  .object({
    t: z.literal('hello'),
    protocolVersion: z.number().int().positive(),
    host: hostInfoSchema,
  })
  .strict();

const protocolErrorSchema = z
  .object({
    t: z.literal('protocol.error'),
    code: z.literal('UPGRADE_REQUIRED'),
    message: z.string().min(1).max(4096),
  })
  .strict();

const frameSchema = z.discriminatedUnion('t', [
  reqSchema,
  resSchema,
  evSchema,
  helloSchema,
  protocolErrorSchema,
]);

export class RemoteProtocolError extends Error {
  readonly code = 'REMOTE_PROTOCOL_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'RemoteProtocolError';
  }
}

function frameText(raw: string | Buffer): string {
  if (Buffer.isBuffer(raw)) {
    if (raw.byteLength > REMOTE_MAX_FRAME_BYTES) {
      throw new RemoteProtocolError('remote frame exceeds size limit');
    }
    return raw.toString('utf8');
  }
  if (Buffer.byteLength(raw, 'utf8') > REMOTE_MAX_FRAME_BYTES) {
    throw new RemoteProtocolError('remote frame exceeds size limit');
  }
  return raw;
}

/** Parse and validate a V1 frame before any handler or renderer side effect. */
export function parseRemoteFrame(raw: string | Buffer): RemoteFrame {
  const text = frameText(raw);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new RemoteProtocolError('remote frame is not valid JSON');
  }

  const result = frameSchema.safeParse(parsed);
  if (!result.success) {
    throw new RemoteProtocolError('remote frame failed schema validation');
  }
  return result.data as RemoteFrame;
}

export function isRemoteRequestFrame(frame: RemoteFrame): frame is RemoteReqFrame {
  return frame.t === 'req';
}

export function isRemoteResponseFrame(frame: RemoteFrame): frame is RemoteResFrame {
  return frame.t === 'res';
}

export function isRemoteEventFrame(frame: RemoteFrame): frame is RemoteEvFrame {
  return frame.t === 'ev';
}

export function isRemoteHelloFrame(frame: RemoteFrame): frame is RemoteHelloFrame {
  return frame.t === 'hello';
}
