/**
 * MANUAL-INVOICE-UI-01B1B — die sichtbare Rechnung ohne Auftrag.
 *
 * Kunde → Positionen → Rechnungsdetails → Prüfen und Freigeben, über die
 * dauerhafte Entwurfssitzung (IndexedDB-Attrappe) und den bestehenden
 * Coordinator. Der Coordinator wird hier als Attrappe beobachtet: Was die
 * Seite ihm übergibt und **in welcher Reihenfolge** (Flush vor Finalize),
 * ist der Vertrag dieses Blocks; sein Inneres deckt 01B1A ab.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { DEFAULT_SETUP } from '../data/mockData';
import { DEFAULT_COMPANY_PROFILE } from '../data/companyProfileDefaults';
import { AppProvider } from '../context/AppContext';
import { ManualInvoicePage } from './ManualInvoicePage';
import { OffeneRechnungenPage } from './OffeneRechnungenPage';
import { hydrateCompanyProfileStore } from '../services/companyProfileService';
import { createCustomer } from '../services/customerService';
import { getCustomerStoreSnapshot, hydrateCustomerStore } from '../services/customerStoreService';
import { hydrateVorgangStore } from '../services/vorgangService';
import {
  loadInvoiceDraftRecordByLocator,
  resetInvoiceDraftDurabilityDatabaseForTests,
} from '../services/invoice/invoiceDraftDurabilityService';
import * as durability from '../services/invoice/invoiceDraftDurabilityService';
import * as coordinator from '../services/invoice/invoiceFinalizationCoordinator';
import * as scopeService from '../services/storage/storageScopeService';
import * as workspacePayload from '../services/workspace/workspaceSyncPayloadService';
import { resolveHeuteQuickActionRoute } from '../services/officeActionService';
import { hydrateInvoiceStore, resetInvoiceStore } from '../services/invoice/invoiceStore';
import { resetTestStores } from '../test/resetStores';
import type { InvoiceDraftLocator } from '../types/invoiceDraftDurability';
import type { Customer, VorgangInvoice } from '../types/models';

const WORKSPACE = 'ws-manual-ui';

type Mount = { container: HTMLDivElement; root: Root };

function locator(): InvoiceDraftLocator {
  return { sourceScopeKey: `workspace:${WORKSPACE}`, workspaceId: WORKSPACE, vorgangId: null, invoiceType: 'rechnung' };
}

function LocationProbe() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <div data-testid="location" data-path={location.pathname} data-search={location.search}>
      <button type="button" data-testid="history-back" onClick={() => navigate(-1)} />
      <button type="button" data-testid="history-forward" onClick={() => navigate(1)} />
    </div>
  );
}

async function renderPage(entry = '/rechnungen/neu'): Promise<Mount> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  const tree = (
    <MemoryRouter initialEntries={[entry]}>
      <AppProvider initialSetup={{ ...DEFAULT_SETUP, setupComplete: true, companyName: 'Beispiel Betrieb GmbH' }}>
        <Routes>
          <Route path="/rechnungen/neu" element={<ManualInvoicePage />} />
          <Route path="/rechnungen/offen" element={<OffeneRechnungenPage />} />
          {/* 01B2 — die globale Detailroute; die Seite selbst prüft invoiceDetailPage01b2. */}
          <Route path="/rechnungen/:invoiceId" element={<div data-testid="detail-stub" />} />
          <Route path="/vorgaenge" element={<div data-testid="vorgaenge" />} />
        </Routes>
        <LocationProbe />
      </AppProvider>
    </MemoryRouter>
  );
  await act(async () => {
    root = createRoot(container);
    root.render(tree);
    await Promise.resolve();
  });
  return { container, root };
}

/** Wartet, bis die Bedingung gilt — und schweigt beim Timeout **nicht**. */
async function waitFor(check: () => boolean, rounds = 80, label = ''): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    if (check()) return;
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
  }
  throw new Error(`waitFor: Bedingung nicht erfüllt ${label} — ${check.toString().slice(0, 120)}`);
}

const q = <T extends Element = HTMLElement>(mount: Mount, testId: string) =>
  mount.container.querySelector<T>(`[data-testid="${testId}"]`);

function setValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(element, value);
  element.dispatchEvent(new Event('input', { bubbles: true }));
}

async function click(mount: Mount, testId: string): Promise<void> {
  const element = q<HTMLButtonElement>(mount, testId);
  if (!element) throw new Error(`fehlt: ${testId}`);
  await act(async () => {
    element.click();
    await Promise.resolve();
  });
}

async function type(mount: Mount, testId: string, value: string): Promise<void> {
  const element = q<HTMLInputElement>(mount, testId);
  if (!element) throw new Error(`fehlt: ${testId}`);
  await act(async () => {
    setValue(element, value);
    await Promise.resolve();
  });
}

async function selectRadio(mount: Mount, testId: string): Promise<void> {
  const label = q(mount, testId);
  const input = label?.querySelector<HTMLInputElement>('input');
  if (!input) throw new Error(`fehlt: ${testId}`);
  await act(async () => {
    input.click();
    await Promise.resolve();
  });
}

function seedCustomer(): Customer {
  const created = createCustomer({ name: 'Müller Bau GmbH', street: 'Hauptstraße 12', zip: '45356', city: 'Essen' });
  if (!created.success) throw new Error(created.errorKey);
  return created.customer;
}

/** Kunde wählen, eine Position eintragen, Leistungszeitraum setzen — bis zur Prüfung. */
async function walkToReview(mount: Mount, customer: Customer): Promise<void> {
  await waitFor(() => q(mount, 'manual-invoice-step-customer') !== null);
  await selectRadio(mount, 'customer-decision-existing');
  await selectRadio(mount, `customer-option-${customer.id}`);
  await click(mount, 'manual-invoice-next');
  await waitFor(() => q(mount, 'manual-positions-editor') !== null);
  await type(mount, 'manual-position-description', 'Anfahrt und Kleinreparatur');
  await type(mount, 'manual-position-quantity', '1');
  await type(mount, 'manual-position-unit-price', '45');
  await click(mount, 'manual-position-commit');
  await waitFor(() => q(mount, 'manual-position-0') !== null);
  await click(mount, 'manual-invoice-next');
  await waitFor(() => q(mount, 'manual-invoice-step-details') !== null);
  await type(mount, 'invoice-edit-service-from', '2026-09-01');
  await type(mount, 'invoice-edit-service-to', '2026-09-05');
  await click(mount, 'manual-invoice-next');
  await waitFor(() => q(mount, 'manual-invoice-step-review') !== null);
  // Der gespeicherte Stand ist die Wahrheit für die Freigabe.
  await waitFor(() => q(mount, 'invoice-approve') !== null);
}

beforeEach(async () => {
  vi.restoreAllMocks();
  localStorage.clear();
  resetTestStores();
  resetInvoiceStore();
  hydrateVorgangStore([]);
  hydrateCustomerStore([]);
  await resetInvoiceDraftDurabilityDatabaseForTests();
  scopeService.setActiveStorageScope({ type: 'workspace', workspaceId: WORKSPACE });
  hydrateCompanyProfileStore({
    ...DEFAULT_COMPANY_PROFILE,
    companyName: 'Beispiel Betrieb GmbH',
    street: 'Werkstraße 2',
    zip: '54321',
    city: 'Betriebsstadt',
    taxNumber: '11/222/33333',
  });
  vi.spyOn(workspacePayload, 'resolveCloudWorkspaceId').mockReturnValue(WORKSPACE);
});

afterEach(async () => {
  vi.restoreAllMocks();
  document.body.innerHTML = '';
  await resetInvoiceDraftDurabilityDatabaseForTests();
  resetTestStores();
});

describe('01B1B — Einstieg', () => {
  it('L1/L2: /rechnungen/neu routet, die Übersicht trägt „Neue Rechnung"', async () => {
    const overview = await renderPage('/rechnungen/offen');
    await waitFor(() => q(overview, 'overview-new-invoice') !== null);
    await click(overview, 'overview-new-invoice');
    await waitFor(() => q(overview, 'manual-invoice-progress') !== null);
    expect(q(overview, 'location')?.getAttribute('data-path')).toBe('/rechnungen/neu');
    expect(q(overview, 'manual-invoice-progress')?.textContent).toBe('1/4');
  });

  it('L3: die Quick-Action fällt ohne laufende Rechnung und aktiven Vorgang auf /rechnungen/neu zurück', () => {
    expect(resolveHeuteQuickActionRoute('heute.action.writeInvoice')).toBe('/rechnungen/neu');
  });
});

describe('01B1B — Schritt 1 Kunde', () => {
  it('L4/L7: ein bestehender Kunde landet mit Kennung und Snapshot im Entwurf und überlebt den Remount', async () => {
    const customer = seedCustomer();
    const first = await renderPage();
    await waitFor(() => q(first, 'manual-invoice-step-customer') !== null);
    expect(q(first, 'customer-decision-none'), 'V1 hat Kundenpflicht — „kein Kunde" darf es nicht geben').toBeNull();

    await selectRadio(first, 'customer-decision-existing');
    await selectRadio(first, `customer-option-${customer.id}`);
    await click(first, 'manual-invoice-next');
    await waitFor(() => q(first, 'manual-invoice-step-positions') !== null);

    await waitForStoredDraft((draft) => draft.customerId === customer.id);
    const stored = await loadInvoiceDraftRecordByLocator(locator());
    expect(stored.ok && stored.draft.customerId).toBe(customer.id);
    expect(stored.ok && stored.draft.customerBilling.name).toBe('Müller Bau GmbH');
    expect(stored.ok && stored.draft.vorgangId).toBeNull();

    // Remount = Reload: der Kunde ist wieder da, der Schritt aus der Adresse wird geprüft.
    await act(async () => first.root.unmount());
    const second = await renderPage('/rechnungen/neu?step=customer');
    await waitFor(() => q(second, 'manual-invoice-customer-chosen') !== null);
    expect(q(second, 'manual-invoice-customer-chosen')?.textContent).toContain('Müller Bau GmbH');
  });

  it('L5: ein neuer Kunde wird als Stammsatz angelegt und mit seiner echten Kennung übernommen', async () => {
    const mount = await renderPage();
    await waitFor(() => q(mount, 'manual-invoice-step-customer') !== null);
    await selectRadio(mount, 'customer-decision-new');
    await type(mount, 'manual-invoice-customer-name', 'Neu Bau GmbH');
    await type(mount, 'customer-decision-city', 'Bochum');
    await click(mount, 'manual-invoice-next');
    await waitFor(() => q(mount, 'manual-invoice-step-positions') !== null);

    const customers = getCustomerStoreSnapshot();
    expect(customers).toHaveLength(1);
    expect(customers[0]!.name).toBe('Neu Bau GmbH');
    await waitForStoredDraft((draft) => draft.customerId === customers[0]!.id);
    const stored = await loadInvoiceDraftRecordByLocator(locator());
    expect(stored.ok && stored.draft.customerId).toBe(customers[0]!.id);
    expect(stored.ok && stored.draft.customerBilling.city).toBe('Bochum');
  });

  it('L7b: Verlauf zurück/vor führt zum vorherigen/nächsten Schritt, ohne Datenverlust', async () => {
    const customer = seedCustomer();
    const mount = await renderPage();
    await waitFor(() => q(mount, 'manual-invoice-step-customer') !== null);
    await selectRadio(mount, 'customer-decision-existing');
    await selectRadio(mount, `customer-option-${customer.id}`);
    await click(mount, 'manual-invoice-next');
    await waitFor(() => q(mount, 'manual-invoice-step-positions') !== null);
    expect(q(mount, 'location')?.getAttribute('data-search')).toBe('?step=positions');

    await click(mount, 'history-back');
    await waitFor(() => q(mount, 'manual-invoice-step-customer') !== null, 40, 'zurück');
    expect(q(mount, 'location')?.getAttribute('data-search')).toBe('?step=customer');
    expect(q(mount, 'manual-invoice-customer-chosen')?.textContent).toContain('Müller Bau GmbH');

    await click(mount, 'history-forward');
    await waitFor(() => q(mount, 'manual-invoice-step-positions') !== null, 40, 'vor');
    expect(q(mount, 'location')?.getAttribute('data-search')).toBe('?step=positions');
  });

  it('L6: ohne Kunde bleibt „Weiter" gesperrt', async () => {
    seedCustomer();
    const mount = await renderPage();
    await waitFor(() => q(mount, 'manual-invoice-next') !== null);
    expect(q<HTMLButtonElement>(mount, 'manual-invoice-next')?.disabled).toBe(true);
    await selectRadio(mount, 'customer-decision-existing');
    expect(q<HTMLButtonElement>(mount, 'manual-invoice-next')?.disabled).toBe(true);
    // Ein Sprung in einen späteren Schritt über die Adresse wird zurückgewiesen.
    await act(async () => mount.root.unmount());
    const jumped = await renderPage('/rechnungen/neu?step=review');
    await waitFor(() => q(jumped, 'manual-invoice-step-customer') !== null);
    expect(q(jumped, 'manual-invoice-step-review')).toBeNull();
  });
});

describe('01B1B — Schritt 2 Positionen', () => {
  async function toPositions(mount: Mount, customer: Customer): Promise<void> {
    await waitFor(() => q(mount, 'manual-invoice-step-customer') !== null);
    await selectRadio(mount, 'customer-decision-existing');
    await selectRadio(mount, `customer-option-${customer.id}`);
    await click(mount, 'manual-invoice-next');
    await waitFor(() => q(mount, 'manual-positions-editor') !== null);
  }

  it('L8/L9/L10/L13/L14: hinzufügen, bearbeiten, entfernen — ohne Auftragsfelder, dauerhaft', async () => {
    const customer = seedCustomer();
    const mount = await renderPage();
    await toPositions(mount, customer);
    expect(q<HTMLButtonElement>(mount, 'manual-invoice-next')?.disabled, 'ohne Position gesperrt').toBe(true);

    await type(mount, 'manual-position-description', 'Anfahrt');
    await type(mount, 'manual-position-quantity', '2');
    await type(mount, 'manual-position-unit-price', '45');
    await click(mount, 'manual-position-commit');
    await waitFor(() => q(mount, 'manual-position-0') !== null);
    expect(q(mount, 'manual-position-0')?.textContent).toContain('Anfahrt');
    expect(q<HTMLButtonElement>(mount, 'manual-invoice-next')?.disabled).toBe(false);

    await click(mount, 'manual-position-edit-0');
    await type(mount, 'manual-position-description', 'Anfahrt (Nachmittag)');
    await click(mount, 'manual-position-commit');
    await waitFor(() => q(mount, 'manual-position-0')?.textContent?.includes('Nachmittag') === true);

    await waitForStoredDraft(
      (draft) => draft.positions.length === 1 && String((draft.positions[0] as { description: string }).description).includes('Nachmittag'),
    );
    const stored = await loadInvoiceDraftRecordByLocator(locator());
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    const position = stored.draft.positions[0]!;
    expect(position.description).toBe('Anfahrt (Nachmittag)');
    expect(position.quantity).toBe(2);
    expect(position.unitPrice).toBe(45);
    for (const forbidden of ['orderPositionId', 'plannedQuantity', 'executedQuantity', 'billedQuantity', 'openQuantity']) {
      expect(forbidden in position, `${forbidden} erfunden`).toBe(false);
    }
    // Sichtbar: keine Planmengen-Wörter im Editor.
    expect(q(mount, 'manual-positions-editor')?.textContent).not.toMatch(/Geplant|Ausgeführt|Plan/);

    await click(mount, 'manual-position-remove-0');
    await waitFor(() => q(mount, 'manual-positions-empty') !== null);
    expect(q<HTMLButtonElement>(mount, 'manual-invoice-next')?.disabled).toBe(true);
  });

  it('L11/L12: Menge 0 und leere Beschreibung blockieren — nichts wird still korrigiert', async () => {
    const customer = seedCustomer();
    const mount = await renderPage();
    await toPositions(mount, customer);

    await type(mount, 'manual-position-quantity', '0');
    await click(mount, 'manual-position-commit');
    expect(q(mount, 'manual-position-0')).toBeNull();
    expect(q(mount, 'manual-position-issues')?.textContent).toContain('Beschreibung');
    expect(q(mount, 'manual-position-issues')?.textContent).toContain('Menge');

    await type(mount, 'manual-position-description', 'Anfahrt');
    await click(mount, 'manual-position-commit');
    expect(q(mount, 'manual-position-0'), 'Menge 0 wurde übernommen').toBeNull();
  });
});

describe('01B1B — Schritt 3/4 Details, Prüfung, Freigabe', () => {
  it('L15–L21: Details bleiben erhalten; die Prüfung zeigt Summen und keinen Projektblock', async () => {
    const customer = seedCustomer();
    const mount = await renderPage();
    await walkToReview(mount, customer);

    await waitForStoredDraft((draft) => draft.servicePeriodTo === '2026-09-05');
    const stored = await loadInvoiceDraftRecordByLocator(locator());
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    expect(stored.draft.servicePeriodFrom).toBe('2026-09-01');
    expect(stored.draft.taxStatus).toBe('standard_19');
    expect(stored.draft.skontoText).toBe(stored.draft.skontoText); // aus dem Profil übernommen, unverändert

    const review = q(mount, 'manual-invoice-review-totals')?.textContent ?? '';
    expect(review).toContain('45,00');
    expect(review).toContain('8,55');
    expect(review).toContain('53,55');
    expect(mount.container.querySelector('.invoice-project'), 'Projektblock ohne Titel/Baustelle').toBeNull();
    expect(mount.container.textContent).not.toContain('Projekt: -');
    expect(q(mount, 'manual-invoice-progress')?.textContent).toBe('4/4');
  });

  it('L22: §13b verlangt die Bestätigung und gibt danach den Weg frei', async () => {
    const customer = seedCustomer();
    const mount = await renderPage();
    await waitFor(() => q(mount, 'manual-invoice-step-customer') !== null);
    await selectRadio(mount, 'customer-decision-existing');
    await selectRadio(mount, `customer-option-${customer.id}`);
    await click(mount, 'manual-invoice-next');
    await waitFor(() => q(mount, 'manual-positions-editor') !== null);
    await type(mount, 'manual-position-description', 'Anfahrt');
    await type(mount, 'manual-position-unit-price', '45');
    await click(mount, 'manual-position-commit');
    await waitFor(() => q(mount, 'manual-position-0') !== null);
    await click(mount, 'manual-invoice-next');
    await waitFor(() => q(mount, 'invoice-tax-reverse_charge_13b') !== null);

    await click(mount, 'invoice-tax-reverse_charge_13b');
    await waitFor(() => q(mount, 'invoice-13b-confirm') !== null);
    expect(q<HTMLButtonElement>(mount, 'manual-invoice-next')?.disabled, 'ohne §13b-Bestätigung gesperrt').toBe(true);
    const box = q<HTMLInputElement>(mount, 'invoice-13b-confirm-checkbox')!;
    await act(async () => {
      box.click();
      await Promise.resolve();
    });
    await waitFor(() => q<HTMLButtonElement>(mount, 'manual-invoice-next')?.disabled === false);
  });

  it('L24/L25/L26/L27/L28/L29: Freigabe ruft den Coordinator mit vorgangId null — nach dem Flush — und führt auf die globale Detailroute (01B2)', async () => {
    const customer = seedCustomer();
    let captured: coordinator.StartInvoiceDraftFinalizationInput | null = null;
    /* Was der Coordinator beim Start im Speicher vorfindet — Beweis für „Flush vor Finalize". */
    let storedAtStart: { revision: number; positions: number; servicePeriodTo: string } | null = null;
    const start = vi.spyOn(coordinator, 'startInvoiceDraftFinalization').mockImplementation(async (input) => {
      captured = input;
      const record = await loadInvoiceDraftRecordByLocator(locator());
      if (record.ok) {
        storedAtStart = {
          revision: record.record.revision,
          positions: record.draft.positions.length,
          servicePeriodTo: record.draft.servicePeriodTo,
        };
      }
      // Wie der echte Coordinator: das Ergebnis liegt im First-Class-Speicher.
      const invoice = { id: 'inv-ui-1', number: '2026-0031', type: 'rechnung', status: 'vorbereitet', customerId: input.identity.draftId && customer.id, positions: [], subtotal: 45, amount: 53.55, date: '2026-09-12', issueDate: '2026-09-12', createdAt: '2026-09-12T00:00:00.000Z', paymentDueDate: '2999-12-31', customerSnapshot: { name: 'Müller Bau GmbH' }, companySnapshot: { companyName: 'Beispiel Betrieb GmbH' }, payments: [], paymentStatus: 'offen', legalNotices: [], previousAbschlagDeductions: [], archiveDocumentId: 'doc-ui-1' } as unknown as VorgangInvoice;
      hydrateInvoiceStore([{ invoice, vorgangId: null }]);
      return { ok: true, invoice, clientInvoiceId: 'inv-ui-1', contentFingerprint: 'fp', idempotentReplay: false, archiveWarning: false, revision: 3, cloudState: 'confirmed' };
    });
    const mount = await renderPage();
    await walkToReview(mount, customer);

    await click(mount, 'invoice-approve');
    await waitFor(() => start.mock.calls.length === 1 && storedAtStart !== null);

    expect(captured).not.toBeNull();
    expect(captured!.identity.vorgangId).toBeNull();
    expect(captured!.identity.invoiceType).toBe('rechnung');
    expect(captured!.overbillingAcknowledged).toBe(false);
    /*
     * Flush vor Finalize: Der Coordinator sah im Speicher bereits den
     * vollständigen Stand (Position, Leistungszeitraum) und exakt die
     * Revision, die ihm als `expectedRevision` übergeben wurde.
     */
    expect(storedAtStart).not.toBeNull();
    expect(storedAtStart!.positions).toBe(1);
    expect(storedAtStart!.servicePeriodTo).toBe('2026-09-05');
    expect(storedAtStart!.revision).toBe(captured!.expectedRevision);

    // 01B2 — nach bewiesener Finalisierung (Rechnung liegt mit vorgangId null im
    // Speicher) führt der Weg auf die globale Detailroute, nicht mehr in die Übersicht.
    await waitFor(() => q(mount, 'location')?.getAttribute('data-path') === '/rechnungen/inv-ui-1');
    expect(q(mount, 'detail-stub')).not.toBeNull();
  });

  it('L30: ein Doppelklick startet genau eine Finalisierung', async () => {
    const customer = seedCustomer();
    let release: (() => void) | null = null;
    const start = vi.spyOn(coordinator, 'startInvoiceDraftFinalization').mockImplementation(
      () => new Promise((resolve) => { release = () => resolve({ ok: false, reason: 'offline_or_unconfigured', recovery: 'retry_allowed', cloudState: 'not_committed' } as never); }),
    );
    const mount = await renderPage();
    await walkToReview(mount, customer);

    await click(mount, 'invoice-approve');
    await waitFor(() => start.mock.calls.length === 1);
    expect(q<HTMLButtonElement>(mount, 'invoice-approve')?.disabled).toBe(true);
    await click(mount, 'invoice-approve');
    await act(async () => {
      await new Promise((done) => setTimeout(done, 10));
    });
    expect(start).toHaveBeenCalledTimes(1);
    release?.();
    await waitFor(() => q(mount, 'manual-invoice-failure') !== null);
  });

  it('L31: Offline/Retry wird verständlich angezeigt und die Freigabe wieder geöffnet', async () => {
    const customer = seedCustomer();
    vi.spyOn(coordinator, 'startInvoiceDraftFinalization').mockResolvedValue(
      { ok: false, reason: 'offline_or_unconfigured', recovery: 'retry_allowed', cloudState: 'not_committed' } as never,
    );
    const mount = await renderPage();
    await walkToReview(mount, customer);
    await click(mount, 'invoice-approve');
    await waitFor(() => q(mount, 'manual-invoice-failure') !== null);
    expect(q(mount, 'manual-invoice-failure')?.textContent).toContain('Internetverbindung');
    expect(q(mount, 'manual-invoice-failure')?.textContent).not.toMatch(/vorgangId|clientInvoiceId|not_committed/);
    await waitFor(() => q<HTMLButtonElement>(mount, 'invoice-approve')?.disabled === false);
  });

  it('L32: ein bereits finalisierter Entwurf erzeugt keine zweite Rechnung', async () => {
    const customer = seedCustomer();
    const start = vi.spyOn(coordinator, 'startInvoiceDraftFinalization');
    const mount = await renderPage();
    await walkToReview(mount, customer);
    const stored = await loadInvoiceDraftRecordByLocator(locator());
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;

    // Finalisierung begonnen und abgeschlossen — wie nach einem verlorenen Tab.
    // Die Sitzung speichert noch nach; die Revision wird deshalb frisch gelesen.
    await act(async () => mount.root.unmount());
    const fresh = await loadInvoiceDraftRecordByLocator(locator());
    expect(fresh.ok).toBe(true);
    if (!fresh.ok) return;
    const begun = await durability.beginInvoiceDraftFinalization({
      identity: { ...locator(), draftId: fresh.record.draftId },
      expectedRevision: fresh.record.revision,
      clientInvoiceId: 'inv-done',
      contentFingerprint: 'fp',
      request: { workspaceId: WORKSPACE, vorgangId: null, clientInvoiceId: 'inv-done', invoice: { id: 'inv-done', type: 'rechnung' } } as never,
      approvalContext: {},
      now: '2026-09-12T10:00:00.000Z',
    });
    expect(begun.ok, JSON.stringify(begun)).toBe(true);
    const completed = await durability.completeInvoiceDraftFinalization({
      identity: { ...locator(), draftId: fresh.record.draftId },
      expectedRevision: begun.ok ? begun.record.revision : 0,
      clientInvoiceId: 'inv-done',
      contentFingerprint: 'fp',
      finalizedInvoiceId: 'inv-done',
      archiveWarning: false,
      now: '2026-09-12T10:01:00.000Z',
    } as never);
    expect(completed.ok, JSON.stringify(completed)).toBe(true);
    hydrateInvoiceStore([{ invoice: { id: 'inv-done', type: 'rechnung', status: 'vorbereitet', positions: [] } as unknown as VorgangInvoice, vorgangId: null }]);

    const again = await renderPage('/rechnungen/neu?step=review');
    await waitFor(() => q(again, 'manual-invoice-page') !== null);
    // Session readOnly/finalized: kein Freigabeknopf, keine Finalisierung.
    await waitFor(() => q(again, 'invoice-session-locked') !== null || q(again, 'manual-invoice-step-customer') !== null);
    expect(q(again, 'invoice-approve')).toBeNull();
    expect(start).not.toHaveBeenCalled();
  });
});

/**
 * Wartet, bis der **gespeicherte** Entwurf eine Bedingung erfüllt. Die
 * Sitzung schreibt asynchron und debounced; nur der Datensatz zählt.
 */
async function waitForStoredDraft(
  check: (draft: { customerId?: string; positions: unknown[]; servicePeriodTo: string }) => boolean,
  rounds = 80,
): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    const result = await loadInvoiceDraftRecordByLocator(locator());
    if (result.ok && check(result.draft as never)) return;
    await act(async () => {
      await new Promise((done) => setTimeout(done, 5));
    });
  }
  throw new Error('waitForStoredDraft: gespeicherter Entwurf erreichte den erwarteten Stand nicht');
}
