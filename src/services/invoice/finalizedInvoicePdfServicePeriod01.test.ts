/**
 * FINALIZED-INVOICE-PDF-SERVICE-PERIOD-01B
 *
 * Die Bestätigung des Leistungszeitraums war bisher reine Entwurfssemantik.
 * Beim Finalisieren ging sie verloren, und der PDF-Pfad baute aus der
 * finalisierten Rechnung ein Pseudo-Draft ohne Bestätigung — jede freigegebene
 * Rechnung scheiterte danach an `service_period_unconfirmed`.
 *
 * Diese Suite hält den Zielvertrag fest: Die Bestätigung ist ein dauerhaftes
 * Approval-Faktum der finalisierten Rechnung, überlebt Cloud-Hin- und Rückweg,
 * und fehlt sie, bleibt der PDF-Pfad geschlossen. Ausschliesslich synthetische
 * Daten.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { VorgangInvoice } from '../../types/models';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import { createTestVorgang, testSetup } from '../../test/fixtures';
import { hydrateCompanyProfileStore } from '../companyProfileService';
import { hydrateDocumentStore } from '../documentService';
import {
  applyFinalizedInvoiceToVorgang,
  getVorgangById,
  hydrateVorgangStore,
} from '../vorgangService';
import {
  buildInvoiceContentFingerprintFromInvoice,
  buildInvoiceDraftForType,
  buildInvoiceFinalizationContentFingerprint,
  finalizeInvoiceDraft,
  setAbschlagDraftCalculationMode,
} from '../invoiceService';
import { validateFinalizedInvoiceForPdf } from '../invoiceValidationService';
import { generateApprovedInvoicePdf } from '../invoicePdfService';
import { validateWorkspaceInvoiceCloudPayload } from './workspaceInvoiceCloudPayloadValidator';
import {
  buildWorkspaceInvoiceFinalizePayload,
  mapCloudPayloadToVorgangInvoice,
} from './workspaceInvoiceCloudService';
import {
  PREPARED_FINALIZE_REQUEST_FORMAT_VERSION,
  PREPARED_FINALIZE_REQUEST_KIND,
  buildInvoicePayloadV1,
  validatePreparedWorkspaceInvoiceFinalizeRequest,
} from './workspaceInvoiceFinalizeRequestValidator';

const companySnapshot = {
  ...DEFAULT_COMPANY_PROFILE,
  companyName: 'Beispiel Betrieb GmbH',
  street: 'Werkstraße 2',
  zip: '54321',
  city: 'Beispielstadt',
  iban: 'DE00 0000 0000 0000 0000 00',
};

function seedWorld(): void {
  hydrateDocumentStore([]);
  hydrateCompanyProfileStore(companySnapshot);
  hydrateVorgangStore([createTestVorgang()]);
}

/** Ein freigabereifer Entwurf mit ausdrücklich bestätigtem Leistungszeitraum. */
function confirmedDraft(type: Parameters<typeof buildInvoiceDraftForType>[2] = 'rechnung') {
  const draft = buildInvoiceDraftForType('v-test-1', testSetup, type);
  if (!draft) throw new Error('draft_missing');
  draft.positions.forEach((position) => {
    position.quantity = 4;
  });
  draft.servicePeriodFrom = '2026-05-01';
  draft.servicePeriodTo = '2026-05-31';
  draft.servicePeriodConfirmed = true;
  return draft;
}

/**
 * Eine finalisierte Rechnung, wie sie ohne den Fix im Speicher steht:
 * Zeitraum vorhanden, Bestätigung nicht. Genau der Legacy-Fall.
 */
function legacyFinalizedInvoice(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: 'inv-sp-1',
    number: '2026-0042',
    type: 'rechnung',
    positions: [
      {
        id: 'line-1',
        orderPositionId: 'op-test-1',
        description: 'Beispielleistung',
        quantity: 8,
        unit: 'Stunden',
        unitPrice: 65,
        lineTotal: 520,
      },
    ],
    subtotal: 520,
    taxStatus: 'standard_19',
    amount: 618.8,
    status: 'vorbereitet',
    date: '2026-06-01',
    createdAt: '2026-06-01T10:00:00.000Z',
    issueDate: '2026-06-01',
    servicePeriodFrom: '2026-05-01',
    servicePeriodTo: '2026-05-31',
    paymentDueDate: '2026-06-15',
    paymentTermsText: 'Zahlbar in 14 Tagen',
    skontoText: '',
    customerSnapshot: {
      name: 'Beispiel Kundschaft GmbH',
      contactPerson: '',
      street: 'Musterweg 1',
      zip: '12345',
      city: 'Beispielstadt',
      email: '',
      phone: '',
    },
    companySnapshot,
    legalNotices: [],
    previousAbschlagDeductions: [],
    introText: 'Einleitung',
    closingText: 'Schluss',
    baustelle: 'Teststraße 1',
    vorgangTitle: 'Testvorgang',
    paymentStatus: 'offen',
    payments: [],
    ...overrides,
  };
}

function codes(invoice: VorgangInvoice): string[] {
  return validateFinalizedInvoiceForPdf(invoice).blockingErrors.map((e) => e.code);
}

describe('SP-PDF-01B — Finalisierung bewahrt die Bestätigung', () => {
  beforeEach(seedWorld);

  it('R1: ein bestätigter Entwurf schreibt servicePeriodConfirmed in die Rechnung', () => {
    const result = finalizeInvoiceDraft('v-test-1', confirmedDraft(), testSetup);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.invoice.servicePeriodConfirmed).toBe(true);
  });

  it('R4: die Bestätigung überlebt den Speicher und die Neuprojektion', () => {
    const result = finalizeInvoiceDraft('v-test-1', confirmedDraft(), testSetup);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const reloaded = getVorgangById('v-test-1')?.invoices.find((i) => i.id === result.invoice.id);
    expect(reloaded?.servicePeriodConfirmed).toBe(true);
    expect(codes(reloaded!)).not.toContain('service_period_unconfirmed');
  });

  it('R14: alle finalisierbaren Rechnungstypen tragen die Bestätigung', () => {
    for (const type of ['rechnung', 'abschlag', 'teilrechnung', 'schluss'] as const) {
      seedWorld();
      const draft = buildInvoiceDraftForType('v-test-1', testSetup, type);
      if (!draft) continue;
      draft.positions.forEach((p) => {
        p.quantity = 2;
      });
      draft.servicePeriodFrom = '2026-05-01';
      draft.servicePeriodTo = '2026-05-31';
      draft.servicePeriodConfirmed = true;

      const result = finalizeInvoiceDraft('v-test-1', draft, testSetup);
      expect(result.ok, `${type} finalisiert nicht`).toBe(true);
      if (!result.ok) continue;
      expect(result.invoice.servicePeriodConfirmed, `${type} verliert die Bestätigung`).toBe(true);
      expect(codes(result.invoice), `${type} blockiert im PDF-Gate`).not.toContain(
        'service_period_unconfirmed',
      );
    }
  });

  it('R14b: auch der pauschale Abschlag trägt die Bestätigung', () => {
    const base = buildInvoiceDraftForType('v-test-1', testSetup, 'abschlag');
    expect(base).not.toBeNull();
    const draft = setAbschlagDraftCalculationMode(base!, 'fixed_amount', testSetup);
    draft.fixedAmountNet = 500;
    draft.servicePeriodFrom = '2026-05-01';
    draft.servicePeriodTo = '2026-05-31';
    draft.servicePeriodConfirmed = true;

    const result = finalizeInvoiceDraft('v-test-1', draft, testSetup);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.invoice.servicePeriodConfirmed).toBe(true);
    expect(codes(result.invoice)).not.toContain('service_period_unconfirmed');
  });
});

describe('SP-PDF-01B — PDF-Revalidierung liest den gespeicherten Wert', () => {
  it('R2: eine bestätigte Rechnung passiert das Leistungszeitraum-Gate', () => {
    const invoice = legacyFinalizedInvoice({ servicePeriodConfirmed: true });
    expect(codes(invoice)).not.toContain('service_period_unconfirmed');
  });

  it('R3: eine bestätigte Rechnung erzeugt tatsächlich eine PDF', async () => {
    const invoice = legacyFinalizedInvoice({ servicePeriodConfirmed: true });
    const result = await generateApprovedInvoicePdf(invoice);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mimeType).toBe('application/pdf');
  });

  it('R5: eine historische Rechnung ohne Bestätigung bleibt blockiert', async () => {
    /*
     * Der Kern des Blocks: Zeitraum vorhanden, Bestätigung nicht — und es gibt
     * keinen persistierten Beweis, dass je jemand bestätigt hat. Fail-closed.
     */
    const invoice = legacyFinalizedInvoice();
    expect(invoice.servicePeriodConfirmed).toBeUndefined();
    expect(codes(invoice)).toContain('service_period_unconfirmed');

    const result = await generateApprovedInvoicePdf(invoice);
    expect(result.ok).toBe(false);
  });

  it('R15: ausdrückliches false bleibt ebenfalls blockierend', () => {
    const invoice = legacyFinalizedInvoice({ servicePeriodConfirmed: false });
    expect(codes(invoice)).toContain('service_period_unconfirmed');
  });
});

describe('SP-PDF-01B — Cloud-Payload und Validatoren', () => {
  it('R6: der Cloud-Payload-Validator akzeptiert die Bestätigung', () => {
    const payload = buildWorkspaceInvoiceFinalizePayload(
      legacyFinalizedInvoice({ servicePeriodConfirmed: true }),
    );
    expect(payload.servicePeriodConfirmed).toBe(true);
    expect(validateWorkspaceInvoiceCloudPayload(payload).ok).toBe(true);
  });

  it('R6b: false ist gültig, fehlend ist gültig, ein Nicht-Boolean nicht', () => {
    const base = buildWorkspaceInvoiceFinalizePayload(legacyFinalizedInvoice());
    expect(base.servicePeriodConfirmed).toBeUndefined();
    expect(validateWorkspaceInvoiceCloudPayload(base).ok).toBe(true);
    expect(
      validateWorkspaceInvoiceCloudPayload({ ...base, servicePeriodConfirmed: false }).ok,
    ).toBe(true);

    const wrong = validateWorkspaceInvoiceCloudPayload({
      ...base,
      servicePeriodConfirmed: 'ja',
    });
    expect(wrong.ok).toBe(false);
    if (wrong.ok) return;
    expect(wrong.detail).toBe('payload.servicePeriodConfirmed:not_boolean');
  });

  it('R7: der Prepared-Finalize-Request-Validator akzeptiert die Bestätigung', () => {
    const invoice = legacyFinalizedInvoice({ servicePeriodConfirmed: true });
    const request = {
      kind: PREPARED_FINALIZE_REQUEST_KIND,
      formatVersion: PREPARED_FINALIZE_REQUEST_FORMAT_VERSION,
      workspaceId: 'ws-1',
      vorgangId: 'v-test-1',
      clientInvoiceId: invoice.id,
      invoice,
      invoicePayload: buildInvoicePayloadV1(invoice),
      expectedResponseProjectionRawJson: '{}',
    };

    const result = validatePreparedWorkspaceInvoiceFinalizeRequest(request);
    expect(result.ok, result.ok ? '' : result.detail).toBe(true);
  });
});

describe('SP-PDF-01B — Cloud-Roundtrip', () => {
  it('R8: ein auf Gerät A bestätigtes true kommt auf Gerät B an', () => {
    const payload = buildWorkspaceInvoiceFinalizePayload(
      legacyFinalizedInvoice({ servicePeriodConfirmed: true }),
    );
    const validated = validateWorkspaceInvoiceCloudPayload(payload);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    const onDeviceB = mapCloudPayloadToVorgangInvoice(validated.payload);
    expect(onDeviceB.servicePeriodConfirmed).toBe(true);
    expect(codes(onDeviceB)).not.toContain('service_period_unconfirmed');
  });

  it('R9: ein alter Cloud-Datensatz ohne das Feld bleibt unbestätigt', () => {
    const payload = buildWorkspaceInvoiceFinalizePayload(legacyFinalizedInvoice());
    const validated = validateWorkspaceInvoiceCloudPayload(payload);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;

    const onDeviceB = mapCloudPayloadToVorgangInvoice(validated.payload);
    expect(onDeviceB.servicePeriodConfirmed).toBeUndefined();
    expect(codes(onDeviceB)).toContain('service_period_unconfirmed');
  });
});

describe('SP-PDF-01B — Merge ist monoton', () => {
  function merge(
    localConfirmed: boolean | undefined,
    cloudConfirmed: boolean | undefined,
  ): boolean | undefined {
    const local = legacyFinalizedInvoice({ servicePeriodConfirmed: localConfirmed });
    const cloud = legacyFinalizedInvoice({ servicePeriodConfirmed: cloudConfirmed });
    const vorgang = createTestVorgang({ invoices: [local] });
    const applied = applyFinalizedInvoiceToVorgang(vorgang, cloud);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return undefined;
    return applied.invoice.servicePeriodConfirmed;
  }

  it('R10: lokales true überlebt einen Legacy-Cloud-Datensatz ohne Feld', () => {
    expect(merge(true, undefined)).toBe(true);
  });

  it('R11: ein Cloud-true erreicht eine lokale Rechnung ohne Feld', () => {
    expect(merge(undefined, true)).toBe(true);
  });

  it('R10b/R10c: true bleibt true, undefined bleibt undefined', () => {
    expect(merge(true, true)).toBe(true);
    expect(merge(undefined, undefined)).toBeUndefined();
  });

  it('R10d: ein Cloud-false stuft ein lokales true nicht zurück', () => {
    expect(merge(true, false)).toBe(true);
  });
});

describe('SP-PDF-01B — Fingerprints bleiben unberührt', () => {
  beforeEach(seedWorld);

  it('R12: die Bestätigung verändert den Content-Fingerprint nicht', () => {
    const without = buildInvoiceContentFingerprintFromInvoice(legacyFinalizedInvoice());
    const with_ = buildInvoiceContentFingerprintFromInvoice(
      legacyFinalizedInvoice({ servicePeriodConfirmed: true }),
    );
    const false_ = buildInvoiceContentFingerprintFromInvoice(
      legacyFinalizedInvoice({ servicePeriodConfirmed: false }),
    );

    /*
     * Zwei Rechnungen, die sich nur darin unterscheiden, ob jemand bestätigt
     * hat, sind derselbe Beleg. Der Fingerprint beantwortet „ist das dieselbe
     * Rechnung?" — nicht „wie kam sie zustande?".
     */
    expect(with_).toBe(without);
    expect(false_).toBe(without);
  });

  it('R13: Prepared-Finalize erzeugt keinen fingerprint_mismatch', () => {
    const draft = confirmedDraft();
    const prepared = buildInvoiceFinalizationContentFingerprint(draft, testSetup);

    const result = finalizeInvoiceDraft('v-test-1', draft, testSetup);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(buildInvoiceContentFingerprintFromInvoice(result.invoice)).toBe(prepared);
  });
});
