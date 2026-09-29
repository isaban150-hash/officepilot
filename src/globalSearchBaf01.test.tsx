/**
 * BROWSER-ACCEPTANCE-FIX 01 / A2 — globale Suche `/suche`.
 *
 * Kunden als eigener Treffer, E-Mails aus der Cloud (workspace-gebunden),
 * Relevanz (starke Namenstreffer vor schwachen Teiltreffern), deutsche Daten,
 * unterscheidbare Rechnungsbelege, Klartext-Status statt technischer Werte.
 *
 * Neutrale Beispieldaten, kein Netzwerk.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { AppProvider } from './context/AppContext';
import { DEFAULT_SETUP } from './data/mockData';
import { SearchPage } from './components/search/GlobalSearchBar';
import {
  buildEmailSearchResults,
  germanizeIsoDates,
  mergeSearchResults,
  searchOffice,
  searchStatusLabel,
} from './services/officeSearchService';
import { searchCloudEmails, type EmailSearchDeps } from './services/search/emailSearchSource';
import { hydrateCustomerStore } from './services/customerStoreService';
import { hydrateVorgangStore, getVorgangInvoice } from './services/vorgangService';
import { archiveOutgoingInvoice } from './services/invoiceArchiveService';
import { setTaskStoreForTests } from './services/taskStore';
import { normalizeTask } from './services/taskNormalize';
import { resetTestStores } from './test/resetStores';
import { createOrderPosition, createTestVorgang } from './test/fixtures';
import type { Customer, Vorgang, VorgangInvoice } from './types/models';
import type { EmailMessage } from './types/emailMessage';
import type { SearchResult } from './types/officeSearch';

const WS = 'ws-eigen';
const TODAY = '2026-09-28';

function customer(id: string, name: string, extra: Partial<Customer> = {}): Customer {
  return {
    id,
    name,
    contactPerson: '',
    street: 'Testweg 13',
    zip: '33602',
    city: 'Bielefeld',
    email: '',
    phone: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  } as Customer;
}

function invoice(id: string, number: string, status: VorgangInvoice['status'] = 'versendet'): VorgangInvoice {
  return {
    id,
    number,
    type: 'rechnung',
    positions: [
      { id: 'l1', orderPositionId: 'op-1', description: 'Arbeit', quantity: 1, unit: 'Stk', unitPrice: 100, lineTotal: 100 },
    ],
    subtotal: 100,
    taxStatus: 'standard_19',
    amount: 119,
    status,
    date: '2026-09-22',
    issueDate: '2026-09-22',
    createdAt: '2026-09-22T10:00:00.000Z',
    paymentDueDate: '2026-09-01',
    paymentStatus: 'offen',
    payments: [],
    legalNotices: [],
    previousAbschlagDeductions: [],
  } as VorgangInvoice;
}

function vorgang(id: string, title: string, customerName: string, invoices: VorgangInvoice[] = []): Vorgang {
  return {
    ...createTestVorgang({
      id,
      title,
      status: 'beauftragt',
      customer: customerName,
      orderPositions: [createOrderPosition({ id: 'op-1', unit: 'Stk', plannedQuantity: 1, unitPrice: 100 })],
    }),
    invoices,
  } as Vorgang;
}

function seedCompany(): void {
  hydrateCustomerStore([
    customer('c-az', 'AZ Testbau GmbH'),
    customer('c-m5', 'M5 Testbau GmbH'),
    customer('c-resume', 'Resume Testbau GmbH', { contactPerson: 'Frau Beispiel' }),
    customer('c-weg', 'Resume Testbau Alt GmbH', { sync: { deleted: true } } as Partial<Customer>),
  ]);
  hydrateVorgangStore([
    vorgang('v-az-1', 'Dach AZ', 'AZ Testbau GmbH', [invoice('inv-18', '2026-0018')]),
    vorgang('v-az-2', 'Fassade AZ', 'AZ Testbau GmbH'),
    vorgang('v-m5', 'Neubau M5', 'M5 Testbau GmbH'),
    vorgang('v-resume', 'TEST Mobile Resume §13b', 'Resume Testbau GmbH'),
  ]);
}

function email(overrides: Partial<EmailMessage>): EmailMessage {
  return {
    id: 'mail-x',
    workspaceId: WS,
    clientMessageId: 'cm-x',
    to: ['kunde@example.invalid'],
    cc: [],
    bcc: [],
    subject: '',
    bodyText: '',
    senderName: 'Betrieb',
    replyToEmail: 'betrieb@example.invalid',
    provider: 'brevo',
    status: 'sent',
    createdAt: '2026-09-25T08:15:00.000Z',
    attemptNumber: 1,
    rowVersion: 1,
    attachments: [],
    direction: 'outbound',
    hasHtml: false,
    skippedAttachments: [],
    ...overrides,
  } as EmailMessage;
}

const INBOUND = email({
  id: 'in-1',
  direction: 'inbound',
  subject: 'Re: OfficeTakt 07E Testmail',
  fromName: 'Saban',
  fromAddress: 'absender@example.invalid',
  bodyText: 'Hallo, hier die Antwort mit Materialliste.',
  receivedAt: '2026-09-26T09:30:00.000Z',
});
const OUTBOUND = email({ id: 'out-1', subject: 'OfficeTakt 07E Testmail', bodyText: 'Guten Tag' });
const OTHER = email({ id: 'out-2', subject: 'Angebot Dach', bodyText: 'Materialliste anbei' });

describe('BROWSER-ACCEPTANCE-FIX 01 / A2 — Suchdienst', () => {
  beforeEach(() => {
    resetTestStores();
    seedCompany();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resetTestStores();
  });

  it('A2-1: Kunde ist eigener Treffertyp, ohne Kennung, mit Weg zum Kunden', () => {
    const results = searchOffice({ query: 'Resume Testbau', todayIso: TODAY, limit: 40 });
    const hit = results.find((result) => result.type === 'customer');
    expect(hit).toBeDefined();
    expect(hit!.title).toBe('Resume Testbau GmbH');
    expect(hit!.source).toBe('Kunde');
    expect(hit!.route).toBe('/kunden/customer/c-resume');
    expect(`${hit!.title} ${hit!.subtitle} ${hit!.snippet}`).not.toMatch(/c-resume/);
  });

  it('A2-2: Ranking — starker Namenstreffer vor schwachen Teiltreffern', () => {
    const results = searchOffice({ query: 'Resume Testbau', todayIso: TODAY, limit: 40 });
    const titles = results.map((result) => `${result.type}:${result.title}`);
    // Der Kunde selbst steht ganz oben.
    expect(titles[0]).toBe('customer:Resume Testbau GmbH');
    // Der Auftrag von Resume Testbau vor allen Aufträgen, die nur „Testbau" teilen.
    const resumeOrder = titles.indexOf('vorgang:TEST Mobile Resume §13b');
    const weakOrders = ['vorgang:Dach AZ', 'vorgang:Fassade AZ', 'vorgang:Neubau M5'].map((t) => titles.indexOf(t));
    expect(resumeOrder).toBeGreaterThanOrEqual(0);
    for (const weak of weakOrders.filter((index) => index >= 0)) expect(resumeOrder).toBeLessThan(weak);
    // Schwache Treffer bleiben auffindbar, nur weiter hinten.
    expect(titles).toContain('customer:AZ Testbau GmbH');
    expect(titles.indexOf('customer:AZ Testbau GmbH')).toBeGreaterThan(titles.indexOf('customer:Resume Testbau GmbH'));
  });

  it('A2-3: gelöschte Kunden erscheinen nicht; leere Anfrage liefert keine Kunden', () => {
    const results = searchOffice({ query: 'Resume Testbau Alt', todayIso: TODAY, limit: 40 });
    expect(results.some((result) => result.title === 'Resume Testbau Alt GmbH')).toBe(false);
    // Die leere Anfrage behandelt die Seite selbst (A2-UI-5); Kunden listet sie nie auf.
    expect(searchOffice({ query: '', todayIso: TODAY, limit: 100 }).some((r) => r.type === 'customer')).toBe(false);
  });

  it('A2-4: Gross-/Kleinschreibung und Sonderzeichen', () => {
    for (const query of ['RESUME testbau', 'resume testbau!', '  Resume   Testbau  ', '„Resume Testbau"']) {
      const results = searchOffice({ query, todayIso: TODAY, limit: 40 });
      expect(results[0]?.title, query).toBe('Resume Testbau GmbH');
    }
    // Sonderzeichen allein werfen nicht und finden nichts Erfundenes.
    expect(() => searchOffice({ query: '%$§&*()[]', todayIso: TODAY })).not.toThrow();
    expect(() => searchOffice({ query: '.*+?^${}()|[]\\', todayIso: TODAY })).not.toThrow();
  });

  it('A2-5: Rechnungen bleiben per Nummer auffindbar und unterscheidbar', () => {
    const results = searchOffice({ query: '2026-0018', todayIso: TODAY, limit: 40 });
    const invoiceHit = results.find((result) => result.type === 'invoice');
    expect(invoiceHit?.title).toBe('Rechnung 2026-0018');
    // Der Archivbeleg trägt die Nummer im Titel.
    const v = getVorgangInvoice('v-az-1', 'inv-18')!;
    const archived = archiveOutgoingInvoice('v-az-1', v, 'Test GmbH');
    expect(archived.success).toBe(true);
    const after = searchOffice({ query: '2026-0018', todayIso: TODAY, limit: 40 });
    const docHit = after.find((result) => result.type === 'document');
    expect(docHit?.title).toContain('2026-0018');
  });

  it('A2-6: deutsche Daten statt ISO, Klartext-Status statt Rohwert', () => {
    setTaskStoreForTests([
      normalizeTask({
        id: 't-1',
        title: 'Zahlung prüfen Resume',
        status: 'open',
        priority: 'kritisch',
        dueDate: '2026-09-21',
      }),
    ]);
    const results = searchOffice({ query: 'Resume', todayIso: TODAY, limit: 40 });
    const task = results.find((result) => result.type === 'task');
    expect(task?.subtitle).toBe('Frist 21.09.2026');
    expect(task?.statusLabel).toBe('Priorität kritisch');

    const invoiceHit = searchOffice({ query: '2026-0018', todayIso: TODAY, limit: 40 }).find(
      (result) => result.type === 'invoice',
    );
    expect(invoiceHit?.status).toBe('ueberfaellig');
    expect(invoiceHit?.statusLabel).toBe('Überfällig');

    for (const result of results) {
      expect(`${result.title} ${result.subtitle} ${result.snippet}`).not.toMatch(/\b\d{4}-\d{2}-\d{2}\b/);
    }

    expect(germanizeIsoDates('Datum: 2026-09-22 · Nr. 2026-0018 · 2026-09-25T08:15:00.000Z')).toBe(
      'Datum: 22.09.2026 · Nr. 2026-0018 · 25.09.2026',
    );
    expect(searchStatusLabel('in_bearbeitung')).toBe('In Bearbeitung');
    expect(searchStatusLabel('irgendein_rohwert')).toBeUndefined();
    expect(searchStatusLabel('Antwort offen')).toBe('Antwort offen');
  });

  it('A2-7: E-Mail per Betreff — Eingang und Gesendet mit richtigem Ziel', () => {
    const results = buildEmailSearchResults([INBOUND, OUTBOUND, OTHER], 'Testmail');
    expect(results.map((result) => result.route).sort()).toEqual([
      '/kommunikation/eingang/in-1',
      '/kommunikation/email/out-1',
    ]);
    const inbound = results.find((result) => result.route.endsWith('in-1'))!;
    expect(inbound.type).toBe('email');
    expect(inbound.source).toBe('E-Mail');
    expect(inbound.title).toBe('Re: OfficeTakt 07E Testmail');
    expect(inbound.subtitle).toBe('Von Saban · 26.09.2026, 11:30');
    // Kein Nachrichtentext, keine Kennung in der Anzeige.
    const shown = results.map((result) => `${result.title} ${result.subtitle} ${result.snippet}`).join(' ');
    expect(shown).not.toContain('Materialliste');
    expect(shown).not.toMatch(/in-1|out-1|cm-x/);
  });

  it('A2-8: E-Mail per Absender und per Text', () => {
    expect(buildEmailSearchResults([INBOUND, OUTBOUND, OTHER], 'Saban').map((r) => r.route)).toEqual([
      '/kommunikation/eingang/in-1',
    ]);
    // Die vollständige Adresse steht vorn, auch wenn die Domain überall vorkommt.
    expect(buildEmailSearchResults([OUTBOUND, OTHER, INBOUND], 'absender@example.invalid')[0]?.route).toBe(
      '/kommunikation/eingang/in-1',
    );
    const byBody = buildEmailSearchResults([INBOUND, OUTBOUND, OTHER], 'Materialliste');
    expect(byBody.map((r) => r.route).sort()).toEqual(['/kommunikation/eingang/in-1', '/kommunikation/email/out-2']);
    expect(byBody.every((r) => r.matchedField === 'Text der E-Mail')).toBe(true);
    // Betreff-Treffer stehen vor reinen Text-Treffern.
    const mixed = buildEmailSearchResults([OTHER, OUTBOUND], 'Angebot Dach');
    expect(mixed[0]?.route).toBe('/kommunikation/email/out-2');
  });

  it('A2-9: Workspace-Grenze, fehlende Cloud und Fehler — keine fremden oder erfundenen Treffer', async () => {
    const foreign = email({ ...INBOUND, id: 'fremd-1', workspaceId: 'ws-fremd' });
    const listInbound = vi.fn(async () => ({ ok: true as const, messages: [INBOUND, foreign] }));
    const listSent = vi.fn(async () => ({ ok: true as const, messages: [OUTBOUND] }));
    const deps: EmailSearchDeps = {
      isConfigured: () => true,
      resolveWorkspaceId: () => WS,
      listInbound,
      listSent,
    };

    const results = await searchCloudEmails('Testmail', deps);
    expect(results.map((r) => r.route).sort()).toEqual(['/kommunikation/eingang/in-1', '/kommunikation/email/out-1']);
    // Geladen wird nur der eigene Workspace.
    expect(listInbound).toHaveBeenCalledWith(WS);
    expect(listSent).toHaveBeenCalledWith(WS);

    expect(await searchCloudEmails('Testmail', { ...deps, isConfigured: () => false })).toEqual([]);
    expect(await searchCloudEmails('Testmail', { ...deps, resolveWorkspaceId: () => null })).toEqual([]);
    expect(
      await searchCloudEmails('Testmail', {
        ...deps,
        listInbound: async () => ({ ok: false, error: 'forbidden' as never }),
        listSent: async () => {
          throw new Error('offline');
        },
      }),
    ).toEqual([]);
    listInbound.mockClear();
    expect(await searchCloudEmails(' ', deps)).toEqual([]);
    expect(await searchCloudEmails('a', deps)).toEqual([]);
    expect(listInbound).not.toHaveBeenCalled();
  });

  it('A2-10: Zusammenführung — nach Relevanz, ohne Doppelte, mit Obergrenze', () => {
    const local = searchOffice({ query: 'Testmail', todayIso: TODAY, limit: 40 });
    const emails = buildEmailSearchResults([INBOUND, OUTBOUND], 'Testmail');
    const merged = mergeSearchResults(local, [...emails, ...emails], 40);
    expect(merged.filter((r) => r.type === 'email')).toHaveLength(2);
    expect(mergeSearchResults(local, emails, 1)).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------ */
/* Seite                                                                */
/* ------------------------------------------------------------------ */

type Mount = { container: HTMLDivElement; root: Root };

function LocationProbe() {
  const location = useLocation();
  return createElement('div', { 'data-testid': 'location' }, location.pathname);
}

async function mountSearch(query: string, searchEmails: (q: string) => Promise<SearchResult[]>): Promise<Mount> {
  const container = window.document.createElement('div');
  window.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: [`/suche?q=${encodeURIComponent(query)}`] },
        createElement(
          AppProvider,
          { initialSetup: { ...DEFAULT_SETUP, setupComplete: true } },
          createElement(
            Routes,
            null,
            createElement(Route, { path: '/suche', element: createElement(SearchPage, { searchEmails }) }),
            createElement(Route, { path: '*', element: createElement(LocationProbe) }),
          ),
        ),
      ),
    );
  });
  for (let i = 0; i < 10; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  return { container, root };
}

function unmount(mount: Mount): void {
  act(() => mount.root.unmount());
  mount.container.remove();
}

describe('BROWSER-ACCEPTANCE-FIX 01 / A2 — Suchseite', () => {
  beforeEach(() => {
    resetTestStores();
    seedCompany();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    resetTestStores();
  });

  it('A2-UI-1: Kunde oben, Klick öffnet den Kunden', async () => {
    const mount = await mountSearch('Resume Testbau', async () => []);
    const first = mount.container.querySelector('[data-testid^="search-result-"]') as HTMLButtonElement;
    expect(first.textContent).toContain('Resume Testbau GmbH');
    expect(first.textContent).toContain('Kunde');
    await act(async () => first.click());
    expect(mount.container.querySelector('[data-testid="location"]')?.textContent).toBe('/kunden/customer/c-resume');
    unmount(mount);
  });

  it('A2-UI-2: E-Mail-Treffer erscheint, Klick öffnet die E-Mail', async () => {
    const searchEmails = vi.fn(async (q: string) => buildEmailSearchResults([INBOUND, OUTBOUND], q));
    const mount = await mountSearch('Testmail', searchEmails);
    expect(searchEmails).toHaveBeenCalledWith('Testmail');
    const button = mount.container.querySelector('[data-testid="search-result-search-email-in-1"]') as HTMLButtonElement;
    expect(button).not.toBeNull();
    expect(button.textContent).toContain('Re: OfficeTakt 07E Testmail');
    expect(button.textContent).toContain('E-Mail');
    await act(async () => button.click());
    expect(mount.container.querySelector('[data-testid="location"]')?.textContent).toBe('/kommunikation/eingang/in-1');
    unmount(mount);
  });

  it('A2-UI-3: keine technischen Statuswerte und keine ISO-Daten in der Liste', async () => {
    const mount = await mountSearch('Testbau', async () => []);
    const text = [...mount.container.querySelectorAll('[data-testid^="search-result-"]')]
      .map((node) => node.textContent ?? '')
      .join('\n');
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toMatch(/ueberfaellig|in_bearbeitung|beauftragt\b/);
    expect(text).not.toMatch(/\b\d{4}-\d{2}-\d{2}\b/);
    unmount(mount);
  });

  it('A2-UI-5: leere Anfrage — Hinweis statt Treffer, keine E-Mail-Abfrage', async () => {
    const searchEmails = vi.fn(async () => [] as SearchResult[]);
    const mount = await mountSearch('', searchEmails);
    expect(mount.container.querySelector('[data-testid="search-empty-query"]')).not.toBeNull();
    expect(mount.container.querySelectorAll('[data-testid^="search-result-"]').length).toBe(0);
    expect(searchEmails).not.toHaveBeenCalled();
    unmount(mount);
  });

  it('A2-UI-4: fehlschlagende E-Mail-Quelle lässt die übrige Suche stehen', async () => {
    const mount = await mountSearch('Resume Testbau', async () => {
      throw new Error('offline');
    });
    expect(mount.container.querySelectorAll('[data-testid^="search-result-"]').length).toBeGreaterThan(0);
    unmount(mount);
  });
});
