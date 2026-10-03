/**
 * EINGANG-01D-1 Nacharbeit — Gutschrift-Sicherheit, Gutschriftbetrag,
 * Analysis-Recovery.
 *
 * Echte Produktionspfade: Klassifikation → `intakeCachedDocumentFile` →
 * Eingang → `createExpenseFromInbox` → Formular-Vorbelegung
 * (`getExpensePrefillForInbox`), Bestandsladen (`bootstrapBusinessState`)
 * mit Recovery, Cloud-Payload/Pull. Ersetzt wird nur die Bild-OCR.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDocumentBlobDatabaseReset } from '../test/documentBlobTestReset';
import { DEFAULT_COMPANY_PROFILE } from '../data/companyProfileDefaults';
import { hydrateCompanyProfileStore } from './companyProfileService';
import { classifyDocument } from './documentClassificationService';
import { hydrateDocumentStore } from './documentService';
import { intakeCachedDocumentFile } from './documentIntakeService';
import {
  getDocumentWorkResult,
  getDocumentWorkResultStoreSnapshot,
  resetDocumentWorkResultStoreForTests,
  upsertDocumentWorkResult,
} from './documentWorkResultStoreService';
import { getAllExpenses } from './expenseService';
import { hydrateExpenseStore } from './expenseStore';
import { getInboxItemById, hydrateInboxStore } from './inboxService';
import * as intakeAnalysisCommitService from './intakeAnalysisCommitService';
import {
  findInboxItemsMissingIntakeAnalysis,
  recoverMissingIntakeAnalysesNow,
} from './intakeAnalysisCommitService';
import {
  createExpenseFromInbox,
  getExpensePrefillForInbox,
  resolveCreditNoteGrossTotal,
} from './officeActionService';
import { setImageOcrExtractorForTests } from './ocrDocumentService';
import { bootstrapBusinessState } from './storage/storageBootstrapService';
import { setTaskStoreForTests } from './taskStore';
import { hydrateVorgangStore } from './vorgangService';
import {
  buildInboxItemCloudPayload,
  buildWorkResultPushPayload,
  mergeInboxItemsFromPull,
  mergeWorkResultsFromPull,
  type CloudInboxRow,
  type CloudWorkResultRow,
} from './document/intakeCloudSyncService';
import type { CachedDocumentFilePayload } from './cachedDocumentFileService';
import type { InboxItem } from '../types/models';

const WS = '00000000-0000-4000-8000-0000000d1a01';

const TEXT = {
  invoiceMentionsCreditNoUntitled:
    'Baustoff Meyer GmbH\nIhre Bestellung vom 01.09.2026\nRechnungs-Nr.: R-77\nDatum: 01.10.2026\nMaterial 200,00 EUR\nverrechnet mit Gutschrift-Nr. GS-5\nGesamtbetrag 238,00 EUR\nZahlbar bis 15.10.2026',
  invoiceMentionsCreditNo:
    'Baustoff Meyer GmbH\nRechnung\nIhre Bestellung vom 01.09.2026\nRechnungs-Nr.: R-77\nDatum: 01.10.2026\nMaterial 200,00 EUR\nverrechnet mit Gutschrift-Nr. GS-5\nGesamtbetrag 238,00 EUR\nZahlbar bis 15.10.2026',
  invoiceTitleLine13:
    'Baustoff Meyer GmbH\nMusterstraße 1\n12345 Musterstadt\nTel 0123\nFax 0124\nwww.meyer.de\nKunde Cirmak GmbH\nIndustriestr 18\n32105 Bad Salzuflen\nKd-Nr 4711\nDatum 01.10.2026\nSeite 1\nRechnung R-88\nGutschrift-Nr. aus Vormonat GS-9 berücksichtigt\nGesamtbetrag 119,00 EUR\nZahlbar bis 15.10.2026',
  creditWithInvoiceReference:
    'Baustoff Meyer GmbH\nGutschrift\nzu Rechnung RE-2026-1 vom 01.09.2026\nRechnungsnummer: RE-2026-1\nDatum: 01.10.2026\nRücknahme Material\nGutschrift brutto 119,00 EUR',
  creditNumberOnly:
    'Baustoff Meyer GmbH\nGutschriftsnummer: GS-2026-12\nDatum: 01.10.2026\nRücknahme Material\nGesamtbetrag 50,00 EUR',
  bank:
    'Sparkasse Musterstadt\nKontoauszug Nr. 9\nBuchungstag Valuta Text\n01.10.2026 01.10.2026 Gutschrift Kunde Meyer 500,00 EUR\nAlter Saldo 1.000,00 EUR\nNeuer Saldo 1.500,00 EUR',
  creditNetTaxGross:
    'Baustoff Meyer GmbH\nGutschrift\nGutschriftsnummer: GS-3\nDatum: 01.10.2026\nRücknahme Material\nNetto 100,00 EUR\nUmsatzsteuer 19 % 19,00 EUR\nGesamtbetrag 119,00 EUR',
  creditNegativeGold:
    'GC-Großhandel OWL GmbH\nGutschrift\nCirmak Haustechnik GmbH\nGutschrift GS-2026-0205\nDatum 05.02.2026 · zu RE-2026-11842\n1 Retoure Pressfittinge -186,30 €\nNetto -156,55 €\nUSt 19 % -29,75 €\nGutschrift brutto -186,30 €',
  creditWithoutTotal:
    'Baustoff Meyer GmbH\nGutschrift\nGutschriftsnummer: GS-4\nDatum: 01.10.2026\nRücknahme Material 119,00 EUR',
  correction:
    'Baustoff Meyer GmbH\nRechnungskorrektur\nzur Rechnung R-2026-100 vom 01.10.2026\nRechnungsnummer: RK-2026-3\nDatum: 05.10.2026\nGesamtbetrag 107,10 EUR\nZahlbar bis 20.10.2026',
  selfBilling:
    'Kunde AG\nAbrechnungsgutschrift\nGutschrift im Gutschriftsverfahren gemäß § 14 Abs. 2 Satz 2 UStG\nGutschriftsnummer: AG-55\nDatum: 01.10.2026\nGesamtbetrag 1.190,00 EUR',
  invoice:
    'Baustoff Müller GmbH\nRechnung\nRechnungsnummer: R-2026-100\nRechnungsdatum: 01.10.2026\nMaterial 100,00 EUR\nUSt 19 % 19,00 EUR\nGesamtbetrag 119,00 EUR\nZahlbar bis 15.10.2026',
} as const;

const LARGE_INVOICE = `${TEXT.invoice}\n${'Leistungsbeschreibung Position Material und Lohn gemäß Aufmaß.\n'.repeat(900)}`;

let ocrText = '';
let fileCounter = 0;

function payloadFor(name: string): CachedDocumentFilePayload {
  fileCounter += 1;
  const bytes = new TextEncoder().encode(`01d1n-${name}-${fileCounter}-${Math.random()}`);
  return { fileName: `${name}.png`, mimeType: 'image/png', fileSize: bytes.length, bytes };
}

async function intake(text: string, name: string): Promise<InboxItem> {
  ocrText = text;
  const result = await intakeCachedDocumentFile(payloadFor(name), { importSource: 'upload', recognizedText: text });
  if (!result.success || result.duplicate) throw new Error(`intake failed for ${name}`);
  return getInboxItemById(result.inboxItem.id)!;
}

function cloudInboxRow(item: InboxItem): CloudInboxRow {
  return {
    client_inbox_id: item.id,
    status: item.status,
    vorgang_link_status: 'none',
    client_file_ref_id: item.fileRefId ?? null,
    archive_document_id: null,
    vorgang_id: null,
    expense_id: null,
    payload: JSON.parse(JSON.stringify(buildInboxItemCloudPayload(item))),
    updated_at: '2026-10-01T10:00:00.000Z',
    deleted: false,
    row_version: 1,
  };
}

function formRoute(item: InboxItem): string {
  return `/ausgaben/neu?inboxId=${encodeURIComponent(item.id)}`;
}

useDocumentBlobDatabaseReset();

beforeEach(() => {
  localStorage.clear();
  fileCounter = 0;
  hydrateCompanyProfileStore(DEFAULT_COMPANY_PROFILE);
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
  intakeAnalysisCommitService.cancelIntakeAnalysisRecovery();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('Nacharbeit 1 — Gutschrift-Erkennung: Dokumentidentität statt Erwähnung', () => {
  it('A: Rechnung mit Rechnungs-Nr. und erwähnter Gutschrift-Nr. → Eingangsrechnung, positive Ausgabe', async () => {
    const item = await intake(TEXT.invoiceMentionsCreditNo, 'rechnung-gs-nr');
    // Ohne Titelzeile bleibt es bei der bestehenden Rechnungsart — entscheidend: keine Gutschrift.
    expect(['eingangsrechnung', 'rechnung']).toContain(item.classifiedKind);
    expect(item.classifiedKind).not.toBe('gutschrift');
    expect(item.financeReviewReason).toBeUndefined();

    const result = createExpenseFromInbox(item);
    expect(result.ok).toBe(true);
    const expenses = getAllExpenses().filter((expense) => expense.linkedInboxId === item.id);
    expect(expenses).toHaveLength(1);
    expect(expenses[0]!.grossAmount).toBe(238);
    expect(expenses[0]!.isCreditNote).toBe(false);
  });

  it('A2: ohne Titelzeile (Schwarz-Probe) → keine Gutschrift, keine Vorzeichenumkehr', () => {
    const item = classifyDocument({ recognizedText: TEXT.invoiceMentionsCreditNoUntitled, sourceFileName: 'r77.pdf' });
    expect(item.classifiedKind).not.toBe('gutschrift');
    expect(item.financeReviewReason).toBeUndefined();
  });

  it('B: Rechnungstitel erst in Zeile 13 + Gutschrift-Nr. im Text → Eingangsrechnung', () => {
    const result = classifyDocument({ recognizedText: TEXT.invoiceTitleLine13, sourceFileName: 'r88.pdf' });
    expect(result.classifiedKind).toBe('eingangsrechnung');
  });

  it('B2: dasselbe mit getrennter Seite 1 → Eingangsrechnung', () => {
    const result = classifyDocument({
      recognizedText: TEXT.invoiceTitleLine13,
      sourceFileName: 'r88.pdf',
      pageTexts: [{ pageNumber: 1, text: TEXT.invoiceTitleLine13 }],
    });
    expect(result.classifiedKind).toBe('eingangsrechnung');
  });

  it('C: echte Gutschrift mit Bezug auf die ursprüngliche Rechnung → bleibt Gutschrift', () => {
    expect(classifyDocument({ recognizedText: TEXT.creditWithInvoiceReference, sourceFileName: 'gs.pdf' }).classifiedKind).toBe('gutschrift');
  });

  it('D: Gutschriftsnummer als Kopfmerkmal ohne Rechnungstitel → bleibt Gutschrift', () => {
    expect(classifyDocument({ recognizedText: TEXT.creditNumberOnly, sourceFileName: 'gs.pdf' }).classifiedKind).toBe('gutschrift');
  });

  it('E: Kontoauszug mit Buchungstext „Gutschrift" → bleibt Kontoauszug', () => {
    expect(classifyDocument({ recognizedText: TEXT.bank, sourceFileName: 'auszug.pdf' }).classifiedKind).toBe('kontoauszug');
  });
});

describe('Nacharbeit 2/3 — Gutschrift nie automatisch gebucht, Betrag nur aus dem Gesamtbetrag', () => {
  it('B: Netto 100 / USt 19 / Gesamtbetrag 119 → keine Ausgabe, Formular, Vorbelegung −119', async () => {
    const item = await intake(TEXT.creditNetTaxGross, 'gs-netto-ust-gesamt');
    expect(item.classifiedKind).toBe('gutschrift');

    expect(createExpenseFromInbox(item)).toEqual({ ok: true, kind: 'navigate', route: formRoute(item) });
    expect(getAllExpenses()).toHaveLength(0);

    const prefill = getExpensePrefillForInbox(item.id)!;
    expect(prefill.grossAmount).toBe(-119);
    expect(prefill.isCreditNote).toBe(true);
    expect(prefill.paymentDueDate).toBeUndefined();
    expect(prefill.linkedInboxId).toBe(item.id);
  });

  it('C: negativ gedruckte Gutschrift −186,30 (Schranke „keine Forderung") → Formular, −186,30, keine Doppelnegierung', async () => {
    const item = await intake(TEXT.creditNegativeGold, 'gs-negativ');
    expect(item.classifiedKind).toBe('gutschrift');
    expect(createExpenseFromInbox(item)).toEqual({ ok: true, kind: 'navigate', route: formRoute(item) });
    expect(getAllExpenses()).toHaveLength(0);
    expect(getExpensePrefillForInbox(item.id)!.grossAmount).toBe(-186.3);
  });

  it('D: Gutschrift ohne beschrifteten Gesamtbetrag → Formular, Betrag leer', async () => {
    const item = await intake(TEXT.creditWithoutTotal, 'gs-ohne-gesamt');
    expect(item.classifiedKind).toBe('gutschrift');
    expect(createExpenseFromInbox(item)).toEqual({ ok: true, kind: 'navigate', route: formRoute(item) });
    expect(getExpensePrefillForInbox(item.id)!.grossAmount).toBe(0);
  });

  it('D2: widersprüchliche Gesamtbeträge → kein Betrag (nicht raten)', () => {
    expect(resolveCreditNoteGrossTotal('Gutschrift\nGesamtbetrag 119,00 EUR\nBrutto 120,00 EUR')).toBeNull();
    expect(resolveCreditNoteGrossTotal('Gutschrift\nGesamtbetrag 1.190,00 EUR\nGutschrift brutto -1.190,00 €')).toBe(1190);
  });

  it('Wiederholung: vorhandene Gutschrift-Ausgabe → dorthin, keine zweite', async () => {
    const item = await intake(TEXT.creditNetTaxGross, 'gs-wiederholung');
    const { addExpense } = await import('./expenseService');
    const created = addExpense(getExpensePrefillForInbox(item.id)!);
    expect(created.success).toBe(true);
    if (!created.success) return;
    expect(created.expense.grossAmount).toBe(-119);
    expect(created.expense.isCreditNote).toBe(true);
    expect(createExpenseFromInbox(item)).toEqual({ ok: true, kind: 'navigate', route: `/ausgaben/${created.expense.id}` });
    expect(getAllExpenses()).toHaveLength(1);
  });

  it.each([
    ['E invoice_correction', TEXT.correction, 'invoice_correction'],
    ['F self_billing_credit', TEXT.selfBilling, 'self_billing_credit'],
  ] as const)('%s → keine Ausgabe, keine Vorbelegung', async (_label, text, reason) => {
    const item = await intake(text, `review-${reason}`);
    expect(item.financeReviewReason).toBe(reason);
    expect(createExpenseFromInbox(item)).toEqual({ ok: false, errorKey: 'document.accounting.financeReviewRequired' });
    expect(getExpensePrefillForInbox(item.id)).toBeNull();
    expect(getAllExpenses()).toHaveLength(0);
  });
});

describe('Nacharbeit 5 — Timer-Absicherung des verzögerten Analysis-Commits', () => {
  it('G: requestAnimationFrame feuert nie (verdeckter Tab) → Commit startet trotzdem', async () => {
    vi.stubGlobal('requestAnimationFrame', () => 0);
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
    const item = await intake(LARGE_INVOICE, 'raf-blockiert');
    expect(getDocumentWorkResult(item.id)).toBeNull();
    await vi.waitFor(() => expect(getDocumentWorkResult(item.id)).not.toBeNull(), { timeout: 4_000, interval: 50 });
  });
  // „Genau einmal" wird in intakeFinanceTruth01d1Nacharbeit2.test.ts mit gesteuerten RAF/Timern geprüft.
});

describe('Nacharbeit 6/7/8 — Recovery nach Reload', () => {
  it('verlorener Callback → Reload → Recovery schreibt fest → Zweitgerät erhält das Ergebnis ohne Volltext', async () => {
    bootstrapBusinessState({ userId: 'user-1d1', workspaceId: WS });
    hydrateCompanyProfileStore(DEFAULT_COMPANY_PROFILE);

    // 1/2 — mehrseitig/groß aufgenommen, der geplante Commit geht verloren.
    const lost = vi
      .spyOn(intakeAnalysisCommitService, 'scheduleIntakeDocumentAnalysisCommit')
      .mockImplementation(() => undefined);
    const item = await intake(LARGE_INVOICE, 'recovery-gross');
    expect(lost).toHaveBeenCalledWith(item.id);
    lost.mockRestore();

    // 3 — der Eingang mit Volltext ist gespeichert, das Ergebnis fehlt.
    expect(getInboxItemById(item.id)!.recognizedData._extractedText).toBeTruthy();
    expect(getDocumentWorkResult(item.id)).toBeNull();

    // 4/5/6 — Neustart: Bestand laden, Recovery holt nach (verzögert, onlyIfMissing).
    bootstrapBusinessState({ userId: 'user-1d1', workspaceId: WS });
    expect(getInboxItemById(item.id)).toBeTruthy();
    expect(getDocumentWorkResult(item.id)).toBeNull();
    await vi.waitFor(() => expect(getDocumentWorkResult(item.id)).not.toBeNull(), { timeout: 6_000, interval: 100 });

    // 7/8 — Sync zum Zweitgerät: Ergebnis kommt an, ohne eigenen Volltext.
    const reloaded = getInboxItemById(item.id)!;
    const inboxRow = cloudInboxRow(reloaded);
    expect(Object.keys(inboxRow.payload.recognizedData as Record<string, string>).some((key) => key.startsWith('_'))).toBe(false);
    const work = getDocumentWorkResult(item.id)!;
    const workRow: CloudWorkResultRow = {
      ...JSON.parse(JSON.stringify(buildWorkResultPushPayload(work, false))),
      updated_at: '2026-10-01T10:00:00.000Z',
      row_version: 1,
    };
    const context = { deviceId: 'dev-b', workspaceId: WS, dirty: new Set<string>() };
    const onB = mergeWorkResultsFromPull([], [workRow], context).items;
    expect(onB.map((entry) => entry.inboxItemId)).toEqual([item.id]);
    const inboxOnB = mergeInboxItemsFromPull([], [inboxRow], context).items[0]!;
    expect(inboxOnB.recognizedData._extractedText).toBeUndefined();
  }, 20_000);

  it('onlyIfMissing: ein vorhandenes Ergebnis wird nicht überschrieben', async () => {
    const item = await intake(TEXT.invoice, 'recovery-vorhanden');
    const existing = getDocumentWorkResult(item.id)!;
    upsertDocumentWorkResult({ ...existing, analyzedAt: '2000-01-01T00:00:00.000Z' });
    expect(findInboxItemsMissingIntakeAnalysis()).not.toContain(item.id);
    recoverMissingIntakeAnalysesNow();
    expect(getDocumentWorkResult(item.id)!.analyzedAt).toBe('2000-01-01T00:00:00.000Z');
  });

  it('fail closed: ohne lokalen Volltext (Zweitgerät) wird nichts erfunden', async () => {
    const item = await intake(TEXT.invoice, 'recovery-ohne-text');
    const rowFromCloud = cloudInboxRow(getInboxItemById(item.id)!);
    const context = { deviceId: 'dev-b', workspaceId: WS, dirty: new Set<string>() };
    const onB = mergeInboxItemsFromPull([], [rowFromCloud], context).items;
    hydrateInboxStore(onB);
    resetDocumentWorkResultStoreForTests();
    expect(findInboxItemsMissingIntakeAnalysis()).toEqual([]);
    expect(recoverMissingIntakeAnalysesNow()).toBe(0);
    expect(getDocumentWorkResultStoreSnapshot()).toHaveLength(0);
  });
});
