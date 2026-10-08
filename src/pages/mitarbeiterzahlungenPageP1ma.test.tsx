/**
 * P1 MITARBEITERZAHLUNGEN — die Seite so, wie der Nutzer sie bedient:
 * Mitarbeiter anlegen, Zahlung erfassen (Formular → Zusammenfassung →
 * bestätigen), Abbrechen, Doppelklick, Detail, Storno — und der
 * Lesemodus für Mitglieder. Dazu die angrenzenden Oberflächen: Hinweis im
 * Ausgabenformular, Nachweisauswahl, Lohnabrechnungs-Hinweis und die
 * umbenannte Benutzerverwaltung. Synthetische Daten, kein Netz.
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider } from '../context/AppContext';
import { AuthProvider } from '../context/AuthContext';
import { DEFAULT_SETUP } from '../data/mockData';
import { MitarbeiterzahlungenPage } from './MitarbeiterzahlungenPage';
import { AusgabeNeuPage } from './AusgabeNeuPage';
import { ExpenseForm } from '../components/expenses/ExpenseForm';
import { PaymentProofField } from '../components/payment/PaymentProofField';
import { isSelectableEmployeeProofDocument } from '../components/employee/employeePaymentUi';
import { loginAsDefaultAdmin } from '../test/authFixtures';
import * as supabaseLib from '../lib/supabase';
import { hydrateWorkspaceStore } from '../services/workspace/workspaceStore';
import { resetSyncClientForTests } from '../services/sync/syncClientService';
import { listEmployeePayments } from '../services/employee/employeePaymentService';
import { hydrateDocumentStore } from '../services/documentService';
import { hydrateInboxStore } from '../services/inboxService';
import { t } from '../i18n';
import type { CompanyDocument, CompanySetup, InboxItem } from '../types/models';

const setup: CompanySetup = { ...DEFAULT_SETUP, setupComplete: true, language: 'de' };
const WORKSPACE_ID = '00000000-0000-4000-8000-00000000e1e1';
const ADMIN_USER_ID = 'usr-admin';
const ROUTE = '/finanzen/mitarbeiterzahlungen';

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location" data-path={location.pathname} data-search={location.search} />;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
  }
}

async function render(entry: string, element: ReactNode, path = ROUTE): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[entry]}>
        <AuthProvider>
          <AppProvider initialSetup={setup}>
            <Routes>
              <Route path={path} element={element} />
            </Routes>
            <LocationProbe />
          </AppProvider>
        </AuthProvider>
      </MemoryRouter>,
    );
  });
  await settle();
}

function q(id: string): HTMLElement | null {
  return document.body.querySelector(`[data-testid="${id}"]`);
}

async function click(id: string): Promise<void> {
  const el = q(id);
  expect(el, id).not.toBeNull();
  await act(async () => {
    el!.click();
  });
  await settle();
}

async function type(id: string, value: string): Promise<void> {
  const el = q(id) as HTMLInputElement | HTMLTextAreaElement;
  expect(el, id).not.toBeNull();
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

async function choose(id: string, value: string): Promise<void> {
  const el = q(id) as HTMLSelectElement;
  expect(el, id).not.toBeNull();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function seedWorkspace(role: 'owner' | 'admin' | 'member'): void {
  hydrateWorkspaceStore({
    workspace: { id: WORKSPACE_ID, name: 'Beispielbetrieb', ownerUserId: 'usr-owner', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', version: 1 },
    workspaceMembers: [{ workspaceId: WORKSPACE_ID, userId: ADMIN_USER_ID, role, status: 'active', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
  });
}

async function legeMitarbeiterAn(name: string): Promise<void> {
  await click('employee-add');
  await type('employee-form-name', name);
  await click('employee-form-save');
}

async function fuelleFormular(kind: string): Promise<void> {
  const employeeSelect = q('employee-payment-employee') as HTMLSelectElement;
  const option = Array.from(employeeSelect.options).find((entry) => entry.value);
  await choose('employee-payment-employee', option!.value);
  await choose('employee-payment-kind', kind);
  await type('employee-payment-amount', '300,00');
  await type('employee-payment-date', '2026-10-02');
  await choose('employee-payment-method', 'cash');
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-08T10:00:00.000Z'));
  resetSyncClientForTests({
    deviceId: 'dev-a',
    workspaceId: 'local-ws-a',
    serverWorkspaceId: WORKSPACE_ID,
    createdAt: '2026-01-01T00:00:00.000Z',
    syncPolicy: 'cloud_ready',
  });
  vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(false);
  await loginAsDefaultAdmin();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  host?.remove();
  host = null;
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('Finanzen → Mitarbeiterzahlungen', () => {
  it('Mitarbeiter anlegen, Zahlung erst nach Zusammenfassung und ausdrücklicher Bestätigung', async () => {
    await render(ROUTE, <MitarbeiterzahlungenPage />);
    expect(q('employee-payments-page')).not.toBeNull();
    expect(q('employee-payments-empty')).not.toBeNull();
    await legeMitarbeiterAn('Erika Beispiel');
    expect(q('employee-list')?.textContent).toContain('Erika Beispiel');

    await click('employee-payments-add');
    expect(q('employee-payment-form')).not.toBeNull();
    /* Keine Vorgabe für die Zahlungsart. */
    expect((q('employee-payment-method') as HTMLSelectElement).value).toBe('');

    await click('employee-payment-next');
    expect(q('employee-payment-summary')).toBeNull();
    expect(document.body.textContent).toContain('Bitte einen Mitarbeiter wählen.');

    await fuelleFormular('advance');
    await click('employee-payment-next');
    expect(q('employee-payment-summary')).not.toBeNull();
    expect(q('employee-payment-hint-advance')?.textContent).toContain('Dieser Vorschuss wird nicht als Aufwand behandelt.');
    expect(q('employee-payment-summary-amount')?.textContent).toContain('300,00');
    /* Die Zusammenfassung hat noch nichts festgehalten. */
    expect(listEmployeePayments()).toHaveLength(0);

    await click('employee-payment-confirm');
    expect(listEmployeePayments()).toHaveLength(1);
    const zahlung = listEmployeePayments()[0];
    expect(zahlung).toMatchObject({ kind: 'advance', amount: 300, paymentMethod: 'cash' });
    expect(q('employee-payment-dialog')).toBeNull();
    /* Das Detail öffnet sich über die Adresse — mit der MZ-Referenz. */
    expect(q('location')?.getAttribute('data-search')).toContain(`zahlung=${zahlung.id}`);
    expect(q('employee-payment-detail-reference')?.textContent).toBe(zahlung.receiptReference);
    expect(q(`employee-payment-row-${zahlung.id}`)?.textContent).toContain(zahlung.receiptReference);
  });

  it('Abbrechen — auch nach der Zusammenfassung — erzeugt keine Zahlung', async () => {
    await render(ROUTE, <MitarbeiterzahlungenPage />);
    await legeMitarbeiterAn('Erika Beispiel');
    await click('employee-payments-add');
    await fuelleFormular('wage');
    await click('employee-payment-next');
    expect(q('employee-payment-summary')).not.toBeNull();
    await click('employee-payment-back');
    await click('employee-payment-cancel');
    expect(q('employee-payment-dialog')).toBeNull();
    expect(listEmployeePayments()).toHaveLength(0);
  });

  it('ein Doppelklick auf „Zahlung jetzt erfassen" erfasst genau eine Zahlung', async () => {
    await render(ROUTE, <MitarbeiterzahlungenPage />);
    await legeMitarbeiterAn('Erika Beispiel');
    await click('employee-payments-add');
    await fuelleFormular('wage');
    await click('employee-payment-next');
    const knopf = q('employee-payment-confirm')!;
    await act(async () => {
      knopf.click();
      knopf.click();
    });
    await settle();
    expect(listEmployeePayments()).toHaveLength(1);
  });

  it('WEISS: Zahlungsgrund und Zahlungsweg statt „Art" neben „Zahlungsart"; gleiche Zahlung ein zweites Mal — Hinweis, keine Sperre', async () => {
    await render(ROUTE, <MitarbeiterzahlungenPage />);
    await legeMitarbeiterAn('Erika Beispiel');
    await click('employee-payments-add');
    const formular = q('employee-payment-form')!.textContent ?? '';
    expect(formular).toContain('Zahlungsgrund');
    expect(formular).toContain('Wofür wurde gezahlt?');
    expect(formular).toContain('Zahlungsweg');
    expect(formular).toContain('Wie wurde ausgezahlt');
    expect(formular).not.toContain('Zahlungsart');

    await fuelleFormular('wage');
    await click('employee-payment-next');
    expect(q('employee-payment-duplicate-warning')).toBeNull();
    await click('employee-payment-confirm');
    if (q('employee-payment-detail-close')) await click('employee-payment-detail-close');
    const erste = listEmployeePayments()[0]!;

    /* Bewusst noch einmal dieselbe Zahlung: neue Dialogsitzung, neue Kennung. */
    await click('employee-payments-add');
    await fuelleFormular('wage');
    await click('employee-payment-next');
    const hinweis = q('employee-payment-duplicate-warning');
    expect(hinweis?.textContent).toContain('Möglicherweise doppelt erfasst');
    expect(hinweis?.textContent).toContain(erste.receiptReference);
    expect((q('employee-payment-confirm') as HTMLButtonElement).disabled).toBe(false);
    expect(q('employee-payment-summary')!.textContent).toContain('Zahlungsgrund');
    expect(q('employee-payment-summary')!.textContent).toContain('Zahlungsweg');
    await click('employee-payment-confirm');
    expect(listEmployeePayments()).toHaveLength(2);
  });

  it('Storno nur mit Grund; danach bleibt die Zahlung sichtbar und trägt Datum und Grund', async () => {
    await render(ROUTE, <MitarbeiterzahlungenPage />);
    await legeMitarbeiterAn('Erika Beispiel');
    await click('employee-payments-add');
    await fuelleFormular('wage');
    await click('employee-payment-next');
    await click('employee-payment-confirm');
    const zahlung = listEmployeePayments()[0];

    expect(q('employee-payment-receipt-create')).not.toBeNull();
    await click('employee-payment-reverse-open');
    expect(q('employee-payment-reverse-dialog')).not.toBeNull();
    await click('employee-payment-reverse-confirm');
    expect(document.body.textContent).toContain('Bitte einen Grund angeben');
    expect(listEmployeePayments()[0].reversedAt).toBeUndefined();

    await type('employee-payment-reverse-reason', 'Falscher Betrag');
    await click('employee-payment-reverse-confirm');
    const storniert = listEmployeePayments()[0];
    expect(storniert.reversedAt).toBeTruthy();
    expect(q('employee-payment-detail-reversed')?.textContent).toMatch(/^Storniert am \d{2}\.\d{2}\.\d{4} – Falscher Betrag$/);
    expect(q('employee-payment-receipt-create')).toBeNull();
    expect(q('employee-payment-receipt-after-reversal')).not.toBeNull();
    expect(q(`employee-payment-row-${zahlung.id}`)).not.toBeNull();
  });

  it('das Nachweis-Hochladen steht in der Adresse und übersteht ein Neuladen', async () => {
    await render(ROUTE, <MitarbeiterzahlungenPage />);
    await legeMitarbeiterAn('Erika Beispiel');
    await click('employee-payments-add');
    await fuelleFormular('wage');
    await click('employee-payment-next');
    await click('employee-payment-confirm');
    const zahlung = listEmployeePayments()[0];
    await click('employee-payment-proof-upload-open');
    expect(q('location')?.getAttribute('data-search')).toContain('nachweis=1');
    expect(q('employee-proof-upload')).not.toBeNull();

    /* „Neu laden" — die Seite startet frisch mit derselben Adresse. */
    await act(async () => root!.unmount());
    host!.remove();
    await render(`${ROUTE}?zahlung=${zahlung.id}&nachweis=1`, <MitarbeiterzahlungenPage />);
    expect(q('employee-payment-detail-reference')?.textContent).toBe(zahlung.receiptReference);
    expect(q('employee-proof-upload')).not.toBeNull();
  });

  it('ein Mitglied ohne Finanzrecht sieht nur den Hinweis — keine Daten, keine Erfassung', async () => {
    vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(true);
    seedWorkspace('member');
    await render(ROUTE, <MitarbeiterzahlungenPage />);
    expect(q('employee-payments-read-only')).not.toBeNull();
    expect(q('employee-payments-add')).toBeNull();
    expect(q('employee-management')).toBeNull();
  });
});

describe('Angrenzende Oberflächen', () => {
  it('Ausgabenformular: Kategorie Personal zeigt einen nicht blockierenden Hinweis', async () => {
    await render('/ausgaben/neu', <ExpenseForm mode="add" onSaved={() => undefined} onCancel={() => undefined} />, '/ausgaben/neu');
    expect(q('expense-personal-hint')).toBeNull();
    await choose('expense-category-select', 'personal');
    expect(q('expense-personal-hint')?.textContent).toContain('Lohnabrechnungen nicht zusätzlich als Ausgabe erfassen');
  });

  it('/ausgaben/neu?inboxId=<Lohnabrechnung> zeigt den Hinweis mit Weg zu den Mitarbeiterzahlungen', async () => {
    hydrateInboxStore([
      {
        id: 'inbox-lohn',
        title: 'Lohnabrechnung Oktober 2026',
        documentType: 'lohnabrechnung',
        classifiedKind: 'lohnabrechnung',
        sender: 'Steuerbüro Beispiel',
        priority: 'mittel',
        deadline: null,
        digitalFolder: { id: 'd', name: 'Lohn', path: '/Mitarbeiter/Lohnunterlagen/' },
        paperFiling: { folderId: 'paper-personal', register: 'Lohn', label: 'Personal' },
        status: 'neu',
        receivedAt: '2026-10-02',
        recommendedAction: 'zuordnen',
        recognizedData: {},
        officePilotSuggestion: '',
        nextTaskLabel: '',
        securityHint: '',
      } as InboxItem,
    ]);
    await render('/ausgaben/neu?inboxId=inbox-lohn', <AusgabeNeuPage />, '/ausgaben/neu');
    expect(q('expense-new-payroll-hint')?.textContent).toContain('Lohnauszahlungen erfassen Sie unter Finanzen → Mitarbeiterzahlungen.');
    expect(q('expense-new-payroll-hint-link')?.getAttribute('href')).toBe(ROUTE);
  });

  it('Nachweisauswahl: nur aktive Dokumente, keine erzeugte Auszahlungsquittung, kein Rechnungsdokument', async () => {
    const basis = {
      category: 'personal', issuer: '', recognizedText: '', issueDate: '2026-10-02', validUntil: null,
      digitalFolder: { id: 'd', name: 'x', path: '/x/' }, paperFolder: { folderId: 'paper-personal', register: 'Lohn', label: 'Personal' },
      tags: [], linkedCompany: '', linkedVorgang: null, archived: true, createdAt: '2026-10-02T09:00:00.000Z', imagePreview: '📄',
      linkedInvoiceId: null, linkedLetterId: null, linkedOfferId: null,
    };
    hydrateDocumentStore([
      { ...basis, id: 'doc-aktiv', title: 'Unterschriebene Quittung' },
      { ...basis, id: 'doc-geloescht', title: 'Gelöschte Quittung', sync: { updatedAt: 'x', version: 2, deleted: true, deviceId: 'd', workspaceId: 'w' } },
      { ...basis, id: 'emp-receipt-pay-1', title: 'Erzeugte Auszahlungsquittung' },
      { ...basis, id: 'doc-rechnung', title: 'Ausgangsrechnung RE-1', category: 'ausgangsrechnung', linkedInvoiceId: 'inv-1' },
    ] as CompanyDocument[]);
    await render(
      ROUTE,
      <PaymentProofField value="" onChange={() => undefined} translate={(key) => t(key)} testId="nachweis" isSelectable={isSelectableEmployeeProofDocument} />,
    );
    const werte = Array.from((q('nachweis') as HTMLSelectElement).options).map((option) => option.value);
    expect(werte).toContain('doc-aktiv');
    expect(werte).not.toContain('doc-geloescht');
    expect(werte).not.toContain('emp-receipt-pay-1');
    expect(werte).not.toContain('doc-rechnung');
  });

  it('Benutzer & Zugänge statt „Mitarbeiter" für die Benutzerverwaltung — DE, TR, BG', () => {
    expect(t('settings.team.users.title')).toBe('Benutzer & Zugänge');
    expect(t('settings.operating.section.admin')).toBe('Benutzer & Zugänge');
    expect(t('settings.operating.admin.users')).toBe('Benutzer & Zugänge verwalten');
    expect(t('settings.operating.role.member')).not.toContain('Mitarbeiter');
    expect(t('settings.team.users.title', 'tr')).toBe('Kullanıcılar ve erişimler');
    expect(t('settings.operating.role.member', 'tr')).not.toMatch(/Çalışan/i);
    expect(t('settings.team.users.title', 'bg')).toBe('Потребители и достъп');
    expect(t('settings.operating.role.member', 'bg')).not.toMatch(/служител/i);
    expect(t('home.tile.assistant.desc')).toBe('Ihr digitaler Assistent');
    /* Die neue Entität heisst sichtbar „Mitarbeiter". */
    expect(t('finanzen.employeePayments')).toBe('Mitarbeiterzahlungen');
  });
});
