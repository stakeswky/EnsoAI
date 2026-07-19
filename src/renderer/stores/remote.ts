import type { ControllerLease, RemoteClientStatus, RemoteHostInfo } from '@shared/types';
import { create } from 'zustand';

interface RemoteState {
  status: RemoteClientStatus | null;
  setStatus: (status: RemoteClientStatus) => void;
}

export const useRemoteStore = create<RemoteState>()((set) => ({
  status: null,
  setStatus: (status) =>
    set((state) => (areRemoteClientStatusesEqual(state.status, status) ? state : { status })),
}));

function areRemoteHostInfosEqual(
  left: RemoteHostInfo | null,
  right: RemoteHostInfo | null
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.platform === right.platform &&
      left.home === right.home &&
      left.hostname === right.hostname &&
      left.appVersion === right.appVersion)
  );
}

function areControllerLeasesEqual(
  left: ControllerLease | null | undefined,
  right: ControllerLease | null | undefined
): boolean {
  return (
    left === right ||
    (left != null &&
      right != null &&
      left.leaseId === right.leaseId &&
      left.holderDeviceId === right.holderDeviceId &&
      left.holderClientId === right.holderClientId &&
      left.acquiredAt === right.acquiredAt &&
      left.expiresAt === right.expiresAt &&
      left.graceUntil === right.graceUntil &&
      left.coordSeq === right.coordSeq)
  );
}

export function areRemoteClientStatusesEqual(
  left: RemoteClientStatus | null,
  right: RemoteClientStatus | null
): boolean {
  return (
    left === right ||
    (left !== null &&
      right !== null &&
      left.state === right.state &&
      left.host === right.host &&
      left.port === right.port &&
      areRemoteHostInfosEqual(left.hostInfo, right.hostInfo) &&
      left.mirrorSyncPhase === right.mirrorSyncPhase &&
      left.mirrorRevision === right.mirrorRevision &&
      left.mirrorProtocol === right.mirrorProtocol &&
      areControllerLeasesEqual(left.mirrorController, right.mirrorController) &&
      left.mirrorOwnsControl === right.mirrorOwnsControl &&
      left.mirrorLastResyncReason === right.mirrorLastResyncReason &&
      left.error === right.error)
  );
}

/** Whether this window is attached to a remote host (incl. reconnecting) */
export function isRemoteAttached(status: RemoteClientStatus | null): boolean {
  return status?.state === 'connected' || status?.state === 'reconnecting';
}

/** React hook: attached state */
export function useRemoteAttached(): boolean {
  return useRemoteStore((state) => isRemoteAttached(state.status));
}

export interface EffectiveEnv {
  home: string;
  platform: 'darwin' | 'win32' | 'linux';
  /** Path separator matching `platform` */
  pathSep: '/' | '\\';
}

function toEffectiveEnv(status: RemoteClientStatus | null): EffectiveEnv {
  const hostInfo = isRemoteAttached(status) ? status?.hostInfo : null;
  const platform = hostInfo?.platform ?? window.electronAPI.env.platform;
  return {
    home: hostInfo?.home ?? window.electronAPI.env.HOME,
    platform,
    pathSep: platform === 'win32' ? '\\' : '/',
  };
}

/**
 * Environment of the machine that terminals/files actually run on:
 * the remote host while attached, the local machine otherwise.
 * Non-reactive; for reactive usage use `useEffectiveEnv`.
 */
export function getEffectiveEnv(): EffectiveEnv {
  return toEffectiveEnv(useRemoteStore.getState().status);
}

/** React hook: reactive effective environment */
export function useEffectiveEnv(): EffectiveEnv {
  const status = useRemoteStore((state) => state.status);
  return toEffectiveEnv(status);
}

/** One-time listener wiring (call once at app startup) */
export function initRemoteStatusListener(): void {
  let receivedStatusEvent = false;
  window.electronAPI.remote.onStatusChanged((status) => {
    receivedStatusEvent = true;
    useRemoteStore.getState().setStatus(status);
  });
  window.electronAPI.remote
    .getStatus()
    .then((status) => {
      if (!receivedStatusEvent) useRemoteStore.getState().setStatus(status);
    })
    .catch((error) => {
      console.error(error);
      if (!receivedStatusEvent) {
        useRemoteStore.getState().setStatus({
          state: 'disconnected',
          host: null,
          port: null,
          hostInfo: null,
        });
      }
    });
}
