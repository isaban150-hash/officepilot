/**
 * REAL-PRODUCT-TEST-01B — Steuerberater-Monatsübersicht und Heute teilen die
 * Wahrheit der Monatsmappe.
 *
 *  A  Monat ohne Belege: count 0, nicht vollständig, Zustand `empty`, nie „bereit"
 *  B  finalisierte Ausgangsrechnung wird gezählt (Rechnungsdatum), Entwurf nicht
 *  C  gebuchte Ausgabe wird gezählt, ihr Eingangsposten nicht doppelt
 *  D  unklarer Eingangsposten / fehlende Unterlage → `open`, nicht vollständig
 *  E  vollständiger Monat → `ready`; ein Beleg ohne Dokument hält ihn offen (wie im Export sichtbar)
 *  F  Heute-Karte und Steuerberater-Seite zeigen dieselbe Semantik
 *  G  Übersicht ≡ Monatsmappenmodell (gleiche Belegmenge)
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import type { Expense } from '../types/expense';
import type { Task, VorgangInvoice } from '../types/models';
import { DEFAULT_SETUP } from '../data/mockData';
import { AuthProvider } from '../context/AuthContext';
import { TestProviders } from '../test/testProviders';
import { hydrateInvoiceStore } from './invoice/invoiceStore';
import { hydrateExpenseStore } from './expenseStore';
import { hydrateTaskStore } from './taskService';
import { processUpload } from './inboxService';
import { getSteuerberaterMonthOverview } from './steuerberaterOverviewService';
import { buildMonatsmappeModel } from './steuerberater/monatsmappeModelService';
import { collectMonatsmappeInput } from './steuerberater/monatsmappeInputService';
import { HomeOpenWork } from '../components/home/HomeOpenWork';
import { SteuerberaterPage } from '../pages/SteuerberaterPage';

const MONTH = '2026-09';
const REF = new Date(2026, 8, 16);

function invoice(overrides: Partial<VorgangInvoice> = {}): VorgangInvoice {
  return {
    id: 'inv-1',
    number: 'RE-2026-001',
    type: 'rechnung',
    positions: [],
    subtotal: 100,
    taxStatus: 'standard_19',
    amount: 119,
    status: 'versendet',
    date: '2026-09-10',
    issueDate: '2026-09-10',
    createdAt: '2026-09-10T10:00:00.000Z',
    customerSnapshot: { name: 'Kunde A', contactPerson: '', street: '', zip: '', city: '', email: '', phone: '' },
    payments: [],
    ...overrides,
  } as VorgangInvoice;
}

function expense(overrides: Partial<Expense> = {}): Expense {
  return {
    id: 'exp-real-1',
    status: 'gebucht',
    category: 'material',
    supplierName: 'Lieferant GmbH',
    invoiceNumber: 'L-100',
    title: 'Material',
    description: '',
    issueDate: '2026-09-12',
    paymentDueDate: null,
    taxStatus: 'standard_19',
    netAmount: 50,
    taxAmount: 9.5,
    grossAmount: 59.5,
    currency: 'EUR',
    paymentStatus: 'offen',
    payments: [],
    positions: [],
    allocations: [],
    isCreditNote: false,
    dedupeKey: 'lieferant gmbh|l-100',
    tags: [],
    digitalFolder: { id: 'dig', name: 'Ausgaben', path: '/Ausgaben/' },
    paperFolder: { folderId: 'f', register: 'A', label: 'x' },
    createdAt: '2026-09-12T10:00:00.000Z',
    updatedAt: '2026-09-12T10:00:00.000Z',
    ...overrides,
  } as Expense;
}

function steuerTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-steuer-1',
    title: 'Kontoauszug September nachreichen',
    description: '',
    status: 'open',
    priority: 'mittel',
    category: 'steuern',
    dueDate: '2026-09-30',
    sourceType: 'manual',
    taskKind: 'steuerberater_export',
    dedupeKey: 'steuer-1',
    autoCreated: false,
    createdAt: '2026-09-01T00:00:00.000Z',
    type: 'steuerberater_export',
    ...overrides,
  } as Task;
}

function overview() {
  return getSteuerberaterMonthOverview(REF, 'de-DE', MONTH);
}

function renderHome(): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <TestProviders initialSetup={DEFAULT_SETUP}>
        <HomeOpenWork />
      </TestProviders>
    </MemoryRouter>,
  );
}

function renderSteuerberater(): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <AuthProvider>
        <TestProviders initialSetup={DEFAULT_SETUP}>
          <SteuerberaterPage />
        </TestProviders>
      </AuthProvider>
    </MemoryRouter>,
  );
}

describe('REAL-PRODUCT-TEST-01B — Monatsübersicht aus dem Monatsmappenmodell', () => {
  it('A: Monat ohne Belege ist leer — nicht vollständig, nicht „bereit"', () => {
    const result = overview();
    expect(result.documentCount).toBe(0);
    expect(result.isComplete).toBe(false);
    expect(result.state).toBe('empty');
    expect(result.completenessPercent).toBe(0);
  });

  it('B: finalisierte Ausgangsrechnung zählt im Monat ihres Rechnungsdatums; Entwürfe nie', () => {
    hydrateInvoiceStore([
      { invoice: invoice(), vorgangId: null },
      { invoice: invoice({ id: 'inv-draft', number: 'ENTWURF', status: 'entwurf' }), vorgangId: null },
      { invoice: invoice({ id: 'inv-aug', number: 'RE-2026-000', issueDate: '2026-08-30', date: '2026-08-30' }), vorgangId: null },
    ]);
    const result = overview();
    expect(result.invoiceCount).toBe(1);
    expect(result.documentCount).toBe(1);
    expect(result.documents[0]).toMatchObject({ id: 'inv-1', kind: 'ausgangsrechnung', route: '/rechnungen/inv-1' });
    expect(result.state).toBe('ready');
  });

  it('C: gebuchte Ausgabe zählt; ihr Eingangsposten wird nicht zusätzlich als unklar geführt', () => {
    const uploaded = processUpload({ kind: 'eingangsrechnung' });
    hydrateExpenseStore([expense({ linkedInboxId: uploaded.id })]);
    const result = overview();
    expect(result.expenseCount).toBe(1);
    expect(result.documents[0]).toMatchObject({ id: 'exp-real-1', kind: 'eingangsbeleg', route: '/ausgaben/exp-real-1' });
    expect(result.unclearDocuments.map((doc) => doc.id)).not.toContain(uploaded.id);
  });

  it('D: unklarer Eingangsposten oder fehlende Unterlage → offen, nicht vollständig', () => {
    hydrateInvoiceStore([{ invoice: invoice(), vorgangId: null }]);
    const uploaded = processUpload({ kind: 'eingangsrechnung' });
    const withUnclear = overview();
    expect(withUnclear.unclearDocuments.map((doc) => doc.id)).toContain(uploaded.id);
    expect(withUnclear.state).toBe('open');
    expect(withUnclear.isComplete).toBe(false);
    expect(withUnclear.openCount).toBe(1);

    hydrateTaskStore([steuerTask()]);
    const withTask = overview();
    expect(withTask.missingCount).toBe(1);
    expect(withTask.openCount).toBe(2);
    expect(withTask.completenessPercent).toBe(33);
  });

  it('E: vollständiger Monat → bereit, 100 %; Beleg ohne Dokument hält ihn offen', () => {
    hydrateInvoiceStore([{ invoice: invoice(), vorgangId: null }, { invoice: invoice({ id: 'inv-2', number: 'RE-2026-003' }), vorgangId: null }]);
    const ready = overview();
    expect(ready.documentCount).toBe(2);
    expect(ready.state).toBe('ready');
    expect(ready.isComplete).toBe(true);
    expect(ready.completenessPercent).toBe(100);

    /* Ausgabe ohne Archivdokument/Datei: im Export als „Dokument fehlt" sichtbar → hier offen. */
    hydrateExpenseStore([expense()]);
    const open = overview();
    expect(open.documentCount).toBe(3);
    expect(open.missingItems.map((m) => m.id)).toContain('exp-real-1');
    expect(open.state).toBe('open');
  });

  it('F: Heute und Steuerberater-Seite zeigen dieselbe Semantik', () => {
    /* leer: neutral, weder Prozent noch „bereit" */
    const emptyHome = renderHome();
    expect(emptyHome).toContain('Noch keine Belege');
    expect(emptyHome).not.toContain('Monatsunterlagen bereit');
    expect(emptyHome).not.toContain('% vollständig');
    const emptyPage = renderSteuerberater();
    expect(emptyPage).not.toContain('Es fehlen noch 0');
    expect(emptyPage).toContain('Noch keine Belege');

    /* offen: konkrete Zahl statt „bereit" */
    hydrateInvoiceStore([{ invoice: invoice(), vorgangId: null }]);
    hydrateTaskStore([steuerTask()]);
    const openHome = renderHome();
    expect(openHome).toContain('1 offenen Punkt prüfen');
    expect(openHome).not.toContain('Monatsunterlagen bereit');
    const openPage = renderSteuerberater();
    expect(openPage).toContain('1 offener Punkt');
    expect(openPage).toContain('1 Beleg in diesem Monat · 1 Ausgangsrechnung · 0 Eingangsbelege · 0 Stornos');
    expect(openPage).not.toMatch(/Beleg\(e\)|Ausgangsrechnung\(en\)|Eingangsbeleg\(e\)|Storno\(s\)/);

    /* bereit */
    hydrateTaskStore([]);
    expect(renderHome()).toContain('Monatsunterlagen bereit');
    const readyPage = renderSteuerberater();
    expect(readyPage).toContain('Vollständig');
    expect(readyPage).not.toContain('✓');
  });

  it('G: Übersicht zählt exakt die Belege des Monatsmappenmodells', () => {
    hydrateInvoiceStore([
      { invoice: invoice(), vorgangId: null },
      { invoice: invoice({ id: 'inv-storno', number: 'RE-2026-002', cancelledAt: '2026-09-14T10:00:00.000Z', cancelReason: 'Doppelt' }), vorgangId: null },
    ]);
    hydrateExpenseStore([expense()]);
    const model = buildMonatsmappeModel(collectMonatsmappeInput(MONTH));
    const result = overview();
    const modelIds = [...model.ausgangsrechnungen, ...model.eingangsbelege, ...model.stornos].map((b) => b.id).sort();
    expect(result.documents.map((d) => d.id).sort()).toEqual(modelIds);
    expect(result.stornoCount).toBe(model.stornos.length);
    expect(result.documentCount).toBe(modelIds.length);
  });
});
