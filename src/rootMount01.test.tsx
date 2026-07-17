import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import { AppProvider } from './context/AppContext';
import { DEFAULT_SETUP } from './data/mockData';
import { AppShell } from './components/layout/AppShell';
import {
  getRootMountErrorProbeSnapshot,
  installRootMountErrorProbes,
  isRootMountDebugEnabled,
  resetRootMountErrorProbesForTests,
  RootMountDebugOverlay,
} from './components/system/RootMountDebugOverlay';
import { resetTestStores } from './test/resetStores';

const MAIN_TSX = resolve(__dirname, 'main.tsx');

describe('ROOT-MOUNT-01', () => {
  let host: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    host?.remove();
    host = null;
    root = null;
    resetRootMountErrorProbesForTests();
    resetTestStores();
  });

  it('Diagnose ist nur in DEV aktiv', () => {
    expect(isRootMountDebugEnabled()).toBe(Boolean(import.meta.env.DEV));
  });

  it('main.tsx mountet Overlay nur hinter import.meta.env.DEV und vor BusinessStateGate', () => {
    const source = readFileSync(MAIN_TSX, 'utf8');
    expect(source).toContain('RootMountDebugOverlay');
    expect(source).toContain('{import.meta.env.DEV ? <RootMountDebugOverlay /> : null}');
    const overlayIdx = source.indexOf('<RootMountDebugOverlay');
    const gateIdx = source.indexOf('<BusinessStateGate');
    expect(overlayIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeGreaterThan(overlayIdx);
  });

  it('AppShell ohne RootMount-Overlay-Pfad bleibt ohne root-mount-debug-overlay', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);

    await act(async () => {
      root!.render(
        createElement(
          MemoryRouter,
          { initialEntries: ['/'] },
          createElement(
            AuthProvider,
            null,
            createElement(
              AppProvider,
              { initialSetup: DEFAULT_SETUP },
              createElement(AppShell),
            ),
          ),
        ),
      );
    });

    expect(host.querySelector('[data-testid="app-shell"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="root-mount-debug-overlay"]')).toBeNull();
  });

  it('Overlay zeigt React-Mount, Phase und Auth-Status (vor AppShell)', async () => {
    if (!import.meta.env.DEV) return;

    host = document.createElement('div');
    host.id = 'root';
    document.body.appendChild(host);
    root = createRoot(host);

    await act(async () => {
      root!.render(
        createElement(
          MemoryRouter,
          { initialEntries: ['/ablage'] },
          createElement(
            AuthProvider,
            null,
            createElement(RootMountDebugOverlay),
            createElement('div', { 'data-testid': 'bootstrap-loading' }, 'loading'),
          ),
        ),
      );
    });

    const overlay = host.querySelector('[data-testid="root-mount-debug-overlay"]');
    expect(overlay).not.toBeNull();
    expect(host.querySelector('[data-testid="root-mount-debug-reactMounted"]')?.textContent).toBe(
      'true',
    );
    expect(host.querySelector('[data-testid="root-mount-debug-rootPresent"]')?.textContent).toBe(
      'true',
    );
    expect(host.querySelector('[data-testid="root-mount-debug-route"]')?.textContent).toBe(
      '/ablage',
    );
    expect(host.querySelector('[data-testid="root-mount-debug-phase"]')?.textContent).toMatch(
      /auth-waiting|bootstrap-waiting|pre-shell-ui|app-shell-mounted|auth-loading-ui/,
    );
    expect(host.querySelector('[data-testid="root-mount-debug-isAuthReady"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="root-mount-debug-setupStatus"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="root-mount-debug-elapsedMs"]')).not.toBeNull();
  });

  it('window.onerror und unhandledrejection werden nur protokolliert', async () => {
    if (!import.meta.env.DEV) return;

    installRootMountErrorProbes();
    resetRootMountErrorProbesForTests();

    await act(async () => {
      window.dispatchEvent(
        new ErrorEvent('error', { message: 'root-mount-probe-error', error: new Error('probe') }),
      );
      const rejection = new Event('unhandledrejection');
      Object.defineProperty(rejection, 'reason', {
        value: new Error('root-mount-probe-rejection'),
      });
      window.dispatchEvent(rejection);
    });

    const probe = getRootMountErrorProbeSnapshot();
    expect(probe.lastWindowError).toContain('root-mount-probe-error');
    expect(probe.lastUnhandledRejection).toContain('root-mount-probe-rejection');
  });
});
