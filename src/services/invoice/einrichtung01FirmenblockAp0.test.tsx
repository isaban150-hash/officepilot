/**
 * EINRICHTUNG-01 (AP0, EIN-01, E17) — der Firmenblock von Rechnung und Angebot.
 *
 * Katalog V3:
 *   S-01.1  neue Rechnung nach gespeicherter Signatur und Vorlagen: Firmenblock ⊆ COMPANY_SNAPSHOT_KEYS,
 *           der Freigabekandidat besteht den Validator
 *   S-02.1  Altentwurf mit unzulässigen Schlüsseln: nur diese fallen weg, eingefrorene Werte bleiben
 *   S-02.3  Altentwurf ohne unzulässige Schlüssel: Freigabe wie bisher (gleicher Block, gleiche Reihenfolge)
 *   S-03.1  eingeschleustes unbekanntes Feld: Clientprüfung `unknown_field` (der Freigabeweg ruft den
 *           Server erst nach bestandener Prüfung, `invoicePreparedFinalizeService` → `request_invalid`)
 *   S-03.3/S-09.3  `COMPANY_SNAPSHOT_KEYS` unverändert und getrennt vom Profilvertrag
 *   S-03.9  Server-Positivliste (E17-Migration) = `COMPANY_SNAPSHOT_KEYS`
 *   S-04.1  Angebot: ohne Kommunikationsfelder; Name, Adresse, Steuer, Bank und Branding bleiben
 *   S-05.1  HTML-Ansicht mit und ohne die entfernten Felder identisch (neuer Vergleichstest,
 *           nicht `InvoiceDocumentView.test.tsx`)
 *   S-05.2  PDF: sichtbare Texte und eingebettete Bilder identisch, inklusive Logo, Rechtsform,
 *           Steuer-, Bank- und Zahlungsdaten
 *
 * Neutrale synthetische Daten, kein Netz.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';

import { buildInvoiceDraftForType, buildInvoiceFinalizationCandidate } from '../invoiceService';
import {
  validatePreparedWorkspaceInvoiceFinalizeRequest,
  buildInvoicePayloadV1,
  PREPARED_FINALIZE_REQUEST_FORMAT_VERSION,
  PREPARED_FINALIZE_REQUEST_KIND,
} from './workspaceInvoiceFinalizeRequestValidator';
import { buildExpectedPreparedResponseProjection } from './invoicePreparedResponseProjection';
import { COMPANY_SNAPSHOT_KEYS } from './companySnapshotFieldCatalog';
import { COMPANY_PROFILE_FIELD_CLASSES } from '../company/companyProfileFieldCatalog';
import { generateApprovedInvoicePdf } from '../invoicePdfService';
import { buildInvoicePrintModelFromInvoice } from '../invoicePrintModel';
import { InvoiceDocumentView } from '../../components/invoice/InvoiceDocumentView';
import { AppProvider } from '../../context/AppContext';
import { hydrateCompanyProfileStore } from '../companyProfileService';
import { hydrateVorgangStore } from '../vorgangService';
import { addOfferDraft, buildOfferFinalizationCandidate, emptyCustomerBilling, normalizeOfferPosition } from '../offer/offerService';
import { DEFAULT_SETUP } from '../../data/mockData';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import { createTestVorgangWithExecutedQuantity } from '../../test/fixtures';
import { alsInhaber } from '../../test/workspaceRoleTestUtils';
import * as scopeService from '../storage/storageScopeService';
import * as workspacePayload from '../workspace/workspaceSyncPayloadService';
import * as supabaseLib from '../../lib/supabase';
import { resetTestStores } from '../../test/resetStores';
import type { BrandingProfile } from '../../types/branding';
import type { CompanyProfile, InvoiceDraft, VorgangInvoice } from '../../types/models';

const VORGANG_ID = 'vg-ein01-firmenblock';
const WORKSPACE_ID = 'ws-ein01-firmenblock';
const CLIENT_INVOICE_ID = 'inv-ein01-firmenblock';

/** Ein echtes 1×1-PNG — `pdf-lib` bettet es tatsächlich ein. */
const PNG_EIN_PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const ALT_LOGO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/** Kommunikationsfelder (E-MAIL-07C, 01B): gehören ins Profil, nie in einen Beleg. */
const KOMMUNIKATION: Partial<CompanyProfile> = {
  emailSignature: 'Beispiel Haustechnik GmbH\nMusterstrasse 5',
  defaultOfferEmailSubject: 'Angebot {nummer}',
  defaultOfferEmailBody: 'Anbei unser Angebot.',
  defaultLetterEmailSubject: 'Schreiben',
  defaultLetterEmailBody: 'Anbei unser Schreiben.',
  defaultInvoiceEmailSubject: 'Rechnung {nummer}',
  defaultInvoiceEmailBody: 'Anbei die Rechnung.',
  senderDisplayName: 'Beispiel Haustechnik',
  replyToEmail: 'antwort@example.invalid',
};

const BRANDING: BrandingProfile = { logo: { assetId: 'asset-ein01-1111', mimeType: 'image/png' }, primaryColor: '#123456' };

function profil(overrides: Partial<CompanyProfile> = {}): CompanyProfile {
  return {
    ...DEFAULT_COMPANY_PROFILE,
    companyName: 'Beispiel Haustechnik',
    legalForm: 'GmbH',
    street: 'Musterstrasse 5',
    zip: '33602',
    city: 'Bielefeld',
    contactPerson: 'A. Beispiel',
    email: 'info@example.invalid',
    phone: '0521 000000',
    taxNumber: '305/123/45678',
    bankName: 'Beispielbank',
    iban: 'DE89370400440532013000',
    bic: 'COBADEFFXXX',
    accountHolder: 'Beispiel Haustechnik GmbH',
    ...overrides,
  };
}

function entwurf(): InvoiceDraft {
  const draft = buildInvoiceDraftForType(VORGANG_ID, DEFAULT_SETUP, 'rechnung');
  expect(draft, 'Entwurf konnte nicht gebaut werden').not.toBeNull();
  return {
    ...draft!,
    servicePeriodFrom: '2026-08-01',
    servicePeriodTo: '2026-08-20',
    servicePeriodConfirmed: true,
  };
}

function kandidat(draft: InvoiceDraft): VorgangInvoice {
  const built = buildInvoiceFinalizationCandidate(VORGANG_ID, draft, DEFAULT_SETUP, CLIENT_INVOICE_ID);
  expect(built, JSON.stringify(built)).toMatchObject({ ok: true });
  if (!built.ok) throw new Error('candidate failed');
  return built.invoice;
}

/** Der vollständige vorbereitete Request aus echtem Kandidaten und echtem Payload-Builder. */
function request(rawInvoice: VorgangInvoice): Record<string, unknown> {
  const invoice = JSON.parse(JSON.stringify(rawInvoice)) as VorgangInvoice;
  const built = buildInvoicePayloadV1(invoice);
  expect(built, 'Payload konnte nicht gebaut werden').not.toBeNull();
  const invoicePayload = JSON.parse(JSON.stringify(built)) as Record<string, unknown>;
  return {
    kind: PREPARED_FINALIZE_REQUEST_KIND,
    formatVersion: PREPARED_FINALIZE_REQUEST_FORMAT_VERSION,
    workspaceId: WORKSPACE_ID,
    vorgangId: VORGANG_ID,
    clientInvoiceId: CLIENT_INVOICE_ID,
    invoice,
    invoicePayload,
    expectedResponseProjectionRawJson: buildExpectedPreparedResponseProjection(invoicePayload, CLIENT_INVOICE_ID),
  };
}

function schluessel(snapshot: unknown): string[] {
  return Object.keys((snapshot ?? {}) as Record<string, unknown>);
}

const ERLAUBT: ReadonlySet<string> = new Set<string>(COMPANY_SNAPSHOT_KEYS);

beforeEach(() => {
  vi.restoreAllMocks();
  resetTestStores();
  hydrateVorgangStore([createTestVorgangWithExecutedQuantity({ id: VORGANG_ID, invoices: [] })]);
  scopeService.setActiveStorageScope({ type: 'workspace', workspaceId: WORKSPACE_ID });
  vi.spyOn(workspacePayload, 'resolveCloudWorkspaceId').mockReturnValue(WORKSPACE_ID);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('EINRICHTUNG-01 AP0 — Firmenblock aus einer Positivliste', () => {
  it('S-01.1: nach gespeicherter Signatur und Vorlagen enthält der Firmenblock nur Vertragsschlüssel; der Kandidat ist gültig', () => {
    hydrateCompanyProfileStore(profil({ ...KOMMUNIKATION, branding: BRANDING, logoDataUrl: PNG_EIN_PIXEL }));
    const draft = entwurf();

    // Am Entwurf: Vertragsschlüssel, dazu wie bisher `branding` (fällt bei der Freigabe weg).
    for (const key of schluessel(draft.companySnapshot)) {
      expect(ERLAUBT.has(key) || key === 'branding', `Entwurf trägt ${key}`).toBe(true);
    }
    for (const key of Object.keys(KOMMUNIKATION)) {
      expect(key in draft.companySnapshot, `Kommunikationsfeld ${key} im Entwurf`).toBe(false);
    }

    const invoice = kandidat(draft);
    for (const key of schluessel(invoice.companySnapshot)) {
      expect(ERLAUBT.has(key), `Kandidat trägt ${key}`).toBe(true);
    }
    expect(invoice.companySnapshot?.companyName).toBe('Beispiel Haustechnik');
    expect(invoice.companySnapshot?.accountHolder).toBe('Beispiel Haustechnik GmbH');
    expect(invoice.companySnapshot?.logoDataUrl).toBe(PNG_EIN_PIXEL);

    const checked = validatePreparedWorkspaceInvoiceFinalizeRequest(request(invoice));
    expect(checked, JSON.stringify(checked)).toMatchObject({ ok: true });
  });

  it('S-02.1: ein Altentwurf mit unzulässigen Schlüsseln wird freigebbar; nur diese fallen weg, eingefrorene Werte bleiben', () => {
    hydrateCompanyProfileStore(profil({ logoDataUrl: ALT_LOGO }));
    const neu = entwurf();
    const alt: InvoiceDraft = {
      ...neu,
      taxStatus: 'standard_7',
      companySnapshot: {
        ...neu.companySnapshot,
        companyName: 'Alt GmbH',
        taxNumber: '111/111/11111',
        logoDataUrl: ALT_LOGO,
        ...KOMMUNIKATION,
      } as CompanyProfile,
    };

    // Das Profil hat sich seither geändert — heutige Werte dürfen nicht übernommen werden.
    hydrateCompanyProfileStore(
      profil({ ...KOMMUNIKATION, companyName: 'Neu GmbH', taxNumber: '999/999/99999', logoDataUrl: PNG_EIN_PIXEL, defaultTaxStatus: 'standard_19' }),
    );

    const invoice = kandidat(alt);
    const block = invoice.companySnapshot as unknown as Record<string, unknown>;
    for (const key of Object.keys(KOMMUNIKATION)) expect(key in block, `${key} blieb stehen`).toBe(false);
    expect(block.companyName).toBe('Alt GmbH');
    expect(block.taxNumber).toBe('111/111/11111');
    expect(block.logoDataUrl).toBe(ALT_LOGO);
    expect(invoice.taxStatus).toBe('standard_7');

    // Genau die unzulässigen Schlüssel fehlen, alles andere ist der eingefrorene Block.
    const { branding: _branding, ...erwartet } = alt.companySnapshot as unknown as Record<string, unknown>;
    for (const key of Object.keys(KOMMUNIKATION)) delete erwartet[key];
    expect(block).toEqual(erwartet);

    const checked = validatePreparedWorkspaceInvoiceFinalizeRequest(request(invoice));
    expect(checked, JSON.stringify(checked)).toMatchObject({ ok: true });
  });

  it('S-02.3: ein Altentwurf ohne unzulässige Schlüssel ergibt denselben Block in derselben Reihenfolge wie bisher', () => {
    hydrateCompanyProfileStore(profil({ branding: BRANDING, logoDataUrl: PNG_EIN_PIXEL }));
    const draft = entwurf();
    const invoice = kandidat(draft);

    // Bisherige Regel (cloneCompanySnapshot vor AP0): Entwurfsblock ohne `branding`, `logoDataUrl` wie am Entwurf.
    const { branding: _branding, ...rest } = draft.companySnapshot as unknown as Record<string, unknown>;
    const bisher = { ...rest, logoDataUrl: draft.companySnapshot.logoDataUrl };
    expect(JSON.stringify(invoice.companySnapshot)).toBe(JSON.stringify(bisher));
  });

  it('S-03.1: ein eingeschleustes unbekanntes Feld scheitert an der Clientprüfung mit unknown_field', () => {
    hydrateCompanyProfileStore(profil());
    const manipuliert = JSON.parse(JSON.stringify(request(kandidat(entwurf())))) as Record<string, unknown>;
    ((manipuliert.invoice as Record<string, unknown>).companySnapshot as Record<string, unknown>).emailSignature = 'eingeschleust';

    const checked = validatePreparedWorkspaceInvoiceFinalizeRequest(manipuliert);
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.detail).toBe('request.invoice.companySnapshot.emailSignature:unknown_field');
  });

  it('S-03.3/S-09.3: COMPANY_SNAPSHOT_KEYS ist unverändert und kennt keine Kommunikations- oder Vorbelegungsfelder', () => {
    expect([...COMPANY_SNAPSHOT_KEYS]).toEqual([
      'companyName', 'legalForm', 'logoDataUrl', 'street', 'zip', 'city', 'country', 'countryCode', 'contactPerson',
      'phone', 'email', 'website', 'taxNumber', 'vatId', 'registrationAuthority', 'registrationNumber', 'bankName',
      'iban', 'bic', 'accountHolder', 'defaultPaymentDays', 'defaultPaymentTerms', 'defaultSkonto', 'skontoEnabled',
      'skontoPercent', 'skontoDays', 'managingDirector', 'taxFreeNotice', 'invoiceFooterNotes',
    ]);
    for (const key of [
      ...Object.keys(KOMMUNIKATION), 'defaultIntroText', 'defaultClosingText', 'defaultTaxStatus', 'currency', 'branding',
    ]) {
      expect(ERLAUBT.has(key), key).toBe(false);
    }
    // Getrennt vom Profilvertrag: Das Profil führt mehr Felder als der Beleg.
    expect(Object.keys(COMPANY_PROFILE_FIELD_CLASSES).length).toBeGreaterThan(COMPANY_SNAPSHOT_KEYS.length);
    for (const key of COMPANY_SNAPSHOT_KEYS) expect(key in COMPANY_PROFILE_FIELD_CLASSES, key).toBe(true);
  });

  it('S-03.9: die Positivliste des Servers (E17) ist COMPANY_SNAPSHOT_KEYS', () => {
    const sql = readFileSync(join(process.cwd(), 'supabase/migrations/20261127120000_einrichtung01_e17_firmenblock.sql'), 'utf8');
    const block = /where k <> all \(array\[([^\]]+)\]::text\[\]\)/.exec(sql);
    expect(block, 'Positivliste im Helfer nicht gefunden').not.toBeNull();
    const server = [...block![1].matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]);
    expect(server).toEqual([...COMPANY_SNAPSHOT_KEYS]);
  });

  it('S-04.1: das Angebot friert keine Kommunikationsfelder ein; Name, Adresse, Steuer, Bank und Branding bleiben', () => {
    hydrateCompanyProfileStore(profil({ ...KOMMUNIKATION, branding: BRANDING }));
    const added = addOfferDraft(WORKSPACE_ID, {
      customer: { ...emptyCustomerBilling(), name: 'Musterbau GmbH' },
      title: 'Bad sanieren',
      positions: [normalizeOfferPosition({ description: 'Fliesenarbeiten', quantity: 2, unitPrice: 100 })],
      taxStatus: 'standard_19',
      offerDate: '2026-10-01',
      validUntil: '2026-10-31',
    });
    expect(added.success).toBe(true);
    if (!added.success) return;
    const candidate = buildOfferFinalizationCandidate(added.offer.id);
    expect(candidate, JSON.stringify(candidate)).toMatchObject({ ok: true });
    if (!candidate.ok) return;
    const block = candidate.content.companySnapshot as unknown as Record<string, unknown>;
    for (const key of Object.keys(block)) expect(ERLAUBT.has(key) || key === 'branding', `Angebot trägt ${key}`).toBe(true);
    for (const key of Object.keys(KOMMUNIKATION)) expect(key in block, key).toBe(false);
    expect(block).toMatchObject({
      companyName: 'Beispiel Haustechnik',
      street: 'Musterstrasse 5',
      zip: '33602',
      city: 'Bielefeld',
      taxNumber: '305/123/45678',
      iban: 'DE89370400440532013000',
      bic: 'COBADEFFXXX',
      branding: BRANDING,
    });
    expect(candidate.content.brandingSnapshot?.logo).toEqual(BRANDING.logo);
  });
});

/* ------------------------------------------------------------------ */
/* S-05 — dieselbe Ausgabe mit und ohne die entfernten Felder          */
/* ------------------------------------------------------------------ */

async function pdfText(bytes: Uint8Array): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const pdf = await pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: true, verbosity: 0, useWorkerFetch: false }).promise;
  try {
    const parts: string[] = [];
    for (let index = 1; index <= pdf.numPages; index += 1) {
      const content = await (await pdf.getPage(index)).getTextContent();
      for (const item of content.items) if ('str' in item && item.str.trim()) parts.push(item.str);
    }
    return parts.join('\n');
  } finally {
    await pdf.destroy();
  }
}

/** Prüfsummen aller eingebetteten Bilder (Bildobjekte), sortiert — Bytes und Zeitstempel des PDFs sind egal. */
async function pdfBilder(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes);
  const hashes: string[] = [];
  for (const [, object] of doc.context.enumerateIndirectObjects()) {
    if (object instanceof PDFRawStream && object.dict.get(PDFName.of('Subtype')) === PDFName.of('Image')) {
      hashes.push(createHash('sha256').update(object.contents).digest('hex'));
    }
  }
  return hashes.sort();
}

function htmlOf(invoice: VorgangInvoice): string {
  const html = renderToStaticMarkup(
    <AppProvider initialSetup={{ ...DEFAULT_SETUP, setupComplete: true }}>
      <InvoiceDocumentView model={buildInvoicePrintModelFromInvoice(invoice)} />
    </AppProvider>,
  );
  return html.replace(/\s+/g, ' ').trim();
}

describe('EINRICHTUNG-01 AP0 — Darstellung unverändert (S-05)', () => {
  beforeEach(() => {
    alsInhaber();
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(false);
  });

  function paar(): { bereinigt: VorgangInvoice; mitAltfeldern: VorgangInvoice } {
    hydrateCompanyProfileStore(profil({ logoDataUrl: PNG_EIN_PIXEL, managingDirector: 'A. Beispiel', vatId: 'DE123456789' }));
    const neu = entwurf();
    const alt: InvoiceDraft = { ...neu, companySnapshot: { ...neu.companySnapshot, ...KOMMUNIKATION } as CompanyProfile };
    const bereinigt: VorgangInvoice = {
      ...kandidat(alt),
      number: '2026-0042',
      status: 'vorbereitet',
      date: '2026-09-01',
      issueDate: '2026-09-01',
      paymentDueDate: '2026-09-15',
      paymentTermsText: 'Zahlbar innerhalb von 14 Tagen ohne Abzug.',
    } as VorgangInvoice;
    const mitAltfeldern: VorgangInvoice = {
      ...bereinigt,
      companySnapshot: { ...bereinigt.companySnapshot, ...KOMMUNIKATION } as CompanyProfile,
    };
    for (const key of Object.keys(KOMMUNIKATION)) expect(key in (bereinigt.companySnapshot ?? {})).toBe(false);
    return { bereinigt, mitAltfeldern };
  }

  it('S-05.1: die HTML-Ansicht ist mit und ohne die entfernten Felder identisch', () => {
    const { bereinigt, mitAltfeldern } = paar();
    const a = htmlOf(bereinigt);
    const b = htmlOf(mitAltfeldern);
    expect(a.length).toBeGreaterThan(500);
    expect(a).toContain('Beispiel Haustechnik');
    expect(a).toBe(b);
  });

  it('S-05.2: das PDF zeigt mit und ohne die entfernten Felder dieselben Texte und Bilder', async () => {
    const { bereinigt, mitAltfeldern } = paar();
    const [pa, pb] = await Promise.all([generateApprovedInvoicePdf(bereinigt), generateApprovedInvoicePdf(mitAltfeldern)]);
    expect(pa, JSON.stringify(pa)).toMatchObject({ ok: true });
    expect(pb, JSON.stringify(pb)).toMatchObject({ ok: true });
    if (!pa.ok || !pb.ok) return;

    const [ta, tb] = [await pdfText(pa.bytes), await pdfText(pb.bytes)];
    expect(ta).toBe(tb);
    for (const sichtbar of ['Beispiel Haustechnik', 'GmbH', '305/123/45678', 'DE123456789', 'DE89', 'COBADEFFXXX', 'Zahlbar innerhalb von 14 Tagen']) {
      expect(ta, sichtbar).toContain(sichtbar);
    }
    for (const unsichtbar of ['Anbei unser Angebot', 'antwort@example.invalid']) expect(ta).not.toContain(unsichtbar);

    const [ba, bb] = [await pdfBilder(pa.bytes), await pdfBilder(pb.bytes)];
    expect(ba.length, 'das Logo ist eingebettet').toBeGreaterThan(0);
    expect(ba).toEqual(bb);
  });
});
