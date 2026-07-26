import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_SETUP } from './data/mockData';
import { AppShell } from './components/layout/AppShell';
import { NetworkStatusBanner } from './components/system/NetworkStatusBanner';
import * as betaTestMode from './config/betaTestMode';
import {
  notifyPersistenceHealthChanged,
  resetPersistenceHealthForTests,
} from './services/persistenceHealthService';
import { TestProviders } from './test/testProviders';

type Mount = { container: HTMLDivElement; root: Root };

function mount(ui: ReactNode): Mount {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  act(() => {
    root = createRoot(container);
    root.render(ui);
  });
  return { container, root };
}

function stubNavigatorOnline(online: boolean) {
  vi.stubGlobal('navigator', { onLine: online });
}

function renderMainTreeWithShell() {
  return createElement(
    MemoryRouter,
    { initialEntries: ['/'] },
    createElement(NetworkStatusBanner),
    createElement(TestProviders, { initialSetup: DEFAULT_SETUP }, createElement(AppShell)),
  );
}

function renderAuthPathNetworkBanner() {
  return createElement(NetworkStatusBanner);
}

describe('APP-DESIGN-FOUNDATION-01F single offline banner', () => {
  let mounted: Mount | undefined;

  beforeEach(() => {
    resetPersistenceHealthForTests();
  });

  afterEach(() => {
    if (mounted) {
      act(() => {
        mounted!.root.unmount();
      });
      mounted.container.remove();
      mounted = undefined;
    }
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    resetPersistenceHealthForTests();
  });

  it('AppShell importiert und rendert NetworkStatusBanner nicht mehr', () => {
    const source = readFileSync(
      resolve(process.cwd(), 'src/components/layout/AppShell.tsx'),
      'utf8',
    );
    expect(source).not.toMatch(/NetworkStatusBanner/);

    stubNavigatorOnline(false);
    mounted = mount(
      createElement(
        MemoryRouter,
        { initialEntries: ['/'] },
        createElement(TestProviders, { initialSetup: DEFAULT_SETUP }, createElement(AppShell)),
      ),
    );

    expect(mounted.container.querySelectorAll('[data-testid="network-error-banner"]')).toHaveLength(
      0,
    );
  });

  it('Offline + eingeloggter App-Tree: genau ein network-error-banner', () => {
    stubNavigatorOnline(false);
    mounted = mount(renderMainTreeWithShell());

    expect(mounted.container.querySelectorAll('[data-testid="network-error-banner"]')).toHaveLength(
      1,
    );
    expect(mounted.container.querySelector('[data-testid="app-shell"]')).not.toBeNull();
  });

  it('Online + eingeloggter App-Tree: kein network-error-banner', () => {
    stubNavigatorOnline(true);
    mounted = mount(renderMainTreeWithShell());

    expect(mounted.container.querySelectorAll('[data-testid="network-error-banner"]')).toHaveLength(
      0,
    );
  });

  it('Offline auf Auth-/globalem Pfad: NetworkStatusBanner bleibt sichtbar', () => {
    stubNavigatorOnline(false);
    mounted = mount(renderAuthPathNetworkBanner());

    expect(mounted.container.querySelectorAll('[data-testid="network-error-banner"]')).toHaveLength(
      1,
    );
  });

  it('AppShell rendert PersistenceFailureBanner und BetaModeBanner weiterhin', () => {
    stubNavigatorOnline(true);
    vi.spyOn(betaTestMode, 'isBetaTestMode').mockReturnValue(true);
    notifyPersistenceHealthChanged({ healthy: false, hasFailure: true });

    mounted = mount(
      createElement(
        MemoryRouter,
        { initialEntries: ['/'] },
        createElement(TestProviders, { initialSetup: DEFAULT_SETUP }, createElement(AppShell)),
      ),
    );

    expect(mounted.container.querySelector('[data-testid="persistence-failure-banner"]')).not.toBeNull();
    expect(mounted.container.querySelector('[data-testid="beta-mode-banner"]')).not.toBeNull();
    expect(mounted.container.querySelectorAll('[data-testid="network-error-banner"]')).toHaveLength(
      0,
    );
  });

  it('main.tsx behält die globale NetworkStatusBanner-Einbindung', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/main.tsx'), 'utf8');
    expect(source).toMatch(/import \{ NetworkStatusBanner \}/);
    expect(source).toMatch(/<NetworkStatusBanner\s*\/>/);
  });
});
