/**
 * BROWSER-ACCEPTANCE-FIX 01 / B1 — „Was soll ich heute erledigen?"
 *
 * Der Assistent beantwortet allgemeine Prioritätsfragen aus derselben Quelle
 * wie „Jetzt wichtig" — nicht mehr aus dem zuletzt geöffneten Auftrag.
 * Nur lesend, keine erfundenen Daten, natürliches Deutsch.
 *
 * Neutrale Beispieldaten, kein Netzwerk.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { processOfficePilotQuestion } from './services/brain/brainOrchestrator';
import {
  buildDailyPriorityAnswer,
  isDailyPriorityQuestion,
} from './services/brain/dailyPriorityResolver';
import { recordVorgangContext, resetCompanySessionForTests } from './services/brain/companySessionService';
import { buildPendingSummary, scanPendingItems } from './services/pendingEngineService';
import { reconcileInvoicePaymentTasks } from './services/invoice/invoicePaymentTaskSync';
import { getAllVorgaenge, hydrateVorgangStore } from './services/vorgangService';
import { getAllTasksFromStore, setTaskStoreForTests } from './services/taskStore';
import { normalizeTask } from './services/taskNormalize';
import { hydrateInboxStore } from './services/inboxService';
import { hydrateDocumentStore } from './services/documentService';
import { reminderDeadlineOf } from './services/brain/dailyPriorityResolver';
import { contextPartLabels } from './components/assistant/BrainOrchestrationCard';
import { MOCK_INBOX_ITEMS } from './data/inboxMockData';
import { t } from './i18n';
import { resetTestStores } from './test/resetStores';
import { createOrderPosition, createTestVorgang } from './test/fixtures';
import type { Vorgang, VorgangInvoice } from './types/models';

const TODAY = '2026-09-28';
const QUESTIONS = [
  'Was soll ich heute erledigen?',
  'Was ist heute wichtig?',
  'Was ist dringend?',
  'Was muss ich noch machen?',
  'Was muss ich heute erledigen?',
];

function invoice(id: string, number: string, dueDate: string, amount = 1190): VorgangInvoice {
  return {
    id,
    number,
    type: 'rechnung',
    positions: [
      { id: `${id}-l`, orderPositionId: 'op-1', description: 'Arbeit', quantity: 1, unit: 'Stk', unitPrice: amount / 1.19, lineTotal: amount / 1.19 },
    ],
    subtotal: amount / 1.19,
    taxStatus: 'standard_19',
    amount,
    status: 'versendet',
    date: '2026-08-01',
    issueDate: '2026-08-01',
    createdAt: '2026-08-01T10:00:00.000Z',
    paymentDueDate: dueDate,
    paymentStatus: 'offen',
    payments: [],
    legalNotices: [],
    previousAbschlagDeductions: [],
  } as VorgangInvoice;
}

function vorgang(id: string, title: string, invoices: VorgangInvoice[], positions = 1): Vorgang {
  return {
    ...createTestVorgang({
      id,
      title,
      status: 'beauftragt',
      customer: 'Beispiel Bau GmbH',
      orderPositions: Array.from({ length: positions }, (_, i) =>
        createOrderPosition({ id: `op-${i + 1}`, description: `Position ${i + 1}`, unit: 'Stk', plannedQuantity: 1, unitPrice: 100 }),
      ),
    }),
    invoices,
  } as Vorgang;
}

function task(id: string, title: string, dueDate?: string, extra: Record<string, unknown> = {}) {
  return normalizeTask({ id, title, status: 'open', priority: 'hoch', dueDate, ...extra } as never);
}

/** Drei überfällige Rechnungen, vier überfällige Aufgaben — die Lage der Browser-Abnahme. */
function seedAbnahmeLage(): void {
  hydrateVorgangStore([
    vorgang('v-a', 'Dach A', [invoice('inv-11', '2026-0011', '2026-09-21', 2380), invoice('inv-12', '2026-0012', '2026-09-21', 357)]),
    vorgang('v-b', 'Fassade B', [invoice('inv-9', '2026-0009', '2026-09-10', 1190)]),
    vorgang('v-test', 'TEST Einzelauftrag', [], 2),
  ]);
  setTaskStoreForTests([
    task('t-1', 'Angebot nachfassen', '2026-09-20'),
    task('t-2', 'Material bestellen', '2026-09-24'),
    task('t-3', 'Aufmaß prüfen', '2026-09-25'),
    task('t-4', 'Rückruf Kunde', '2026-09-27'),
    task('t-5', 'Später erledigen', '2026-10-15'),
  ]);
}

function allText(answer: { title: string; summary: string; bullets: string[]; actions: { label: string }[] }): string {
  return [answer.title, answer.summary, ...answer.bullets, ...answer.actions.map((a) => a.label)].join('\n');
}

describe('BROWSER-ACCEPTANCE-FIX 01 / B1 — Tagesprioritäten im Assistenten', () => {
  beforeEach(() => {
    resetTestStores();
    resetCompanySessionForTests();
  });
  afterEach(() => {
    resetTestStores();
    resetCompanySessionForTests();
  });

  it('B1-1: allgemeine Prioritätsfragen werden erkannt, auftragsbezogene nicht', () => {
    for (const q of QUESTIONS) expect(isDailyPriorityQuestion(q), q).toBe(true);
    for (const q of ['Was fehlt noch im Auftrag?', 'Was soll als Nächstes passieren?', 'Welche Risiken gibt es?', 'Wo ist die Rechnung 2026-0011?', 'Was ist wichtig im Betrieb?']) {
      expect(isDailyPriorityQuestion(q), q).toBe(false);
    }
  });

  it('B1-2: überfällige Rechnungen und Aufgaben stehen vorn — nicht der zuletzt geöffnete Auftrag', async () => {
    seedAbnahmeLage();
    // Die Sitzung zeigt auf einen einzelnen Testauftrag — genau wie in der Abnahme.
    recordVorgangContext('v-test');

    const result = await processOfficePilotQuestion('Was soll ich heute erledigen?', { mode: 'rules', today: TODAY });
    const answer = result.assistantAnswer!;

    // B1-Nacharbeit: kein interner Kontextschlüssel — die Tagesantwort nutzt keinen Sitzungskontext.
    expect(result.companyContextUsed ?? []).toEqual([]);
    expect(answer.title).toBe('Heute wichtig');
    expect(result.workflowUsed ?? []).toEqual([]);
    expect(answer.summary).toBe('Zuerst das Überfällige: 3 überfällige Rechnungen und 4 überfällige Aufgaben.');
    const text = allText(answer);
    expect(text).not.toContain('TEST Einzelauftrag');
    // Rechnungen, älteste zuerst, mit echten Daten.
    const invoiceLines = answer.bullets.filter((b) => b.startsWith('Überfällig: Rechnung'));
    expect(invoiceLines[0]).toContain('2026-0009');
    expect(invoiceLines[0]).toContain('fällig seit 10.09.2026');
    expect(text).toContain('2026-0011');
    // Die Aufgabe mit Frist in der Zukunft ist nicht überfällig.
    expect(text).not.toContain('Später erledigen');
    // Keine sitzungsbezogenen Auftragshinweise unter der Tagesantwort.
    expect(result.proactiveHints).toEqual([]);
  });

  it('B1-3: Reihenfolge überfällig → heute → bald', async () => {
    hydrateVorgangStore([
      vorgang('v-a', 'Dach A', [
        invoice('inv-o', '2026-0020', '2026-09-01'),
        invoice('inv-h', '2026-0021', TODAY),
        invoice('inv-b', '2026-0022', '2026-10-01'),
      ]),
    ]);
    setTaskStoreForTests([task('t-h', 'Baustelle abnehmen', TODAY), task('t-s', 'Irgendwann', '2026-11-30')]);

    const { answer } = buildDailyPriorityAnswer(TODAY);
    const prefixes = answer.bullets.map((b) => b.split(':')[0]);
    const firstToday = prefixes.indexOf('Heute');
    const firstSoon = prefixes.indexOf('Bald');
    expect(prefixes[0]).toBe('Überfällig');
    expect(firstToday).toBeGreaterThan(0);
    expect(firstSoon).toBeGreaterThan(firstToday);
    expect(answer.bullets.join('\n')).toContain('Aufgabe „Baustelle abnehmen“ (heute fällig)');
    expect(answer.bullets.join('\n')).toContain('Rechnung 2026-0022 in 3 Tagen fällig');
    expect(answer.bullets.join('\n')).not.toContain('Irgendwann');
    expect(answer.summary).toBe('Zuerst das Überfällige: 1 überfällige Rechnung. Danach, was heute fällig ist (2).');
  });

  it('B1-4: nichts Dringendes — ehrliche Antwort, keine erfundene Dringlichkeit', async () => {
    hydrateVorgangStore([vorgang('v-a', 'Dach A', [])]);
    setTaskStoreForTests([task('t-s', 'Irgendwann', '2026-12-01'), task('t-n', 'Ohne Frist')]);

    const result = await processOfficePilotQuestion('Was ist heute wichtig?', { mode: 'rules', today: TODAY });
    const answer = result.assistantAnswer!;
    expect(answer.summary).toBe(
      'Aktuell liegt nichts Dringendes vor: keine überfälligen Rechnungen oder Aufgaben und nichts, was heute fällig ist.',
    );
    expect(answer.bullets).toEqual([]);
    expect(answer.actions).toEqual([]);
  });

  it('B1-5: dieselbe Grundlage wie „Jetzt wichtig" (Heute)', () => {
    seedAbnahmeLage();
    hydrateInboxStore(MOCK_INBOX_ITEMS.slice(0, 2).map((item) => ({ ...item, status: 'neu' as const })));

    /*
     * Wie im Produkt: Der tägliche Abgleich beim App-Start legt die „Zahlung
     * prüfen“-Aufgaben an (02B — nicht mehr das Rendern von Heute); Heute und
     * die Frage lesen danach denselben Stand.
     */
    reconcileInvoicePaymentTasks({ today: TODAY });
    const heute = buildPendingSummary(scanPendingItems(TODAY).items, TODAY);
    const assistant = buildDailyPriorityAnswer(TODAY);

    expect(heute.overdueTasks).toBe(7);
    expect(assistant.counts.overdueInvoices).toBe(heute.overdueInvoices);
    expect(assistant.counts.overdueTasks).toBe(heute.overdueTasks);
    expect(assistant.counts.dueTodayInvoices).toBe(heute.dueTodayInvoices);
    expect(assistant.counts.dueTasksToday).toBe(heute.dueTasksToday);
    expect(assistant.answer.summary).toBe('Zuerst das Überfällige: 3 überfällige Rechnungen und 7 überfällige Aufgaben.');
    // Die Zahlungs-Aufgaben stehen nicht ein zweites Mal neben ihrer Rechnung.
    const taskLines = assistant.answer.bullets.filter((b) => b.includes('Aufgabe „'));
    expect(taskLines.some((b) => /Rechnung 2026-00(09|11|12)/.test(b))).toBe(false);
    // … aber die Zahl oben bleibt nachvollziehbar.
    expect(assistant.answer.bullets).toContain('Überfällig: 3 Aufgaben betreffen die Zahlung der Rechnungen oben.');
    // Keine Doppelung „Überfällig: Rechnung … überfällig".
    expect(assistant.answer.bullets.some((b) => /^Überfällig: .* überfällig/.test(b))).toBe(false);
    // Offene Eingangsprüfungen („neu") — Teil der Heute-Logik — erscheinen ebenfalls.
    if (heute.newInboxItems > 0) {
      expect(assistant.answer.bullets.join('\n')).toMatch(/Im Eingang (wartet 1 neues Dokument|warten \d+ neue Dokumente) auf Ihre Prüfung\./);
    }
  });

  it('B1-6: nur lesend — keine Aufgabe angelegt oder erledigt, keine Rechnung verändert', async () => {
    seedAbnahmeLage();
    const tasksBefore = JSON.stringify(getAllTasksFromStore());
    const vorgaengeBefore = JSON.stringify(getAllVorgaenge());

    for (const q of QUESTIONS) {
      const result = await processOfficePilotQuestion(q, { mode: 'rules', today: TODAY });
      // Aktionen sind reine Navigation innerhalb der App.
      for (const action of result.assistantAnswer?.actions ?? []) {
        expect(Object.keys(action).sort()).toEqual(['id', 'label', 'route']);
        expect(action.route.startsWith('/')).toBe(true);
      }
    }

    // Die Heute-Seite legt „Zahlung prüfen"-Aufgaben an — die Frage nicht.
    expect(JSON.stringify(getAllTasksFromStore())).toBe(tasksBefore);
    expect(JSON.stringify(getAllVorgaenge())).toBe(vorgaengeBefore);
  });

  it('B1-7: keine erfundenen Daten — jede Rechnungsnummer und jeder Betrag stammt aus dem Bestand', () => {
    seedAbnahmeLage();
    const text = allText(buildDailyPriorityAnswer(TODAY).answer);
    const numbers = text.match(/\b2026-\d{4}\b/g) ?? [];
    expect(new Set(numbers)).toEqual(new Set(['2026-0009', '2026-0011', '2026-0012']));
    const amounts = text.match(/\d{1,3}(?:\.\d{3})*,\d{2} €/g) ?? [];
    for (const amount of amounts) expect(['2.380,00 €', '357,00 €', '1.190,00 €']).toContain(amount);
  });

  it('B1-8: natürliches Singular/Plural, keine „(en)"-Platzhalter', () => {
    hydrateVorgangStore([vorgang('v-a', 'Dach A', [invoice('inv-1', '2026-0030', '2026-09-01')])]);
    setTaskStoreForTests([task('t-1', 'Rückruf', '2026-09-27')]);
    const one = buildDailyPriorityAnswer(TODAY).answer;
    expect(one.summary).toBe('Zuerst das Überfällige: 1 überfällige Rechnung und 1 überfällige Aufgabe.');

    seedAbnahmeLage();
    const many = allText(buildDailyPriorityAnswer(TODAY).answer);
    for (const text of [allText(one), many]) {
      expect(text).not.toMatch(/\((en|e|n|s)\)/);
    }
  });

  it('B1-9: Auftragshinweise ohne Platzhalter und ohne widersprüchliche Wortwahl', () => {
    const keys = [
      'handwerkKnowledge.hint.positionFullyBilled',
      'workflowIntelligence.risk.openPositions',
      'companyContext.hint.customerOpenInvoices',
      'companyContext.hint.baustelleDocuments',
      'workflowIntelligence.risk.materialWithoutLieferschein',
      'financeIntelligence.risk.openReceivables',
      'financeIntelligence.datev.markForAccounting',
    ] as const;
    for (const key of keys) {
      const text = t(key, 'de', { position: 'Dach', count: 1, customer: 'Beispiel', baustelle: 'Weg 1', amount: '100,00 €' });
      expect(text, key).not.toMatch(/\((en|e|n|s)\)/);
    }
    // „vollständig abgerechnet" (Abrechnung) statt „ausgeführt" — dieselbe Regel wie „noch offen".
    expect(t('handwerkKnowledge.hint.positionFullyBilled', 'de', { position: 'Dach', count: 1 })).toBe(
      'Vollständig abgerechnete Positionen: 1, darunter „Dach“.',
    );
    expect(t('workflowIntelligence.risk.openPositions', 'de', { count: 1 })).toBe(
      'Noch nicht vollständig abgerechnete Positionen im Auftrag: 1.',
    );
  });

  it('B1-10: auftragsbezogene Fragen bleiben beim Workflow', async () => {
    seedAbnahmeLage();
    recordVorgangContext('v-test');
    const result = await processOfficePilotQuestion('Was soll als Nächstes passieren?', { mode: 'rules', today: TODAY });
    expect(result.assistantAnswer?.title ?? '').not.toBe('Heute wichtig');
  });

  /* ---------------------------------------------------------------- */
  /* B1-Nacharbeit                                                     */
  /* ---------------------------------------------------------------- */

  it('N1: Kontextanzeige — nur verständliche Bezeichnungen, nie ein interner Schlüssel', () => {
    const translate = (key: Parameters<typeof t>[0]) => t(key, 'de');
    expect(contextPartLabels(['customer', 'vorgang'], translate)).toEqual(['Kunde', 'Auftrag']);
    expect(contextPartLabels(['upload', 'vorgang'], translate)).toEqual(['Zuletzt hochgeladenes Dokument', 'Auftrag']);
    expect(contextPartLabels(['document', 'contract', 'document'], translate)).toEqual(['Dokument', 'Vertrag']);
    // Unbekannte/technische Schlüssel erscheinen nicht.
    expect(contextPartLabels(['daily_priorities', 'irgendwas_intern'], translate)).toEqual([]);
    expect(contextPartLabels(undefined, translate)).toEqual([]);
  });

  /** Eine Wiedervorlage genau so, wie documentReminderProposalService sie anlegt. */
  function reminderTask(id: string, remindOn: string, deadline: string) {
    const [y, m, d] = deadline.split('-');
    return normalizeTask({
      id,
      title: `Antwort – Mängelanzeige Gebäude B – Frist ${d}.${m}.${y}`,
      description: `Frist im Schreiben: ${d}.${m}.${y}.`,
      status: 'open',
      priority: 'mittel',
      category: 'dokumente',
      dueDate: remindOn,
      sourceType: 'manual',
      sourceId: 'inbox-1',
      taskKind: 'document_reminder',
      dedupeKey: `reminder:inbox-1:response_due:${deadline}:${remindOn}`,
      type: 'dokument_pruefen',
    } as never);
  }

  it('N2: Erinnerung vor echter Frist, beide vorbei — Erinnerung heisst Erinnerung, die Frist steht einmal richtig', () => {
    setTaskStoreForTests([reminderTask('r-1', '2026-09-20', '2026-09-22')]);
    const bullets = buildDailyPriorityAnswer(TODAY).answer.bullets;
    const line = bullets.find((b) => b.includes('Mängelanzeige'))!;
    expect(line).toBe(
      'Überfällig: Wiedervorlage „Antwort – Mängelanzeige Gebäude B“ (Erinnerung vom 20.09.2026 ist offen; Frist im Schreiben 22.09.2026 überschritten)',
    );
    // Das Erinnerungsdatum wird nie „Frist" genannt, und es gibt genau eine Frist.
    expect(line).not.toMatch(/Frist 20\.09\.2026/);
    expect(line.match(/Frist/g)).toHaveLength(1);
  });

  it('N3: Erinnerung überfällig, echte Frist noch offen', () => {
    setTaskStoreForTests([reminderTask('r-2', '2026-09-25', '2026-10-02')]);
    const line = buildDailyPriorityAnswer(TODAY).answer.bullets.find((b) => b.includes('Mängelanzeige'))!;
    expect(line).toBe(
      'Überfällig: Wiedervorlage „Antwort – Mängelanzeige Gebäude B“ (Erinnerung vom 25.09.2026 ist offen; Frist im Schreiben am 02.10.2026)',
    );
    expect(line).not.toContain('überschritten');
  });

  it('N4: heute fällige Erinnerung', () => {
    setTaskStoreForTests([reminderTask('r-3', TODAY, '2026-09-30')]);
    const line = buildDailyPriorityAnswer(TODAY).answer.bullets.find((b) => b.includes('Mängelanzeige'))!;
    expect(line).toBe(
      'Heute: Wiedervorlage „Antwort – Mängelanzeige Gebäude B“ (Erinnerung für heute; Frist im Schreiben am 30.09.2026)',
    );
  });

  it('N5: Aufgabe ohne separate Frist — ihr Datum ist Fälligkeit, keine „Frist"', () => {
    setTaskStoreForTests([task('t-x', 'Rückruf Kunde', '2026-09-20')]);
    const line = buildDailyPriorityAnswer(TODAY).answer.bullets.find((b) => b.includes('Rückruf'))!;
    expect(line).toBe('Überfällig: Aufgabe „Rückruf Kunde“ (fällig seit 20.09.2026)');
    expect(line).not.toContain('Frist');
  });

  it('N6: Frist nur aus einem passenden Schlüssel — nichts erfunden', () => {
    expect(reminderDeadlineOf({ taskKind: 'document_reminder', dedupeKey: 'reminder:inbox-1:response_due:2026-09-22:2026-09-20', dueDate: '2026-09-20' })).toBe('2026-09-22');
    // Schlüssel passt nicht zum Erinnerungstag (Aufgabe verschoben) → keine Frist behaupten.
    expect(reminderDeadlineOf({ taskKind: 'document_reminder', dedupeKey: 'reminder:inbox-1:response_due:2026-09-22:2026-09-20', dueDate: '2026-09-24' })).toBeNull();
    expect(reminderDeadlineOf({ taskKind: 'document_reminder', dedupeKey: 'manual:x:document_reminder', dueDate: '2026-09-20' })).toBeNull();
    expect(reminderDeadlineOf({ taskKind: 'legacy:x', dedupeKey: 'reminder:a:b:2026-09-22:2026-09-20', dueDate: '2026-09-20' })).toBeNull();

    // Ohne lesbare Frist: nur die Erinnerung, der Titel bleibt vollständig.
    setTaskStoreForTests([
      normalizeTask({ id: 'r-4', title: 'Unterlagen nachreichen', status: 'open', priority: 'mittel', dueDate: '2026-09-21', taskKind: 'document_reminder', dedupeKey: 'manual:r-4' } as never),
    ]);
    const line = buildDailyPriorityAnswer(TODAY).answer.bullets.find((b) => b.includes('Unterlagen'))!;
    expect(line).toBe('Überfällig: Wiedervorlage „Unterlagen nachreichen“ (Erinnerung vom 21.09.2026 ist offen)');
  });

  it('N7: Heute und Assistent zählen die Wiedervorlage gleich', () => {
    setTaskStoreForTests([reminderTask('r-1', '2026-09-20', '2026-09-22'), task('t-x', 'Rückruf Kunde', '2026-09-20')]);
    const heute = buildPendingSummary(scanPendingItems(TODAY).items, TODAY);
    const assistant = buildDailyPriorityAnswer(TODAY);
    expect(heute.overdueTasks).toBe(2);
    expect(assistant.counts.overdueTasks).toBe(heute.overdueTasks);
    expect(assistant.answer.summary).toBe('Zuerst das Überfällige: 2 überfällige Aufgaben.');
  });

  function offerDocument(id: string, title: string, validUntil: string) {
    return {
      id,
      title,
      category: 'angebot',
      classifiedKind: 'angebot',
      issuer: 'Beispielbetrieb',
      recognizedText: 'Angebot',
      issueDate: '2026-09-01',
      validUntil,
      digitalFolder: { id: 'dig-a', name: 'Angebote', path: '/Angebote/' },
      paperFolder: { folderId: 'folder-1', register: 'A', label: 'Angebote' },
      tags: [],
      linkedCompany: '',
      linkedVorgang: null,
      archived: true,
      createdAt: '2026-09-01T10:00:00.000Z',
    } as never;
  }

  it('N8: Angebot mit Nummer — dieselbe Bezeichnung wie „Jetzt wichtig", keine Doppelung', () => {
    hydrateDocumentStore([offerDocument('doc-an-1', 'AN-2026-0001 – Angebot', '2026-10-21')]);
    const items = scanPendingItems(TODAY, { readOnly: true }).items;
    const heuteLabel = items.find((item) => item.kind === 'document_expiring')?.metadata?.proofLabel;
    expect(heuteLabel).toBe('AN-2026-0001 – Angebot');

    const bullets = buildDailyPriorityAnswer(TODAY).answer.bullets;
    expect(bullets).toContain('Bald: AN-2026-0001 – Angebot läuft in 23 Tagen ab');
    expect(bullets.join('\n')).not.toMatch(/Angebot – Angebot/);
  });

  it('N9: Angebot ohne Nummer — keine erfundene Nummer; Restlaufzeit korrekt; abgelaufen ohne Doppelung', () => {
    hydrateDocumentStore([
      offerDocument('doc-an-2', 'Angebot', '2026-09-29'),
      offerDocument('doc-an-3', 'AN-2026-0003 – Angebot', '2026-09-20'),
    ]);
    const text = buildDailyPriorityAnswer(TODAY).answer.bullets.join('\n');
    expect(text).toContain('Bald: Angebot läuft in 1 Tag ab');
    expect(text).toContain('Überfällig: AN-2026-0003 – Angebot ist abgelaufen (seit 20.09.2026)');
    expect(text).not.toMatch(/Angebot – Angebot/);
    expect(text.match(/AN-\d{4}-\d{4}/g)).toEqual(['AN-2026-0003']);
  });
});
