/**
 * UIUX-FOUNDATION-01E — Kernarbeitsbereiche auf den 01D-Patterns.
 *
 *  A  Heute: eigener Kopf mit genau einer Hauptaktion, Sections nach
 *     Arbeitsbedarf, keine Kacheln/Emojis
 *  B  Eingang-Liste: Header + Hauptaktion, Aufmerksamkeit als RowList, Filter-Chips, InboxCard bleibt
 *  C  Dokumentdetail: Back-Link zum Parent, PageHeader, SummaryList; EingangDetail-Back als Link
 *  D  Aufträge-Liste: BusinessList mit Status, Suche/Filter, Leerzustände
 *  E  Vorgang-Detail: PageHeader mit Status/Back, vtab bleibt
 *  F  Rechnungsliste: Titel „Rechnungen“, Zahlungsstand, Toolbar, Business-Zeilen mit StatusBadge
 *  G  Rechnungsdetail: Header mit Status, Zahlungs-Section sichtbar, Back aus from-Parameter
 *  H  Status: Payment-Badges rendern über StatusBadge (kein Domain-CSS)
 *  I  Back/Deep-Link: vtab und from bleiben in Links erhalten
 *  J/K/L Empty/Loading/Error-Pattern in den Kernbereichen
 *  O  Primary-Action-Hierarchie: genau ein page-header__actions je Seite
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppProvider } from '../context/AppContext';
import { AuthProvider } from '../context/AuthContext';
import { DEFAULT_SETUP } from '../data/mockData';
import { MOCK_INBOX_ITEMS } from '../data/inboxMockData';
import { hydrateInboxStore } from '../services/inboxService';
import { hydrateTaskStore } from '../services/taskStore';
import { hydrateVorgangStore } from '../services/vorgangService';
import { createTestVorgang } from '../test/fixtures';
import { resetHomeHintDismissals } from '../services/homeHintDismissalService';
import { HeutePage } from './HeutePage';
import { EingangPage } from './EingangPage';
import { VorgaengePage } from './VorgaengePage';
import { VorgangDetailPage } from './VorgangDetailPage';
import { OffeneRechnungenPage } from './OffeneRechnungenPage';
import { InvoicePaymentBadge } from '../components/invoice/InvoicePaymentBadge';
import { ExpensePaymentBadge } from '../components/expenses/ExpensePaymentBadge';
import { LoadingState } from '../components/ui/States';

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
  resetHomeHintDismissals();
});

beforeEach(() => {
  resetHomeHintDismissals();
  hydrateInboxStore(MOCK_INBOX_ITEMS.map((item) => ({ ...item })));
  hydrateVorgangStore([
    createTestVorgang({ id: 'v-01e-1', title: 'Badumbau Müller', customer: 'Müller GmbH', baustelle: 'Hauptstraße 1' }),
    createTestVorgang({ id: 'v-01e-2', title: 'Heizung Schmidt', customer: 'Schmidt', status: 'abgeschlossen' }),
  ]);
  hydrateTaskStore([]);
});

const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2705}\u{274C}\u{2714}]/u;

describe('UIUX-FOUNDATION-01E — Heute (A/O)', () => {
  /*
   * Die Heute-Seite wurde mit dem Startseiten-Redesign (7c17791) auf das
   * 04b-Layout umgebaut: Der frühere `heute-head`-Kopf mit `heute-head__title`
   * und `heute-head__actions` ist ebenso entfallen wie die Abschnitte
   * „Offene Arbeit" und „Schnellzugriff" — `HomeOpenWork` wird von der Seite
   * gar nicht mehr eingebunden. Die Zusicherungen standen seither auf Markup,
   * das es nicht mehr gibt.
   *
   * Geprüft wird deshalb dasselbe **Anliegen** am geltenden Aufbau: ein
   * eigener Kopf, genau eine Hauptaktion, Abschnitte in der Reihenfolge ihres
   * Arbeitsbedarfs — und weiterhin keine Kacheln und keine Emojis.
   */
  it('eigener Kopf mit genau einer Hauptaktion, Sections in Arbeitsreihenfolge, keine Kacheln oder Emojis', () => {
    const html = renderToStaticMarkup(withProviders(<HeutePage />));
    expect(html).toContain('data-testid="heute-page"');

    // Ein Kopf, eine Überschrift.
    expect(html).toContain('data-testid="desk-greeting-header"');
    expect(html.match(/<h1[ >]/g) ?? []).toHaveLength(1);

    // Genau eine Hauptaktion.
    expect(html.match(/data-testid="home-card-add-document"/g) ?? []).toHaveLength(1);

    for (const id of ['heute-section-attention', 'heute-section-assistant', 'home-new-intake']) {
      expect(html).toContain(`data-testid="${id}"`);
    }
    // Was Arbeit verlangt, steht vor dem, was nur informiert.
    expect(html.indexOf('heute-section-attention')).toBeLessThan(html.indexOf('heute-section-assistant'));
    expect(html.indexOf('heute-section-assistant')).toBeLessThan(html.indexOf('home-new-intake'));

    expect(html).toContain('href="/ablage"');
    expect(html).toContain('href="/steuerberater"');
    expect(html).not.toContain('mobile-home-card');
    expect(html).not.toMatch(EMOJI);
    /* Die einzigen Karten sind die fachlich geprüften Dokument-Kurzfassungen (DocumentExperienceCard). */
    expect((html.match(/class="card/g) ?? []).length).toBe((html.match(/document-summary-compact" data-testid=/g) ?? []).length);
  });
});

describe('UIUX-FOUNDATION-01E — Eingang (B/J)', () => {
  it('Header mit Hauptaktion, Filter-Chips, InboxCard-Zeilen bleiben; Leerzustand über EmptyStateBlock', () => {
    const html = renderToStaticMarkup(withProviders(<EingangPage />));
    expect(html).toContain('data-testid="ablage-page"');
    expect(html).toContain('data-testid="ablage-add-document"');
    expect(html.match(/page-header__actions/g)).toHaveLength(1);
    expect(html).toContain('data-testid="ablage-filter-all"');
    expect(html).toContain('data-testid="ablage-filter-neu"');
    expect(html).toMatch(/data-testid="inbox-card-/);
    expect(html).toContain('data-testid="documents-capture-panel"');
    hydrateInboxStore([]);
    const empty = renderToStaticMarkup(withProviders(<EingangPage />));
    expect(empty).toContain('data-testid="ablage-empty-state"');
    expect(empty).not.toContain('ablage-filter-all');
    expect(empty).toContain('empty-state-block');
  });
});

describe('UIUX-FOUNDATION-01E — Aufträge (D/J)', () => {
  it('BusinessList mit Status, Suche/Filter; Filter „Abgeschlossen“ zeigt nur abgeschlossene', () => {
    const html = renderToStaticMarkup(withProviders(<VorgaengePage />));
    expect(html).toContain('data-testid="vorgaenge-list"');
    expect(html).toContain('data-testid="vorgaenge-search"');
    expect(html).toContain('data-testid="vorgaenge-filter-active"');
    expect(html).toContain('data-testid="vorgaenge-row-v-01e-1"');
    expect(html).not.toContain('data-testid="vorgaenge-row-v-01e-2"');
    expect(html).toContain('business-list__status');
    expect(html).toContain('Müller GmbH · Hauptstraße 1');
    expect(html).not.toContain('card-list');
    hydrateVorgangStore([]);
    expect(renderToStaticMarkup(withProviders(<VorgaengePage />))).toContain('data-testid="vorgaenge-empty-state"');
  });

  it('Filterwechsel zeigt abgeschlossene Aufträge', () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root!.render(withProviders(<VorgaengePage />)));
    act(() => container!.querySelector<HTMLButtonElement>('[data-testid="vorgaenge-filter-done"]')!.click());
    expect(container.querySelector('[data-testid="vorgaenge-row-v-01e-2"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="vorgaenge-row-v-01e-1"]')).toBeNull();
    expect(container.querySelector('[data-testid="vorgaenge-filter-done"]')?.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('UIUX-FOUNDATION-01E — Vorgang-Detail (E/I)', () => {
  it('PageHeader mit Back-Link, Status und Kunde; vtab bleibt in der Adresse', () => {
    const html = renderToStaticMarkup(
      withProviders(
        <Routes>
          <Route path="/vorgaenge/:id" element={<VorgangDetailPage />} />
        </Routes>,
        ['/vorgaenge/v-01e-1?vtab=invoices'],
      ),
    );
    expect(html).toContain('data-testid="vorgang-detail-header"');
    expect(html).toContain('<h1 class="page-header__title">Badumbau Müller</h1>');
    expect(html).toContain('data-testid="vorgang-detail-status"');
    expect(html).toMatch(/<a class="page-header__back" data-testid="vorgang-detail-back" href="\/vorgaenge"/);
    expect(html).toContain('data-testid="vorgang-section-nav"');
    expect(html).toContain('aria-selected="true"');
    expect(html).not.toContain('class="back-link"');
  });
});

describe('UIUX-FOUNDATION-01E — Rechnungen (F/H/O)', () => {
  it('Titel „Rechnungen“, Zahlungsstand-Section, Toolbar, eine Hauptaktion', () => {
    const html = renderToStaticMarkup(withProviders(<OffeneRechnungenPage />));
    expect(html).toContain('data-testid="rechnungen-page"');
    expect(html).toContain('>Rechnungen</h1>');
    expect(html).toContain('data-testid="rechnungen-summary"');
    expect(html).toContain('data-testid="rechnungen-search"');
    expect(html).toContain('data-testid="rechnungen-filter-ueberfaellig"');
    expect(html).toContain('data-testid="overview-new-invoice"');
    expect(html.match(/page-header__actions/g)).toHaveLength(1);
    expect(html).toMatch(/<a class="page-header__back" data-testid="rechnungen-back" href="\/vorgaenge"/);
    expect(html).not.toContain('overview-kpi-card');
    expect(html).not.toContain('class="chip-group overview-filters"');
  });

  it('Payment-Badges rendern über StatusBadge mit semantischem Ton', () => {
    const t = (k: string) => k;
    const html = renderToStaticMarkup(
      <>
        <InvoicePaymentBadge status="ueberfaellig" translate={t as never} />
        <InvoicePaymentBadge status="bezahlt" translate={t as never} />
        <ExpensePaymentBadge status="teilbezahlt" translate={t as never} />
      </>,
    );
    expect(html).toContain('status-badge invoice-payment-badge invoice-payment-badge--ueberfaellig');
    expect(html).toContain('data-tone="critical"');
    expect(html).toContain('data-tone="success"');
    expect(html).toContain('data-tone="warning"');
    expect(html).toContain('badge__label">payment.status.bezahlt');
  });
});

describe('UIUX-FOUNDATION-01E — Loading (K)', () => {
  it('LoadingState steht als ruhiges Muster bereit', () => {
    const html = renderToStaticMarkup(<LoadingState label="Lädt" count={2} />);
    expect(html).toContain('aria-busy="true"');
    expect((html.match(/skeleton/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});
