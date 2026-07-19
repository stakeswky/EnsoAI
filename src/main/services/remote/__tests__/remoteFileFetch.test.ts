import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as workspaceRuntime from '../../workspace/workspaceMirrorRuntime';
import { remoteClientManager } from '../RemoteClientManager';
import {
  remoteFileResultToResponse,
  tryFetchRemoteFileResponse,
  tryFetchWorkspaceResourceResponse,
  workspaceResourceResultToResponse,
} from '../remoteFileFetch';

function resultFor(data: Buffer, id = 'resource-1') {
  return {
    reference: {
      id,
      displayName: 'preview.png',
      mime: 'image/png',
      size: data.byteLength,
      checksum: createHash('sha256').update(data).digest('hex'),
    },
    data: data.toString('base64'),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('workspace resource preview response', () => {
  it('returns verified bytes with the staged MIME type', async () => {
    const response = workspaceResourceResultToResponse('resource-1', resultFor(Buffer.from('png')));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe('png');
  });

  it('rejects mismatched ids and checksums before serving bytes', () => {
    expect(() =>
      workspaceResourceResultToResponse('resource-2', resultFor(Buffer.from('png')))
    ).toThrow(/reference mismatch/);

    const invalid = resultFor(Buffer.from('png'));
    invalid.data = Buffer.from('tampered').toString('base64');
    expect(() => workspaceResourceResultToResponse('resource-1', invalid)).toThrow(
      /checksum mismatch/
    );
  });

  it('fetches opaque resources over the active mirror connection', async () => {
    const source = Buffer.from('remote-resource');
    const request = vi
      .spyOn(remoteClientManager, 'requestWorkspaceResource')
      .mockResolvedValue(resultFor(source));
    vi.spyOn(remoteClientManager, 'hasActiveConnection').mockReturnValue(true);
    vi.spyOn(workspaceRuntime, 'getWorkspaceResourceService').mockImplementation(() => {
      throw new Error('local resource service should not be used');
    });

    const response = await tryFetchWorkspaceResourceResponse('resource-1');

    expect(request).toHaveBeenCalledWith('resource-1');
    expect(response?.status).toBe(200);
    expect(Buffer.from(await response!.arrayBuffer())).toEqual(source);
  });
});

describe('remote file preview response', () => {
  it('validates the declared size and MIME before serving bytes', async () => {
    const data = Buffer.from('preview');
    const response = remoteFileResultToResponse({
      data: data.toString('base64'),
      mime: 'image/png',
      size: data.byteLength,
    });
    expect(Buffer.from(await response.arrayBuffer())).toEqual(data);

    expect(() =>
      remoteFileResultToResponse({
        data: data.toString('base64'),
        mime: 'image/png',
        size: data.byteLength + 1,
      })
    ).toThrow(/size mismatch/);
  });

  it('fails closed while a remote target is active', async () => {
    vi.spyOn(remoteClientManager, 'hasActiveConnection').mockReturnValue(true);
    vi.spyOn(remoteClientManager, 'requestRemoteFile').mockRejectedValue(new Error('ambiguous'));

    await expect(tryFetchRemoteFileResponse('/remote/repo/image.png')).resolves.toMatchObject({
      status: 502,
    });
  });
});
