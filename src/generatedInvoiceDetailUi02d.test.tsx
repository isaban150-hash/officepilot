/**
 * OFFICEPILOT-GENERATED-INVOICE-UNDERSTANDING-02D — geprüft wird, was der Nutzer sieht.
 *
 * 02B hat die Dokumentnatur eingetragen und drei Stellen abgesichert. Auf dem
 * Realgerät blieben drei falsche Aussagen an einer eigenen Ausgangsrechnung
 * stehen: die Aufforderung „Original ablegen“ ganz oben, der Satz „Original
 * noch nicht als abgeheftet markiert“ im Verständnis und der nächste Schritt
 * „Antwort vorbereiten“.
 *
 * Der Grund, warum 02B das nicht bemerkt hat, steckt in seiner Testform: Es
 * prüfte einzelne Servicefelder statt die gerenderte Seite. Dieser Test setzt
 * deshalb am echten `DokumentDetailPage`-Pfad an und misst Text im DOM — nur
 * so fallen Aussagen auf, die aus einer Ecke kommen, an die niemand gedacht hat.
 *
 * Neutrale Beispieldaten, kein Netzwerk.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppProvider } from './context/AppContext';
import { DEFAULT_SETUP } from './data/mockData';
import { DokumentDetailPage } from './pages/DokumentDetailPage';
import { archiveOutgoingInvoice } from './services/invoiceArchiveService';
import { addDocument } from './services/documentService';
import { getVorgangInvoice, hydrateVorgangStore } from './services/vorgangService';
import { resetTestStores } from './test/resetStores';
import { createOrderPosition, createTestVorgang } from './test/fixtures';
import type { CompanyDocument, Vorgang, VorgangInvoice } from './types/models';

const setupComplete = { ...DEFAULT_SETUP, setupComplete: true };
const VORGANG_ID = 'v-gen-inv-ui';
const INVOICE_ID = 'inv-gen-ui-1';

type Mount = { container: HTMLDivElement; root: Root };

function buildInvoice(): VorgangInvoice {
  return {
    id: INVOICE_ID,
    number: '2026-0002',
    type: 'rechnung',
    positions: [
      {
        id: 'line-1',
        orderPositionId: 'op-1',
        description: 'Dachsanierung',
        quantity: 10,
        unit: 'm²',
        unitPrice: 100,
        lineTotal: 1000,
      },
    ],
    subtotal: 1000,
    taxStatus: 'standard_19',
    amount: 1190,
    status: 'vorbereitet',
    date: '2026-08-25',
    issueDate: '2026-08-25',
    createdAt: '2026-08-25T10:00:00.000Z',
    paymentDueDate: '2026-09-08',
    paymentStatus: 'offen',
    payments: [],
    legalNotices: [],
    previousAbschlagDeductions: [],
    customerSnapshot: {
      name: 'Beispiel Projektbau GmbH',
      contactPerson: '',
      street: 'Weg 1',
      zip: '33330',
      city: 'Beispielstadt',
      email: '',
      phone: '',
    },
  } as VorgangInvoice;
}

function seedVorgang(): void {
  hydrateVorgangStore([
    {
      ...createTestVorgang({
        id: VORGANG_ID,
        status: 'beauftragt',
        customer: 'Beispiel Projektbau GmbH',
        title: 'Gewerbepark – Dachsanierung',
        orderPositions: [
          createOrderPosition({ id: 'op-1', unit: 'm²', plannedQuantity: 10, unitPrice: 100 }),
        ],
      }),
      invoices: [buildInvoice()],
    } as Vorgang,
  ]);
}

/** Genau der Weg, auf dem 2026-0002 entstanden ist. */
function archiveInvoice(): CompanyDocument {
  const invoice = getVorgangInvoice(VORGANG_ID, INVOICE_ID)!;
  const result = archiveOutgoingInvoice(VORGANG_ID, invoice, 'Test GmbH');
  if (!result.success) throw new Error('Archivierung fehlgeschlagen');
  return result.document;
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (check()) return;
    await settle();
  }
  throw new Error(`timed out waiting for: ${label}`);
}

function unmount(mount: Mount): void {
  act(() => mount.root.unmount());
  mount.container.remove();
}

async function mountDetail(documentId: string): Promise<Mount> {
  const container = window.document.createElement('div');
  window.document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: [`/dokumente/${documentId}`] },
        createElement(
          AppProvider,
          { initialSetup: setupComplete },
          createElement(
            Routes,
            null,
            createElement(Route, {
              path: '/dokumente/:id',
              element: createElement(DokumentDetailPage),
            }),
          ),
        ),
      ),
    );
  });
  await settle();
  return { container, root };
}

/** Auch der aufgeklappte Bereich zählt — dort liegt die Ablagekarte. */
async function openAll(mount: Mount): Promise<void> {
  const toggle = mount.container.querySelector(
    '[data-testid="show-more-toggle"]',
  ) as HTMLButtonElement | null;
  if (toggle) {
    await act(async () => toggle.click());
    await settle();
  }
}

function visibleText(mount: Mount): string {
  return mount.container.textContent ?? '';
}

describe('OFFICEPILOT-GENERATED-INVOICE-DETAIL-UI-02D', () => {
  beforeEach(() => {
    resetTestStores();
    seedVorgang();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetTestStores();
  });

  it('A: die eigene Ausgangsrechnung verlangt kein Papieroriginal', async () => {
    const document = archiveInvoice();
    const mount = await mountDetail(document.id);
    await waitFor(
      () => mount.container.querySelector('[data-testid="document-detail-page"]') !== null,
      'Detailseite',
    );
    await openAll(mount);

    const text = visibleText(mount);

    // Der obere Überblick fordert keine Ablage eines Originals …
    expect(text).not.toContain('Original ablegen');
    expect(text).not.toContain('Bitte Original abheften');
    // … das Verständnis behauptet keinen offenen Papierstatus …
    expect(text).not.toContain('Original noch nicht als abgeheftet markiert');
    // … und es gibt nichts zu beantworten.
    expect(text).not.toContain('Antwort vorbereiten');

    unmount(mount);
  });

  /**
   * 02F — die vier Aussagen aus dem aufgeklappten Bereich. Sie sind der Grund,
   * warum eine Liste bekannter Zeichenketten als Prüfung nicht genügt: „Original
   * noch abheften“ ist eine andere Formulierung als „Original noch nicht als
   * abgeheftet markiert“ und rutschte durch die 02D-Assertions hindurch.
   */
  it('A2: auch der aufgeklappte Bereich verlangt kein Papieroriginal', async () => {
    const document = archiveInvoice();
    const mount = await mountDetail(document.id);
    await waitFor(
      () => mount.container.querySelector('[data-testid="document-detail-page"]') !== null,
      'Detailseite',
    );
    await openAll(mount);

    const text = visibleText(mount);

    expect(text).not.toContain('Original liegt physisch im Ordner');
    expect(text).not.toContain('Original noch abheften');
    expect(text).not.toContain('Original abheften und in OfficePilot bestätigen');
    expect(text).not.toContain('Antwort formulieren');

    unmount(mount);
  });

  /**
   * Breiter als eine Stichwortliste: kein einziges „abheften“ darf auf der
   * ganzen Seite stehen. So fällt auch eine Formulierung auf, an die beim
   * Schreiben dieses Tests niemand gedacht hat.
   */
  it('A3: das Wort „abheften“ kommt nirgends vor', async () => {
    const document = archiveInvoice();
    const mount = await mountDetail(document.id);
    await waitFor(
      () => mount.container.querySelector('[data-testid="document-detail-page"]') !== null,
      'Detailseite',
    );
    await openAll(mount);

    expect(visibleText(mount)).not.toContain('abheften');

    unmount(mount);
  });

  it('B: die fachlich richtigen Angaben bleiben sichtbar', async () => {
    const document = archiveInvoice();
    const mount = await mountDetail(document.id);
    await waitFor(
      () => mount.container.querySelector('[data-testid="document-detail-page"]') !== null,
      'Detailseite',
    );
    await openAll(mount);

    const text = visibleText(mount);
    expect(text).toContain('Ausgangsrechnung');
    expect(text).toContain('2026-0002');
    // Der digitale Ablageort bleibt — nur die Papierpflicht entfällt.
    expect(text).toContain('Ausgangsrechnungen');
    // Kein Zahlungsziel als Gültigkeitsfrist (02B), hier als Sichtprüfung.
    expect(text).not.toContain('Gültigkeit prüfen');

    // Und die Ablageinformation selbst bleibt am Dokument erhalten.
    expect(document.paperFolder.folderId).toBe('folder-3');

    unmount(mount);
  });

  it('C: ein Fremddokument behält Papierhinweis und Antwortschritt', async () => {
    const foreign = addDocument({
      title: 'Eingangsrechnung Holz AG',
      category: 'eingangsrechnung',
      issuer: 'Holz AG',
      recognizedText: 'Eingangsrechnung RE-2026-1',
      issueDate: '2026-08-01',
      classifiedKind: 'eingangsrechnung',
      archived: true,
    });
    expect(foreign.success).toBe(true);
    if (!foreign.success) return;

    const mount = await mountDetail(foreign.document.id);
    await waitFor(
      () => mount.container.querySelector('[data-testid="document-detail-page"]') !== null,
      'Detailseite',
    );
    await openAll(mount);

    const text = visibleText(mount);
    // Genau das, was bei eingehender Post richtig ist — global abgeschaltet
    // wurde nichts.
    expect(text).toContain('Original ablegen');
    expect(text).toContain('Original noch nicht als abgeheftet markiert');
    expect(text).toContain('Antwort vorbereiten');
    // 02F — auch der aufgeklappte Bereich bleibt für Fremdpost unverändert.
    expect(text).toContain('Original noch abheften');
    expect(text).toContain('Antwort formulieren');

    unmount(mount);
  });

  it('D: die eigene Rechnung behält Frage, E-Mail und WhatsApp', async () => {
    const document = archiveInvoice();
    const mount = await mountDetail(document.id);
    await waitFor(
      () => mount.container.querySelector('[data-testid="document-detail-page"]') !== null,
      'Detailseite',
    );
    await openAll(mount);

    const text = visibleText(mount);
    // Entfernt wird nur der Antwortknopf — die Versandwege bleiben.
    expect(text).toContain('E-Mail schreiben');
    expect(text).toContain('WhatsApp schreiben');
    expect(text).toContain('Frage zu diesem');
    // Und der Bezug zur Rechnung selbst bleibt erreichbar.
    expect(text).toContain('Rechnung öffnen');

    unmount(mount);
  });
});
