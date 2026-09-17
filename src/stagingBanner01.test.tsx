/**
 * V1-B1 — STAGING-Kennzeichnung: nur mit explizitem Flag sichtbar.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { StagingBanner } from './components/system/StagingBanner';
import { isStagingEnvironment } from './config/productionGuard';

describe('V1-B1 — StagingBanner', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('ohne Flag (Produktion/lokal) kein Banner', () => {
    vi.stubEnv('VITE_APP_ENVIRONMENT', '');
    expect(isStagingEnvironment()).toBe(false);
    expect(renderToStaticMarkup(<StagingBanner />)).toBe('');
    vi.stubEnv('VITE_APP_ENVIRONMENT', 'production');
    expect(isStagingEnvironment()).toBe(false);
    vi.stubEnv('VITE_APP_ENVIRONMENT', 'true');
    expect(isStagingEnvironment()).toBe(false);
  });

  it('VITE_APP_ENVIRONMENT=staging zeigt das Banner mit deutlichem Text', () => {
    vi.stubEnv('VITE_APP_ENVIRONMENT', 'staging');
    expect(isStagingEnvironment()).toBe(true);
    const html = renderToStaticMarkup(<StagingBanner />);
    expect(html).toContain('data-testid="staging-banner"');
    expect(html).toContain('STAGING');
    expect(html).toContain('Testadressen');
  });
});
