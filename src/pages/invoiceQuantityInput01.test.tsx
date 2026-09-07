/**
 * INVOICE-QUANTITY-INPUT-UX-01B — die Mengeneingabe traegt eine Geldforderung.
 *
 * Realbefund auf iPhone/Safari: Die vorbelegte `0` liess sich nicht loeschen —
 * `parseFloat('') || 0` schrieb sie bei jedem Tastendruck zurueck. Deutsche
 * Dezimalmengen mit Komma wurden von `type="number"` verworfen, bevor die
 * Anwendung sie sah.
 *
 * Der Fix nutzt den vorhandenen `NumericInput` im **strengen Modus**: keine
 * stille Umdeutung und kein voreiliges `0` bei `1,`.
 *
 * INVOICE-ACTUAL-MEASURE-VS-PLAN-01B — die ursprünglich mitgelieferte
 * Plan-Obergrenze ist wieder entfallen; der letzte Abschnitt sichert jetzt
 * ausdrücklich, dass sie nicht zurückkehrt.
 *
 * Synthetische Daten, kein Netz, keine Finalisierung.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { AppProvider } from '../context/AppContext';
import { DEFAULT_SETUP } from '../data/mockData';
import { DEFAULT_COMPANY_PROFILE } from '../data/companyProfileDefaults';
import { RechnungPage } from './RechnungPage';
import { createOrderPosition, createTestVorgang } from '../test/fixtures';
import { hydrateCompanyProfileStore } from '../services/companyProfileService';
import { hydrateDocumentStore } from '../services/documentService';
import { hydrateVorgangStore } from '../services/vorgangService';
import { resetInvoiceNumberSequence } from '../services/invoiceNumberService';
import { setActiveStorageScope } from '../services/storage/storageScopeService';
import { resetInvoiceDraftDurabilityDatabaseForTests } from '../services/invoice/invoiceDraftDurabilityService';
import * as workspaceSyncPayloadService from '../services/workspace/workspaceSyncPayloadService';
import type { OrderPosition } from '../types/models';

const WORKSPACE_ID = 'ws-quantity-input-01b';

const company = {
  ...DEFAULT_COMPANY_PROFILE,
  companyName: 'Menge GmbH',
  street: 'Werk 1',
  zip: '80331',
  city: 'München',
  iban: 'DE89370400440532013000',
  bankName: 'Sparkasse',
  phone: '089 111',
  email: 'a@b.invalid',
};

/** 420 m² geplant, 420 ausgeführt — die offene Menge ist damit 420. */
function position(overrides: Partial<OrderPosition> = {}): OrderPosition {
  return createOrderPosition({
    id: 'op-test-1',
    description: 'Dachbahn verlegen',
    plannedQuantity: 420,
    executedQuantity: 420,
    unit: 'm²',
    unitPrice: 25,
    category: 'arbeit',
    ...overrides,
  });
}

let root: Root;
let host: HTMLDivElement;

beforeEach(async () => {
  resetInvoiceNumberSequence();
  hydrateDocumentStore([]);
  hydrateCompanyProfileStore(company);
  setActiveStorageScope({ type: 'workspace', workspaceId: WORKSPACE_ID });
  vi.spyOn(workspaceSyncPayloadService, 'resolveCloudWorkspaceId').mockReturnValue(WORKSPACE_ID);
  await resetInvoiceDraftDurabilityDatabaseForTests();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

async function renderPage(positions: OrderPosition[] = [position()]): Promise<void> {
  hydrateVorgangStore([createTestVorgang({ orderPositions: positions })]);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={['/vorgaenge/v-test-1/rechnung?type=rechnung']}>
        <AppProvider initialSetup={{ ...DEFAULT_SETUP, setupComplete: true }}>
          <Routes>
            <Route path="/vorgaenge/:id/rechnung" element={<RechnungPage />} />
          </Routes>
        </AppProvider>
      </MemoryRouter>,
    );
  });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (host.querySelector('[data-testid="rechnung-page"]')) break;
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
  }
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
  }
}

function find(testId: string): HTMLElement | null {
  return host.querySelector(`[data-testid="${testId}"]`);
}

function field(orderPositionId = 'op-test-1'): HTMLInputElement {
  const element = find(`invoice-qty-${orderPositionId}`);
  expect(element, `Mengenfeld ${orderPositionId} fehlt`).not.toBeNull();
  return element as HTMLInputElement;
}

function previewButton(): HTMLButtonElement {
  const element = find('invoice-continue-preview');
  expect(element, 'Vorschau-Schaltfläche fehlt').not.toBeNull();
  return element as HTMLButtonElement;
}

/** Tippt einen Text so, wie der Browser ihn liefert — als ganzen `value`. */
async function type(input: HTMLInputElement, text: string): Promise<void> {
  await act(async () => {
    input.focus();
  });
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )?.set;
    setter?.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
  }
}

async function blur(input: HTMLInputElement): Promise<void> {
  await act(async () => {
    input.blur();
  });
  await act(async () => {
    await new Promise((done) => setTimeout(done, 0));
  });
}

/** Der gespeicherte Wert wird über den Zeilenbetrag gelesen — 25 € je Einheit. */
function lineTotalText(): string {
  return host.querySelector('.position-price')?.textContent?.trim() ?? '';
}

describe('INVOICE-QUANTITY-INPUT-UX-01B — normale Eingabe', () => {
  it('T1: die vorbelegte Menge lässt sich vollständig löschen', async () => {
    await renderPage();
    const input = field();

    await type(input, '');

    expect(input.value, 'Das Feld sprang auf 0 zurück').toBe('');
    await blur(input);
    expect(input.value, 'Nach dem Verlassen steht der fachliche Wert').toBe('0');
  });

  it('T2: 185 wird sofort übernommen', async () => {
    await renderPage();
    await type(field(), '185');

    expect(lineTotalText()).toContain('4.625');
  });

  /*
   * T3 — der schwerwiegendste Befund. Ein halber Tastendruck darf einen
   * bestätigten Wert nicht vernichten.
   */
  it('T3: ein unvollständiges „1," überschreibt den gespeicherten Wert nicht', async () => {
    await renderPage();
    const input = field();
    await type(input, '185');
    expect(lineTotalText()).toContain('4.625');

    await type(input, '1,');

    expect(input.value, 'Der Zwischenstand ist nicht sichtbar').toBe('1,');
    expect(lineTotalText(), 'Der gespeicherte Wert wurde zu 0 überschrieben').toContain('4.625');
    expect(previewButton().disabled, 'Die Vorschau blieb trotz offener Eingabe erlaubt').toBe(true);
  });

  it('T4: 1,5 mit Komma wird übernommen', async () => {
    await renderPage();
    await type(field(), '1,5');

    expect(lineTotalText()).toContain('37,5');
    expect(previewButton().disabled).toBe(false);
  });

  it('T5: 1.5 mit Punkt wird ebenfalls übernommen', async () => {
    await renderPage();
    await type(field(), '1.5');

    expect(lineTotalText()).toContain('37,5');
  });
});

describe('INVOICE-QUANTITY-INPUT-UX-01B — keine stille Umdeutung', () => {
  it('T6: „-1" wird nicht zu 1', async () => {
    await renderPage();
    const input = field();
    await type(input, '-1');

    expect(input.value, 'Das Minus wurde entfernt statt abgewiesen').not.toBe('1');
    expect(lineTotalText(), 'Aus -1 wurde die Menge 1').not.toContain('25 €');
  });

  it('T7: „1e3" wird nicht zu 13', async () => {
    await renderPage();
    const input = field();
    await type(input, '1e3');

    expect(input.value).not.toBe('13');
    expect(lineTotalText(), 'Aus 1e3 wurde die Menge 13').not.toContain('325');
  });

  it('T8: „1,2,3" wird nicht zu 1,23', async () => {
    await renderPage();
    const input = field();
    await type(input, '1,2,3');

    expect(input.value).not.toBe('1,23');
    expect(lineTotalText(), 'Aus 1,2,3 wurde die Menge 1,23').not.toContain('30,75');
  });
});

/*
 * INVOICE-ACTUAL-MEASURE-VS-PLAN-01B — bewusst umgedrehter Abschnitt.
 *
 * Er hiess „Obergrenze und Vorschau" und sicherte, dass 421 bei einem Planrest
 * von 420 abgewiesen wird und die Vorschau sperrt. Die Planmenge ist die
 * Vertragsmenge und kein Aufmass: Die Überschreitung ist ein Fall für den
 * bestehenden Bestätigungspfad, kein Eingabefehler. Was bleibt, ist die Sperre
 * bei einem **unvollständigen** Zwischenstand — dort steht wirklich keine Zahl.
 */
describe('INVOICE-ACTUAL-MEASURE-VS-PLAN-01B — keine Plan-Obergrenze in der Oberfläche', () => {
  it('T9: 421 bei 420 Planrest wird übernommen und sperrt die Vorschau nicht', async () => {
    await renderPage();
    const input = field();
    await type(input, '185');
    await type(input, '421');

    expect(input.value, 'Die Eingabe ist nicht sichtbar geblieben').toBe('421');
    expect(find('invoice-qty-error-op-test-1'), 'Ein Grenzfehler erschien erneut').toBeNull();
    expect(lineTotalText(), 'Der Wert wurde nicht übernommen').toContain('10.525');
    expect(previewButton().disabled, 'Die Planüberschreitung sperrte die Vorschau').toBe(false);
  });

  it('T10: nach 421 führt ein Tap auf die Vorschau tatsächlich weiter', async () => {
    await renderPage();
    const input = field();
    await type(input, '421');

    const button = previewButton();
    expect(button.disabled).toBe(false);

    await blur(input);
    await act(async () => {
      button.click();
    });
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });

    expect(find('invoice-continue-preview'), 'Der Weg zur Vorschau blieb versperrt').toBeNull();
  });

  it('T11: ein unvollständiger Zwischenstand sperrt weiterhin', async () => {
    await renderPage();
    const input = field();
    await type(input, '421');
    expect(previewButton().disabled).toBe(false);

    await type(input, '421,');

    expect(find('invoice-qty-incomplete-op-test-1'), 'Kein Hinweis auf „421,"').not.toBeNull();
    expect(previewButton().disabled, 'Ein halber Tastendruck ging durch').toBe(true);

    await type(input, '420');
    expect(find('invoice-qty-incomplete-op-test-1')).toBeNull();
    expect(lineTotalText()).toContain('10.500');
    expect(previewButton().disabled).toBe(false);
  });

  it('T12: zwei Positionen nehmen unabhängig voneinander Mengen über Plan an', async () => {
    await renderPage([
      position(),
      position({ id: 'op-test-2', description: 'Dämmung', plannedQuantity: 100, executedQuantity: 100 }),
    ]);

    await type(field('op-test-1'), '421');
    await type(field('op-test-2'), '50');

    expect(find('invoice-qty-error-op-test-1')).toBeNull();
    expect(find('invoice-qty-error-op-test-2')).toBeNull();
    expect(previewButton().disabled).toBe(false);
  });

  it('T13: „Alle Positionen übernehmen" löst einen offenen Zwischenstand', async () => {
    await renderPage();
    await type(field(), '1,');
    expect(previewButton().disabled).toBe(true);

    const applyAll = find('invoice-apply-all-positions');
    expect(applyAll, 'Sammelschaltfläche fehlt — der Test prüfte nichts').not.toBeNull();
    await act(async () => {
      applyAll!.click();
    });
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });

    expect(find('invoice-qty-incomplete-op-test-1')).toBeNull();
    expect(previewButton().disabled).toBe(false);
  });

  /*
   * T14 — der gefährlichste der alten Fälle: Ein ausgeschöpfter Planrest
   * sperrte das Feld. Wer 420 von 420 m² abgerechnet hat und weitere 100 m²
   * ausführt, konnte sie nicht mehr abrechnen.
   */
  it('T14: eine ausgeschöpfte Position bleibt bedienbar', async () => {
    await renderPage([position({ executedQuantity: 0 })]);

    expect(field().disabled, 'Ohne offenen Rest wurde das Feld gesperrt').toBe(false);
    await type(field(), '100');
    expect(lineTotalText()).toContain('2.500');
    expect(previewButton().disabled).toBe(false);
  });
});
