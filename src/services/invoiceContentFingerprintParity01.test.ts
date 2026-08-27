/**
 * OFFICEPILOT-CONTENT-FINGERPRINT-PARITY-01C — dieselbe Rechnung, derselbe Abdruck.
 *
 * `expectedAmendmentSequence` ist ein Concurrency-Guard der Finalisierung, kein
 * Identitätsmerkmal der Rechnung. Der Server prüft ihn und entfernt ihn danach
 * ausdrücklich aus dem gespeicherten Payload. Eine aus der Cloud gezogene
 * Schlussrechnung trägt ihn deshalb nie — der Inhalts-Fingerabdruck rechnete
 * aber `?? 0` und wich damit von der lokalen Fassung mit echtem Wert ab.
 *
 * Folge: Intent-Auflösung, Duplikaterkennung und Resume hielten dieselbe
 * Rechnung für zwei verschiedene.
 *
 * Die Rückwärtskompatibilität entsteht **nicht** durch Nachbauen des alten
 * Werts — der ist aus der Cloud-Rechnung nicht rekonstruierbar. Sie entsteht
 * durch Normalisieren des bereits **persistierten** JSON-Textes, der seine
 * eigene Legacy-Quelle ist.
 *
 * Neutrale Beispieldaten.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildInvoiceContentFingerprintFromInvoice,
  buildInvoiceFinalizationContentFingerprint,
  matchesPersistedInvoiceContentFingerprint,
} from './invoiceService';
import { hydrateVorgangStore, immutableInvoiceFingerprint } from './vorgangService';
import { matchInvoiceFinalizeIntentForClear } from './invoice/invoiceCloudPullMergeService';
import {
  resetInvoiceFinalizeIntentsForTests,
  seedInvoiceFinalizeIntentForTests,
} from './invoice/invoiceFinalizeIntentService';
import { buildInvoicePayloadV1 } from './invoice/workspaceInvoiceFinalizeRequestValidator';
import { createOrderPosition, createTestVorgang, testSetup } from '../test/fixtures';
import { buildInvoiceDraftForType } from './invoiceService';
import type { InvoiceDocumentType, Vorgang, VorgangInvoice } from '../types/models';

const VORGANG_ID = 'v-fingerprint-parity';

function seedVorgang(): void {
  hydrateVorgangStore([
    {
      ...createTestVorgang({
        id: VORGANG_ID,
        title: 'Dachsanierung Beispielweg',
        status: 'beauftragt',
        customer: 'Beispiel Projektbau GmbH',
        orderPositions: [
          createOrderPosition({ id: 'op-1', unit: 'm²', plannedQuantity: 100, unitPrice: 100 }),
        ],
      }),
      invoices: [],
    } as Vorgang,
  ]);
}

function buildInvoice(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: 'inv-fingerprint-1',
    number: '2026-0099',
    invoiceSequenceNumber: 99,
    type: 'schluss',
    positions: [
      {
        id: 'line-1',
        orderPositionId: 'op-1',
        description: 'Dachsanierung',
        quantity: 100,
        unit: 'm²',
        unitPrice: 100,
        lineTotal: 10000,
      },
    ],
    subtotal: 10000,
    taxStatus: 'null_13b',
    amount: 10000,
    status: 'vorbereitet',
    date: '2026-08-27',
    createdAt: '2026-08-27T10:00:00.000Z',
    issueDate: '2026-08-27',
    servicePeriodFrom: '2026-08-01',
    servicePeriodTo: '2026-08-27',
    paymentDueDate: '2099-12-31',
    paymentTermsText: 'Zahlbar innerhalb 14 Tagen',
    skontoText: '',
    introText: 'Guten Tag,',
    closingText: 'Mit freundlichen Grüßen',
    baustelle: 'Beispielweg 1',
    vorgangTitle: 'Dachsanierung Beispielweg',
    customerSnapshot: {
      name: 'Beispiel Projektbau GmbH',
      contactPerson: '',
      street: 'Beispielstraße 2',
      zip: '20000',
      city: 'Beispielstadt',
      email: '',
      phone: '',
    },
    legalNotices: [],
    previousAbschlagDeductions: [],
    ...overrides,
  } as VorgangInvoice;
}

/**
 * Baut den Fingerabdruck in der **alten** Form nach — bitgenau so, wie der
 * frühere Erzeuger ihn geschrieben hat: derselbe Inhalt, plus der Schlüssel
 * `expectedAmendmentSequence` an seiner damaligen Stelle unmittelbar vor
 * `positions`.
 *
 * Das ist die einzige ehrliche Art, einen Altbestand im Test darzustellen —
 * der alte Erzeuger existiert nach dem Fix nicht mehr.
 */
function legacyFingerprint(current: string, amendment: unknown): string {
  const parsed = JSON.parse(current) as Record<string, unknown>;
  const rebuilt: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (key === 'positions') rebuilt.expectedAmendmentSequence = amendment;
    rebuilt[key] = value;
  }
  if (!('expectedAmendmentSequence' in rebuilt)) {
    rebuilt.expectedAmendmentSequence = amendment;
  }
  return JSON.stringify(rebuilt);
}

describe('OFFICEPILOT-CONTENT-FINGERPRINT-PARITY-01C', () => {
  /* ---------------------------------------------------------------------- */
  /* ROT 1 — Parität lokal vs. Cloud                                         */
  /* ---------------------------------------------------------------------- */

  it('ROT1/D: Schlussrechnung mit seq 3 und dieselbe Cloud-Rechnung ohne Feld sind identisch', () => {
    const local = buildInvoice({ expectedAmendmentSequence: 3 });
    // Aus der Cloud gezogen: der Guard wurde serverseitig nicht gespeichert.
    const fromCloud = buildInvoice({ expectedAmendmentSequence: undefined });

    expect(buildInvoiceContentFingerprintFromInvoice(local)).toBe(
      buildInvoiceContentFingerprintFromInvoice(fromCloud),
    );
  });

  it('C: dasselbe gilt für eine Schlussrechnung ohne Nachträge', () => {
    const local = buildInvoice({ expectedAmendmentSequence: 0 });
    const fromCloud = buildInvoice({ expectedAmendmentSequence: undefined });

    expect(buildInvoiceContentFingerprintFromInvoice(local)).toBe(
      buildInvoiceContentFingerprintFromInvoice(fromCloud),
    );
  });

  /* ---------------------------------------------------------------------- */
  /* ROT 2 — Legacy-Normalisierung                                           */
  /* ---------------------------------------------------------------------- */

  it('ROT2: ein alter persistierter Fingerprint mit seq 3 wird erkannt', () => {
    const current = buildInvoiceContentFingerprintFromInvoice(buildInvoice());
    const persisted = legacyFingerprint(current, 3);

    expect(persisted).not.toBe(current);
    expect(matchesPersistedInvoiceContentFingerprint(persisted, current)).toBe(true);
  });

  /* ---------------------------------------------------------------------- */
  /* Kanonische Form                                                         */
  /* ---------------------------------------------------------------------- */

  it('9: der neue Fingerprint nennt das Feld für keinen Rechnungstyp', () => {
    seedVorgang();
    for (const type of ['rechnung', 'abschlag', 'schluss'] as InvoiceDocumentType[]) {
      const draft = buildInvoiceDraftForType(VORGANG_ID, testSetup, type);
      expect(draft, type).not.toBeNull();
      const fromDraft = buildInvoiceFinalizationContentFingerprint(draft!, testSetup);
      expect(fromDraft, type).not.toContain('expectedAmendmentSequence');
    }

    for (const type of [
      'rechnung',
      'abschlag',
      'teilrechnung',
      'schluss',
    ] as InvoiceDocumentType[]) {
      const fingerprint = buildInvoiceContentFingerprintFromInvoice(
        buildInvoice({ type, ...(type === 'abschlag' ? { abschlagNumber: 1 } : {}) }),
      );
      expect(fingerprint, type).not.toContain('expectedAmendmentSequence');
    }
  });

  it('9b: beide Erzeuger bleiben strukturell formgleich', () => {
    seedVorgang();
    for (const type of ['rechnung', 'abschlag', 'schluss'] as InvoiceDocumentType[]) {
      const draft = buildInvoiceDraftForType(VORGANG_ID, testSetup, type)!;
      const fromDraft = JSON.parse(
        buildInvoiceFinalizationContentFingerprint(draft, testSetup),
      ) as Record<string, unknown>;
      const fromInvoice = JSON.parse(
        buildInvoiceContentFingerprintFromInvoice(buildInvoice({ type })),
      ) as Record<string, unknown>;

      // Gleiche Schlüssel, gleiche Reihenfolge — sonst wäre jeder Vergleich wertlos.
      expect(Object.keys(fromInvoice), type).toEqual(Object.keys(fromDraft));
    }
  });

  /* ---------------------------------------------------------------------- */
  /* 10 — gültige Legacy-Formen                                              */
  /* ---------------------------------------------------------------------- */

  it('10: jeder vom alten Erzeuger mögliche Fingerprint wird erkannt', () => {
    for (const [type, amendment] of [
      ['schluss', 0],
      ['schluss', 3],
      ['rechnung', null],
      ['abschlag', null],
      ['teilrechnung', null],
    ] as [InvoiceDocumentType, unknown][]) {
      const current = buildInvoiceContentFingerprintFromInvoice(buildInvoice({ type }));
      const persisted = legacyFingerprint(current, amendment);
      expect(
        matchesPersistedInvoiceContentFingerprint(persisted, current),
        `${type}/${JSON.stringify(amendment)}`,
      ).toBe(true);
    }
  });

  it('10b: der exakte neue Fingerprint stimmt mit sich selbst überein', () => {
    const current = buildInvoiceContentFingerprintFromInvoice(buildInvoice());
    expect(matchesPersistedInvoiceContentFingerprint(current, current)).toBe(true);
  });

  /* ---------------------------------------------------------------------- */
  /* 11 — fail closed                                                        */
  /* ---------------------------------------------------------------------- */

  it('11: unbrauchbare persistierte Werte werden abgewiesen', () => {
    const current = buildInvoiceContentFingerprintFromInvoice(buildInvoice());

    for (const persisted of [
      'kein json',
      '{',
      'null',
      '[]',
      '"text"',
      '5',
      'true',
    ]) {
      expect(
        matchesPersistedInvoiceContentFingerprint(persisted, current),
        persisted,
      ).toBe(false);
    }

    /*
     * Ein Objekt **ohne** den Legacy-Schlüssel darf nicht über den
     * Normalisierungspfad laufen — sonst würde jede reine Formatabweichung
     * toleriert. Ohne exakte Gleichheit gilt: false.
     */
    const parsed = JSON.parse(current) as Record<string, unknown>;
    const reordered = JSON.stringify({ positions: parsed.positions, ...parsed });
    expect(reordered).not.toBe(current);
    expect(matchesPersistedInvoiceContentFingerprint(reordered, current)).toBe(false);

    // Ein zusätzliches unbekanntes Feld bleibt nach dem Streichen übrig.
    const withExtra = legacyFingerprint(
      JSON.stringify({ ...parsed, unbekannt: 'x' }),
      0,
    );
    expect(matchesPersistedInvoiceContentFingerprint(withExtra, current)).toBe(false);
  });

  it('11b: ungültige Legacy-Werte werden abgewiesen', () => {
    const current = buildInvoiceContentFingerprintFromInvoice(buildInvoice());

    for (const amendment of ['3', true, {}, [], -1, 1.5, null]) {
      expect(
        matchesPersistedInvoiceContentFingerprint(legacyFingerprint(current, amendment), current),
        `schluss/${JSON.stringify(amendment)}`,
      ).toBe(false);
    }
  });

  it('11c: der Legacy-Wert muss zum Rechnungstyp passen', () => {
    for (const [type, amendment] of [
      ['rechnung', 0],
      ['abschlag', 3],
      ['teilrechnung', '3'],
      ['rechnung', 5],
    ] as [InvoiceDocumentType, unknown][]) {
      const current = buildInvoiceContentFingerprintFromInvoice(buildInvoice({ type }));
      expect(
        matchesPersistedInvoiceContentFingerprint(legacyFingerprint(current, amendment), current),
        `${type}/${JSON.stringify(amendment)}`,
      ).toBe(false);
    }

    // Ein unbekannter Rechnungstyp im Altbestand wird ebenfalls abgewiesen.
    const current = buildInvoiceContentFingerprintFromInvoice(buildInvoice());
    const foreignType = JSON.stringify({
      ...(JSON.parse(legacyFingerprint(current, 3)) as Record<string, unknown>),
      type: 'gutschrift',
    });
    expect(matchesPersistedInvoiceContentFingerprint(foreignType, current)).toBe(false);
  });

  /* ---------------------------------------------------------------------- */
  /* 12 — echte Inhaltsabweichungen                                          */
  /* ---------------------------------------------------------------------- */

  it('12: jede echte Inhaltsabweichung bleibt abgewiesen', () => {
    const base = buildInvoice();
    const current = buildInvoiceContentFingerprintFromInvoice(base);

    const variants: [string, VorgangInvoice][] = [
      ['Betrag', buildInvoice({ amount: 9999 })],
      ['Nettosumme', buildInvoice({ subtotal: 9999 })],
      [
        'Position',
        buildInvoice({
          positions: [
            {
              id: 'line-1',
              orderPositionId: 'op-1',
              description: 'Etwas anderes',
              quantity: 100,
              unit: 'm²',
              unitPrice: 100,
              lineTotal: 10000,
            },
          ],
        }),
      ],
      [
        'Kunde',
        buildInvoice({
          customerSnapshot: {
            name: 'Andere GmbH',
            contactPerson: '',
            street: 'Andere Straße 1',
            zip: '30000',
            city: 'Anderswo',
            email: '',
            phone: '',
          },
        }),
      ],
      ['issueDate', buildInvoice({ issueDate: '2026-09-01' })],
      ['servicePeriod', buildInvoice({ servicePeriodTo: '2026-09-30' })],
      ['Rechnungstyp', buildInvoice({ type: 'rechnung' })],
      ['taxStatus', buildInvoice({ taxStatus: 'standard_19' })],
      ['Textfeld', buildInvoice({ closingText: 'Anderer Schlusstext' })],
    ];

    for (const [label, variant] of variants) {
      const persisted = legacyFingerprint(
        buildInvoiceContentFingerprintFromInvoice(variant),
        variant.type === 'schluss' ? 3 : null,
      );
      expect(matchesPersistedInvoiceContentFingerprint(persisted, current), label).toBe(false);
    }
  });

  /* ---------------------------------------------------------------------- */
  /* 13 — produktives Verhalten                                              */
  /* ---------------------------------------------------------------------- */

  it('13: der Intent-Abgleich erkennt einen alten Intent mit seq 3 nach dem Pull', () => {
    resetInvoiceFinalizeIntentsForTests();
    seedVorgang();

    const cloudInvoice = buildInvoice({ expectedAmendmentSequence: undefined });
    const legacyIntentFingerprint = legacyFingerprint(
      buildInvoiceContentFingerprintFromInvoice(cloudInvoice),
      3,
    );

    seedInvoiceFinalizeIntentForTests({
      workspaceId: 'ws-parity-1',
      vorgangId: VORGANG_ID,
      clientInvoiceId: cloudInvoice.id,
      contentFingerprint: legacyIntentFingerprint,
      createdAt: '2026-08-27T09:00:00.000Z',
    });

    expect(
      matchInvoiceFinalizeIntentForClear({
        workspaceId: 'ws-parity-1',
        vorgangId: VORGANG_ID,
        invoice: cloudInvoice,
      }),
    ).toBe('matched');

    resetInvoiceFinalizeIntentsForTests();
  });

  it('13b: ein inhaltlich abweichender alter Intent bleibt ein Konflikt', () => {
    resetInvoiceFinalizeIntentsForTests();
    seedVorgang();

    const cloudInvoice = buildInvoice({ expectedAmendmentSequence: undefined });
    // Derselbe Beleg, aber ein anderer Betrag — das darf nie durchgehen.
    const foreign = legacyFingerprint(
      buildInvoiceContentFingerprintFromInvoice(buildInvoice({ amount: 9999 })),
      3,
    );

    seedInvoiceFinalizeIntentForTests({
      workspaceId: 'ws-parity-1',
      vorgangId: VORGANG_ID,
      clientInvoiceId: cloudInvoice.id,
      contentFingerprint: foreign,
      createdAt: '2026-08-27T09:00:00.000Z',
    });

    expect(
      matchInvoiceFinalizeIntentForClear({
        workspaceId: 'ws-parity-1',
        vorgangId: VORGANG_ID,
        invoice: cloudInvoice,
      }),
    ).toBe('fingerprint_conflict');

    resetInvoiceFinalizeIntentsForTests();
  });

  /* ---------------------------------------------------------------------- */
  /* 14/15 — Schutzmechanismen und Scope                                     */
  /* ---------------------------------------------------------------------- */

  it('14: immutableInvoiceFingerprint bleibt unverändert', () => {
    // Er kannte das Feld nie — und darf es weiterhin nicht kennen.
    for (const type of ['rechnung', 'abschlag', 'teilrechnung', 'schluss'] as InvoiceDocumentType[]) {
      const withValue = immutableInvoiceFingerprint(
        buildInvoice({ type, expectedAmendmentSequence: 3 }),
        VORGANG_ID,
      );
      const withoutValue = immutableInvoiceFingerprint(
        buildInvoice({ type, expectedAmendmentSequence: undefined }),
        VORGANG_ID,
      );
      expect(withValue, type).toBe(withoutValue);
      expect(withValue, type).not.toContain('expectedAmendmentSequence');
    }
  });

  it('14b: der Writer sendet den Guard weiterhin', () => {
    expect(buildInvoicePayloadV1({ type: 'schluss', expectedAmendmentSequence: 3 })
      ?.expectedAmendmentSequence).toBe(3);
    expect(buildInvoicePayloadV1({ type: 'schluss' })?.expectedAmendmentSequence).toBe(0);
  });

  it('14c: der SQL-Amendment-Guard und die Strip-Regel sind unverändert', () => {
    const sql = readFileSync(
      resolve(
        process.cwd(),
        'supabase/migrations/20250724150000_workspace_order_amendment_cloud_foundation.sql',
      ),
      'utf8',
    );
    expect(sql).toContain('select coalesce(max(a.sequence_no), 0)');
    expect(sql).toContain(
      'if v_current_amendment_sequence is distinct from v_expected_amendment_sequence then',
    );
    expect(sql).toContain("raise exception 'invoice_amendment_state_stale'");
    expect(sql).toContain("- 'expectedAmendmentSequence'");
    expect(sql).toContain("- 'expected_amendment_sequence'");
  });

  it('15: der Legacy-Orchestrator bleibt ohne produktiven Aufrufer', () => {
    /*
     * Die Entscheidung, `resolveInvoiceFinalizeIntent` nicht anzufassen, hängt
     * daran. Wird der Legacy-Pfad je verdrahtet, schlägt dieser Test an.
     */
    const read = (file: string) => readFileSync(resolve(process.cwd(), file), 'utf8');

    const orchestrator = read('src/services/invoice/invoiceCloudFinalizeOrchestrator.ts');
    expect(orchestrator).toContain('export async function finalizeInvoiceDraftWithCloud(');
    expect(orchestrator).toContain('resolveInvoiceFinalizeIntent');

    /*
     * Geprüft wird der **Aufruf**, nicht die Erwähnung: In
     * `invoicePreparedFinalizeService` steht der Name in einem Kommentar, der
     * genau festhält, dass der Legacy-Pfad unberührt bleibt.
     */
    for (const file of [
      'src/pages/RechnungPage.tsx',
      'src/services/invoice/invoiceFinalizationCoordinator.ts',
      'src/services/invoice/invoicePreparedFinalizeService.ts',
      'src/services/invoice/invoiceFinalizationPreflightService.ts',
    ]) {
      const source = read(file);
      expect(source, `${file}: Import`).not.toContain('invoiceCloudFinalizeOrchestrator');
      expect(source, `${file}: Aufruf`).not.toContain('finalizeInvoiceDraftWithCloud(');
      expect(source, `${file}: Intent`).not.toContain('resolveInvoiceFinalizeIntent');
    }
  });
});
