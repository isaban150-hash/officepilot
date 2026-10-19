/**
 * GO-LIVE-SECURITY-01 — XRechnung und ZUGFeRD unter derselben Regel wie PDF und Druck.
 *
 * Ohne gültigen, bestätigten Leistungszeitraum verlässt keine E-Rechnung den
 * Betrieb: weder neu erzeugt noch eine bereits abgelegte Datei. Die Regel
 * stammt aus dem zentralen PDF-Validator und gilt für jede Rolle — wer
 * bestätigen darf, bestätigt zuerst, wie beim PDF.
 *
 * Neutrale Beispieldaten, kein Netzwerk.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureXRechnungArtifact } from './xrechnungArtifactService';
import { validateFinalizedInvoiceForPdf } from '../invoiceValidationService';
import { ensureZugferdArtifact } from './zugferd/zugferdArtifactService';
import { getDocumentFileRefStoreSnapshot, hydrateDocumentFileStore } from '../documentFileStoreService';
import {
  getDocumentFileRepresentationBindingStoreSnapshot,
  hydrateDocumentFileRepresentationBindingStore,
} from '../documentFileRepresentationBindingStoreService';
import { hydrateDocumentStore } from '../documentService';
import { clearDocumentBlobStoreForTests } from '../storage/documentBlobIndexedDbService';
import { resetTestStores } from '../../test/resetStores';
import type {
  CompanyDocument,
  CompanyProfile,
  CustomerBilling,
  VorgangInvoice,
  VorgangInvoiceLine,
} from '../../types/models';
import { alsInhaber } from '../../test/workspaceRoleTestUtils';

// SYS-04 (systemische Gesamtnacharbeit): Bei eingerichteter Cloud gibt eine unbekannte Sitzung keine Rechnung mehr aus.
// Diese Tests prüfen Inhalte der Ausgabe und laufen deshalb ausdrücklich als Inhaber (auch nach restoreAllMocks).
beforeEach(() => alsInhaber());

const VERKAEUFER = {
  companyName: 'Beispiel Betrieb GmbH',
  legalForm: 'GmbH',
  street: 'Werkstraße 2',
  zip: '54321',
  city: 'Beispielstadt',
  country: 'Deutschland',
  countryCode: 'DE',
  contactPerson: 'Beispiel Kontakt',
  phone: '0000 000000',
  email: 'buero@beispiel.invalid',
  website: '',
  taxNumber: '00/000/00000',
  vatId: 'DE111111111',
  bankName: 'Beispielbank',
  iban: 'DE89370400440532013000',
  bic: 'WELADED1ESN',
  accountHolder: 'Beispiel Betrieb GmbH',
  defaultPaymentDays: 14,
  defaultPaymentTerms: 'Zahlbar innerhalb von 14 Tagen.',
  defaultSkonto: '',
  invoiceFooterNotes: 'Vielen Dank für Ihren Auftrag.',
} as unknown as CompanyProfile;

const KAEUFER: CustomerBilling = {
  name: 'Beispiel Kundschaft GmbH',
  contactPerson: 'Beispiel Ansprechperson',
  street: 'Musterweg 1',
  zip: '12345',
  city: 'Beispielstadt',
  email: 'buchhaltung@kundschaft.invalid',
  phone: '0000 111111',
  countryCode: 'DE',
  vatId: 'DE987654321',
  buyerReference: 'TEST-REF-GLS01',
};

function zeile(): VorgangInvoiceLine {
  return {
    id: 'p1',
    description: 'Wartung',
    quantity: 2,
    unit: 'Stunden',
    unitPrice: 80,
    lineTotal: 160,
  } as VorgangInvoiceLine;
}

/** Freigegeben, Leistungszeitraum gültig und bestätigt — der zulässige Fall. */
function rechnung(o: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: 'inv-gls01-e',
    number: '2026-0071',
    type: 'rechnung',
    positions: [zeile()],
    subtotal: 160,
    taxStatus: 'standard_19',
    amount: 190.4,
    status: 'vorbereitet',
    date: '2026-09-24',
    createdAt: '2026-09-24T08:00:00.000Z',
    issueDate: '2026-09-24',
    servicePeriodFrom: '2026-09-22',
    servicePeriodTo: '2026-09-24',
    servicePeriodConfirmed: true,
    paymentDueDate: '2026-10-08',
    paymentTermsText: 'Zahlbar innerhalb von 14 Tagen.',
    skontoText: '',
    currencyCode: 'EUR',
    customerSnapshot: { ...KAEUFER },
    companySnapshot: { ...VERKAEUFER },
    legalNotices: [],
    previousAbschlagDeductions: [],
    ...o,
  } as unknown as VorgangInvoice;
}

/** Ein Altbeleg aus der Zeit vor der Bestätigung — der Wert fehlt ganz. */
function altbeleg(): VorgangInvoice {
  const alt = rechnung();
  delete alt.servicePeriodConfirmed;
  return alt;
}

function archivDokument(inv: VorgangInvoice): CompanyDocument {
  return {
    id: `doc-${inv.id}`,
    title: `${inv.number} – Rechnung`,
    kind: 'rechnung',
    // GO-LIVE-SECURITY-01 / ABSCHLUSS — wie ein echter erzeugter Rechnungsbeleg (invoiceArchiveService).
    category: 'ausgangsrechnung',
    classifiedKind: 'ausgangsrechnung',
    linkedInvoiceId: inv.id,
    createdAt: '2026-09-24T08:00:00.000Z',
    tags: [],
    status: 'abgelegt',
    area: 'finanzen',
  } as unknown as CompanyDocument;
}

const dateien = () => getDocumentFileRefStoreSnapshot();
const bindungen = () => getDocumentFileRepresentationBindingStoreSnapshot();

beforeEach(async () => {
  resetTestStores();
  await clearDocumentBlobStoreForTests();
  hydrateDocumentStore([archivDokument(rechnung())] as never);
  hydrateDocumentFileStore([], {});
  hydrateDocumentFileRepresentationBindingStore([]);
});

afterEach(() => {
  resetTestStores();
  (vi.restoreAllMocks(), alsInhaber());
});

describe('GLS01 XRechnung — dieselbe Regel wie PDF und Druck', () => {
  it('X1: ein unbestätigter Altbeleg bekommt keine XRechnung — und es entsteht keine Datei', async () => {
    const result = await ensureXRechnungArtifact(altbeleg());

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('service_period_unconfirmed');
    expect(dateien()).toHaveLength(0);
    expect(bindungen()).toHaveLength(0);
  });

  it('X2: auch ausdrücklich unbestätigt (false, wie nach der Rücknahme auf dem Mitgliedsgerät)', async () => {
    const result = await ensureXRechnungArtifact(rechnung({ servicePeriodConfirmed: false }));
    expect(result.ok).toBe(false);
    expect(dateien()).toHaveLength(0);
  });

  it.each([
    ['verdreht', { servicePeriodFrom: '2026-09-24', servicePeriodTo: '2026-09-22' }],
    ['ungültiges Datum', { servicePeriodFrom: '22.09.2026', servicePeriodTo: '2026-09-24' }],
    ['ohne Zeitraum, unbestätigt', { servicePeriodFrom: undefined, servicePeriodTo: undefined, servicePeriodConfirmed: false }],
    // Der PDF-Validator nimmt dann das Rechnungsdatum — und lässt durch. Dasselbe gilt hier.
    ['ohne Zeitraum, bestätigt', { servicePeriodFrom: undefined, servicePeriodTo: undefined }],
  ] as Array<[string, Partial<VorgangInvoice>]>)(
    'X3: %s — XRechnung entscheidet genau wie der PDF-Validator',
    async (fall, abweichung) => {
      const inv = rechnung(abweichung);
      const pdfSperrt = validateFinalizedInvoiceForPdf(inv).blockingErrors.some((error) =>
        ['service_period', 'service_period_order', 'service_period_unconfirmed'].includes(error.code),
      );
      // Damit der Vergleich nicht leer läuft: Nur der letzte Fall lässt das PDF durch.
      expect(pdfSperrt).toBe(fall !== 'ohne Zeitraum, bestätigt');

      const result = await ensureXRechnungArtifact(inv);
      if (pdfSperrt) {
        expect(result.ok).toBe(false);
        expect(result.ok ? null : result.reason).toBe('service_period_unconfirmed');
        expect(dateien()).toHaveLength(0);
      } else {
        // Die Regel sperrt nicht; was danach geschieht, entscheidet der übrige Bauweg.
        expect(result.ok ? 'ok' : result.reason).not.toBe('service_period_unconfirmed');
      }
    },
  );

  it('X4: eine bereits abgelegte XRechnung wird für eine jetzt unbestätigte Rechnung nicht ausgeliefert', async () => {
    const erst = await ensureXRechnungArtifact(rechnung());
    expect(erst.ok).toBe(true);
    expect(dateien()).toHaveLength(1);

    const danach = await ensureXRechnungArtifact(rechnung({ servicePeriodConfirmed: false }));
    expect(danach.ok).toBe(false);
    if (danach.ok) return;
    expect(danach.reason).toBe('service_period_unconfirmed');
    // Die abgelegte Datei bleibt unangetastet; sie wird nur nicht herausgegeben.
    expect(dateien()).toHaveLength(1);
    expect(bindungen()).toHaveLength(1);
  });

  it('X5: bestätigt bleibt alles wie bisher — erzeugen, dann dieselben Bytes wiederverwenden', async () => {
    const erst = await ensureXRechnungArtifact(rechnung());
    const zweit = await ensureXRechnungArtifact(rechnung());
    expect(erst.ok && zweit.ok).toBe(true);
    if (!erst.ok || !zweit.ok) return;
    expect(zweit.reused).toBe(true);
    expect(zweit.artifact.contentSha256).toBe(erst.artifact.contentSha256);
  });
});

describe('GLS01 ZUGFeRD — die Wiederverwendung umgeht die Regel nicht', () => {
  it('Z1: eine bereits abgelegte ZUGFeRD-Datei wird für eine jetzt unbestätigte Rechnung nicht ausgeliefert', async () => {
    const erst = await ensureZugferdArtifact(rechnung());
    expect(erst.ok).toBe(true);
    const vorher = dateien().length;

    const danach = await ensureZugferdArtifact(rechnung({ servicePeriodConfirmed: false }));
    expect(danach.ok).toBe(false);
    if (danach.ok) return;
    expect(danach.reason).toBe('service_period_unconfirmed');
    expect(dateien()).toHaveLength(vorher);
  });

  it('Z2: ein unbestätigter Altbeleg bekommt auch kein ZUGFeRD — mit klarem Grund', async () => {
    const result = await ensureZugferdArtifact(altbeleg());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('service_period_unconfirmed');
    expect(dateien()).toHaveLength(0);
  });
});
