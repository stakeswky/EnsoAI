import type { RemoteClientStatus, RemoteHostStatus, RemotePairedDeviceInfo } from '@shared/types';
import { Copy, Eye, EyeOff, RefreshCw, X } from 'lucide-react';
import * as React from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useI18n } from '@/i18n';
import { useWorkspaceMirrorStore } from '@/stores/workspaceMirror';

const LAST_HOST_KEY = 'enso-remote-last-host';
const REMOTE_DEVICE_ID_KEY = 'enso-remote-device-id';

function remoteDeviceId(): string {
  const existing = localStorage.getItem(REMOTE_DEVICE_ID_KEY);
  if (existing) return existing;
  const created = `device-${crypto.randomUUID()}`;
  localStorage.setItem(REMOTE_DEVICE_ID_KEY, created);
  return created;
}

interface ConnectForm {
  host: string;
  port: string;
  token: string;
  liveMirror: boolean;
}

function readLastHost(): ConnectForm {
  try {
    const raw = localStorage.getItem(LAST_HOST_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        host: typeof parsed.host === 'string' ? parsed.host : '',
        port: typeof parsed.port === 'string' ? parsed.port : '48925',
        token: '',
        liveMirror: parsed.liveMirror === true,
      };
    }
  } catch {
    // Ignore corrupted storage
  }
  return { host: '', port: '48925', token: '', liveMirror: false };
}

export function RemoteSettings() {
  const { t } = useI18n();
  const [hostStatus, setHostStatus] = React.useState<RemoteHostStatus | null>(null);
  const [clientStatus, setClientStatus] = React.useState<RemoteClientStatus | null>(null);
  const [showToken, setShowToken] = React.useState(false);
  const [hostBusy, setHostBusy] = React.useState(false);
  const [connectBusy, setConnectBusy] = React.useState(false);
  const [connectError, setConnectError] = React.useState<string | null>(null);
  const [hostError, setHostError] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);
  const [pairedDevices, setPairedDevices] = React.useState<RemotePairedDeviceInfo[]>([]);
  const [form, setForm] = React.useState<ConnectForm>(readLastHost);
  const requestControl = useWorkspaceMirrorStore((state) => state.requestControl);
  const releaseControl = useWorkspaceMirrorStore((state) => state.releaseControl);

  React.useEffect(() => {
    window.electronAPI.remoteHost.getStatus().then(setHostStatus).catch(console.error);
    window.electronAPI.remote.getStatus().then(setClientStatus).catch(console.error);
    window.electronAPI.remoteHost.listPairedDevices().then(setPairedDevices).catch(console.error);

    const cleanupHost = window.electronAPI.remoteHost.onStatusChanged(setHostStatus);
    const cleanupClient = window.electronAPI.remote.onStatusChanged(setClientStatus);
    return () => {
      cleanupHost();
      cleanupClient();
    };
  }, []);

  const handleToggleHost = async (enabled: boolean) => {
    setHostBusy(true);
    setHostError(null);
    try {
      const status = enabled
        ? await window.electronAPI.remoteHost.start()
        : await window.electronAPI.remoteHost.stop();
      setHostStatus(status);
    } catch (error) {
      setHostError(error instanceof Error ? error.message : String(error));
    } finally {
      setHostBusy(false);
    }
  };

  const handleRegenerateToken = async () => {
    setHostBusy(true);
    try {
      setHostStatus(await window.electronAPI.remoteHost.regenerateToken());
    } finally {
      setHostBusy(false);
    }
  };

  const handleMirrorV2Toggle = async (enabled: boolean) => {
    setHostBusy(true);
    setHostError(null);
    try {
      setHostStatus(await window.electronAPI.remoteHost.setMirrorV2Enabled(enabled));
    } catch (error) {
      setHostError(error instanceof Error ? error.message : String(error));
    } finally {
      setHostBusy(false);
    }
  };

  const handleRevokeDevice = async (deviceId: string) => {
    await window.electronAPI.remoteHost.revokePairedDevice(deviceId);
    setPairedDevices(await window.electronAPI.remoteHost.listPairedDevices());
  };

  const handleCopyToken = async () => {
    if (hostStatus?.token) {
      await navigator.clipboard.writeText(hostStatus.token);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  const handleConnect = async () => {
    const port = Number.parseInt(form.port, 10);
    if (!form.host.trim() || !Number.isFinite(port)) {
      return;
    }
    setConnectBusy(true);
    setConnectError(null);
    try {
      localStorage.setItem(
        LAST_HOST_KEY,
        JSON.stringify({ host: form.host, port: form.port, liveMirror: form.liveMirror })
      );
      const status = await window.electronAPI.remote.connect({
        host: form.host.trim(),
        port,
        token: form.token.trim(),
        deviceId: remoteDeviceId(),
        clientId: `client-${crypto.randomUUID()}`,
        mirrorV2: form.liveMirror,
      });
      setClientStatus(status);
      if (status.state !== 'connected' && status.error) {
        setConnectError(status.error);
      }
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : String(err));
    } finally {
      setConnectBusy(false);
    }
  };

  const handleDisconnect = async () => {
    await window.electronAPI.remote.disconnect();
    setClientStatus(await window.electronAPI.remote.getStatus());
  };

  const handleControlToggle = async () => {
    setConnectBusy(true);
    setConnectError(null);
    try {
      if (clientStatus?.mirrorOwnsControl) {
        await releaseControl();
      } else {
        await requestControl();
      }
      setClientStatus(await window.electronAPI.remote.getStatus());
    } catch (error) {
      setConnectError(error instanceof Error ? error.message : String(error));
    } finally {
      setConnectBusy(false);
    }
  };

  const running = hostStatus?.running ?? false;
  const connectionState = clientStatus?.state ?? 'disconnected';
  const isAttached = connectionState === 'connected' || connectionState === 'reconnecting';

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-lg font-medium">{t('Remote Development')}</h3>
        <p className="text-sm text-muted-foreground">
          {t('Develop across machines on your Tailscale network')}
        </p>
      </div>

      {/* ---- Host mode ---- */}
      <div className="grid grid-cols-[100px_1fr] items-center gap-4">
        <span className="text-sm font-medium">{t('Host Mode')}</span>
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            {t('Allow other devices to connect to this machine')}
          </p>
          <Switch checked={running} onCheckedChange={handleToggleHost} disabled={hostBusy} />
        </div>
      </div>

      <div className="grid grid-cols-[100px_1fr] items-center gap-4">
        <span className="text-sm font-medium">{t('Status')}</span>
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex h-2 w-2 rounded-full ${running ? 'bg-green-500' : 'bg-gray-400'}`}
          />
          <span className="text-sm text-muted-foreground">
            {running && hostStatus
              ? `${hostStatus.bindAddress}:${hostStatus.port} · ${t('Connected clients: {{count}}', { count: hostStatus.clientCount })}`
              : t('Stopped')}
          </span>
        </div>
      </div>

      {running && !hostStatus?.tailscaleAddress && (
        <div className="grid grid-cols-[100px_1fr] items-center gap-4">
          <span />
          <p className="text-sm text-yellow-500">
            {t('Tailscale network not detected; server is only reachable from this machine')}
          </p>
        </div>
      )}

      <div className="grid grid-cols-[100px_1fr] items-center gap-4">
        <span className="text-sm font-medium">{t('Pairing Token')}</span>
        <div className="flex items-center gap-1 min-w-0">
          <code className="flex-1 truncate rounded bg-muted/50 px-2 py-1 text-xs text-muted-foreground">
            {hostStatus?.token ? (showToken ? hostStatus.token : '•'.repeat(32)) : '—'}
          </code>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0"
            onClick={() => setShowToken((v) => !v)}
          >
            {showToken ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0"
            onClick={handleCopyToken}
            title={copied ? t('Copied') : t('Copy')}
          >
            <Copy className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 shrink-0"
            onClick={handleRegenerateToken}
            disabled={hostBusy}
            title={t('Regenerate token (disconnects all clients)')}
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-[100px_1fr] items-center gap-4">
        <span className="text-sm font-medium">{t('Live Mirror')}</span>
        <div className="flex items-center justify-between">
          <span className="text-sm text-muted-foreground">
            {hostStatus?.mirrorV2Enabled === true ? t('Enabled') : t('Disabled')}
          </span>
          <Switch
            checked={hostStatus?.mirrorV2Enabled === true}
            onCheckedChange={handleMirrorV2Toggle}
            disabled={hostBusy}
          />
        </div>
      </div>

      {hostError && (
        <div className="grid grid-cols-[100px_1fr] items-center gap-4">
          <span />
          <p className="text-sm text-red-500">{hostError}</p>
        </div>
      )}

      {(hostStatus?.mirrorV2Enabled === true || pairedDevices.length > 0) && (
        <div className="grid grid-cols-[100px_1fr] gap-4">
          <span />
          <p className="text-xs text-yellow-500">
            {t(
              'Control access is equivalent to a local user: paired devices can access workspace files, processes, Agent prompts, and terminals.'
            )}
          </p>
        </div>
      )}

      {pairedDevices.some((device) => device.revokedAt === null) && (
        <div className="grid grid-cols-[100px_1fr] gap-4">
          <span className="text-sm font-medium">{t('Paired Devices')}</span>
          <div className="divide-y border-y">
            {pairedDevices
              .filter((device) => device.revokedAt === null)
              .map((device) => (
                <div key={device.deviceId} className="flex h-9 items-center gap-2">
                  <span className="min-w-0 flex-1 truncate text-sm">{device.deviceId}</span>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 shrink-0"
                    onClick={() => handleRevokeDevice(device.deviceId)}
                    title={t('Revoke device')}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
          </div>
        </div>
      )}

      {/* ---- Connect to a host ---- */}
      <div className="border-t pt-4">
        <h3 className="text-lg font-medium">{t('Connect to Host')}</h3>
        <p className="text-sm text-muted-foreground">
          {t('Run terminals and agents on another machine')}
        </p>
      </div>

      {isAttached ? (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <span
              className={`inline-flex h-2 w-2 rounded-full ${
                connectionState === 'connected' ? 'bg-green-500' : 'bg-yellow-500'
              }`}
            />
            <span className="text-sm">
              {connectionState === 'connected'
                ? t('Connected to {{hostname}}', {
                    hostname: clientStatus?.hostInfo?.hostname ?? clientStatus?.host ?? '',
                  })
                : t('Reconnecting...')}
            </span>
            <span className="text-xs text-muted-foreground">
              {clientStatus?.host}:{clientStatus?.port}
            </span>
          </div>
          <p className="text-sm text-muted-foreground">
            {clientStatus?.mirrorProtocol === 'v2'
              ? t('Mirroring the remote workspace in real time')
              : t('Legacy RPC connection; workspace state is not mirrored')}
          </p>
          <div className="grid grid-cols-[100px_1fr] gap-x-4 gap-y-2 border-y py-3 text-sm">
            <span className="text-muted-foreground">{t('Sync')}</span>
            <span>
              {clientStatus?.mirrorSyncPhase ?? 'disconnected'}
              {clientStatus?.mirrorRevision !== undefined
                ? ` · r${clientStatus.mirrorRevision}`
                : ''}
            </span>
            <span className="text-muted-foreground">{t('Control')}</span>
            <span>
              {clientStatus?.mirrorOwnsControl
                ? t('This device')
                : clientStatus?.mirrorController
                  ? t('Observer')
                  : t('Available')}
            </span>
            {clientStatus?.mirrorLastResyncReason && (
              <>
                <span className="text-muted-foreground">{t('Resync')}</span>
                <span>{clientStatus.mirrorLastResyncReason}</span>
              </>
            )}
          </div>
          {connectError && <p className="text-sm text-red-500">{connectError}</p>}
          <div className="flex gap-2">
            {clientStatus?.mirrorProtocol === 'v2' && (
              <Button variant="outline" onClick={handleControlToggle} disabled={connectBusy}>
                {clientStatus.mirrorOwnsControl ? t('Release Control') : t('Take Control')}
              </Button>
            )}
            <Button variant="outline" onClick={handleDisconnect}>
              {t('Disconnect')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-[100px_1fr] items-center gap-4">
            <span className="text-sm font-medium">{t('Host Address')}</span>
            <div className="flex gap-2">
              <Input
                value={form.host}
                onChange={(e) => setForm((f) => ({ ...f, host: e.target.value }))}
                placeholder="100.x.x.x / mac-mini.tailnet.ts.net"
                className="flex-1"
              />
              <Input
                value={form.port}
                onChange={(e) => setForm((f) => ({ ...f, port: e.target.value }))}
                placeholder="48925"
                className="w-24"
              />
            </div>
          </div>
          <div className="grid grid-cols-[100px_1fr] items-center gap-4">
            <span className="text-sm font-medium">{t('Pairing Token')}</span>
            <Input
              type="password"
              value={form.token}
              onChange={(e) => setForm((f) => ({ ...f, token: e.target.value }))}
              placeholder={t('Paste the token shown on the host')}
            />
          </div>
          <div className="grid grid-cols-[100px_1fr] items-center gap-4">
            <span className="text-sm font-medium">{t('Live Mirror')}</span>
            <div className="flex items-center justify-between gap-4">
              <p className="text-sm text-muted-foreground">
                {t('Experimental real-time workspace mirroring')}
              </p>
              <Switch
                checked={form.liveMirror}
                onCheckedChange={(liveMirror) => setForm((current) => ({ ...current, liveMirror }))}
              />
            </div>
          </div>
          {form.liveMirror && (
            <div className="grid grid-cols-[100px_1fr] gap-4">
              <span />
              <p className="text-xs text-yellow-500">
                {t(
                  'Control access is equivalent to a local user: this device can access workspace files, processes, Agent prompts, and terminals.'
                )}
              </p>
            </div>
          )}
          {connectError && (
            <div className="grid grid-cols-[100px_1fr] items-center gap-4">
              <span />
              <p className="text-sm text-red-500">{connectError}</p>
            </div>
          )}
          <div className="grid grid-cols-[100px_1fr] items-center gap-4">
            <span />
            <div>
              <Button onClick={handleConnect} disabled={connectBusy || !form.host.trim()}>
                {connectBusy ? t('Connecting...') : t('Connect')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
