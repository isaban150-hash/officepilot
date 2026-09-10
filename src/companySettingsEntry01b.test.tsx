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
import { FirmendatenPage } from './pages/FirmendatenPage';
import { UserMenu } from './components/layout/UserMenu';
import { loginAsDefaultAdmin } from './test/authFixtures';
import {
  FIRMENDATEN_INVOICE_TEXTS_HREF,
  FIRMENDATEN_PAYMENT_TERMS_HREF,
  INVOICE_TEXTS_SECTION_ID,
  PAYMENT_TERMS_SECTION_ID,
} from './services/backupSectionNavigation';

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
              <Route path="/firmendaten" element={<FirmendatenPage />} />
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

    for (const group of ['company', 'documents', 'payment', 'team']) {
      expect(
        mount.container.querySelector(`[data-testid="settings-group-${group}"]`),
        `Bereich fehlt: ${group}`,
      ).toBeTruthy();
    }
    /* Keine Kachelwand: die Einträge sind Zeilen, nicht Karten. */
    expect(mount.container.querySelectorAll('.settings-row').length).toBeGreaterThanOrEqual(4);
    expect(mount.container.querySelectorAll('.mehr-link-card').length).toBe(0);
  });

  it('M4: der Firmenprofil-Eintrag führt in die bestehenden Firmendaten', () => {
    const mount = mountAt('/einstellungen');

    expect(entryHref(mount, 'company-profile')).toBe('/firmendaten');
  });

  it('M5: Zahlungsbedingungen führen zur bestehenden Quelle, nicht zu einem zweiten Formular', () => {
    const mount = mountAt('/einstellungen');

    expect(entryHref(mount, 'payment-terms')).toBe(FIRMENDATEN_PAYMENT_TERMS_HREF);
    /* Auf der Einstellungsseite selbst wird nichts bearbeitet. */
    expect(mount.container.querySelector('input')).toBeNull();
    expect(mount.container.querySelector('form')).toBeNull();
  });

  it('M5b: der Zielanker existiert in den Firmendaten wirklich', () => {
    const mount = mountAt('/firmendaten', <div />);

    expect(mount.container.querySelector(`#${PAYMENT_TERMS_SECTION_ID}`)).toBeTruthy();
    expect(mount.container.querySelector(`#${INVOICE_TEXTS_SECTION_ID}`)).toBeTruthy();
  });

  it('M6: Rechnungstexte und Betrieb führen auf bestehende Ziele', () => {
    const mount = mountAt('/einstellungen');

    expect(entryHref(mount, 'invoice-texts')).toBe(FIRMENDATEN_INVOICE_TEXTS_HREF);
    expect(entryHref(mount, 'operations')).toBe('/mehr');
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

  it('M9: die bestehende Firmendatenseite bleibt funktionsfähig', () => {
    const mount = mountAt('/firmendaten', <div />);

    expect(mount.container.querySelector('#profile-companyName')).toBeTruthy();
    expect(mount.container.querySelector('#profile-iban')).toBeTruthy();
    expect(mount.container.querySelector('#profile-payment-days')).toBeTruthy();
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
  for (const sectionId of [PAYMENT_TERMS_SECTION_ID, INVOICE_TEXTS_SECTION_ID]) {
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
        mountAt(`/firmendaten#${sectionId}`, <div />);
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
