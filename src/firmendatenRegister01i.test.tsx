/**
 * COMPANY-PROFILE-REGISTER-01I — Registergericht und Registernummer in den
 * Firmendaten.
 *
 * Geprüft wird der normale Weg: Feld ausfüllen, Formular absenden, Seite neu
 * aufbauen. Keine Abkürzung über den Store — genau dieser Pfad ist die Zusage
 * an den Betrieb.
 *
 * Zusätzlich der Sync-Vertrag: Beide Werte müssen unverändert in der
 * Cloud-Nutzlast stehen und aus ihr zurückkommen, und ein älteres Profil ohne
 * diese Felder muss weiterhin gültig sein. Keine echte Cloud.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppProvider } from './context/AppContext';
import { AuthProvider } from './context/AuthContext';
import { BETA_TEST_COMPANY_PROFILE, BETA_TEST_SETUP } from './config/betaTestMode';
import { FirmendatenPage } from './pages/FirmendatenPage';
import {
  getCompanyProfile,
  hydrateCompanyProfileStore,
  updateCompanyProfile,
} from './services/companyProfileService';
import {
  buildCompanyProfileCloudPayload,
  parseCompanyProfileFromCloud,
} from './services/workspace/workspaceCloudService';
import type { CompanyProfile } from './types/models';

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

function setNativeInputValue(input: HTMLInputElement, value: string): void {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  act(() => {
    descriptor?.set?.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('01I — J: Firmendaten-Oberfläche', () => {
  let mounted: Mount | null = null;

  beforeEach(() => {
    hydrateCompanyProfileStore({ ...BETA_TEST_COMPANY_PROFILE });
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

  it('J1/J2: beide Felder sind sichtbar und tragen ihre deutschen Bezeichnungen', () => {
    mounted = mountFirmendaten();

    const authority = mounted.container.querySelector(
      '#profile-registrationAuthority',
    ) as HTMLInputElement;
    const number = mounted.container.querySelector(
      '#profile-registrationNumber',
    ) as HTMLInputElement;

    expect(authority).not.toBeNull();
    expect(number).not.toBeNull();
    expect(authority.name).toBe('registrationAuthority');
    expect(number.name).toBe('registrationNumber');

    const labels = Array.from(mounted.container.querySelectorAll('label')).map(
      (l) => l.textContent,
    );
    expect(labels).toContain('Registergericht');
    expect(labels).toContain('Registernummer');

    /* Ohne Beispiel landet beides in einem Feld — der Platzhalter ist Teil der Aussage. */
    expect(authority.placeholder).toBe('Amtsgericht Lemgo');
    expect(number.placeholder).toBe('HRB 12345');

    /* Und keines der beiden ist ein Pflichtfeld. */
    expect(authority.required).toBe(false);
    expect(number.required).toBe(false);
  });

  it('J3: die Werte werden über den normalen Speicherpfad gespeichert', () => {
    mounted = mountFirmendaten();

    setNativeInputValue(
      mounted.container.querySelector('#profile-registrationAuthority') as HTMLInputElement,
      'Amtsgericht Lemgo',
    );
    setNativeInputValue(
      mounted.container.querySelector('#profile-registrationNumber') as HTMLInputElement,
      'HRB 12345',
    );

    act(() => {
      (mounted!.container.querySelector('button[type="submit"]') as HTMLButtonElement).click();
    });

    expect(mounted.container.querySelector('.form-error')).toBeNull();
    expect(getCompanyProfile().registrationAuthority).toBe('Amtsgericht Lemgo');
    expect(getCompanyProfile().registrationNumber).toBe('HRB 12345');
  });

  it('J4: nach einem Neuaufbau stehen die Werte wieder im Formular', () => {
    hydrateCompanyProfileStore({
      ...BETA_TEST_COMPANY_PROFILE,
      registrationAuthority: 'Amtsgericht Lemgo',
      registrationNumber: 'HRB 12345',
    });
    mounted = mountFirmendaten();

    expect(
      (mounted.container.querySelector('#profile-registrationAuthority') as HTMLInputElement).value,
    ).toBe('Amtsgericht Lemgo');
    expect(
      (mounted.container.querySelector('#profile-registrationNumber') as HTMLInputElement).value,
    ).toBe('HRB 12345');
  });

  it('J5: leer gelassene Registerfelder verhindern das Speichern nicht', () => {
    mounted = mountFirmendaten();

    act(() => {
      (mounted!.container.querySelector('button[type="submit"]') as HTMLButtonElement).click();
    });

    expect(mounted.container.querySelector('.form-error')).toBeNull();
    expect(getCompanyProfile().registrationAuthority ?? '').toBe('');
    expect(getCompanyProfile().registrationNumber ?? '').toBe('');
  });

  it('äußere Leerzeichen werden beim Speichern entfernt, der Rest bleibt', () => {
    hydrateCompanyProfileStore({ ...BETA_TEST_COMPANY_PROFILE });

    const result = updateCompanyProfile({
      registrationAuthority: '  Amtsgericht Lemgo  ',
      registrationNumber: ' HRB 12345 ',
    });

    expect(result.success).toBe(true);
    expect(getCompanyProfile().registrationAuthority).toBe('Amtsgericht Lemgo');
    expect(getCompanyProfile().registrationNumber).toBe('HRB 12345');
  });
});

describe('01I — I: Sync-Roundtrip', () => {
  const MIT_REGISTER: CompanyProfile = {
    ...BETA_TEST_COMPANY_PROFILE,
    registrationAuthority: 'Amtsgericht Lemgo',
    registrationNumber: 'HRB 12345',
    branding: { version: 1, primaryColor: '#123456' },
  };

  it('I1/I2: die Cloud-Nutzlast trägt beide Werte', () => {
    const payload = buildCompanyProfileCloudPayload(MIT_REGISTER);
    const inner = payload.payload as Record<string, unknown>;

    expect(inner.registrationAuthority).toBe('Amtsgericht Lemgo');
    expect(inner.registrationNumber).toBe('HRB 12345');
  });

  it('I3: der Rückweg erhält beide unverändert', () => {
    const payload = buildCompanyProfileCloudPayload(MIT_REGISTER);
    const parsed = parseCompanyProfileFromCloud(payload);

    expect(parsed?.registrationAuthority).toBe('Amtsgericht Lemgo');
    expect(parsed?.registrationNumber).toBe('HRB 12345');
  });

  it('I4: ein älteres Profil ohne die Felder bleibt gültig', () => {
    const alt = { ...BETA_TEST_COMPANY_PROFILE };
    delete (alt as Partial<CompanyProfile>).registrationAuthority;
    delete (alt as Partial<CompanyProfile>).registrationNumber;

    const parsed = parseCompanyProfileFromCloud(buildCompanyProfileCloudPayload(alt));

    expect(parsed).not.toBeNull();
    expect(parsed?.companyName).toBe(BETA_TEST_COMPANY_PROFILE.companyName);
    expect(parsed?.registrationAuthority).toBeUndefined();

    /* Und der lokale Store nimmt ihn ohne Murren auf. */
    hydrateCompanyProfileStore(parsed!);
    expect(getCompanyProfile().registrationAuthority ?? '').toBe('');
  });

  it('I5: der Branding-Unterblock bleibt davon unberührt', () => {
    const parsed = parseCompanyProfileFromCloud(buildCompanyProfileCloudPayload(MIT_REGISTER));

    /*
     * Der Branding-Vertrag lässt bewusst nur seine eigenen Schlüssel durch —
     * `version` fällt dabei weg. Das ist bestehendes Verhalten aus
     * BRANDING-01E-1 und nicht Gegenstand dieses Blocks. Geprüft wird hier nur,
     * dass die neuen Registerfelder daran nichts ändern.
     */
    expect(parsed?.branding?.primaryColor).toBe('#123456');
  });
});

/**
 * COMPANY-PROFILE-REGISTER-01I — der Rechnungs-Cloud-Vertrag.
 *
 * Anders als beim Firmenprofil ist die Feldliste des `companySnapshot` im
 * Rechnungspayload **geschlossen**. Ohne die beiden neuen Schlüssel hätte der
 * eigene Validator jede Rechnung eines eingetragenen Betriebs abgelehnt — der
 * Befund kam aus dem Regressionslauf, nicht aus der Vorabanalyse.
 */
describe('01I — Rechnungs-Cloud-Vertrag kennt die Registerfelder', () => {
  const REGISTER_INVOICE = {
    id: 'inv-01i',
    number: 'RE-2026-0001',
    type: 'rechnung',
    positions: [],
    subtotal: 100,
    taxStatus: 'standard_19',
    amount: 119,
    status: 'vorbereitet',
    date: '2026-09-01',
    createdAt: '2026-09-01T08:00:00.000Z',
    companySnapshot: {
      ...BETA_TEST_COMPANY_PROFILE,
      registrationAuthority: 'Amtsgericht Lemgo',
      registrationNumber: 'HRB 12345',
      branding: undefined,
    },
  };

  it('der Validator akzeptiert eine Rechnung mit Registerangaben', async () => {
    const { buildWorkspaceInvoiceFinalizePayload } = await import(
      './services/invoice/workspaceInvoiceCloudService'
    );
    const { validateWorkspaceInvoiceCloudPayload } = await import(
      './services/invoice/workspaceInvoiceCloudPayloadValidator'
    );

    const payload = buildWorkspaceInvoiceFinalizePayload(
      REGISTER_INVOICE as never,
    ) as Record<string, unknown>;
    const result = validateWorkspaceInvoiceCloudPayload(JSON.parse(JSON.stringify(payload)));

    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect((payload.companySnapshot as Record<string, unknown>).registrationNumber).toBe(
      'HRB 12345',
    );
  });

  it('der Rückweg aus der Cloud trägt die Registerangaben zurück in den Snapshot', async () => {
    const { buildWorkspaceInvoiceFinalizePayload, mapCloudPayloadToVorgangInvoice } = await import(
      './services/invoice/workspaceInvoiceCloudService'
    );

    const payload = JSON.parse(
      JSON.stringify(buildWorkspaceInvoiceFinalizePayload(REGISTER_INVOICE as never)),
    );
    const pulled = mapCloudPayloadToVorgangInvoice(payload);

    expect(pulled?.companySnapshot?.registrationAuthority).toBe('Amtsgericht Lemgo');
    expect(pulled?.companySnapshot?.registrationNumber).toBe('HRB 12345');
  });
});
