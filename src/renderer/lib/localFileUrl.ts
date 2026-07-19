import { WORKSPACE_RESOURCE_URI_PREFIX, workspaceResourceIdFromUri } from '@shared/types';
import { toCustomProtocolFileBaseUrl, toCustomProtocolFileUrl } from '@shared/utils/fileUrl';

/**
 * Convert a filesystem path or opaque workspace resource URI to a
 * `local-file://` URL string.
 *
 * Opaque resource references must never be passed through the filesystem URL
 * encoder: doing so would turn the host-owned URI into a path-looking URL and
 * either leak host details or make the preview request target the wrong file.
 */
export function toLocalFileUrl(pathOrResource: string): string {
  const resourceId = workspaceResourceIdFromUri(pathOrResource);
  if (resourceId) {
    return `local-file://resource/${encodeURIComponent(resourceId)}`;
  }

  // Fail closed for malformed opaque references instead of interpreting them
  // as ordinary paths. The protocol handler rejects this sentinel URL.
  if (pathOrResource.toLowerCase().startsWith(WORKSPACE_RESOURCE_URI_PREFIX)) {
    return 'local-file://resource/';
  }

  return toCustomProtocolFileUrl(pathOrResource, 'local-file');
}

/**
 * Create a base URL for resolving relative paths within a directory.
 * Ensures the resulting URL.pathname ends with a trailing slash.
 */
export function toLocalFileBaseUrl(absDirPath: string): URL {
  return toCustomProtocolFileBaseUrl(absDirPath, 'local-file');
}
