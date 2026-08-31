/**
 * BRANDING-01F-1R — der Branding-Snapshot überlebt den echten Entwurfsspeicher.
 *
 * Ein Entwurf kann Tage vor der Freigabe entstehen, zwischendurch persistiert,
 * nach einem Reload wieder geladen und erst dann finalisiert werden. Genau in
 * dieser Lücke könnte der Snapshot verloren gehen oder — schlimmer — aus dem
 * inzwischen geänderten Firmenprofil neu gebaut werden.
 *
 * Geprüft wird deshalb der **reale** Weg: erzeugen, speichern, über den
 * Locator neu laden (die Lage nach einem vollständigen Reload), Firmenprofil
 * ändern, dann finalisieren.
 *
 * Neutrale synthetische Daten, keine Netzzugriffe.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createInvoiceDraftRecord,
  loadInvoiceDraftRecordByLocator,
  resetInvoiceDraftDurabilityDatabaseForTests,
} from './invoiceDraftDurabilityService';
import { buildInvoiceDraftForType, finalizeInvoiceDraft } from '../invoiceService';
import { hydrateCompanyProfileStore } from '../companyProfileService';
import { hydrateVorgangStore } from '../vorgangService';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import { DEFAULT_SETUP } from '../../data/mockData';
import { createTestVorgang } from '../../test/fixtures';
import { resetTestStores } from '../../test/resetStores';
import type { BrandingProfile } from '../../types/branding';
import type { InvoiceDraftIdentity, InvoiceDraftLocator } from '../../types/invoiceDraftDurability';
import type { CompanyProfile, InvoiceDraft } from '../../types/models';

const WORKSPACE_ID = 'ws-branding-durability';
const SCOPE_KEY = `workspace:${WORKSPACE_ID}`;
const VORGANG_ID = 'vg-branding-durability';

const BRANDING_A: BrandingProfile = {
  logo: { assetId: 'asset-a-1111', mimeType: 'image/png' },
  primaryColor: '#111111',
};
const BRANDING_B: BrandingProfile = {
  logo: { assetId: 'asset-b-2222', mimeType: 'image/webp' },
  primaryColor: '#222222',
};

function setBranding(branding: BrandingProfile): void {
  hydrateCompanyProfileStore({
    ...DEFAULT_COMPANY_PROFILE,
    companyName: 'Beispiel Betrieb GmbH',
    street: 'Musterweg 5',
    zip: '10115',
    city: 'Berlin',
    email: 'kontakt@example.invalid',
    phone: '030 000000',
    taxNumber: '11/222/33333',
    iban: 'DE89370400440532013000',
    branding,
  } as unknown as CompanyProfile);
}

function identityFor(draft: InvoiceDraft): InvoiceDraftIdentity {
  return {
    sourceScopeKey: SCOPE_KEY,
    workspaceId: WORKSPACE_ID,
    vorgangId: VORGANG_ID,
    invoiceType: draft.type,
    draftId: draft.id,
  };
}

const LOCATOR: InvoiceDraftLocator = {
  sourceScopeKey: SCOPE_KEY,
  workspaceId: WORKSPACE_ID,
  vorgangId: VORGANG_ID,
  invoiceType: 'rechnung',
};

beforeEach(async () => {
  resetTestStores();
  hydrateVorgangStore([createTestVorgang({ id: VORGANG_ID })]);
  await resetInvoiceDraftDurabilityDatabaseForTests();
});

afterEach(async () => {
  await resetInvoiceDraftDurabilityDatabaseForTests();
});

describe('BRANDING-01F-1R — Snapshot über Persistenz, Reload und Finalisierung', () => {
  it('bewahrt den Snapshot über den echten Speicher- und Ladeweg', async () => {
    setBranding(BRANDING_A);

    const draft = buildInvoiceDraftForType(VORGANG_ID, DEFAULT_SETUP, 'rechnung');
    expect(draft).not.toBeNull();
    expect(draft!.brandingSnapshot).toEqual({
      version: 1,
      logo: BRANDING_A.logo,
      primaryColor: '#111111',
    });

    const created = await createInvoiceDraftRecord({ identity: identityFor(draft!), draft: draft! });
    expect(created.ok).toBe(true);

    // Die Lage nach einem vollständigen Reload: ohne bekannte draftId wiederfinden.
    const loaded = await loadInvoiceDraftRecordByLocator(LOCATOR);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    expect(loaded.draft.brandingSnapshot).toEqual({
      version: 1,
      logo: BRANDING_A.logo,
      primaryColor: '#111111',
    });

    /*
     * Jetzt wechselt das Firmenprofil. Der wiederhergestellte Entwurf darf das
     * nicht mitbekommen — und die Finalisierung darf den Snapshot nicht aus dem
     * aktuellen Profil neu bilden.
     */
    setBranding(BRANDING_B);

    const finalized = finalizeInvoiceDraft(VORGANG_ID, loaded.draft, DEFAULT_SETUP);
    expect(finalized).toMatchObject({ ok: true });
    if (!finalized.ok) return;

    expect(finalized.invoice.brandingSnapshot).toEqual({
      version: 1,
      logo: BRANDING_A.logo,
      primaryColor: '#111111',
    });
    // Ausdrücklich nicht der neue Stand.
    expect(finalized.invoice.brandingSnapshot?.logo?.assetId).not.toBe('asset-b-2222');
  });

  it('teilt nach dem Laden keine Objektinstanz mit dem Entwurf', async () => {
    setBranding(BRANDING_A);
    const draft = buildInvoiceDraftForType(VORGANG_ID, DEFAULT_SETUP, 'rechnung')!;
    await createInvoiceDraftRecord({ identity: identityFor(draft), draft });

    const loaded = await loadInvoiceDraftRecordByLocator(LOCATOR);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const finalized = finalizeInvoiceDraft(VORGANG_ID, loaded.draft, DEFAULT_SETUP);
    expect(finalized).toMatchObject({ ok: true });
    if (!finalized.ok) return;

    expect(finalized.invoice.brandingSnapshot).not.toBe(loaded.draft.brandingSnapshot);
    expect(finalized.invoice.brandingSnapshot?.logo).not.toBe(loaded.draft.brandingSnapshot?.logo);
  });

  it('bewahrt auch einen leeren Snapshot über den Speicherweg', async () => {
    setBranding({});
    const draft = buildInvoiceDraftForType(VORGANG_ID, DEFAULT_SETUP, 'rechnung')!;
    expect(draft.brandingSnapshot).toEqual({ version: 1 });

    await createInvoiceDraftRecord({ identity: identityFor(draft), draft });
    const loaded = await loadInvoiceDraftRecordByLocator(LOCATOR);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    expect(loaded.draft.brandingSnapshot).toEqual({ version: 1 });
  });
});
