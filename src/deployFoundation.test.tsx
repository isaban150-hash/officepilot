import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  getProductionConfigIssues,
  isDefaultAdminBootstrapAllowed,
  isProductionBuild,
} from './config/productionGuard';
import { NotFoundPage } from './pages/system/NotFoundPage';
import { ServerErrorPage } from './pages/system/ServerErrorPage';
import { ProductionConfigBanner } from './components/system/ProductionConfigBanner';
import { NetworkStatusBanner } from './components/system/NetworkStatusBanner';
import { AppErrorBoundary } from './components/system/AppErrorBoundary';

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

describe('DEPLOY-01 deployment foundation', () => {
  let mounted: Mount | undefined;

  afterEach(() => {
    if (mounted) {
      act(() => mounted!.root.unmount());
      mounted.container.remove();
      mounted = undefined;
    }
  });

  it('enthält vercel.json mit SPA-Rewrite und dist output', () => {
    const vercelPath = resolve(process.cwd(), 'vercel.json');
    const config = JSON.parse(readFileSync(vercelPath, 'utf8')) as {
      outputDirectory: string;
      buildCommand: string;
      rewrites: Array<{ destination: string }>;
    };

    expect(config.outputDirectory).toBe('dist');
    expect(config.buildCommand).toBe('npm run build');
    expect(config.rewrites.some((entry) => entry.destination === '/index.html')).toBe(true);
  });

  it('blockiert Default-Admin in Production ohne VITE_ALLOW_DEFAULT_ADMIN', () => {
    vi.stubEnv('PROD', true);
    vi.stubEnv('VITE_ALLOW_DEFAULT_ADMIN', '');
    expect(isDefaultAdminBootstrapAllowed()).toBe(false);
  });

  it('meldet Beta-Modus in Production als Konfigurationsproblem', () => {
    vi.stubEnv('PROD', true);
    vi.stubEnv('VITE_BETA_TEST_MODE', 'true');
    vi.stubEnv('VITE_ALLOW_DEFAULT_ADMIN', '');

    const issues = getProductionConfigIssues();
    expect(issues.some((issue) => issue.code === 'beta_mode_in_production')).toBe(true);
  });

  it('zeigt ProductionConfigBanner bei Fehlkonfiguration', () => {
    vi.stubEnv('PROD', true);
    vi.stubEnv('VITE_BETA_TEST_MODE', 'true');

    const html = renderToStaticMarkup(<ProductionConfigBanner />);
    expect(html).toContain('production-config-banner');
    expect(html).toContain('VITE_BETA_TEST_MODE');
  });

  it('rendert 404-Seite', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <NotFoundPage />
      </MemoryRouter>,
    );
    expect(html).toContain('not-found-page');
    expect(html).toContain('Seite nicht gefunden');
  });

  it('rendert 500-Fallback-Seite', () => {
    const html = renderToStaticMarkup(<ServerErrorPage />);
    expect(html).toContain('server-error-page');
    expect(html).toContain('server-error-retry');
  });

  it('fängt Render-Fehler mit AppErrorBoundary ab', () => {
    function Broken(): never {
      throw new Error('boom');
    }

    mounted = mount(
      <AppErrorBoundary>
        <Broken />
      </AppErrorBoundary>,
    );
    expect(mounted.container.querySelector('[data-testid="server-error-page"]')).not.toBeNull();
  });

  it('zeigt Offline-Banner wenn navigator offline ist', () => {
    vi.stubGlobal('navigator', { onLine: false });

    const html = renderToStaticMarkup(<NetworkStatusBanner />);
    expect(html).toContain('network-error-banner');
  });

  it('Production-Build-Flag ist in Tests verfügbar', () => {
    expect(typeof isProductionBuild()).toBe('boolean');
  });
});
