import { useEffect, useState, type CSSProperties } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { getCachedSetup } from '../../services/persistenceService';

const appStartedAt = Date.now();

type ErrorProbeSnapshot = {
  lastWindowError: string;
  lastUnhandledRejection: string;
  lastConsoleError: string;
};

const errorProbe: ErrorProbeSnapshot = {
  lastWindowError: 'none',
  lastUnhandledRejection: 'none',
  lastConsoleError: 'none',
};

let probesInstalled = false;
const probeListeners = new Set<() => void>();

function notifyProbeListeners() {
  for (const listener of probeListeners) {
    listener();
  }
}

function formatUnknown(value: unknown): string {
  if (value instanceof Error) {
    return value.message || value.name || 'Error';
  }
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** DEV-only: Fehler nur protokollieren, nie reparieren. */
export function installRootMountErrorProbes(): void {
  if (!import.meta.env.DEV || probesInstalled) return;
  probesInstalled = true;

  window.addEventListener('error', (event) => {
    const message = event.message || formatUnknown(event.error) || 'window.error';
    errorProbe.lastWindowError = `${message} @ ${nowStamp()}`;
    console.error('[RootMountDebug] window.onerror', message, event.error);
    notifyProbeListeners();
  });

  window.addEventListener('unhandledrejection', (event) => {
    const message = formatUnknown(event.reason);
    errorProbe.lastUnhandledRejection = `${message} @ ${nowStamp()}`;
    console.error('[RootMountDebug] unhandledrejection', event.reason);
    notifyProbeListeners();
  });

  const originalConsoleError = console.error.bind(console);
  console.error = (...args: unknown[]) => {
    errorProbe.lastConsoleError = `${args.map(formatUnknown).join(' ')} @ ${nowStamp()}`;
    originalConsoleError(...args);
    notifyProbeListeners();
  };
}

export function isRootMountDebugEnabled(): boolean {
  return Boolean(import.meta.env.DEV);
}

export function getRootMountErrorProbeSnapshot(): ErrorProbeSnapshot {
  return { ...errorProbe };
}

/** Test-only reset. */
export function resetRootMountErrorProbesForTests(): void {
  errorProbe.lastWindowError = 'none';
  errorProbe.lastUnhandledRejection = 'none';
  errorProbe.lastConsoleError = 'none';
}

function nowStamp(): string {
  return new Date().toISOString().slice(11, 23);
}

type StartupPhase =
  | 'react-mounted'
  | 'auth-waiting'
  | 'bootstrap-waiting'
  | 'auth-loading-ui'
  | 'app-shell-mounted'
  | 'pre-shell-ui';

function detectStartupPhase(isAuthReady: boolean): StartupPhase {
  if (!isAuthReady) return 'auth-waiting';
  if (document.querySelector('[data-testid="bootstrap-loading"]')) return 'bootstrap-waiting';
  if (document.querySelector('[data-testid="auth-loading"]')) return 'auth-loading-ui';
  if (document.querySelector('[data-testid="app-shell"]')) return 'app-shell-mounted';
  return 'pre-shell-ui';
}

function detectSetupStatus(isAuthReady: boolean): string {
  if (!isAuthReady) return 'blocked-by-auth';
  if (document.querySelector('[data-testid="bootstrap-loading"]')) return 'bootstrap-pending';
  const setup = getCachedSetup();
  if (!setup) return 'no-cached-setup';
  return setup.setupComplete ? 'setup-complete' : 'setup-incomplete';
}

type Snapshot = {
  reactMounted: true;
  rootPresent: boolean;
  phase: StartupPhase;
  isAuthReady: boolean;
  setupStatus: string;
  route: string;
  lastWindowError: string;
  lastUnhandledRejection: string;
  lastConsoleError: string;
  elapsedMs: number;
};

function captureSnapshot(isAuthReady: boolean, route: string): Snapshot {
  const probe = getRootMountErrorProbeSnapshot();
  return {
    reactMounted: true,
    rootPresent: Boolean(document.getElementById('root')),
    phase: detectStartupPhase(isAuthReady),
    isAuthReady,
    setupStatus: detectSetupStatus(isAuthReady),
    route,
    lastWindowError: probe.lastWindowError,
    lastUnhandledRejection: probe.lastUnhandledRejection,
    lastConsoleError: probe.lastConsoleError,
    elapsedMs: Date.now() - appStartedAt,
  };
}

const overlayStyle: CSSProperties = {
  position: 'fixed',
  top: 0,
  left: 0,
  right: 0,
  zIndex: 100000,
  maxHeight: '38vh',
  overflow: 'auto',
  margin: 0,
  padding: '6px 8px',
  background: 'rgba(127, 29, 29, 0.92)',
  color: '#fff7ed',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: '11px',
  lineHeight: 1.35,
  pointerEvents: 'none',
  borderBottom: '1px solid rgba(254, 215, 170, 0.5)',
};

const rowStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: '8px',
  whiteSpace: 'nowrap',
};

function Row({ label, value }: { label: string; value: string | number | boolean }) {
  return (
    <div style={rowStyle}>
      <span>{label}</span>
      <strong data-testid={`root-mount-debug-${label}`}>{String(value)}</strong>
    </div>
  );
}

export function RootMountDebugOverlay() {
  const enabled = isRootMountDebugEnabled();
  const { isAuthReady } = useAuth();
  const location = useLocation();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);

  useEffect(() => {
    if (!enabled) {
      setSnapshot(null);
      return;
    }

    installRootMountErrorProbes();

    const refresh = () => {
      setSnapshot(captureSnapshot(isAuthReady, location.pathname + location.search));
    };

    refresh();
    const intervalId = window.setInterval(refresh, 500);
    const onProbe = () => refresh();
    probeListeners.add(onProbe);

    return () => {
      window.clearInterval(intervalId);
      probeListeners.delete(onProbe);
    };
  }, [enabled, isAuthReady, location.pathname, location.search]);

  if (!enabled || !snapshot) return null;

  return (
    <aside
      data-testid="root-mount-debug-overlay"
      aria-label="Root mount startup diagnostics"
      style={overlayStyle}
    >
      <div style={{ fontWeight: 700, marginBottom: 4 }}>Root Mount Debug (DEV)</div>
      <Row label="reactMounted" value={snapshot.reactMounted} />
      <Row label="rootPresent" value={snapshot.rootPresent} />
      <Row label="phase" value={snapshot.phase} />
      <Row label="isAuthReady" value={snapshot.isAuthReady} />
      <Row label="setupStatus" value={snapshot.setupStatus} />
      <Row label="route" value={snapshot.route} />
      <Row label="lastWindowError" value={snapshot.lastWindowError} />
      <Row label="lastUnhandledRejection" value={snapshot.lastUnhandledRejection} />
      <Row label="lastConsoleError" value={snapshot.lastConsoleError} />
      <Row label="elapsedMs" value={snapshot.elapsedMs} />
    </aside>
  );
}
