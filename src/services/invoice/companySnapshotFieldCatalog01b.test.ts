/**
 * COMPANY-SNAPSHOT-FIELD-CATALOG-01B — die beiden Rechnungsvalidatoren können
 * nicht mehr auseinanderlaufen.
 *
 * Der Fehler, den dieser Test verhindert, ist bereits eingetreten: Beim
 * Registerblock wurde `registrationAuthority`/`registrationNumber` nur in einer
 * der beiden Positivlisten ergänzt. Der Cloud-Payload-Validator liess die
 * Rechnung durch, der Prepared-Finalize-Request-Validator wies sie danach mit
 * `unknown_field` ab — für jeden eingetragenen Betrieb, und ohne dass ein Test
 * es gemerkt hätte.
 *
 * Geprüft wird deshalb auf zwei Ebenen:
 *
 *  1. **Zur Laufzeit** — jeder Schlüssel des Katalogs wird von **beiden**
 *     Validatoren akzeptiert, ein unbekannter von beiden abgelehnt.
 *  2. **Am Quelltext** — keiner der beiden Validatoren führt noch eine eigene
 *     Schlüsselliste. TypeScript-Typen existieren zur Laufzeit nicht; dass
 *     beide aus derselben Quelle speisen, lässt sich nur so festhalten.
 *
 * Kein Netz, keine Cloud, keine gespeicherten Daten.
 */
import { describe, expect, it } from 'vitest';

import cloudValidatorSource from './workspaceInvoiceCloudPayloadValidator.ts?raw';
import finalizeValidatorSource from './workspaceInvoiceFinalizeRequestValidator.ts?raw';
import { COMPANY_SNAPSHOT_KEYS } from './companySnapshotFieldCatalog';
import { validateWorkspaceInvoiceCloudPayload } from './workspaceInvoiceCloudPayloadValidator';
import {
  buildInvoicePayloadV1,
  validatePreparedWorkspaceInvoiceFinalizeRequest,
  PREPARED_FINALIZE_REQUEST_KIND,
  PREPARED_FINALIZE_REQUEST_FORMAT_VERSION,
} from './workspaceInvoiceFinalizeRequestValidator';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import type { CompanyProfile, VorgangInvoice } from '../../types/models';

/** Ein Snapshot, der **jeden** Katalogschlüssel tatsächlich trägt. */
const FULL_SNAPSHOT: CompanyProfile = {
  ...DEFAULT_COMPANY_PROFILE,
  companyName: 'Alpha Haustechnik GmbH',
  legalForm: 'GmbH',
  logoDataUrl: '',
  street: 'Werkstraße 12',
  zip: '32657',
  city: 'Lemgo',
  country: 'Deutschland',
  contactPerson: 'A. Alpha',
  phone: '05261 123456',
  email: 'buero@alpha.invalid',
  website: 'www.alpha.invalid',
  taxNumber: '111/222/33333',
  vatId: 'DE123456789',
  registrationAuthority: 'Amtsgericht Lemgo',
  registrationNumber: 'HRB 12345',
  bankName: 'Sparkasse Lemgo',
  iban: 'DE89 3704 0044 0532 0130 00',
  bic: 'WELADED1LIP',
  defaultPaymentDays: 14,
  defaultPaymentTerms: 'Zahlbar innerhalb von 14 Tagen.',
  defaultSkonto: '',
  skontoEnabled: false,
  skontoPercent: 0,
  skontoDays: 0,
  managingDirector: 'Max Mustermann, Erika Beispiel',
  taxFreeNotice: '',
  invoiceFooterNotes: '',
};

function invoiceWith(snapshot: Record<string, unknown>): VorgangInvoice {
  return {
    id: 'inv-catalog-01b',
    number: '2026-0042',
    type: 'rechnung',
    positions: [],
    subtotal: 440,
    taxStatus: 'standard_19',
    amount: 523.6,
    status: 'vorbereitet',
    date: '2026-09-01',
    createdAt: '2026-09-01T08:00:00.000Z',
    issueDate: '2026-09-01',
    servicePeriodFrom: '2026-08-01',
    servicePeriodTo: '2026-08-31',
    servicePeriodConfirmed: true,
    paymentDueDate: '2026-09-15',
    paymentTermsText: 'Zahlbar innerhalb von 14 Tagen.',
    customerSnapshot: {
      name: 'Beispiel Kundschaft GmbH',
      contactPerson: 'A. Beispiel',
      street: 'Musterweg 1',
      zip: '10115',
      city: 'Berlin',
      email: '',
      phone: '',
    },
    companySnapshot: snapshot,
    legalNotices: [],
  } as unknown as VorgangInvoice;
}

/** Was der Cloud-Validator sagt — `true`, oder der Ablehnungsgrund. */
function cloudVerdict(snapshot: Record<string, unknown>): true | string {
  const invoice = invoiceWith(snapshot);
  const payload = JSON.parse(JSON.stringify(invoice)) as Record<string, unknown>;
  /* Diese Metaschlüssel gehören nicht in den Cloud-Payload. */
  delete payload.legalNotices;
  const result = validateWorkspaceInvoiceCloudPayload({
    ...payload,
    legalNotices: [],
  });
  return result.ok ? true : result.detail;
}

/** Was der Prepared-Finalize-Validator sagt — `true`, oder der Ablehnungsgrund. */
function finalizeVerdict(snapshot: Record<string, unknown>): true | string {
  const invoice = JSON.parse(JSON.stringify(invoiceWith(snapshot)));
  const invoicePayload = buildInvoicePayloadV1(invoice);
  if (!invoicePayload) return 'builder_rejected';
  const result = validatePreparedWorkspaceInvoiceFinalizeRequest({
    kind: PREPARED_FINALIZE_REQUEST_KIND,
    formatVersion: PREPARED_FINALIZE_REQUEST_FORMAT_VERSION,
    workspaceId: 'ws-1',
    vorgangId: 'v-test-1',
    clientInvoiceId: invoice.id,
    invoice,
    invoicePayload,
    expectedResponseProjectionRawJson: '{}',
  });
  return result.ok ? true : result.detail;
}

describe('01B — beide Validatoren tragen denselben Schlüsselkatalog', () => {
  it('der vollständige Katalog wird von beiden akzeptiert', () => {
    const snapshot = { ...FULL_SNAPSHOT } as Record<string, unknown>;

    /* Der Prüfkörper muss wirklich jeden Katalogschlüssel enthalten. */
    for (const key of COMPANY_SNAPSHOT_KEYS) {
      expect(Object.prototype.hasOwnProperty.call(snapshot, key), `fehlt: ${key}`).toBe(true);
    }

    expect(cloudVerdict(snapshot)).toBe(true);
    expect(finalizeVerdict(snapshot)).toBe(true);
  });

  it('beide Validatoren urteilen über jeden Schlüssel gleich', () => {
    /*
     * Die eigentliche Aussage dieses Blocks, und zwar zur Laufzeit: Für
     * dieselbe Frage — „darf dieser Schlüssel vorkommen?" — dürfen die beiden
     * Validatoren nie verschieden antworten. Genau diese Divergenz war der
     * Fehler von 01I, und sie blieb monatelang unbemerkt, weil niemand beide
     * gegeneinander gehalten hat.
     *
     * Geprüft werden Katalogschlüssel **und** Nicht-Katalogschlüssel: Sonst
     * wäre der Test auch dann grün, wenn beide alles akzeptierten.
     */
    const proben = [
      ...COMPANY_SNAPSHOT_KEYS.map((key) => ({ key, erlaubt: true })),
      { key: 'branding', erlaubt: false },
      { key: 'futureUnknownCompanyField', erlaubt: false },
      { key: 'storagePath', erlaubt: false },
    ];

    const abweichungen: string[] = [];
    for (const { key, erlaubt } of proben) {
      const snapshot = { ...FULL_SNAPSHOT } as Record<string, unknown>;
      if (!erlaubt) snapshot[key] = 'x';

      const cloudUnbekannt = String(cloudVerdict(snapshot)).includes(`${key}:unknown_field`);
      const finalizeUnbekannt = String(finalizeVerdict(snapshot)).includes(key);

      if (cloudUnbekannt !== finalizeUnbekannt) {
        abweichungen.push(`${key}: cloud=${cloudUnbekannt} finalize=${finalizeUnbekannt}`);
      }
      if (cloudUnbekannt === erlaubt) {
        abweichungen.push(`${key}: erwartet erlaubt=${erlaubt}, cloud sagt anders`);
      }
    }

    expect(abweichungen).toEqual([]);
  });

  it('E: die Kontrollfelder sind im Katalog', () => {
    for (const key of [
      'registrationAuthority',
      'registrationNumber',
      'managingDirector',
      'companyName',
      'legalForm',
      'taxNumber',
      'vatId',
      'iban',
      'bic',
    ]) {
      expect(COMPANY_SNAPSHOT_KEYS, key).toContain(key);
    }
  });
});

describe('01B — F: der unknown-field-Schutz bleibt scharf', () => {
  it('ein unbekannter Schlüssel wird von BEIDEN abgelehnt', () => {
    const snapshot = {
      ...FULL_SNAPSHOT,
      futureUnknownCompanyField: 'irgendwas',
    } as Record<string, unknown>;

    const cloud = cloudVerdict(snapshot);
    const finalize = finalizeVerdict(snapshot);

    expect(cloud).not.toBe(true);
    expect(String(cloud)).toContain('futureUnknownCompanyField:unknown_field');
    expect(finalize).not.toBe(true);
    expect(String(finalize)).toContain('futureUnknownCompanyField');
  });

  it('G: technische Branding-/Assetwerte bleiben draussen', () => {
    /*
     * `branding` ist ein geschlossener Unterblock mit eigenem Vertrag; Pfade,
     * signierte URLs und Bildbytes haben in einem Rechnungs-Snapshot nichts zu
     * suchen. Die Zentralisierung darf sie nicht versehentlich erlauben.
     */
    for (const verboten of ['branding', 'storagePath', 'signedUrl', 'publicUrl', 'dataUrl']) {
      expect(COMPANY_SNAPSHOT_KEYS).not.toContain(verboten);

      const snapshot = { ...FULL_SNAPSHOT, [verboten]: 'x' } as Record<string, unknown>;
      expect(cloudVerdict(snapshot), `cloud liess ${verboten} durch`).not.toBe(true);
    }
  });
});

describe('01B — die Quelle ist wirklich nur noch eine', () => {
  it('keiner der beiden Validatoren führt noch eine eigene Schlüsselliste', () => {
    /*
     * Am Quelltext geprüft, weil TypeScript-Typen zur Laufzeit nicht
     * existieren. Fände jemand die Zentralisierung unbequem und schriebe die
     * Liste lokal zurück, stünde `'companyName'` wieder in einer
     * `COMPANY_KEYS`-Definition — und dieser Test würde rot.
     */
    for (const [name, source] of [
      ['cloud', cloudValidatorSource],
      ['finalize', finalizeValidatorSource],
    ] as const) {
      const definition = source.slice(source.indexOf('const COMPANY_KEYS'));
      const bisZeilenende = definition.slice(0, definition.indexOf('\n'));

      expect(definition, name).toContain('COMPANY_SNAPSHOT_KEYS');
      /* Die Definition passt in eine Zeile — eine ausgeschriebene Liste nicht. */
      expect(bisZeilenende, name).toContain('COMPANY_SNAPSHOT_KEYS');
    }
  });

  it('beide importieren denselben Katalog', () => {
    for (const [name, source] of [
      ['cloud', cloudValidatorSource],
      ['finalize', finalizeValidatorSource],
    ] as const) {
      expect(source, name).toContain("from './companySnapshotFieldCatalog'");
    }
  });
});
