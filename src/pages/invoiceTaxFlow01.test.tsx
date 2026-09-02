/**
 * INVOICE-TAX-FLOW-01B — die Steuerentscheidung liegt vor der Vorschau.
 *
 * Belegter Realbefund (Rechnung 2026-0004, BV Testzentrum): Die Vorschau zeigte
 * bereits `0 %`, den §13b-Rechtshinweis und Reverse Charge — und **erst
 * darunter** verlangte die Oberfläche die Bestätigung, dass §13b überhaupt
 * angewendet werden soll. Die Vorschau behauptete also eine Rechtsangabe, die
 * noch offen war.
 *
 * Ursache war nicht eine Automatik, sondern dass `CompanySetup.taxStatus`
 * ungefragt als konkrete Steuerart der Rechnung galt und in der Rechnungsanlage
 * bis zur Vorschau gar nicht sichtbar war.
 *
 * Geprüft wird die tatsächliche Oberfläche. Synthetische Daten, kein Netz, keine
 * Finalisierung.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { AppProvider } from '../context/AppContext';
import { DEFAULT_SETUP } from '../data/mockData';
import { DEFAULT_COMPANY_PROFILE } from '../data/companyProfileDefaults';
import { RechnungPage } from './RechnungPage';
import { createTestVorgang } from '../test/fixtures';
import { hydrateCompanyProfileStore } from '../services/companyProfileService';
import { hydrateDocumentStore } from '../services/documentService';
import { getVorgangById, hydrateVorgangStore } from '../services/vorgangService';
import { resetInvoiceNumberSequence } from '../services/invoiceNumberService';
import { setActiveStorageScope } from '../services/storage/storageScopeService';
import { resetInvoiceDraftDurabilityDatabaseForTests } from '../services/invoice/invoiceDraftDurabilityService';
import { validateInvoiceDraftForApproval } from '../services/invoiceService';
import { buildInvoicePrintModel } from '../services/invoicePrintModel';
import { buildRechnungDraft } from '../services/invoiceService';
import * as workspaceSyncPayloadService from '../services/workspace/workspaceSyncPayloadService';
import type { TaxStatus } from '../types/models';

const WORKSPACE_ID = 'ws-tax-flow-01b';

const company = {
  ...DEFAULT_COMPANY_PROFILE,
  companyName: 'Steuerfluss GmbH',
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

beforeEach(async () => {
  resetInvoiceNumberSequence();
  hydrateDocumentStore([]);
  hydrateCompanyProfileStore(company);
  hydrateVorgangStore([createTestVorgang()]);
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

/** Rendert die Rechnungsanlage und wartet, bis der Entwurf aus IndexedDB steht. */
async function renderPage(taxStatus: TaxStatus): Promise<void> {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={['/vorgaenge/v-test-1/rechnung']}>
        <AppProvider initialSetup={setupWith(taxStatus)}>
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
}

function find(testId: string): HTMLElement | null {
  return host.querySelector(`[data-testid="${testId}"]`);
}

function continueButton(): HTMLButtonElement {
  const button = find('invoice-continue-preview') as HTMLButtonElement | null;
  if (!button) throw new Error('continue button missing');
  return button;
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
  });
}

/** Die Vorschau ist erreicht, sobald das Rechnungsdokument gerendert ist. */
function previewReached(): boolean {
  return find('invoice-document-number') !== null;
}

async function tryContinue(): Promise<void> {
  await click(continueButton());
}

async function chooseTax(status: TaxStatus): Promise<void> {
  const chip = find(`invoice-tax-${status}`);
  if (!chip) throw new Error(`tax chip missing: ${status}`);
  await click(chip);
}

async function toggleConfirmation(): Promise<void> {
  const box = find('invoice-13b-confirm-checkbox') as HTMLInputElement | null;
  if (!box) throw new Error('13b checkbox missing');
  await act(async () => {
    box.click();
  });
}

/** Die sichtbaren Labels — bewusst der Nutzertext, nicht der technische Wert. */
const TAX_LABEL: Record<TaxStatus, string> = {
  standard_19: '19 % Regelbesteuerung',
  standard_7: '7 % Regelbesteuerung',
  kleinunternehmer_19: '§19 Kleinunternehmer',
  reverse_charge_13b: '§13b Reverse Charge',
  tax_free: 'Steuerfrei / ohne USt',
  unclear: 'Unklar / noch klären',
};

/**
 * INVOICE-TAX-FLOW-01D — die vollständige Kontrolle einer Steuerwahl.
 *
 * Geprüft wird nicht nur der aktive Chip, sondern auch, dass **kein anderer**
 * aktiv ist, und dass die Klartextzeile denselben Wert nennt. Genau diese Kette
 * fehlte, als auf dem iPhone statt „19 % Regelbesteuerung" tatsächlich
 * `kleinunternehmer_19` im Entwurf stand.
 */
function expectSelected(expected: TaxStatus): void {
  for (const status of Object.keys(TAX_LABEL) as TaxStatus[]) {
    const chip = find(`invoice-tax-${status}`);
    expect(chip, `Chip fehlt: ${status}`).not.toBeNull();
    expect(
      chip!.className.includes('chip--active'),
      `chip--active falsch für ${status}`,
    ).toBe(status === expected);
  }
  const selected = find('invoice-tax-selected');
  expect(selected?.textContent).toContain(TAX_LABEL[expected]);
  // Niemals der technische Wert.
  expect(selected?.textContent).not.toContain(expected);
}

describe('INVOICE-TAX-FLOW-01B — Steuerart im Positionsschritt', () => {
  // T1
  it('T1: standard_19 ist vor der Vorschau sichtbar und lässt weitergehen', async () => {
    await renderPage('standard_19');

    expect(find('invoice-tax-decision')).not.toBeNull();
    expect(find('invoice-tax-standard_19')?.className).toContain('chip--active');
    expect(find('invoice-13b-confirm')).toBeNull();
    expect(continueButton().disabled).toBe(false);

    await tryContinue();
    expect(previewReached()).toBe(true);
  });

  /*
   * T2 — der Realbefund.
   *
   * Der Entwurf startet mit §13b aus dem Firmen-Setup. Vor dem Fix führte
   * „Weiter zur Vorschau" hier direkt in eine fertige §13b-Vorschau.
   */
  it('T2: §13b aus dem Setup ist sichtbar und sperrt ohne Bestätigung', async () => {
    await renderPage('reverse_charge_13b');

    expect(find('invoice-tax-reverse_charge_13b')?.className).toContain('chip--active');
    // Die Bestätigung gehört zur Auswahl, nicht unter die Vorschau.
    expect(find('invoice-13b-confirm')).not.toBeNull();
    expect(find('invoice-tax-decision')?.contains(find('invoice-13b-confirm'))).toBe(true);
    expect(find('invoice-tax-decision-blocked')).not.toBeNull();
    expect(continueButton().disabled).toBe(true);

    await tryContinue();
    expect(previewReached()).toBe(false);
  });

  // T3
  it('T3: mit Bestätigung führt §13b in die Vorschau', async () => {
    await renderPage('reverse_charge_13b');
    await toggleConfirmation();

    expect(continueButton().disabled).toBe(false);
    await tryContinue();
    expect(previewReached()).toBe(true);
    // Die §13b-Karte ist nicht doppelt vorhanden.
    expect(find('invoice-13b-confirm')).toBeNull();
  });

  // T4
  it('T4: Wechsel weg von §13b und zurück verlangt erneute Bestätigung', async () => {
    await renderPage('reverse_charge_13b');
    await toggleConfirmation();
    expect(continueButton().disabled).toBe(false);

    await chooseTax('standard_19');
    expect(find('invoice-13b-confirm')).toBeNull();
    expect(continueButton().disabled).toBe(false);
    /*
     * R3 — der Zwischenzustand wird jetzt ausdrücklich geprüft.
     *
     * Bis 01D schaute dieser Test nur auf den zurückgesetzten Haken. Damit wäre
     * ein falsch gesetzter Steuerwert unbemerkt durchgegangen.
     */
    expectSelected('standard_19');

    await chooseTax('reverse_charge_13b');
    const box = find('invoice-13b-confirm-checkbox') as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(continueButton().disabled).toBe(true);
  });

  // T5
  it('T5: unclear sperrt vor der Vorschau mit sichtbarem Hinweis', async () => {
    await renderPage('unclear');

    expect(find('invoice-tax-unclear')?.className).toContain('chip--active');
    expect(find('invoice-tax-decision-blocked')?.textContent).toBeTruthy();
    expect(continueButton().disabled).toBe(true);

    await tryContinue();
    expect(previewReached()).toBe(false);

    // Nach Klärung geht es weiter — die Sperre ist kein Sackgassenzustand.
    await chooseTax('standard_19');
    expect(continueButton().disabled).toBe(false);
  });

  // T6 / T7 / T8 — die übrigen Steuerarten bleiben unverändert durchlässig.
  for (const status of ['standard_7', 'kleinunternehmer_19', 'tax_free'] as const) {
    it(`T6-8: ${status} führt unverändert in die Vorschau`, async () => {
      await renderPage(status);

      expect(find('invoice-13b-confirm')).toBeNull();
      expect(find('invoice-tax-decision-blocked')).toBeNull();
      expect(continueButton().disabled).toBe(false);

      await tryContinue();
      expect(previewReached()).toBe(true);
    });
  }

  /*
   * T9 — die Bestätigung wird bewusst nicht persistiert.
   *
   * Sie gehört in diesem Block nicht in den Draft-Vertrag. Nach einer neuen
   * Komponenteninstanz ist sie wieder offen; das ist die sichere Richtung.
   */
  it('T9: eine neue Instanz verlangt die §13b-Bestätigung erneut', async () => {
    await renderPage('reverse_charge_13b');
    await toggleConfirmation();
    expect(continueButton().disabled).toBe(false);

    await act(async () => root.unmount());
    host.remove();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);

    await renderPage('reverse_charge_13b');
    const box = find('invoice-13b-confirm-checkbox') as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(continueButton().disabled).toBe(true);
  });

  // T11 — im Bearbeitungsschritt gilt dieselbe Regel.
  it('T11: §13b im Bearbeitungsschritt sperrt den Rückweg zur Vorschau', async () => {
    await renderPage('standard_19');
    await tryContinue();
    expect(previewReached()).toBe(true);

    const editButton = find('invoice-edit') as HTMLButtonElement | null;
    // Der Bearbeitungsschritt wird über die Vorschau erreicht.
    expect(editButton, 'Bearbeiten-Schaltfläche nicht gefunden').not.toBeNull();
    await click(editButton!);

    await chooseTax('reverse_charge_13b');
    const back = find('invoice-back-preview') as HTMLButtonElement;
    expect(back.disabled).toBe(true);
    expect(find('invoice-13b-confirm')).not.toBeNull();

    await toggleConfirmation();
    expect((find('invoice-back-preview') as HTMLButtonElement).disabled).toBe(false);
  });
});

/**
 * INVOICE-TAX-FLOW-01D — Wertkette und Gegenprobe.
 *
 * Der iPhone-Realbefund: Der Nutzer wählte „19 % Regelbesteuerung" und die
 * Vorschau zeigte „§19 Kleinunternehmer" mit 0 %. Der Steuerpfad im Code ist
 * nachweislich korrekt (Analyse 01C) — geprüft wird deshalb die Kette
 * Klick → Wert → Klartext → Vorschau → Rückweg, in beide Richtungen, damit
 * `standard_19` und `kleinunternehmer_19` dauerhaft gegeneinander verriegelt
 * sind.
 */
describe('INVOICE-TAX-FLOW-01D — Wertkette 19 % und §19', () => {
  // R1
  it('R1: §13b → 19 % bleibt über Vorschau und Rückweg standard_19', async () => {
    await renderPage('reverse_charge_13b');
    await chooseTax('standard_19');

    expectSelected('standard_19');
    expect(find('invoice-13b-confirm')).toBeNull();
    expect(continueButton().disabled).toBe(false);

    await tryContinue();
    expect(previewReached()).toBe(true);
    const preview = host.textContent ?? '';
    expect(preview).toContain('MwSt. (19 %)');
    expect(preview).not.toContain('§19 Kleinunternehmer');
    expect(preview).not.toContain('§13b');

    await click(find('invoice-back-positions')!);
    expectSelected('standard_19');
  });

  // R2 — die Gegenprobe: dasselbe Verfahren, anderes Ziel.
  it('R2: §13b → §19 Kleinunternehmer ergibt tatsächlich §19', async () => {
    await renderPage('reverse_charge_13b');
    await chooseTax('kleinunternehmer_19');

    expectSelected('kleinunternehmer_19');
    expect(continueButton().disabled).toBe(false);

    await tryContinue();
    expect(previewReached()).toBe(true);
    const preview = host.textContent ?? '';
    expect(preview).toContain('§19 Kleinunternehmer');
    expect(preview).toContain('Gemäß § 19 UStG wird keine Umsatzsteuer berechnet.');
    expect(preview).not.toContain('MwSt. (19 %)');
    expect(preview).not.toContain('§13b');

    await click(find('invoice-back-positions')!);
    expectSelected('kleinunternehmer_19');
  });

  // R7
  it('R7: 7 % Regelbesteuerung führt zu 7 % in der Vorschau', async () => {
    await renderPage('standard_19');
    await chooseTax('standard_7');

    expectSelected('standard_7');
    await tryContinue();
    expect(host.textContent).toContain('MwSt. (7 %)');
  });

  // R6 — der Klartext gilt auch für den Sperrzustand.
  it('R6: unclear wird im Klartext benannt und bleibt gesperrt', async () => {
    await renderPage('unclear');

    expectSelected('unclear');
    expect(continueButton().disabled).toBe(true);
    await tryContinue();
    expect(previewReached()).toBe(false);
  });

  /*
   * R4 — die Steuerentscheidung steht vor der Summenkarte.
   *
   * Keine Pixelmessung: Geprüft wird die Dokumentreihenfolge. Sie ist der Grund,
   * warum die Summenkarte beim Umschalten auf einen Steuersatz > 0 die
   * Schaltflächen nicht mehr verschiebt.
   */
  it('R4: der Steuerbereich steht im DOM vor der Summenkarte', async () => {
    await renderPage('standard_19');

    const taxCard = find('invoice-tax-decision');
    const subtotalRow = Array.from(host.querySelectorAll('.data-row')).find((row) =>
      row.textContent?.includes('Zwischensumme'),
    );
    expect(taxCard, 'Steuerbereich fehlt').not.toBeNull();
    expect(subtotalRow, 'Summenkarte fehlt').not.toBeUndefined();
    expect(
      taxCard!.compareDocumentPosition(subtotalRow!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeGreaterThan(0);
  });

  // R8
  it('R8: der Bearbeitungsschritt zeigt denselben Klartext', async () => {
    await renderPage('standard_19');
    await tryContinue();
    await click(find('invoice-edit')!);

    expectSelected('standard_19');

    await chooseTax('reverse_charge_13b');
    expectSelected('reverse_charge_13b');
    expect((find('invoice-back-preview') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('INVOICE-TAX-FLOW-01B — Gates bleiben erhalten', () => {
  /*
   * T10 — Defense in Depth.
   *
   * Der neue Flow fängt §13b früher ab. Die bestehende Freigabeprüfung bleibt
   * trotzdem bestehen; sie sitzt im Fachdienst, nicht in der Oberfläche.
   */
  it('T10: die Freigabeprüfung blockiert §13b ohne Bestätigung weiterhin', () => {
    const draft = buildRechnungDraft('v-test-1', setupWith('reverse_charge_13b'));
    expect(draft).not.toBeNull();
    const withTax = { ...draft!, taxStatus: 'reverse_charge_13b' as const };

    const vorgang = getVorgangById('v-test-1');

    const blocked = validateInvoiceDraftForApproval(withTax, company, vorgang, {
      reverseCharge13bConfirmed: false,
    });
    expect(blocked.blockingErrors.map((item) => item.code)).toContain('reverse_charge_unconfirmed');

    const allowed = validateInvoiceDraftForApproval(withTax, company, vorgang, {
      reverseCharge13bConfirmed: true,
    });
    expect(allowed.blockingErrors.map((item) => item.code)).not.toContain(
      'reverse_charge_unconfirmed',
    );
  });

  // Die Steuerlogik selbst wurde nicht angefasst.
  it('T10b: unclear bleibt auch im Fachdienst ein Blocker', () => {
    const draft = buildRechnungDraft('v-test-1', setupWith('unclear'));
    const result = validateInvoiceDraftForApproval(draft!, company, getVorgangById('v-test-1'), {});
    expect(result.blockingErrors.map((item) => item.code)).toContain('tax_status');
  });

  // Berechnung und Rechtshinweise stammen weiterhin aus dem Bestandspfad.
  it('T10c: §13b bleibt 0 % mit unverändertem Rechtshinweis', () => {
    const draft = buildRechnungDraft('v-test-1', setupWith('reverse_charge_13b'));
    const model = buildInvoicePrintModel(draft!, setupWith('reverse_charge_13b'));
    expect(model.summary.taxRate).toBe(0);
    expect(model.taxNotices).toContain(
      'Steuerschuldnerschaft des Leistungsempfängers gemäß § 13b UStG.',
    );
  });
});
