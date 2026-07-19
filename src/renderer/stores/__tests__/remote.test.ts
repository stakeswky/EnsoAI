import type { RemoteClientStatus } from '@shared/types';
import { describe, expect, it, vi } from 'vitest';
import { areRemoteClientStatusesEqual, useRemoteStore } from '../remote';

const liveStatus: RemoteClientStatus = {
  state: 'connected',
  host: '100.64.0.2',
  port: 48925,
  hostInfo: {
    platform: 'darwin',
    home: '/Users/host',
    hostname: 'host.local',
    appVersion: '0.2.44',
  },
  mirrorSyncPhase: 'live',
  mirrorRevision: 12,
  mirrorProtocol: 'v2',
  mirrorController: {
    leaseId: 'lease-1',
    holderDeviceId: 'device-1',
    holderClientId: 'client-1',
    acquiredAt: 1,
    expiresAt: 60_000,
    graceUntil: null,
    coordSeq: 1,
  },
  mirrorOwnsControl: true,
};

describe('remote renderer status', () => {
  it('treats structurally equal status payloads as the same status', () => {
    expect(
      areRemoteClientStatusesEqual(liveStatus, {
        ...liveStatus,
        hostInfo: { ...liveStatus.hostInfo! },
        mirrorController: { ...liveStatus.mirrorController! },
      })
    ).toBe(true);
    expect(areRemoteClientStatusesEqual(liveStatus, { ...liveStatus, mirrorRevision: 13 })).toBe(
      false
    );
  });

  it('does not notify subscribers for duplicate status payloads', () => {
    useRemoteStore.setState({ status: null });
    const subscriber = vi.fn();
    const unsubscribe = useRemoteStore.subscribe(subscriber);

    useRemoteStore.getState().setStatus(liveStatus);
    useRemoteStore.getState().setStatus({
      ...liveStatus,
      hostInfo: { ...liveStatus.hostInfo! },
      mirrorController: { ...liveStatus.mirrorController! },
    });

    expect(subscriber).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});
