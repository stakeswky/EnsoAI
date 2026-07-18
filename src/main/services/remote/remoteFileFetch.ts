import { createHash } from 'node:crypto';
import {
  type RemoteFileReadResult,
  WORKSPACE_MIRROR_MAX_RESOURCE_BASE64_LENGTH,
  WORKSPACE_MIRROR_MAX_RESOURCE_BYTES,
  WorkspaceResourceReferenceSchema,
} from '@shared/types';
import type { WorkspaceResourceFetchResult } from '../workspace/WorkspaceResourceService';
import { getWorkspaceResourceService } from '../workspace/workspaceMirrorRuntime';
import { remoteClientManager } from './RemoteClientManager';

/** Max file size served over the remote preview channel (base64 over WS) */
export const REMOTE_PREVIEW_MAX_BYTES = 10 * 1024 * 1024;

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

export function remoteFileResultToResponse(candidate: unknown): Response {
  if (!candidate || typeof candidate !== 'object') {
    throw new Error('invalid remote file response');
  }
  const result = candidate as Partial<RemoteFileReadResult>;
  const maxBase64Length = Math.ceil(REMOTE_PREVIEW_MAX_BYTES / 3) * 4;
  if (
    typeof result.data !== 'string' ||
    result.data.length > maxBase64Length ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(result.data) ||
    typeof result.mime !== 'string' ||
    !/^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/.test(result.mime) ||
    !Number.isSafeInteger(result.size) ||
    (result.size ?? -1) < 0 ||
    (result.size ?? 0) > REMOTE_PREVIEW_MAX_BYTES
  ) {
    throw new Error('invalid remote file response');
  }
  const data = Buffer.from(result.data, 'base64');
  if (data.toString('base64') !== result.data || data.byteLength !== result.size) {
    throw new Error('remote file size mismatch');
  }
  return new Response(data, {
    status: 200,
    headers: {
      'Content-Type': result.mime,
      'Content-Length': String(data.byteLength),
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

/**
 * When this instance is attached to a remote host, preview paths refer to
 * files on the host. Fetch the bytes over the remote connection and wrap
 * them in a protocol Response. Returns null when there is no active remote
 * connection. Once any remote target is active, failures return a closed
 * response instead of falling through to a coincidentally equal local path.
 */
export async function tryFetchRemoteFileResponse(filePath: string): Promise<Response | null> {
  if (!remoteClientManager.hasActiveConnection()) {
    return null;
  }
  try {
    return remoteFileResultToResponse(await remoteClientManager.requestRemoteFile(filePath));
  } catch {
    return new Response('Remote file unavailable', { status: 502 });
  }
}

export function workspaceResourceResultToResponse(
  resourceId: string,
  candidate: unknown
): Response {
  if (!candidate || typeof candidate !== 'object') {
    throw new Error('invalid workspace resource response');
  }

  const result = candidate as Partial<WorkspaceResourceFetchResult>;
  const parsedReference = WorkspaceResourceReferenceSchema.safeParse(result.reference);
  if (!parsedReference.success || parsedReference.data.id !== resourceId) {
    throw new Error('workspace resource reference mismatch');
  }

  const encoded = result.data;
  if (
    typeof encoded !== 'string' ||
    encoded.length > WORKSPACE_MIRROR_MAX_RESOURCE_BASE64_LENGTH ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)
  ) {
    throw new Error('invalid workspace resource bytes');
  }

  const data = Buffer.from(encoded, 'base64');
  if (
    data.byteLength > WORKSPACE_MIRROR_MAX_RESOURCE_BYTES ||
    data.toString('base64') !== encoded ||
    data.byteLength !== parsedReference.data.size ||
    createHash('sha256').update(data).digest('hex') !== parsedReference.data.checksum
  ) {
    throw new Error('workspace resource checksum mismatch');
  }

  return new Response(data, {
    status: 200,
    headers: {
      'Content-Type': parsedReference.data.mime,
      'Content-Length': String(data.byteLength),
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

/**
 * Serve an opaque workspace resource without exposing the host filesystem
 * path. An active mirror connection is preferred; a referenced local resource
 * is used only as a transient-disconnect fallback.
 */
export async function tryFetchWorkspaceResourceResponse(
  resourceId: string
): Promise<Response | null> {
  // An opaque URI was produced by the active mirror host, so prefer that
  // connection when present. This also prevents a coincidentally identical
  // local id from shadowing the remote resource.
  if (remoteClientManager.hasActiveConnection()) {
    try {
      const remoteResult = await remoteClientManager.requestWorkspaceResource(resourceId);
      return workspaceResourceResultToResponse(resourceId, remoteResult);
    } catch {
      // A reconnecting socket may fail transiently; try a referenced local
      // resource before returning a 404 to the protocol caller.
    }
  }

  try {
    const localResult = await getWorkspaceResourceService().fetch(
      resourceId,
      'local-file-protocol'
    );
    return workspaceResourceResultToResponse(resourceId, localResult);
  } catch {
    return null;
  }
}
