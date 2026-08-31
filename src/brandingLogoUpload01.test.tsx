/**
 * BRANDING-01C — der produktive Logo-Pfad in den Firmendaten.
 *
 * Geprüft wird die Fehlergrenze: Eine abgelehnte Datei darf den bestehenden
 * Entwurf nicht anrühren, und der frühere Freitext-Weg, über den sich jede
 * Prüfung umgehen liess, darf nicht mehr existieren.
 *
 * Neutrale synthetische Dateien.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppProvider } from './context/AppContext';
import { AuthProvider } from './context/AuthContext';
import { BETA_TEST_COMPANY_PROFILE, BETA_TEST_SETUP } from './config/betaTestMode';
import { FirmendatenPage } from './pages/FirmendatenPage';
import { getCompanyProfile, hydrateCompanyProfileStore } from './services/companyProfileService';

const EXISTING_LOGO = 'data:image/png;base64,VORHANDEN';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

type Mount = { container: HTMLDivElement; root: Root };

function mountFirmendaten(): Mount {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <MemoryRouter initialEntries={['/firmendaten']}>
        <AuthProvider>
          <AppProvider initialSetup={BETA_TEST_SETUP}>
            <Routes>
              <Route path="/firmendaten" element={<FirmendatenPage />} />
            </Routes>
          </AppProvider>
        </AuthProvider>
      </MemoryRouter>,
    );
  });
  return { container, root };
}

function imageFile(signature: readonly number[], type: string, name: string): File {
  const bytes = new Uint8Array(signature.length + 16);
  bytes.set(signature, 0);
  return new File([bytes], name, { type });
}

/** Dateiauswahl simulieren: `files` ist normalerweise nicht beschreibbar. */
async function selectFile(input: HTMLInputElement, file: File): Promise<void> {
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
    /*
     * Der Handler ist asynchron: erst die Signaturprüfung, dann der
     * FileReader — beide melden sich über eigene Tasks. Ein paar Durchläufe
     * abwarten, statt eine feste Wartezeit zu raten.
     */
    for (let tick = 0; tick < 5; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });
}

function preview(container: HTMLElement): HTMLImageElement | null {
  return container.querySelector('[data-testid="company-logo-preview"]');
}

describe('BRANDING-01C Logo-Upload', () => {
  let mounted: Mount | null = null;

  beforeEach(() => {
    hydrateCompanyProfileStore({
      ...BETA_TEST_COMPANY_PROFILE,
      logoDataUrl: EXISTING_LOGO,
    });
  });

  afterEach(() => {
    if (mounted) {
      act(() => {
        mounted!.root.unmount();
      });
      mounted.container.remove();
      mounted = null;
    }
  });

  it('das Dateifeld erlaubt nur PNG, JPEG und WebP — kein SVG', () => {
    mounted = mountFirmendaten();
    const input = mounted.container.querySelector('#profile-logo-file') as HTMLInputElement;

    expect(input.getAttribute('accept')).toBe('image/png,image/jpeg,image/webp');
    expect(input.getAttribute('accept')).not.toContain('svg');
  });

  it('der freie Data-URL-Schreibweg ist geschlossen', () => {
    /*
     * Das frühere Textfeld konnte jede Zeichenkette in `logoDataUrl` schreiben
     * und damit Grössen-, Typ- und Signaturprüfung umgehen.
     */
    mounted = mountFirmendaten();

    expect(mounted.container.querySelector('#profile-logo')).toBeNull();

    const writableLogoInputs = [...mounted.container.querySelectorAll('input')].filter(
      (element) =>
        element.type === 'text' && (element.value ?? '').startsWith('data:'),
    );
    expect(writableLogoInputs).toEqual([]);
  });

  it('eine ungültige Datei lässt Vorschau und Profil unverändert und meldet den Fehler', async () => {
    mounted = mountFirmendaten();
    const input = mounted.container.querySelector('#profile-logo-file') as HTMLInputElement;
    expect(preview(mounted.container)?.getAttribute('src')).toBe(EXISTING_LOGO);

    // Als PNG angemeldet, tatsächlich eine SVG-Datei.
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    await selectFile(input, new File([svg], 'logo.png', { type: 'image/png' }));

    const error = mounted.container.querySelector('[data-testid="company-logo-error"]');
    expect(error?.textContent).toBe('Der Dateiinhalt passt nicht zum Dateiformat.');
    // Vorschau unverändert …
    expect(preview(mounted.container)?.getAttribute('src')).toBe(EXISTING_LOGO);
    // … und nichts persistiert.
    expect(getCompanyProfile().logoDataUrl).toBe(EXISTING_LOGO);
  });

  it('ein nicht unterstütztes Format wird abgelehnt', async () => {
    mounted = mountFirmendaten();
    const input = mounted.container.querySelector('#profile-logo-file') as HTMLInputElement;

    await selectFile(input, imageFile(PNG_SIGNATURE, 'image/gif', 'logo.gif'));

    const error = mounted.container.querySelector('[data-testid="company-logo-error"]');
    expect(error?.textContent).toBe(
      'Dieses Dateiformat wird nicht unterstützt. Bitte PNG, JPG oder WebP verwenden.',
    );
    expect(preview(mounted.container)?.getAttribute('src')).toBe(EXISTING_LOGO);
  });

  it('eine gültige Datei wird übernommen und ersetzt die Vorschau', async () => {
    mounted = mountFirmendaten();
    const input = mounted.container.querySelector('#profile-logo-file') as HTMLInputElement;

    await selectFile(input, imageFile(PNG_SIGNATURE, 'image/png', 'logo.png'));

    const src = preview(mounted.container)?.getAttribute('src') ?? '';
    /*
     * BRANDING-01E-2 — die Vorschau einer neu gewählten Datei ist jetzt eine
     * Object-URL statt einer Data-URL. Die eigentliche Zusicherung dieses Falls
     * bleibt unverändert: Die Auswahl ersetzt die Vorschau und wird noch nicht
     * gespeichert. Zusätzlich wird nun belegt, dass **keine** Data-URL mehr
     * entsteht — neue Uploads sollen nicht als Base64 im Profil landen.
     */
    expect(src.startsWith('data:')).toBe(false);
    expect(src).not.toBe(EXISTING_LOGO);
    expect(src.length).toBeGreaterThan(0);
    expect(mounted.container.querySelector('[data-testid="company-logo-error"]')).toBeNull();

    // Noch nicht gespeichert — das geschieht erst beim Absenden des Formulars.
    expect(getCompanyProfile().logoDataUrl).toBe(EXISTING_LOGO);
  });

  it('Logo entfernen leert den Entwurf, ohne sofort zu speichern', async () => {
    mounted = mountFirmendaten();
    const remove = mounted.container.querySelector(
      '[data-testid="company-logo-remove"]',
    ) as HTMLButtonElement;
    expect(remove).not.toBeNull();

    await act(async () => {
      remove.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(preview(mounted.container)).toBeNull();
    expect(
      mounted.container.querySelector('[data-testid="company-logo-remove"]'),
    ).toBeNull();
    // Erst das Speichern des Formulars macht es dauerhaft.
    expect(getCompanyProfile().logoDataUrl).toBe(EXISTING_LOGO);
  });
});
