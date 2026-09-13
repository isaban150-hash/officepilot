/**
 * COMPANY-SETTINGS-ENTRY-01B — der zentrale Einstellungsbereich.
 *
 * Geprüft wird ausschliesslich, was dieser Block leistet: Auffindbarkeit und
 * Bündelung. Die Firmenwahrheit selbst — `CompanyProfile` — bleibt unberührt,
 * und genau das hält der letzte Test fest: Die Einstellungsseite darf **keine**
 * zweite Pflegeoberfläche für dieselben Felder werden.
 *
 * Synthetische Daten, kein Netz.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppProvider } from './context/AppContext';
import { AuthProvider } from './context/AuthContext';
import { BETA_TEST_SETUP } from './config/betaTestMode';
import { EinstellungenPage } from './pages/EinstellungenPage';
import { FirmendatenLegacyRoute, resolveFirmendatenLegacyTarget } from './pages/settings/FirmendatenLegacyRoute';
import { CompanySettingsPage } from './pages/settings/CompanySettingsPage';
import { OperatingSettingsPage, OPERATING_SETTINGS_BACKUP_HREF } from './pages/settings/OperatingSettingsPage';
import { UserMenu } from './components/layout/UserMenu';
import { loginAsDefaultAdmin } from './test/authFixtures';
import {
  INVOICE_TEXTS_SECTION_ID,
  PAYMENT_TERMS_SECTION_ID,
} from './services/backupSectionNavigation';
import { INVOICE_SETTINGS_ROUTE } from './pages/settings/InvoiceSettingsPage';

type Mount = { container: HTMLDivElement; root: Root };

const mounted: Mount[] = [];

/** Der echte Routenraum dieses Blocks: Einstellungen und ihr Hauptziel. */
function mountAt(entry: string, element: React.ReactNode = <EinstellungenPage />): Mount {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter initialEntries={[entry]}>
        <AuthProvider>
          <AppProvider initialSetup={BETA_TEST_SETUP}>
            <Routes>
              <Route path="/einstellungen" element={element} />
              <Route path="/firmendaten" element={<FirmendatenLegacyRoute />} />
              <Route path="/einstellungen/firma" element={<CompanySettingsPage />} />
              <Route path="/einstellungen/betrieb" element={<OperatingSettingsPage />} />
              <Route path="/einstellungen/rechnungen" element={<div data-testid="invoice-settings-stub" />} />
              <Route path="/einstellungen/design" element={<div data-testid="design-settings-stub" />} />
              <Route path="/mehr" element={<div data-testid="mehr-page-stub" />} />
              <Route path="/admin/users" element={<div data-testid="admin-users-stub" />} />
            </Routes>
          </AppProvider>
        </AuthProvider>
      </MemoryRouter>,
    );
  });
  const mount = { container, root };
  mounted.push(mount);
  return mount;
}

function entryHref(mount: Mount, id: string): string | null {
  return mount.container
    .querySelector(`[data-testid="settings-entry-${id}"]`)
    ?.getAttribute('href') ?? null;
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  while (mounted.length > 0) {
    const mount = mounted.pop()!;
    act(() => mount.root.unmount());
    mount.container.remove();
  }
});

describe('01B — Einstellungen als zentraler Einstieg', () => {
  it('M1/M7: /einstellungen rendert und ist direkt aufrufbar', () => {
    const mount = mountAt('/einstellungen');

    expect(mount.container.querySelector('[data-testid="einstellungen-page"]')).toBeTruthy();
    expect(mount.container.textContent).toContain('Einstellungen');
  });

  it('M8: alle Kernbereiche sind vorhanden — auch in einer Spalte', () => {
    const mount = mountAt('/einstellungen');

    // SETTINGS-01B2 — Firma, Rechnungen & Zahlungen, Dokumente & Design, Betrieb.
    for (const group of ['company', 'documents', 'design', 'team']) {
      expect(
        mount.container.querySelector(`[data-testid="settings-group-${group}"]`),
        `Bereich fehlt: ${group}`,
      ).toBeTruthy();
    }
    /* Keine Kachelwand: die Einträge sind Zeilen, nicht Karten. */
    expect(mount.container.querySelectorAll('.settings-row').length).toBeGreaterThanOrEqual(4);
    expect(mount.container.querySelectorAll('.mehr-link-card').length).toBe(0);
  });

  it('M4: der Firmenprofil-Eintrag führt auf die kanonische Firmenprofil-Seite (SETTINGS-01B2)', () => {
    const mount = mountAt('/einstellungen');

    expect(entryHref(mount, 'company-profile')).toBe('/einstellungen/firma');
  });

  it('M5: Rechnungen & Zahlungen führen auf die eine Unterseite (SETTINGS-01B4), nicht zu einem zweiten Formular', () => {
    const mount = mountAt('/einstellungen');

    expect(entryHref(mount, 'invoices')).toBe(INVOICE_SETTINGS_ROUTE);
    expect(entryHref(mount, 'payment-terms')).toBeNull();
    expect(entryHref(mount, 'invoice-texts')).toBeNull();
    /* Auf der Einstellungsseite selbst wird nichts bearbeitet. */
    expect(mount.container.querySelector('input')).toBeNull();
    expect(mount.container.querySelector('form')).toBeNull();
  });

  it('M5b: die Legacy-Tiefenlinks laufen nicht ins Leere — jeder bekannte Hash hat ein kanonisches Ziel (SETTINGS-01B5)', () => {
    expect(resolveFirmendatenLegacyTarget(`#${PAYMENT_TERMS_SECTION_ID}`)).toBe('/einstellungen/rechnungen');
    expect(resolveFirmendatenLegacyTarget(`#${INVOICE_TEXTS_SECTION_ID}`)).toBe('/einstellungen/rechnungen');
    expect(resolveFirmendatenLegacyTarget('#logo')).toBe('/einstellungen/design');
    expect(resolveFirmendatenLegacyTarget('#datensicherung')).toBe(OPERATING_SETTINGS_BACKUP_HREF);
    expect(resolveFirmendatenLegacyTarget('')).toBe('/einstellungen/firma');
    expect(resolveFirmendatenLegacyTarget('#unbekannt')).toBe('/einstellungen/firma');
    for (const target of ['', '#logo', '#zahlungsbedingungen', '#datensicherung', '#x']) {
      expect(resolveFirmendatenLegacyTarget(target).startsWith('/firmendaten')).toBe(false);
    }
  });

  it('M6: Betrieb führt auf ein bestehendes Ziel', () => {
    const mount = mountAt('/einstellungen');

    expect(entryHref(mount, 'operations')).toBe('/einstellungen/betrieb'); // SETTINGS-01B5
  });

  it('M10: die Seite führt keine eigene Firmendatenquelle ein', () => {
    const mount = mountAt('/einstellungen');

    /*
     * Der entscheidende Test dieses Blocks. Entstünde hier ein Feld für
     * Firmenname, IBAN oder Steuernummer, gäbe es eine zweite Pflegestelle für
     * dieselbe Wahrheit — und beim nächsten Bearbeiten wüsste niemand mehr,
     * welche gilt.
     */
    expect(mount.container.querySelectorAll('input, textarea, select').length).toBe(0);
  });

  it('M9: /firmendaten führt auf die kanonische Firmenprofil-Seite — keine alte Formularseite mehr (SETTINGS-01B5)', () => {
    const mount = mountAt('/firmendaten', <div />);

    expect(mount.container.querySelector('[data-testid="settings-company-page"]')).toBeTruthy();
    expect(mount.container.querySelector('#settings-company-companyName')).toBeTruthy();
    expect(mount.container.querySelector('#settings-company-iban')).toBeTruthy();
    expect(mount.container.querySelector('.company-profile-form #profile-companyName')).toBeNull();
    expect(mount.container.querySelector('#profile-payment-days')).toBeNull();
    expect(mount.container.querySelector('input[type="file"]')).toBeNull();
  });
});

describe('01C — Tiefenlinks springen sichtbar zum Abschnitt', () => {
  /*
   * Der Sichttest auf dem echten Bildschirm hat gezeigt: Die Adresse trug den
   * Hash, die Seite blieb aber stehen — der Zielabschnitt lag rund 2.600 Pixel
   * unterhalb. React Router scrollt bei client-seitiger Navigation nicht von
   * selbst, und der vorhandene Effekt kannte nur die Datensicherung.
   *
   * Diese Regression hält die Verallgemeinerung fest, damit ein künftiger
   * Abschnitt nicht wieder still ins Leere zeigt.
   */
  // SETTINGS-01B5 — der einzige verbliebene Abschnitts-Tiefenlink ist die Datensicherung auf der Betriebsseite.
  for (const sectionId of ['datensicherung']) {
    it(`springt zu #${sectionId}`, async () => {
      const scrolled: string[] = [];
      const original = Element.prototype.scrollIntoView;
      Element.prototype.scrollIntoView = function scrollIntoViewSpy(this: Element) {
        scrolled.push(this.id);
      };
      const frames: FrameRequestCallback[] = [];
      const originalRaf = window.requestAnimationFrame;
      window.requestAnimationFrame = ((cb: FrameRequestCallback) => {
        frames.push(cb);
        return frames.length;
      }) as typeof window.requestAnimationFrame;

      try {
        mountAt(`/einstellungen/betrieb#${sectionId}`, <div />);
        await act(async () => {
          for (const frame of frames.splice(0)) frame(0);
          await Promise.resolve();
        });
        expect(scrolled).toContain(sectionId);
      } finally {
        Element.prototype.scrollIntoView = original;
        window.requestAnimationFrame = originalRaf;
      }
    });
  }
});

describe('01B — Einstieg über das Benutzermenü', () => {
  async function mountMenu(): Promise<Mount> {
    /* Ohne angemeldeten Benutzer rendert das Menü nichts — der Test wäre leer. */
    await loginAsDefaultAdmin();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={['/']}>
          <AuthProvider>
            <AppProvider initialSetup={BETA_TEST_SETUP}>
              <UserMenu />
            </AppProvider>
          </AuthProvider>
        </MemoryRouter>,
      );
      await Promise.resolve();
    });
    const mount = { container, root };
    mounted.push(mount);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (container.querySelector('[data-testid="user-menu"]')) break;
      await act(async () => {
        await Promise.resolve();
      });
    }
    return mount;
  }

  it('M2/M3: das Benutzermenü bietet „Einstellungen" und zeigt auf /einstellungen', async () => {
    const mount = await mountMenu();
    const trigger = mount.container.querySelector<HTMLElement>(
      '[data-testid="user-menu-dropdown-trigger"]',
    );
    expect(trigger, 'Benutzermenü nicht gerendert — der Test wäre sonst aussagelos').toBeTruthy();

    act(() => trigger!.click());

    const entry = mount.container.querySelector('[data-testid="user-menu-einstellungen"]');
    expect(entry, 'Eintrag „Einstellungen" fehlt').toBeTruthy();
    expect(entry?.getAttribute('href')).toBe('/einstellungen');
    expect(entry?.textContent).toContain('Einstellungen');
  });
});
