/**
 * SHARED-PRESENTATION-CONTEXT-01B — Vertragstests der Präsentations-Foundation.
 *
 * Geprüft wird vor allem, was der Builder **nicht** tut: nichts auflösen,
 * nichts erfinden, nichts mutieren, nichts einfrieren aufweichen.
 *
 * Neutrale Beispieldaten.
 */
import { describe, expect, it } from 'vitest';
import type { CompanyProfile, CustomerBilling } from '../../types/models';
import { SHARED_PRESENTATION_CONTEXT_VERSION } from '../../types/presentation';
import {
  buildDraftSharedPresentationContext,
  buildFinalSharedPresentationContext,
} from './sharedPresentationContextService';

function companyProfile(overrides: Partial<CompanyProfile> = {}): CompanyProfile {
  return {
    companyName: 'Beispiel Haustechnik GmbH',
    legalForm: 'GmbH',
    logoDataUrl: 'data:image/png;base64,AAAA',
    street: 'Werkstraße 3',
    zip: '30000',
    city: 'Beispielstadt',
    country: 'Deutschland',
    contactPerson: 'A. Beispiel',
    phone: '0500 111222',
    email: 'buero@beispiel-haustechnik.example',
    website: 'www.beispiel-haustechnik.example',
    taxNumber: '00/000/00000',
    vatId: 'DE000000000',
    bankName: 'Beispielbank',
    iban: 'DE00 0000 0000 0000 0000 00',
    bic: 'BEISPXXX',
    defaultPaymentDays: 14,
    defaultPaymentTerms: 'Zahlbar innerhalb von 14 Tagen.',
    defaultSkonto: '',
    managingDirector: 'A. Beispiel',
    invoiceFooterNotes: 'Beispielhinweis',
    ...overrides,
  };
}

function customerBilling(overrides: Partial<CustomerBilling> = {}): CustomerBilling {
  return {
    name: 'Beispiel Industriebau GmbH',
    contactPerson: 'B. Muster',
    street: 'Beispielstraße 5',
    zip: '20000',
    city: 'Musterstadt',
    email: 'kontakt@industriebau.example',
    phone: '0400 333444',
    ...overrides,
  };
}

const DOCUMENT = { type: 'invoice', locale: 'de-DE' };

describe('SHARED-PRESENTATION-CONTEXT-01B', () => {
  it('1 — der Firmen-Snapshot wird zum Absender', () => {
    const context = buildDraftSharedPresentationContext({
      companySnapshot: companyProfile(),
      customerBilling: customerBilling(),
      document: DOCUMENT,
    });

    expect(context.issuer).toEqual({
      name: 'Beispiel Haustechnik GmbH',
      legalForm: 'GmbH',
      street: 'Werkstraße 3',
      zip: '30000',
      city: 'Beispielstadt',
      country: 'Deutschland',
      contactPerson: 'A. Beispiel',
      phone: '0500 111222',
      email: 'buero@beispiel-haustechnik.example',
      website: 'www.beispiel-haustechnik.example',
      taxNumber: '00/000/00000',
      vatId: 'DE000000000',
      bankName: 'Beispielbank',
      iban: 'DE00 0000 0000 0000 0000 00',
      bic: 'BEISPXXX',
      managingDirector: 'A. Beispiel',
    });
    expect(context.version).toBe(SHARED_PRESENTATION_CONTEXT_VERSION);
  });

  it('2 — der Kunden-Snapshot wird zum Empfänger', () => {
    const context = buildDraftSharedPresentationContext({
      companySnapshot: companyProfile(),
      customerBilling: customerBilling(),
      document: DOCUMENT,
    });

    expect(context.recipient).toEqual({
      name: 'Beispiel Industriebau GmbH',
      contactPerson: 'B. Muster',
      street: 'Beispielstraße 5',
      zip: '20000',
      city: 'Musterstadt',
      email: 'kontakt@industriebau.example',
      phone: '0400 333444',
    });
  });

  it('3 — die customerId reist nur als Referenz mit und wird nicht aufgelöst', () => {
    /*
     * Der Beweis, dass nicht nachgeschlagen wird: Die Kennung verweist auf
     * einen Kunden, den es nirgends gibt, und die dargestellten Werte bleiben
     * exakt die übergebenen. Ein Lookup müsste hier scheitern oder etwas
     * anderes liefern.
     */
    const context = buildDraftSharedPresentationContext({
      companySnapshot: companyProfile(),
      customerBilling: customerBilling({ name: 'Im Entwurf festgehalten' }),
      recipientCustomerId: 'cust-existiert-nicht',
      document: DOCUMENT,
    });

    expect(context.recipientCustomerId).toBe('cust-existiert-nicht');
    expect(context.recipient.name).toBe('Im Entwurf festgehalten');
  });

  it('4 — der Entwurf zeigt genau den übergebenen Snapshot', () => {
    const context = buildDraftSharedPresentationContext({
      companySnapshot: companyProfile({ street: 'Alte Werkstraße 1' }),
      customerBilling: customerBilling({ street: 'Alte Anschrift 1' }),
      recipientCustomerId: 'cust-1',
      document: DOCUMENT,
    });

    expect(context.issuer.street).toBe('Alte Werkstraße 1');
    expect(context.recipient.street).toBe('Alte Anschrift 1');
  });

  it('5 — spätere Änderung am Kunden-Eingabeobjekt lässt den Context unberührt', () => {
    const billing = customerBilling();
    const context = buildDraftSharedPresentationContext({
      companySnapshot: companyProfile(),
      customerBilling: billing,
      document: DOCUMENT,
    });

    billing.name = 'Nachträglich geändert';
    billing.street = 'Neue Straße 9';

    expect(context.recipient.name).toBe('Beispiel Industriebau GmbH');
    expect(context.recipient.street).toBe('Beispielstraße 5');
  });

  it('6 — spätere Änderung am Firmen-Eingabeobjekt lässt den Context unberührt', () => {
    const profile = companyProfile();
    const context = buildDraftSharedPresentationContext({
      companySnapshot: profile,
      customerBilling: customerBilling(),
      document: DOCUMENT,
    });

    profile.companyName = 'Umfirmiert GmbH';
    profile.iban = 'DE99 9999 9999 9999 9999 99';

    expect(context.issuer.name).toBe('Beispiel Haustechnik GmbH');
    expect(context.issuer.iban).toBe('DE00 0000 0000 0000 0000 00');
  });

  it('7/8 — die Eingabeobjekte werden nicht verändert', () => {
    const profile = companyProfile();
    const billing = customerBilling();
    const profileBefore = JSON.stringify(profile);
    const billingBefore = JSON.stringify(billing);

    buildDraftSharedPresentationContext({
      companySnapshot: profile,
      customerBilling: billing,
      document: DOCUMENT,
    });
    buildFinalSharedPresentationContext({
      companySnapshot: profile,
      customerSnapshot: billing,
      document: DOCUMENT,
    });

    expect(JSON.stringify(profile)).toBe(profileBefore);
    expect(JSON.stringify(billing)).toBe(billingBefore);
  });

  it('9/10 — finalisiert werden ausschliesslich die eingefrorenen Snapshots gezeigt', () => {
    const context = buildFinalSharedPresentationContext({
      companySnapshot: companyProfile({ street: 'Damalige Werkstraße 1', city: 'Damalsstadt' }),
      customerSnapshot: customerBilling({ street: 'Damalige Anschrift 2', city: 'Altstadt' }),
      recipientCustomerId: 'cust-1',
      document: DOCUMENT,
    });

    expect(context.mode).toBe('final');
    expect({ street: context.issuer.street, city: context.issuer.city }).toEqual({
      street: 'Damalige Werkstraße 1',
      city: 'Damalsstadt',
    });
    expect({ street: context.recipient.street, city: context.recipient.city }).toEqual({
      street: 'Damalige Anschrift 2',
      city: 'Altstadt',
    });
  });

  it('11/12 — fehlt ein finaler Snapshot, wird geworfen statt ausgewichen', () => {
    expect(() =>
      buildFinalSharedPresentationContext({
        companySnapshot: undefined as unknown as CompanyProfile,
        customerSnapshot: customerBilling(),
        document: DOCUMENT,
      }),
    ).toThrow(/companySnapshot fehlt/);

    expect(() =>
      buildFinalSharedPresentationContext({
        companySnapshot: companyProfile(),
        customerSnapshot: undefined as unknown as CustomerBilling,
        document: DOCUMENT,
      }),
    ).toThrow(/customerSnapshot fehlt/);
  });

  /*
   * 13 — „der finale Pfad kennt keine Live-Quelle" hat hier bewusst KEINEN
   * eigenen Testfall.
   *
   * Was tatsächlich zugesichert ist: Der Builder liest selbst keine Live-Quelle,
   * hat keinen Customer- oder Company-Lookup, keinen Live-Fallback und
   * verwendet ausschliesslich die übergebenen Objekte. Das belegen Test 8
   * (finalisiert wird genau der übergebene Stand gezeigt) und Test 17 (keine
   * Store-, Persistenz- oder Sync-Abhängigkeit im Code).
   *
   * Was **nicht** zugesichert werden kann: dass die übergebenen Objekte
   * wirklich historisch eingefroren sind. `companySnapshot` hat den Typ
   * `CompanyProfile`, `customerSnapshot` den Typ `CustomerBilling` — ob dahinter
   * ein alter Stand oder das aktuelle Profil steckt, sieht der Compiler nicht.
   * Dafür ist der spätere produktive Aufrufer verantwortlich.
   *
   * Ein `@ts-expect-error`-Vertrag würde hier ohnehin nichts prüfen:
   * `tsconfig.json` schliesst die Testdateien per `exclude` aus, und weder
   * `vitest.config.ts` noch `vitest.core.config.ts` aktivieren `typecheck`.
   * Die Direktive stünde als scheinbarer Nachweis in der Datei, ohne je
   * ausgewertet zu werden — lieber keine Zusicherung als eine, die nichts hält.
   */

  it('14 — fehlende Angaben bleiben leer, vorhandene bleiben unangetastet', () => {
    /*
     * Die Trennlinie: Nur der wirklich leere String und `undefined` gelten als
     * „nicht vorhanden". Alles andere ist ein historischer Wert und wird
     * zeichengetreu übernommen — auch Leerzeichen. Ein stilles `trim()` würde
     * ein eingefrorenes Dokument verändern, und sei es nur um ein Zeichen.
     */
    const context = buildDraftSharedPresentationContext({
      companySnapshot: companyProfile({
        website: '',
        managingDirector: undefined,
        vatId: '   ',
        city: ' Beispielstadt ',
      }),
      customerBilling: customerBilling({
        contactPerson: '',
        phone: '',
        email: '  ',
        street: ' Alte Anschrift 1 ',
      }),
      document: DOCUMENT,
    });

    // leer / fehlend → undefined
    expect(context.issuer.website).toBeUndefined();
    expect(context.issuer.managingDirector).toBeUndefined();
    expect(context.recipient.contactPerson).toBeUndefined();
    expect(context.recipient.phone).toBeUndefined();
    expect(context.recipientCustomerId).toBeUndefined();
    expect(context.project).toBeUndefined();

    // reiner Whitespace ist ein Wert, kein Fehlen
    expect(context.issuer.vatId).toBe('   ');
    expect(context.recipient.email).toBe('  ');

    // führender/nachfolgender Whitespace bleibt erhalten
    expect(context.issuer.city).toBe(' Beispielstadt ');
    expect(context.recipient.street).toBe(' Alte Anschrift 1 ');
    expect(context.recipient.street).not.toBe('Alte Anschrift 1');
  });

  it('14b — auch der finale Pfad übernimmt Snapshot-Werte zeichengetreu', () => {
    const context = buildFinalSharedPresentationContext({
      companySnapshot: companyProfile({ street: ' Damalige Werkstraße 1 ' }),
      customerSnapshot: customerBilling({ street: ' Alte Anschrift 1 ' }),
      recipientCustomerId: ' cust-1 ',
      project: { vorgangId: 'v-1', title: ' Beispielauftrag ', site: '' },
      document: DOCUMENT,
    });

    expect(context.issuer.street).toBe(' Damalige Werkstraße 1 ');
    expect(context.recipient.street).toBe(' Alte Anschrift 1 ');
    expect(context.recipientCustomerId).toBe(' cust-1 ');
    expect(context.project?.title).toBe(' Beispielauftrag ');
    expect(context.project?.site).toBeUndefined();
  });

  it('15 — das Logo wird nicht übernommen', () => {
    const context = buildDraftSharedPresentationContext({
      companySnapshot: companyProfile(),
      customerBilling: customerBilling(),
      document: DOCUMENT,
    });

    expect(JSON.stringify(context)).not.toContain('data:image');
    expect((context.issuer as Record<string, unknown>).logoDataUrl).toBeUndefined();
  });

  it('16 — keine Rechnungsfachlichkeit im gemeinsamen Context', () => {
    const context = buildFinalSharedPresentationContext({
      companySnapshot: companyProfile(),
      customerSnapshot: customerBilling(),
      project: { vorgangId: 'v-1', title: 'Beispielauftrag', site: 'Beispielstraße 5' },
      document: DOCUMENT,
    });

    const serialized = JSON.stringify(context);
    for (const forbidden of [
      'positions',
      'summary',
      'subtotal',
      'taxRate',
      'taxStatus',
      'grossTotal',
      'invoiceNumber',
      'paymentDueDate',
      'skonto',
      'servicePeriod',
      'deduction',
      'defaultPaymentTerms',
      'invoiceFooterNotes',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(Object.keys(context).sort()).toEqual([
      'document',
      'issuer',
      'mode',
      'project',
      'provenance',
      'recipient',
      'recipientCustomerId',
      'version',
    ]);
  });

  it('17 — zwei Aufrufe mit gleicher Eingabe liefern denselben Context', () => {
    const input = {
      companySnapshot: companyProfile(),
      customerBilling: customerBilling(),
      recipientCustomerId: 'cust-1',
      project: { vorgangId: 'v-1', title: 'Beispielauftrag', site: 'Beispielstraße 5' },
      document: DOCUMENT,
    };

    expect(buildDraftSharedPresentationContext(input)).toEqual(
      buildDraftSharedPresentationContext(input),
    );
  });

  it('18 — die Herkunft wird übernommen, nicht ermittelt', () => {
    const withDefaults = buildDraftSharedPresentationContext({
      companySnapshot: companyProfile(),
      customerBilling: customerBilling(),
      document: DOCUMENT,
    });
    expect(withDefaults.provenance).toEqual({
      issuer: 'draft_snapshot',
      recipient: 'draft_snapshot',
    });

    const declared = buildDraftSharedPresentationContext({
      companySnapshot: companyProfile(),
      customerBilling: customerBilling(),
      document: DOCUMENT,
      issuerSource: 'current_company_snapshot',
      recipientSource: 'customer_master_snapshot',
    });
    expect(declared.provenance).toEqual({
      issuer: 'current_company_snapshot',
      recipient: 'customer_master_snapshot',
    });

    const final = buildFinalSharedPresentationContext({
      companySnapshot: companyProfile(),
      customerSnapshot: customerBilling(),
      document: DOCUMENT,
    });
    expect(final.provenance).toEqual({
      issuer: 'invoice_snapshot',
      recipient: 'invoice_snapshot',
    });
  });

  it('19 — Entwurf und finale Fassung sind eindeutig unterscheidbar', () => {
    expect(
      buildDraftSharedPresentationContext({
        companySnapshot: companyProfile(),
        customerBilling: customerBilling(),
        document: DOCUMENT,
      }).mode,
    ).toBe('draft');
    expect(
      buildFinalSharedPresentationContext({
        companySnapshot: companyProfile(),
        customerSnapshot: customerBilling(),
        document: DOCUMENT,
      }).mode,
    ).toBe('final');
  });

  it('20/21 — der Baustein ist frei von Store-, Persistenz- und Sync-Abhängigkeiten', () => {
    /*
     * Statt das Store-System zu booten, nur um nachzusehen, dass nichts
     * passiert: Der Nachweis wird an der Abhängigkeitsgrenze geführt. Was
     * nicht importiert werden kann, kann auch nicht geschrieben werden.
     */
    const source = sharedPresentationContextSource;

    // Einzige Importe sind Typen aus models/presentation.
    const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
    expect(imports.sort()).toEqual(['../../types/models', '../../types/presentation']);

    /*
     * Kommentare werden entfernt: Die Datei *beschreibt* ihre Abstinenz von
     * Stores und Outbox — geprüft werden soll der Code, nicht die Prosa.
     */
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');

    for (const forbidden of [
      'Store',
      'localStorage',
      'indexedDB',
      'fetch(',
      'supabase',
      'Outbox',
      'persistAll',
      'Date.now',
      'Math.random',
    ]) {
      expect(code).not.toContain(forbidden);
    }
  });

  it('das Projekt reist nur als Bezug mit', () => {
    const context = buildDraftSharedPresentationContext({
      companySnapshot: companyProfile(),
      customerBilling: customerBilling(),
      project: { vorgangId: 'v-1', title: 'Beispielauftrag', site: '' },
      document: DOCUMENT,
    });

    expect(context.project).toEqual({
      vorgangId: 'v-1',
      title: 'Beispielauftrag',
      site: undefined,
    });
  });
});

/*
 * Der Quelltext des Bausteins als Zeichenkette. `?raw` ist der von Vite
 * vorgesehene Weg und braucht weder Node-Dateizugriff noch ein Mock.
 */
import sharedPresentationContextSource from './sharedPresentationContextService.ts?raw';
