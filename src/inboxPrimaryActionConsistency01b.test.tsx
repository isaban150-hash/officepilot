/**
 * INBOX-PRIMARY-ACTION-CONSISTENCY-01B — die Eingangskarte verspricht nur, was
 * sie tut.
 *
 * Realbefund iPhone/Safari: Auf der Eingangsliste stand bei Rechnung **und**
 * Mahnung „Neuen Vorgang anlegen", während die Detailseite bereits korrekt
 * „Ausgabe erfassen" bzw. „Prüfen, ob schon bezahlt" zeigte.
 *
 * Belegte Ursache: `finalizeInboxPresentation` setzt die Listenaktion bewusst
 * auf „Jetzt prüfen" — lief aber **vor** `attachDocumentCaseMatch` und wurde
 * sofort wieder überschrieben.
 *
 * Der eigentliche Skandal daran ist nicht das Label, sondern die Unwahrheit:
 * `InboxCard` legt beim Klick **keinen** Vorgang an, sondern öffnet das
 * Dokument. Diese Suite prüft deshalb Beschriftung **und** Verhalten.
 *
 * Bisher war die Lücke unsichtbar, weil alle Listenzusicherungen
 * Negativsicherungen waren („nie record_expense") — die `create_vorgang`
 * mühelos erfüllt.
 *
 * Synthetische Daten, kein Netz, keine echte Buchung.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

import { AppProvider } from './context/AppContext';
import { DEFAULT_SETUP } from './data/mockData';
import { InboxCard } from './components/inbox/InboxCard';
import { buildInboxDocumentSummary } from './services/documentSummary';
import { hydrateInboxStore } from './services/inboxService';
import { hydrateVorgangStore } from './services/vorgangService';
import { hydrateExpenseStore } from './services/expenseStore';
import { getAllExpenses } from './services/expenseService';
import { getAllVorgaenge } from './services/vorgangService';
import { createAuftragInboxItem, createTestVorgang } from './test/fixtures';
import { resetTestStores } from './test/resetStores';
import { t, type TranslationKey } from './i18n';
import type { ClassifiedDocumentKind, InboxItem, Vorgang } from './types/models';

const SUPPLIER = 'Westfalen Testlieferant fuer OfficePilot';
const SITE = 'Teststraße 24, 33602 Bielefeld';

const translate = (key: TranslationKey) => t(key, 'de');
const REVIEW_LABEL = t('inbox.reviewNow', 'de');
const OPEN_CASE_LABEL = t('documentExperience.action.openCase', 'de');

function doc(
  kind: ClassifiedDocumentKind,
  overrides: Partial<InboxItem> = {},
): InboxItem {
  const { recognizedData, ...rest } = overrides;
  return {
    ...createAuftragInboxItem({ id: `inbox-consistency-${kind}` }),
    title: `${kind} ${SUPPLIER}`,
    sender: SUPPLIER,
    classifiedKind: kind,
    documentType: 'eingangsrechnung',
    recognizedData: {
      Rechnungsnummer: 'RE-4711',
      Betrag: '486,20 EUR',
      Lieferant: SUPPLIER,
      ...recognizedData,
    },
    ...rest,
  } as InboxItem;
}

function matchingVorgang(overrides: Partial<Vorgang> = {}): Vorgang {
  return createTestVorgang({
    id: 'vg-consistency-01b',
    title: 'Bauvorhaben Teststraße',
    customer: SUPPLIER,
    baustelle: SITE,
    ...overrides,
  });
}

/** Die Hauptaktion, wie sie die Eingangskarte sieht. */
function listPrimary(item: InboxItem): string {
  return buildInboxDocumentSummary(item, { translate }).primaryAction.id;
}

function listLabel(item: InboxItem): string {
  return translate(buildInboxDocumentSummary(item, { translate }).primaryAction.labelKey);
}

beforeEach(() => {
  resetTestStores();
  hydrateVorgangStore([]);
  hydrateInboxStore([]);
  hydrateExpenseStore([]);
});

describe('INBOX-PRIMARY-ACTION-CONSISTENCY-01B — jede Karte führt zur Prüfung', () => {
  /*
   * R1–R10 — die Generalitätslücke war vollständig: Alle Nicht-Verträge liefen
   * durch dieselbe Funktion und verloren dieselbe Aktion.
   */
  it('R1: eine normale Eingangsrechnung zeigt „Jetzt prüfen"', () => {
    const item = doc('eingangsrechnung');
    expect(listPrimary(item)).toBe('review_document');
    expect(listLabel(item)).toBe(REVIEW_LABEL);
    expect(listPrimary(item)).not.toBe('create_vorgang');
    // Die fachliche Erfassung gehört auf die Detailseite, nicht in die Liste.
    expect(listPrimary(item)).not.toBe('record_expense');
  });

  it.each(['mahnung', 'zahlungserinnerung'] as const)(
    'R2/R3: %s zeigt „Jetzt prüfen" statt einer Vorgangsanlage',
    (kind) => {
      const item = doc(kind);
      expect(listPrimary(item)).toBe('review_document');
      expect(listPrimary(item)).not.toBe('create_vorgang');
      expect(listPrimary(item)).not.toBe('check_payment');
    },
  );

  it.each(['tankbeleg', 'kassenbeleg', 'quittung'] as const)(
    'R4/R5: %s zeigt „Jetzt prüfen"',
    (kind) => {
      const item = doc(kind, { recognizedData: { Betrag: '68,57 EUR' } });
      expect(listPrimary(item)).toBe('review_document');
      expect(listPrimary(item)).not.toBe('record_expense');
    },
  );

  it('R6: ein Behördenbrief zeigt „Jetzt prüfen"', () => {
    const item = doc('behoerdenbrief', {
      documentType: 'behoerde',
      recognizedData: { Behörde: 'Finanzamt Bielefeld', Betreff: 'Prüfung' },
    });
    expect(listPrimary(item)).toBe('review_document');
    expect(listPrimary(item)).not.toBe('create_task');
  });

  it('R7: ein allgemeiner Brief zeigt „Jetzt prüfen"', () => {
    const item = doc('brief', {
      documentType: 'brief',
      recognizedData: { Absender: SUPPLIER, Betreff: 'Information' },
    });
    expect(listPrimary(item)).toBe('review_document');
  });

  it('R8: ein noch unklares Schreiben zeigt „Jetzt prüfen"', () => {
    const item = doc('sonstiges', {
      documentType: 'sonstiges',
      recognizedData: { Absender: SUPPLIER },
    });
    expect(listPrimary(item)).toBe('review_document');
    // Gerade hier wäre „Neuen Vorgang anlegen" die schlechteste Aufforderung.
    expect(listPrimary(item)).not.toBe('create_vorgang');
  });

  it('R9: ein Angebot zeigt „Jetzt prüfen"', () => {
    const item = doc('angebot', { recognizedData: { Betrag: '2.400,00 EUR' } });
    expect(listPrimary(item)).toBe('review_document');
  });

  it('R10: ein Lieferschein zeigt „Jetzt prüfen"', () => {
    const item = doc('lieferschein', { recognizedData: { Datum: '01.08.2026' } });
    expect(listPrimary(item)).toBe('review_document');
  });

  it('R11: ein unverknüpfter Werkvertrag zeigt „Jetzt prüfen", keine Vertragsannahme', () => {
    const item = doc('werkvertrag', {
      documentType: 'vertrag',
      recognizedData: {
        Auftraggeber: 'Isobautec GmbH',
        Bauvorhaben: 'Dachsanierung',
        Vertragssumme: '12.000,00 €',
      },
    });
    expect(listPrimary(item)).toBe('review_document');
    expect(listPrimary(item), 'Die Liste bot eine Vertragsannahme an').not.toBe(
      'accept_contract_order',
    );
  });

  it('R12/R21: ein bestätigt verknüpfter Vertrag behält „Vorgang öffnen"', () => {
    const vorgang = matchingVorgang();
    hydrateVorgangStore([vorgang]);
    const item = doc('werkvertrag', {
      documentType: 'vertrag',
      vorgangId: vorgang.id,
      vorgangLinkStatus: 'linked',
    });

    expect(listPrimary(item)).toBe('open_vorgang');
    expect(listLabel(item)).toBe(OPEN_CASE_LABEL);
  });
});

describe('INBOX-PRIMARY-ACTION-CONSISTENCY-01B — der Fallabgleich bleibt Kontext', () => {
  /*
   * R17–R20 — die Trefferdaten verschwinden nicht; nur die sichtbare Aktion
   * wird ehrlich.
   */
  it('R17: ohne Treffer bleibt der Fallabgleich am Summary erhalten', () => {
    const item = doc('eingangsrechnung');
    const summary = buildInboxDocumentSummary(item, { translate });

    expect(summary.caseMatch).toBeTruthy();
    expect(summary.caseMatch?.matchStatus).toBe('none');
    expect(summary.primaryAction.id).toBe('review_document');
  });

  it('R18/R19: ein Treffer ohne bestätigte Verknüpfung ändert die Listenaktion nicht', () => {
    hydrateVorgangStore([matchingVorgang()]);
    const item = doc('eingangsrechnung', { recognizedData: { Baustelle: SITE } });
    const summary = buildInboxDocumentSummary(item, { translate });

    expect(summary.caseMatch?.matchStatus, 'Der Test prüft nicht den gemeinten Zustand').not.toBe(
      'none',
    );
    expect(summary.primaryAction.id).toBe('review_document');
    expect(summary.primaryAction.id).not.toBe('link_vorgang');
    expect(summary.primaryAction.id).not.toBe('select_vorgang');
  });

  it('R19b: mehrere mögliche Vorgänge machen keine Auswahl zur Listenaktion', () => {
    hydrateVorgangStore([
      matchingVorgang({ id: 'vg-a', title: 'Bauvorhaben A' }),
      matchingVorgang({ id: 'vg-b', title: 'Bauvorhaben B' }),
    ]);
    const item = doc('eingangsrechnung', { recognizedData: { Baustelle: SITE } });

    expect(listPrimary(item)).toBe('review_document');
  });

  it('R20: eine ins Leere zeigende Verknüpfung führt nicht zu „Vorgang öffnen"', () => {
    hydrateVorgangStore([]);
    const item = doc('eingangsrechnung', {
      vorgangId: 'vg-existiert-nicht',
      vorgangLinkStatus: 'linked',
    });

    expect(listPrimary(item)).toBe('review_document');
    expect(listPrimary(item)).not.toBe('open_vorgang');
    expect(listPrimary(item)).not.toBe('link_vorgang');
  });

  it('R22: „Später" bleibt als Nebenaktion erhalten', () => {
    const item = doc('eingangsrechnung');
    const summary = buildInboxDocumentSummary(item, { translate });

    expect(summary.secondaryActions.map((a) => a.id)).toEqual(['later']);
  });
});

/* ————— Verhalten der echten Karte ————— */

let host: HTMLDivElement;
let root: Root;
let currentPath = '';

function PathProbe() {
  currentPath = useLocation().pathname;
  return null;
}

async function settle(rounds = 15): Promise<void> {
  for (let attempt = 0; attempt < rounds; attempt += 1) {
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
  }
}

async function renderCard(item: InboxItem, onReview: (id: string) => void): Promise<void> {
  hydrateInboxStore([item]);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: ['/ablage'] },
        createElement(
          AppProvider,
          { initialSetup: { ...DEFAULT_SETUP, setupComplete: true } },
          createElement(
            Routes,
            null,
            createElement(Route, {
              path: '*',
              element: createElement(
                'div',
                null,
                createElement(PathProbe),
                createElement(InboxCard, { item, onReview, onUpdated: () => {} }),
              ),
            }),
          ),
        ),
      ),
    );
  });
  await settle();
}

async function clickPrimary(itemId: string): Promise<void> {
  const button = host.querySelector(
    `[data-testid="inbox-review-${itemId}"]`,
  ) as HTMLButtonElement | null;
  expect(button, 'Hauptaktion der Karte nicht gefunden').not.toBeNull();
  await act(async () => {
    button!.click();
  });
  await settle(5);
}

describe('INBOX-PRIMARY-ACTION-CONSISTENCY-01B — Beschriftung und Verhalten stimmen überein', () => {
  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('R14: „Jetzt prüfen" auf einer Rechnung öffnet das Dokument und bucht nichts', async () => {
    const item = doc('eingangsrechnung');
    const onReview = vi.fn();
    await renderCard(item, onReview);

    expect(host.querySelector(`[data-testid="inbox-review-${item.id}"]`)?.textContent).toContain(
      REVIEW_LABEL,
    );
    await clickPrimary(item.id);

    expect(onReview).toHaveBeenCalledWith(item.id);
    expect(getAllExpenses().length, 'Die Liste hat gebucht').toBe(0);
    expect(getAllVorgaenge().length, 'Die Liste hat einen Vorgang angelegt').toBe(0);
  });

  it('R15: „Jetzt prüfen" auf einer Mahnung öffnet das Dokument ohne Finanzwirkung', async () => {
    const item = doc('mahnung');
    const onReview = vi.fn();
    await renderCard(item, onReview);

    await clickPrimary(item.id);

    expect(onReview).toHaveBeenCalledWith(item.id);
    expect(getAllExpenses().length).toBe(0);
    expect(getAllVorgaenge().length).toBe(0);
  });

  it('R16: „Jetzt prüfen" auf einem unverknüpften Vertrag nimmt keinen Auftrag an', async () => {
    const item = doc('werkvertrag', {
      documentType: 'vertrag',
      recognizedData: { Auftraggeber: 'Isobautec GmbH', Vertragssumme: '12.000,00 €' },
    });
    const onReview = vi.fn();
    await renderCard(item, onReview);

    await clickPrimary(item.id);

    expect(onReview).toHaveBeenCalledWith(item.id);
    expect(getAllVorgaenge().length, 'Die Liste hat einen Auftrag erzeugt').toBe(0);
  });

  it('R13: „Vorgang öffnen" navigiert wirklich zum vorhandenen Vorgang', async () => {
    const vorgang = matchingVorgang();
    hydrateVorgangStore([vorgang]);
    const item = doc('werkvertrag', {
      documentType: 'vertrag',
      vorgangId: vorgang.id,
      vorgangLinkStatus: 'linked',
    });
    const onReview = vi.fn();
    await renderCard(item, onReview);

    expect(host.querySelector(`[data-testid="inbox-review-${item.id}"]`)?.textContent).toContain(
      OPEN_CASE_LABEL,
    );
    await clickPrimary(item.id);

    expect(currentPath).toBe(`/vorgaenge/${vorgang.id}`);
    expect(onReview, 'Statt zu navigieren wurde das Dokument geöffnet').not.toHaveBeenCalled();
  });
});
