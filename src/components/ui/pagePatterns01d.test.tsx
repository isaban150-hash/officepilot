/**
 * UIUX-FOUNDATION-01D — Page Patterns.
 *
 *  A/B/C PageHeader: h1/h2, Status neben Titel, Primär/Sekundär-Slots, Reihenfolge, Stapel-Klassen
 *  D  Back: Link (backHref) vs. Button (onBack), Testid, kein Back ohne Label
 *  E  RowList: Link/Button/statisch, Chevron nur interaktiv, trailing
 *  F  BusinessList: Identität/Fakten/Aktion, genau eine Aktion, DataTable mobil-Stapel per data-label
 *  G  Status: expenseStatusTone, StatusBadge mit Text
 *  H/I/J Empty/Loading/Error/InlineNotice: Rollen, aria, Retry nur mit Aktion
 *  K  AusgabeDetailPage: Header mit Back/Status/Hauptaktion, Sections, keine Card-Wand
 *  L  AusgabenPage: Toolbar + BusinessList, Leerzustand ohne doppelte Aktion
 *  M  Mehr/Finanzen auf RowList
 *  O  Fokus/Tastatur: RowListItem-Button fokussierbar, FilterChips aria-pressed
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppProvider } from '../../context/AppContext';
import { AuthProvider } from '../../context/AuthContext';
import { DEFAULT_SETUP } from '../../data/mockData';
import { hydrateExpenseStore } from '../../services/expenseStore';
import { expenseStatusTone } from '../../services/ui/statusTone';
import type { Expense } from '../../types/expense';
import { Button } from './Button';
import { StatusBadge } from './Badge';
import { EmptyStateBlock } from './EmptyStateBlock';
import { BusinessList, BusinessListItem, DataTable, RowList, RowListItem } from './Lists';
import { Page, PageToolbar } from './Page';
import { BackLink, PageHeader } from './PageHeader';
import { ErrorState, InlineNotice, LoadingState } from './States';
import { FilterChips, SearchField } from './Toolbar';
import { AusgabeDetailPage } from '../../pages/AusgabeDetailPage';
import { AusgabenPage } from '../../pages/AusgabenPage';
import { FinanzenPage } from '../../pages/FinanzenPage';
import { MehrPage } from '../../pages/MehrPage';

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
function mount(node: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(node));
  return container;
}
afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

function testExpense(overrides: Partial<Expense> = {}): Expense {
  return {
    id: 'exp-1',
    title: 'Diesel Tankstelle',
    supplierName: 'Aral',
    invoiceNumber: 'R-77',
    category: 'fahrzeug',
    status: 'gebucht',
    issueDate: '2026-03-05',
    paymentDueDate: '2026-03-19',
    grossAmount: 119,
    netAmount: 100,
    taxAmount: 19,
    description: '',
    tags: [],
    paperFolder: { folder: 'Tankbelege', register: '2026' },
    digitalFolder: { name: 'Tankbelege', path: '/Tankbelege/2026' },
    payments: [],
    paymentStatus: 'offen',
    createdAt: '2026-03-05T00:00:00.000Z',
    updatedAt: '2026-03-05T00:00:00.000Z',
    ...overrides,
  } as unknown as Expense;
}

describe('UIUX-FOUNDATION-01D — PageHeader (A/B/C)', () => {
  it('h1 mit Status, Untertitel, Primär nach Sekundär im DOM, genau ein Actions-Block', () => {
    const html = renderToStaticMarkup(
      withProviders(
        <PageHeader
          title="Rechnung R-1"
          subtitle="Musterkunde"
          status={<StatusBadge tone="warning" label="Teilbezahlt" />}
          primaryAction={<Button>Zahlung erfassen</Button>}
          secondaryAction={<Button variant="outline">Bearbeiten</Button>}
          testId="ph"
        />,
      ),
    );
    expect(html).toContain('<h1 class="page-header__title">Rechnung R-1</h1>');
    expect(html).toContain('page-header__status');
    expect(html).toContain('Teilbezahlt');
    expect(html.indexOf('page-header__secondary')).toBeLessThan(html.indexOf('page-header__primary'));
    expect(html.match(/page-header__actions/g)).toHaveLength(1);
    expect(renderToStaticMarkup(withProviders(<PageHeader title="Eingebettet" level={2} />))).toContain('<h2 class="page-header__title">');
    expect(renderToStaticMarkup(withProviders(<PageHeader title="Ohne" />))).not.toContain('page-header__actions');
  });
});

describe('UIUX-FOUNDATION-01D — Back (D)', () => {
  it('backHref → Link, onBack → Button, ohne Label kein Back', () => {
    const link = renderToStaticMarkup(withProviders(<PageHeader title="T" backLabel="Zurück" backHref="/ausgaben" backTestId="b1" />));
    expect(link).toMatch(/<a class="page-header__back" data-testid="b1" href="\/ausgaben"[^>]*>← Zurück<\/a>/);
    const button = renderToStaticMarkup(withProviders(<PageHeader title="T" backLabel="Zurück" onBack={() => {}} backTestId="b2" />));
    expect(button).toContain('<button type="button" class="page-header__back"');
    expect(renderToStaticMarkup(withProviders(<PageHeader title="T" onBack={() => {}} />))).not.toContain('page-header__back');
    const onClick = vi.fn();
    const c = mount(withProviders(<BackLink label="Zurück" onClick={onClick} testId="bl" />));
    act(() => c.querySelector<HTMLButtonElement>('[data-testid="bl"]')!.click());
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe('UIUX-FOUNDATION-01D — RowList (E)', () => {
  it('Link-, Button- und statische Zeile; Chevron nur bei Interaktion; trailing ersetzt Chevron', () => {
    const html = renderToStaticMarkup(
      withProviders(
        <RowList testId="rl">
          <RowListItem to="/kunden" icon="customers" title="Kunden" description="Stamm" testId="r-link" />
          <RowListItem onClick={() => {}} title="Aktion" testId="r-btn" />
          <RowListItem title="Statisch" trailing={<span>3</span>} testId="r-static" />
        </RowList>,
      ),
    );
    expect(html).toMatch(/<a [^>]*data-testid="r-link"[^>]*href="\/kunden"/);
    expect(html).toMatch(/<button type="button" class="row-list__item row-list__item--interactive"[^>]*data-testid="r-btn"/);
    expect(html).toMatch(/<div class="row-list__item"[^>]*data-testid="r-static"/);
    expect((html.match(/row-list__chevron/g) ?? []).length).toBe(2);
    expect(html).toContain('row-list__trailing');
    expect(html).not.toContain('class="card');
  });
});

describe('UIUX-FOUNDATION-01D — BusinessList & DataTable (F)', () => {
  it('Zeile mit Identität, Status, Betrag; klickbar oder eine Aktion; Tabelle mit data-label', () => {
    const html = renderToStaticMarkup(
      withProviders(
        <BusinessList testId="bl">
          <BusinessListItem to="/x" title="R-1" subtitle="Kunde" status={<StatusBadge tone="success" label="Bezahlt" />} amount={<span>1,00 €</span>} testId="row-1" />
          <BusinessListItem title="R-2" action={<Button size="sm">Öffnen</Button>} testId="row-2" />
        </BusinessList>,
      ),
    );
    expect(html).toMatch(/<a [^>]*class="business-list__item business-list__item--interactive"[^>]*href="\/x"/);
    expect(html).toContain('business-list__status');
    expect(html).toContain('business-list__amount');
    expect(html).toContain('business-list__action');
    expect((html.match(/<button/g) ?? []).length).toBe(1);

    const table = renderToStaticMarkup(
      <DataTable
        caption="Positionen"
        columns={[
          { id: 'name', header: 'Position', cell: (r: { n: string; a: number }) => r.n },
          { id: 'amount', header: 'Betrag', cell: (r) => String(r.a), align: 'end' },
        ]}
        rows={[{ n: 'Rohr', a: 10 }]}
        rowKey={(r) => r.n}
      />,
    );
    expect(table).toContain('<caption class="sr-only">Positionen</caption>');
    expect(table).toContain('<th scope="col">Position</th>');
    expect(table).toContain('data-label="Betrag"');
    expect(table).toContain('data-table__cell--end');
  });
});

describe('UIUX-FOUNDATION-01D — Status (G)', () => {
  it('Ausgabenstatus auf Töne; StatusBadge nie ohne Text', () => {
    expect(expenseStatusTone('entwurf')).toBe('neutral');
    expect(expenseStatusTone('gebucht')).toBe('success');
    expect(expenseStatusTone('storniert')).toBe('neutral');
    expect(renderToStaticMarkup(<StatusBadge tone="critical" label="Überfällig" />)).toContain('badge__label">Überfällig');
  });
});

describe('UIUX-FOUNDATION-01D — Empty/Loading/Error/Notice (H/I/J)', () => {
  it('Rollen und aria korrekt; Retry nur mit Handler; Warnung ist kein alert', () => {
    const html = renderToStaticMarkup(
      <>
        <EmptyStateBlock title="Nichts da" description="Legen Sie los." />
        <LoadingState label="Lädt Ausgaben" count={2} />
        <ErrorState title="Konnte nicht laden" detail="ECONNRESET" retryLabel="Erneut versuchen" onRetry={() => {}} />
        <ErrorState title="Ohne Retry" testId="e2" />
        <InlineNotice tone="warning" title="Prüfen">Bitte Datum ergänzen.</InlineNotice>
        <InlineNotice tone="critical">Fehler</InlineNotice>
      </>,
    );
    expect(html).toContain('empty-state-block');
    expect(html).toMatch(/<div class="loading-state" role="status" aria-live="polite" aria-busy="true"/);
    expect((html.match(/data-testid="loading-state-skeleton"/g) ?? []).length).toBe(2);
    expect(html).toContain('role="alert" data-testid="error-state"');
    expect(html).toContain('<details class="error-state__details"><summary>Technische Details</summary>');
    expect(html).toContain('data-testid="error-state-retry"');
    expect(html).not.toContain('data-testid="e2-retry"');
    expect(html).toMatch(/inline-notice inline-notice--warning" role="status"/);
    expect(html).toMatch(/inline-notice inline-notice--critical" role="alert"/);
  });
});

describe('UIUX-FOUNDATION-01D — Toolbar & Fokus (O)', () => {
  it('SearchField mit sr-only Label, FilterChips mit aria-pressed, Button-Zeile fokussierbar', () => {
    const c = mount(
      withProviders(
        <Page testId="p">
          <PageToolbar
            search={<SearchField label="Suchen" value="" onChange={() => {}} testId="sf" />}
            filters={<FilterChips options={[{ id: 'a', label: 'Alle' }, { id: 'b', label: 'B', count: 2 }]} value="a" onChange={() => {}} label="Filter" testIdPrefix="f" />}
          />
          <RowList>
            <RowListItem onClick={() => {}} title="Fokus" testId="focus-row" />
          </RowList>
        </Page>,
      ),
    );
    const input = c.querySelector<HTMLInputElement>('[data-testid="sf"] input')!;
    expect(input.type).toBe('search');
    expect(c.querySelector('[data-testid="sf"] .sr-only')?.textContent).toBe('Suchen');
    expect(c.querySelector('[data-testid="f-a"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(c.querySelector('[data-testid="f-b"]')?.getAttribute('aria-pressed')).toBe('false');
    expect(c.querySelector('[data-testid="f-b"] .chip__count')?.textContent).toBe('2');
    const rowButton = c.querySelector<HTMLButtonElement>('[data-testid="focus-row"]')!;
    act(() => rowButton.focus());
    expect(document.activeElement).toBe(rowButton);
    expect(c.querySelector('.page-toolbar')).not.toBeNull();
  });
});

describe('UIUX-FOUNDATION-01D — repräsentative Seiten (K/L/M)', () => {
  it('AusgabeDetailPage: Back-Link mit from-Parameter, Status im Header, eine Hauptaktion, Sections statt Karten', () => {
    hydrateExpenseStore([testExpense()]);
    const html = renderToStaticMarkup(
      withProviders(
        <Routes>
          <Route path="/ausgaben/:id" element={<AusgabeDetailPage />} />
        </Routes>,
        ['/ausgaben/exp-1?from=overview'],
      ),
    );
    expect(html).toMatch(/<a class="page-header__back" data-testid="ausgabe-detail-back" href="\/ausgaben\/offen"/);
    expect(html).toContain('data-testid="ausgabe-payment-status"');
    expect(html).toContain('data-testid="ausgabe-record-payment"');
    expect(html.match(/page-header__actions/g)).toHaveLength(1);
    expect(html).toContain('data-testid="ausgabe-section-payment"');
    expect(html).toContain('data-testid="ausgabe-section-details"');
    expect(html).toContain('summary-list');
    expect(html).not.toContain('class="back-link"');
    expect(html).not.toContain('class="card"');
    expect(html).toContain('data-testid="ausgabe-detail-actions"');
  });

  it('AusgabenPage: Toolbar + BusinessList mit Status/Betrag; leer ohne doppelte Header-Aktion', () => {
    hydrateExpenseStore([testExpense(), testExpense({ id: 'exp-2', title: 'Schrauben', status: 'entwurf' })]);
    const html = renderToStaticMarkup(withProviders(<AusgabenPage />));
    expect(html).toContain('data-testid="ausgaben-list"');
    expect((html.match(/data-testid="ausgaben-row-/g) ?? []).length).toBe(2);
    expect(html).toContain('data-testid="ausgaben-search"');
    expect(html).toContain('data-testid="ausgaben-category-all"');
    expect(html).toContain('119,00');
    expect(html).toContain('business-list__status');
    expect(html).not.toContain('card-list');
    hydrateExpenseStore([]);
    const empty = renderToStaticMarkup(withProviders(<AusgabenPage />));
    expect(empty).toContain('data-testid="ausgaben-empty"');
    expect((empty.match(/href="\/ausgaben\/neu"/g) ?? []).length).toBe(1);
  });

  it('Mehr und Finanzen nutzen RowList + SectionHeader', () => {
    for (const node of [<MehrPage key="m" />, <FinanzenPage key="f" />]) {
      const html = renderToStaticMarkup(withProviders(node));
      expect(html).toContain('class="row-list"');
      expect(html).toContain('ui-section-header__title');
      expect(html).not.toContain('settings-row');
      expect(html).toContain('page page--narrow');
    }
  });
});
