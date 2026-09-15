/**
 * PRODUCT-BASIS-FIRMENPROFIL-01D — E-Mail & Kommunikation, Waehrung, Hub.
 *
 *  A  Hub: sechs Bereiche in Produktreihenfolge, Kommunikation verlinkt
 *  B  Owner aendert Anzeigename/Reply-To/Standardtexte -> Profil
 *  C  Member: readonly, kein Speichern-Button, Felder readOnly
 *  D  Reply-To leer -> Fallback Firmen-E-Mail sichtbar und im Resolver wirksam
 *  E  Anzeigename leer -> Ableitung „Firmenname Rechtsform“ sichtbar
 *  F  ungueltige Eingabe -> Fehler, Profil unveraendert
 *  G/H Waehrung EUR auf der Rechnungsseite; currency_ambiguous sichtbar
 *  L  technischer From nur als nicht aenderbar dargestellt (kein Eingabefeld)
 *  N  ungespeicherter Entwurf wird nach Navigation wiederhergestellt (Resume)
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider } from '../../context/AppContext';
import { AuthProvider } from '../../context/AuthContext';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import { DEFAULT_SETUP } from '../../data/mockData';
import { resetTestStores } from '../../test/resetStores';
import { loginAsDefaultAdmin, resetAuthForTests } from '../../test/authFixtures';
import * as supabaseLib from '../../lib/supabase';
import { getCompanyProfile, hydrateCompanyProfileStore } from '../../services/companyProfileService';
import { hydrateExpenseStore } from '../../services/expenseStore';
import { hydrateWorkspaceStore } from '../../services/workspace/workspaceStore';
import { resolveProfileReplyToEmail, resolveProfileSenderDisplayName } from '../../services/company/companyProfileSettingsContract';
import { CommunicationSettingsPage } from './CommunicationSettingsPage';
import { captureAndPersistUiSession } from '../../services/uiSession/uiSessionCapture';
import { resetUiSessionLiveState, setPendingUiSessionApply } from '../../services/uiSession/uiSessionLiveState';
import { clearUiSessionSnapshot } from '../../services/uiSession/uiSessionStore';
import { decideUiSessionRestore } from '../../services/uiSession/uiSessionRestore';
import { InvoiceSettingsPage } from './InvoiceSettingsPage';
import { EinstellungenPage } from '../EinstellungenPage';
import type { CompanySetup, Expense } from '../../types/models';

const WS = '00000000-0000-4000-8000-00000000d01d';
const setup: CompanySetup = { ...DEFAULT_SETUP, setupComplete: true, taxStatus: 'standard_19' };
const PROFILE = { ...DEFAULT_COMPANY_PROFILE, companyName: 'Cirmak Haustechnik', legalForm: 'GmbH', contactPerson: 'A', street: 'W', zip: '1', city: 'X', email: 'info@cirmak.example', iban: 'DE89370400440532013000', taxNumber: '1', currency: 'EUR', defaultTaxStatus: 'standard_19' as const };

let root: Root;
let host: HTMLDivElement;
const q = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
async function type(id: string, value: string): Promise<void> {
  const el = q(id) as HTMLInputElement;
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function submit(): Promise<void> {
  const form = host.querySelector('form.settings-form') as HTMLFormElement;
  await act(async () => { form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  await settle();
}
async function mount(node: ReactNode, path = '/einstellungen/kommunikation'): Promise<void> {
  host = document.createElement('div');
  host.className = 'app-shell__main';
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(<MemoryRouter initialEntries={[path]}><AuthProvider><AppProvider initialSetup={setup}><Routes><Route path="*" element={node} /></Routes></AppProvider></AuthProvider></MemoryRouter>);
  });
  await settle();
}
async function unmount(): Promise<void> {
  await act(async () => root.unmount());
  host.remove();
}
function asRole(role: 'owner' | 'member'): void {
  vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
  hydrateWorkspaceStore({
    workspace: { id: WS, name: 'Betrieb', ownerUserId: role === 'owner' ? 'usr-admin' : 'usr-owner', createdAt: 'x', updatedAt: 'x', version: 1 },
    workspaceMembers: [{ workspaceId: WS, userId: 'usr-admin', role, status: 'active', createdAt: 'x', updatedAt: 'x' }],
  });
}

beforeEach(async () => {
  resetTestStores();
  resetAuthForTests();
  hydrateCompanyProfileStore(PROFILE);
  hydrateExpenseStore([]);
  vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(false);
  await loginAsDefaultAdmin();
});
afterEach(() => { vi.restoreAllMocks(); resetTestStores(); });

describe('01D — Hub', () => {
  it('A: Firma, Rechnungen & Zahlungen, Design, E-Mail & Kommunikation, Betrieb — in dieser Reihenfolge; Kommunikation verlinkt', async () => {
    await mount(<EinstellungenPage />, '/einstellungen');
    const groups = Array.from(host.querySelectorAll('.settings-group')).map((g) => g.getAttribute('data-testid'));
    expect(groups).toEqual(['settings-group-company', 'settings-group-documents', 'settings-group-design', 'settings-group-communication', 'settings-group-team']);
    expect(q('settings-entry-communication')?.getAttribute('href')).toBe('/einstellungen/kommunikation');
    expect(q('settings-entry-communication')?.textContent).toContain('E-Mail & Kommunikation');
    await unmount();
  });
});

describe('01D — E-Mail & Kommunikation', () => {
  it('D/E/L: Fallbacks sichtbar; technischer From nicht editierbar', async () => {
    await mount(<CommunicationSettingsPage />);
    expect(q('settings-communication-senderDisplayName-hint')?.textContent).toContain('Cirmak Haustechnik GmbH');
    expect(q('settings-communication-replyToEmail-hint')?.textContent).toContain('info@cirmak.example');
    expect(q('settings-communication-identity-name')?.textContent).toBe('Cirmak Haustechnik GmbH');
    expect(q('settings-communication-identity-replyTo')?.textContent).toBe('info@cirmak.example');
    expect(q('settings-communication-identity-from')?.textContent).toContain('nicht änderbar');
    expect(host.querySelector('input[name="from"], input[name="fromEmail"], input[name="senderEmail"]')).toBeNull();
    await unmount();
  });

  it('B/K: Owner setzt Anzeigename, Reply-To und Standardtexte; Resolver folgen; leer loescht wieder', async () => {
    await mount(<CommunicationSettingsPage />);
    await type('settings-communication-senderDisplayName', ' Cirmak Service ');
    await type('settings-communication-replyToEmail', 'Rechnung@Cirmak.Example');
    await type('settings-communication-defaultInvoiceEmailSubject', 'Ihre Rechnung {invoiceNumber}');
    await type('settings-communication-defaultInvoiceEmailBody', 'Hallo\n{companyName}');
    expect(q('settings-communication-identity-name')?.textContent).toBe('Cirmak Service');
    expect(q('settings-communication-dirty')?.textContent).toBe('Ungespeicherte Änderungen');
    await submit();
    const saved = getCompanyProfile();
    expect(saved).toMatchObject({ senderDisplayName: 'Cirmak Service', replyToEmail: 'rechnung@cirmak.example', defaultInvoiceEmailSubject: 'Ihre Rechnung {invoiceNumber}' });
    expect(resolveProfileReplyToEmail(saved)).toBe('rechnung@cirmak.example');
    expect(resolveProfileSenderDisplayName(saved)).toBe('Cirmak Service');
    await type('settings-communication-senderDisplayName', '');
    await type('settings-communication-replyToEmail', '');
    await submit();
    const cleared = getCompanyProfile();
    expect('senderDisplayName' in cleared).toBe(false);
    expect('replyToEmail' in cleared).toBe(false);
    expect(resolveProfileReplyToEmail(cleared)).toBe('info@cirmak.example');
    await unmount();
  });

  it('F: ungueltige Reply-To / zu langer Name -> Fehler sichtbar, Profil unveraendert', async () => {
    hydrateCompanyProfileStore({ ...PROFILE, replyToEmail: 'alt@cirmak.example' });
    await mount(<CommunicationSettingsPage />);
    await type('settings-communication-replyToEmail', 'kein-mail');
    await submit();
    expect(q('settings-communication-error')?.textContent).toContain('Antwortadresse');
    expect(getCompanyProfile().replyToEmail).toBe('alt@cirmak.example');
    await type('settings-communication-replyToEmail', 'alt@cirmak.example');
    await type('settings-communication-senderDisplayName', 'x'.repeat(121));
    expect((q('settings-communication-senderDisplayName') as HTMLInputElement).maxLength).toBe(120);
    await unmount();
  });

  it('C: Member sieht Readonly-Hinweis, Felder readOnly, kein Speichern-Button', async () => {
    asRole('member');
    await mount(<CommunicationSettingsPage />);
    expect(q('settings-communication-readonly')).not.toBeNull();
    expect((q('settings-communication-replyToEmail') as HTMLInputElement).readOnly).toBe(true);
    expect((q('settings-communication-defaultInvoiceEmailBody') as HTMLTextAreaElement).readOnly).toBe(true);
    expect(q('settings-communication-save')).toBeNull();
    await unmount();
  });

  it('N: ungespeicherter Entwurf ueberlebt Verlassen und Wiederoeffnen (Resume-Infrastruktur), ohne zu speichern', async () => {
    clearUiSessionSnapshot();
    resetUiSessionLiveState();
    await mount(<CommunicationSettingsPage />);
    await type('settings-communication-replyToEmail', 'entwurf@cirmak.example');
    captureAndPersistUiSession({ pathname: '/einstellungen/kommunikation', search: '', hash: '', historyKey: 'k1', mainScrollTop: 0, userId: null, source: 'auto' });
    await unmount();
    expect('replyToEmail' in getCompanyProfile()).toBe(false);
    const decision = decideUiSessionRestore({ userId: null, currentPathname: '/einstellungen/kommunikation', currentSearch: '' });
    if (decision.intent === 'silent' && decision.snapshot) setPendingUiSessionApply(decision.snapshot);
    await mount(<CommunicationSettingsPage />);
    expect((q('settings-communication-replyToEmail') as HTMLInputElement).value).toBe('entwurf@cirmak.example');
    expect(q('settings-communication-dirty')?.textContent).toBe('Ungespeicherte Änderungen');
    await unmount();
  });
});

describe('01D — Waehrung auf der Rechnungsseite', () => {
  it('G/H: EUR ruhig dargestellt; kein Eingabefeld; Fremdwaehrungsbelege -> sichtbarer Hinweis; E-Mail-Texte verweisen auf Kommunikation', async () => {
    await mount(<InvoiceSettingsPage />, '/einstellungen/rechnungen');
    expect(q('settings-invoices-currency')?.textContent).toContain('EUR');
    expect(host.querySelector('[data-testid="settings-invoices-section-currency"] input, [data-testid="settings-invoices-section-currency"] select')).toBeNull();
    expect(q('settings-invoices-currency-ambiguous')).toBeNull();
    expect(q('settings-invoices-section-email')).toBeNull();
    expect(q('settings-invoices-email-moved-link')?.getAttribute('href')).toBe('/einstellungen/kommunikation');
    await unmount();

    hydrateCompanyProfileStore({ ...PROFILE, currency: undefined });
    hydrateExpenseStore([{ ...(DEFAULT_COMPANY_PROFILE as unknown as Expense), id: 'exp-real-chf', status: 'gebucht', category: 'material', supplierName: 'L', invoiceNumber: 'C-1', title: 'T', description: '', issueDate: '2026-09-01', paymentDueDate: null, taxStatus: 'standard_19', netAmount: 1, taxAmount: 0, grossAmount: 1, currency: 'CHF', paymentStatus: 'offen', payments: [], positions: [], allocations: [], isCreditNote: false, dedupeKey: 'l|c-1', tags: [], digitalFolder: { id: 'd', name: 'A', path: '/A/' }, paperFolder: { folderId: 'f', register: 'A', label: 'x' }, createdAt: 'x', updatedAt: 'x' } as Expense]);
    await mount(<InvoiceSettingsPage />, '/einstellungen/rechnungen');
    expect(q('settings-invoices-currency-ambiguous')).not.toBeNull();
    expect(q('settings-invoices-currency')?.textContent).toContain('EUR'); // Anzeige-Fallback, keine Profilmutation
    expect('currency' in getCompanyProfile()).toBe(false);
    await unmount();
  });
});
