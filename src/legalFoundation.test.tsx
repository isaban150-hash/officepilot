import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { LegalFooterLinks } from './components/legal/LegalFooterLinks';
import { ImpressumPage } from './pages/legal/ImpressumPage';
import { DatenschutzPage } from './pages/legal/DatenschutzPage';
import { AgbPage } from './pages/legal/AgbPage';
import { LizenzbedingungenPage } from './pages/legal/LizenzbedingungenPage';
import { RegisterPage } from './pages/RegisterPage';
import { AppProvider } from './context/AppContext';
import { AuthProvider } from './context/AuthContext';
import { DEFAULT_SETUP } from './data/mockData';
import {
  LICENSE_VERSION,
  PRIVACY_VERSION,
  TERMS_VERSION,
} from './config/legalVersions';
import { OFFICEPILOT_LEGAL_DISCLAIMER } from './config/legalDisclaimer';
import { registerUser } from './services/auth/authService';
import { findUserByEmail } from './services/auth/authStore';
import { loginAsDefaultAdmin } from './test/authFixtures';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { AdminUsersPage } from './pages/AdminUsersPage';

describe('LEGAL-01', () => {
  it('Versionen sind als Entwurf definiert', () => {
    expect(TERMS_VERSION).toBe('1.0-draft');
    expect(PRIVACY_VERSION).toBe('1.0-draft');
    expect(LICENSE_VERSION).toBe('1.0-draft');
  });

  it('Registrierung ohne Zustimmung blockiert', async () => {
    const result = await registerUser({
      companyName: 'Firma',
      firstName: 'Max',
      lastName: 'Muster',
      email: 'no-consent@example.com',
      password: 'TestPasswort1',
      acceptedTermsVersion: '',
      acceptedPrivacyVersion: PRIVACY_VERSION,
      acceptedLicenseVersion: LICENSE_VERSION,
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBe('terms_required');
    }
  });

  it('Zustimmung und Versionen werden gespeichert', async () => {
    const result = await registerUser({
      companyName: 'Legal GmbH',
      firstName: 'Anna',
      lastName: 'Test',
      email: 'consent@example.com',
      password: 'TestPasswort1',
      acceptedTermsVersion: TERMS_VERSION,
      acceptedPrivacyVersion: PRIVACY_VERSION,
      acceptedLicenseVersion: LICENSE_VERSION,
    });
    expect(result.success).toBe(true);
    const user = findUserByEmail('consent@example.com');
    expect(user?.acceptedTermsVersion).toBe(TERMS_VERSION);
    expect(user?.acceptedPrivacyVersion).toBe(PRIVACY_VERSION);
    expect(user?.acceptedLicenseVersion).toBe(LICENSE_VERSION);
    expect(user?.legalAcceptedAt).toBeTruthy();
  });

  it('Legal-Seiten rendern mit Entwurf-Hinweis', () => {
    const impressum = renderToStaticMarkup(
      <MemoryRouter>
        <ImpressumPage />
      </MemoryRouter>,
    );
    expect(impressum).toContain('data-testid="impressum-page"');
    expect(impressum).toContain('Entwurf – muss rechtlich geprüft werden');

    const datenschutz = renderToStaticMarkup(
      <MemoryRouter>
        <DatenschutzPage />
      </MemoryRouter>,
    );
    expect(datenschutz).toContain('data-testid="datenschutz-page"');

    const agb = renderToStaticMarkup(
      <MemoryRouter>
        <AgbPage />
      </MemoryRouter>,
    );
    expect(agb).toContain('data-testid="agb-page"');

    const lizenz = renderToStaticMarkup(
      <MemoryRouter>
        <LizenzbedingungenPage />
      </MemoryRouter>,
    );
    expect(lizenz).toContain('data-testid="lizenzbedingungen-page"');
  });

  it('Footer-Links sind auf Auth-Seiten sichtbar', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <LegalFooterLinks />
      </MemoryRouter>,
    );
    expect(html).toContain('data-testid="legal-footer-links"');
    expect(html).toContain('Impressum');
    expect(html).toContain('/datenschutz');
    expect(html).toContain('/agb');
    expect(html).toContain('/lizenzbedingungen');
  });

  it('Registrierung zeigt drei Zustimmungs-Checkboxen', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AuthProvider>
          <AppProvider initialSetup={DEFAULT_SETUP}>
            <RegisterPage />
          </AppProvider>
        </AuthProvider>
      </MemoryRouter>,
    );
    expect(html).toContain('data-testid="register-terms"');
    expect(html).toContain('data-testid="register-privacy"');
    expect(html).toContain('data-testid="register-license"');
    expect(html).toContain('data-testid="legal-footer-links"');
  });

  it('Admin zeigt Zustimmungsdaten', async () => {
    await loginAsDefaultAdmin();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <MemoryRouter>
          <AuthProvider>
            <AppProvider initialSetup={{ ...DEFAULT_SETUP, setupComplete: true }}>
              <AdminUsersPage />
            </AppProvider>
          </AuthProvider>
        </MemoryRouter>,
      );
    });
    expect(container.querySelector('[data-testid="admin-users-table"]')).not.toBeNull();
    expect(container.textContent).toContain('AGB');
    expect(container.textContent).toContain('Datenschutz');
    expect(container.textContent).toContain('Zustimmung');
    act(() => root.unmount());
    container.remove();
  });

  it('einheitlicher KI-/Dokument-Hinweis', () => {
    expect(OFFICEPILOT_LEGAL_DISCLAIMER).toContain('keine Rechts- oder Steuerberatung');
    expect(OFFICEPILOT_LEGAL_DISCLAIMER).toContain('prüfen');
  });
});
