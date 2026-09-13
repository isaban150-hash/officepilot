/**
 * SETTINGS-01B4 — Rechnungen & Zahlungen (`/einstellungen/rechnungen`).
 *
 * Routing, Laden/Speichern/Dirty/Resume, Zahlungsziel, Zahlungstext (eigener
 * Text wird nie still ersetzt), Skonto samt Zahlungsabgleich, Steuerstatus
 * (Profil > Setup, kein Backfill, §13b bleibt unbestätigt), Standardtexte in
 * manueller und Vorgangsrechnung, Bestandsschutz für Entwurf und finalisierte
 * Rechnung, kein Drift, Vorschau ohne Nebenwirkungen. Synthetische Daten.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider } from '../../context/AppContext';
import { AuthProvider } from '../../context/AuthContext';
import { AppShell } from '../../components/layout/AppShell';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import { DEFAULT_SETUP } from '../../data/mockData';
import { EinstellungenPage } from '../EinstellungenPage';
import { CompanySettingsPage } from './CompanySettingsPage';
import { DesignSettingsPage } from './DesignSettingsPage';
import { FirmendatenLegacyRoute } from './FirmendatenLegacyRoute';
import {
  INVOICE_SETTINGS_ROUTE,
  InvoiceSettingsPage,
  buildInvoiceSettingsPayload,
  pickInvoiceSettings,
} from './InvoiceSettingsPage';
import { loginAsDefaultAdmin, resetAuthForTests } from '../../test/authFixtures';
import { resetTestStores } from '../../test/resetStores';
import { createOrderPosition, createTestVorgang } from '../../test/fixtures';
import * as supabaseLib from '../../lib/supabase';
import * as companyProfileService from '../../services/companyProfileService';
import { getCompanyProfile, hydrateCompanyProfileStore } from '../../services/companyProfileService';
import { hydrateWorkspaceStore } from '../../services/workspace/workspaceStore';
import { resetStorageScopeForTests, setActiveStorageScope } from '../../services/storage/storageScopeService';
import { captureAndPersistUiSession } from '../../services/uiSession/uiSessionCapture';
import { resetUiSessionLiveState, setPendingUiSessionApply } from '../../services/uiSession/uiSessionLiveState';
import { clearUiSessionSnapshot, loadUiSessionSnapshot } from '../../services/uiSession/uiSessionStore';
import { decideUiSessionRestore } from '../../services/uiSession/uiSessionRestore';
import {
  buildInvoiceDraftForType,
  buildManualInvoiceDraft,
  finalizeInvoiceDraft,
  reconcilePaymentTermsWithSkonto,
  updateDraftPositionQuantity,
  updateInvoiceDraftMetadata,
} from '../../services/invoiceService';
import {
  buildDefaultPaymentTerms,
  isStandardPaymentTerms,
  reconcilePaymentTermsWithDays,
  resolveInvoiceDefaults,
  standardPaymentTerms,
} from '../../services/invoice/invoiceDefaults';
import { buildSkontoText, parseSkontoFromText } from '../../services/invoiceTaxService';
import { getOpenAmount, recordPayment } from '../../services/invoicePaymentService';
import { hasValidReverseChargeConfirmation } from '../../services/invoice/reverseChargeConfirmationService';
import { taxDecisionBlocker } from '../../services/invoice/invoiceApprovalUx';
import { findCriticalCompanyProfileDrift } from '../../services/invoice/companySnapshotDriftService';
import { getInvoiceNumberSequenceSnapshot, getNextInvoiceNumberPreview } from '../../services/invoiceNumberService';
import { getVorgangInvoice, getVorgangStoreSnapshot, hydrateVorgangStore, immutableInvoiceFingerprint } from '../../services/vorgangService';
import { buildDocumentBlobScopeKey } from '../../services/storage/documentBlobScopeService';
import type { CompanyProfile, CompanySetup, Vorgang } from '../../types/models';

const ADMIN_USER_ID = 'usr-admin';
const WORKSPACE_ID = '00000000-0000-4000-8000-00000000b4b4';
const SCOPE = buildDocumentBlobScopeKey({ type: 'workspace', workspaceId: WORKSPACE_ID });
const ROUTE = INVOICE_SETTINGS_ROUTE;
const setup: CompanySetup = { ...DEFAULT_SETUP, setupComplete: true, taxStatus: 'standard_19' };
const CUSTOMER = { name: 'Beispiel Projektbau GmbH', contactPerson: '', street: 'Beispielweg 1', zip: '10000', city: 'Beispielstadt', email: '', phone: '' };

const SAVED: CompanyProfile = {
  ...DEFAULT_COMPANY_PROFILE,
  companyName: 'Bestand GmbH',
  contactPerson: 'A. Beispiel',
  street: 'Werkstraße 2',
  zip: '54321',
  city: 'Betriebsstadt',
  email: 'info@example.invalid',
  taxNumber: '143/123/45678',
  iban: 'DE89370400440532013000',
  defaultPaymentDays: 14,
  defaultPaymentTerms: 'Zahlbar innerhalb von 14 Tagen ohne Abzug.',
  skontoEnabled: false,
  skontoPercent: 0,
  skontoDays: 0,
};

function seedWorkspace(role: 'owner' | 'admin' | 'member'): void {
  hydrateWorkspaceStore({
    workspace: { id: WORKSPACE_ID, name: 'Beispielbetrieb', ownerUserId: 'usr-owner', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', version: 1 },
    workspaceMembers: [{ workspaceId: WORKSPACE_ID, userId: ADMIN_USER_ID, role, status: 'active', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
  });
}

function seedVorgaenge(ids: string[]): void {
  hydrateVorgangStore(ids.map((id) => ({ ...createTestVorgang({ id, status: 'beauftragt', orderPositions: [createOrderPosition({ id: 'op-1', unit: 'm²', plannedQuantity: 10, unitPrice: 10 })] }), invoices: [] }) as Vorgang));
}

function orderDraft(id: string) {
  const base = buildInvoiceDraftForType(id, setup, 'rechnung')!;
  return updateInvoiceDraftMetadata(updateDraftPositionQuantity(base, base.positions[0]!.id, 10), { servicePeriodFrom: '2026-09-01', servicePeriodTo: '2026-09-05', servicePeriodConfirmed: true });
}

let root: Root;
let host: HTMLDivElement;

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location" data-path={location.pathname} />;
}

function routes(): ReactNode {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/" element={<div data-testid="home-stub" />} />
        <Route path="/einstellungen" element={<EinstellungenPage />} />
        <Route path="/einstellungen/firma" element={<CompanySettingsPage />} />
        <Route path="/einstellungen/design" element={<DesignSettingsPage />} />
        <Route path={ROUTE} element={<InvoiceSettingsPage />} />
        <Route path="/firmendaten" element={<FirmendatenLegacyRoute />} />
        <Route path="/einstellungen/betrieb" element={<div data-testid="operating-settings-stub" />} />
      </Route>
    </Routes>
  );
}

async function settle(): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
  }
}

async function renderAt(entry: string): Promise<void> {
  host = document.createElement('div');
  host.className = 'app-shell__main';
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[entry]}>
        <AuthProvider>
          <AppProvider initialSetup={setup}>
            {routes()}
            <LocationProbe />
          </AppProvider>
        </AuthProvider>
      </MemoryRouter>,
    );
  });
  await settle();
}

async function unmount(): Promise<void> {
  if (root) await act(async () => root.unmount());
  host?.remove();
}

async function remount(): Promise<void> {
  await unmount();
  const decision = decideUiSessionRestore({ userId: null, currentPathname: ROUTE, currentSearch: '' });
  if (decision.intent === 'silent' && decision.snapshot) setPendingUiSessionApply(decision.snapshot);
  await renderAt(ROUTE);
}

function q(id: string): HTMLElement | null {
  return host.querySelector(`[data-testid="${id}"]`);
}
function field(name: string): HTMLInputElement {
  return q(`settings-invoices-${name}`) as HTMLInputElement;
}
async function type(name: string, value: string): Promise<void> {
  const el = field(name);
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function select(name: string, value: string): Promise<void> {
  const el = field(name) as unknown as HTMLSelectElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}
async function toggleSkonto(): Promise<void> {
  const el = field('skontoEnabled');
  await act(async () => {
    el.click();
  });
}
async function submit(): Promise<void> {
  const form = host.querySelector('form.settings-form') as HTMLFormElement;
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await settle();
}
function pathNow(): string {
  return q('location')?.getAttribute('data-path') ?? '';
}
function saveButton(): HTMLButtonElement {
  return q('settings-invoices-save') as HTMLButtonElement;
}

describe('SETTINGS-01B4 — Rechnungen & Zahlungen', () => {
  beforeEach(async () => {
    resetTestStores();
    resetAuthForTests();
    localStorage.clear();
    setActiveStorageScope({ type: 'guest' });
    resetUiSessionLiveState();
    clearUiSessionSnapshot();
    hydrateCompanyProfileStore(SAVED);
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(false);
    await loginAsDefaultAdmin();
  });

  afterEach(async () => {
    await unmount();
    document.body.innerHTML = '';
    clearUiSessionSnapshot();
    resetUiSessionLiveState();
    vi.restoreAllMocks();
    resetStorageScopeForTests();
    resetTestStores();
  });

  /* ---------------- Routing (1–5) ---------------- */

  it('T1–T5: Hub-Eintrag, kanonische Route, Legacy-Hashes → neue Seite ohne Loop, #datensicherung → Betrieb', async () => {
    await renderAt('/einstellungen');
    expect(q('settings-entry-invoices')?.getAttribute('href')).toBe(ROUTE);
    expect(q('settings-group-documents')?.textContent).toContain('Rechnungen & Zahlungen');
    expect(q('settings-entry-payment-terms')).toBeNull();
    expect(q('settings-entry-invoice-texts')).toBeNull();
    await unmount();

    await renderAt(ROUTE);
    expect(q('settings-invoices-page')).not.toBeNull();
    for (const section of ['payment', 'skonto', 'tax', 'texts']) {
      expect(q(`settings-invoices-section-${section}`), section).not.toBeNull();
    }
    expect(q('settings-invoices-back')?.getAttribute('href')).toBe('/einstellungen');
    await unmount();

    for (const hash of ['zahlungsbedingungen', 'rechnungstexte']) {
      await renderAt(`/firmendaten#${hash}`);
      expect(pathNow(), hash).toBe(ROUTE);
      expect(q('settings-invoices-page')).not.toBeNull();
      await settle();
      expect(pathNow(), `${hash} loop`).toBe(ROUTE);
      await unmount();
    }

    // SETTINGS-01B5 — die alte Seite existiert nicht mehr; keine zweiten Rechnungsdefaults irgendwo.
    await renderAt('/firmendaten#datensicherung');
    expect(pathNow()).toBe('/einstellungen/betrieb');
    expect(host.querySelector('#profile-payment-days')).toBeNull();
    expect(host.querySelector('[name="defaultPaymentTerms"]')).toBeNull();
  });

  /* ---------------- Laden / Speichern / Dirty / Resume (6–12) ---------------- */

  it('T6–T9: vorhandene Werte, Dirty, Speichern mit genau einem Profil-Update, danach sauber', async () => {
    const updateSpy = vi.spyOn(companyProfileService, 'updateCompanyProfile');
    await renderAt(ROUTE);
    expect(field('defaultPaymentDays').value).toBe('14');
    expect(field('defaultPaymentTerms').value).toBe('Zahlbar innerhalb von 14 Tagen ohne Abzug.');
    expect(field('skontoEnabled').checked).toBe(false);
    expect(field('skontoPercent').disabled).toBe(true);
    expect(field('defaultTaxStatus').value).toBe('standard_19');
    expect(saveButton().disabled).toBe(true);
    expect(q('settings-invoices-dirty')?.textContent).toBe('Keine Änderungen');

    await type('defaultIntroText', 'Vielen Dank für Ihren Auftrag.');
    expect(q('settings-invoices-dirty')?.textContent).toBe('Ungespeicherte Änderungen');
    expect(saveButton().disabled).toBe(false);

    await submit();
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect(getCompanyProfile().defaultIntroText).toBe('Vielen Dank für Ihren Auftrag.');
    expect(getCompanyProfile().companyName).toBe('Bestand GmbH');
    expect(saveButton().disabled).toBe(true);
    expect(host.textContent).toContain('Rechnungseinstellungen gespeichert.');
  });

  it('T10/T11: Entwurf überlebt den Neuaufbau (eigener Namensraum); Speichern entfernt ihn', async () => {
    await renderAt(ROUTE);
    await type('defaultClosingText', 'Mit freundlichen Grüßen');
    await type('defaultPaymentDays', '21');
    await toggleSkonto();
    await type('skontoPercent', '2');
    await type('skontoDays', '7');
    captureAndPersistUiSession({ pathname: ROUTE, search: '', hash: '', historyKey: 'k1', mainScrollTop: 0, userId: null, source: 'auto' });
    const snapshot = loadUiSessionSnapshot();
    expect(snapshot?.drafts.dirty).toBe(true);
    expect(JSON.stringify(snapshot)).toContain('invoiceSettings');

    await remount();
    expect(field('defaultClosingText').value).toBe('Mit freundlichen Grüßen');
    expect(field('defaultPaymentDays').value).toBe('21');
    // Auch der Schalter (boolean) und die Zahlen kommen zurück.
    expect(field('skontoEnabled').checked).toBe(true);
    expect(field('skontoPercent').value).toBe('2');
    expect(field('skontoDays').value).toBe('7');
    expect(getCompanyProfile().defaultPaymentDays).toBe(14);

    await submit();
    expect(getCompanyProfile().defaultPaymentDays).toBe(21);
    expect(getCompanyProfile().skontoEnabled).toBe(true);
    expect(getCompanyProfile().defaultClosingText).toBe('Mit freundlichen Grüßen');
    captureAndPersistUiSession({ pathname: ROUTE, search: '', hash: '', historyKey: 'k2', mainScrollTop: 0, userId: null, source: 'auto' });
    expect(loadUiSessionSnapshot()?.drafts.dirty ?? false).toBe(false);
  });

  it('T12: member sieht die Werte nur lesend, ohne Speichern', async () => {
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
    seedWorkspace('member');
    await renderAt(ROUTE);
    expect(q('settings-invoices-readonly')?.textContent).toContain('Nur Administratoren');
    expect(q('settings-invoices-save')).toBeNull();
    expect(field('defaultPaymentDays').disabled).toBe(true);
    expect(field('defaultPaymentDays').value).toBe('14');
    expect(field('defaultIntroText').readOnly).toBe(true);
    expect(q('settings-invoices-paymentTerms-reset')).toBeNull();
    expect(q('settings-invoices-preview')).not.toBeNull();
    await unmount();

    seedWorkspace('admin');
    await renderAt(ROUTE);
    expect(q('settings-invoices-readonly')).toBeNull();
    expect(q('settings-invoices-save')).not.toBeNull();
    expect(field('defaultPaymentDays').disabled).toBe(false);
  });

  /* ---------------- Zahlungsziel (13–15) ---------------- */

  it('T13–T15: 14 Tage → konkretes Fälligkeitsdatum; Standardsatz folgt der Tageszahl; Skontofrist über Zahlungsziel blockiert', async () => {
    await renderAt(ROUTE);
    expect(resolveInvoiceDefaults(getCompanyProfile(), setup, '2026-09-13').paymentDueDate).toBe('2026-09-27');
    expect(q('settings-invoices-preview-due')?.textContent).toContain('14 Tage');

    await type('defaultPaymentDays', '30');
    expect(field('defaultPaymentTerms').value).toBe('Zahlbar innerhalb von 30 Tagen ohne Abzug.');
    expect(q('settings-invoices-preview-due')?.textContent).toContain('30 Tage');
    await submit();
    expect(getCompanyProfile().defaultPaymentDays).toBe(30);
    expect(resolveInvoiceDefaults(getCompanyProfile(), setup, '2026-09-13').paymentDueDate).toBe('2026-10-13');
    const manual = buildManualInvoiceDraft({ billing: CUSTOMER }, setup);
    expect(manual.paymentDueDate).toBe(resolveInvoiceDefaults(getCompanyProfile(), setup, manual.issueDate).paymentDueDate);

    // Ungültig: Skontofrist länger als Zahlungsziel → Fehler am Feld, nichts gespeichert.
    const updateSpy = vi.spyOn(companyProfileService, 'updateCompanyProfile');
    await toggleSkonto();
    await type('skontoPercent', '2');
    await type('skontoDays', '45');
    await submit();
    expect(updateSpy).not.toHaveBeenCalled();
    expect(q('settings-invoices-skontoDays-error')?.textContent).toBeTruthy();
    expect(getCompanyProfile().skontoEnabled).toBe(false);
  });

  /* ---------------- Zahlungstext (16–18) ---------------- */

  it('T16–T18: Standardsatz ohne eigenen Text; eigener Text gewinnt und wird durch Skonto/Zahlungsziel nicht still ersetzt', async () => {
    expect(isStandardPaymentTerms('Zahlbar innerhalb von 14 Tagen ohne Abzug.', 14)).toBe(true);
    expect(isStandardPaymentTerms('Bitte überweisen Sie zeitnah.', 14)).toBe(false);
    expect(reconcilePaymentTermsWithDays('Bitte überweisen Sie zeitnah.', 14, 30)).toBe('Bitte überweisen Sie zeitnah.');
    expect(reconcilePaymentTermsWithDays(standardPaymentTerms(14, false), 14, 30)).toBe(standardPaymentTerms(30, false));

    await renderAt(ROUTE);
    expect(q('settings-invoices-paymentTerms-hint')?.textContent).toContain('Standardsatz');
    expect(q('settings-invoices-paymentTerms-reset')).toBeNull();

    // Skonto an → Standardsatz verliert „ohne Abzug" (Resolver-Regel, in der Vorschau sichtbar).
    await toggleSkonto();
    await type('skontoPercent', '2');
    await type('skontoDays', '7');
    expect(q('settings-invoices-preview-terms')?.textContent).toBe('Zahlbar innerhalb von 14 Tagen.');

    // Eigener Text: bleibt bei Skonto aus/an und Zahlungsziel-Wechsel wortgleich.
    await type('defaultPaymentTerms', 'Bitte überweisen Sie zeitnah.');
    expect(q('settings-invoices-paymentTerms-hint')?.textContent).toContain('Eigener Text');
    expect(q('settings-invoices-paymentTerms-reset')).not.toBeNull();
    await toggleSkonto();
    await type('defaultPaymentDays', '10');
    expect(field('defaultPaymentTerms').value).toBe('Bitte überweisen Sie zeitnah.');
    expect(q('settings-invoices-preview-terms')?.textContent).toBe('Bitte überweisen Sie zeitnah.');
    await submit();
    expect(getCompanyProfile().defaultPaymentTerms).toBe('Bitte überweisen Sie zeitnah.');
    expect(buildManualInvoiceDraft({ billing: CUSTOMER }, setup).paymentTermsText).toBe('Bitte überweisen Sie zeitnah.');
    expect(reconcilePaymentTermsWithSkonto('Bitte überweisen Sie zeitnah.', 'Skonto', 10)).toBe('Bitte überweisen Sie zeitnah.');

    // Zurück zum Standardsatz per Knopf — kein Tippen nötig.
    await act(async () => (q('settings-invoices-paymentTerms-reset') as HTMLButtonElement).click());
    expect(field('defaultPaymentTerms').value).toBe('Zahlbar innerhalb von 10 Tagen ohne Abzug.');
    await submit();
    expect(buildDefaultPaymentTerms(getCompanyProfile())).toBe('Zahlbar innerhalb von 10 Tagen ohne Abzug.');
  });

  /* ---------------- Skonto (19–24) ---------------- */

  it('T19–T23: Skonto aus/an, Prozent, Tage, generierter Satz aus buildSkontoText — neue Rechnung erhält ihn', async () => {
    await renderAt(ROUTE);
    expect(q('settings-invoices-skonto-sentence')?.textContent).toContain('keinen Skonto-Satz');
    expect(field('skontoDays').disabled).toBe(true);
    expect(buildManualInvoiceDraft({ billing: CUSTOMER }, setup).skontoText).toBe('');

    await toggleSkonto();
    expect(field('skontoPercent').disabled).toBe(false);
    expect(q('settings-invoices-skonto-sentence')?.textContent).toContain('Prozent und Frist');
    await type('skontoPercent', '2');
    await type('skontoDays', '7');
    const expected = buildSkontoText({ ...SAVED, skontoEnabled: true, skontoPercent: 2, skontoDays: 7 });
    expect(expected).toContain('2 %');
    expect(q('settings-invoices-skonto-sentence')?.textContent).toBe(expected);
    expect(q('settings-invoices-preview-skonto')?.textContent).toBe(expected);

    await submit();
    const profile = getCompanyProfile();
    expect(profile).toMatchObject({ skontoEnabled: true, skontoPercent: 2, skontoDays: 7, defaultSkonto: expected });
    // Der gespeicherte Standardsatz bleibt wortgleich; der Resolver leitet daraus den Satz ohne „ohne Abzug" ab.
    expect(profile.defaultPaymentTerms).toBe('Zahlbar innerhalb von 14 Tagen ohne Abzug.');
    expect(buildDefaultPaymentTerms(profile)).toBe('Zahlbar innerhalb von 14 Tagen.');
    const manual = buildManualInvoiceDraft({ billing: CUSTOMER }, setup);
    expect(manual.paymentTermsText).toBe('Zahlbar innerhalb von 14 Tagen.');
    expect(manual.skontoText).toBe(expected);
    expect(parseSkontoFromText(manual.skontoText ?? '')).toEqual({ percent: 2, days: 7 });
    seedVorgaenge(['v-sk']);
    expect(buildInvoiceDraftForType('v-sk', setup, 'rechnung')!.skontoText).toBe(expected);

    // Aus: Werte bleiben erhalten, kein Satz mehr.
    await toggleSkonto();
    expect(field('skontoPercent').value).toBe('2');
    expect(field('skontoPercent').disabled).toBe(true);
    await submit();
    expect(getCompanyProfile()).toMatchObject({ skontoEnabled: false, skontoPercent: 2, skontoDays: 7, defaultSkonto: '' });
    expect(buildManualInvoiceDraft({ billing: CUSTOMER }, setup).skontoText).toBe('');
    expect(buildManualInvoiceDraft({ billing: CUSTOMER }, setup).paymentTermsText).toBe('Zahlbar innerhalb von 14 Tagen ohne Abzug.');

    // Ungültig: Prozent 0 bei aktivem Skonto blockiert.
    const updateSpy = vi.spyOn(companyProfileService, 'updateCompanyProfile');
    await toggleSkonto();
    await type('skontoPercent', '0');
    await submit();
    expect(updateSpy).not.toHaveBeenCalled();
    expect(q('settings-invoices-skontoPercent-error')?.textContent).toBeTruthy();
  });

  it('T24: Zahlungsabgleich — fristgerechte Zahlung des Skontobetrags gleicht die neue Rechnung aus', async () => {
    hydrateCompanyProfileStore({ ...SAVED, skontoEnabled: true, skontoPercent: 2, skontoDays: 7, defaultSkonto: buildSkontoText({ ...SAVED, skontoEnabled: true, skontoPercent: 2, skontoDays: 7 }) });
    seedVorgaenge(['v-pay']);
    const draft = orderDraft('v-pay');
    expect(parseSkontoFromText(draft.skontoText ?? '')).toEqual({ percent: 2, days: 7 });
    const result = finalizeInvoiceDraft('v-pay', draft, setup);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const invoice = getVorgangInvoice('v-pay', result.invoice.id)!;
    const reduced = Math.round(invoice.amount * 0.98 * 100) / 100;
    const paid = recordPayment('v-pay', invoice.id, { amount: reduced, date: invoice.issueDate ?? invoice.date }, { confirmUnsent: true });
    expect(paid.success, JSON.stringify(paid)).toBe(true);
    const settled = getVorgangInvoice('v-pay', invoice.id)!;
    expect(settled.amount).toBe(invoice.amount);
    expect(getOpenAmount(settled)).toBe(0);
    // Ohne Skonto-Satz wäre dieselbe Zahlung eine Unterzahlung.
    expect(getOpenAmount({ ...settled, skontoText: '' })).toBeGreaterThan(0);
  });

  /* ---------------- Steuerstatus (25–28) ---------------- */

  it('T25–T28: Profil-Default gewinnt; Legacy-Fallback aus Setup; kein Backfill beim Öffnen; §13b bleibt unbestätigt', async () => {
    const updateSpy = vi.spyOn(companyProfileService, 'updateCompanyProfile');
    const setup13b: CompanySetup = { ...setup, taxStatus: 'reverse_charge_13b' };
    // Legacy: Profil ohne defaultTaxStatus → Setup-Wert, Seite zeigt ihn, mutiert nichts.
    await renderAt(ROUTE);
    expect('defaultTaxStatus' in getCompanyProfile()).toBe(false);
    expect(field('defaultTaxStatus').value).toBe('standard_19');
    expect(q('settings-invoices-tax-fallback')).not.toBeNull();
    expect(buildManualInvoiceDraft({ billing: CUSTOMER }, setup13b).taxStatus).toBe('reverse_charge_13b');
    // Speichern eines anderen Feldes → immer noch kein Backfill.
    await type('defaultIntroText', 'x');
    await submit();
    expect(updateSpy).toHaveBeenCalledTimes(1);
    expect('defaultTaxStatus' in getCompanyProfile()).toBe(false);
    expect(q('settings-invoices-tax-fallback')).not.toBeNull();

    // Ausdrückliche Wahl → gespeichert, gewinnt über Setup.
    await select('defaultTaxStatus', 'reverse_charge_13b');
    expect(q('settings-invoices-tax-13b-hint')).not.toBeNull();
    expect(q('settings-invoices-preview-tax')?.textContent).toContain('§13b');
    await submit();
    expect(getCompanyProfile().defaultTaxStatus).toBe('reverse_charge_13b');
    expect(q('settings-invoices-tax-fallback')).toBeNull();
    expect(buildManualInvoiceDraft({ billing: CUSTOMER }, setup).taxStatus).toBe('reverse_charge_13b');

    // Confirm-first: der Default setzt die §13b-Bestätigung nicht.
    setActiveStorageScope({ type: 'workspace', workspaceId: WORKSPACE_ID });
    const manual = buildManualInvoiceDraft({ billing: CUSTOMER }, setup);
    expect(hasValidReverseChargeConfirmation({ sourceScopeKey: SCOPE, workspaceId: WORKSPACE_ID, vorgangId: null, invoiceType: 'rechnung', draftId: manual.id, draftSha256: 'x' })).toBe(false);
    expect(taxDecisionBlocker(manual.taxStatus, false)).toBe('invoice.validation.reverseChargeConfirmRequired');
    seedVorgaenge(['v-13b']);
    const order = buildInvoiceDraftForType('v-13b', setup, 'rechnung')!;
    expect(order.taxStatus).toBe('reverse_charge_13b');
    expect(taxDecisionBlocker(order.taxStatus, false)).toBe('invoice.validation.reverseChargeConfirmRequired');
  });

  /* ---------------- Texte (29–33) ---------------- */

  it('T29–T33: Intro/Closing landen in manueller und Vorgangsrechnung; ein bestehender Entwurf bleibt unverändert', async () => {
    seedVorgaenge(['v-txt']);
    const before = orderDraft('v-txt');
    expect(before.introText).toBe('');
    const manualBefore = buildManualInvoiceDraft({ billing: CUSTOMER }, setup);

    await renderAt(ROUTE);
    await type('defaultIntroText', 'Einleitung neu');
    await type('defaultClosingText', 'Schluss neu');
    await type('invoiceFooterNotes', 'Fußzeile neu');
    expect(q('settings-invoices-preview-intro')?.textContent).toBe('Einleitung neu');
    expect(q('settings-invoices-preview-closing')?.textContent).toBe('Schluss neu');
    await submit();
    expect(getCompanyProfile()).toMatchObject({ defaultIntroText: 'Einleitung neu', defaultClosingText: 'Schluss neu', invoiceFooterNotes: 'Fußzeile neu' });

    const manual = buildManualInvoiceDraft({ billing: CUSTOMER }, setup);
    const order = buildInvoiceDraftForType('v-txt', setup, 'rechnung')!;
    for (const draft of [manual, order]) {
      expect(draft.introText).toBe('Einleitung neu');
      expect(draft.closingText).toBe('Schluss neu');
    }
    // Bestehende Entwürfe tragen weiter ihre alten Werte.
    expect(before.introText).toBe('');
    expect(manualBefore.introText).toBe('');
    expect(updateInvoiceDraftMetadata(before, { paymentTermsText: 'Sofort' }).introText).toBe('');
    // Pro Rechnung editierbar.
    expect(updateInvoiceDraftMetadata(manual, { introText: 'Individuell' }).introText).toBe('Individuell');
  });

  /* ---------------- Historische Wahrheit (34–35) ---------------- */

  it('T34/T35: finalisierte Rechnung und Snapshots bleiben unverändert; keine Drift durch Default-Änderungen', async () => {
    seedVorgaenge(['v-hist']);
    const result = finalizeInvoiceDraft('v-hist', orderDraft('v-hist'), setup);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const before = getVorgangInvoice('v-hist', result.invoice.id)!;
    const fingerprint = immutableInvoiceFingerprint(before, 'v-hist');
    const snapshotBefore = JSON.stringify({ c: before.companySnapshot, b: before.brandingSnapshot });

    await renderAt(ROUTE);
    await type('defaultPaymentDays', '30');
    await toggleSkonto();
    await type('skontoPercent', '3');
    await type('skontoDays', '5');
    await select('defaultTaxStatus', 'tax_free');
    await type('defaultIntroText', 'Neu');
    await type('defaultClosingText', 'Neu');
    await type('defaultPaymentTerms', 'Anders');
    await submit();
    expect(getCompanyProfile().defaultPaymentDays).toBe(30);

    const after = getVorgangInvoice('v-hist', result.invoice.id)!;
    expect(immutableInvoiceFingerprint(after, 'v-hist')).toBe(fingerprint);
    expect(JSON.stringify({ c: after.companySnapshot, b: after.brandingSnapshot })).toBe(snapshotBefore);
    expect(after.paymentTermsText).toBe('Zahlbar innerhalb von 14 Tagen ohne Abzug.');
    expect(after.skontoText ?? '').toBe('');
    expect(after.taxStatus).toBe('standard_19');
    expect(findCriticalCompanyProfileDrift(after.companySnapshot!, getCompanyProfile())).toEqual([]);
  });

  /* ---------------- Vorschau (36–37) ---------------- */

  it('T36/T37: die Vorschau persistiert nichts und reserviert keine Nummer', async () => {
    const updateSpy = vi.spyOn(companyProfileService, 'updateCompanyProfile');
    const sequence = JSON.stringify(getInvoiceNumberSequenceSnapshot());
    const next = getNextInvoiceNumberPreview();
    const vorgaenge = JSON.stringify(getVorgangStoreSnapshot());
    const storageWrites = vi.spyOn(Storage.prototype, 'setItem');
    await renderAt(ROUTE);
    await type('defaultPaymentDays', '20');
    await toggleSkonto();
    await type('skontoPercent', '2');
    await type('skontoDays', '7');
    expect(q('settings-invoices-preview-due')?.textContent).toContain('20 Tage');
    expect(q('settings-invoices-preview-skonto')?.textContent).toContain('2 %');
    expect(updateSpy).not.toHaveBeenCalled();
    expect(JSON.stringify(getInvoiceNumberSequenceSnapshot())).toBe(sequence);
    expect(getNextInvoiceNumberPreview()).toBe(next);
    expect(JSON.stringify(getVorgangStoreSnapshot())).toBe(vorgaenge);
    // Nur UI-Sitzung/Resume darf schreiben — kein Profil, kein Vorgang.
    for (const call of storageWrites.mock.calls) {
      expect(String(call[0])).not.toMatch(/company|vorgang|invoice/i);
    }
    // Payload-Helfer: kein Backfill von defaultTaxStatus ohne Wahl.
    expect('defaultTaxStatus' in buildInvoiceSettingsPayload(pickInvoiceSettings(SAVED))).toBe(false);
  });
});
