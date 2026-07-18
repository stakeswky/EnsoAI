import { REMOTE_FS_READ_FILE_CHANNEL, type RemoteFileReadResult } from '@shared/types';
import { remoteClientManager } from './RemoteClientManager';

/** Max file size served over the remote preview channel (base64 over WS) */
export const REMOTE_PREVIEW_MAX_BYTES = 64 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ogg': 'video/ogg',
  '.mov': 'video/quicktime',
};

export function mimeForExtension(ext: string): string {
  return MIME_BY_EXT[ext.toLowerCase()] ?? 'application/octet-stream';
}

/**
 * When this instance is attached to a remote host, preview paths refer to
 * files on the host. Fetch the bytes over the remote connection and wrap
 * them in a protocol Response. Returns null when there is no active remote
 * connection or the remote read fails (caller falls back to local serving).
 */
export async function tryFetchRemoteFileResponse(filePath: string): Promise<Response | null> {
  if (!remoteClientManager.hasActiveConnection()) {
    return null;
  }
  try {
    const result = (await remoteClientManager.requestViaAnyConnection(REMOTE_FS_READ_FILE_CHANNEL, [
      filePath,
    ])) as RemoteFileReadResult;
    return new Response(Buffer.from(result.data, 'base64'), {
      status: 200,
      headers: {
        'Content-Type': result.mime,
        'Cache-Control': 'no-cache',
      },
    });
  } catch {
    return null;
  }
}
