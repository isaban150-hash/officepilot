/**
 * EINGANG-01D-1 Nacharbeit 2 — sichere Buchungsbeträge, Richtung eigener
 * Gutschriften, 60-Zeilen-Fallback, „genau einmal" des verzögerten Commits.
 *
 * Echte Produktionspfade: `intakeCachedDocumentFile` → Eingang →
 * `createExpenseFromInbox` → Formular-Vorbelegung (`getExpensePrefillForInbox`).
 * Ersetzt wird nur die Bild-OCR; beim Scheduler zusätzlich RAF und Zeitgeber.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDocumentBlobDatabaseReset } from '../test/documentBlobTestReset';
import { DEFAULT_COMPANY_PROFILE } from '../data/companyProfileDefaults';
import { hydrateCompanyProfileStore } from './companyProfileService';
import { classifyDocument } from './documentClassificationService';
import { hydrateDocumentStore } from './documentService';
import { intakeCachedDocumentFile } from './documentIntakeService';
import { resetDocumentWorkResultStoreForTests } from './documentWorkResultStoreService';
import { getAllExpenses } from './expenseService';
import { hydrateExpenseStore } from './expenseStore';
import { getInboxItemById, hydrateInboxStore } from './inboxService';
import * as intakeWorkflowService from './intakeWorkflowService';
import { scheduleIntakeDocumentAnalysisCommit } from './intakeAnalysisCommitService';
import { buildExpenseInputFromInbox, createExpenseFromInbox, getExpensePrefillForInbox } from './officeActionService';
import { createAuftragInboxItem } from '../test/fixtures';
import { setImageOcrExtractorForTests } from './ocrDocumentService';
import { setTaskStoreForTests } from './taskStore';
import { hydrateVorgangStore } from './vorgangService';
import type { CachedDocumentFilePayload } from './cachedDocumentFileService';
import type { InboxItem } from '../types/models';

const OWN = {
  ...DEFAULT_COMPANY_PROFILE,
  companyName: 'Mustermann Sanitär GmbH',
  street: 'Handwerkerweg 7',
  zip: '10115',
  city: 'Berlin',
};

let ocrText = '';
let fileCounter = 0;

async function intake(text: string, name: string): Promise<InboxItem> {
  ocrText = text;
  fileCounter += 1;
  const bytes = new TextEncoder().encode(`01d1n2-${name}-${fileCounter}-${Math.random()}`);
  const payload: CachedDocumentFilePayload = { fileName: `${name}.png`, mimeType: 'image/png', fileSize: bytes.length, bytes };
  const result = await intakeCachedDocumentFile(payload, { importSource: 'upload', recognizedText: text });
  if (!result.success || result.duplicate) throw new Error(`intake failed for ${name}`);
  return getInboxItemById(result.inboxItem.id)!;
}

function formRoute(item: InboxItem): string {
  return `/ausgaben/neu?inboxId=${encodeURIComponent(item.id)}`;
}

function expensesFor(item: InboxItem) {
  return getAllExpenses().filter((expense) => expense.linkedInboxId === item.id);
}

useDocumentBlobDatabaseReset();

beforeEach(() => {
  localStorage.clear();
  hydrateCompanyProfileStore(OWN);
  hydrateInboxStore([]);
  hydrateDocumentStore([]);
  hydrateVorgangStore([]);
  hydrateExpenseStore([]);
  setTaskStoreForTests([]);
  resetDocumentWorkResultStoreForTests();
  setImageOcrExtractorForTests(async () => ({ text: ocrText, confidence: 90 }));
});

afterEach(() => {
  setImageOcrExtractorForTests(null);
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('P1-B — automatische Buchung nur mit sicherem Gesamtbetrag', () => {
  it('A: eindeutige Rechnung Netto 200 / USt 38 / Gesamtbetrag 238 → automatisch +238', async () => {
    const item = await intake(
      'Baustoff Meyer GmbH\nRechnung\nRechnungs-Nr.: R-201\nDatum: 01.10.2026\nNetto 200,00 EUR\nUSt 19 % 38,00 EUR\nGesamtbetrag 238,00 EUR\nZahlbar bis 15.10.2026',
      'rechnung-eindeutig',
    );
    expect(createExpenseFromInbox(item).ok).toBe(true);
    expect(expensesFor(item).map((expense) => expense.grossAmount)).toEqual([238]);
  });

  it('B: ohne Titel, erkannt 200, beschrifteter Gesamtbetrag 238 → keine Buchung, Formular mit 238', async () => {
    const item = await intake(
      'Baustoff Meyer GmbH\nIhre Bestellung vom 01.09.2026\nRechnungs-Nr.: R-78\nDatum: 01.10.2026\nMaterial 200,00 EUR\nGesamtbetrag 238,00 EUR\nZahlbar bis 15.10.2026',
      'ohne-titel-mit-gesamt',
    );
    // Erkannt wurde „Material 200", sicher ist „Gesamtbetrag 238": Widerspruch → Bestätigung im Formular.
    expect(item.recognizedData.Betrag).toMatch(/^200,00/);
    expect(createExpenseFromInbox(item)).toEqual({ ok: true, kind: 'navigate', route: formRoute(item) });
    expect(expensesFor(item)).toHaveLength(0);
    expect(getExpensePrefillForInbox(item.id)!.grossAmount).toBe(238);
  });

  it('C: ohne Titel, ohne jede Beschriftung (200 / 38 / 238) → keine automatische Buchung', async () => {
    const item = await intake(
      'Baustoff Meyer GmbH\nIhre Bestellung vom 01.09.2026\nRechnungs-Nr.: R-79\nDatum: 01.10.2026\nMaterial 200,00 EUR\nMehrwertsteuer 38,00 EUR\n238,00 EUR\nZahlbar bis 15.10.2026',
      'ohne-titel-ohne-gesamt',
    );
    const result = createExpenseFromInbox(item);
    // Die bestehende Schranke findet hier keine Forderung („kein Buchungsbeleg"); gebucht wird nichts.
    expect(result.ok && result.kind === 'navigate' && result.route.startsWith('/ausgaben/exp-')).toBe(false);
    expect(expensesFor(item)).toHaveLength(0);
    expect(getExpensePrefillForInbox(item.id)!.grossAmount).toBe(0);
  });

  it('C2: Forderung erkannt („zusammen"), aber kein sicher beschrifteter Gesamtbetrag → Formular, Betrag leer', async () => {
    const item = await intake(
      'Baustoff Meyer GmbH\nIhre Bestellung vom 01.09.2026\nRechnungs-Nr.: R-81\nDatum: 01.10.2026\nMaterial 200,00 EUR\nMehrwertsteuer 38,00 EUR\nzusammen 238,00 EUR\nZahlbar bis 15.10.2026',
      'ohne-titel-zusammen',
    );
    expect(createExpenseFromInbox(item)).toEqual({ ok: true, kind: 'navigate', route: formRoute(item) });
    expect(expensesFor(item)).toHaveLength(0);
    expect(getExpensePrefillForInbox(item.id)!.grossAmount).toBe(0);
  });

  it('D: nur ein einziger Betrag im Text → erkannter Betrag bleibt (bisheriges Verhalten); zwei unbeschriftete → leer', () => {
    const receipt = (text: string): InboxItem => ({
      ...createAuftragInboxItem({ id: `inbox-beleg-${Math.random().toString(36).slice(2, 8)}` }),
      classifiedKind: 'tankbeleg',
      sender: 'Aral Station Nord',
      recognizedData: { Betrag: '59,50 EUR', Datum: '2026-02-10', _extractedText: text },
    });
    expect(buildExpenseInputFromInbox(receipt('Aral Station Nord\nTankbeleg\n59,50 EUR'), 'tankbeleg').grossAmount).toBe(59.5);
    expect(buildExpenseInputFromInbox(receipt('Aral Station Nord\nTankbeleg\n59,50 EUR\n9,50 EUR'), 'tankbeleg').grossAmount).toBe(0);
    // Ohne Volltext (Altbestand/Zweitgerät): unverändert der erkannte Betrag.
    const legacy = receipt('');
    delete (legacy.recognizedData as Record<string, string>)._extractedText;
    expect(buildExpenseInputFromInbox(legacy, 'tankbeleg').grossAmount).toBe(59.5);
  });
});

describe('P2-A — eigene Kundengutschrift ist keine Ausgabe', () => {
  const ownCredit =
    'Mustermann Sanitär GmbH\nGutschrift an Kunden\nHandwerkerweg 7 · 10115 Berlin\nSägewerk Flisch GmbH\nWerkstraße 12\n32657 Lemgo\nGutschrift GS-K-2026-1\nDatum 01.10.2026\nMinderung wegen Mindermaß\nGutschrift brutto -2.856,00 €';

  it('A: eigene Firma ist Absender → kein Formular, keine Vorbelegung, keine Ausgabe', async () => {
    const item = await intake(ownCredit, 'eigene-gutschrift');
    expect(item.classifiedKind).toBe('gutschrift');
    expect(item.sender).toBe('Mustermann Sanitär GmbH');
    expect(createExpenseFromInbox(item)).toEqual({ ok: false, errorKey: 'document.accounting.ownCreditNoteReview' });
    expect(getExpensePrefillForInbox(item.id)).toBeNull();
    expect(getAllExpenses()).toHaveLength(0);
  });

  it('B: fremder Lieferant ist Absender, eigene Firma nur Empfänger → bestätigtes Formular', async () => {
    const item = await intake(
      'GC-Großhandel OWL GmbH\nGutschrift\nMustermann Sanitär GmbH\nHandwerkerweg 7\n10115 Berlin\nGutschrift GS-2026-0205\nDatum 05.02.2026\nGutschrift brutto -186,30 €',
      'fremde-gutschrift',
    );
    expect(item.sender).not.toBe('Mustermann Sanitär GmbH');
    expect(createExpenseFromInbox(item)).toEqual({ ok: true, kind: 'navigate', route: formRoute(item) });
    expect(getExpensePrefillForInbox(item.id)!.grossAmount).toBe(-186.3);
  });

  it('C: ohne Firmenprofil-Namen wird keine eigene Rolle behauptet → bestätigtes Formular', async () => {
    hydrateCompanyProfileStore({ ...DEFAULT_COMPANY_PROFILE, companyName: '' });
    const item = await intake(ownCredit, 'richtung-unklar');
    expect(createExpenseFromInbox(item)).toEqual({ ok: true, kind: 'navigate', route: formRoute(item) });
    expect(getAllExpenses()).toHaveLength(0);
  });
});

describe('P2-B — 60-Zeilen-Fallback dreht keine Gutschrift in eine Rechnung', () => {
  const creditPage = 'Baustoff Meyer GmbH\nGutschrift\nGutschriftsnummer: GS-60\nDatum: 01.10.2026\nRücknahme Material\nGutschrift brutto 119,00 EUR';
  const invoiceCopy = 'Baustoff Meyer GmbH\nRechnung\nRechnungsnummer: RE-2026-1\nMaterial 100,00 EUR\nGesamtbetrag 119,00 EUR\nZahlbar bis 15.09.2026';

  it('A: ohne Seitentexte, Rechnungskopie angehängt → Gutschrift, keine automatische Ausgabe', async () => {
    const item = await intake(`${creditPage}\n${invoiceCopy}`, 'gs-mit-kopie');
    expect(item.classifiedKind).toBe('gutschrift');
    expect(createExpenseFromInbox(item)).toEqual({ ok: true, kind: 'navigate', route: formRoute(item) });
    expect(getAllExpenses()).toHaveLength(0);
  });

  it('B: mit echten Seitentexten, Seite 2 Rechnungskopie → Gutschrift', () => {
    const result = classifyDocument({
      recognizedText: `${creditPage}\n${invoiceCopy}`,
      pageTexts: [{ pageNumber: 1, text: creditPage }, { pageNumber: 2, text: invoiceCopy }],
    });
    expect(result.classifiedKind).toBe('gutschrift');
  });

  const line13Invoice =
    'Baustoff Meyer GmbH\nMusterstraße 1\n12345 Musterstadt\nTel 0123\nFax 0124\nwww.meyer.de\nKunde Cirmak GmbH\nIndustriestr 18\n32105 Bad Salzuflen\nKd-Nr 4711\nDatum 01.10.2026\nSeite 1\nRechnung R-88\nGutschrift-Nr. aus Vormonat GS-9 berücksichtigt\nGesamtbetrag 119,00 EUR\nZahlbar bis 15.10.2026';

  it('C: Rechnungstitel in Zeile 13, Gutschrift-Nr. nur erwähnt → Eingangsrechnung (mit und ohne Seitentexte)', () => {
    expect(classifyDocument({ recognizedText: line13Invoice }).classifiedKind).toBe('eingangsrechnung');
    expect(classifyDocument({ recognizedText: line13Invoice, pageTexts: [{ pageNumber: 1, text: line13Invoice }] }).classifiedKind).toBe('eingangsrechnung');
  });

  it('D: Rechnungs-Nr. im Kopf, Gutschrift-Nr. später → keine Gutschrift', () => {
    const result = classifyDocument({
      recognizedText: 'Baustoff Meyer GmbH\nRechnung\nRechnungs-Nr.: R-77\nMaterial 200,00 EUR\nverrechnet mit Gutschrift-Nr. GS-5\nGesamtbetrag 238,00 EUR\nZahlbar bis 15.10.2026',
    });
    expect(result.classifiedKind).toBe('eingangsrechnung');
  });

  it('E: echte Gutschrift mit Bezug auf die Originalrechnung → Gutschrift', () => {
    const result = classifyDocument({
      recognizedText: 'Baustoff Meyer GmbH\nGutschrift\nzu Rechnung RE-2026-1 vom 01.09.2026\nRechnungsnummer: RE-2026-1\nGutschrift brutto 119,00 EUR',
    });
    expect(result.classifiedKind).toBe('gutschrift');
  });
});

describe('Verzögerter Analysis-Commit läuft genau einmal (gesteuertes RAF und Zeitgeber)', () => {
  let frames: FrameRequestCallback[] = [];
  let analyzeCalls: ReturnType<typeof vi.spyOn>;

  function flushFrames(): void {
    const pending = frames;
    frames = [];
    pending.forEach((callback) => callback(0));
  }

  beforeEach(() => {
    frames = [];
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    vi.stubGlobal('requestIdleCallback', undefined);
    // Ein Eingang ohne Ergebnis: jeder Lauf ruft die Analyse genau einmal auf.
    analyzeCalls = vi.spyOn(intakeWorkflowService, 'analyzeUploadedDocument').mockReturnValue(null);
  });

  it('A: Zeichnen zuerst → genau einmal, der Zeitgeber läuft nicht nach', () => {
    scheduleIntakeDocumentAnalysisCommit('inbox-exactly-once-a');
    flushFrames();
    flushFrames();
    vi.advanceTimersByTime(0);
    expect(analyzeCalls).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5_000);
    flushFrames();
    expect(analyzeCalls).toHaveBeenCalledTimes(1);
  });

  it('B: Zeitgeber zuerst → genau einmal, späteres Zeichnen läuft nicht nach', () => {
    scheduleIntakeDocumentAnalysisCommit('inbox-exactly-once-b');
    vi.advanceTimersByTime(1_000);
    expect(analyzeCalls).toHaveBeenCalledTimes(1);
    flushFrames();
    flushFrames();
    vi.advanceTimersByTime(5_000);
    expect(analyzeCalls).toHaveBeenCalledTimes(1);
  });

  it('C: Zeichnen feuert nie (verdeckter Tab) → Zeitgeber, genau einmal', () => {
    scheduleIntakeDocumentAnalysisCommit('inbox-exactly-once-c');
    vi.advanceTimersByTime(999);
    expect(analyzeCalls).toHaveBeenCalledTimes(0);
    vi.advanceTimersByTime(5_000);
    expect(analyzeCalls).toHaveBeenCalledTimes(1);
  });

  it('D: beide werden erst später gemeinsam fällig → genau einmal', () => {
    scheduleIntakeDocumentAnalysisCommit('inbox-exactly-once-d');
    flushFrames();
    flushFrames();
    vi.advanceTimersByTime(5_000);
    flushFrames();
    expect(analyzeCalls).toHaveBeenCalledTimes(1);
  });
});
