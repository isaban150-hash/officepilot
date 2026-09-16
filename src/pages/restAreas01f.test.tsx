/**
 * UIUX-FOUNDATION-01F — restliche Produktbereiche auf den 01D-Patterns.
 *
 *  A  Kundenliste: BusinessList, Hauptaktion im Header, Adresse als Untertitel, Legacy/Orphan als Badge
 *  B  Kundendetail: PageHeader mit Back-Link/Status/Bearbeiten, Sections, Business-Listen
 *  C  Dokumentliste: Toolbar (Suche, Bereichs-Chips), Zeilen mit Vorschau/Status
 *  D  Aufgaben: Zeilen mit Checkbox-Aktion, Prioritäts-Status, Filter-Chips
 *  E  Offene Ausgaben / Steuerberater: Zahlungsstand-Section, Notices, Hauptaktion je Schritt
 *  F  Payment-UI: Summary-Notices als InlineNotice, Historie als BusinessList, Badges über StatusBadge
 *  G  Back-Patterns: Upload/MailImport/Sync/Suche = Link, Papierarchiv = History-Button
 *  H  DetailExperienceCard ohne doppelte Identität
 *  I  Token --op-on-primary vorhanden, Legacy-CSS entfernt
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppProvider } from '../context/AppContext';
import { AuthProvider } from '../context/AuthContext';
import { DEFAULT_SETUP } from '../data/mockData';
import { hydrateVorgangStore } from '../services/vorgangService';
import { hydrateTaskStore } from '../services/taskStore';
import { hydrateExpenseStore } from '../services/expenseStore';
import { createCustomer } from '../services/customerService';
import { createTestVorgang } from '../test/fixtures';
import { KundenPage } from './KundenPage';
import { KundenDetailPage } from './KundenDetailPage';
import { AufgabenPage } from './AufgabenPage';
import { OffeneAusgabenPage } from './OffeneAusgabenPage';
import { SteuerberaterPage } from './SteuerberaterPage';
import { PapierarchivPage } from './PapierarchivPage';
import { MailImportPage } from './MailImportPage';
import { DetailExperienceCard } from '../components/detail/DetailExperienceCard';
import { InvoicePaymentSummary } from '../components/invoice/InvoicePaymentSummary';
import { InvoicePaymentHistory } from '../components/invoice/InvoicePaymentHistory';
import type { VorgangInvoice } from '../types/models';

function withProviders(node: React.ReactNode, entries: string[] = ['/']) {
  return (
    <MemoryRouter initialEntries={entries}>
      <AuthProvider>
        <AppProvider initialSetup={DEFAULT_SETUP}>{node}</AppProvider>
      </AuthProvider>
    </MemoryRouter>
  );
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

beforeEach(() => {
  hydrateVorgangStore([]);
  hydrateTaskStore([]);
  hydrateExpenseStore([]);
});

describe('UIUX-FOUNDATION-01F — Kunden (A/B)', () => {
  it('Liste: Hauptaktion im Header, Business-Zeilen mit Adresse; Detail: Back-Link, Sections', () => {
    const created = createCustomer({ name: 'Bau Nord GmbH', street: 'Industrieweg 3', zip: '80331', city: 'München', contactPerson: 'M. Nord', email: '', phone: '' });
    expect(created.success).toBe(true);
    const id = created.success ? created.customer.id : '';
    hydrateVorgangStore([createTestVorgang({ id: 'v-f1', title: 'Dach Nord', customer: 'Bau Nord GmbH', customerId: id })]);

    const list = renderToStaticMarkup(withProviders(<KundenPage />));
    expect(list).toContain('data-testid="kunden-list"');
    expect(list).toContain('data-testid="kunden-create-action"');
    expect(list.match(/page-header__actions/g)).toHaveLength(1);
    expect(list).toMatch(/<a class="business-list__item business-list__item--interactive"[^>]*data-testid="kunde-customer-/);
    expect(list).toContain('data-testid="kunde-address"');
    expect(list).not.toContain('card-link');

    const detail = renderToStaticMarkup(
      withProviders(
        <Routes>
          <Route path="/kunden/customer/:customerId" element={<KundenDetailPage kind="customer" />} />
        </Routes>,
        [`/kunden/customer/${id}`],
      ),
    );
    expect(detail).toContain('<h1 class="page-header__title">Bau Nord GmbH</h1>');
    expect(detail).toMatch(/<a class="page-header__back" data-testid="kunden-detail-back" href="\/kunden"/);
    expect(detail).toContain('data-testid="kunden-edit-action"');
    for (const id2 of ['kunden-contact', 'kunden-vorgaenge-open', 'kunden-invoices', 'kunden-receivables', 'kunden-documents', 'kunden-tasks']) {
      expect(detail).toContain(`data-testid="${id2}"`);
    }
    expect(detail).toContain('data-testid="kunden-vorgang-v-f1"');
    expect(detail).toContain('summary-list');
    expect(detail).not.toContain('kunden-detail-section');
    expect(detail).not.toContain('class="card');
  });
});

describe('UIUX-FOUNDATION-01F — Aufgaben (D)', () => {
  it('Zeilen mit Checkbox als Aktion und Prioritäts-Status; Filter-Chips', () => {
    hydrateTaskStore([
      { id: 't1', title: 'Brief prüfen', description: 'Test', status: 'open', priority: 'kritisch', category: 'dokumente', sourceType: 'system', dueDate: '2026-09-20', createdAt: '2026-09-01T00:00:00.000Z' } as never,
    ]);
    const c = document.createElement('div');
    document.body.appendChild(c);
    container = c;
    root = createRoot(c);
    act(() => root!.render(withProviders(<AufgabenPage />)));
    expect(c.querySelector('[data-testid="aufgaben-list"]')).not.toBeNull();
    expect(c.querySelector('[data-testid="aufgaben-toggle-t1"]')).not.toBeNull();
    expect(c.querySelector('[data-testid="aufgaben-row-t1"] .status-badge')?.getAttribute('data-tone')).toBe('critical');
    expect(c.querySelector('[data-testid="aufgaben-filter-offen"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(c.querySelector('.card-list')).toBeNull();
  });
});

describe('UIUX-FOUNDATION-01F — Finanzen / Steuerberater (E)', () => {
  it('Offene Ausgaben: Zahlungsstand-Section, Toolbar, Back-Link; Steuerberater: Status + eine Hauptaktion', () => {
    const offen = renderToStaticMarkup(withProviders(<OffeneAusgabenPage />));
    expect(offen).toContain('data-testid="offene-ausgaben-summary"');
    expect(offen).toContain('data-testid="offene-ausgaben-search"');
    expect(offen).toMatch(/<a class="page-header__back" data-testid="offene-ausgaben-back" href="\/ausgaben"/);
    expect(offen).not.toContain('overview-kpi-card');
    expect(offen).not.toContain('invoice-hint');

    const stb = renderToStaticMarkup(withProviders(<SteuerberaterPage />));
    expect(stb).toContain('data-testid="steuerberater-month-status"');
    expect(stb).toContain('data-testid="steuerberater-prepare-folder"');
    expect(stb.match(/page-header__actions/g)).toHaveLength(1);
    expect(stb).toContain('data-testid="steuerberater-month"');
    expect(stb).toContain('data-testid="steuerberater-categories"');
    expect(stb).not.toContain('⚠');
  });
});

describe('UIUX-FOUNDATION-01F — Payment-UI (F)', () => {
  it('Summary mit InlineNotice und StatusBadge, Historie als BusinessList', () => {
    const invoice = {
      id: 'inv-1',
      number: '2026-0001',
      type: 'schluss',
      status: 'freigegeben',
      date: '2026-01-01',
      issueDate: '2026-01-01',
      paymentDueDate: '2000-01-01',
      totals: { gross: 100, net: 84.03, vat: 15.97 },
      payments: [{ id: 'p1', date: '2026-01-10', amount: 40, reference: 'Überweisung', note: 'Teil 1' }],
      positions: [],
    } as unknown as VorgangInvoice;
    const t = (k: string) => k;
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <InvoicePaymentSummary invoice={invoice} translate={t as never} />
        <InvoicePaymentHistory invoice={invoice} translate={t as never} onRemovePayment={() => {}} />
      </MemoryRouter>,
    );
    expect(html).toContain('status-badge invoice-payment-badge');
    expect(html).toContain('summary-list');
    expect(html).toContain('money-display');
    expect(html).toMatch(/invoice-payment-history__list|business-list/);
    expect(html).toContain('business-list__item invoice-payment-history__item');
    expect(html).toContain('payment.reference: Überweisung');
    expect(html).not.toContain('invoice-payment-summary__notice');
  });
});

describe('UIUX-FOUNDATION-01F — Back-Patterns & Titel (G/H)', () => {
  it('MailImport/Papierarchiv-Back im PageHeader; DetailExperienceCard ohne doppelte Identität', () => {
    const mail = renderToStaticMarkup(withProviders(<MailImportPage />));
    expect(mail).toMatch(/<a class="page-header__back" data-testid="mail-import-back" href="\/mehr"/);
    const paper = renderToStaticMarkup(withProviders(<PapierarchivPage />));
    expect(paper).toContain('<button type="button" class="page-header__back" data-testid="papierarchiv-back"');
    expect(paper).toContain('class="row-list"');
    expect(mail).not.toContain('class="back-link"');

    const withId = renderToStaticMarkup(withProviders(<DetailExperienceCard recognizedTitle="R-1" assistantMessage="x" />));
    const noId = renderToStaticMarkup(withProviders(<DetailExperienceCard recognizedTitle="R-1" assistantMessage="x" hideIdentity />));
    expect(withId).toContain('Was ist das?');
    expect(noId).not.toContain('Was ist das?');
    expect(noId).toContain('detail-experience-section__value--assistant');
  });
});

describe('UIUX-FOUNDATION-01F — Tokens & Legacy-CSS (I)', () => {
  it('--op-on-primary existiert; tote Legacy-Regeln sind entfernt; Produktivcode ohne back-link', () => {
    const tokens = fs.readFileSync(path.resolve(__dirname, '../styles/tokens.css'), 'utf8');
    expect(tokens).toContain('--op-on-primary: #ffffff;');
    const components = fs.readFileSync(path.resolve(__dirname, '../styles/components.css'), 'utf8');
    expect(components).toContain('var(--op-on-primary)');
    const index = fs.readFileSync(path.resolve(__dirname, '../index.css'), 'utf8');
    for (const dead of ['.card-link {', '.document-toolbar {', '.overview-kpi-grid {', '.mehr-link-card {', '.invoice-payment-badge--offen', '.kunden-detail-section {', '.task-row {']) {
      expect(index, dead).not.toContain(dead);
    }
    const pagesDir = path.resolve(__dirname);
    const offenders = fs
      .readdirSync(pagesDir)
      .filter((f) => f.endsWith('.tsx') && !f.includes('.test.'))
      .filter((f) => fs.readFileSync(path.join(pagesDir, f), 'utf8').includes('className="back-link"'));
    expect(offenders).toEqual([]);
  });
});
