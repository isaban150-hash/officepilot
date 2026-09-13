/**
 * SETTINGS-01B1 — Datenmodell und Persistenz der Settings-Felder.
 *
 * Kontrakt, Validator, lokale Lesesemantik, Cloud-Roundtrip, Default-Resolver
 * für Vorgangs- und manuelle Rechnung, Confirm-first, Snapshot-/Drift-Wahrheit,
 * Draft-Bestandsschutz, Print/PDF. Neutrale Beispieldaten, kein Netzwerk.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider } from '../../context/AppContext';
import { InvoiceDocumentView } from '../../components/invoice/InvoiceDocumentView';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import { DEFAULT_SETUP } from '../../data/mockData';
import { resetTestStores } from '../../test/resetStores';
import { createOrderPosition, createTestVorgang } from '../../test/fixtures';
import {
  getCompanyProfile,
  hydrateCompanyProfileStore,
  updateCompanyProfile,
} from '../companyProfileService';
import { validateCompanyProfileForSettings } from '../setupValidationService';
import {
  buildCompanyProfileCloudPayload,
  parseCompanyProfileFromCloud,
} from '../workspace/workspaceCloudService';
import {
  applyCompanyProfileSettingsContract,
  resolveProfileDocumentTemplate,
} from './companyProfileSettingsContract';
import { sanitizeBrandingProfile } from '../branding/brandingProfileContract';
import {
  buildBrandingSnapshot,
  parseBrandingSnapshotFromCloud,
} from '../branding/brandingSnapshotService';
import { resolveInvoiceDefaults } from '../invoice/invoiceDefaults';
import {
  buildInvoiceDraftForType,
  buildManualInvoiceDraft,
  finalizeInvoiceDraft,
  updateInvoiceDraftMetadata,
} from '../invoiceService';
import { hydrateVorgangStore, getVorgangInvoice, immutableInvoiceFingerprint } from '../vorgangService';
import {
  buildCriticalCompanyFingerprint,
  findCriticalCompanyProfileDrift,
} from '../invoice/companySnapshotDriftService';
import { hasValidReverseChargeConfirmation } from '../invoice/reverseChargeConfirmationService';
import { taxDecisionBlocker } from '../invoice/invoiceApprovalUx';
import { buildInvoicePrintModelFromInvoice, buildInvoicePrintModel } from '../invoicePrintModel';
import { generateApprovedInvoicePdf } from '../invoicePdfService';
import { validateWorkspaceInvoiceCloudPayload } from '../invoice/workspaceInvoiceCloudPayloadValidator';
import {
  createInvoiceDraftRecord,
  loadInvoiceDraftRecordByLocator,
  resetInvoiceDraftDurabilityDatabaseForTests,
} from '../invoice/invoiceDraftDurabilityService';
import { resetStorageScopeForTests, setActiveStorageScope } from '../storage/storageScopeService';
import type { CompanyProfile, CompanySetup, InvoiceDraft, Vorgang } from '../../types/models';
import { buildDocumentBlobScopeKey } from '../storage/documentBlobScopeService';
import { updateDraftPositionQuantity } from '../invoiceService';

const WORKSPACE = '00000000-0000-4000-8000-00000000a1b1';
const SCOPE = buildDocumentBlobScopeKey({ type: 'workspace', workspaceId: WORKSPACE });
const VORGANG_ID = 'v-s1b1';
const setupStandard: CompanySetup = { ...DEFAULT_SETUP, setupComplete: true, taxStatus: 'standard_19' };
const setupLegacy13b: CompanySetup = { ...DEFAULT_SETUP, setupComplete: true, taxStatus: 'reverse_charge_13b' };

function profile(overrides: Partial<CompanyProfile> = {}): CompanyProfile {
  return {
    ...DEFAULT_COMPANY_PROFILE,
    companyName: 'Muster GmbH',
    street: 'Musterstraße 3',
    zip: '20000',
    city: 'Musterstadt',
    contactPerson: 'M. Muster',
    email: 'info@example.invalid',
    taxNumber: '11/222/33333',
    bankName: 'Musterbank',
    iban: 'DE89370400440532013000',
    bic: 'MUSTDEFF',
    ...overrides,
  };
}

function seedVorgang(): void {
  hydrateVorgangStore([
    {
      ...createTestVorgang({
        id: VORGANG_ID,
        title: 'Dachsanierung',
        status: 'beauftragt',
        customer: 'Beispiel Projektbau GmbH',
        orderPositions: [createOrderPosition({ id: 'op-1', unit: 'm²', plannedQuantity: 10, unitPrice: 10 })],
      }),
      invoices: [],
    } as Vorgang,
  ]);
}

function billableOrderDraft(): InvoiceDraft {
  const base = buildInvoiceDraftForType(VORGANG_ID, setupStandard, 'rechnung')!;
  const withQuantity = updateDraftPositionQuantity(base, base.positions[0]!.id, 10);
  return updateInvoiceDraftMetadata(withQuantity, {
    servicePeriodFrom: '2026-09-01',
    servicePeriodTo: '2026-09-05',
    servicePeriodConfirmed: true,
  });
}

const CUSTOMER = { name: 'Beispiel Projektbau GmbH', contactPerson: '', street: 'Beispielweg 1', zip: '10000', city: 'Beispielstadt', email: '', phone: '' };

describe('SETTINGS-01B1 — Datenmodell und Persistenz', () => {
  beforeEach(() => {
    resetTestStores();
    seedVorgang();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resetTestStores();
  });

  /* ---------------- I — Normalisierung / Kontrakt ---------------- */

  it('A1: der Kontrakt trimmt Texte, verwirft Nicht-Strings und ungültige Steuerstatus — und fügt nichts hinzu', () => {
    const cleaned = applyCompanyProfileSettingsContract({
      accountHolder: '  Muster GmbH  ',
      defaultIntroText: ' Hallo ',
      defaultClosingText: 42,
      defaultTaxStatus: 'nope',
    });
    expect(cleaned).toEqual({ accountHolder: 'Muster GmbH', defaultIntroText: 'Hallo' });
    const legacy = applyCompanyProfileSettingsContract({ companyName: 'Alt GmbH' });
    expect(legacy).toEqual({ companyName: 'Alt GmbH' });
    expect(Object.keys(legacy)).not.toContain('accountHolder');
  });

  it('A2: hydrate/update lesen mit derselben Semantik; ein Altprofil bleibt ohne neue Schlüssel', () => {
    hydrateCompanyProfileStore(profile({ accountHolder: ' Konto ', defaultTaxStatus: 'tax_free' }));
    expect(getCompanyProfile().accountHolder).toBe('Konto');
    expect(getCompanyProfile().defaultTaxStatus).toBe('tax_free');

    hydrateCompanyProfileStore(profile());
    const old = getCompanyProfile();
    expect('accountHolder' in old).toBe(false);
    expect('defaultTaxStatus' in old).toBe(false);
    expect(resolveProfileDocumentTemplate(old)).toBe('classic');

    const updated = updateCompanyProfile({ defaultIntroText: '  Vielen Dank für Ihren Auftrag. ' });
    expect(updated.success && updated.profile.defaultIntroText).toBe('Vielen Dank für Ihren Auftrag.');
  });

  it('F1: documentTemplate — classic akzeptiert, Unbekanntes fail-closed verworfen, fehlend = classic', () => {
    expect(sanitizeBrandingProfile({ documentTemplate: 'classic' })).toEqual({ documentTemplate: 'classic' });
    expect(sanitizeBrandingProfile({ documentTemplate: 'modern' })).toEqual({});
    expect(buildBrandingSnapshot({})).toEqual({ version: 1 });
    expect(buildBrandingSnapshot({ documentTemplate: 'classic' })).toEqual({ version: 1, documentTemplate: 'classic' });
    expect(() => buildBrandingSnapshot({ documentTemplate: 'compact' as never })).toThrow();
    expect(parseBrandingSnapshotFromCloud({ version: 1, documentTemplate: 'classic' })).toEqual({ version: 1, documentTemplate: 'classic' });
    expect(parseBrandingSnapshotFromCloud({ version: 1, documentTemplate: 'modern' })).toBeNull();
  });

  /* ---------------- G — Validator ---------------- */

  it('G1: der Validator prüft die neuen Felder mit Längen und Mengen, ohne Bestehendes zu lockern', () => {
    const ok = validateCompanyProfileForSettings(profile({ accountHolder: 'Muster GmbH', defaultTaxStatus: 'standard_7', defaultIntroText: 'Hi', branding: { documentTemplate: 'classic' } }));
    expect(ok.valid, JSON.stringify(ok.errors)).toBe(true);

    const bad = validateCompanyProfileForSettings(profile({
      accountHolder: 'x'.repeat(121),
      defaultIntroText: 'y'.repeat(2001),
      defaultClosingText: 'z'.repeat(2001),
      defaultTaxStatus: 'weird' as never,
      branding: { documentTemplate: 'modern' as never },
    }));
    expect(bad.valid).toBe(false);
    expect(bad.errors).toMatchObject({
      accountHolder: 'companyProfile.accountHolderTooLong',
      defaultIntroText: 'companyProfile.defaultIntroTextTooLong',
      defaultClosingText: 'companyProfile.defaultClosingTextTooLong',
      defaultTaxStatus: 'companyProfile.defaultTaxStatusInvalid',
      documentTemplate: 'companyProfile.documentTemplateInvalid',
    });
    // Bestehende Regel bleibt scharf.
    expect(validateCompanyProfileForSettings(profile({ companyName: '' })).valid).toBe(false);
  });

  /* ---------------- H/N — Cloud-Roundtrip ---------------- */

  it('H1: neue Felder überleben den Cloud-Roundtrip; ein Altpayload bekommt keine neuen Schlüssel; Fremdvorlagen fallen weg', () => {
    const full = profile({ accountHolder: 'Muster GmbH', defaultTaxStatus: 'reverse_charge_13b', defaultIntroText: 'Intro', defaultClosingText: 'Schluss', branding: { documentTemplate: 'classic', primaryColor: '#112233' } });
    const payload = buildCompanyProfileCloudPayload(full);
    const cloudJson = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
    const back = parseCompanyProfileFromCloud(cloudJson)!;
    expect(back.accountHolder).toBe('Muster GmbH');
    expect(back.defaultTaxStatus).toBe('reverse_charge_13b');
    expect(back.defaultIntroText).toBe('Intro');
    expect(back.defaultClosingText).toBe('Schluss');
    expect(back.branding).toEqual({ documentTemplate: 'classic', primaryColor: '#112233' });

    const legacy = parseCompanyProfileFromCloud({ payload: { ...profile() } as unknown as Record<string, unknown> })!;
    expect('accountHolder' in legacy).toBe(false);
    expect('defaultTaxStatus' in legacy).toBe(false);

    const foreign = parseCompanyProfileFromCloud({ payload: { ...profile(), defaultTaxStatus: 'later', branding: { documentTemplate: 'modern' } } as unknown as Record<string, unknown> })!;
    expect('defaultTaxStatus' in foreign).toBe(false);
    expect(foreign.branding).toEqual({});
    expect(resolveProfileDocumentTemplate(foreign)).toBe('classic');
  });

  /* ---------------- C/D/J — Default-Resolver ---------------- */

  it('J1: resolveInvoiceDefaults — Profilstatus gewinnt, sonst Legacy-Setup; Intro/Closing; Zahlung/Skonto wie bisher', () => {
    const withDefaults = profile({ defaultTaxStatus: 'tax_free', defaultIntroText: 'Intro', defaultClosingText: 'Schluss', skontoEnabled: true, skontoPercent: 2, skontoDays: 7 });
    const d = resolveInvoiceDefaults(withDefaults, setupStandard, '2026-09-13');
    expect(d.taxStatus).toBe('tax_free');
    expect(d.introText).toBe('Intro');
    expect(d.closingText).toBe('Schluss');
    expect(d.paymentDueDate).toBe('2026-09-27');
    expect(d.paymentTermsText).toBe('Zahlbar innerhalb von 14 Tagen.');
    expect(d.skontoText).toContain('2 %');

    const legacy = resolveInvoiceDefaults(profile(), setupLegacy13b, '2026-09-13');
    expect(legacy.taxStatus).toBe('reverse_charge_13b');
    expect(legacy.introText).toBe('');
    expect(legacy.closingText).toBe('');
    expect(legacy.paymentTermsText).toBe('Zahlbar innerhalb von 14 Tagen ohne Abzug.');
  });

  it('J2: Vorgangs- und manuelle Rechnung nutzen denselben Resolver — Defaults im Draft, nicht im companySnapshot', () => {
    hydrateCompanyProfileStore(profile({ accountHolder: 'Muster GmbH', defaultTaxStatus: 'standard_7', defaultIntroText: 'Intro', defaultClosingText: 'Schluss', branding: { documentTemplate: 'classic' } }));
    const order = buildInvoiceDraftForType(VORGANG_ID, setupStandard, 'rechnung')!;
    const manual = buildManualInvoiceDraft({ billing: CUSTOMER }, setupStandard);
    for (const draft of [order, manual]) {
      expect(draft.taxStatus).toBe('standard_7');
      expect(draft.introText).toBe('Intro');
      expect(draft.closingText).toBe('Schluss');
      expect(draft.companySnapshot.accountHolder).toBe('Muster GmbH');
      expect('defaultTaxStatus' in draft.companySnapshot).toBe(false);
      expect('defaultIntroText' in draft.companySnapshot).toBe(false);
      expect('defaultClosingText' in draft.companySnapshot).toBe(false);
      expect(draft.brandingSnapshot).toEqual({ version: 1, documentTemplate: 'classic' });
    }
    // Legal notices folgen dem aufgelösten Status, nicht dem Setup.
    expect(order.legalNotices).toEqual(buildInvoiceDraftForType(VORGANG_ID, setupLegacy13b, 'rechnung')!.legalNotices);
  });

  it('C1: Legacy-Fallback — ohne Profil-Default zählt CompanySetup.taxStatus; das Profil wird nicht mutiert', () => {
    hydrateCompanyProfileStore(profile());
    const manual = buildManualInvoiceDraft({ billing: CUSTOMER }, setupLegacy13b);
    expect(manual.taxStatus).toBe('reverse_charge_13b');
    expect('defaultTaxStatus' in getCompanyProfile()).toBe(false);
    const order = buildInvoiceDraftForType(VORGANG_ID, setupStandard, 'rechnung')!;
    expect(order.taxStatus).toBe('standard_19');
    // SETTINGS-01B2 — auch ohne Profilwert wird classic explizit eingefroren.
    expect(order.brandingSnapshot).toEqual({ version: 1, documentTemplate: 'classic' });
  });

  it('A-01B2: altes Profil ohne documentTemplate → neu finalisierte Rechnung trägt explizit classic', () => {
    hydrateCompanyProfileStore(profile());
    expect('branding' in getCompanyProfile()).toBe(false);
    const result = finalizeInvoiceDraft(VORGANG_ID, billableOrderDraft(), setupStandard);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    const invoice = getVorgangInvoice(VORGANG_ID, result.invoice.id)!;
    expect(invoice.brandingSnapshot).toEqual({ version: 1, documentTemplate: 'classic' });
    // Ein älterer Entwurf ohne Vorlage im Snapshot wird bei der Finalisierung ebenfalls festgeschrieben.
    const legacyDraft = { ...billableOrderDraft(), brandingSnapshot: { version: 1 as const } };
    const legacyResult = finalizeInvoiceDraft(VORGANG_ID, legacyDraft, setupStandard);
    expect(legacyResult.ok).toBe(true);
    if (!legacyResult.ok) return;
    expect(getVorgangInvoice(VORGANG_ID, legacyResult.invoice.id)!.brandingSnapshot?.documentTemplate).toBe('classic');
  });

  it('C2: defaultTaxStatus = reverse charge bleibt Vorbelegung — die §13b-Bestätigung ist NICHT gesetzt', () => {
    hydrateCompanyProfileStore(profile({ defaultTaxStatus: 'reverse_charge_13b' }));
    setActiveStorageScope({ type: 'workspace', workspaceId: WORKSPACE });
    const draft = buildManualInvoiceDraft({ billing: CUSTOMER }, setupStandard);
    expect(draft.taxStatus).toBe('reverse_charge_13b');
    expect(hasValidReverseChargeConfirmation({ sourceScopeKey: SCOPE, workspaceId: WORKSPACE, vorgangId: null, invoiceType: 'rechnung', draftId: draft.id, draftSha256: 'x' })).toBe(false);
    expect(taxDecisionBlocker(draft.taxStatus, false)).toBe('invoice.validation.reverseChargeConfirmRequired');
    resetStorageScopeForTests();
  });

  /* ---------------- K — Draft-Bestandsschutz ---------------- */

  it('K1: ein bestehender Entwurf wird durch geänderte Defaults nicht umgeschrieben (Resume ist autoritativ)', async () => {
    setActiveStorageScope({ type: 'workspace', workspaceId: WORKSPACE });
    await resetInvoiceDraftDurabilityDatabaseForTests();
    hydrateCompanyProfileStore(profile({ defaultIntroText: 'Alt', defaultTaxStatus: 'standard_19' }));
    const draft = buildManualInvoiceDraft({ billing: CUSTOMER }, setupStandard);
    const identity = { sourceScopeKey: SCOPE, workspaceId: WORKSPACE, vorgangId: null, invoiceType: 'rechnung' as const, draftId: draft.id };
    const created = await createInvoiceDraftRecord({ identity, draft, now: '2026-09-12T10:00:00.000Z' });
    expect(created.ok).toBe(true);

    // Heute ändert der Betrieb seine Vorgaben.
    hydrateCompanyProfileStore(profile({ defaultIntroText: 'Neu', defaultTaxStatus: 'tax_free', accountHolder: 'Neuer Inhaber' }));
    const loaded = await loadInvoiceDraftRecordByLocator({ sourceScopeKey: SCOPE, workspaceId: WORKSPACE, vorgangId: null, invoiceType: 'rechnung' });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.draft.introText).toBe('Alt');
    expect(loaded.draft.taxStatus).toBe('standard_19');
    // Der Entwurf bleibt auch durch eine Metadatenänderung bei seinem Stand.
    const touched = updateInvoiceDraftMetadata(loaded.draft, { paymentTermsText: 'Sofort' });
    expect(touched.introText).toBe('Alt');
    // Ein neuer Entwurf bekommt die neuen Vorgaben.
    expect(buildManualInvoiceDraft({ billing: CUSTOMER }, setupStandard).introText).toBe('Neu');
    await resetInvoiceDraftDurabilityDatabaseForTests();
    resetStorageScopeForTests();
  });

  /* ---------------- L — Drift ---------------- */

  it('L1: Default-Änderungen erzeugen keinen Company-Drift; accountHolder ist ein kritisches Bankfeld', () => {
    const snapshot = profile({ accountHolder: 'Muster GmbH' });
    const changedDefaults = profile({ accountHolder: 'Muster GmbH', defaultTaxStatus: 'tax_free', defaultIntroText: 'x', defaultClosingText: 'y', defaultPaymentDays: 30, skontoEnabled: true, skontoPercent: 3, skontoDays: 5, defaultPaymentTerms: 'anders' });
    expect(findCriticalCompanyProfileDrift(snapshot, changedDefaults)).toEqual([]);
    expect(buildCriticalCompanyFingerprint(snapshot)).toBe(buildCriticalCompanyFingerprint(changedDefaults));
    expect(findCriticalCompanyProfileDrift(snapshot, profile({ accountHolder: 'Anderer' }))).toEqual(['accountHolder']);
    // Alter Snapshot ohne Feld vs. Profil mit leerem Feld: kein Drift.
    expect(findCriticalCompanyProfileDrift(profile(), profile({ accountHolder: '' }))).toEqual([]);
  });

  /* ---------------- Historische Wahrheit ---------------- */

  it('S1: Finalisierung friert accountHolder und Vorlage ein; spätere Profiländerung lässt die Rechnung unverändert', () => {
    hydrateCompanyProfileStore(profile({ accountHolder: 'Muster GmbH', defaultIntroText: 'Intro', branding: { documentTemplate: 'classic' } }));
    const draft = billableOrderDraft();
    const result = finalizeInvoiceDraft(VORGANG_ID, draft, setupStandard);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    const invoice = getVorgangInvoice(VORGANG_ID, result.invoice.id)!;
    expect(invoice.companySnapshot?.accountHolder).toBe('Muster GmbH');
    expect('defaultIntroText' in (invoice.companySnapshot ?? {})).toBe(false);
    expect('branding' in (invoice.companySnapshot ?? {})).toBe(false);
    expect(invoice.brandingSnapshot).toEqual({ version: 1, documentTemplate: 'classic' });
    expect(invoice.introText).toBe('Intro');
    const fingerprintBefore = immutableInvoiceFingerprint(invoice, VORGANG_ID);
    // Der Cloud-Validator akzeptiert den Snapshot mit Kontoinhaber und Vorlage.
    const { payments: _p, paymentStatus: _s, archiveDocumentId: _a, ...payload } = invoice;
    expect(validateWorkspaceInvoiceCloudPayload(JSON.parse(JSON.stringify(payload)))).toMatchObject({ ok: true });

    hydrateCompanyProfileStore(profile({ accountHolder: 'Neuer Inhaber', defaultIntroText: 'Neu', companyName: 'Umbenannt GmbH' }));
    const after = getVorgangInvoice(VORGANG_ID, result.invoice.id)!;
    expect(after.companySnapshot?.accountHolder).toBe('Muster GmbH');
    expect(after.companySnapshot?.companyName).toBe('Muster GmbH');
    expect(after.introText).toBe('Intro');
    expect(immutableInvoiceFingerprint(after, VORGANG_ID)).toBe(fingerprintBefore);
    expect(buildInvoicePrintModelFromInvoice(after).documentTemplate).toBe('classic');
  });

  /* ---------------- M — Print / PDF ---------------- */

  it('M1: Kontoinhaber erscheint nur mit Wert; ohne Wert bleibt das Markup unverändert; Vorlage classic', async () => {
    const withHolder = buildInvoicePrintModel(
      buildManualInvoiceDraft({ billing: CUSTOMER }, setupStandard),
      setupStandard,
    );
    expect(withHolder.documentTemplate).toBe('classic');
    const htmlWithout = renderToStaticMarkup(<MemoryRouter><AppProvider initialSetup={setupStandard}><InvoiceDocumentView model={withHolder} /></AppProvider></MemoryRouter>);
    expect(htmlWithout).not.toContain('Kontoinhaber');

    hydrateCompanyProfileStore(profile({ accountHolder: 'Muster Haustechnik GmbH' }));
    const model = buildInvoicePrintModel(buildManualInvoiceDraft({ billing: CUSTOMER }, setupStandard), setupStandard);
    const htmlWith = renderToStaticMarkup(<MemoryRouter><AppProvider initialSetup={setupStandard}><InvoiceDocumentView model={model} /></AppProvider></MemoryRouter>);
    expect(htmlWith).toContain('Kontoinhaber');
    expect(htmlWith).toContain('Muster Haustechnik GmbH');
    expect(htmlWith).not.toContain('Kontoinhaber: -');

    const draft = billableOrderDraft();
    const result = finalizeInvoiceDraft(VORGANG_ID, draft, setupStandard);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    const pdf = await generateApprovedInvoicePdf(getVorgangInvoice(VORGANG_ID, result.invoice.id)!);
    expect(pdf.ok, JSON.stringify(pdf)).toBe(true);
  }, 30_000);
});
