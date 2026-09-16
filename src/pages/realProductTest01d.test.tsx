/**
 * REAL-PRODUCT-TEST-01D — restliche funktionale Browserbefunde (Befund 2–6).
 * (Befund 1 Sync: `syncStatus01d.test.tsx`.)
 *
 *  2  Aufgaben: „Heute" = heute fällig, „Überfällig" getrennt; Heute-Hinweis benennt beides
 *     getrennt; `getTodayIso` nutzt das lokale Kalenderdatum
 *  3  Navigation: neue Hauptseite/Detailseite beginnt oben, echter Rückweg stellt die Position wieder her
 *  4  Aufträge: kanonischer Anlegeweg als Hauptaktion, „Offene Rechnungen" nur Nebenaktion
 *  5  Dokumentarchiv: eigene Ausgangsrechnung zeigt Nummer, Kunde, Datum, Betrag; andere Dokumente unverändert
 *  6  Kunden: gleiche Namen getrennt, unterscheidbar, Altbestand erklärt
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Outlet, Route, Routes, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuthProvider } from '../context/AuthContext';
import { DEFAULT_SETUP } from '../data/mockData';
import { TestProviders } from '../test/testProviders';
import { createOrderPosition, createTestVorgang } from '../test/fixtures';
import { resetTestStores } from '../test/resetStores';
import { KundenPage } from './KundenPage';
import { VorgaengePage } from './VorgaengePage';
import { DokumentePage } from './DokumentePage';
import { getTodayIso } from '../services/taskNormalize';
import { getTasksFiltered } from '../services/taskEngineService';
import { setTaskStoreForTests } from '../services/taskStore';
import { normalizeTask } from '../services/taskNormalize';
import { scanPendingItems } from '../services/pendingEngineService';
import { createCustomer } from '../services/customerService';
import { hydrateVorgangStore, getVorgangInvoice } from '../services/vorgangService';
import { archiveOutgoingInvoice } from '../services/invoiceArchiveService';
import { addDocument, hydrateDocumentStore } from '../services/documentService';
import { useMainScrollRestoration, resetMainScrollPositionsForTests } from '../components/layout/useMainScrollRestoration';
import type { VorgangInvoice } from '../types/models';
import { useRef } from 'react';

let root: Root | null = null;
let container: HTMLDivElement | null = null;
function mount(node: React.ReactElement): HTMLDivElement {
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

function task(id: string, dueDate: string) {
  return normalizeTask({
    id,
    title: `Aufgabe ${id}`,
    description: '',
    status: 'open',
    priority: 'mittel',
    category: 'dokumente',
    type: 'dokument_pruefen',
    dueDate,
    done: false,
  });
}

describe('01D — Befund 2: Aufgaben heute / überfällig', () => {
  beforeEach(() => {
    resetTestStores();
    setTaskStoreForTests([task('t-heute', '2026-09-16'), task('t-alt', '2026-09-07'), task('t-morgen', '2026-09-17')]);
  });

  it('„Heute" enthält nur heute fällige, „Überfällig" nur vergangene Aufgaben', () => {
    expect(getTasksFiltered('heute', '2026-09-16').map((t) => t.id)).toEqual(['t-heute']);
    expect(getTasksFiltered('ueberfaellig', '2026-09-16').map((t) => t.id)).toEqual(['t-alt']);
  });

  it('Heute-Hinweis nennt überfällige Aufgaben nicht „heute fällig"', () => {
    const { summary } = scanPendingItems('2026-09-16');
    expect(summary.dueTasksToday).toBe(1);
    expect(summary.overdueTasks).toBe(1);
    const labels = summary.highlights.filter((h) => h.kind === 'open_tasks').map((h) => h.labelKey);
    expect(labels).toEqual(['pending.highlight.overdueTaskOne', 'pending.highlight.dueTaskTodayOne']);
  });

  it('getTodayIso nutzt das lokale Kalenderdatum (kein UTC-Sprung nach Mitternacht)', () => {
    const local = new Date(2026, 8, 16, 0, 30); // 16.09.2026 00:30 Ortszeit
    expect(getTodayIso(local)).toBe('2026-09-16');
    expect(getTodayIso('2026-09-16T23:59:00.000Z')).toBe('2026-09-16');
  });
});

function Shell() {
  const mainRef = useRef<HTMLElement | null>(null);
  useMainScrollRestoration(mainRef);
  return (
    <main ref={mainRef} data-testid="main" style={{ height: 100, overflowY: 'auto' }}>
      <Outlet />
    </main>
  );
}
let nav: ReturnType<typeof useNavigate> | null = null;
function Page({ name }: { name: string }) {
  nav = useNavigate();
  return <div style={{ height: 2000 }}>{name}</div>;
}

describe('01D — Befund 3: Scrollregel im Inhaltsbereich', () => {
  beforeEach(() => resetMainScrollPositionsForTests());

  it('neue Seite beginnt oben, Rückweg stellt die Position wieder her, Detailseite oben', () => {
    const c = mount(
      <MemoryRouter initialEntries={['/']}>
        <Routes>
          <Route element={<Shell />}>
            <Route path="/" element={<Page name="heute" />} />
            <Route path="/ablage" element={<Page name="eingang" />} />
            <Route path="/dokumente/:id" element={<Page name="detail" />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    const main = c.querySelector<HTMLElement>('[data-testid="main"]')!;
    main.scrollTop = 800;
    act(() => nav!('/ablage'));
    expect(main.scrollTop).toBe(0);
    main.scrollTop = 300;
    act(() => nav!('/dokumente/d-1'));
    expect(main.scrollTop).toBe(0);
    act(() => nav!(-1));
    expect(main.scrollTop).toBe(300);
    act(() => nav!(-1));
    expect(main.scrollTop).toBe(800);
    // gleicher Pfad, nur Query: Position bleibt
    main.scrollTop = 150;
    act(() => nav!('/?step=2'));
    expect(main.scrollTop).toBe(150);
  });
});

describe('01D — Befund 4: Aufträge — Hauptaktion', () => {
  beforeEach(() => {
    resetTestStores();
    hydrateVorgangStore([createTestVorgang({ id: 'v-1', title: 'Bad Nord', customer: 'Kunde A' })]);
  });

  it('kanonischer Anlegeweg ist Hauptaktion, offene Rechnungen nur Nebenaktion', () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <TestProviders initialSetup={DEFAULT_SETUP}>
          <VorgaengePage />
        </TestProviders>
      </MemoryRouter>,
    );
    expect(html).toMatch(/page-header__primary[^]*?href="\/dokumente\/hinzufuegen"[^]*?Auftrag aus Dokument anlegen/);
    expect(html).toMatch(/page-header__secondary[^]*?href="\/rechnungen\/offen"/);
    expect(html).not.toMatch(/page-header__primary[^]*?Offene Rechnungen anzeigen/);
    expect(html).toContain('data-testid="vorgaenge-new-from-document"');
  });
});

function ownInvoice(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: 'inv-d-1',
    number: '2026-0012',
    type: 'rechnung',
    positions: [{ id: 'l1', orderPositionId: 'op-1', description: 'Sanierung', quantity: 1, unit: 'psch', unitPrice: 1000, lineTotal: 1000 }],
    subtotal: 1000,
    taxStatus: 'standard_19',
    amount: 1190,
    status: 'versendet',
    date: '2026-09-07',
    issueDate: '2026-09-07',
    createdAt: '2026-09-07T10:00:00.000Z',
    paymentDueDate: '2026-09-21',
    paymentStatus: 'offen',
    payments: [],
    legalNotices: [],
    previousAbschlagDeductions: [],
    customerSnapshot: { name: 'Cirmak Haustechnik GmbH', contactPerson: '', street: 'Weg 1', zip: '45356', city: 'Essen', email: '', phone: '' },
    ...overrides,
  } as VorgangInvoice;
}

describe('01D — Befund 5: Dokumentarchiv — eigene Ausgangsrechnung unterscheidbar', () => {
  beforeEach(() => {
    resetTestStores();
    hydrateDocumentStore([]);
  });

  it('zeigt Nummer, Kunde, Rechnungsdatum und Betrag; andere Dokumente bleiben wie bisher', () => {
    hydrateVorgangStore([
      {
        ...createTestVorgang({
          id: 'v-d',
          title: 'TEST M5 Neuer Auftrag V4',
          customer: 'Cirmak Haustechnik GmbH',
          orderPositions: [createOrderPosition({ id: 'op-1', unit: 'psch', plannedQuantity: 1, unitPrice: 1000 })],
        }),
        invoices: [ownInvoice(), ownInvoice({ id: 'inv-d-2', number: '2026-0013', amount: 595, subtotal: 500, issueDate: '2026-09-09', date: '2026-09-09' })],
      },
    ]);
    const archived1 = archiveOutgoingInvoice('v-d', getVorgangInvoice('v-d', 'inv-d-1')!, 'Test GmbH');
    const archived2 = archiveOutgoingInvoice('v-d', getVorgangInvoice('v-d', 'inv-d-2')!, 'Test GmbH');
    expect(archived1.success && archived2.success).toBe(true);
    const letter = addDocument({
      title: 'Schreiben Finanzamt',
      category: 'behoerde',
      issuer: 'Finanzamt Essen',
      recognizedText: 'Steuerbescheid 2025',
      issueDate: '2026-09-01',
      classifiedKind: 'steuerbescheid',
      archived: true,
    });
    expect(letter.success).toBe(true);

    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={['/dokumente']}>
        <AuthProvider>
          <TestProviders initialSetup={DEFAULT_SETUP}>
            <DokumentePage />
          </TestProviders>
        </AuthProvider>
      </MemoryRouter>,
    );
    expect(html).toContain('Rechnung 2026-0012');
    expect(html).toContain('Rechnung 2026-0013');
    expect(html).toContain('Cirmak Haustechnik GmbH · 7.9.2026');
    expect(html).toContain('Cirmak Haustechnik GmbH · 9.9.2026');
    expect(html).toMatch(/1\.190,00\s?€/);
    expect(html).toMatch(/595,00\s?€/);
    expect(html).toContain('TEST M5 Neuer Auftrag V4');
    // Fremddokument unverändert: Absender · Datum, kein Betrag, kein Rechnungstitel
    expect(html).toContain('Finanzamt Essen');
    expect(html).not.toContain('Rechnung Finanzamt');
  });
});

describe('01D — Befund 6: Kunden — gleiche Namen unterscheidbar', () => {
  beforeEach(() => resetTestStores());

  it('gleichnamige Kunden bleiben getrennt und zeigen Merkmale; Altbestand wird erklärt', () => {
    const a = createCustomer({ name: 'Müller Bau GmbH', contactPerson: 'Anna Müller', street: 'Industrieweg 3', zip: '80331', city: 'München', email: 'anna@mueller.example', phone: '' });
    const b = createCustomer(
      { name: 'Müller Bau GmbH', contactPerson: 'Bernd Müller', street: 'Seeufer 9', zip: '88131', city: 'Lindau', email: 'bernd@mueller.example', phone: '' },
      { allowDuplicate: true },
    );
    expect(a.success && b.success).toBe(true);
    if (!a.success || !b.success) return;
    hydrateVorgangStore([
      createTestVorgang({ id: 'v-a', title: 'Bad A', customer: 'Müller Bau GmbH', customerId: a.customer.id }),
      createTestVorgang({ id: 'v-b', title: 'Bad B', customer: 'Müller Bau GmbH', customerId: b.customer.id }),
      createTestVorgang({ id: 'v-legacy', title: 'Alt', customer: 'Müller Bau GmbH' }),
    ]);
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <TestProviders initialSetup={DEFAULT_SETUP}>
          <KundenPage />
        </TestProviders>
      </MemoryRouter>,
    );
    expect(html).toContain(`kunde-customer-${a.customer.id}`);
    expect(html).toContain(`kunde-customer-${b.customer.id}`);
    expect(html).toContain('Industrieweg 3, 80331 München');
    expect(html).toContain('Seeufer 9, 88131 Lindau');
    expect(html).toContain('anna@mueller.example');
    expect(html).toContain('bernd@mueller.example');
    expect(html).toContain('Altbestand');
    expect(html).toContain('Wird getrennt geführt');
    expect((html.match(/Müller Bau GmbH/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });
});
