/**
 * MOBILE-RESUME-STATE-01B — der Rechnungsschritt überlebt einen Neuaufbau.
 *
 * Belegter Realbefund auf iPhone/Safari: Wer in der Rechnungsvorschau steht,
 * zu einer anderen App wechselt und zurückkommt, landet wieder bei den
 * Positionen. Das Betriebssystem verwirft den Tab; der Entwurf überlebt in
 * IndexedDB, der Schritt lag ausschliesslich in `useState`.
 *
 * Der Schritt steht jetzt als Suchparameter in der Adresse. Er ist dabei
 * **niemals eine Berechtigung**: Eine §13b-Rechnung ohne erneute Bestätigung
 * und ein ungeklärter Steuerstatus führen weiterhin nicht in die Vorschau.
 *
 * Synthetische Daten, kein Netz, keine Finalisierung.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

import { AppProvider } from '../context/AppContext';
import { DEFAULT_SETUP } from '../data/mockData';
import { DEFAULT_COMPANY_PROFILE } from '../data/companyProfileDefaults';
import { RechnungPage } from './RechnungPage';
import { createTestVorgang } from '../test/fixtures';
import { hydrateCompanyProfileStore } from '../services/companyProfileService';
import { hydrateDocumentStore } from '../services/documentService';
import { hydrateVorgangStore } from '../services/vorgangService';
import { resetInvoiceNumberSequence } from '../services/invoiceNumberService';
import { setActiveStorageScope } from '../services/storage/storageScopeService';
import { resetInvoiceDraftDurabilityDatabaseForTests } from '../services/invoice/invoiceDraftDurabilityService';
import * as workspaceSyncPayloadService from '../services/workspace/workspaceSyncPayloadService';
import type { TaxStatus } from '../types/models';

const WORKSPACE_ID = 'ws-resume-step-01b';

const company = {
  ...DEFAULT_COMPANY_PROFILE,
  companyName: 'Resume GmbH',
  street: 'Werk 1',
  zip: '80331',
  city: 'München',
  iban: 'DE89370400440532013000',
  bankName: 'Sparkasse',
  phone: '089 111',
  email: 'a@b.invalid',
};

function setupWith(taxStatus: TaxStatus) {
  return { ...DEFAULT_SETUP, setupComplete: true, taxStatus };
}

let root: Root;
let host: HTMLDivElement;
/** Der zuletzt gerenderte Suchstring — so sieht der Test die Adresse. */
let currentSearch = '';

function SearchProbe() {
  currentSearch = useLocation().search;
  return null;
}

/**
 * Hält **jeden** gerenderten Suchstring fest, nicht nur den letzten. Nur so
 * lässt sich beweisen, dass die Adresse während der Wiederaufnahme nicht
 * zwischenzeitlich auf `step=positions` zurückfällt.
 */
function SearchRecorder({ onSearch }: { onSearch: (search: string) => void }) {
  onSearch(useLocation().search);
  return null;
}

beforeEach(async () => {
  // Die §13b-Bestätigung liegt in `localStorage` — kein Fall darf den nächsten bestätigen.
  try {
    localStorage.clear();
  } catch {
    // Ohne Speicher gibt es nichts zu leeren.
  }
  resetInvoiceNumberSequence();
  hydrateDocumentStore([]);
  hydrateCompanyProfileStore(company);
  hydrateVorgangStore([createTestVorgang()]);
  setActiveStorageScope({ type: 'workspace', workspaceId: WORKSPACE_ID });
  vi.spyOn(workspaceSyncPayloadService, 'resolveCloudWorkspaceId').mockReturnValue(WORKSPACE_ID);
  await resetInvoiceDraftDurabilityDatabaseForTests();
  currentSearch = '';
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

/**
 * Rendert die Rechnungsanlage unter einer konkreten Adresse und wartet, bis der
 * Entwurf aus IndexedDB steht. Die Adresse wird über einen kleinen Beobachter
 * mitgelesen, damit der Test die Normalisierung prüfen kann.
 */
async function renderAt(search: string, taxStatus: TaxStatus): Promise<void> {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[`/vorgaenge/v-test-1/rechnung${search}`]}>
        <AppProvider initialSetup={setupWith(taxStatus)}>
          <Routes>
            <Route
              path="/vorgaenge/:id/rechnung"
              element={
                <>
                  <RechnungPage />
                  <SearchProbe />
                </>
              }
            />
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
  // Die Wiederaufnahme läuft nach der Hydration; ihr Ergebnis braucht Renderzeit.
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
  }
}

function find(testId: string): HTMLElement | null {
  return host.querySelector(`[data-testid="${testId}"]`);
}

function previewVisible(): boolean {
  return find('invoice-document-number') !== null;
}

function positionsVisible(): boolean {
  return find('invoice-continue-preview') !== null;
}

function editVisible(): boolean {
  return find('invoice-back-preview') !== null;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
  });
}

describe('MOBILE-RESUME-STATE-01B — Wiederaufnahme aus der Adresse', () => {
  // 1
  it('R1: step=preview wird nach der Hydration wiederhergestellt', async () => {
    await renderAt('?type=rechnung&step=preview', 'standard_19');
    expect(previewVisible()).toBe(true);
    expect(positionsVisible()).toBe(false);
  });

  // 2
  it('R2: step=edit wird wiederhergestellt', async () => {
    await renderAt('?type=rechnung&step=edit', 'standard_19');
    expect(editVisible()).toBe(true);
    expect(previewVisible()).toBe(false);
  });

  // 3
  it('R3: ohne step beginnt der Ablauf bei den Positionen', async () => {
    await renderAt('?type=rechnung', 'standard_19');
    expect(positionsVisible()).toBe(true);
    expect(previewVisible()).toBe(false);
  });

  // 4
  it('R4: ein ungültiger step fällt auf positions zurück und wird normalisiert', async () => {
    await renderAt('?type=rechnung&step=freigabe', 'standard_19');
    expect(positionsVisible()).toBe(true);
    expect(currentSearch).toContain('step=positions');
    expect(currentSearch).not.toContain('freigabe');
  });

  /*
   * 5 — der Kern der Sicherheitsregel.
   *
   * `reverseCharge13bConfirmed` ist bewusst flüchtig. Nach einem Neuaufbau ist
   * die Bestätigung offen, und dann darf keine Adresse eine bestätigte
   * §13b-Vorschau herbeiführen.
   */
  it('R5: §13b ohne Bestätigung erreicht trotz step=preview keine Vorschau', async () => {
    await renderAt('?type=rechnung&step=preview', 'reverse_charge_13b');

    expect(previewVisible()).toBe(false);
    expect(positionsVisible()).toBe(true);
    expect(currentSearch).toContain('step=positions');
    // Die Bestätigung muss erneut erfolgen.
    const box = find('invoice-13b-confirm-checkbox') as HTMLInputElement | null;
    expect(box).not.toBeNull();
    expect(box!.checked).toBe(false);
    expect((find('invoice-continue-preview') as HTMLButtonElement).disabled).toBe(true);
  });

  // 6
  it('R6: unclear erreicht trotz step=preview keine Vorschau', async () => {
    await renderAt('?type=rechnung&step=preview', 'unclear');
    expect(previewVisible()).toBe(false);
    expect(positionsVisible()).toBe(true);
    expect(currentSearch).toContain('step=positions');
  });

  // 7
  it('R7: der Wechsel zur Vorschau schreibt step und erhält type', async () => {
    await renderAt('?type=rechnung', 'standard_19');
    await click(find('invoice-continue-preview')!);

    expect(previewVisible()).toBe(true);
    expect(currentSearch).toContain('step=preview');
    expect(currentSearch).toContain('type=rechnung');
  });

  // 8
  it('R8: der Rückweg zu den Positionen schreibt step=positions', async () => {
    await renderAt('?type=rechnung&step=preview', 'standard_19');
    await click(find('invoice-back-positions')!);

    expect(positionsVisible()).toBe(true);
    expect(currentSearch).toContain('step=positions');
    expect(currentSearch).toContain('type=rechnung');
  });

  /*
   * 11 — der Realbefund in Testform.
   *
   * Eine neue Komponenteninstanz auf derselben Adresse ist genau das, was nach
   * einem verworfenen Safari-Tab geschieht: Der Entwurf kommt aus IndexedDB,
   * der React-Zustand ist neu.
   */
  it('R11: ein Neuaufbau derselben Rechnung landet wieder in der Vorschau', async () => {
    await renderAt('?type=rechnung', 'standard_19');
    await click(find('invoice-continue-preview')!);
    expect(previewVisible()).toBe(true);
    const searchAfterStep = currentSearch;

    await act(async () => root.unmount());
    host.remove();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);

    await renderAt(`?${searchAfterStep.replace(/^\?/, '')}`, 'standard_19');
    expect(previewVisible()).toBe(true);
  });

  // 9
  it('R9: ein echter Wechsel der Rechnungsart übernimmt den alten Schritt nicht', async () => {
    await renderAt('?type=rechnung&step=preview', 'standard_19');
    expect(previewVisible()).toBe(true);

    /*
     * Die Auswahl der Rechnungsart steht nur im Positionsschritt. Der Weg
     * dorthin ist deshalb Teil des Falls — und er hinterlässt `step=positions`
     * in der Adresse, was den Wechsel erst aussagekräftig macht.
     */
    await click(find('invoice-back-positions')!);
    expect(currentSearch).toContain('step=positions');

    const abschlag = find('invoice-type-abschlag') as HTMLButtonElement | null;
    expect(abschlag, 'Auswahl der Rechnungsart nicht gefunden').not.toBeNull();
    await click(abschlag!);
    for (let attempt = 0; attempt < 30; attempt += 1) {
      await act(async () => {
        await new Promise((done) => setTimeout(done, 0));
      });
    }

    expect(currentSearch).toContain('type=abschlag');
    expect(previewVisible()).toBe(false);
    expect(positionsVisible()).toBe(true);
    expect(currentSearch).not.toContain('step=preview');
  });
});

/**
 * INVOICE-MOBILE-RESUME-01B — eine gegebene §13b-Bestätigung überlebt den
 * App-Wechsel, eine nicht gegebene entsteht nicht.
 *
 * R5 oben bleibt unverändert: Ohne Bestätigung führt keine Adresse in die
 * Vorschau. Diese Suite ergänzt den zweiten Fall — der Nutzer **hat**
 * bestätigt, und genau dieser unveränderte Entwurf soll nach einem
 * vollständigen Neuaufbau dort weitermachen, wo er stand.
 */
describe('INVOICE-MOBILE-RESUME-01B — §13b über den App-Wechsel', () => {
  function confirmCheckbox(): HTMLInputElement | null {
    return find('invoice-13b-confirm-checkbox') as HTMLInputElement | null;
  }

  /** Ein vollständiger Neuaufbau — genau das, was ein verworfener Tab hinterlässt. */
  async function remountAt(search: string, taxStatus: TaxStatus): Promise<void> {
    await act(async () => root.unmount());
    host.remove();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await renderAt(search, taxStatus);
  }

  /** Hakt §13b an und wartet, bis die Bestätigung geschrieben ist. */
  async function confirm13b(): Promise<void> {
    const box = confirmCheckbox();
    expect(box, '§13b-Kästchen nicht gefunden').not.toBeNull();
    await act(async () => {
      box!.click();
    });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await act(async () => {
        await new Promise((done) => setTimeout(done, 0));
      });
    }
  }

  it('R13B-1: ohne gespeicherte Bestätigung bleibt es fail-closed', async () => {
    await renderAt('?type=rechnung&step=preview', 'reverse_charge_13b');

    expect(previewVisible()).toBe(false);
    expect(positionsVisible()).toBe(true);
    expect(confirmCheckbox()!.checked).toBe(false);
  });

  /*
   * Der Realbefund in Testform: bestätigen, in die Vorschau, App wechseln,
   * zurückkommen.
   */
  it('R13B-2: die bestätigte Vorschau überlebt einen vollständigen Neuaufbau', async () => {
    await renderAt('?type=rechnung', 'reverse_charge_13b');
    await confirm13b();
    await click(find('invoice-continue-preview')!);
    expect(previewVisible()).toBe(true);
    const searchAfterStep = currentSearch;
    expect(searchAfterStep).toContain('step=preview');

    await remountAt(`?${searchAfterStep.replace(/^\?/, '')}`, 'reverse_charge_13b');

    expect(previewVisible(), 'Der Neuaufbau fiel auf die Positionen zurück').toBe(true);
    expect(currentSearch, 'Die Adresse wurde auf positions normalisiert').toContain(
      'step=preview',
    );
  });

  /*
   * Die Anzeige darf nicht behaupten, was der Freigabekontext nicht trägt:
   * Nach dem Resume muss das Kästchen denselben Zustand zeigen, mit dem die
   * Vorschau wiederhergestellt wurde.
   */
  it('R13B-2b: das Kästchen zeigt nach dem Resume die Bestätigung', async () => {
    await renderAt('?type=rechnung', 'reverse_charge_13b');
    await confirm13b();
    await remountAt('?type=rechnung&step=positions', 'reverse_charge_13b');

    expect(confirmCheckbox()!.checked, 'Die Bestätigung wurde nicht wiederhergestellt').toBe(
      true,
    );
  });

  /** Trägt eine Menge ein und wartet, bis der Entwurf gespeichert ist. */
  async function changeQuantity(value: string): Promise<void> {
    const quantity = host.querySelector(
      '[data-testid^="invoice-qty-"]',
    ) as HTMLInputElement | null;
    expect(quantity, 'Mengenfeld nicht gefunden').not.toBeNull();
    await act(async () => {
      quantity!.focus();
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )!.set!;
      setter.call(quantity!, value);
      quantity!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    for (let attempt = 0; attempt < 40; attempt += 1) {
      await act(async () => {
        await new Promise((done) => setTimeout(done, 0));
      });
    }
  }

  /*
   * INVOICE-MOBILE-RESUME-01B2 — die Lücke innerhalb derselben Sitzung.
   *
   * Die Bestätigung ist an `draftSha256` gebunden, aber ohne Neuaufbau wurde
   * diese Bindung nie geprüft: Wer §13b bestätigte, danach eine Menge änderte
   * und ohne Zwischenschritt freigab, trug eine Bestätigung weiter, die zu
   * einem anderen Rechnungsstand gehörte. Der Freigabe-Validator sieht nur
   * `true`, nicht wofür.
   */
  it('R13B-INSESSION-1: eine fachliche Änderung entwertet die Bestätigung sofort', async () => {
    await renderAt('?type=rechnung', 'reverse_charge_13b');
    await confirm13b();
    expect(confirmCheckbox()!.checked).toBe(true);
    expect((find('invoice-continue-preview') as HTMLButtonElement).disabled).toBe(false);

    await changeQuantity('7');

    expect(confirmCheckbox()!.checked, 'Die Bestätigung überlebte die Änderung').toBe(false);
    expect(
      (find('invoice-continue-preview') as HTMLButtonElement).disabled,
      'Der Weg zur Vorschau blieb offen',
    ).toBe(true);
    expect(find('invoice-tax-decision-blocked'), 'Kein Hinweis auf die offene Bestätigung')
      .not.toBeNull();
  });

  it('R13B-INSESSION-2: die erneute Bestätigung gilt für den neuen Stand', async () => {
    await renderAt('?type=rechnung', 'reverse_charge_13b');
    await confirm13b();
    await changeQuantity('7');
    expect(confirmCheckbox()!.checked).toBe(false);

    await confirm13b();
    expect(confirmCheckbox()!.checked).toBe(true);
    await click(find('invoice-continue-preview')!);
    expect(previewVisible()).toBe(true);

    // Der neue Punkt gehört zum geänderten Stand und trägt über den Neuaufbau.
    await remountAt(`?${currentSearch.replace(/^\?/, '')}`, 'reverse_charge_13b');
    expect(previewVisible(), 'Der neue Punkt wurde nicht wiederhergestellt').toBe(true);
  });

  it('R13B-INSESSION-3: reine Oberflächenwechsel entwerten nichts', async () => {
    await renderAt('?type=rechnung', 'reverse_charge_13b');
    await confirm13b();

    await click(find('invoice-continue-preview')!);
    expect(previewVisible()).toBe(true);
    await click(find('invoice-back-positions')!);

    expect(confirmCheckbox()!.checked, 'Ein Schrittwechsel entwertete die Bestätigung').toBe(
      true,
    );
    expect((find('invoice-continue-preview') as HTMLButtonElement).disabled).toBe(false);
  });

  it('R13B-3: eine fachliche Entwurfsänderung entwertet die Bestätigung', async () => {
    await renderAt('?type=rechnung', 'reverse_charge_13b');
    await confirm13b();
    await click(find('invoice-continue-preview')!);
    const searchAfterStep = currentSearch;

    /*
     * Der Entwurf wird nach der Bestätigung inhaltlich verändert — der
     * gespeicherte Hash gehört danach zu einem anderen Stand.
     */
    await click(find('invoice-back-positions')!);
    await changeQuantity('7');

    await remountAt(`?${searchAfterStep.replace(/^\?/, '')}`, 'reverse_charge_13b');

    expect(previewVisible(), 'Ein veralteter Punkt öffnete die Vorschau').toBe(false);
    expect(positionsVisible()).toBe(true);
    expect(confirmCheckbox()!.checked).toBe(false);
  });

  /** Neuaufbau auf einem anderen Vorgang — dessen Entwurf entsteht dort erstmals. */
  async function remountOtherVorgangAt(search: string, taxStatus: TaxStatus): Promise<void> {
    hydrateVorgangStore([createTestVorgang(), createTestVorgang({ id: 'v-test-2' })]);
    await act(async () => root.unmount());
    host.remove();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);

    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={[`/vorgaenge/v-test-2/rechnung${search}`]}>
          <AppProvider initialSetup={setupWith(taxStatus)}>
            <Routes>
              <Route
                path="/vorgaenge/:id/rechnung"
                element={
                  <>
                    <RechnungPage />
                    <SearchProbe />
                  </>
                }
              />
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
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await act(async () => {
        await new Promise((done) => setTimeout(done, 0));
      });
    }
  }

  it('R13B-5: ein anderer Vorgang übernimmt die Bestätigung nicht', async () => {
    await renderAt('?type=rechnung', 'reverse_charge_13b');
    await confirm13b();

    await remountOtherVorgangAt('?type=rechnung&step=preview', 'reverse_charge_13b');

    expect(previewVisible(), 'Ein fremder Vorgang erbte die Bestätigung').toBe(false);
    expect(confirmCheckbox()!.checked).toBe(false);
  });

  it('R13B-6: eine andere Rechnungsart übernimmt die Bestätigung nicht', async () => {
    await renderAt('?type=rechnung', 'reverse_charge_13b');
    await confirm13b();

    await remountAt('?type=schluss&step=preview', 'reverse_charge_13b');

    expect(previewVisible(), 'Die Schlussrechnung erbte die Bestätigung').toBe(false);
    expect(confirmCheckbox()!.checked).toBe(false);
  });

  it('R13B-7: der Standardsteuerstatus resumt unverändert', async () => {
    await renderAt('?type=rechnung&step=preview', 'standard_19');
    expect(previewVisible()).toBe(true);
    expect(currentSearch).toContain('step=preview');
  });

  /*
   * Eine im Speicher liegende Bestätigung darf einen ungeklärten Steuerstatus
   * nicht öffnen. Der zweite Vorgang bekommt einen frischen Entwurf mit
   * `unclear` — die Bestätigung aus dem ersten liegt daneben und muss wirkungslos
   * bleiben.
   */
  it('R13B-8: unclear bleibt trotz gespeicherter Bestätigung fail-closed', async () => {
    await renderAt('?type=rechnung', 'reverse_charge_13b');
    await confirm13b();

    await remountOtherVorgangAt('?type=rechnung&step=preview', 'unclear');

    expect(previewVisible(), 'Ein ungeklärter Steuerstatus erreichte die Vorschau').toBe(false);
    expect(positionsVisible()).toBe(true);
  });

  /*
   * Der eigentliche Bug: Der Rückfall wurde in die Adresse geschrieben und
   * löschte damit die Information, dass der Nutzer schon in der Vorschau war.
   * Geprüft wird deshalb nicht nur das Ergebnis, sondern dass `step=preview`
   * die Wiederaufnahme zu **keinem** Zeitpunkt verlässt.
   */
  it('R13B-9: die Adresse wird während der Wiederaufnahme nicht auf positions überschrieben', async () => {
    await renderAt('?type=rechnung', 'reverse_charge_13b');
    await confirm13b();
    await click(find('invoice-continue-preview')!);
    const searchAfterStep = currentSearch;

    await act(async () => root.unmount());
    host.remove();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);

    const seen: string[] = [];
    await act(async () => {
      root.render(
        <MemoryRouter initialEntries={[`/vorgaenge/v-test-1/rechnung${searchAfterStep}`]}>
          <AppProvider initialSetup={setupWith('reverse_charge_13b')}>
            <Routes>
              <Route
                path="/vorgaenge/:id/rechnung"
                element={
                  <>
                    <RechnungPage />
                    <SearchProbe />
                    <SearchRecorder onSearch={(value) => seen.push(value)} />
                  </>
                }
              />
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
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await act(async () => {
        await new Promise((done) => setTimeout(done, 0));
      });
    }

    expect(
      seen.some((value) => value.includes('step=positions')),
      `Die Adresse fiel zwischenzeitlich zurück: ${seen.join(' | ')}`,
    ).toBe(false);
    expect(previewVisible()).toBe(true);
  });
});
