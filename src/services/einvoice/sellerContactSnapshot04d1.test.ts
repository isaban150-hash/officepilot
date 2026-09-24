/**
 * E-RECHNUNG-04D-FIX1 — der Ansprechpartner des Absenders im eingefrorenen Beleg.
 *
 * Realbefund der unabhängigen Abnahme: Die Telefonnummer wurde im Firmenprofil
 * ergänzt und synchronisiert, danach eine Rechnung freigegeben — und der
 * XRechnung-Export wies sie trotzdem mit „dem Absender fehlt eine
 * Telefonnummer" ab.
 *
 * Die Ursache lag nicht im Export, sondern im Zeitpunkt des Einfrierens: Der
 * Firmen-Snapshot entsteht beim **Aufbau** des Entwurfs, und Entwürfe sind
 * dauerhaft. Wer `/rechnungen/neu` erneut öffnet, nimmt den gespeicherten
 * Entwurf wieder auf — samt seines damaligen Snapshots. Der Drift-Dienst, der
 * genau dafür existiert, kannte die Kontaktangaben nicht.
 *
 * Geprüft wird deshalb beides: dass die Angaben jetzt mitgeführt werden — und
 * dass ein bereits freigegebener Beleg sich dadurch **nicht** verändert.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  buildInvoiceDraftForType,
  buildInvoiceFinalizationCandidate,
  buildManualInvoiceDraft,
  updateDraftPositionQuantity,
  updateInvoiceDraftMetadata,
} from '../invoiceService';
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
  CRITICAL_COMPANY_FIELDS,
  applyCriticalCompanyProfileFields,
  findCriticalCompanyProfileDrift,
} from '../invoice/companySnapshotDriftService';
import { COMPANY_SNAPSHOT_KEYS } from '../invoice/companySnapshotFieldCatalog';
import {
  buildWorkspaceInvoiceFinalizePayload,
  mapCloudPayloadToVorgangInvoice,
} from '../invoice/workspaceInvoiceCloudService';
import { validateWorkspaceInvoiceCloudPayload } from '../invoice/workspaceInvoiceCloudPayloadValidator';
import { buildCanonicalEInvoice } from './canonicalEInvoiceBuilder';
import { renderXRechnungCii } from './xrechnungCiiRenderer';
import type { CustomerBilling, InvoiceDraft, Vorgang, VorgangInvoice } from '../../types/models';

const VID = 'v-04d1';

const KUNDE: CustomerBilling = {
  name: 'AZ Testbau GmbH',
  contactPerson: 'Frau Meier',
  street: 'Industriestrasse 12',
  zip: '33602',
  city: 'Bielefeld',
  email: 'buchhaltung@az-testbau.invalid',
  phone: '0521 4711',
  countryCode: 'DE',
  vatId: 'DE987654321',
  buyerReference: 'TEST-BUYER-B',
};

/** Das Profil des Betriebs — ohne Telefonnummer, wie im Realbefund. */
function profilOhneTelefon(overrides: Record<string, unknown> = {}) {
  hydrateCompanyProfileStore({
    ...DEFAULT_COMPANY_PROFILE,
    companyName: 'Cirmak Haustechnik GmbH',
    street: 'Ruhrallee 5',
    zip: '45138',
    city: 'Essen',
    country: 'Deutschland',
    countryCode: 'DE',
    contactPerson: 'Saban Irmak',
    phone: '',
    email: 'buero@cirmak.invalid',
    taxNumber: '27/123/45678',
    vatId: 'DE111111111',
    iban: 'DE89370400440532013000',
    bic: 'WELADED1ESN',
    bankName: 'Sparkasse',
    ...overrides,
  } as never);
}

function vorgang(): Vorgang {
  return {
    id: VID,
    title: '04D1 Probe',
    customer: KUNDE.name,
    baustelle: '',
    status: 'beauftragt',
    materialSource: 'betrieb',
    createdAt: '2026-09-20T08:00:00.000Z',
    orderNumber: 'AU-2026-0099',
    customerBilling: { ...KUNDE },
    orderPositions: [
      { id: 'op1', description: 'Wartung', plannedQuantity: 10, unit: 'Stunden', unitPrice: 10, billable: true },
    ],
    documents: [],
    tasks: [],
    photos: [],
    invoices: [],
  } as unknown as Vorgang;
}

function freigabereif(draft: InvoiceDraft): InvoiceDraft {
  const mit = updateInvoiceDraftMetadata(draft, {
    servicePeriodFrom: '2026-09-23',
    servicePeriodTo: '2026-09-23',
    servicePeriodConfirmed: true,
  });
  const erste = mit.positions[0];
  if (erste) return updateDraftPositionQuantity(mit, erste.id, 1);
  return {
    ...mit,
    positions: [
      { id: 'p1', description: 'Wartung', quantity: 1, unit: 'Stunden', unitPrice: 10, billable: true } as never,
    ],
  };
}

function finalisiere(draft: InvoiceDraft, id: string): VorgangInvoice {
  const candidate = buildInvoiceFinalizationCandidate(draft.vorgangId, freigabereif(draft), testSetup, id);
  if (!candidate.ok) throw new Error('Kandidat abgelehnt: ' + JSON.stringify(candidate));
  return { ...candidate.invoice, number: '2026-0099' };
}

const TELEFON_B = '+49 0000 0000000';

beforeEach(() => {
  resetTestStores();
  profilOhneTelefon();
});

describe('A — der Root Cause', () => {
  it('der Firmen-Snapshot entsteht beim Aufbau des Entwurfs, nicht bei der Freigabe', () => {
    const draft = buildManualInvoiceDraft({ billing: KUNDE }, testSetup);
    expect(draft.companySnapshot.phone, 'damals leer').toBe('');

    updateCompanyProfile({ phone: TELEFON_B });
    expect(getCompanyProfile().phone).toBe(TELEFON_B);

    // Der Entwurf von vorher kennt die neue Nummer nicht — das ist die Lücke.
    expect(draft.companySnapshot.phone).toBe('');
  });

  it('die Kontaktangaben stehen jetzt in der Driftliste', () => {
    for (const feld of ['contactPerson', 'phone', 'email', 'countryCode'] as const) {
      expect([...CRITICAL_COMPANY_FIELDS], feld).toContain(feld);
    }
  });

  it('T1/T2: ein offener Entwurf meldet die Änderung und übernimmt sie vor der Freigabe', () => {
    const draft = buildManualInvoiceDraft({ billing: KUNDE }, testSetup);
    updateCompanyProfile({ phone: TELEFON_B });

    const drift = findCriticalCompanyProfileDrift(draft.companySnapshot, getCompanyProfile());
    expect(drift, 'die Änderung wird sichtbar').toContain('phone');

    const uebernommen = applyCriticalCompanyProfileFields(draft.companySnapshot, getCompanyProfile());
    expect(uebernommen.phone).toBe(TELEFON_B);
    // Alles andere bleibt, wie es war.
    expect(uebernommen.companyName).toBe('Cirmak Haustechnik GmbH');
  });
});

describe('B — der Snapshot einer neu freigegebenen Rechnung', () => {
  it('T3/T4/T5: Kontaktname, Telefon und E-Mail sind eingefroren und tragen bis ins XML', () => {
    profilOhneTelefon({ phone: TELEFON_B });
    const invoice = finalisiere(buildManualInvoiceDraft({ billing: KUNDE }, testSetup), 'inv-a');

    expect(invoice.companySnapshot?.contactPerson).toBe('Saban Irmak');
    expect(invoice.companySnapshot?.phone).toBe(TELEFON_B);
    expect(invoice.companySnapshot?.email).toBe('buero@cirmak.invalid');

    const canonical = buildCanonicalEInvoice(invoice);
    expect(canonical.ok, canonical.ok ? '' : JSON.stringify(canonical.issues)).toBe(true);
    if (!canonical.ok) return;
    expect(canonical.value.seller.contact).toEqual({
      name: 'Saban Irmak',
      phone: TELEFON_B,
      email: 'buero@cirmak.invalid',
    });

    const xml = renderXRechnungCii(canonical.value);
    expect(xml.ok).toBe(true);
    if (!xml.ok) return;
    expect(xml.xml).toContain('<ram:PersonName>Saban Irmak</ram:PersonName>');
    expect(xml.xml).toContain(`<ram:CompleteNumber>${TELEFON_B}</ram:CompleteNumber>`);
  });

  it('T10: die Auftragsrechnung nimmt denselben Weg', () => {
    profilOhneTelefon({ phone: TELEFON_B });
    hydrateVorgangStore([vorgang()]);
    for (const type of ['rechnung', 'teilrechnung', 'abschlag', 'schluss'] as const) {
      const draft = buildInvoiceDraftForType(VID, testSetup, type)!;
      expect(draft.companySnapshot.phone, type).toBe(TELEFON_B);
      expect(draft.companySnapshot.contactPerson, type).toBe('Saban Irmak');
    }
  });
});

describe('C — der freigegebene Beleg bleibt stehen', () => {
  it('T6/T7/T8: alte Rechnung behält A, neue bekommt B', () => {
    profilOhneTelefon({ phone: '0201 111111' });
    const alt = finalisiere(buildManualInvoiceDraft({ billing: KUNDE }, testSetup), 'inv-alt');
    expect(alt.companySnapshot?.phone).toBe('0201 111111');

    updateCompanyProfile({ phone: TELEFON_B });

    // Der freigegebene Beleg rührt sich nicht.
    expect(alt.companySnapshot?.phone).toBe('0201 111111');
    expect(buildCanonicalEInvoice(alt).ok).toBe(true);

    const neu = finalisiere(buildManualInvoiceDraft({ billing: KUNDE }, testSetup), 'inv-neu');
    expect(neu.companySnapshot?.phone).toBe(TELEFON_B);
  });

  it('T14: der Canonical-Builder fragt das Firmenprofil nie', () => {
    profilOhneTelefon({ phone: '0201 111111' });
    const invoice = finalisiere(buildManualInvoiceDraft({ billing: KUNDE }, testSetup), 'inv-x');

    /*
     * Das Profil wird nach der Freigabe vollständig ausgetauscht. Läse der
     * Builder es, müsste sich das Ergebnis ändern — es tut es nicht, weil er
     * keinen Zugang dazu hat.
     */
    profilOhneTelefon({
      companyName: 'Ganz anderer Betrieb GmbH',
      phone: '0999 999999',
      email: 'anders@anders.invalid',
      contactPerson: 'Jemand Anders',
    });

    const canonical = buildCanonicalEInvoice(invoice);
    expect(canonical.ok).toBe(true);
    if (!canonical.ok) return;
    expect(canonical.value.seller.name).toBe('Cirmak Haustechnik GmbH');
    expect(canonical.value.seller.contact.phone).toBe('0201 111111');
    expect(canonical.value.seller.contact.name).toBe('Saban Irmak');
  });
});

describe('D — Altbelege', () => {
  it('T9: ohne Telefonnummer bleibt der Beleg nicht exportierbar', () => {
    const invoice = finalisiere(buildManualInvoiceDraft({ billing: KUNDE }, testSetup), 'inv-ohne');
    expect(invoice.companySnapshot?.phone).toBe('');

    const canonical = buildCanonicalEInvoice(invoice);
    expect(canonical.ok).toBe(false);
    if (canonical.ok) return;
    expect(canonical.issues.map((i) => i.code)).toContain('seller_contact_missing');
    // Und es wird nichts aus dem heutigen Profil nachgeschoben.
    updateCompanyProfile({ phone: TELEFON_B });
    expect(buildCanonicalEInvoice(invoice).ok).toBe(false);
  });
});

describe('E — Persistenz und Unveränderlichkeit', () => {
  it('T11: der Cloud-Rundlauf verliert die Kontaktangaben nicht', () => {
    profilOhneTelefon({ phone: TELEFON_B });
    const invoice = finalisiere(buildManualInvoiceDraft({ billing: KUNDE }, testSetup), 'inv-cloud');

    for (const feld of ['contactPerson', 'phone', 'email'] as const) {
      expect([...COMPANY_SNAPSHOT_KEYS], feld).toContain(feld);
    }

    const payload = buildWorkspaceInvoiceFinalizePayload(invoice);
    const geprueft = validateWorkspaceInvoiceCloudPayload(payload);
    expect(geprueft.ok, geprueft.ok ? '' : geprueft.detail).toBe(true);

    const zurueck = mapCloudPayloadToVorgangInvoice(payload);
    expect(zurueck?.companySnapshot?.phone).toBe(TELEFON_B);
    expect(zurueck?.companySnapshot?.contactPerson).toBe('Saban Irmak');
    expect(zurueck?.companySnapshot?.email).toBe('buero@cirmak.invalid');
  });

  it('T12: ein nachträglich veränderter Kontakt ist ein anderer Beleg', () => {
    profilOhneTelefon({ phone: TELEFON_B });
    const invoice = finalisiere(buildManualInvoiceDraft({ billing: KUNDE }, testSetup), 'inv-fp');

    const original = immutableInvoiceFingerprint(invoice);
    const manipuliert = immutableInvoiceFingerprint({
      ...invoice,
      companySnapshot: { ...invoice.companySnapshot!, phone: '0999 999999' },
    });
    expect(manipuliert).not.toBe(original);
    // Und das Ergebnis bleibt über Wiederholungen stabil.
    expect(immutableInvoiceFingerprint(invoice)).toBe(original);
  });
});
