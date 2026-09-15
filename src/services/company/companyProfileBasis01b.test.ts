/**
 * PRODUCT-BASIS-FIRMENPROFIL-EINSTELLUNGEN-01B — Modell-, Migrations- und
 * Snapshot-Haertung.
 *
 *  A  neue Felder normalisieren/persistieren (currency, replyToEmail, senderDisplayName)
 *  G  bewusstes Loeschen = Schluessel fehlt im Payload (Schema-Version 2)
 *  H  defaultTaxStatus-Migration: Profil gewinnt / Setup wird uebernommen / nichts erfunden
 *     currency: EUR nur ohne widersprechende Belege
 *  I  fachliche Leser (Ausgabe, Rechnung) nutzen die Profilwahrheit; Setup ist Spiegel
 *  J  Own-Company-Guard bleibt gruen (Cirmak / Çırmak / Schreibweisen)
 *  K  finalisierte Rechnung bleibt nach Profilaenderung historisch stabil (companySnapshot,
 *     Korrektur-Modell), neue Felder sickern nie in Snapshots
 *  L  Branding-Snapshot unveraendert
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  COMPANY_PROFILE_SCHEMA_VERSION,
  applyCompanyProfileSettingsContract,
  resolveProfileCurrency,
  resolveProfileReplyToEmail,
  resolveProfileSenderDisplayName,
} from './companyProfileSettingsContract';
import { migrateCompanyProfileLegacyFields } from './companyProfileLegacyMigrationService';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import { DEFAULT_SETUP } from '../../data/mockData';
import { getCompanyProfile, hydrateCompanyProfileStore, updateCompanyProfile } from '../companyProfileService';
import { getCachedSetup, persistAll } from '../persistenceService';
import { buildCompanyProfileCloudPayload, parseCompanyProfileFromCloud } from '../workspace/workspaceCloudService';
import { addExpense } from '../expenseService';
import { hydrateExpenseStore } from '../expenseStore';
import { resolveDefaultTaxStatus } from '../invoice/invoiceDefaults';
import { isOwnCompanyName, pickExternalCustomerName } from '../customerOwnCompanyGuard';
import { toInvoiceCompanySnapshot } from '../invoiceService';
import { COMPANY_SNAPSHOT_KEYS } from '../invoice/companySnapshotFieldCatalog';
import { buildInvoicePrintModelFromInvoice } from '../invoicePrintModel';
import { buildInvoiceCorrectionModel } from '../invoice/invoiceCorrectionModel';
import { resetTestStores } from '../../test/resetStores';
import type { CompanyProfile, VorgangInvoice } from '../../types/models';

const profile = (overrides: Partial<CompanyProfile> = {}): CompanyProfile => ({
  ...DEFAULT_COMPANY_PROFILE,
  companyName: 'Cirmak Haustechnik GmbH',
  street: 'Werkstraße 12',
  zip: '32657',
  city: 'Lemgo',
  email: 'info@cirmak.example',
  iban: 'DE89370400440532013000',
  ...overrides,
});

describe('01B — A/G Vertrag der neuen Felder', () => {
  it('normalisiert currency (ISO 4217, Grossbuchstaben), replyToEmail (klein, gueltig), senderDisplayName (getrimmt)', () => {
    const next = applyCompanyProfileSettingsContract({
      currency: ' eur ', replyToEmail: ' Buero@Cirmak.Example ', senderDisplayName: '  Cirmak Haustechnik  ',
    });
    expect(next).toEqual({ currency: 'EUR', replyToEmail: 'buero@cirmak.example', senderDisplayName: 'Cirmak Haustechnik' });
  });

  it('01B2 — drei Zustaende: leer = Schluessel entfernt (bewusst), ungueltig = unveraendert belassen (nie Loeschung)', () => {
    const cleared = applyCompanyProfileSettingsContract({ currency: '', replyToEmail: '', senderDisplayName: '', defaultTaxStatus: 'standard_19' });
    expect(Object.keys(cleared)).toEqual(['defaultTaxStatus']);
    const invalid = applyCompanyProfileSettingsContract({ currency: 'euro', replyToEmail: 'kein-mail', senderDisplayName: 'x'.repeat(200) });
    expect(invalid).toEqual({ currency: 'euro', replyToEmail: 'kein-mail', senderDisplayName: 'x'.repeat(200) });
    // Der Payload eines ungueltigen Werts sieht nie wie eine Loeschung aus.
    const payload = buildCompanyProfileCloudPayload(profile({ currency: 'euro' as never, replyToEmail: 'kein-mail' }));
    expect(payload.payload).toMatchObject({ currency: 'euro', replyToEmail: 'kein-mail' });
  });

  it('01B2 — Schreibgrenze: gueltig gespeichert, leer geloescht, ungueltig abgelehnt ohne Nebenwirkung', () => {
    resetTestStores();
    hydrateCompanyProfileStore(profile({ currency: 'EUR', replyToEmail: 'alt@cirmak.example', senderDisplayName: 'Alt', defaultTaxStatus: 'standard_19' }));
    // gueltig
    expect(updateCompanyProfile({ replyToEmail: ' Neu@Cirmak.Example ', senderDisplayName: ' Cirmak Service ' }).success).toBe(true);
    expect(getCompanyProfile()).toMatchObject({ replyToEmail: 'neu@cirmak.example', senderDisplayName: 'Cirmak Service' });
    // ungueltig: F/E/D/C — abgelehnt, bestehender Wert bleibt, Payload unveraendert
    const before = JSON.stringify(buildCompanyProfileCloudPayload(getCompanyProfile()));
    expect(updateCompanyProfile({ replyToEmail: 'kein-mail' })).toEqual({ success: false, errorKey: 'companyProfile.replyToEmailInvalid' });
    expect(updateCompanyProfile({ senderDisplayName: 'x'.repeat(121) })).toEqual({ success: false, errorKey: 'companyProfile.senderDisplayNameTooLong' });
    expect(updateCompanyProfile({ currency: 'euro' })).toEqual({ success: false, errorKey: 'companyProfile.currencyInvalid' });
    expect(updateCompanyProfile({ currency: 'USD' })).toEqual({ success: false, errorKey: 'companyProfile.currencyUnsupported' });
    expect(updateCompanyProfile({ defaultTaxStatus: 'kaputt' as never })).toEqual({ success: false, errorKey: 'companyProfile.taxStatusInvalid' });
    expect(getCompanyProfile()).toMatchObject({ currency: 'EUR', replyToEmail: 'neu@cirmak.example', senderDisplayName: 'Cirmak Service', defaultTaxStatus: 'standard_19' });
    expect(JSON.stringify(buildCompanyProfileCloudPayload(getCompanyProfile()))).toBe(before);
    // bewusst leer: Schluessel weg, Resolver faellt zurueck
    expect(updateCompanyProfile({ replyToEmail: '', senderDisplayName: '' }).success).toBe(true);
    const after = getCompanyProfile();
    expect('replyToEmail' in after).toBe(false);
    expect('senderDisplayName' in after).toBe(false);
    expect(resolveProfileReplyToEmail(after)).toBe('info@cirmak.example');
    expect(resolveProfileSenderDisplayName(after)).toBe('Cirmak Haustechnik GmbH');
    expect('replyToEmail' in (buildCompanyProfileCloudPayload(after).payload as object)).toBe(false);
    resetTestStores();
  });

  it('Resolver: fehlend -> EUR / Firmen-E-Mail / „Firmenname Rechtsform“', () => {
    const p = profile({ legalForm: 'GmbH', companyName: 'Cirmak Haustechnik' });
    expect(resolveProfileCurrency(p)).toBe('EUR');
    expect(resolveProfileReplyToEmail(p)).toBe('info@cirmak.example');
    expect(resolveProfileSenderDisplayName(p)).toBe('Cirmak Haustechnik GmbH');
    const explicit = profile({ currency: 'EUR', replyToEmail: 'rechnung@cirmak.example', senderDisplayName: 'Cirmak Service' });
    expect(resolveProfileReplyToEmail(explicit)).toBe('rechnung@cirmak.example');
    expect(resolveProfileSenderDisplayName(explicit)).toBe('Cirmak Service');
  });

  it('Cloud-Payload traegt profile_schema_version 2 und ohne die Felder, wenn geloescht; Pull liest sie zurueck', () => {
    const payload = buildCompanyProfileCloudPayload(profile({ currency: 'EUR', replyToEmail: 'x@y.de', senderDisplayName: 'S' }));
    expect(payload.profile_schema_version).toBe(COMPANY_PROFILE_SCHEMA_VERSION);
    expect(payload.payload).toMatchObject({ currency: 'EUR', replyToEmail: 'x@y.de', senderDisplayName: 'S' });
    const cleared = buildCompanyProfileCloudPayload(profile({ currency: 'EUR', replyToEmail: '', senderDisplayName: '' }));
    expect('replyToEmail' in (cleared.payload as object)).toBe(false);
    expect('senderDisplayName' in (cleared.payload as object)).toBe(false);
    const parsed = parseCompanyProfileFromCloud(payload as Record<string, unknown>);
    expect(parsed).toMatchObject({ currency: 'EUR', replyToEmail: 'x@y.de', senderDisplayName: 'S' });
  });
});

describe('01B — H Migration', () => {
  it('A: Profilwert gewinnt, Setup wird nie darueber gelegt', () => {
    const r = migrateCompanyProfileLegacyFields({ profile: profile({ defaultTaxStatus: 'tax_free', currency: 'EUR' }), setup: { taxStatus: 'standard_19' }, documentCurrencies: [] });
    expect(r.profile.defaultTaxStatus).toBe('tax_free');
    expect(r.changes).toEqual([]);
  });
  it('B: Profil fehlt, Setup gueltig -> einmalig uebernommen; idempotent', () => {
    const r = migrateCompanyProfileLegacyFields({ profile: profile(), setup: { taxStatus: 'kleinunternehmer_19' }, documentCurrencies: ['EUR', undefined] });
    expect(r.profile.defaultTaxStatus).toBe('kleinunternehmer_19');
    expect(r.profile.currency).toBe('EUR');
    expect(r.changes).toEqual(['defaultTaxStatus_from_setup', 'currency_default_eur']);
    const again = migrateCompanyProfileLegacyFields({ profile: r.profile, setup: { taxStatus: 'standard_7' }, documentCurrencies: [] });
    expect(again.changes).toEqual([]);
    expect(again.profile).toEqual(r.profile);
  });
  it('C: beide fehlen/ungueltig -> kein erfundener Steuerstatus', () => {
    const r = migrateCompanyProfileLegacyFields({ profile: profile(), setup: { taxStatus: 'kaputt' as never }, documentCurrencies: [] });
    expect('defaultTaxStatus' in r.profile).toBe(false);
  });
  it('currency: ein fremdwaehriger Beleg -> nicht gesetzt, Konflikt sichtbar', () => {
    const r = migrateCompanyProfileLegacyFields({ profile: profile(), setup: { taxStatus: 'standard_19' }, documentCurrencies: ['EUR', 'chf'] });
    expect('currency' in r.profile).toBe(false);
    expect(r.conflicts).toEqual(['currency_ambiguous']);
  });
});

describe('01B — I fachliche Leser und Legacy-Spiegel', () => {
  beforeEach(() => {
    resetTestStores();
    hydrateExpenseStore([]);
  });
  afterEach(() => resetTestStores());

  it('Profil ist die Wahrheit; Setup folgt als Spiegel; Ausgabe nutzt das Profil', () => {
    persistAll({ ...DEFAULT_SETUP, taxStatus: 'standard_19', setupComplete: true, companyName: 'Cirmak Haustechnik GmbH' });
    hydrateCompanyProfileStore(profile());
    expect(updateCompanyProfile({ defaultTaxStatus: 'tax_free' }).success).toBe(true);
    expect(getCachedSetup().taxStatus).toBe('tax_free');
    expect(resolveDefaultTaxStatus(getCompanyProfile(), getCachedSetup())).toBe('tax_free');
    const created = addExpense({ title: 'Material', category: 'material', supplierName: 'Lieferant', issueDate: '2026-09-01', grossAmount: 100 });
    expect(created.success && created.expense.taxStatus).toBe('tax_free');
  });

  it('ohne Profilwert gilt kontrolliert der Spiegel — kein eigener Entscheidungspfad', () => {
    persistAll({ ...DEFAULT_SETUP, taxStatus: 'standard_7', setupComplete: true, companyName: 'X' });
    hydrateCompanyProfileStore({ ...profile(), defaultTaxStatus: undefined });
    expect(resolveDefaultTaxStatus(getCompanyProfile(), getCachedSetup())).toBe('standard_7');
  });
});

describe('01B — J Own-Company-Guard', () => {
  beforeEach(() => {
    resetTestStores();
    hydrateCompanyProfileStore(profile({ currency: 'EUR', replyToEmail: 'x@cirmak.example', defaultTaxStatus: 'standard_19' }));
  });
  afterEach(() => resetTestStores());
  it('Cirmak / Çırmak / Schreibweisen bleiben die eigene Firma, nie Kunde', () => {
    for (const name of ['Cirmak Haustechnik GmbH', 'Çırmak Haustechnik GmbH', 'CIRMAK HAUSTECHNIK GMBH', '  cirmak haustechnik gmbh ']) {
      expect(isOwnCompanyName(name), name).toBe(true);
    }
    expect(isOwnCompanyName('Müller Bau GmbH')).toBe(false);
    expect(pickExternalCustomerName(['Çırmak Haustechnik GmbH', 'Müller Bau GmbH'])).toBe('Müller Bau GmbH');
  });
});

describe('01B — K/L Snapshot-Grenze', () => {
  const invoice = (): VorgangInvoice => ({
    id: 'inv-1', number: '2026-0001', type: 'rechnung', positions: [], subtotal: 100, taxStatus: 'standard_19', amount: 119,
    status: 'versendet', date: '2026-08-28', issueDate: '2026-08-28', createdAt: '2026-08-28T10:00:00.000Z',
    customerSnapshot: { name: 'Kunde A', contactPerson: '', street: 'Weg 1', zip: '12345', city: 'Ort', email: 'k@a.de', phone: '' },
    companySnapshot: toInvoiceCompanySnapshot(profile({ currency: 'EUR', replyToEmail: 'alt@cirmak.example', senderDisplayName: 'Alt', defaultTaxStatus: 'standard_19' })),
    brandingSnapshot: { version: 1, primaryColor: '#123456', documentTemplate: 'classic' },
    payments: [],
  }) as VorgangInvoice;

  it('neue Felder sind nie Teil des companySnapshot; Katalog unveraendert', () => {
    const snapshot = toInvoiceCompanySnapshot(profile({ currency: 'EUR', replyToEmail: 'x@y.de', senderDisplayName: 'S', defaultTaxStatus: 'tax_free' }));
    for (const key of ['currency', 'replyToEmail', 'senderDisplayName', 'defaultTaxStatus']) expect(key in snapshot, key).toBe(false);
    expect((COMPANY_SNAPSHOT_KEYS as readonly string[]).some((k) => ['currency', 'replyToEmail', 'senderDisplayName'].includes(k))).toBe(false);
  });

  it('Profilaenderung (IBAN, Adresse, replyTo, Waehrung) veraendert Print- und Korrekturmodell einer finalisierten Rechnung nicht', () => {
    resetTestStores();
    const inv = invoice();
    const before = JSON.stringify(buildInvoicePrintModelFromInvoice(inv));
    const correctionBefore = JSON.stringify(buildInvoiceCorrectionModel(inv, { cancelledAt: '2026-09-10T00:00:00.000Z', cancelReason: 'x' }));
    hydrateCompanyProfileStore(profile({ iban: 'DE02120300000000202051', street: 'Neue Straße 99', currency: 'EUR', replyToEmail: 'neu@cirmak.example', defaultTaxStatus: 'tax_free', senderDisplayName: 'Neu Service', defaultInvoiceEmailSubject: 'Neuer Betreff', defaultInvoiceEmailBody: 'Neuer Text', logoDataUrl: '' }));
    updateCompanyProfile({ city: 'Detmold' });
    expect(JSON.stringify(buildInvoicePrintModelFromInvoice(inv))).toBe(before);
    expect(JSON.stringify(buildInvoiceCorrectionModel(inv, { cancelledAt: '2026-09-10T00:00:00.000Z', cancelReason: 'x' }))).toBe(correctionBefore);
    expect(inv.companySnapshot?.iban).toBe('DE89370400440532013000');
    expect(inv.brandingSnapshot).toEqual({ version: 1, primaryColor: '#123456', documentTemplate: 'classic' });
    resetTestStores();
  });
});
