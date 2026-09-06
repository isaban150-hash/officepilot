/**
 * FIXED-AMOUNT-BILLING-INVARIANT-01K — der Fingerprint darf nicht an der
 * Schluesselreihenfolge haengen.
 *
 * Realbefund: Nach einer erfolgreich finalisierten Abschlagsrechnung
 * (2026-0006) scheiterte jede weitere Finalisierung desselben Vorgangs mit
 * `merge_conflict` / `id_content_conflict` — gleiche `VorgangInvoice.id`,
 * unterschiedlicher `immutableInvoiceFingerprint`, aber **kein einziger
 * Feldunterschied** nach `JSON.parse`.
 *
 * Ursache: Der Fingerprint serialisiert `customerSnapshot` und
 * `companySnapshot` als vorhandene Objekte. Die Cloud-Fassung laeuft durch
 * eine PostgreSQL-`jsonb`-Spalte, und `jsonb` bewahrt die
 * Objektschluesselreihenfolge nicht (im Repository bereits dokumentiert in
 * `documentCloudPullOrchestrator.stableStringify`).
 *
 * Diese Datei sichert beide Haelften: Reihenfolge darf **nicht** zaehlen,
 * jeder echte Inhaltsunterschied **muss** weiterhin zaehlen.
 *
 * Neutrale Beispieldaten, kein Kundenbezug.
 */
import { describe, expect, it } from 'vitest';

import { immutableInvoiceFingerprint } from './services/vorgangService';
import type { CompanyProfile, CustomerBilling, VorgangInvoice } from './types/models';

const VORGANG_ID = 'v-fingerprint-1';

/** Test-only: baut jedes Objekt rekursiv mit umgekehrter Schlüsselreihenfolge neu. */
function withReversedKeyOrder<T>(value: T): T {
  if (Array.isArray(value)) {
    // Array-Reihenfolge bleibt strikt erhalten — nur die Keys darin drehen.
    return value.map((entry) => withReversedKeyOrder(entry)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const rebuilt: Record<string, unknown> = {};
    for (const key of Object.keys(source).reverse()) {
      rebuilt[key] = withReversedKeyOrder(source[key]);
    }
    return rebuilt as unknown as T;
  }
  return value;
}

function customer(overrides: Partial<CustomerBilling> = {}): CustomerBilling {
  return {
    name: 'Beispiel Projektbau GmbH',
    contactPerson: 'A. Beispiel',
    street: 'Beispielweg 2',
    zip: '20000',
    city: 'Beispielstadt',
    email: 'kontakt@beispiel.example',
    phone: '040 000000',
    ...overrides,
  };
}

function company(overrides: Partial<CompanyProfile> = {}): CompanyProfile {
  return {
    companyName: 'Muster Handwerk GmbH',
    legalForm: 'GmbH',
    street: 'Werkstraße 1',
    zip: '80331',
    city: 'München',
    country: 'Deutschland',
    contactPerson: 'B. Muster',
    phone: '089 111111',
    email: 'info@muster.example',
    website: '',
    taxNumber: '11/222/33333',
    vatId: 'DE000000000',
    bankName: 'Musterbank',
    iban: 'DE00000000000000000000',
    bic: 'MUSTERXXX',
    defaultPaymentDays: 14,
    ...overrides,
  } as CompanyProfile;
}

/** Eine realistische finalisierte Abschlagsrechnung mit Positionen. */
function invoice(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: 'inv-fingerprint-1',
    number: '2026-0006',
    invoiceSequenceNumber: 6,
    type: 'abschlag',
    abschlagNumber: 1,
    positions: [
      {
        id: 'line-1',
        orderPositionId: 'op-1',
        description: 'Dachbahn verlegen',
        quantity: 185,
        unit: 'm2',
        unitLabel: 'm²',
        unitPrice: 18.4,
        lineTotal: 3404,
      },
      {
        id: 'line-2',
        orderPositionId: 'op-2',
        description: 'Dämmung',
        quantity: 100,
        unit: 'm2',
        unitLabel: 'm²',
        unitPrice: 24.5,
        lineTotal: 2450,
      },
    ],
    subtotal: 5854,
    taxStatus: 'standard_19',
    amount: 6966.26,
    status: 'vorbereitet',
    date: '2026-09-06',
    issueDate: '2026-09-06',
    servicePeriodFrom: '2026-08-10',
    servicePeriodTo: '2026-08-21',
    paymentDueDate: '2026-09-20',
    paymentTermsText: 'Zahlbar innerhalb von 14 Tagen ohne Abzug.',
    skontoText: '',
    introText: '',
    closingText: '',
    baustelle: 'Avenwedder Straße 210',
    vorgangTitle: 'Logistikzentrum Avenwedde – Dachsanierung Halle 3',
    customerSnapshot: customer(),
    companySnapshot: company(),
    legalNotices: ['Hinweis A', 'Hinweis B'],
    previousAbschlagDeductions: [],
    createdAt: '2026-09-06T08:00:00.000Z',
    ...overrides,
  } as VorgangInvoice;
}

const fp = (value: VorgangInvoice): string => immutableInvoiceFingerprint(value, VORGANG_ID);

describe('FIXED-AMOUNT-BILLING-INVARIANT-01K — Schlüsselreihenfolge zählt nicht', () => {
  it('K1: customerSnapshot mit anderer Schlüsselreihenfolge ergibt denselben Fingerprint', () => {
    const a = invoice();
    const b = invoice({ customerSnapshot: withReversedKeyOrder(customer()) });

    expect(Object.keys(b.customerSnapshot!)).not.toEqual(Object.keys(a.customerSnapshot!));
    expect(fp(b), 'Die Schlüsselreihenfolge des Kundenblocks erzeugt einen Scheinkonflikt').toBe(
      fp(a),
    );
  });

  it('K2: companySnapshot mit anderer Schlüsselreihenfolge ergibt denselben Fingerprint', () => {
    const a = invoice();
    const b = invoice({ companySnapshot: withReversedKeyOrder(company()) });

    expect(Object.keys(b.companySnapshot!)).not.toEqual(Object.keys(a.companySnapshot!));
    expect(fp(b), 'Die Schlüsselreihenfolge des Firmenblocks erzeugt einen Scheinkonflikt').toBe(
      fp(a),
    );
  });

  it('K3: auch verschachtelte Objekte werden rekursiv kanonisiert', () => {
    const nested = { plz: '80331', ort: 'München', land: 'Deutschland' };
    const a = invoice({
      companySnapshot: company({ branding: nested } as unknown as Partial<CompanyProfile>),
    });
    const b = invoice({
      companySnapshot: withReversedKeyOrder(
        company({ branding: nested } as unknown as Partial<CompanyProfile>),
      ),
    });

    expect(fp(b), 'Ein verschachteltes Objekt blieb reihenfolgeabhängig').toBe(fp(a));
  });

  /*
   * K9 — der Realfall. Ein `jsonb`-Roundtrip sortiert **jedes** Objekt der
   * Struktur um, Werte und Array-Reihenfolge bleiben identisch.
   */
  it('K9: eine vollständig umsortierte Rechnung ergibt denselben Fingerprint', () => {
    const a = invoice();
    const b = withReversedKeyOrder(invoice());

    expect(JSON.parse(JSON.stringify(b))).toEqual(JSON.parse(JSON.stringify(a)));
    expect(fp(b), 'Der jsonb-Roundtrip erzeugt weiterhin einen Scheinkonflikt').toBe(fp(a));
  });
});

describe('FIXED-AMOUNT-BILLING-INVARIANT-01K — echte Unterschiede bleiben Konflikt', () => {
  it('K4: ein abweichender Betrag bleibt ein Konflikt', () => {
    expect(fp(invoice({ amount: 6966.25 }))).not.toBe(fp(invoice()));
    expect(fp(invoice({ subtotal: 5853 }))).not.toBe(fp(invoice()));
  });

  it('K5: ein anderer Kunde bleibt ein Konflikt', () => {
    expect(fp(invoice({ customerSnapshot: customer({ name: 'Andere GmbH' }) }))).not.toBe(
      fp(invoice()),
    );
    expect(fp(invoice({ customerSnapshot: customer({ zip: '20001' }) }))).not.toBe(fp(invoice()));
  });

  it('K6: eine abweichende Position bleibt ein Konflikt', () => {
    const withOtherPrice = invoice();
    withOtherPrice.positions[0] = { ...withOtherPrice.positions[0], unitPrice: 20.5 };
    expect(fp(withOtherPrice)).not.toBe(fp(invoice()));

    const withOtherQuantity = invoice();
    withOtherQuantity.positions[0] = { ...withOtherQuantity.positions[0], quantity: 186 };
    expect(fp(withOtherQuantity)).not.toBe(fp(invoice()));
  });

  it('K7: die Reihenfolge fachlich relevanter Arrays bleibt bedeutsam', () => {
    expect(
      fp(invoice({ legalNotices: ['Hinweis B', 'Hinweis A'] })),
      'legalNotices wurden umsortiert und damit gleichgemacht',
    ).not.toBe(fp(invoice()));

    const swapped = invoice();
    swapped.positions = [swapped.positions[1], swapped.positions[0]];
    expect(fp(swapped), 'Positionen wurden umsortiert und damit gleichgemacht').not.toBe(
      fp(invoice()),
    );
  });

  /*
   * K8 — `null` darf nicht zu „Feld fehlt" werden.
   *
   * Auf oberster Ebene normalisiert der Fingerprint viele Felder selbst mit
   * `?? null` bzw. `?? ''` und setzt beide Zustände dort **bewusst** gleich;
   * dagegen wird hier nicht getestet. Geprüft wird ein Feld **innerhalb** eines
   * Snapshots, dessen rohe Objektstruktur erhalten bleibt.
   */
  it('K8: null und ein fehlendes Feld bleiben innerhalb eines Snapshots unterscheidbar', () => {
    const withNull = invoice({
      customerSnapshot: { ...customer(), email: null } as unknown as CustomerBilling,
    });
    const withoutKey = invoice({
      customerSnapshot: (() => {
        const { email: _email, ...rest } = customer();
        return rest as CustomerBilling;
      })(),
    });

    expect(
      fp(withNull),
      'null wurde mit einem fehlenden Feld gleichgesetzt',
    ).not.toBe(fp(withoutKey));
  });
});
