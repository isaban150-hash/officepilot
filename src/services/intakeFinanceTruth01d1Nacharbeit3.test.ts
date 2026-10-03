/**
 * EINGANG-01D-1 Nacharbeit 3 — Fristquelle einer Gutschrift, sicherer
 * Gesamtbetrag ohne „Summe"-Falle, eigene Gutschriftsnummer.
 *
 * Echte Produktionspfade: Klassifikation (mit/ohne Seitentexte) → Eingang →
 * Aufgaben (`createTaskForItem` und die automatische Aufgabe der
 * Ablagebestätigung: `createTaskFromInboxItem(..., { autoCreated: true })`),
 * `intakeCachedDocumentFile` → `createExpenseFromInbox` → Vorbelegung.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useDocumentBlobDatabaseReset } from '../test/documentBlobTestReset';
import { createAuftragInboxItem } from '../test/fixtures';
import { DEFAULT_COMPANY_PROFILE } from '../data/companyProfileDefaults';
import { getCompanyProfile, hydrateCompanyProfileStore } from './companyProfileService';
import { buildInboxItemFromClassification, classifyDocument, getClassificationForItem } from './documentClassificationService';
import { hydrateDocumentStore } from './documentService';
import { intakeCachedDocumentFile } from './documentIntakeService';
import { resetDocumentWorkResultStoreForTests } from './documentWorkResultStoreService';
import { getAllExpenses } from './expenseService';
import { hydrateExpenseStore } from './expenseStore';
import { getInboxItemById, hydrateInboxStore } from './inboxService';
import { createTaskForItem } from './inboxTaskService';
import {
  buildExpenseInputFromInbox,
  createExpenseFromInbox,
  getExpensePrefillForInbox,
  resolveCreditNoteGrossTotal,
} from './officeActionService';
import { t } from '../i18n';
import { buildDocumentSummary } from './documentSummary';
import { analyzeUploadedDocument } from './intakeWorkflowService';
import { buildDocumentMeaningView } from './document/documentMeaningPresentationService';
import {
  applyIntakeAssessmentToSummary,
  buildIntakeAssessmentLead,
  deriveIntakeAssessment,
} from './document/intakeAssessmentService';
import { setImageOcrExtractorForTests } from './ocrDocumentService';
import { createTaskFromInboxItem } from './taskEngineService';
import { getAllTasksFromStore, setTaskStoreForTests } from './taskStore';
import { hydrateVorgangStore } from './vorgangService';
import type { CachedDocumentFilePayload } from './cachedDocumentFileService';
import type { InboxItem } from '../types/models';

const PROFILE = {
  ...DEFAULT_COMPANY_PROFILE,
  companyName: 'Mustermann Sanitär GmbH',
  street: 'Handwerkerweg 7',
  zip: '10115',
  city: 'Berlin',
};
const TO_US = 'An: Mustermann Sanitär GmbH\nHandwerkerweg 7\n10115 Berlin';

let ocrText = '';
let counter = 0;

function itemFromClassification(name: string, text: string, pageTexts?: Array<{ pageNumber: number; text: string }>): InboxItem {
  const classification = classifyDocument({ recognizedText: text, sourceFileName: `${name}.pdf`, pageTexts });
  const item = {
    ...buildInboxItemFromClassification(classification),
    id: `inbox-n3-${name}`,
    status: 'neu',
    receivedAt: '2026-10-01T10:00:00.000Z',
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-01T10:00:00.000Z',
    recognizedData: {
      ...classification.recognizedData,
      _extractedText: text,
      ...(pageTexts ? { _pageTexts: JSON.stringify(pageTexts) } : {}),
    },
  } as InboxItem;
  hydrateInboxStore([item]);
  return item;
}

async function intake(text: string, name: string): Promise<InboxItem> {
  ocrText = text;
  counter += 1;
  const bytes = new TextEncoder().encode(`01d1n3-${name}-${counter}-${Math.random()}`);
  const payload: CachedDocumentFilePayload = { fileName: `${name}.png`, mimeType: 'image/png', fileSize: bytes.length, bytes };
  const result = await intakeCachedDocumentFile(payload, { importSource: 'upload', recognizedText: text });
  if (!result.success || result.duplicate) throw new Error(`intake failed for ${name}`);
  return getInboxItemById(result.inboxItem.id)!;
}

function formRoute(item: InboxItem): string {
  return `/ausgaben/neu?inboxId=${encodeURIComponent(item.id)}`;
}

useDocumentBlobDatabaseReset();

beforeEach(() => {
  localStorage.clear();
  hydrateCompanyProfileStore(PROFILE);
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
});

describe('Frist einer Gutschrift gehört der Gutschrift', () => {
  const creditPage = `Baustoff Meyer GmbH\nGutschrift\n${TO_US}\nGutschriftsnummer: GS-60\nDatum: 01.10.2026\nRücknahme Material\nGutschrift brutto 119,00 EUR`;
  const invoiceCopy = `Baustoff Meyer GmbH\nRechnung\n${TO_US}\nRechnungsnummer: RE-2026-1\nMaterial 100,00 EUR\nGesamtbetrag 119,00 EUR\nZahlbar bis 15.09.2026`;

  function expectNoForeignDeadlineOrTask(item: InboxItem): void {
    expect(item.classifiedKind).toBe('gutschrift');
    expect(item.deadline ?? null).toBeNull();
    expect(item.deadlineType).toBeUndefined();
    expect(getClassificationForItem(item).taskTemplate?.dueDate ?? null).not.toBe('2026-09-15');
    // Ablagebestätigung legt diese Aufgabe automatisch an; „Aufgabe erstellen" ebenso.
    const auto = createTaskFromInboxItem(item, getCompanyProfile(), { autoCreated: true });
    expect(auto?.dueDate ?? null).not.toBe('2026-09-15');
    createTaskForItem(item.id);
    expect(getAllTasksFromStore().map((task) => task.dueDate ?? null)).not.toContain('2026-09-15');
  }

  it('A: Seite 1 Gutschrift, Seite 2 Rechnungskopie mit „Zahlbar bis 15.09." → keine Frist, keine fällige Aufgabe', () => {
    const item = itemFromClassification('gs-kopie-seiten', `${creditPage}\n${invoiceCopy}`, [
      { pageNumber: 1, text: creditPage },
      { pageNumber: 2, text: invoiceCopy },
    ]);
    expectNoForeignDeadlineOrTask(item);
  });

  it('B: dasselbe ohne echte Seitentexte → ebenfalls keine Zahlungsfrist (fail closed)', () => {
    const item = itemFromClassification('gs-kopie-ohne-seiten', `${creditPage}\n${invoiceCopy}`);
    expectNoForeignDeadlineOrTask(item);
  });

  it('B2: eigene echte Handlungsfrist der Gutschrift (Antwort) bleibt erhalten', () => {
    const item = itemFromClassification(
      'gs-antwortfrist',
      `${creditPage}\nBitte bestätigen Sie den Erhalt dieser Gutschrift bis zum 20.10.2026.`,
    );
    expect(item.classifiedKind).toBe('gutschrift');
    expect(item.deadline).toBe('2026-10-20');
    expect(item.deadlineType).toBe('response_due');
  });

  it('C: normale Eingangsrechnung mit „Zahlbar bis 15.09." → payment_due, Frist und Aufgabenfälligkeit bleiben', () => {
    const item = itemFromClassification('rechnung-frist', invoiceCopy);
    expect(item.classifiedKind).toBe('eingangsrechnung');
    expect(item.deadline).toBe('2026-09-15');
    expect(item.deadlineType).toBe('payment_due');
    // Aufgabenvorlage der Rechnung trägt die Zahlungsfrist weiterhin (bestehender Vertrag).
    expect(getClassificationForItem(item).taskTemplate?.dueDate).toBe('2026-09-15');
  });

  it('D: Freistellung — Gültigkeit bleibt getrennt, keine Handlungsfrist', () => {
    const item = itemFromClassification(
      'freistellung',
      'Finanzamt Musterstadt\nFreistellungsbescheinigung nach § 48 b EStG\nDie Freistellung gilt bis zum 31.08.2029.',
    );
    expect(item.classifiedKind).toBe('freistellungsbescheinigung');
    expect(item.deadline ?? null).toBeNull();
  });

  it('E: response_due und document_submission_due anderer Schreiben unverändert', () => {
    const response = itemFromClassification(
      'anhoerung',
      'Landratsamt Musterkreis\nAnhörung\nbitte nehmen Sie bis zum 20.10.2026 Stellung zu dem Sachverhalt.',
    );
    expect(response.deadline).toBe('2026-10-20');
    expect(response.deadlineType).toBe('response_due');
    const submission = itemFromClassification(
      'unterlagen',
      'Landratsamt Musterkreis\nAnforderung\nBitte die fehlenden Unterlagen bis zum 25.10.2026 einreichen.',
    );
    expect(submission.deadline).toBe('2026-10-25');
    expect(submission.deadlineType).toBe('document_submission_due');
  });
});

describe('Sicherer Gesamtbetrag: „Summe" und „Netto-Summe" sind keine Gesamtlabels', () => {
  const invoice = (lines: string) =>
    `Baustoff Meyer GmbH\nRechnung\n${TO_US}\nRechnungs-Nr.: R-${Math.random().toString(36).slice(2, 7)}\nDatum: 01.10.2026\n${lines}\nZahlbar bis 15.10.2026`;

  it.each([
    ['A: Netto-Summe 200 / MwSt 38 / zusammen 238', 'Netto-Summe 200,00 EUR\nMwSt 38,00 EUR\nzusammen 238,00 EUR'],
    ['B: Netto Summe 200 / MwSt 38 / zusammen 238', 'Netto Summe 200,00 EUR\nMwSt 38,00 EUR\nzusammen 238,00 EUR'],
    ['C: Summe 200 / MwSt 38 / zusammen 238', 'Summe 200,00 EUR\nMwSt 38,00 EUR\nzusammen 238,00 EUR'],
  ])('%s → keine automatische Buchung, Formular, Betrag leer', async (_label, lines) => {
    const item = await intake(invoice(lines), 'summe');
    expect(createExpenseFromInbox(item)).toEqual({ ok: true, kind: 'navigate', route: formRoute(item) });
    expect(getAllExpenses()).toHaveLength(0);
    expect(getExpensePrefillForInbox(item.id)!.grossAmount).toBe(0);
  });

  it('D: Kassenbeleg „SUMME 92,95" ohne weiteren Geldbetrag → bleibt sicher', () => {
    const receipt: InboxItem = {
      ...createAuftragInboxItem({ id: 'inbox-n3-kassenbeleg' }),
      classifiedKind: 'kassenbeleg',
      sender: 'Baumarkt Nord',
      recognizedData: { Betrag: '92,95 EUR', Datum: '2026-10-01', _extractedText: 'Baumarkt Nord\nKassenbon\nSUMME 92,95' },
    };
    expect(buildExpenseInputFromInbox(receipt, 'kassenbeleg').grossAmount).toBe(92.95);
  });

  it.each([
    ['E: Netto 200 / MwSt 38 / Gesamtbetrag 238', 'Netto 200,00 EUR\nMwSt 38,00 EUR\nGesamtbetrag 238,00 EUR', 238],
    ['F: Netto 200 / MwSt 38 / Rechnungsbetrag 238', 'Netto 200,00 EUR\nMwSt 38,00 EUR\nRechnungsbetrag 238,00 EUR', 238],
    ['G: Zwischensumme 200 / MwSt 38 / Gesamtbetrag 238', 'Zwischensumme 200,00 EUR\nMwSt 38,00 EUR\nGesamtbetrag 238,00 EUR', 238],
    ['H: Positions-Summen + Gesamtbetrag 238', 'Pos 1 Summe 120,00 EUR\nPos 2 Summe 80,00 EUR\nMwSt 38,00 EUR\nGesamtbetrag 238,00 EUR', 238],
    ['I: widersprüchliche Gesamtlabels 238 / 230', 'Netto 200,00 EUR\nGesamtbetrag 238,00 EUR\nZahlbetrag 230,00 EUR', 0],
  ] as const)('%s → sicherer Betrag %s', async (_label, lines, expected) => {
    const item = await intake(invoice(lines), 'gesamt');
    expect(buildExpenseInputFromInbox(item).grossAmount).toBe(expected);
    if (expected === 0) {
      expect(createExpenseFromInbox(item)).toEqual({ ok: true, kind: 'navigate', route: formRoute(item) });
      expect(getAllExpenses()).toHaveLength(0);
    } else {
      expect(getAllExpenses().some((expense) => expense.grossAmount === 200)).toBe(false);
    }
  });
});

describe('Belegnummer einer Gutschrift ist ihre eigene Nummer', () => {
  it('A: Gutschrift-Nr. GS-2026-17 mit Bezug auf Rechnung RE-2026-1 → GS-2026-17', async () => {
    const item = await intake(
      `Baustoff Meyer GmbH\nGutschrift\n${TO_US}\nGutschrift-Nr. GS-2026-17\nzu Rechnung RE-2026-1 vom 01.09.2026\nRechnungsnummer: RE-2026-1\nGutschrift brutto 119,00 EUR`,
      'gs-nummer',
    );
    expect(item.classifiedKind).toBe('gutschrift');
    expect(createExpenseFromInbox(item)).toEqual({ ok: true, kind: 'navigate', route: formRoute(item) });
    const prefill = getExpensePrefillForInbox(item.id)!;
    expect(prefill.invoiceNumber).toBe('GS-2026-17');
    expect(prefill.grossAmount).toBe(-119);
  });

  it('B: nur Bezug auf Rechnung RE-2026-1, keine eigene Nummer → nicht RE-2026-1', async () => {
    const item = await intake(
      `Baustoff Meyer GmbH\nGutschrift\n${TO_US}\nzu Rechnung RE-2026-1 vom 01.09.2026\nRechnungsnummer: RE-2026-1\nGutschrift brutto 119,00 EUR`,
      'gs-ohne-nummer',
    );
    expect(item.classifiedKind).toBe('gutschrift');
    expect(getExpensePrefillForInbox(item.id)!.invoiceNumber).not.toBe('RE-2026-1');
    expect(getExpensePrefillForInbox(item.id)!.invoiceNumber).toBe('');
  });

  it('C: normale Rechnung RE-2026-1 → Rechnungsnummer unverändert', async () => {
    const item = await intake(
      `Baustoff Meyer GmbH\nRechnung\n${TO_US}\nRechnungsnummer: RE-2026-1\nNetto 100,00 EUR\nMwSt 19,00 EUR\nGesamtbetrag 119,00 EUR\nZahlbar bis 15.10.2026`,
      'rechnung-nummer',
    );
    expect(buildExpenseInputFromInbox(item).invoiceNumber).toBe('RE-2026-1');
  });

  it('D: Prüffall (Rechnungskorrektur) → weiterhin keine Vorbelegung', async () => {
    const item = await intake(
      `Baustoff Meyer GmbH\nRechnungskorrektur\n${TO_US}\nzur Rechnung RE-2026-1 vom 01.09.2026\nRechnungsnummer: RK-2026-3\nGesamtbetrag 107,10 EUR`,
      'korrektur',
    );
    expect(item.financeReviewReason).toBe('invoice_correction');
    expect(getExpensePrefillForInbox(item.id)).toBeNull();
  });
});

/*
 * WEISS-Nacharbeit — realer Fall MB-GS-2026-0311: „Gutschriftbetrag" (ohne
 * Fugen-s) ist der Gesamtbetrag. Sichtbar und vorbelegt wird 285,60 €, nie
 * der Nettobetrag 240,00 € aus dem Erkennungsfeld `Betrag`.
 */
describe('WEISS: Gutschriftbetrag ist der Gesamtbetrag, nicht der Nettobetrag', () => {
  const GS_TEXT = [
    'Muster Baustoffe GmbH',
    'Industriering 14, 33790 Halle',
    'Mustermann Sanitär GmbH',
    'Handwerkerweg 7',
    '10115 Berlin',
    'Halle, 08.09.2026',
    'Gutschrift Nr. MB-GS-2026-0311',
    'zur Rechnung MB-2026-5120',
    'Ruecknahme von 10 Rollen Bitumenbahn',
    'Nettobetrag -240,00 EUR',
    'Umsatzsteuer 19 % -45,60 EUR',
    'Gutschriftbetrag -285,60 EUR',
    'Der Betrag wird mit der naechsten Rechnung verrechnet.',
    'Mit freundlichen Gruessen',
    'Muster Baustoffe GmbH',
  ].join('\n');
  const sichtbar = (wert: string | undefined) => (wert ?? '').replace(/ /g, ' ');

  it('A: realer Fall — Karte, Einleitung, Bedeutung und Vorbelegung zeigen 285,60 €; nichts wird gebucht', async () => {
    const eingang = await intake(GS_TEXT, 'weiss-mb-gs');
    hydrateInboxStore([{ ...eingang, markedAsCompanyDocument: true }]);
    const item = getInboxItemById(eingang.id)!;
    expect(item.classifiedKind).toBe('gutschrift');
    /* Das Rohfeld bleibt, was die Erkennung geliefert hat. */
    expect(item.recognizedData.Betrag).toBe('240,00 EUR');

    const workflow = analyzeUploadedDocument(item.id);
    const summary = buildDocumentSummary(item, workflow ?? null, { translate: (key) => t(key, 'de') });
    const assessment = deriveIntakeAssessment({
      item,
      summary,
      ownCompanyName: PROFILE.companyName,
      hasLinkedExpense: false,
      semantic: workflow?.businessInterpretation?.semantic,
    });
    expect(assessment.role).toBe('supplier_credit');
    expect(assessment.creditTotal).toBe(285.6);
    const karte = applyIntakeAssessmentToSummary(summary, assessment);
    const betrag = karte.facts.find((fact) => fact.id === 'amount');
    expect(betrag?.labelKey).toBe('intakeAssessment.fact.creditAmount');
    expect(sichtbar(betrag?.value)).toBe('285,60 €');
    const einleitung = sichtbar(buildIntakeAssessmentLead(assessment, karte, (key) => t(key, 'de')));
    expect(einleitung).toContain('285,60 €');
    expect(einleitung).not.toContain('240,00');

    /* Netto und Steuer behalten ihre Rolle; nur der Gesamtbetrag ist die Gutschrift. */
    const rollen = Object.fromEntries((workflow?.businessInterpretation?.semantic?.amounts ?? []).map((b) => [b.value, b.role]));
    expect(rollen).toEqual({ 240: 'net_amount', 45.6: 'tax_amount', 285.6: 'credit_amount' });
    /* Die Bedeutung nennt nur den Gutschriftsbetrag als Gutschrift — keine drei „Gutschriften". */
    const bedeutung = buildDocumentMeaningView({ text: GS_TEXT }).amounts.map((row) => `${sichtbar(row.amount)} | ${row.explanation}`);
    expect(bedeutung).toEqual(['285,60 € | Gutschrift zu Ihren Gunsten. Es ist keine Zahlung von Ihnen.']);

    /* Confirm-first: „Erfassen" öffnet nur das Formular, vorbelegt mit −285,60. */
    const vorher = JSON.stringify(getAllExpenses());
    expect(createExpenseFromInbox(item)).toEqual({ ok: true, kind: 'navigate', route: formRoute(item) });
    const prefill = getExpensePrefillForInbox(item.id)!;
    expect(prefill.grossAmount).toBe(-285.6);
    expect(prefill.isCreditNote).toBe(true);
    expect(prefill.invoiceNumber).toBe('MB-GS-2026-0311');
    expect(JSON.stringify(getAllExpenses())).toBe(vorher);
    expect(getAllExpenses()).toHaveLength(0);
  });

  it('A2: gespeicherter Eingang ohne Volltext (realer Zustand) — Betrag und Vorbelegung aus dem Arbeitsstand', async () => {
    const eingang = await intake(GS_TEXT, 'weiss-mb-gs-gespeichert');
    hydrateInboxStore([{ ...eingang, markedAsCompanyDocument: true }]);
    const workflow = analyzeUploadedDocument(eingang.id);
    /* Wie nach dem Speichern: Der Posten trägt nur noch die herausgelösten Felder. */
    const gespeichert = {
      ...getInboxItemById(eingang.id)!,
      recognizedData: Object.fromEntries(
        Object.entries(getInboxItemById(eingang.id)!.recognizedData).filter(([key]) => !key.startsWith('_')),
      ),
    } as InboxItem;
    hydrateInboxStore([gespeichert]);
    const item = getInboxItemById(eingang.id)!;
    expect(item.recognizedData._extractedText).toBeUndefined();
    expect(item.recognizedData.Betrag).toBe('240,00 EUR');

    const summary = buildDocumentSummary(item, workflow ?? null, { translate: (key) => t(key, 'de') });
    const assessment = deriveIntakeAssessment({ item, summary, ownCompanyName: PROFILE.companyName, hasLinkedExpense: false });
    expect(assessment.creditTotal).toBe(285.6);
    const karte = applyIntakeAssessmentToSummary(summary, assessment);
    expect(sichtbar(karte.facts.find((fact) => fact.id === 'amount')?.value)).toBe('285,60 €');
    expect(sichtbar(buildIntakeAssessmentLead(assessment, karte, (key) => t(key, 'de')))).toContain('285,60 €');

    expect(createExpenseFromInbox(item)).toEqual({ ok: true, kind: 'navigate', route: formRoute(item) });
    const prefill = getExpensePrefillForInbox(item.id)!;
    expect(prefill.grossAmount).toBe(-285.6);
    expect(prefill.isCreditNote).toBe(true);
    expect(prefill.invoiceNumber).toBe('MB-GS-2026-0311');
    expect(getAllExpenses()).toHaveLength(0);
  });

  it('B: bestehende Gesamtlabels unverändert, „Gutschriftbetrag" neu', () => {
    const mit = (zeile: string) => resolveCreditNoteGrossTotal(`Gutschrift\nNetto 100,00 EUR\nUSt 19,00 EUR\n${zeile}`);
    expect(mit('Gutschriftsbetrag 119,00 EUR')).toBe(119);
    expect(mit('Gesamtbetrag 119,00 EUR')).toBe(119);
    expect(mit('Gutschrift brutto 119,00 EUR')).toBe(119);
    expect(mit('Bruttobetrag 119,00 EUR')).toBe(119);
    expect(mit('Gutschriftbetrag -119,00 EUR')).toBe(119);
    expect(resolveCreditNoteGrossTotal('Gutschrift\nNettobetrag -240,00 EUR\nUmsatzsteuer 19 % -45,60 EUR')).toBeNull();
  });

  it('C: Rechnungskopie auf Seite 2 macht ihren Gesamtbetrag nicht zum Gutschriftsbetrag', () => {
    const seite2 = 'Muster Baustoffe GmbH\nRechnung\nRechnungsnummer: MB-2026-5120\nGesamtbetrag 1.190,00 EUR';
    const item = itemFromClassification('weiss-anlage', `${GS_TEXT}\n${seite2}`, [
      { pageNumber: 1, text: GS_TEXT },
      { pageNumber: 2, text: seite2 },
    ]);
    const prefill = getExpensePrefillForInbox(item.id);
    expect(prefill?.grossAmount).not.toBe(-1190);
    const summary = buildDocumentSummary(item, null, { translate: (key) => t(key, 'de') });
    const assessment = deriveIntakeAssessment({ item, summary, ownCompanyName: PROFILE.companyName, hasLinkedExpense: false });
    expect(assessment.creditTotal).not.toBe(1190);
  });
});
