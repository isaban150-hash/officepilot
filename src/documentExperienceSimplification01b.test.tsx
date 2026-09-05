/**
 * DOCUMENT-EXPERIENCE-SIMPLIFICATION-01B — eine kanonische Dokumentansicht.
 *
 * Vorher entschieden `prioritizeContractWorkspace` und
 * `useAssistFlowConsolidate` über drei verschiedene Anordnungen derselben
 * Bausteine, und vor dem Inhalt standen zwei destruktive Aktionen. Vier
 * gleichrangige Assistenzflächen drängten sich zwischen Dokument und Handlung.
 *
 * Jetzt gilt für jedes Dokument dieselbe Reihenfolge:
 *   Was ist das · Worum geht es · Was jetzt tun · Frage zum Dokument · Details
 *
 * Geprüft wird über den produktiven Mount der Seite, an der tatsächlichen
 * DOM-Reihenfolge — nicht an einzelnen Elementen.
 *
 * Synthetische Daten, kein Netz, keine produktive Erfassung.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { AppProvider } from './context/AppContext';
import { DEFAULT_SETUP } from './data/mockData';
import { EingangDetailPage } from './pages/EingangDetailPage';
import { createAuftragInboxItem } from './test/fixtures';
import { buildSyntheticWerkvertragText } from './test/werkvertragMultiSectionFixtures';
import { hydrateInboxStore } from './services/inboxService';
import { hydrateVorgangStore } from './services/vorgangService';
import { hydrateCustomerStore } from './services/customerStoreService';
import { setActiveStorageScope } from './services/storage/storageScopeService';
import type { ClassifiedDocumentKind, InboxItem } from './types/models';

const ITEM_ID = 'inbox-experience-01b';

let root: Root;
let host: HTMLDivElement;

function seed(kind: ClassifiedDocumentKind, overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    ...createAuftragInboxItem({ id: ITEM_ID }),
    title: `${kind} Testdokument`,
    sender: 'Westfalen SHK Grosshandel GmbH',
    classifiedKind: kind,
    documentType: 'eingangsrechnung',
    recognizedData: {
      Rechnungsnummer: 'RE-4711',
      Betrag: '486,20 EUR',
      Lieferant: 'Westfalen SHK Grosshandel GmbH',
    },
    ...overrides,
  } as InboxItem;
}

beforeEach(() => {
  setActiveStorageScope({ type: 'guest' });
  localStorage.clear();
  sessionStorage.clear();
  hydrateVorgangStore([]);
  hydrateCustomerStore([]);
  host = document.createElement('div');
  host.className = 'app-shell__main';
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = '';
  localStorage.clear();
  vi.restoreAllMocks();
});

async function settle(rounds = 30): Promise<void> {
  for (let attempt = 0; attempt < rounds; attempt += 1) {
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
  }
}

async function renderDetail(item: InboxItem): Promise<void> {
  hydrateInboxStore([item]);
  await act(async () => {
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: [`/ablage/${ITEM_ID}`] },
        createElement(
          AppProvider,
          { initialSetup: { ...DEFAULT_SETUP, setupComplete: true } },
          createElement(
            Routes,
            null,
            createElement(Route, {
              path: '/ablage/:id',
              element: createElement(EingangDetailPage),
            }),
          ),
        ),
      ),
    );
  });
  await settle();
}

function find(testId: string): HTMLElement | null {
  return host.querySelector(`[data-testid="${testId}"]`);
}

/** Position im DOM — so lässt sich echte Reihenfolge prüfen, nicht nur Existenz. */
function orderOf(testId: string): number {
  const all = Array.from(host.querySelectorAll('[data-testid]'));
  return all.findIndex((el) => el.getAttribute('data-testid') === testId);
}

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
  });
  await settle(10);
}

/** Öffnet „Details anzeigen" und danach eine Untergruppe. */
async function openDetailSection(id: string): Promise<void> {
  const shell = host.querySelector<HTMLElement>('[data-testid="document-review-more-toggle"]');
  if (shell) await click(shell);
  const toggle = find(`review-section-toggle-${id}`);
  if (toggle) await click(toggle);
}

describe('DOCUMENT-EXPERIENCE-SIMPLIFICATION-01B — kanonische Ansicht', () => {
  /*
   * R1 — dieselbe Reihenfolge für jedes Dokument.
   *
   * Geprüft an der DOM-Position, weil genau die drei Renderzweige sie früher
   * je nach Dokument vertauschten.
   */
  it.each(['eingangsrechnung', 'mahnung', 'brief'] as const)(
    'R1: %s folgt der kanonischen Reihenfolge',
    async (kind) => {
      await renderDetail(seed(kind));

      const card = orderOf('document-experience-card');
      const actions = orderOf('document-experience-actions');
      const chat = orderOf('document-free-question-panel');

      expect(card, 'Keine Experience Card').toBeGreaterThanOrEqual(0);
      expect(actions, 'Keine Aktionszone').toBeGreaterThan(card);
      expect(chat, 'Der Chat steht nicht nach den Aktionen').toBeGreaterThan(actions);
      // Genau eine kanonische Hülle, kein Variantenzweig mehr.
      expect(find('eingang-assist-flow')?.getAttribute('data-assist-flow')).toBe('canonical');
    },
  );

  /*
   * R6 — „Angaben prüfen" ist keine Hauptfläche mehr.
   *
   * Der Abschnitt drängte sich zwischen Dokument und Handlung; er gehört zu
   * den Daten, nicht zur Entscheidung.
   */
  it('R6: „Angaben prüfen" steht nicht mehr im Hauptfluss', async () => {
    await renderDetail(seed('eingangsrechnung'));

    expect(
      find('document-field-fill-confirm'),
      'Angabenprüfung weiterhin permanent sichtbar',
    ).toBeNull();
  });

  /*
   * R7 — technische Inhalte erst nach dem Aufklappen.
   */
  it('R7: Originaldokument und Verwaltung erscheinen erst unter „Details"', async () => {
    await renderDetail(seed('eingangsrechnung', { fileRefId: 'file-ref-01b' }));

    expect(find('ablage-original-file'), 'Originaldatei im Hauptfluss').toBeNull();
    expect(find('inbox-delete-trigger'), 'Löschen im Hauptfluss').toBeNull();
    expect(find('inbox-unlink-vorgang-trigger')).toBeNull();

    await openDetailSection('administration');
    expect(find('inbox-delete-trigger'), 'Löschen auch in den Details nicht erreichbar')
      .not.toBeNull();
  });

  /*
   * R14 — destruktive Wege bleiben erreichbar, nur nicht mehr vor dem Inhalt.
   */
  it('R14: Löschen bleibt erreichbar und steht hinter dem Inhalt', async () => {
    await renderDetail(seed('eingangsrechnung'));
    await openDetailSection('administration');

    const card = orderOf('document-experience-card');
    const del = orderOf('inbox-delete-trigger');
    expect(del).toBeGreaterThan(card);
  });

  /*
   * R8 — der Chat bleibt sichtbar und dokumentgebunden.
   */
  it('R8: die Frage zum Dokument bleibt ohne Aufklappen sichtbar', async () => {
    await renderDetail(seed('eingangsrechnung'));

    expect(find('document-free-question-panel'), 'Chat nicht mehr sichtbar').not.toBeNull();
  });

  /*
   * R9 — der Antwortentwurf ist keine vierte Dauerkarte mehr.
   */
  it('R9: der Antwortentwurf steht nicht permanent im Hauptfluss', async () => {
    await renderDetail(seed('brief', { documentType: 'brief' }));

    expect(find('document-confirmed-reply-draft')).toBeNull();
  });

  /*
   * R2 — die Eingangsrechnung behält ihre Finanzaktion.
   *
   * Nicht-Regression zu DOCUMENT-INVOICE-PRIMARY-ACTION-01B: Die
   * Umstrukturierung darf das Routing nicht zurückdrehen.
   */
  it('R2: eine Eingangsrechnung zeigt weiterhin keine Vorgangs-Hauptaktion', async () => {
    await renderDetail(seed('eingangsrechnung'));

    const primary = find('document-review-apply-button');
    expect(primary?.textContent ?? '').not.toContain('Vorgang anlegen');
  });

  /*
   * R3 / R15 — die Mahnung bleibt geschützt.
   *
   * Weder Haupt- noch Nebenaktion darf die Erfassung anbieten; der Belegbezug
   * aus DOCUMENT-ACCOUNTING-REFERENCE-SAFETY bleibt sichtbar.
   */
  it('R3/R15: eine Mahnung bietet keine Erfassungsaktion und zeigt den Belegbezug', async () => {
    await renderDetail(seed('mahnung'));

    const accept = Array.from(host.querySelectorAll('button')).filter((b) =>
      (b.textContent ?? '').includes('Als Ausgabe erfassen'),
    );
    expect(accept, 'Mahnung bietet die Erfassung an').toEqual([]);
    expect(find('document-finance-reference'), 'Belegprüfung fehlt').not.toBeNull();
  });

  /*
   * R16 — die verbindliche Reihenfolge 1–2–3–4.
   *
   * Kopf **und Fakten** beantworten „Was ist das?"; sie stehen deshalb vor der
   * Erklärung. In 01B lag die Prosa noch dazwischen.
   */
  it.each(['eingangsrechnung', 'mahnung', 'brief'] as const)(
    'R16: %s zeigt Kopf → Fakten → Erklärung → Aktionen → Chat → Details',
    async (kind) => {
      await renderDetail(seed(kind));

      const header = orderOf('document-experience-header');
      const facts = orderOf('document-experience-facts');
      const lead = orderOf('document-experience-lead');
      const actions = orderOf('document-experience-actions');
      const chat = orderOf('document-free-question-panel');
      const details = orderOf('document-review-more-options');

      expect(header).toBeGreaterThanOrEqual(0);
      if (facts >= 0) expect(facts, 'Fakten stehen nicht direkt nach dem Kopf').toBeGreaterThan(header);
      if (lead >= 0 && facts >= 0) {
        expect(lead, 'Die Erklärung steht vor den Fakten').toBeGreaterThan(facts);
      }
      if (lead >= 0) expect(actions, 'Aktionen stehen vor der Erklärung').toBeGreaterThan(lead);
      expect(chat).toBeGreaterThan(actions);
      expect(details, 'Details stehen nicht am Ende').toBeGreaterThan(chat);
    },
  );

  /*
   * R17 — höchstens vier Kopffakten, typspezifisch priorisiert.
   */
  it('R17: eine Eingangsrechnung zeigt höchstens vier Kopffakten', async () => {
    await renderDetail(
      seed('eingangsrechnung', {
        deadline: '2026-09-03',
        recognizedData: {
          Rechnungsnummer: 'RE-4711',
          Betrag: '486,20 EUR',
          Lieferant: 'Westfalen SHK Grosshandel GmbH',
          Datum: '20.08.2026',
          Baustelle: 'Teststraße 24',
          Kunde: 'Irgendwer',
        },
      }),
    );

    const rows = host.querySelectorAll('[data-testid="document-experience-facts"] .data-row');
    expect(rows.length, 'Mehr als vier Kopffakten').toBeLessThanOrEqual(4);
    expect(rows.length).toBeGreaterThan(0);
  });

  it('R17b: ein Behördenbrief zeigt höchstens vier passende Kopffakten', async () => {
    await renderDetail(
      seed('finanzamt', {
        documentType: 'behoerde',
        sender: 'Finanzamt Bielefeld',
        deadline: '2026-09-10',
        recognizedData: {
          Betreff: 'Umsatzsteuer-Voranmeldung',
          Aktenzeichen: '305/1234/5678',
          Baustelle: 'Sollte hier nicht stehen',
        },
      }),
    );

    const rows = host.querySelectorAll('[data-testid="document-experience-facts"] .data-row');
    expect(rows.length).toBeLessThanOrEqual(4);
  });

  /*
   * R18 — Warnungen ohne Handlungsbezug verschwinden aus dem Hauptbereich.
   *
   * „Vorgangsbezug unklar" beeinflusst bei einer Lieferantenrechnung keine
   * Entscheidung; in den Kartendetails bleibt der Hinweis erhalten.
   */
  it('R18: „Vorgangsbezug unklar" steht nicht mehr prominent', async () => {
    await renderDetail(seed('eingangsrechnung'));

    expect(find('document-experience-alert-gap-vorgang_unclear')).toBeNull();
    expect(find('document-experience-alert-recognition')).toBeNull();

    // Nach dem Aufklappen bleibt der vollständige Satz an Hinweisen erhalten.
    const shell = host.querySelector<HTMLElement>('[data-testid="document-review-more-toggle"]');
    await click(shell!);
    expect(find('document-experience-details-body')?.textContent ?? '').toContain('Vorgangsbezug');
  });

  /*
   * R20 — die notwendige Bestätigung kommt in den Aktionsfluss.
   *
   * Vorher meldete OfficePilot nur „Bitte zuerst die Ablageentscheidung
   * bestätigen." und der Nutzer musste sie in technischen Bereichen suchen.
   */
  it('R20: eine blockierte Hauptaktion zeigt die Ablagebestätigung direkt', async () => {
    // `markedAsCompanyDocument` schaltet die Hauptaktion frei — sonst ist sie
    // deaktiviert und der Klick liefe ins Leere, ohne die Sperre auszulösen.
    await renderDetail(seed('eingangsrechnung', { markedAsCompanyDocument: true }));

    expect(find('action-filing-confirm'), 'Bestätigung ohne Anlass sichtbar').toBeNull();

    const primary = find('document-review-apply-button');
    expect(primary).not.toBeNull();
    await click(primary!);

    const prompt = find('action-filing-confirm');
    expect(prompt, 'Die Ablagebestätigung erscheint nicht im Aktionsfluss').not.toBeNull();
    // Sie steht zwischen Aktionen und Details — nicht in einer technischen Sektion.
    expect(orderOf('action-filing-confirm')).toBeGreaterThan(orderOf('document-experience-actions'));
    expect(orderOf('action-filing-confirm')).toBeLessThan(orderOf('document-review-more-options'));
    // Nichts wurde automatisch bestätigt.
    expect(prompt?.textContent ?? '').toContain('Ablage');
  });

  /*
   * R21 — der Chat ist im Ausgangszustand kompakt.
   */
  it('R21: der Chat zeigt zunächst nur Titel und Eingabefeld', async () => {
    await renderDetail(seed('eingangsrechnung'));

    expect(find('document-free-question-panel')).not.toBeNull();
    expect(find('document-free-question-input')).not.toBeNull();
    expect(find('document-free-question-scope-hint'), 'Der Hinweistext füllt die Karte')
      .toBeNull();
  });

  /*
   * R26 / R27 — „Worum geht es?" beschreibt das Dokument, nicht den Prozess.
   *
   * Realbefund auf dem iPhone: Dort stand „Rechnungsdaten prüfen und erst nach
   * Freigabe finalisieren." — eine Handlungsanweisung. Der Nutzer erfuhr weder
   * wer schreibt noch worüber.
   */
  it('R26/R27: die Erklärung nennt Lieferant, Nummer und Betrag statt Prozesssprache', async () => {
    await renderDetail(seed('eingangsrechnung'));

    const lead = find('document-experience-lead')?.textContent ?? '';
    expect(lead).toContain('Westfalen');
    expect(lead).toContain('RE-4711');
    expect(lead).toContain('486,20');
    expect(lead, 'Die Prozessanweisung steht wieder an der Stelle der Erklärung')
      .not.toContain('erst nach Freigabe finalisieren');

    // Der nächste Schritt bleibt erhalten — nur an seinem eigenen Ort.
    const shell = host.querySelector<HTMLElement>('[data-testid="document-review-more-toggle"]');
    await click(shell!);
    expect(find('document-experience-next-step')).not.toBeNull();
  });

  it('R26b: eine Mahnung erklärt die Erinnerung und die Prüfbitte', async () => {
    await renderDetail(seed('mahnung'));

    const lead = find('document-experience-lead')?.textContent ?? '';
    expect(lead).toContain('Westfalen');
    expect(lead).toContain('RE-4711');
    expect(lead).toContain('bereits bezahlt');
  });

  /*
   * R28 — keine belanglosen Auffälligkeiten mehr über den Aktionen.
   *
   * „Gegenpartei unklar" widersprach direkt der Zeile darüber, in der der
   * Lieferant stand.
   */
  it('R28: bei sichtbarem Lieferanten verschwindet „Gegenpartei unklar"', async () => {
    await renderDetail(seed('eingangsrechnung'));

    expect(find('document-experience-alert-gap-counterparty_unclear')).toBeNull();
    expect(find('document-experience-alert-sender-uncertain')).toBeNull();
    expect(find('document-experience-alert-gap-vorgang_unclear')).toBeNull();
  });

  /*
   * R30 — nur ein Details-Einstieg im Hauptfluss.
   */
  it('R30: es gibt genau einen öffentlichen Details-Einstieg', async () => {
    await renderDetail(seed('eingangsrechnung', { fileRefId: 'file-ref-01d' }));

    expect(find('document-experience-details'), 'Zweiter Details-Toggle in der Karte').toBeNull();
    expect(find('document-experience-details-toggle')).toBeNull();
    expect(host.querySelectorAll('[data-testid="document-review-more-toggle"]')).toHaveLength(1);

    // Nach dem Öffnen bleibt alles erreichbar.
    await click(find('document-review-more-toggle')!);
    expect(find('document-experience-details-body')).not.toBeNull();
    expect(find('review-section-toggle-original-document')).not.toBeNull();
    expect(find('review-section-toggle-administration')).not.toBeNull();
    expect(find('review-section-toggle-field-confirm')).not.toBeNull();
    expect(find('review-section-archive')).not.toBeNull();
    expect(find('review-section-technical')).not.toBeNull();
  });

  /*
   * R31 — der Kopf sagt dasselbe nicht doppelt.
   */
  it('R31: Betrag und Nummer stehen nicht zusätzlich in der Überschrift', async () => {
    await renderDetail(seed('eingangsrechnung'));

    const headline = find('document-experience-headline')?.textContent ?? '';
    const facts = find('document-experience-facts')?.textContent ?? '';
    expect(facts).toContain('486,20');
    expect(headline, 'Der Betrag steht doppelt im Kopf').not.toContain('486,20');
    // Die Typzeile über der Überschrift entfällt in der Detailansicht.
    expect(find('document-experience-type')).toBeNull();
  });

  /*
   * R13 — der Vertragsfall bleibt unverändert.
   */
  it('R13: ein Werkvertrag behält seinen Auftragsvorschlag', async () => {
    await renderDetail(
      seed('werkvertrag', {
        documentType: 'kundenauftrag',
        sender: 'Musterbau OWL GmbH',
        recognizedData: {
          Kunde: 'Musterbau OWL GmbH',
          Baustelle: 'Teststraße 24, 33602 Bielefeld',
          _vertragstext: buildSyntheticWerkvertragText(),
        },
      }),
    );

    // Der Vorschlag bleibt im DOM erreichbar — der Scroll-Mechanismus sucht ihn dort.
    expect(find('auftragskarte') ?? find('contract-order-proposal')).not.toBeNull();
    expect(find('eingang-assist-flow')?.getAttribute('data-assist-flow')).toBe('canonical');
  });
});
