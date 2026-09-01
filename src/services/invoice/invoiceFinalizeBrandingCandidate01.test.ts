/**
 * INVOICE-FINALIZE-BRANDING-CANDIDATE-01B — der Finalisierungskandidat trägt
 * kein `companySnapshot.branding` mehr.
 *
 * Der Realtest scheiterte reproduzierbar mit
 * `request.invoice.companySnapshot.branding:unknown_field` — noch vor jedem
 * Serverkontakt. Ursache war nicht der Vertrag, sondern ein Übergangsrest im
 * Firmenblock: Seit BRANDING-01E-2 trägt das `CompanyProfile` einen
 * `branding`-Block, und der Entwurf kopiert das Profil vollständig.
 *
 * Diese Datei schliesst die Naht, die alle bisherigen Tests umgangen haben:
 * Sie prüften die **Payload**-Builder, nie den rohen Kandidaten im Request.
 *
 * Neutrale synthetische Daten, kein Netz.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  buildInvoiceDraftForType,
  buildInvoiceFinalizationCandidate,
} from '../invoiceService';
import {
  validatePreparedWorkspaceInvoiceFinalizeRequest,
  buildInvoicePayloadV1,
  PREPARED_FINALIZE_REQUEST_FORMAT_VERSION,
  PREPARED_FINALIZE_REQUEST_KIND,
} from './workspaceInvoiceFinalizeRequestValidator';
import { buildExpectedPreparedResponseProjection } from './invoicePreparedResponseProjection';
import { selectHistoricalInvoiceLogo } from './invoiceHistoricalLogo';
import { immutableInvoiceFingerprint } from '../vorgangService';
import { hydrateCompanyProfileStore } from '../companyProfileService';
import { hydrateVorgangStore } from '../vorgangService';
import { DEFAULT_SETUP } from '../../data/mockData';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import { createTestVorgang } from '../../test/fixtures';
import * as scopeService from '../storage/storageScopeService';
import * as workspacePayload from '../workspace/workspaceSyncPayloadService';
import { resetTestStores } from '../../test/resetStores';
import type { BrandingProfile } from '../../types/branding';
import type { CompanyProfile, InvoiceDraft, VorgangInvoice } from '../../types/models';

const VORGANG_ID = 'vg-branding-candidate';
const WORKSPACE_ID = 'ws-branding-candidate';
const CLIENT_INVOICE_ID = 'inv-branding-candidate';

const BRANDING: BrandingProfile = {
  logo: { assetId: 'asset-a-1111', mimeType: 'image/png' },
  primaryColor: '#123456',
};
const LEGACY_LOGO = 'data:image/png;base64,AAAA';

/** Die Vorbereitung übernimmt den Firmennamen in den Freigabekontext. */
const SETUP = { ...DEFAULT_SETUP, companyName: 'Beispiel Betrieb GmbH' };

function company(overrides: Partial<CompanyProfile> = {}): CompanyProfile {
  return {
    ...DEFAULT_COMPANY_PROFILE,
    companyName: 'Beispiel Betrieb GmbH',
    street: 'Werkstraße 2',
    zip: '54321',
    city: 'Betriebsstadt',
    email: 'kontakt@example.invalid',
    phone: '030 000000',
    taxNumber: '11/222/33333',
    iban: 'DE89370400440532013000',
    ...overrides,
  };
}

/** Ein Entwurf, wie ihn ein Betrieb mit gesetztem Branding heute erzeugt. */
function brandingDraft(): InvoiceDraft {
  hydrateCompanyProfileStore(company({ branding: BRANDING, logoDataUrl: LEGACY_LOGO }));
  const draft = buildInvoiceDraftForType(VORGANG_ID, DEFAULT_SETUP, 'rechnung');
  expect(draft, 'Entwurf konnte nicht gebaut werden').not.toBeNull();
  // Vorbedingung des Realtests: der Entwurf trägt den Übergangsrest.
  expect(draft!.companySnapshot.branding).toEqual(BRANDING);
  expect(draft!.brandingSnapshot?.logo).toEqual(BRANDING.logo);
  return draft!;
}

function candidateOf(draft: InvoiceDraft): VorgangInvoice {
  const built = buildInvoiceFinalizationCandidate(
    VORGANG_ID,
    draft,
    DEFAULT_SETUP,
    CLIENT_INVOICE_ID,
  );
  expect(built, JSON.stringify(built)).toMatchObject({ ok: true });
  if (!built.ok) throw new Error('candidate failed');
  return built.invoice;
}

/**
 * Der vollständige vorbereitete Request — aus dem **echten** Kandidaten und dem
 * **echten** Payload-Builder zusammengesetzt, genau wie es
 * `buildPreparationSynchronously` tut.
 *
 * Bewusst ohne `prepareInvoiceDraftFinalization`: Das würde eine Anmeldung und
 * einen Cloud-Pull verlangen. Geprüft werden soll hier die Struktur des
 * Kandidaten, nicht die Infrastruktur davor.
 */
function buildRequestEnvelope(rawInvoice: VorgangInvoice): Record<string, unknown> {
  // Wie in der Produktion: der Träger geht einmal durch JSON.
  const invoice = JSON.parse(JSON.stringify(rawInvoice)) as VorgangInvoice;
  const built = buildInvoicePayloadV1(invoice);
  expect(built, 'Payload konnte nicht gebaut werden').not.toBeNull();
  const invoicePayload = JSON.parse(JSON.stringify(built)) as Record<string, unknown>;
  const projection = buildExpectedPreparedResponseProjection(
    invoicePayload,
    CLIENT_INVOICE_ID,
  );
  expect(projection, 'Projektion konnte nicht gebaut werden').not.toBeNull();

  return {
    kind: PREPARED_FINALIZE_REQUEST_KIND,
    formatVersion: PREPARED_FINALIZE_REQUEST_FORMAT_VERSION,
    workspaceId: WORKSPACE_ID,
    vorgangId: VORGANG_ID,
    clientInvoiceId: CLIENT_INVOICE_ID,
    invoice,
    invoicePayload,
    expectedResponseProjectionRawJson: projection,
  } as unknown as Record<string, unknown>;
}

beforeEach(() => {
  vi.restoreAllMocks();
  resetTestStores();
  hydrateVorgangStore([createTestVorgang({ id: VORGANG_ID, invoices: [] })]);
  // Die Vorbereitung verlangt einen aktiven Workspace-Scope.
  scopeService.setActiveStorageScope({ type: 'workspace', workspaceId: WORKSPACE_ID });
  vi.spyOn(workspacePayload, 'resolveCloudWorkspaceId').mockReturnValue(WORKSPACE_ID);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('INVOICE-FINALIZE-BRANDING-CANDIDATE-01B — Kandidat und Request', () => {
  // TEST 1
  it('K1: der Kandidat trägt kein companySnapshot.branding, aber den vollen Snapshot', () => {
    const invoice = candidateOf(brandingDraft());

    expect('branding' in (invoice.companySnapshot ?? {})).toBe(false);
    expect(invoice.brandingSnapshot).toEqual({
      version: 1,
      logo: BRANDING.logo,
      primaryColor: '#123456',
    });
  });

  // TEST 4
  it('K2: die fertige Rechnung behält das Legacy-Logo unverändert', () => {
    const invoice = candidateOf(brandingDraft());
    expect(invoice.companySnapshot?.logoDataUrl).toBe(LEGACY_LOGO);
  });

  /*
   * TEST 2 — die bisher fehlende Naht.
   *
   * Nicht der Payload-Builder, sondern der vollständige vorbereitete Request
   * inklusive des rohen Kandidaten. Genau hier scheiterte der Realtest.
   */
  it('K3: der vorbereitete Finalize-Request eines Branding-Entwurfs ist gültig', () => {
    const request = buildRequestEnvelope(candidateOf(brandingDraft()));

    const checked = validatePreparedWorkspaceInvoiceFinalizeRequest(request);
    expect(checked, JSON.stringify(checked)).toMatchObject({ ok: true });

    // Und ausdrücklich nicht der Realtest-Fehler.
    if (!checked.ok) {
      expect(checked.detail).not.toContain('companySnapshot.branding');
    }
  });

  // TEST 3
  it('K4: der Payload bleibt wie in 01F-2 — ohne branding, mit brandingSnapshot', async () => {
    const invoice = candidateOf(brandingDraft());
    const payload = buildInvoicePayloadV1(invoice)!;

    expect('branding' in (payload.companySnapshot as Record<string, unknown>)).toBe(false);
    expect(payload.brandingSnapshot).toEqual({
      version: 1,
      logo: BRANDING.logo,
      primaryColor: '#123456',
    });
  });

  // TEST 9 — die Quelle wurde repariert, nicht der Vertrag aufgeweicht.
  it('K5: der Validator lehnt eingeschleustes companySnapshot.branding weiterhin ab', () => {
    const tampered = JSON.parse(
      JSON.stringify(buildRequestEnvelope(candidateOf(brandingDraft()))),
    ) as Record<string, unknown>;
    const invoice = tampered.invoice as Record<string, unknown>;
    (invoice.companySnapshot as Record<string, unknown>).branding = { ...BRANDING };

    const checked = validatePreparedWorkspaceInvoiceFinalizeRequest(tampered);
    expect(checked.ok).toBe(false);
    if (!checked.ok) {
      expect(checked.detail).toBe('request.invoice.companySnapshot.branding:unknown_field');
    }
  });

  // Der externe Vertrag bleibt unverändert.
  it('K6: die Request-Formatversion bleibt 3', () => {
    expect(PREPARED_FINALIZE_REQUEST_FORMAT_VERSION).toBe(3);
  });
});

describe('INVOICE-FINALIZE-BRANDING-CANDIDATE-01B — Logos und Fingerprint', () => {
  // TEST 5
  it('L1: eine neue Rechnung nutzt den Branding-Snapshot als Logoquelle', () => {
    const invoice = candidateOf(brandingDraft());
    expect(selectHistoricalInvoiceLogo(invoice)).toEqual({
      kind: 'asset',
      reference: BRANDING.logo,
    });
  });

  /*
   * TEST 6 — Übergangsrechnungen sind bereits gespeichert; sie werden nicht
   * umgeschrieben und dürfen ihre Quelle behalten. Der Selektor bleibt
   * unverändert.
   */
  it('L2: eine bestehende Übergangsrechnung nutzt weiterhin companySnapshot.branding', () => {
    const legacyTransition = {
      id: 'inv-alt',
      type: 'rechnung',
      companySnapshot: company({ branding: BRANDING }),
    } as unknown as VorgangInvoice;

    expect(selectHistoricalInvoiceLogo(legacyTransition)).toEqual({
      kind: 'asset',
      reference: BRANDING.logo,
    });
  });

  // TEST 7
  it('L3: eine alte Rechnung nutzt weiterhin das Legacy-Bild', () => {
    const legacy = {
      id: 'inv-legacy',
      type: 'rechnung',
      companySnapshot: company({ logoDataUrl: LEGACY_LOGO }),
    } as unknown as VorgangInvoice;

    expect(selectHistoricalInvoiceLogo(legacy)).toEqual({
      kind: 'legacy_data_url',
      dataUrl: LEGACY_LOGO,
    });
  });

  /*
   * TEST 8 — lokale und Cloudfassung müssen denselben Fingerprint ergeben.
   *
   * Der Fingerprint schneidet `logoDataUrl` heraus, `branding` aber nicht. Bevor
   * die Quelle repariert war, trug die lokale Rechnung ein Feld, das die
   * Cloudfassung nie bekam — der nächste Pull hätte das als
   * `id_content_conflict` gewertet.
   */
  it('L4: lokale und Cloud-Fassung sind fingerprint-gleich', () => {
    const local = candidateOf(brandingDraft());
    const payload = buildInvoicePayloadV1(local)!;
    const fromCloud = {
      ...local,
      companySnapshot: payload.companySnapshot as VorgangInvoice['companySnapshot'],
    } as VorgangInvoice;

    expect(immutableInvoiceFingerprint(local, VORGANG_ID)).toBe(
      immutableInvoiceFingerprint(fromCloud, VORGANG_ID),
    );
  });
});
