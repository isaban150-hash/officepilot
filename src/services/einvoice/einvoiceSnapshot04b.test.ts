/**
 * E-RECHNUNG-04B — die Stammdaten der strukturierten Rechnung und ihr
 * Einfrieren im Beleg.
 *
 * Die eigentliche Frage dieses Blocks ist keine Formatfrage, sondern eine
 * Integritätsfrage: Eine E-Rechnung darf später nicht aus heutigen Stammdaten
 * und damaligen Beträgen zusammengesetzt werden. Geprüft wird deshalb vor
 * allem, was nach einer Stammdatenänderung **gleich bleibt**.
 *
 * Kein XML, keine Serialisierung, keine Codelisten — das kommt in 04C.
 * Neutrale Beispieldaten, kein Netzwerk.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildInvoiceDraftForType,
  buildInvoiceFinalizationCandidate,
  buildInvoiceFinalizationContentFingerprint,
  buildManualInvoiceDraft,
  buildManualInvoicePosition,
  updateDraftPositionQuantity,
  updateInvoiceDraftMetadata,
} from '../invoiceService';
import { billingFromCustomer, createCustomer, updateCustomer } from '../customerService';
import {
  getCompanyProfile,
  hydrateCompanyProfileStore,
  updateCompanyProfile,
} from '../companyProfileService';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import { hydrateVorgangStore, immutableInvoiceFingerprint } from '../vorgangService';
import { testSetup } from '../../test/fixtures';
import { resetTestStores } from '../../test/resetStores';
import {
  buildCustomerCloudPushPayload,
  parseCustomerCloudPayload,
} from '../customer/customerCloudService';
import {
  DEFAULT_COUNTRY_CODE,
  EINVOICE_STANDARDS,
  INVOICE_CURRENCY_CODE,
  normalizeCountryCode,
  resolveCountryCode,
} from './einvoiceStandards';
import type { Customer, InvoiceDraft, Vorgang } from '../../types/models';

const VID = 'v-04b';

function completeProfile(overrides: Record<string, unknown> = {}) {
  hydrateCompanyProfileStore({
    ...DEFAULT_COMPANY_PROFILE,
    companyName: 'Cirmak Haustechnik GmbH',
    street: 'Ruhrallee 5',
    zip: '45138',
    city: 'Essen',
    country: 'Deutschland',
    contactPerson: 'Herr Cirmak',
    phone: '0201 999999',
    email: 'buero@cirmak.de',
    taxNumber: '27/123/45678',
    vatId: 'DE111111111',
    iban: 'DE89370400440532013000',
    bic: 'WELADED1ESN',
    bankName: 'Sparkasse',
    ...overrides,
  } as never);
}

/** Der Kontrollkunde dieses Blocks — mit allen neuen Angaben. */
function testKunde(): Customer {
  const created = createCustomer(
    {
      name: 'AZ Testbau GmbH',
      contactPerson: 'Frau Meier',
      street: 'Industriestrasse 12',
      zip: '33602',
      city: 'Bielefeld',
      email: 'buero@az-testbau.invalid',
      phone: '0521 4711',
      countryCode: 'DE',
      vatId: 'DE-TEST-A',
      buyerReferenceDefault: 'TEST-BUYER-REF-A',
      leitwegId: 'TEST-LEITWEG-A',
    },
    { allowDuplicate: true },
  );
  if (!created.success) throw new Error('Kunde nicht angelegt: ' + created.errorKey);
  return created.customer;
}

function vorgangMit(customer: Customer): Vorgang {
  return {
    id: VID,
    title: '04B Datenprobe',
    customer: customer.name,
    baustelle: '',
    status: 'beauftragt',
    materialSource: 'betrieb',
    createdAt: '2026-09-20T08:00:00.000Z',
    orderNumber: 'AU-2026-0099',
    customerId: customer.id,
    customerBilling: billingFromCustomer(customer),
    orderPositions: [
      {
        id: 'op1',
        description: 'Wartung',
        plannedQuantity: 10,
        unit: 'Stunden',
        unitPrice: 80,
        billable: true,
      },
    ],
    documents: [],
    tasks: [],
    photos: [],
    invoices: [],
  } as unknown as Vorgang;
}

/**
 * Ein freigabefertiger Entwurf — nur so weit gefüllt, wie der Test es braucht:
 * bestätigter Leistungszeitraum und mindestens eine abgerechnete Menge.
 */
function freigabereif(draft: InvoiceDraft): InvoiceDraft {
  const mitZeitraum = updateInvoiceDraftMetadata(draft, {
    servicePeriodFrom: '2026-09-23',
    servicePeriodTo: '2026-09-23',
    servicePeriodConfirmed: true,
  });
  const erste = mitZeitraum.positions[0];
  if (erste) return updateDraftPositionQuantity(mitZeitraum, erste.id, 2);
  return {
    ...mitZeitraum,
    positions: [
      buildManualInvoicePosition({
        description: 'Wartung',
        quantity: 2,
        unit: 'Stunden',
        unitPrice: 80,
      }),
    ],
  };
}

beforeEach(() => {
  resetTestStores();
  completeProfile();
});

afterEach(() => {
  resetTestStores();
});

describe('A — die Projektfestlegungen stehen fest', () => {
  it('XRechnung 3.0 / 3.0.2 / Bundle 2026-08-31, ZUGFeRD 2.5.2 mit Factur-X 1.09.2', () => {
    expect(EINVOICE_STANDARDS.xrechnung.generation).toBe('3.0');
    expect(EINVOICE_STANDARDS.xrechnung.specification).toBe('3.0.2');
    expect(EINVOICE_STANDARDS.xrechnung.bundle).toBe('2026-08-31');
    expect(EINVOICE_STANDARDS.zugferd.version).toBe('2.5.2');
    expect(EINVOICE_STANDARDS.zugferd.facturX).toBe('1.09.2');
  });
});

describe('B — Ländercode', () => {
  it('T1: das Firmenprofil speichert den Ländercode', () => {
    const saved = updateCompanyProfile({ countryCode: 'DE' });
    expect(saved.success, JSON.stringify(saved)).toBe(true);
    expect(getCompanyProfile().countryCode).toBe('DE');
  });

  it('wird normalisiert, aber nie geraten', () => {
    expect(normalizeCountryCode('de')).toBe('DE');
    expect(normalizeCountryCode('Deutschland')).toBe('DE');
    expect(normalizeCountryCode('Österreich')).toBe('AT');
    expect(normalizeCountryCode('  ')).toBeUndefined();
    // Kein Rückfall auf Deutschland: ein geratener Code wäre schlimmer als keiner.
    expect(normalizeCountryCode('Absurdistan')).toBeUndefined();
    expect(DEFAULT_COUNTRY_CODE).toBe('DE');
  });

  it('der Freitext trägt den Code, wenn kein eigener gepflegt ist', () => {
    expect(resolveCountryCode({ country: 'Deutschland' })).toBe('DE');
    // Das ausdrückliche Feld gewinnt gegen den Freitext.
    expect(resolveCountryCode({ countryCode: 'AT', country: 'Deutschland' })).toBe('AT');
  });
});

describe('C — Kundenstamm', () => {
  it('T3/T4/T5/T6: die vier neuen Angaben werden gespeichert', () => {
    const kunde = testKunde();
    expect(kunde.countryCode).toBe('DE');
    expect(kunde.vatId).toBe('DE-TEST-A');
    expect(kunde.buyerReferenceDefault).toBe('TEST-BUYER-REF-A');
    expect(kunde.leitwegId).toBe('TEST-LEITWEG-A');
  });

  it('ein nicht gepflegtes Feld bleibt abwesend statt leer', () => {
    const created = createCustomer({ name: 'Schlichter Kunde' }, { allowDuplicate: true });
    if (!created.success) throw new Error(created.errorKey);
    expect('countryCode' in created.customer).toBe(false);
    expect('buyerReferenceDefault' in created.customer).toBe(false);
  });

  it('die Angaben überstehen den Cloud-Rundlauf', () => {
    const kunde = testKunde();
    const push = buildCustomerCloudPushPayload(kunde) as { payload: Record<string, unknown> };
    const zurueck = parseCustomerCloudPayload(push.payload);
    expect(zurueck?.countryCode).toBe('DE');
    expect(zurueck?.vatId).toBe('DE-TEST-A');
    expect(zurueck?.buyerReferenceDefault).toBe('TEST-BUYER-REF-A');
    expect(zurueck?.leitwegId).toBe('TEST-LEITWEG-A');
  });
});

describe('D — vom Kundenstamm in den Entwurf', () => {
  it('die Käuferreferenz wird aus dem Standard vorbelegt, nicht erfunden', () => {
    const kunde = testKunde();
    const billing = billingFromCustomer(kunde);
    expect(billing.buyerReference).toBe('TEST-BUYER-REF-A');
    expect(billing.countryCode).toBe('DE');
    expect(billing.vatId).toBe('DE-TEST-A');
    expect(billing.leitwegId).toBe('TEST-LEITWEG-A');
  });

  it('ohne Standard belegt die Leitweg-ID vor — der B2G-Fall', () => {
    const created = createCustomer(
      { name: 'Amt für Hochbau', leitwegId: 'L-991-XYZ' },
      { allowDuplicate: true },
    );
    if (!created.success) throw new Error(created.errorKey);
    expect(billingFromCustomer(created.customer).buyerReference).toBe('L-991-XYZ');
  });

  it('ohne beides bleibt die Käuferreferenz leer — kein Fantasiewert', () => {
    const created = createCustomer({ name: 'Privatkunde' }, { allowDuplicate: true });
    if (!created.success) throw new Error(created.errorKey);
    const billing = billingFromCustomer(created.customer);
    expect(billing.buyerReference).toBeUndefined();
    // Insbesondere nicht aus Kennung oder Name abgeleitet.
    expect(JSON.stringify(billing)).not.toContain(created.customer.id);
  });

  it('T7: die Auftragsrechnung übernimmt die Käuferdaten', () => {
    const kunde = testKunde();
    hydrateVorgangStore([vorgangMit(kunde)]);
    for (const type of ['rechnung', 'teilrechnung', 'abschlag', 'schluss'] as const) {
      const draft = buildInvoiceDraftForType(VID, testSetup, type);
      expect(draft, type).not.toBeNull();
      expect(draft!.customerBilling.countryCode, type).toBe('DE');
      expect(draft!.customerBilling.vatId, type).toBe('DE-TEST-A');
      expect(draft!.customerBilling.buyerReference, type).toBe('TEST-BUYER-REF-A');
      expect(draft!.customerBilling.leitwegId, type).toBe('TEST-LEITWEG-A');
      expect(draft!.currencyCode, type).toBe(INVOICE_CURRENCY_CODE);
    }
  });

  it('T8: die manuelle Rechnung ohne Auftrag ebenso', () => {
    const kunde = testKunde();
    const draft = buildManualInvoiceDraft(
      { billing: billingFromCustomer(kunde), customerId: kunde.id },
      testSetup,
    );
    expect(draft.vorgangId).toBeNull();
    expect(draft.customerBilling.countryCode).toBe('DE');
    expect(draft.customerBilling.buyerReference).toBe('TEST-BUYER-REF-A');
    expect(draft.currencyCode).toBe(INVOICE_CURRENCY_CODE);
  });

  it('T9: die Käuferreferenz ist im Entwurf überschreibbar', () => {
    const kunde = testKunde();
    const draft = buildManualInvoiceDraft(
      { billing: billingFromCustomer(kunde), customerId: kunde.id },
      testSetup,
    );
    const geaendert = updateInvoiceDraftMetadata(draft, {
      customerBilling: { buyerReference: 'Projekt-2026-99' },
    });
    expect(geaendert.customerBilling.buyerReference).toBe('Projekt-2026-99');
    // Der Stammsatz bleibt unberührt.
    expect(kunde.buyerReferenceDefault).toBe('TEST-BUYER-REF-A');
    // Und alles andere am Empfänger bleibt stehen.
    expect(geaendert.customerBilling.vatId).toBe('DE-TEST-A');
    expect(geaendert.customerBilling.name).toBe('AZ Testbau GmbH');
  });
});

describe('E — der freigegebene Beleg friert ein', () => {
  function finalisiere(draft: InvoiceDraft) {
    const candidate = buildInvoiceFinalizationCandidate(
      draft.vorgangId,
      freigabereif(draft),
      testSetup,
      'inv-04b-1',
    );
    if (!candidate.ok) throw new Error('Kandidat abgelehnt: ' + JSON.stringify(candidate));
    return candidate.invoice;
  }

  it('T2/T10/T11/T12/T13: Währung, Käuferdaten und Verkäuferdaten stehen im Beleg', () => {
    const kunde = testKunde();
    hydrateVorgangStore([vorgangMit(kunde)]);
    const invoice = finalisiere(buildInvoiceDraftForType(VID, testSetup, 'rechnung')!);

    expect(invoice.currencyCode, 'T2 Währung').toBe('EUR');
    expect(invoice.customerSnapshot?.buyerReference, 'T10').toBe('TEST-BUYER-REF-A');
    expect(invoice.customerSnapshot?.vatId, 'T11').toBe('DE-TEST-A');
    expect(invoice.customerSnapshot?.countryCode, 'T12').toBe('DE');
    expect(invoice.customerSnapshot?.leitwegId).toBe('TEST-LEITWEG-A');
    expect(invoice.companySnapshot?.vatId, 'T13').toBe('DE111111111');
    expect(invoice.companySnapshot?.iban, 'T13').toBe('DE89370400440532013000');
  });

  it('T14/T15: eine spätere Stammdatenänderung erreicht den Beleg nicht', () => {
    const kunde = testKunde();
    hydrateVorgangStore([vorgangMit(kunde)]);
    const alt = finalisiere(buildInvoiceDraftForType(VID, testSetup, 'rechnung')!);

    const geaendert = updateCustomer(kunde.id, {
      vatId: 'DE-TEST-B',
      buyerReferenceDefault: 'TEST-BUYER-REF-B',
      leitwegId: 'TEST-LEITWEG-B',
    });
    expect(geaendert.success, JSON.stringify(geaendert)).toBe(true);

    // T14 — der bereits freigegebene Beleg trägt weiterhin die A-Werte.
    expect(alt.customerSnapshot?.vatId).toBe('DE-TEST-A');
    expect(alt.customerSnapshot?.buyerReference).toBe('TEST-BUYER-REF-A');
    expect(alt.customerSnapshot?.leitwegId).toBe('TEST-LEITWEG-A');

    // T15 — ein neuer Entwurf übernimmt die B-Werte.
    hydrateVorgangStore([vorgangMit(geaendert.success ? geaendert.customer : kunde)]);
    const neu = buildInvoiceDraftForType(VID, testSetup, 'rechnung')!;
    expect(neu.customerBilling.vatId).toBe('DE-TEST-B');
    expect(neu.customerBilling.buyerReference).toBe('TEST-BUYER-REF-B');
  });

  it('T16: eine spätere Firmenprofiländerung erreicht den Beleg nicht', () => {
    const kunde = testKunde();
    hydrateVorgangStore([vorgangMit(kunde)]);
    const alt = finalisiere(buildInvoiceDraftForType(VID, testSetup, 'rechnung')!);

    const saved = updateCompanyProfile({
      vatId: 'DE999999999',
      countryCode: 'AT',
      iban: 'DE00000000000000000000',
    });
    expect(saved.success, JSON.stringify(saved)).toBe(true);

    expect(alt.companySnapshot?.vatId).toBe('DE111111111');
    expect(alt.companySnapshot?.iban).toBe('DE89370400440532013000');
    expect(alt.currencyCode).toBe('EUR');
  });
});

describe('F — Altbestand und normale Rechnungen', () => {
  it('T17: ein Beleg ohne die neuen Felder bleibt lesbar und wird nicht angereichert', () => {
    const kunde = testKunde();
    hydrateVorgangStore([vorgangMit(kunde)]);
    const draft = buildInvoiceDraftForType(VID, testSetup, 'rechnung')!;

    // Ein Entwurf, wie ihn ein Client von vor 04B hinterlassen hätte.
    const alt: InvoiceDraft = {
      ...freigabereif(draft),
      currencyCode: undefined,
      customerBilling: {
        name: kunde.name,
        contactPerson: kunde.contactPerson,
        street: kunde.street,
        zip: kunde.zip,
        city: kunde.city,
        email: kunde.email,
        phone: kunde.phone,
      },
    };
    const candidate = buildInvoiceFinalizationCandidate(VID, alt, testSetup, 'inv-04b-legacy');
    expect(candidate.ok, JSON.stringify(candidate)).toBe(true);
    if (!candidate.ok) return;

    // Nichts wurde aus dem heutigen Kundenstamm nachgeschoben.
    expect(candidate.invoice.customerSnapshot?.vatId).toBeUndefined();
    expect(candidate.invoice.customerSnapshot?.countryCode).toBeUndefined();
    expect(candidate.invoice.customerSnapshot?.buyerReference).toBeUndefined();
    expect(candidate.invoice.customerSnapshot?.name).toBe(kunde.name);
  });

  it('T18/T19: ohne Käuferreferenz und ohne Leitweg-ID bleibt die Rechnung freigebbar', () => {
    const created = createCustomer(
      { name: 'Privatkunde', street: 'Weg 1', zip: '33602', city: 'Bielefeld' },
      { allowDuplicate: true },
    );
    if (!created.success) throw new Error(created.errorKey);
    const draft = buildManualInvoiceDraft(
      { billing: billingFromCustomer(created.customer), customerId: created.customer.id },
      testSetup,
    );
    expect(draft.customerBilling.buyerReference).toBeUndefined();
    expect(draft.customerBilling.leitwegId).toBeUndefined();

    const candidate = buildInvoiceFinalizationCandidate(
      null,
      freigabereif(draft),
      testSetup,
      'inv-04b-privat',
    );
    expect(candidate.ok, JSON.stringify(candidate)).toBe(true);
  });
});

describe('G — Fingerprint', () => {
  it('T20: eine geänderte Käuferreferenz ist ein anderer Beleg', () => {
    const kunde = testKunde();
    hydrateVorgangStore([vorgangMit(kunde)]);
    const draft = freigabereif(buildInvoiceDraftForType(VID, testSetup, 'rechnung')!);

    const a = buildInvoiceFinalizationContentFingerprint(draft, testSetup);
    const b = buildInvoiceFinalizationContentFingerprint(
      updateInvoiceDraftMetadata(draft, { customerBilling: { buyerReference: 'ANDERS' } }),
      testSetup,
    );
    expect(b).not.toBe(a);

    // Dasselbe gilt für die übrigen eingefrorenen Angaben.
    for (const feld of ['countryCode', 'vatId', 'leitwegId'] as const) {
      const geaendert = buildInvoiceFinalizationContentFingerprint(
        updateInvoiceDraftMetadata(draft, { customerBilling: { [feld]: 'XX' } }),
        testSetup,
      );
      expect(geaendert, feld).not.toBe(a);
    }
  });

  it('die Währung zählt zum unveränderlichen Abdruck des fertigen Belegs', () => {
    const kunde = testKunde();
    hydrateVorgangStore([vorgangMit(kunde)]);
    const candidate = buildInvoiceFinalizationCandidate(
      VID,
      freigabereif(buildInvoiceDraftForType(VID, testSetup, 'rechnung')!),
      testSetup,
      'inv-04b-fp',
    );
    if (!candidate.ok) throw new Error(JSON.stringify(candidate));
    const invoice = candidate.invoice;

    const mit = immutableInvoiceFingerprint(invoice, VID);
    const ohne = immutableInvoiceFingerprint({ ...invoice, currencyCode: undefined }, VID);
    expect(ohne).not.toBe(mit);
    /*
     * Der Schlüssel steht auch ohne Wert da. Liesse man ihn entfallen, ergäbe
     * derselbe Altbeleg je nach Herkunft verschiedene Abdrücke — und das fiele
     * nicht als roter Test auf, sondern beim Nutzer als Merge-Konflikt.
     */
    expect(ohne).toContain('"currencyCode":null');
    // Ein Altbeleg bleibt sich selbst gleich, egal wie oft gerechnet wird.
    expect(immutableInvoiceFingerprint({ ...invoice, currencyCode: undefined }, VID)).toBe(ohne);
  });

  it('die Währung steht bewusst nicht im Inhalts-Abdruck der Finalisierung', () => {
    const kunde = testKunde();
    hydrateVorgangStore([vorgangMit(kunde)]);
    const draft = freigabereif(buildInvoiceDraftForType(VID, testSetup, 'rechnung')!);
    /*
     * Sie kann sich nicht ändern, trüge zur Drift-Erkennung also nichts bei —
     * und ein vor 04B angelegter Intent trägt seinen Abdruck ohne diesen
     * Schlüssel. Stünde sie darin, passte er nie wieder.
     */
    expect(
      buildInvoiceFinalizationContentFingerprint({ ...draft, currencyCode: undefined }, testSetup),
    ).toBe(buildInvoiceFinalizationContentFingerprint(draft, testSetup));
  });
});
