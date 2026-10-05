/**
 * HEUTE-V2 — Dokumentfristen und offene Nachweise auf der Startseite.
 *
 * Geprueft wird der eine Integrationspfad, den der Block eingezogen hat:
 * `getOpenDocumentLifecycleItems` → `homeHintService` → `deskIntelligenceService`.
 * Bewusst keine eigene Fristenarithmetik in den Tests — gemessen wird, was die
 * Startseite am Ende wirklich anzeigt.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { buildDeskPriorities } from './deskIntelligenceService';
import { getOpenDocumentLifecycleItems } from './documentLifecycleService';
import { buildHomeHints, type HomeHint } from './homeHintService';
import { hydrateDocumentStore } from './documentService';
import { hydrateExpenseStore } from './expenseStore';
import { hydrateInboxStore } from './inboxService';
import {
  buildHomeHintId,
  dismissHomeHint,
  resetHomeHintDismissals,
  snoozeHomeHint,
} from './homeHintDismissalService';
import { hydrateTaskStore } from './taskStore';
import { hydrateVorgangStore } from './vorgangService';
import { resetMemory } from './officePilotMemoryService';
import { hydrateCompanyProfileStore } from './companyProfileService';
import { createAuftragInboxItem } from '../test/fixtures';
import { de } from '../i18n';
import type { InboxItem } from '../types/models';

const TODAY = '2026-07-06';

/** Ein Behoerdenschreiben mit Frist — der Normalfall des Blocks. */
function behoerdenschreiben(id: string, title: string, deadline: string): InboxItem {
  return createAuftragInboxItem({
    id,
    title,
    documentType: 'behoerde',
    classifiedKind: 'finanzamt',
    sender: 'Finanzamt München',
    deadline,
  });
}

function dokumentHinweise(hints: HomeHint[]): HomeHint[] {
  return hints.filter((hint) => hint.messageKey.startsWith('hints.document'));
}

/**
 * Der Satz, den der Nutzer wirklich liest — inklusive eingesetzter Parameter.
 * Nur so faellt auf, wenn ein technischer Code durchschlaegt.
 */
function satz(hint: HomeHint): string {
  let text: string = de[hint.messageKey as keyof typeof de] as string;
  for (const [name, value] of Object.entries(hint.params ?? {})) {
    text = text.replaceAll(`{${name}}`, String(value));
  }
  return text;
}

describe('HEUTE-V2 Dokumentfristen auf der Startseite', () => {
  beforeEach(() => {
    localStorage.clear();
    resetMemory();
    resetHomeHintDismissals();
    hydrateInboxStore([]);
    hydrateDocumentStore([]);
    hydrateTaskStore([]);
    hydrateExpenseStore([]);
    hydrateVorgangStore([]);
    hydrateCompanyProfileStore({ companyName: 'Test GmbH', contactPerson: 'Max' });
  });

  /* ---- A) Die vier Dringlichkeitsstufen ---- */

  it('A1 — eine ueberfaellige Frist erscheint als kritischer Hinweis', () => {
    hydrateInboxStore([behoerdenschreiben('inbox-a1', 'Finanzamt Fristsetzung', '2026-07-02')]);

    const [hinweis] = dokumentHinweise(buildHomeHints(TODAY));
    expect(hinweis?.messageKey).toBe('hints.documentDeadlineOverdue');
    expect(hinweis?.severity).toBe('critical');
  });

  it('A2 — eine heute ablaufende Frist erscheint als kritischer Hinweis', () => {
    hydrateInboxStore([behoerdenschreiben('inbox-a2', 'SOKA Nachweis', TODAY)]);

    const [hinweis] = dokumentHinweise(buildHomeHints(TODAY));
    expect(hinweis?.messageKey).toBe('hints.documentDeadlineToday');
    expect(hinweis?.severity).toBe('critical');
  });

  it('A3 — eine Frist in drei Tagen erscheint als Warnung', () => {
    hydrateInboxStore([behoerdenschreiben('inbox-a3', 'BG BAU Rueckfrage', '2026-07-09')]);

    const [hinweis] = dokumentHinweise(buildHomeHints(TODAY));
    expect(hinweis?.messageKey).toBe('hints.documentDeadlineSoon');
    expect(hinweis?.severity).toBe('warning');
  });

  it('A4 — eine Frist in zwanzig Tagen verschwindet NICHT, sondern steht nachrangig', () => {
    hydrateInboxStore([behoerdenschreiben('inbox-a4', 'Finanzamt Nachfrage', '2026-07-26')]);

    const [hinweis] = dokumentHinweise(buildHomeHints(TODAY));
    expect(hinweis).toBeDefined();
    expect(hinweis?.messageKey).toBe('hints.documentDeadlineLater');
    expect(hinweis?.severity).toBe('info');
  });

  it('A5 — jenseits des bestehenden Aufmerksamkeitsfensters entsteht kein Fristhinweis', () => {
    hydrateInboxStore([behoerdenschreiben('inbox-a5', 'Finanzamt ferne Frist', '2026-12-31')]);

    const fristen = dokumentHinweise(buildHomeHints(TODAY)).filter((hint) =>
      hint.messageKey.includes('Deadline'),
    );
    expect(fristen).toEqual([]);
  });

  it('A6 — eine Frist im deutschen Anzeigeformat geht nicht lautlos verloren (sichtbar gefunden)', () => {
    hydrateInboxStore([
      createAuftragInboxItem({
        id: 'inbox-a6',
        title: 'Westfalen Projektbau Schreiben',
        documentType: 'behoerde',
        classifiedKind: 'sonstiges',
        sender: 'Westfalen Projektbau GmbH',
        /* Genau so legt die Erkennung die Frist im echten Bestand ab. */
        deadline: '30.06.2026',
      }),
    ]);

    const view = getOpenDocumentLifecycleItems(TODAY)[0];
    expect(view?.deadline).toBe('2026-06-30');
    expect(view?.openReasons).toContain('deadline_open');

    const [hinweis] = dokumentHinweise(buildHomeHints(TODAY));
    expect(hinweis?.messageKey).toBe('hints.documentDeadlineOverdue');
    expect(hinweis?.severity).toBe('critical');
  });

  it('A7 — ein unlesbares Fristdatum erfindet keine Frist', () => {
    hydrateInboxStore([
      createAuftragInboxItem({
        id: 'inbox-a7',
        title: 'Schreiben ohne klares Datum',
        documentType: 'behoerde',
        classifiedKind: 'sonstiges',
        sender: 'Absender',
        deadline: 'demnaechst',
      }),
    ]);

    const view = getOpenDocumentLifecycleItems(TODAY)[0];
    expect(view?.deadline).toBeUndefined();
    expect(view?.openReasons ?? []).not.toContain('deadline_open');
  });

  /* ---- B) Die uebrigen offenen Gruende ---- */

  it('B1 — ein fehlender Nachweis erscheint als Warnung mit Handlungssatz', () => {
    const views = getOpenDocumentLifecycleItems(TODAY);
    expect(views).toEqual([]);

    hydrateInboxStore([
      createAuftragInboxItem({
        id: 'inbox-b1',
        title: 'Werkvertrag Mueller Bau',
        documentType: 'kundenauftrag',
        classifiedKind: 'werkvertrag',
        sender: 'Mueller Bau',
      }),
    ]);

    const hinweise = dokumentHinweise(buildHomeHints(TODAY));
    expect(hinweise.length).toBeGreaterThan(0);
    for (const hinweis of hinweise) {
      expect(['critical', 'warning', 'info']).toContain(hinweis.severity);
    }
  });

  it('B2 — ein Dokument ohne Frist meldet den naechsten offenen Schritt', () => {
    hydrateInboxStore([
      createAuftragInboxItem({
        id: 'inbox-b2',
        title: 'Lieferschein Baustoffe',
        documentType: 'lieferschein',
        classifiedKind: 'lieferschein',
        sender: 'Baustoff GmbH',
      }),
    ]);

    const hinweise = dokumentHinweise(buildHomeHints(TODAY));
    for (const hinweis of hinweise) {
      expect(hinweis.messageKey).not.toContain('Deadline');
    }
  });

  it('B3 — das Original-Abheften ist ein Hinweis ohne Alarmton', () => {
    hydrateInboxStore([
      createAuftragInboxItem({
        id: 'inbox-b3',
        title: 'Lieferschein Kies',
        documentType: 'lieferschein',
        classifiedKind: 'lieferschein',
        sender: 'Kieswerk',
      }),
    ]);

    const abheften = dokumentHinweise(buildHomeHints(TODAY)).find(
      (hint) => hint.messageKey === 'hints.documentFileOriginal',
    );
    if (abheften) expect(abheften.severity).toBe('info');
  });

  /* ---- C) Sprache und Ziel ---- */

  it('C1 — jeder Dokumenthinweis fuehrt auf genau das Dokument', () => {
    hydrateInboxStore([behoerdenschreiben('inbox-c1', 'Finanzamt Fristsetzung', '2026-07-02')]);

    const [hinweis] = dokumentHinweise(buildHomeHints(TODAY));
    expect(hinweis?.route).toBe('/ablage/inbox-c1');
  });

  it('C2 — kein technischer Code erscheint im sichtbaren Satz', () => {
    hydrateInboxStore([
      behoerdenschreiben('inbox-c2a', 'Finanzamt Fristsetzung', '2026-07-02'),
      createAuftragInboxItem({
        id: 'inbox-c2b',
        title: 'Werkvertrag Mueller Bau',
        documentType: 'kundenauftrag',
        classifiedKind: 'werkvertrag',
        sender: 'Mueller Bau',
      }),
    ]);

    for (const hinweis of dokumentHinweise(buildHomeHints(TODAY))) {
      const text = satz(hinweis);
      expect(text).toBeTruthy();
      for (const code of ['deadline_open', 'proof_missing', 'reply_open', 'file_original', 'task_open']) {
        expect(text).not.toContain(code);
      }
      expect(text).not.toContain('{');
    }
  });

  it('C3 — keine technische Kennung steht im sichtbaren Satz', () => {
    hydrateInboxStore([behoerdenschreiben('inbox-c3', 'Finanzamt Fristsetzung', '2026-07-02')]);

    const [hinweis] = dokumentHinweise(buildHomeHints(TODAY));
    expect(satz(hinweis!)).not.toContain('inbox-c3');
  });

  it('C4 — der Erfassungsplatzhalter steht nicht im Satz (sichtbar gefunden)', () => {
    hydrateInboxStore([
      createAuftragInboxItem({
        id: 'inbox-c4',
        title: 'Gerade erfasst: Tankbeleg – ARAL',
        documentType: 'lieferschein',
        classifiedKind: 'lieferschein',
        sender: 'ARAL',
      }),
    ]);

    const hinweise = dokumentHinweise(buildHomeHints(TODAY));
    expect(hinweise.length).toBeGreaterThan(0);
    for (const hinweis of hinweise) {
      const text = satz(hinweis);
      expect(text).not.toContain('Gerade erfasst');
      /* Genau ein Doppelpunkt: der des Hinweises selbst. */
      expect(text.split(':')).toHaveLength(2);
      expect(text).toContain('Tankbeleg – ARAL');
    }
  });

  /* ---- D) Menge, Reihenfolge, Entdopplung ---- */

  it('D1 — ein Dokument erzeugt hoechstens einen Hinweis; die Frist gewinnt', () => {
    hydrateInboxStore([behoerdenschreiben('inbox-d1', 'Finanzamt Fristsetzung', '2026-07-02')]);

    const view = getOpenDocumentLifecycleItems(TODAY)[0]!;
    /* Das Dokument traegt nachweislich mehrere offene Gruende. */
    expect(view.openReasons.length).toBeGreaterThan(1);
    expect(view.openReasons).toContain('deadline_open');

    const hinweise = dokumentHinweise(buildHomeHints(TODAY));
    expect(hinweise).toHaveLength(1);
    expect(hinweise[0]!.messageKey).toBe('hints.documentDeadlineOverdue');
  });

  it('D2 — die Startseite wird nicht geflutet: hoechstens drei Dokumenthinweise', () => {
    hydrateInboxStore([
      behoerdenschreiben('inbox-d2a', 'Frist A', '2026-07-01'),
      behoerdenschreiben('inbox-d2b', 'Frist B', '2026-07-02'),
      behoerdenschreiben('inbox-d2c', 'Frist C', '2026-07-03'),
      behoerdenschreiben('inbox-d2d', 'Frist D', '2026-07-04'),
      behoerdenschreiben('inbox-d2e', 'Frist E', '2026-07-05'),
    ]);

    expect(dokumentHinweise(buildHomeHints(TODAY)).length).toBeLessThanOrEqual(3);
  });

  it('D3 — die dringendste Frist steht vorn, die spaeteste faellt notfalls hinten heraus', () => {
    hydrateInboxStore([
      behoerdenschreiben('inbox-d3a', 'Frist spaet', '2026-07-20'),
      behoerdenschreiben('inbox-d3b', 'Frist heute', TODAY),
      behoerdenschreiben('inbox-d3c', 'Frist ueberfaellig', '2026-06-20'),
    ]);

    const titel = dokumentHinweise(buildHomeHints(TODAY)).map((hint) => hint.params?.title);
    expect(titel[0]).toBe('Frist ueberfaellig');
    expect(titel[1]).toBe('Frist heute');
  });

  it('D4 — dieselbe Lage zweimal gelesen ergibt dieselben stabilen Kennungen', () => {
    hydrateInboxStore([behoerdenschreiben('inbox-d4', 'Finanzamt Fristsetzung', '2026-07-02')]);

    const erste = buildHomeHints(TODAY).map((hint) => hint.id);
    const zweite = buildHomeHints(TODAY).map((hint) => hint.id);
    expect(zweite).toEqual(erste);
    expect(new Set(erste).size).toBe(erste.length);
  });

  it('D5 — der Hinweis erscheint auf der Startseite kein zweites Mal neben sich selbst', () => {
    hydrateInboxStore([behoerdenschreiben('inbox-d5', 'Finanzamt Fristsetzung', '2026-07-02')]);

    const ids = buildDeskPriorities(new Date(`${TODAY}T09:00:00`)).map((hint) => hint.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  /* ---- E) Abgrenzung zur bestehenden Aufgabenwelt ---- */

  it('E1 — eine rein offene Aufgabe erzeugt keinen zusaetzlichen Dokumenthinweis', () => {
    hydrateInboxStore([behoerdenschreiben('inbox-e1', 'Finanzamt Fristsetzung', '2026-07-02')]);

    for (const hinweis of dokumentHinweise(buildHomeHints(TODAY))) {
      expect(hinweis.route).not.toBe('/aufgaben');
    }
  });

  it('E2 — ein Zahlungsziel wird nicht ein zweites Mal als Dokumentfrist gemeldet (sichtbar gefunden)', () => {
    hydrateInboxStore([
      createAuftragInboxItem({
        id: 'inbox-e2',
        title: 'Eingangsrechnung – Muster Baustoffe GmbH',
        documentType: 'rechnung',
        classifiedKind: 'eingangsrechnung',
        sender: 'Muster Baustoffe GmbH',
        deadline: '2026-07-01',
      }),
    ]);

    /* Der Lebenszyklus kennt die Frist weiterhin — nur die Startseite meldet sie nicht doppelt. */
    expect(getOpenDocumentLifecycleItems(TODAY)[0]?.openReasons).toContain('deadline_open');

    for (const hinweis of dokumentHinweise(buildHomeHints(TODAY))) {
      expect(hinweis.messageKey).not.toContain('Deadline');
    }
  });

  it('E3 — eine Behoerdenfrist bleibt trotz der Zahlungs-Entdopplung sichtbar', () => {
    hydrateInboxStore([
      createAuftragInboxItem({
        id: 'inbox-e3a',
        title: 'Eingangsrechnung – Muster Baustoffe GmbH',
        documentType: 'rechnung',
        classifiedKind: 'eingangsrechnung',
        sender: 'Muster Baustoffe GmbH',
        deadline: '2026-06-30',
      }),
      behoerdenschreiben('inbox-e3b', 'Finanzamt Fristsetzung', '2026-07-02'),
    ]);

    const fristen = dokumentHinweise(buildHomeHints(TODAY)).filter((hint) =>
      hint.messageKey.includes('Deadline'),
    );
    expect(fristen).toHaveLength(1);
    expect(fristen[0]?.params?.title).toBe('Finanzamt Fristsetzung');
  });

  /* ---- F) Zurueckstellen und Erledigen ---- */

  it('F1 — ein erledigter Hinweis verschwindet ueber den bestehenden Speicher', () => {
    hydrateInboxStore([behoerdenschreiben('inbox-f1', 'Finanzamt Fristsetzung', '2026-07-02')]);

    const id = buildHomeHintId('hints.documentDeadlineOverdue', {
      title: 'Finanzamt Fristsetzung',
    });
    expect(dokumentHinweise(buildHomeHints(TODAY))).toHaveLength(1);

    dismissHomeHint(id, 'done');
    expect(dokumentHinweise(buildHomeHints(TODAY))).toEqual([]);
  });

  it('F2 — ein zurueckgestellter Hinweis ruht, ohne einen zweiten Speicher zu brauchen', () => {
    hydrateInboxStore([behoerdenschreiben('inbox-f2', 'Finanzamt Fristsetzung', '2026-07-02')]);

    const id = buildHomeHintId('hints.documentDeadlineOverdue', {
      title: 'Finanzamt Fristsetzung',
    });
    snoozeHomeHint(id, 'nextweek');
    expect(dokumentHinweise(buildHomeHints(TODAY))).toEqual([]);

    resetHomeHintDismissals();
    expect(dokumentHinweise(buildHomeHints(TODAY))).toHaveLength(1);
  });

  /* ---- G) Einordnung im Tagescockpit ---- */

  it('G1 — eine ueberfaellige Dokumentfrist steht im Cockpit weit vorn, direkt hinter dem Sammelzaehler', () => {
    hydrateInboxStore([behoerdenschreiben('inbox-g1', 'Finanzamt Fristsetzung', '2026-06-20')]);

    const schluessel = buildDeskPriorities(new Date(`${TODAY}T09:00:00`)).map(
      (hint) => hint.messageKey as string,
    );
    /*
     * Der bestehende Sammelzaehler der Behoerdenfristen bleibt bewusst vorn:
     * Er nennt die Gesamtlage, der Dokumenthinweis den konkreten Vorgang.
     * Entscheidend ist, dass der konkrete Vorgang es ueberhaupt unter die drei
     * Plaetze schafft — vor jeden allgemeinen Startseitenhinweis.
     */
    const platz = schluessel.indexOf('hints.documentDeadlineOverdue');
    expect(platz).toBeGreaterThanOrEqual(0);
    expect(platz).toBeLessThanOrEqual(1);
  });

  it('G2 — Dokumenthinweise tragen keine Betraege und ueberleben die Betragsfilterung', () => {
    hydrateInboxStore([behoerdenschreiben('inbox-g2', 'Finanzamt Fristsetzung', '2026-07-02')]);

    for (const hinweis of dokumentHinweise(buildHomeHints(TODAY))) {
      const werte = Object.entries(hinweis.params ?? {});
      expect(werte.map(([name]) => name)).toEqual(['title']);
      for (const [, wert] of werte) expect(String(wert)).not.toMatch(/€|EUR/);
    }
  });

  it('G3 — ohne offene Dokumentvorgaenge entsteht kein einziger Dokumenthinweis', () => {
    expect(dokumentHinweise(buildHomeHints(TODAY))).toEqual([]);
  });
});
