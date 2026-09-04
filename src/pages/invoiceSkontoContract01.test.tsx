/**
 * SKONTO-INVOICE-TEXT-01B — Firmenstandard, Vertragsskonto und Handeingabe.
 *
 * Der Firmenstandard belegt den neuen Entwurf vor. Ein erkanntes Vertragsskonto
 * darf ihn ersetzen — und eine Ablehnung des Angebots muss auf den
 * Firmenstandard zurückfallen, **nicht** auf den Leerstring. Bis zu diesem
 * Block setzte die Auswahl „Nein" den Text hart auf leer und löschte dabei auch
 * jede Handeingabe.
 *
 * Der Rückfallwert stammt aus `draft.companySnapshot`, also aus dem beim Aufbau
 * eingefrorenen Profil. Eine spätere Änderung der Firmendaten verschiebt ihn
 * deshalb nicht.
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
import { RechnungPage, calendarDaysBetween } from './RechnungPage';
import { createAuftragInboxItem } from '../test/fixtures';
import {
  buildSyntheticWerkvertragPages,
  buildSyntheticWerkvertragText,
} from '../test/werkvertragMultiSectionFixtures';
import { hydrateCompanyProfileStore } from '../services/companyProfileService';
import { hydrateDocumentStore } from '../services/documentService';
import { hydrateInboxStore } from '../services/inboxService';
import { getVorgangById, hydrateVorgangStore } from '../services/vorgangService';
import { getContractSkontoOfferForVorgang } from '../services/contractIntelligenceService';
import { confirmImportSafeContractPositions } from '../services/contractPositionImportService';
import {
  createVorgangFromInboxWithContract,
  getContractPreviewForInbox,
} from '../services/intakeWorkflowService';
import { resetInvoiceNumberSequence } from '../services/invoiceNumberService';
import { setActiveStorageScope } from '../services/storage/storageScopeService';
import { resetInvoiceDraftDurabilityDatabaseForTests } from '../services/invoice/invoiceDraftDurabilityService';
import * as workspaceSyncPayloadService from '../services/workspace/workspaceSyncPayloadService';
import type { InboxItem } from '../types/models';

const WORKSPACE_ID = 'ws-skonto-contract-01b';
/** Der Firmenstandard dieses Betriebs. */
const COMPANY_SKONTO = 'Bei Zahlung innerhalb von 10 Tagen gewähren wir 2 % Skonto.';

const company = {
  ...DEFAULT_COMPANY_PROFILE,
  companyName: 'Skonto GmbH',
  street: 'Werk 1',
  zip: '80331',
  city: 'München',
  iban: 'DE89370400440532013000',
  bankName: 'Sparkasse',
  phone: '089 111',
  email: 'a@b.invalid',
  skontoEnabled: true,
  skontoPercent: 2,
  skontoDays: 10,
};

function syntheticWerkvertragItem(): InboxItem {
  return {
    ...createAuftragInboxItem(),
    id: 'inbox-skonto-werkvertrag',
    title: 'Werkvertrag BV Test',
    sender: 'Isobautec GmbH',
    recognizedData: {
      Kunde: 'Isobautec GmbH',
      Baustelle: 'BV Sägewerk Fisch',
      _vertragstext: buildSyntheticWerkvertragText(),
      _pageTexts: JSON.stringify(buildSyntheticWerkvertragPages()),
    },
  } as InboxItem;
}

let root: Root;
let host: HTMLDivElement;
let vorgangId = '';
let contractText = '';

beforeEach(async () => {
  resetInvoiceNumberSequence();
  hydrateDocumentStore([]);
  hydrateVorgangStore([]);
  hydrateCompanyProfileStore(company);

  const item = syntheticWerkvertragItem();
  hydrateInboxStore([item]);
  const preview = getContractPreviewForInbox(item);
  const created = createVorgangFromInboxWithContract(item);
  expect(created, 'Vorgang aus Vertrag konnte nicht erzeugt werden').not.toBeNull();
  confirmImportSafeContractPositions(created!.vorgang.id, preview.positions);
  vorgangId = created!.vorgang.id;

  const vorgang = getVorgangById(vorgangId)!;
  vorgang.createdFromInboxId = item.id;
  const offer = getContractSkontoOfferForVorgang(vorgang);
  expect(offer, 'Der Vertrag bietet kein Skonto an').not.toBeNull();
  contractText = offer!.text;
  // Vertrags- und Firmenwert müssen sich unterscheiden, sonst prüft der Test nichts.
  expect(contractText).not.toBe(COMPANY_SKONTO);

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

async function renderPage(): Promise<void> {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[`/vorgaenge/${vorgangId}/rechnung?type=rechnung`]}>
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

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
  });
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
  }
}

/** Der Skontotext, wie ihn die Vorschau tatsächlich zeigt. */
async function skontoInPreview(): Promise<string> {
  await click(find('invoice-continue-preview')!);
  const block = host.querySelector('.invoice-payment-block, [data-testid="invoice-document"]');
  return (block?.textContent ?? host.textContent ?? '').replace(/\s+/g, ' ');
}

describe('SKONTO-INVOICE-TEXT-01B — Vertragsskonto und Firmenstandard', () => {
  // R10 — angenommen: der Vertrag gewinnt.
  it('R10: angenommenes Vertragsskonto ersetzt den Firmenstandard', async () => {
    await renderPage();
    expect(find('invoice-skonto-choice'), 'Vertragsangebot nicht sichtbar').not.toBeNull();

    await click(find('invoice-skonto-yes')!);
    const preview = await skontoInPreview();
    expect(preview).toContain(contractText.replace(/\s+/g, ' '));
    expect(preview).not.toContain(COMPANY_SKONTO);
  });

  /*
   * R11 — abgelehnt: der Firmenstandard bleibt.
   *
   * Bis 01B ergab die Ablehnung einen leeren Skontotext. Der Betrieb verlor
   * damit seinen eingerichteten Hausstandard, nur weil ein Vertrag ein anderes
   * Skonto anbot.
   */
  it('R11: abgelehntes Vertragsskonto fällt auf den Firmenstandard zurück', async () => {
    await renderPage();
    await click(find('invoice-skonto-yes')!);
    await click(find('invoice-skonto-no')!);

    const preview = await skontoInPreview();
    expect(preview).toContain(COMPANY_SKONTO);
    expect(preview).not.toContain(contractText.replace(/\s+/g, ' '));
  });

  // Ohne jede Auswahl gilt von vornherein der Firmenstandard.
  it('R11b: ohne Auswahl steht der Firmenstandard im Entwurf', async () => {
    await renderPage();
    const preview = await skontoInPreview();
    expect(preview).toContain(COMPANY_SKONTO);
  });

  /*
   * R12 — eine Handeingabe überlebt.
   *
   * Der Effekt der Vertragsauswahl schreibt nur noch beim Umschalten. Vorher
   * lief er bei jeder Entwurfsänderung und löschte den Text.
   */
  it('R12: ein von Hand geänderter Skontotext wird nicht überschrieben', async () => {
    await renderPage();
    await click(find('invoice-continue-preview')!);
    await click(find('invoice-edit')!);

    const field = Array.from(host.querySelectorAll('input, textarea')).find(
      (element) => (element as HTMLInputElement).value === COMPANY_SKONTO,
    ) as HTMLInputElement | undefined;
    expect(field, 'Skontofeld im Bearbeitungsformular nicht gefunden').not.toBeUndefined();

    const manual = 'Zahlbar ohne Abzug — Skonto nach Absprache.';
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        field! instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype,
        'value',
      )?.set;
      setter?.call(field!, manual);
      field!.dispatchEvent(new Event('input', { bubbles: true }));
      field!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await act(async () => {
        await new Promise((done) => setTimeout(done, 0));
      });
    }

    await click(find('invoice-back-preview')!);
    const preview = (host.textContent ?? '').replace(/\s+/g, ' ');
    expect(preview).toContain(manual);
    expect(preview).not.toContain(COMPANY_SKONTO);
  });
});

/**
 * CONTRACT-SKONTO-DUE-DATE-CONSISTENCY-01B — ein Vertragsskonto, das länger
 * läuft als das Zahlungsziel dieser Rechnung, wird nicht übernommen.
 *
 * Der Erkenner liefert heute 2 % / 14 Tage. Steht das Zahlungsziel darunter,
 * verspräche die Übernahme einen Abzug für einen Zeitraum, in dem die Forderung
 * längst fällig ist. OfficePilot entscheidet dabei **nicht**, welche Kondition
 * gewinnt — es stellt den Widerspruch fest und überlässt die kaufmännische
 * Entscheidung dem Betrieb.
 */
describe('CONTRACT-SKONTO-DUE-DATE-CONSISTENCY-01B — Frist gegen Zahlungsziel', () => {
  /** Das Zahlungsziel der Rechnung entsteht aus dem Firmenprofil. */
  function withPaymentDays(days: number): void {
    hydrateCompanyProfileStore({ ...company, defaultPaymentDays: days });
  }

  function contractTextNormalized(): string {
    return contractText.replace(/\s+/g, ' ');
  }

  // T14 — die reine Tagesrechnung, unabhängig von Zeitzone und Sommerzeit.
  it('T14: Kalendertage werden über UTC gezählt', () => {
    expect(calendarDaysBetween('2026-09-01', '2026-09-08')).toBe(7);
    // Beide mitteleuropäischen Zeitumstellungen 2026.
    expect(calendarDaysBetween('2026-03-28', '2026-03-29')).toBe(1);
    expect(calendarDaysBetween('2026-10-24', '2026-10-25')).toBe(1);
    expect(calendarDaysBetween('2026-09-01', '2026-09-01')).toBe(0);
    expect(calendarDaysBetween('', '2026-09-01')).toBeNull();
    expect(calendarDaysBetween('2026-09-01', 'morgen')).toBeNull();
  });

  /*
   * T1 / T12 — der Kern.
   *
   * Zahlungsziel 7 Tage, Vertragsskonto 14 Tage: Die Übernahme unterbleibt, und
   * der bereits vorhandene Firmenstandard überlebt den Versuch unverändert.
   */
  it('T1/T12: 7 Tage Zahlungsziel nimmt 14 Tage Vertragsskonto nicht an', async () => {
    withPaymentDays(7);
    await renderPage();

    await click(find('invoice-skonto-yes')!);

    const preview = await skontoInPreview();
    expect(preview).toContain(COMPANY_SKONTO);
    expect(preview).not.toContain(contractTextNormalized());
  });

  // Der Hinweis nennt beide Zahlen und sagt ausdrücklich, dass nichts gilt.
  it('T1b: der Hinweis benennt Frist, Zahlungsziel und die Nichtübernahme', async () => {
    withPaymentDays(7);
    await renderPage();
    await click(find('invoice-skonto-yes')!);

    const hint = find('invoice-skonto-due-conflict');
    expect(hint, 'Konflikthinweis fehlt').not.toBeNull();
    const text = hint!.textContent ?? '';
    expect(text).toContain('14');
    expect(text).toContain('7');
    expect(text).toContain('nicht übernommen');
  });

  // Nach einem blockierten Versuch darf die Auswahl nicht als erfolgreich wirken.
  it('T1c: die Auswahl kehrt sichtbar auf Nein zurück', async () => {
    withPaymentDays(7);
    await renderPage();
    await click(find('invoice-skonto-yes')!);

    expect(find('invoice-skonto-yes')?.className).not.toContain('chip--active');
    expect(find('invoice-skonto-no')?.className).toContain('chip--active');
  });

  // T2
  it('T2: 20 Tage Zahlungsziel nimmt das Vertragsskonto an', async () => {
    withPaymentDays(20);
    await renderPage();
    await click(find('invoice-skonto-yes')!);

    expect(find('invoice-skonto-due-conflict')).toBeNull();
    expect(await skontoInPreview()).toContain(contractTextNormalized());
  });

  // T3 — Gleichstand ist gültig; verglichen wird mit `>`, nicht mit `>=`.
  it('T3: 14 Tage Zahlungsziel und 14 Tage Vertragsskonto sind zulässig', async () => {
    withPaymentDays(14);
    await renderPage();
    await click(find('invoice-skonto-yes')!);

    expect(find('invoice-skonto-due-conflict')).toBeNull();
    expect(await skontoInPreview()).toContain(contractTextNormalized());
  });

  // T5 — sofort fällig lässt keinen Skontozeitraum zu.
  it('T5: Zahlungsziel 0 Tage nimmt das Vertragsskonto nicht an', async () => {
    withPaymentDays(0);
    await renderPage();
    await click(find('invoice-skonto-yes')!);

    expect(find('invoice-skonto-due-conflict')).not.toBeNull();
    expect(await skontoInPreview()).not.toContain(contractTextNormalized());
  });

  /*
   * T10 / T11 — es wird nichts automatisch verändert.
   *
   * Das Fälligkeitsdatum bleibt sieben Tage nach dem Rechnungsdatum, und das
   * Angebot selbst behält Prozentsatz und Frist.
   */
  it('T10/T11: Fälligkeitsdatum und Angebot bleiben beim Konflikt unverändert', async () => {
    withPaymentDays(7);
    await renderPage();
    const offerBefore = find('invoice-skonto-yes')?.textContent;

    await click(find('invoice-skonto-yes')!);
    expect(find('invoice-skonto-yes')?.textContent).toBe(offerBefore);

    await click(find('invoice-continue-preview')!);
    await click(find('invoice-edit')!);
    const dates = Array.from(host.querySelectorAll('input[type="date"]')) as HTMLInputElement[];
    expect(calendarDaysBetween(dates[0]!.value, dates.at(-1)!.value)).toBe(7);
  });

  /*
   * T13 — der Konflikt ist auflösbar.
   *
   * Nach Verlängerung des Fälligkeitsdatums verschwindet der Hinweis von selbst
   * und die Übernahme gelingt. Keine Sackgasse.
   */
  it('T13: nach Verlängerung des Zahlungsziels gelingt die Übernahme', async () => {
    withPaymentDays(7);
    await renderPage();
    await click(find('invoice-skonto-yes')!);
    expect(find('invoice-skonto-due-conflict')).not.toBeNull();

    await click(find('invoice-continue-preview')!);
    await click(find('invoice-edit')!);
    const dates = Array.from(host.querySelectorAll('input[type="date"]')) as HTMLInputElement[];
    const issue = dates[0]!.value;
    const dueField = dates.at(-1)!;
    const extended = new Date(
      Date.UTC(
        Number(issue.slice(0, 4)),
        Number(issue.slice(5, 7)) - 1,
        Number(issue.slice(8, 10)) + 30,
      ),
    )
      .toISOString()
      .slice(0, 10);

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
        dueField,
        extended,
      );
      dueField.dispatchEvent(new Event('input', { bubbles: true }));
      dueField.dispatchEvent(new Event('change', { bubbles: true }));
    });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await act(async () => {
        await new Promise((done) => setTimeout(done, 0));
      });
    }

    await click(find('invoice-back-preview')!);
    await click(find('invoice-back-positions')!);

    expect(find('invoice-skonto-due-conflict')).toBeNull();
    await click(find('invoice-skonto-yes')!);
    expect(find('invoice-skonto-due-conflict')).toBeNull();
    expect(await skontoInPreview()).toContain(contractTextNormalized());
  });
});
