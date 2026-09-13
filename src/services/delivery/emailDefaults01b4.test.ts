/**
 * EMAIL-01B4 — Standard-E-Mail-Texte: Datenmodell/Contract/Validierung/Cloud-
 * Roundtrip, Resolver-Priorität (Workspace-Standard → i18n), Platzhalter
 * (fail-safe), Korrektur-Defaults (feste i18n-Texte, keine Rechnungs-Standards),
 * Draft-/Retry-Freeze, Snapshot-Freiheit, i18n-Parität. Kein Netz.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { de } from '../../i18n';
import { deDelivery } from '../../i18n/locales/de/delivery';
import { trDelivery } from '../../i18n/locales/tr/delivery';
import { bgDelivery } from '../../i18n/locales/bg/delivery';
import { deSettings } from '../../i18n/locales/de/settings';
import { trSettings } from '../../i18n/locales/tr/settings';
import { bgSettings } from '../../i18n/locales/bg/settings';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import { DEFAULT_SETUP } from '../../data/mockData';
import { resetTestStores } from '../../test/resetStores';
import { createOrderPosition, createTestVorgang } from '../../test/fixtures';
import * as persistence from '../persistenceService';
import { applyCompanyProfileSettingsContract, COMPANY_PROFILE_TEXT_LIMITS } from '../company/companyProfileSettingsContract';
import { getCompanyProfile, hydrateCompanyProfileStore, updateCompanyProfile } from '../companyProfileService';
import { validateCompanyProfileForSettings } from '../setupValidationService';
import { buildCompanyProfileCloudPayload, parseCompanyProfileFromCloud } from '../workspace/workspaceCloudService';
import { buildInvoiceDraftForType, buildManualInvoiceDraft, finalizeInvoiceDraft, toInvoiceCompanySnapshot, updateDraftPositionQuantity, updateInvoiceDraftMetadata } from '../invoiceService';
import { getVorgangInvoice, hydrateVorgangStore } from '../vorgangService';
import { setActiveStorageScope } from '../storage/storageScopeService';
import type { CompanyProfile, CompanySetup, Vorgang, VorgangInvoice } from '../../types/models';
import { fillDeliveryPlaceholders, resolveDeliveryBody, resolveDeliveryDraftDefaults, resolveDeliverySubject } from './documentDeliveryDefaults';
import { createSendDraft, loadSendDraft } from './sendDocumentOrchestrator';

const setup: CompanySetup = { ...DEFAULT_SETUP, setupComplete: true, taxStatus: 'standard_19' };
const BASE: CompanyProfile = { ...DEFAULT_COMPANY_PROFILE, companyName: 'Betrieb', legalForm: 'GmbH', contactPerson: 'A', street: 'W 1', zip: '1', city: 'X', email: 'info@betrieb.invalid', iban: 'DE89370400440532013000', taxNumber: '1', defaultPaymentTerms: 'Zahlbar innerhalb von 14 Tagen ohne Abzug.' };

function finalizeInvoice(id: string): VorgangInvoice {
  hydrateVorgangStore([{ ...createTestVorgang({ id, status: 'beauftragt', customerBilling: { name: 'Kunde GmbH', contactPerson: '', street: 'Weg 1', zip: '1', city: 'X', email: 'kunde@example.invalid', phone: '' }, orderPositions: [createOrderPosition({ id: 'op-1', unit: 'm²', plannedQuantity: 10, unitPrice: 10 })] }), invoices: [] } as Vorgang]);
  const base = buildInvoiceDraftForType(id, setup, 'rechnung')!;
  const draft = updateInvoiceDraftMetadata(updateDraftPositionQuantity(base, base.positions[0]!.id, 10), { servicePeriodFrom: '2026-09-01', servicePeriodTo: '2026-09-05', servicePeriodConfirmed: true });
  const result = finalizeInvoiceDraft(id, draft, setup);
  if (!result.ok) throw new Error(JSON.stringify(result));
  return getVorgangInvoice(id, result.invoice.id)!;
}

describe('EMAIL-01B4 — Settings-Datenmodell', () => {
  beforeEach(() => { resetTestStores(); hydrateCompanyProfileStore(BASE); });
  afterEach(() => resetTestStores());

  it('M1: Contract trimmt, verwirft Nicht-Strings, fügt nichts hinzu; Altprofil bleibt ohne Schlüssel', () => {
    const applied = applyCompanyProfileSettingsContract({ ...BASE, defaultInvoiceEmailSubject: '  Betreff  ', defaultInvoiceEmailBody: 42 as never });
    expect(applied.defaultInvoiceEmailSubject).toBe('Betreff');
    expect('defaultInvoiceEmailBody' in applied).toBe(false);
    expect('defaultInvoiceEmailSubject' in applyCompanyProfileSettingsContract({ ...BASE })).toBe(false);
    expect('defaultInvoiceEmailSubject' in getCompanyProfile()).toBe(false);
  });

  it('M2: Validierung — Länge und Zeilenumbruch im Betreff, Länge der Nachricht; leer erlaubt', () => {
    expect(validateCompanyProfileForSettings({ ...BASE, defaultInvoiceEmailSubject: '', defaultInvoiceEmailBody: '' }, 0).errors.defaultInvoiceEmailSubject).toBeUndefined();
    expect(validateCompanyProfileForSettings({ ...BASE, defaultInvoiceEmailSubject: 'x'.repeat(COMPANY_PROFILE_TEXT_LIMITS.defaultInvoiceEmailSubject + 1) }, 0).errors.defaultInvoiceEmailSubject).toBe('companyProfile.defaultInvoiceEmailSubjectInvalid');
    expect(validateCompanyProfileForSettings({ ...BASE, defaultInvoiceEmailSubject: 'Zeile 1\nZeile 2' }, 0).errors.defaultInvoiceEmailSubject).toBe('companyProfile.defaultInvoiceEmailSubjectInvalid');
    expect(validateCompanyProfileForSettings({ ...BASE, defaultInvoiceEmailBody: 'x'.repeat(COMPANY_PROFILE_TEXT_LIMITS.defaultInvoiceEmailBody + 1) }, 0).errors.defaultInvoiceEmailBody).toBe('companyProfile.defaultInvoiceEmailBodyTooLong');
    expect(validateCompanyProfileForSettings({ ...BASE, defaultInvoiceEmailSubject: 'Rechnung {invoiceNumber}', defaultInvoiceEmailBody: 'Hallo\n{companyName}' }, 0).valid).toBe(true);
  });

  it('M3: Persistenz + Cloud-Roundtrip; nie im Rechnungs-Snapshot', () => {
    const result = updateCompanyProfile({ defaultInvoiceEmailSubject: 'Ihre Rechnung {invoiceNumber}', defaultInvoiceEmailBody: 'Hallo {companyName}' });
    expect(result.success).toBe(true);
    const payload = buildCompanyProfileCloudPayload(getCompanyProfile());
    const inner = payload.payload as Record<string, unknown>;
    expect(inner).toMatchObject({ defaultInvoiceEmailSubject: 'Ihre Rechnung {invoiceNumber}', defaultInvoiceEmailBody: 'Hallo {companyName}' });
    const back = parseCompanyProfileFromCloud(JSON.parse(JSON.stringify(payload)) as Record<string, unknown>);
    expect(back).toMatchObject({ defaultInvoiceEmailSubject: 'Ihre Rechnung {invoiceNumber}' });
    // Altpayload ohne Felder → keine neuen Schlüssel.
    const { defaultInvoiceEmailSubject: _s, defaultInvoiceEmailBody: _b, ...legacy } = inner;
    const parsedLegacy = parseCompanyProfileFromCloud({ payload: legacy });
    expect('defaultInvoiceEmailSubject' in (parsedLegacy as Record<string, unknown>)).toBe(false);
    // Snapshot-Freiheit: Draft und finalisierte Rechnung tragen die Mailtexte nicht.
    expect('defaultInvoiceEmailSubject' in toInvoiceCompanySnapshot(getCompanyProfile())).toBe(false);
    const manual = buildManualInvoiceDraft({ billing: { name: 'K', contactPerson: '', street: '', zip: '', city: '', email: '', phone: '' } }, setup);
    expect('defaultInvoiceEmailBody' in manual.companySnapshot).toBe(false);
    const invoice = finalizeInvoice('v-m3');
    expect('defaultInvoiceEmailSubject' in (invoice.companySnapshot ?? {})).toBe(false);
  });
});

describe('EMAIL-01B4 — Resolver, Platzhalter, Korrektur', () => {
  beforeEach(() => { resetTestStores(); hydrateCompanyProfileStore(BASE); });
  afterEach(() => resetTestStores());

  it('R1: Workspace-Standard vor i18n; leer → Fallback; Platzhalter ersetzt, unbekannte bleiben wörtlich', () => {
    const invoice = finalizeInvoice('v-r1');
    const n = invoice.number;
    expect(resolveDeliverySubject(invoice, 'de', {})).toBe(`Rechnung ${n} - Betrieb GmbH`);
    expect(resolveDeliverySubject(invoice, 'de', { defaultInvoiceEmailSubject: '   ' })).toBe(`Rechnung ${n} - Betrieb GmbH`);
    expect(resolveDeliverySubject(invoice, 'de', { defaultInvoiceEmailSubject: 'Ihre Rechnung {invoiceNumber} von {companyName} {unbekannt}' })).toBe(`Ihre Rechnung ${n} von Betrieb GmbH {unbekannt}`);
    expect(resolveDeliveryBody(invoice, 'tr', { defaultInvoiceEmailBody: 'Hallo {companyName}' })).toBe('Hallo Betrieb GmbH');
    expect(fillDeliveryPlaceholders('{a} {invoiceNumber} {{companyName}}', { invoiceNumber: '1', companyName: 'B' })).toBe('{a} 1 {B}');
    expect(fillDeliveryPlaceholders('{constructor}', { invoiceNumber: '1', companyName: 'B' })).toBe('{constructor}');
    const defaults = resolveDeliveryDraftDefaults(invoice, 'de', { profile: { defaultInvoiceEmailSubject: 'S {invoiceNumber}', defaultInvoiceEmailBody: 'B' } });
    expect(defaults).toMatchObject({ subject: `S ${n}`, bodyText: 'B', recipient: { email: 'kunde@example.invalid' } });
  });

  it('R2: Korrekturbeleg — feste i18n-Texte in de/tr/bg, Rechnungs-Standards werden bewusst NICHT verwendet', () => {
    const invoice = finalizeInvoice('v-r2');
    const n = invoice.number;
    const profile = { defaultInvoiceEmailSubject: 'FALSCH {invoiceNumber}', defaultInvoiceEmailBody: 'FALSCH' };
    expect(resolveDeliverySubject(invoice, 'de', profile, 'invoice_correction')).toBe(`Rechnungskorrektur zu ${n} - Betrieb GmbH`);
    expect(resolveDeliveryBody(invoice, 'de', profile, 'invoice_correction')).toContain('Rechnungskorrektur zu unserer Rechnung');
    expect(resolveDeliverySubject(invoice, 'tr', profile, 'invoice_correction')).toContain('fatura düzeltmesi');
    expect(resolveDeliverySubject(invoice, 'bg', profile, 'invoice_correction')).toContain('Корекция');
    expect(resolveDeliveryDraftDefaults(invoice, 'de', { profile, kind: 'invoice_correction' }).bodyText).not.toContain('FALSCH');
    // Empfänger identisch zum Original (historischer Snapshot).
    expect(resolveDeliveryDraftDefaults(invoice, 'de', { kind: 'invoice_correction' }).recipient.email).toBe('kunde@example.invalid');
  });

  it('R3: Draft-Freeze — ein bestehender Entwurf wird durch spätere Settings-Änderung nicht überschrieben', () => {
    setActiveStorageScope({ type: 'workspace', workspaceId: '00000000-0000-4000-8000-00000000e1b4' });
    localStorage.clear();
    vi.spyOn(persistence, 'buildPersistedStateSnapshot').mockReturnValue({ syncClient: { serverWorkspaceId: '00000000-0000-4000-8000-00000000e1b4' } } as never);
    const invoice = finalizeInvoice('v-r3');
    updateCompanyProfile({ defaultInvoiceEmailSubject: 'Alt {invoiceNumber}' });
    const defaults = resolveDeliveryDraftDefaults(invoice, 'de', { profile: getCompanyProfile() });
    const identity = { kind: 'invoice' as const, clientInvoiceId: invoice.id };
    const draft = createSendDraft({ identity, vorgangId: 'v-r3', recipientEmail: defaults.recipient.email, subject: defaults.subject, bodyText: defaults.bodyText });
    expect(draft.subject).toBe(`Alt ${invoice.number}`);
    updateCompanyProfile({ defaultInvoiceEmailSubject: 'Neu {invoiceNumber}' });
    expect(loadSendDraft(identity)?.subject).toBe(`Alt ${invoice.number}`);
    // Ein neuer Entwurf bekommt den neuen Standard.
    expect(resolveDeliverySubject(invoice, 'de', getCompanyProfile())).toBe(`Neu ${invoice.number}`);
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('I1: i18n-Parität — neue delivery.*- und settings.invoices.email*-Schlüssel in tr/bg; keine „zugestellt"-Semantik für Korrektur', () => {
    for (const key of Object.keys(deDelivery)) {
      expect(key in trDelivery, `tr fehlt ${key}`).toBe(true);
      expect(key in bgDelivery, `bg fehlt ${key}`).toBe(true);
    }
    for (const key of Object.keys(deSettings).filter((k) => k.startsWith('settings.invoices.email') || k === 'settings.invoices.section.email')) {
      expect(key in trSettings, `tr fehlt ${key}`).toBe(true);
      expect(key in bgSettings, `bg fehlt ${key}`).toBe(true);
    }
    expect((de as Record<string, string>)['delivery.kind.invoice_correction']).toBe('Korrekturbeleg');
    expect((de as Record<string, string>)['companyProfile.defaultInvoiceEmailSubjectInvalid']).toContain('255');
  });
});
