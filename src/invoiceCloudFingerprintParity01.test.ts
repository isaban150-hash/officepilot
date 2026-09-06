/**
 * FIXED-AMOUNT-BILLING-INVARIANT-01F — Fingerprint-Parität des Cloud-Roundtrips.
 *
 * Realbefund: Nach einer erfolgreich finalisierten Abschlagsrechnung (2026-0006,
 * 30.000,00 EUR) scheiterte die naechste Finalisierung desselben Vorgangs schon
 * im Preflight mit `merge_conflict` / `id_content_conflict`. Der Konflikt
 * entsteht in `applyFinalizedInvoiceToVorgang`: gleiche `VorgangInvoice.id`,
 * abweichender `immutableInvoiceFingerprint`.
 *
 * `invoicePreparedFinalizeService` haelt selbst fest, dass die lokale Rechnung
 * „nie aus der **verlustbehafteten** Abbildung der Cloud-Antwort" entsteht.
 * Genau diese Asymmetrie wird hier gemessen — ausschliesslich mit produktiven
 * Funktionen, ohne eigene Serialisierung:
 *
 *   Kandidat → localInvoice → buildWorkspaceInvoiceFinalizePayload
 *            → mapCloudPayloadToVorgangInvoice → Fingerprint-Vergleich
 *
 * Reine Diagnose. Faellt der Test, ist die Ursache lokal reproduzierbar und das
 * abweichende Feld steht in der Meldung. Ist er gruen, liegt die Divergenz
 * serverseitig.
 *
 * Neutrale Beispieldaten, kein Kundenbezug.
 */
import { describe, expect, it } from 'vitest';

import { hydrateVorgangStore } from './services/vorgangService';
import { immutableInvoiceFingerprint } from './services/vorgangService';
import {
  buildAbschlagDraft,
  buildInvoiceFinalizationCandidate,
  setAbschlagDraftCalculationMode,
  updateInvoiceDraftFixedAmountNet,
  updateInvoiceDraftTaxStatus,
} from './services/invoiceService';
import {
  buildWorkspaceInvoiceFinalizePayload,
  mapCloudPayloadToVorgangInvoice,
} from './services/invoice/workspaceInvoiceCloudService';
import { createOrderPosition, createTestVorgang, testSetup } from './test/fixtures';
import type { VorgangInvoice } from './types/models';

const VORGANG_ID = 'v-test-1';

/** Der reale Kontrollfall: 34.624,00 EUR billable, davon 30.000,00 EUR pauschal. */
const ORDER_NET = 34624;
const ABSCHLAG_NET = 30000;

function seed(): void {
  hydrateVorgangStore([
    createTestVorgang({
      title: 'Logistikzentrum Avenwedde – Dachsanierung Halle 3',
      baustelle: 'Avenwedder Straße 210, 33335 Gütersloh',
      orderPositions: [
        createOrderPosition({
          id: 'op-test-1',
          description: 'Dachsanierung Halle 3',
          plannedQuantity: 1,
          unit: 'Pauschal',
          unitPrice: ORDER_NET,
          category: 'arbeit',
        }),
      ],
    }),
  ]);
}

/**
 * Die lokal gespeicherte Fassung nach erfolgreicher Finalisierung — exakt die
 * Struktur aus `invoicePreparedFinalizeService`: der vorbereitete Kandidat plus
 * ausschliesslich die erlaubten Serverfelder.
 */
function buildLocalFinalizedInvoice(): VorgangInvoice {
  seed();

  const base = buildAbschlagDraft(VORGANG_ID, testSetup);
  expect(base, 'Abschlagsentwurf konnte nicht gebaut werden').not.toBeNull();

  let draft = setAbschlagDraftCalculationMode(base!, 'fixed_amount', testSetup);
  draft = updateInvoiceDraftFixedAmountNet(draft, ABSCHLAG_NET);
  // §13b wie im Realfall: taxRate 0, netto == brutto.
  draft = updateInvoiceDraftTaxStatus(draft, 'reverse_charge_13b');
  draft = {
    ...draft,
    companySnapshot: {
      ...draft.companySnapshot,
      companyName: 'Muster Handwerk GmbH',
      street: 'Werkstraße 1',
      zip: '80331',
      city: 'München',
    },
  };

  const candidate = buildInvoiceFinalizationCandidate(
    VORGANG_ID,
    draft,
    testSetup,
    'inv-parity-1',
    { reverseCharge13bConfirmed: true },
  );
  expect(
    candidate.ok,
    `Kandidat konnte nicht gebaut werden: ${
      candidate.ok ? '' : (candidate.validation?.blockingErrors.map((e) => e.code).join(', ') ?? candidate.reason)
    }`,
  ).toBe(true);
  if (!candidate.ok) throw new Error('unreachable');

  return {
    ...candidate.invoice,
    id: 'inv-parity-1',
    number: '2026-0006',
    invoiceSequenceNumber: 6,
    status: 'vorbereitet',
    date: '2026-09-06',
    issueDate: '2026-09-06',
    paymentStatus: 'offen',
    payments: [],
  };
}

/** Beschreibt einen Wert samt Typ — `null`, `undefined` und `''` bleiben unterscheidbar. */
function describeValue(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (value === null) return 'null';
  if (Array.isArray(value)) return `Array(${value.length}) ${JSON.stringify(value)}`;
  return `${typeof value} ${JSON.stringify(value)}`;
}

/** Rekursiver Pfad-Diff über die geparsten Fingerprint-Objekte. */
function collectDifferences(local: unknown, mapped: unknown, path = ''): string[] {
  if (Object.is(local, mapped)) return [];

  const bothObjects =
    typeof local === 'object' &&
    typeof mapped === 'object' &&
    local !== null &&
    mapped !== null &&
    Array.isArray(local) === Array.isArray(mapped);

  if (bothObjects) {
    const keys = new Set([
      ...Object.keys(local as Record<string, unknown>),
      ...Object.keys(mapped as Record<string, unknown>),
    ]);
    return [...keys].flatMap((key) =>
      collectDifferences(
        (local as Record<string, unknown>)[key],
        (mapped as Record<string, unknown>)[key],
        path ? `${path}.${key}` : key,
      ),
    );
  }

  if (JSON.stringify(local) === JSON.stringify(mapped)) return [];

  return [
    `${path || '<root>'}\n    local:  ${describeValue(local)}\n    mapped: ${describeValue(mapped)}`,
  ];
}

describe('FIXED-AMOUNT-BILLING-INVARIANT-01F — Cloud-Roundtrip-Parität', () => {
  it('P1: der Fingerprint überlebt Payload-Builder und Cloud-Mapper unverändert', () => {
    const localInvoice = buildLocalFinalizedInvoice();

    const payload = buildWorkspaceInvoiceFinalizePayload(localInvoice);
    const cloudMappedInvoice = mapCloudPayloadToVorgangInvoice(payload);

    const localFingerprint = immutableInvoiceFingerprint(localInvoice, VORGANG_ID);
    const mappedFingerprint = immutableInvoiceFingerprint(cloudMappedInvoice, VORGANG_ID);

    const differences = collectDifferences(
      JSON.parse(localFingerprint),
      JSON.parse(mappedFingerprint),
    );

    expect(
      mappedFingerprint,
      differences.length > 0
        ? `Fingerprint-Divergenz im lokalen Roundtrip:\n  ${differences.join('\n  ')}\n`
        : 'Fingerprints unterscheiden sich, ohne dass ein Feld abweicht',
    ).toBe(localFingerprint);
  });

  /*
   * P2 trennt die beiden Stufen: Erzeugt bereits der Payload-Builder den
   * Verlust, oder erst der Mapper? Der Test ist bewusst tolerant gegenüber
   * Feldern, die der Fingerprint gar nicht liest.
   */
  it('P2: der Payload trägt jedes Feld, das der Fingerprint liest', () => {
    const localInvoice = buildLocalFinalizedInvoice();
    const payload = buildWorkspaceInvoiceFinalizePayload(localInvoice);

    const fingerprintFields = Object.keys(
      JSON.parse(immutableInvoiceFingerprint(localInvoice, VORGANG_ID)) as Record<string, unknown>,
    ).filter((key) => key !== 'vorgangId' && key !== 'positionCount');

    const missing = fingerprintFields.filter(
      (key) =>
        (localInvoice as unknown as Record<string, unknown>)[key] !== undefined &&
        payload[key] === undefined,
    );

    expect(missing, `Der Payload verliert Fingerprint-Felder: ${missing.join(', ')}`).toEqual([]);
  });
});
