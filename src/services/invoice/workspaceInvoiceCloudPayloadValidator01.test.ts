/**
 * OFFICEPILOT-CROSS-PLATFORM-DRAFT-DURABILITY-01P4D2B4 — strenge Cloud-Payload-
 * Validierung. Ausschließlich synthetische, neutrale Daten.
 */
import { describe, expect, it } from 'vitest';
import { validateWorkspaceInvoiceCloudPayload } from './workspaceInvoiceCloudPayloadValidator';

function basePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'inv-cloud-p-1',
    number: '2026-0001',
    type: 'abschlag',
    abschlagNumber: 1,
    invoiceSequenceNumber: 1,
    status: 'vorbereitet',
    positions: [
      {
        id: 'line-1',
        orderPositionId: 'op-1',
        description: 'Beispielposition',
        quantity: 2,
        unit: 'Stück',
        unitLabel: 'Stück',
        unitPrice: 10,
        lineTotal: 20,
      },
    ],
    calculationMode: 'quantity_based',
    subtotal: 20,
    amount: 23.8,
    taxStatus: 'standard_19',
    date: '2026-08-21',
    createdAt: '2026-08-21T09:00:00.000Z',
    issueDate: '2026-08-21',
    paymentTermsText: '',
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
    companySnapshot: {
      companyName: 'Beispiel Betrieb GmbH',
      legalForm: 'GmbH',
      street: 'Werkstraße 2',
      zip: '54321',
      city: 'Betriebsstadt',
      country: 'Deutschland',
      contactPerson: '',
      phone: '',
      email: '',
      website: '',
      taxNumber: '',
      vatId: '',
      bankName: '',
      iban: '',
      bic: '',
      defaultPaymentDays: 14,
      defaultPaymentTerms: '',
      defaultSkonto: '',
      invoiceFooterNotes: '',
    },
    legalNotices: [],
    previousAbschlagDeductions: [],
    ...overrides,
  };
}

describe('01P4D2B4 — strenger Cloud-Payload-Validator', () => {
  it('P2: ein gültiger Payload wird unverändert angenommen', () => {
    const payload = basePayload();
    const result = validateWorkspaceInvoiceCloudPayload(payload);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (result.ok) expect(result.payload).toBe(payload);
  });

  it('P2: ungültige Pflichtfelder machen den gesamten Payload ungültig', () => {
    const cases: [string, Record<string, unknown>][] = [
      ['date als Zahl', { date: 5 }],
      ['date leer', { date: '' }],
      ['date fehlt', { date: undefined }],
      ['createdAt als Objekt', { createdAt: {} }],
      ['createdAt fehlt', { createdAt: undefined }],
      ['subtotal als Text', { subtotal: '81' }],
      ['subtotal fehlt', { subtotal: undefined }],
      ['amount NaN', { amount: Number.NaN }],
      ['amount Infinity', { amount: Number.POSITIVE_INFINITY }],
      ['taxStatus unbekannt', { taxStatus: 'beliebig' }],
      ['taxStatus fehlt', { taxStatus: undefined }],
      ['positions als Objekt', { positions: {} }],
      ['positions fehlen', { positions: undefined }],
      ['type unbekannt', { type: 'fantasie' }],
      ['status unbekannt', { status: 'bezahlt' }],
      ['calculationMode unbekannt', { calculationMode: 'anders' }],
      ['id leer', { id: '' }],
      ['number als Zahl', { number: 5 }],
    ];

    for (const [label, overrides] of cases) {
      const result = validateWorkspaceInvoiceCloudPayload(basePayload(overrides));
      expect(result.ok, label).toBe(false);
    }
  });

  it('P3: verschachtelte Verstöße machen den Payload ungültig', () => {
    const cases: [string, Record<string, unknown>][] = [
      [
        'Positionsbeschreibung als Zahl',
        { positions: [{ ...(basePayload().positions as never[])[0]!, description: 5 }] },
      ],
      [
        'Positionsmenge als Text',
        { positions: [{ ...(basePayload().positions as never[])[0]!, quantity: '2' }] },
      ],
      [
        'Position ohne id',
        { positions: [{ ...(basePayload().positions as never[])[0]!, id: undefined }] },
      ],
      [
        'unbekanntes Positionsfeld',
        { positions: [{ ...(basePayload().positions as never[])[0]!, extra: 1 }] },
      ],
      ['customerSnapshot als Feld', { customerSnapshot: [] }],
      [
        'customerSnapshot-Unterfeld als Zahl',
        { customerSnapshot: { ...(basePayload().customerSnapshot as object), name: 5 } },
      ],
      [
        'companySnapshot-Unterfeld als Objekt',
        { companySnapshot: { ...(basePayload().companySnapshot as object), iban: {} } },
      ],
      ['legalNotices teilweise ungültig', { legalNotices: ['a', 5] }],
      ['legalNotices kein Array', { legalNotices: 'a' }],
      ['previousAbschlagDeductions mit Zahl', { previousAbschlagDeductions: [5] }],
      [
        'Abzug mit falschem Feldtyp',
        {
          previousAbschlagDeductions: [
            {
              invoiceId: 'x',
              invoiceNumber: 'y',
              date: '2026-08-01',
              subtotal: '5',
              amount: 5,
            },
          ],
        },
      ],
      ['expectedAmendmentSequence als Text', { expectedAmendmentSequence: '0' }],
      ['expectedAmendmentSequence negativ', { expectedAmendmentSequence: -1 }],
      ['cancelledAt als Zahl', { cancelledAt: 5 }],
      ['cancelReason als Objekt', { cancelReason: {} }],
      ['sentVia unbekannt', { sentVia: 'fantasie' }],
      ['sentAt als Zahl', { sentAt: 5 }],
      ['unbekanntes Feld', { unbekannt: 'x' }],
    ];

    for (const [label, overrides] of cases) {
      const result = validateWorkspaceInvoiceCloudPayload(basePayload(overrides));
      expect(result.ok, label).toBe(false);
    }

    // Prototypenschlüssel auf jeder Ebene.
    const rootProto = JSON.parse(
      `{"__proto__":{"x":1},"id":"a"}`,
    ) as Record<string, unknown>;
    expect(
      validateWorkspaceInvoiceCloudPayload({ ...basePayload(), ...rootProto }).ok,
    ).toBe(false);
    const linePrototype = JSON.parse(
      `{"id":"line-1","orderPositionId":"op-1","description":"x","quantity":1,"unit":"Stück","unitPrice":1,"lineTotal":1,"constructor":"x"}`,
    );
    expect(
      validateWorkspaceInvoiceCloudPayload(basePayload({ positions: [linePrototype] })).ok,
    ).toBe(false);
  });

  it('P4: fehlende optionale Felder bleiben kompatibel', () => {
    // Ein schlanker Legacy-Payload ohne jedes optionale Feld.
    const legacy = {
      id: 'inv-legacy-1',
      number: '2026-0002',
      type: 'rechnung',
      status: 'vorbereitet',
      positions: [],
      subtotal: 0,
      amount: 0,
      taxStatus: 'standard_19',
      date: '2026-08-01',
      createdAt: '2026-08-01T09:00:00.000Z',
    };
    expect(validateWorkspaceInvoiceCloudPayload(legacy).ok, JSON.stringify(legacy)).toBe(true);

    // Gültige leere Strings und Nullwerte bleiben gültig.
    expect(
      validateWorkspaceInvoiceCloudPayload(
        basePayload({ skontoText: '', paymentTermsText: '', abschlagNumber: 0 }),
      ).ok,
    ).toBe(true);

    // null ist für diese Felder nicht vorgesehen.
    for (const field of ['skontoText', 'abschlagNumber', 'legalNotices']) {
      expect(
        validateWorkspaceInvoiceCloudPayload(basePayload({ [field]: null })).ok,
        field,
      ).toBe(false);
    }
  });

  it('P4: der Payload ist kein reines Objekt', () => {
    for (const invalid of [null, undefined, [], 'text', 5, true, new Date()]) {
      expect(
        validateWorkspaceInvoiceCloudPayload(invalid).ok,
        JSON.stringify(String(invalid)),
      ).toBe(false);
    }
  });

  it('P2: schluss akzeptiert expectedAmendmentSequence, verlangt es aber nicht', () => {
    const schluss = basePayload({
      type: 'schluss',
      abschlagNumber: undefined,
      calculationMode: undefined,
      expectedAmendmentSequence: 0,
    });
    expect(validateWorkspaceInvoiceCloudPayload(schluss).ok, JSON.stringify(schluss)).toBe(true);

    /*
     * READER-AMENDMENT-OPTIONAL-01 — vorher stand hier `.toBe(false)`.
     *
     * Der Guard wird von `normalize_workspace_invoice_payload_for_idempotency`
     * ausdrücklich aus dem gespeicherten Payload entfernt; eine
     * servergespeicherte Schlussrechnung trägt ihn nie. Als Pflicht gelesen
     * war jede Schlussrechnung originübergreifend unlesbar.
     */
    const missing = basePayload({
      type: 'schluss',
      abschlagNumber: undefined,
      calculationMode: undefined,
    });
    expect(validateWorkspaceInvoiceCloudPayload(missing).ok).toBe(true);

    // Vorhanden bleibt streng: eine echte Folge oder gar nichts.
    for (const invalid of [-1, 1.5, '0', null]) {
      const broken = basePayload({
        type: 'schluss',
        abschlagNumber: undefined,
        calculationMode: undefined,
        expectedAmendmentSequence: invalid,
      });
      const result = validateWorkspaceInvoiceCloudPayload(broken);
      expect(result.ok, JSON.stringify(invalid)).toBe(false);
      if (!result.ok) {
        expect(result.detail).toBe('payload.expectedAmendmentSequence:not_sequence');
      }
    }

    // Für andere Rechnungsarten ist das Feld nicht zulässig.
    expect(
      validateWorkspaceInvoiceCloudPayload(basePayload({ expectedAmendmentSequence: 0 })).ok,
    ).toBe(false);
  });
});

/**
 * OFFICEPILOT-CROSS-PLATFORM-DRAFT-DURABILITY-01P4E1B — keine Enum-Drift.
 *
 * Die Listen unten sind bewusst als Literale ausgeschrieben: sie sind der
 * Laufzeitbeweis, dass **jeder** heute gültige Wert der zentralen Unionen vom
 * Validator angenommen wird. Die Gegenrichtung — kein erfundener Wert, kein
 * Tippfehler in der Laufzeitmenge und kein künftig ergänzter Union-Wert, der
 * unbemerkt fehlt — wird typseitig durch die exhaustive `Record<Union, true>`
 * Bindung im Validator erzwungen und von `tsc --noEmit` geprüft.
 */
describe('01P4E1B — keine Enum-Drift zwischen Laufzeit und Modelltypen', () => {
  const acceptsField = (field: string, value: unknown, extra: Record<string, unknown> = {}) =>
    validateWorkspaceInvoiceCloudPayload(basePayload({ [field]: value, ...extra })).ok;

  it('R2a: jede Rechnungsart der Union wird angenommen, unbekannte nicht', () => {
    const types = ['rechnung', 'abschlag', 'teilrechnung', 'schluss', 'gutschrift', 'storno'];
    for (const type of types) {
      const extra =
        type === 'schluss'
          ? { expectedAmendmentSequence: 0, abschlagNumber: undefined, calculationMode: undefined }
          : {};
      expect(acceptsField('type', type, extra), `type:${type}`).toBe(true);
    }
    for (const unknownType of ['Rechnung', 'abschlaege', 'proforma', '']) {
      expect(acceptsField('type', unknownType), `type:${unknownType}`).toBe(false);
    }
  });

  it('R2b: jeder Rechnungsstatus der Union wird angenommen, unbekannte nicht', () => {
    for (const status of ['entwurf', 'vorbereitet', 'versendet']) {
      expect(acceptsField('status', status), `status:${status}`).toBe(true);
    }
    for (const unknownStatus of ['storniert', 'bezahlt', 'Entwurf', '']) {
      expect(acceptsField('status', unknownStatus), `status:${unknownStatus}`).toBe(false);
    }
  });

  it('R2c: jeder Steuerstatus der Union wird angenommen, unbekannte nicht', () => {
    const taxStatuses = [
      'standard_19',
      'standard_7',
      'kleinunternehmer_19',
      'reverse_charge_13b',
      'tax_free',
      'unclear',
    ];
    for (const taxStatus of taxStatuses) {
      expect(acceptsField('taxStatus', taxStatus), `taxStatus:${taxStatus}`).toBe(true);
    }
    for (const unknownTaxStatus of ['standard19', 'reverse_charge', 'STANDARD_19', '']) {
      expect(acceptsField('taxStatus', unknownTaxStatus), unknownTaxStatus).toBe(false);
    }
  });

  it('R2d: jeder Berechnungsmodus der Union wird angenommen, unbekannte nicht', () => {
    for (const mode of ['quantity_based', 'fixed_amount']) {
      expect(acceptsField('calculationMode', mode), `calculationMode:${mode}`).toBe(true);
    }
    for (const unknownMode of ['quantity', 'fixedAmount', '']) {
      expect(acceptsField('calculationMode', unknownMode), unknownMode).toBe(false);
    }
  });

  it('R2e: jeder Versandweg der Union wird angenommen, unbekannte nicht', () => {
    for (const sentVia of ['email', 'post', 'persoenlich', 'portal', 'sonstige']) {
      expect(acceptsField('sentVia', sentVia), `sentVia:${sentVia}`).toBe(true);
    }
    for (const unknownSentVia of ['fax', 'persönlich', 'E-Mail', '']) {
      expect(acceptsField('sentVia', unknownSentVia), unknownSentVia).toBe(false);
    }
  });

  it('R2f: jeder Zahlungsstatus der Union wird angenommen, unbekannte nicht', () => {
    for (const paymentStatus of ['offen', 'teilbezahlt', 'bezahlt', 'ueberfaellig', 'storniert']) {
      expect(acceptsField('paymentStatus', paymentStatus), paymentStatus).toBe(true);
    }
    for (const unknownPaymentStatus of ['überfällig', 'open', 'bezahlt_teilweise', '']) {
      expect(acceptsField('paymentStatus', unknownPaymentStatus), unknownPaymentStatus).toBe(false);
    }
  });

  it('R2g: leere Texte, Null-Beträge und fehlende optionale Felder bleiben unverändert gültig', () => {
    expect(
      validateWorkspaceInvoiceCloudPayload(
        basePayload({ paymentTermsText: '', skontoText: '', introText: '', closingText: '' }),
      ).ok,
    ).toBe(true);
    expect(validateWorkspaceInvoiceCloudPayload(basePayload({ subtotal: 0, amount: 0 })).ok).toBe(
      true,
    );
    expect(
      validateWorkspaceInvoiceCloudPayload(
        basePayload({ sentVia: undefined, paymentStatus: undefined, calculationMode: undefined }),
      ).ok,
    ).toBe(true);
  });
});
