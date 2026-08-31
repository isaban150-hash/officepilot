/**
 * BRANDING-01E-2 — der produktive Branding-Asset-Upload in den Firmendaten.
 *
 * Die tragende Zusicherung dieses Blocks ist nicht „ein Logo lässt sich
 * hochladen", sondern **wann** hochgeladen wird. Assets sind unveränderlich und
 * nicht löschbar; jeder überflüssige Upload hinterlässt für immer ein Objekt im
 * Bucket. Deshalb prüfen die meisten Fälle hier, dass gerade **nicht**
 * hochgeladen wird.
 *
 * Neutrale synthetische Dateien, gemockter Storage — kein Netzzugriff.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppProvider } from './context/AppContext';
import { AuthProvider } from './context/AuthContext';
import { BETA_TEST_COMPANY_PROFILE, BETA_TEST_SETUP } from './config/betaTestMode';
import { FirmendatenPage } from './pages/FirmendatenPage';
import * as profileService from './services/companyProfileService';
import { getCompanyProfile, hydrateCompanyProfileStore } from './services/companyProfileService';
import * as assetCloud from './services/branding/brandingAssetCloudService';
import * as resolver from './services/branding/brandingAssetResolver';
import * as syncClient from './services/sync/syncClientService';
import type { CompanyProfile } from './types/models';

const WORKSPACE_ID = '11111111-2222-4333-8444-555555555555';
const EXISTING_LOGO = 'data:image/png;base64,VORHANDEN';
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const REFERENCE_A = { assetId: 'asset-aaa', mimeType: 'image/png' } as const;
const REFERENCE_B = { assetId: 'asset-bbb', mimeType: 'image/png' } as const;

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

/** Zum Typ passende Anfangsbytes — der Validator prüft die Signatur. */
const SIGNATURES: Record<string, readonly number[]> = {
  'image/png': PNG_SIGNATURE,
  'image/jpeg': [0xff, 0xd8, 0xff, 0xe0],
  'image/webp': [
    0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
  ],
};

function imageFile(type: string, name: string): File {
  const signature = SIGNATURES[type] ?? PNG_SIGNATURE;
  const bytes = new Uint8Array(signature.length + 16);
  bytes.set(signature, 0);
  return new File([bytes], name, { type });
}

/**
 * React verfolgt den Eingabewert selbst; ein direktes `value =` bliebe für den
 * Zustand unsichtbar. Deshalb der native Setter.
 */
async function setInput(container: HTMLElement, selector: string, value: string): Promise<void> {
  const field = container.querySelector(selector) as HTMLInputElement;
  expect(field).not.toBeNull();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  await act(async () => {
    setter?.call(field, value);
    field.dispatchEvent(new Event('input', { bubbles: true }));
    await flush();
  });
}

async function flush(): Promise<void> {
  for (let tick = 0; tick < 6; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function selectFile(input: HTMLInputElement, file: File): Promise<void> {
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await act(async () => {
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
  });
}

async function submit(container: HTMLElement): Promise<void> {
  const form = container.querySelector('form') as HTMLFormElement;
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    await flush();
  });
}

async function click(container: HTMLElement, testId: string): Promise<void> {
  const button = container.querySelector(`[data-testid="${testId}"]`) as HTMLButtonElement;
  expect(button).not.toBeNull();
  await act(async () => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await flush();
  });
}

function fileInput(container: HTMLElement): HTMLInputElement {
  return container.querySelector('#profile-logo-file') as HTMLInputElement;
}

function preview(container: HTMLElement): HTMLImageElement | null {
  return container.querySelector('[data-testid="company-logo-preview"]');
}

function text(container: HTMLElement, testId: string): string | null {
  return container.querySelector(`[data-testid="${testId}"]`)?.textContent ?? null;
}

describe('BRANDING-01E-2 — Branding-Asset-Upload in den Firmendaten', () => {
  let mounted: Mount | null = null;
  let upload: ReturnType<typeof vi.spyOn>;

  function hydrate(overrides: Partial<CompanyProfile> = {}): void {
    hydrateCompanyProfileStore({
      ...BETA_TEST_COMPANY_PROFILE,
      logoDataUrl: EXISTING_LOGO,
      ...overrides,
    });
  }

  beforeEach(() => {
    hydrate();
    vi.spyOn(syncClient, 'getSyncClient').mockReturnValue({
      deviceId: 'device-1',
      workspaceId: WORKSPACE_ID,
      serverWorkspaceId: WORKSPACE_ID,
    } as ReturnType<typeof syncClient.getSyncClient>);
    upload = vi
      .spyOn(assetCloud, 'uploadBrandingAsset')
      .mockResolvedValue({ ok: true, reference: REFERENCE_A });
    vi.spyOn(resolver, 'resolveBrandingAsset').mockResolvedValue({
      ok: true,
      blob: new Blob([new Uint8Array(PNG_SIGNATURE)], { type: 'image/png' }),
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
    vi.restoreAllMocks();
  });

  /* ---------------------------------------------------------------- Auswahl */

  it.each(['image/png', 'image/jpeg', 'image/webp'])(
    'nimmt eine gültige %s-Auswahl an, ohne hochzuladen',
    async (mimeType) => {
      mounted = mountFirmendaten();
      await selectFile(fileInput(mounted.container), imageFile(mimeType, `logo.${mimeType}`));

      expect(mounted.container.querySelector('[data-testid="company-logo-error"]')).toBeNull();
      expect(upload).not.toHaveBeenCalled();
    },
  );

  it('erzeugt bei der Auswahl keine Data-URL und verändert das Profil nicht', async () => {
    mounted = mountFirmendaten();
    await selectFile(fileInput(mounted.container), imageFile('image/png', 'logo.png'));

    const src = preview(mounted.container)?.getAttribute('src') ?? '';
    expect(src.startsWith('data:')).toBe(false);
    expect(getCompanyProfile().logoDataUrl).toBe(EXISTING_LOGO);
    expect(getCompanyProfile().branding).toBeUndefined();
  });

  it('lädt nichts hoch, wenn die Seite ohne Speichern verlassen wird', async () => {
    mounted = mountFirmendaten();
    await selectFile(fileInput(mounted.container), imageFile('image/png', 'logo.png'));

    act(() => {
      mounted!.root.unmount();
    });
    mounted.container.remove();
    mounted = null;

    expect(upload).not.toHaveBeenCalled();
  });

  it('bewahrt bei ungültigem Inhalt das vorhandene Logo und lädt nichts hoch', async () => {
    mounted = mountFirmendaten();
    const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    await selectFile(fileInput(mounted.container), new File([svg], 'logo.png', { type: 'image/png' }));

    expect(text(mounted.container, 'company-logo-error')).toBe(
      'Der Dateiinhalt passt nicht zum Dateiformat.',
    );
    expect(preview(mounted.container)?.getAttribute('src')).toBe(EXISTING_LOGO);
    expect(upload).not.toHaveBeenCalled();
  });

  /* -------------------------------------------------------- Upload und Save */

  it('lädt nichts hoch, wenn die Profilvalidierung scheitert', async () => {
    mounted = mountFirmendaten();
    await selectFile(fileInput(mounted.container), imageFile('image/png', 'logo.png'));

    // Firmenname leeren — die bestehende Validierung lehnt das Profil ab.
    await setInput(mounted.container, '#profile-companyName', '');
    await submit(mounted.container);
    expect(upload).not.toHaveBeenCalled();
  });

  it('lädt nichts hoch, wenn kein Server-Workspace vorhanden ist', async () => {
    vi.spyOn(syncClient, 'getSyncClient').mockReturnValue({
      deviceId: 'device-1',
      workspaceId: 'local',
    } as ReturnType<typeof syncClient.getSyncClient>);

    mounted = mountFirmendaten();
    await selectFile(fileInput(mounted.container), imageFile('image/png', 'logo.png'));
    await submit(mounted.container);

    expect(upload).not.toHaveBeenCalled();
    expect(text(mounted.container, 'company-logo-error')).toContain('Cloud verbunden');
    expect(getCompanyProfile().branding?.logo).toBeUndefined();
  });

  it('lädt beim Speichern genau einmal hoch und speichert nur die Referenz', async () => {
    mounted = mountFirmendaten();
    await selectFile(fileInput(mounted.container), imageFile('image/png', 'logo.png'));
    await submit(mounted.container);

    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: WORKSPACE_ID, mimeType: 'image/png' }),
    );

    const saved = getCompanyProfile();
    expect(saved.branding?.logo).toEqual(REFERENCE_A);
    expect(Object.keys(saved.branding?.logo ?? {}).sort()).toEqual(['assetId', 'mimeType']);

    const serialized = JSON.stringify(saved.branding);
    for (const forbidden of ['storagePath', 'signedUrl', 'publicUrl', 'bucket', 'data:', 'base64']) {
      expect(serialized).not.toContain(forbidden);
    }
  });

  it('bewahrt primaryColor und das Legacy-Logo beim neuen Upload', async () => {
    hydrate({ branding: { primaryColor: '#123456' } });
    mounted = mountFirmendaten();
    await selectFile(fileInput(mounted.container), imageFile('image/png', 'logo.png'));
    await submit(mounted.container);

    const saved = getCompanyProfile();
    expect(saved.branding?.primaryColor).toBe('#123456');
    expect(saved.branding?.logo).toEqual(REFERENCE_A);
    // Legacy bleibt lokal — kein automatischer Datenverlust (D-023).
    expect(saved.logoDataUrl).toBe(EXISTING_LOGO);
  });

  /* -------------------------------------------------- Pending-Reference     */

  it('lädt beim erneuten Speichern nach einem Save-Fehler nicht zweimal hoch', async () => {
    mounted = mountFirmendaten();
    await selectFile(fileInput(mounted.container), imageFile('image/png', 'logo.png'));

    /*
     * Der Save scheitert **nach** dem Upload. Das Asset liegt zu diesem
     * Zeitpunkt bereits unveränderlich im Bucket — ein zweiter Versuch darf
     * kein weiteres totes Objekt erzeugen.
     */
    const save = vi
      .spyOn(profileService, 'updateCompanyProfile')
      .mockReturnValueOnce({ success: false, errorKey: 'companyProfile.nameRequired' });

    await submit(mounted.container);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(getCompanyProfile().branding?.logo).toBeUndefined();

    save.mockRestore();
    await submit(mounted.container);

    // Kein zweiter Upload — und dieselbe Referenz.
    expect(upload).toHaveBeenCalledTimes(1);
    expect(getCompanyProfile().branding?.logo).toEqual(REFERENCE_A);
  });

  it('verwirft die Pending-Referenz bei einer anderen Dateiauswahl', async () => {
    mounted = mountFirmendaten();
    await selectFile(fileInput(mounted.container), imageFile('image/png', 'a.png'));

    const save = vi
      .spyOn(profileService, 'updateCompanyProfile')
      .mockReturnValueOnce({ success: false, errorKey: 'companyProfile.nameRequired' });
    await submit(mounted.container);
    expect(upload).toHaveBeenCalledTimes(1);

    save.mockRestore();
    upload.mockResolvedValue({ ok: true, reference: REFERENCE_B });
    await selectFile(fileInput(mounted.container), imageFile('image/png', 'b.png'));
    await submit(mounted.container);

    expect(upload).toHaveBeenCalledTimes(2);
    expect(getCompanyProfile().branding?.logo).toEqual(REFERENCE_B);
  });

  /* ------------------------------------------------------------- Uploadfehler */

  it('bewahrt bei Uploadfehler das bestehende Logo und erlaubt einen erneuten Versuch', async () => {
    upload.mockResolvedValue({ ok: false, error: 'network' });

    mounted = mountFirmendaten();
    await selectFile(fileInput(mounted.container), imageFile('image/png', 'logo.png'));
    await submit(mounted.container);

    expect(getCompanyProfile().branding?.logo).toBeUndefined();
    expect(getCompanyProfile().logoDataUrl).toBe(EXISTING_LOGO);
    expect(text(mounted.container, 'company-logo-error')).toContain('nicht gespeichert');

    // Die Datei ist noch gewählt: ein erneuter Versuch ohne Neuauswahl.
    upload.mockResolvedValue({ ok: true, reference: REFERENCE_A });
    await submit(mounted.container);
    expect(getCompanyProfile().branding?.logo).toEqual(REFERENCE_A);
  });

  /* ------------------------------------------------------------- Entfernen  */

  it('entfernt Referenz und Legacy-Logo, bewahrt primaryColor und setzt {}', async () => {
    hydrate({ branding: { logo: REFERENCE_A, primaryColor: '#123456' } });
    mounted = mountFirmendaten();

    await click(mounted.container, 'company-logo-remove');
    await submit(mounted.container);

    const saved = getCompanyProfile();
    expect(saved.branding?.logo).toBeUndefined();
    expect(saved.branding?.primaryColor).toBe('#123456');
    expect(saved.logoDataUrl).toBe('');
  });

  it('setzt branding auf {}, wenn nach dem Entfernen nichts übrig bleibt', async () => {
    hydrate({ branding: { logo: REFERENCE_A } });
    mounted = mountFirmendaten();

    await click(mounted.container, 'company-logo-remove');
    await submit(mounted.container);

    // D-022: nur `{}` ist das ausdrückliche Leeren, ein fehlender Schlüssel nicht.
    expect(getCompanyProfile().branding).toEqual({});
  });

  it('verwirft beim Entfernen auch eine noch nicht gespeicherte Pending-Referenz', async () => {
    mounted = mountFirmendaten();
    await selectFile(fileInput(mounted.container), imageFile('image/png', 'logo.png'));

    const save = vi
      .spyOn(profileService, 'updateCompanyProfile')
      .mockReturnValueOnce({ success: false, errorKey: 'companyProfile.nameRequired' });
    await submit(mounted.container);
    expect(upload).toHaveBeenCalledTimes(1);

    save.mockRestore();
    await click(mounted.container, 'company-logo-remove');
    await submit(mounted.container);

    expect(getCompanyProfile().branding?.logo).toBeUndefined();
    expect(getCompanyProfile().logoDataUrl).toBe('');
  });

  it('versucht beim Entfernen keinen Storage-Zugriff', async () => {
    const remove = vi.spyOn(assetCloud, 'downloadBrandingAsset');
    hydrate({ branding: { logo: REFERENCE_A } });
    mounted = mountFirmendaten();

    await click(mounted.container, 'company-logo-remove');
    await submit(mounted.container);

    expect(upload).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  /* --------------------------------------------------------------- Anzeige  */

  it('zeigt das gespeicherte Branding-Asset vor dem Legacy-Logo', async () => {
    hydrate({ branding: { logo: REFERENCE_A } });
    mounted = mountFirmendaten();
    await act(async () => {
      await flush();
    });

    expect(preview(mounted.container)?.getAttribute('data-logo-source')).toBe('branding_asset');
    expect(preview(mounted.container)?.getAttribute('src')).not.toBe(EXISTING_LOGO);
  });

  it('zeigt die gewählte Datei noch vor dem gespeicherten Asset', async () => {
    hydrate({ branding: { logo: REFERENCE_A } });
    mounted = mountFirmendaten();
    await selectFile(fileInput(mounted.container), imageFile('image/png', 'logo.png'));

    expect(preview(mounted.container)?.getAttribute('data-logo-source')).toBe('selected');
    expect(mounted.container.querySelector('[data-testid="company-logo-pending"]')).not.toBeNull();
  });

  it('fällt bei Resolver-Fehler sichtbar auf das Legacy-Logo zurück', async () => {
    vi.spyOn(resolver, 'resolveBrandingAsset').mockResolvedValue({ ok: false, error: 'not_found' });
    hydrate({ branding: { logo: REFERENCE_A } });
    mounted = mountFirmendaten();
    await act(async () => {
      await flush();
    });

    expect(preview(mounted.container)?.getAttribute('data-logo-source')).toBe('legacy');
    expect(preview(mounted.container)?.getAttribute('src')).toBe(EXISTING_LOGO);
    // Kein stiller Tausch: der Nutzer erfährt davon.
    expect(text(mounted.container, 'company-logo-fallback')).toContain('bisherige Logo');
  });

  it('zeigt bei Resolver-Fehler ohne Legacy-Logo gar kein Logo', async () => {
    vi.spyOn(resolver, 'resolveBrandingAsset').mockResolvedValue({ ok: false, error: 'not_found' });
    hydrate({ logoDataUrl: '', branding: { logo: REFERENCE_A } });
    mounted = mountFirmendaten();
    await act(async () => {
      await flush();
    });

    expect(preview(mounted.container)).toBeNull();
    expect(text(mounted.container, 'company-logo-fallback')).not.toBeNull();
  });

  /* -------------------------------------------- Erfolgszustand (R1)         */

  /*
   * Die Gegenrichtung zum Pending-Reference-Schutz: Nach einem **erfolgreichen**
   * Speichern darf nichts Schwebendes zurückbleiben. Sonst würde ein späterer
   * Speichervorgang — etwa nach dem Ändern der Telefonnummer — dieselbe Datei
   * ein zweites Mal als unveränderliches Asset ablegen.
   */
  it('beendet nach erfolgreichem Speichern den Pending-Zustand', async () => {
    mounted = mountFirmendaten();
    await selectFile(fileInput(mounted.container), imageFile('image/png', 'logo.png'));
    expect(preview(mounted.container)?.getAttribute('data-logo-source')).toBe('selected');

    await submit(mounted.container);
    await act(async () => {
      await flush();
    });

    // Die schwebende Auswahl ist beendet …
    expect(mounted.container.querySelector('[data-testid="company-logo-pending"]')).toBeNull();
    expect(preview(mounted.container)?.getAttribute('data-logo-source')).not.toBe('selected');
    // … die Anzeige kommt jetzt aus dem gespeicherten Profil über den Resolver.
    expect(preview(mounted.container)?.getAttribute('data-logo-source')).toBe('branding_asset');
    expect(getCompanyProfile().branding?.logo).toEqual(REFERENCE_A);
  });

  it('lädt beim Speichern eines anderen Feldes nicht erneut hoch', async () => {
    mounted = mountFirmendaten();
    await selectFile(fileInput(mounted.container), imageFile('image/png', 'logo.png'));
    await submit(mounted.container);
    expect(upload).toHaveBeenCalledTimes(1);

    // Irgendein anderes Firmenfeld ändern und erneut speichern.
    await setInput(mounted.container, '#profile-phone', '030 1234567');
    await submit(mounted.container);

    expect(upload).toHaveBeenCalledTimes(1);
    expect(getCompanyProfile().phone).toBe('030 1234567');
    // Die Referenz überlebt den zweiten Speichervorgang unverändert.
    expect(getCompanyProfile().branding?.logo).toEqual(REFERENCE_A);
  });

  it('gibt die Vorschau-Object-URL nach erfolgreichem Speichern frei', async () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL');
    mounted = mountFirmendaten();
    await selectFile(fileInput(mounted.container), imageFile('image/png', 'logo.png'));

    const selectedUrl = preview(mounted.container)?.getAttribute('src') ?? '';
    expect(selectedUrl.length).toBeGreaterThan(0);

    await submit(mounted.container);
    await act(async () => {
      await flush();
    });

    expect(revoke).toHaveBeenCalledWith(selectedUrl);
  });

  /* ------------------------------------------------------------- Sync       */

  /*
   * Der Sync-Tracker bildet seinen `contentKey` über
   * `stripLogoFromCompanyProfile`. Enthielte der die Logo-Referenz nicht, bliebe
   * ein Logowechsel für den Sync unsichtbar — er käme nie in die Cloud.
   */
  it('macht einen Logowechsel für die Änderungserkennung sichtbar', async () => {
    const { stripLogoFromCompanyProfile } = await import('./services/workspace/workspaceStore');
    const base = { ...BETA_TEST_COMPANY_PROFILE, logoDataUrl: EXISTING_LOGO };
    const before = JSON.stringify(
      stripLogoFromCompanyProfile({ ...base, branding: { logo: REFERENCE_A } }),
    );
    const after = JSON.stringify(
      stripLogoFromCompanyProfile({ ...base, branding: { logo: REFERENCE_B } }),
    );

    expect(before).not.toBe(after);
    expect(before).toContain('asset-aaa');
    // Das Legacy-Logo bleibt aussen vor — es geht ohnehin nie in die Cloud.
    expect(before).not.toContain('VORHANDEN');
  });

  it('nutzt den Resolver und baut keinen eigenen Download', async () => {
    const download = vi.spyOn(assetCloud, 'downloadBrandingAsset');
    hydrate({ branding: { logo: REFERENCE_A } });
    mounted = mountFirmendaten();
    await act(async () => {
      await flush();
    });

    expect(resolver.resolveBrandingAsset).toHaveBeenCalledWith(WORKSPACE_ID, REFERENCE_A);
    expect(download).not.toHaveBeenCalled();
  });
});
