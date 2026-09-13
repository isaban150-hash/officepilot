/**
 * SETTINGS-01B3 — der reine Vorschau-Builder für „So sieht Ihr Dokument aus".
 *
 * Kernzusicherung: **nichts wird angelegt oder verändert** — keine Rechnung,
 * kein Nummernkreis, kein Profil, kein Vorgang. Firmenwerte sind echt aus dem
 * Entwurf, alles andere neutrale Beispieldaten. Der geschützte Snapshot von
 * `InvoiceDocumentView` bleibt unberührt (kein `toMatchSnapshot` hier).
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider } from '../../context/AppContext';
import { AuthProvider } from '../../context/AuthContext';
import { InvoiceDocumentView } from '../../components/invoice/InvoiceDocumentView';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import { DEFAULT_SETUP } from '../../data/mockData';
import { resetTestStores } from '../../test/resetStores';
import { getCompanyProfile, hydrateCompanyProfileStore } from '../companyProfileService';
import { getInvoiceNumberSequenceSnapshot, getNextInvoiceNumberPreview } from '../invoiceNumberService';
import { getVorgangStoreSnapshot } from '../vorgangService';
import * as resolver from '../branding/brandingAssetResolver';
import type { CompanyProfile } from '../../types/models';
import { buildSettingsDocumentPreviewModel, PREVIEW_INVOICE_NUMBER } from './settingsDocumentPreview';

const PROFILE: CompanyProfile = {
  ...DEFAULT_COMPANY_PROFILE,
  companyName: 'Vorschau Haustechnik',
  legalForm: 'GmbH',
  street: 'Werkstraße 2',
  zip: '54321',
  city: 'Betriebsstadt',
  taxNumber: '143/123/45678',
  bankName: 'Musterbank',
  iban: 'DE89370400440532013000',
  bic: 'MUSTDEFF',
  accountHolder: 'Vorschau Haustechnik GmbH',
  defaultPaymentDays: 10,
  defaultPaymentTerms: 'Zahlbar innerhalb von 10 Tagen ohne Abzug.',
  defaultIntroText: 'Einleitung aus dem Profil.',
  defaultClosingText: 'Schluss aus dem Profil.',
};

describe('SETTINGS-01B3 — buildSettingsDocumentPreviewModel', () => {
  beforeEach(() => {
    resetTestStores();
    hydrateCompanyProfileStore(PROFILE);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resetTestStores();
  });

  it('P1/P2: erzeugt keine Rechnung, reserviert keine Nummer, schreibt nichts', () => {
    const persist = vi.spyOn(Storage.prototype, 'setItem');
    const sequenceBefore = JSON.stringify(getInvoiceNumberSequenceSnapshot());
    const nextBefore = getNextInvoiceNumberPreview();
    const vorgaengeBefore = JSON.stringify(getVorgangStoreSnapshot());
    const profileBefore = JSON.stringify(getCompanyProfile());

    const model = buildSettingsDocumentPreviewModel({ profile: getCompanyProfile(), logo: { kind: 'none' }, issueDate: '2026-09-13' });

    expect(model.invoiceNumber).toBe(PREVIEW_INVOICE_NUMBER);
    expect(JSON.stringify(getInvoiceNumberSequenceSnapshot())).toBe(sequenceBefore);
    expect(getNextInvoiceNumberPreview()).toBe(nextBefore);
    expect(JSON.stringify(getVorgangStoreSnapshot())).toBe(vorgaengeBefore);
    expect(JSON.stringify(getCompanyProfile())).toBe(profileBefore);
    expect(persist).not.toHaveBeenCalled();
  });

  it('P3: Firmenwerte kommen aus dem aktuellen Entwurf (Name, Anschrift, Bank, Kontoinhaber, Texte)', () => {
    const draft = { ...getCompanyProfile(), companyName: 'Ungespeichert GmbH', accountHolder: 'Neuer Kontoinhaber' };
    const model = buildSettingsDocumentPreviewModel({ profile: draft, logo: { kind: 'none' }, issueDate: '2026-09-13' });
    expect(model.company.companyName).toBe('Ungespeichert GmbH');
    expect(model.company.accountHolder).toBe('Neuer Kontoinhaber');
    expect(model.company.iban).toBe('DE89370400440532013000');
    expect(model.introText).toBe('Einleitung aus dem Profil.');
    expect(model.closingText).toBe('Schluss aus dem Profil.');
    expect(model.paymentTermsText).toBe('Zahlbar innerhalb von 10 Tagen ohne Abzug.');
    expect(model.paymentDueDate).toBe('2026-09-23');
    // Neutrale Beispieldaten — kein echter Kunde, kein echter Vorgang.
    expect(model.customer.name).toBe('Beispiel Kunde GmbH');
    expect(model.positions.length).toBe(2);
    expect(model.summary.subtotalNet).toBe(710);
    expect(model.summary.grossTotal).toBeCloseTo(844.9, 2);
  });

  it('P4/P5: Logo-Zustände (ausstehend, gespeichert, entfernt) und Vorlage classic — ohne Backfill', () => {
    const reference = { assetId: 'asset-neu', mimeType: 'image/png' as const };
    expect(buildSettingsDocumentPreviewModel({ profile: PROFILE, logo: { kind: 'asset', reference } }).logo).toEqual({ kind: 'asset', reference });
    expect(buildSettingsDocumentPreviewModel({ profile: PROFILE, logo: { kind: 'legacy_data_url', dataUrl: 'blob:x' } }).logo).toEqual({ kind: 'legacy_data_url', dataUrl: 'blob:x' });
    expect(buildSettingsDocumentPreviewModel({ profile: PROFILE, logo: { kind: 'none' } }).logo).toEqual({ kind: 'none' });

    // Altes Profil ohne documentTemplate → Vorschau classic, Profil bleibt ohne Feld.
    const legacy: CompanyProfile = { ...PROFILE, branding: { logo: reference } };
    const model = buildSettingsDocumentPreviewModel({ profile: legacy, logo: { kind: 'none' } });
    expect(model.documentTemplate).toBe('classic');
    expect(legacy.branding?.documentTemplate).toBeUndefined();
    expect(buildSettingsDocumentPreviewModel({ profile: { ...PROFILE, branding: { documentTemplate: 'classic' } }, logo: { kind: 'none' } }).documentTemplate).toBe('classic');
  });

  it('P6: rendert mit dem echten InvoiceDocumentView — inkl. Logo-Object-URL des Entwurfs', async () => {
    vi.spyOn(resolver, 'resolveBrandingAsset').mockResolvedValue({ ok: true, blob: new Blob([new Uint8Array([0x89, 0x50])], { type: 'image/png' }) });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const model = buildSettingsDocumentPreviewModel({
      profile: getCompanyProfile(),
      logo: { kind: 'legacy_data_url', dataUrl: 'data:image/png;base64,QUJD' },
      issueDate: '2026-09-13',
    });
    await act(async () => {
      root.render(
        <MemoryRouter>
          <AuthProvider>
            <AppProvider initialSetup={{ ...DEFAULT_SETUP, setupComplete: true }}>
              <InvoiceDocumentView model={model} />
            </AppProvider>
          </AuthProvider>
        </MemoryRouter>,
      );
    });
    for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });

    expect(host.querySelector('.invoice-document')).not.toBeNull();
    expect(host.textContent).toContain('Vorschau Haustechnik');
    expect(host.textContent).toContain(PREVIEW_INVOICE_NUMBER);
    expect(host.textContent).toContain('Beispiel Kunde GmbH');
    expect(host.textContent).toContain('Vorschau Haustechnik GmbH');
    expect(host.querySelector('[data-testid="invoice-header-logo"]')?.getAttribute('src')).toBe('data:image/png;base64,QUJD');
    await act(async () => root.unmount());
    host.remove();
  });
});
