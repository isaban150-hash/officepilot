/**
 * EINGANG-02B — Mahnung, Lieferant und Forderungswahrheit.
 *
 * Über den echten Pfad: Aufnahme mit Seitentexten → Klassifikation → Felder →
 * semantischer Kern (Mahnstufe, Rechnungsbezug, beschriftete Forderung) →
 * vorhandener Finanzbezug (`resolveDocumentFinanceReference` über
 * `Expense.payments`) → Einschätzung und Bedeutung → „Erfassen"-Sperre →
 * Archiv → `confirmFiling` → Aufgaben.
 *
 *   - Nichts wird automatisch bezahlt, gebucht, angelegt, verknüpft oder im
 *     Status geändert. Bankabgleich gibt es in OfficeTakt noch nicht.
 *   - Prüfaufgabe nach bekanntem Stand: offen / bezahlt / Teilzahlung /
 *     unklarer Bezug / gerichtlicher Mahnbescheid.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_COMPANY_PROFILE } from './data/companyProfileDefaults';
import { t } from './i18n';
import { hydrateCompanyProfileStore } from './services/companyProfileService';
import { classifyDocument } from './services/documentClassificationService';
import { resolveDocumentFinanceReference } from './services/documentFinanceReferenceService';
import { intakeCachedDocumentFile } from './services/documentIntakeService';
import { hydrateDocumentFileStore } from './services/documentFileStoreService';
import { hydrateDocumentStore } from './services/documentService';
import { buildDocumentSummary } from './services/documentSummary';
import { resetDocumentWorkResultStoreForTests } from './services/documentWorkResultService';
import { recordExpensePayment } from './services/expensePaymentService';
import { addExpense, getAllExpenses } from './services/expenseService';
import { hydrateExpenseStore } from './services/expenseStore';
import { getInboxItemById, hydrateInboxStore, markInboxImportedToArchive } from './services/inboxService';
import { confirmFiling } from './services/inboxTaskService';
import { analyzeUploadedDocument, processUploadedDocument } from './services/intakeWorkflowService';
import { createExpenseFromInbox } from './services/officeActionService';
import { setActiveStorageScope } from './services/storage/storageScopeService';
import { createTasksFromInboxItem } from './services/taskEngineService';
import { getAllTasks } from './services/taskService';
import { hydrateTaskStore } from './services/taskStore';
import { hydrateVorgangStore } from './services/vorgangService';
import {
  buildDunningExplanation,
  deriveIntakeAssessment,
  resolveDunningMeaningNote,
} from './services/document/intakeAssessmentService';
import { readDunningSemantics } from './services/document/dunningText';
import { importInboxDocumentForTests } from './test/confirmFilingDecisionForTests';
import { useDocumentBlobDatabaseReset } from './test/documentBlobTestReset';

const OWN = 'Mustermann Sanitär GmbH';
const TO = `${OWN}\nHandwerkerweg 7\n10115 Berlin`;
const LF = `Muster Bau GmbH\nIndustriestr. 3\n20095 Hamburg\n${TO}`;
const de = (key: Parameters<typeof t>[0]) => t(key, 'de');

type Seed = { nr: string; brutto: number; bezahlt?: number; lieferant?: string; gutschrift?: boolean };

useDocumentBlobDatabaseReset();
let seq = 0;

beforeEach(() => {
  setActiveStorageScope({ type: 'guest' });
  localStorage.clear();
  resetDocumentWorkResultStoreForTests();
  hydrateInboxStore([]);
  hydrateDocumentStore([]);
  hydrateDocumentFileStore([], {});
  hydrateExpenseStore([]);
  hydrateTaskStore([]);
  hydrateCompanyProfileStore({ ...DEFAULT_COMPANY_PROFILE, companyName: OWN, street: 'Handwerkerweg 7', zip: '10115', city: 'Berlin' });
  hydrateVorgangStore([]);
});

function seed(seeds: Seed[]) {
  for (const s of seeds) {
    const res = addExpense({
      title: `Rechnung ${s.nr}`,
      category: s.gutschrift ? 'gutschrift' : 'material',
      supplierName: s.lieferant ?? 'Muster Bau GmbH',
      invoiceNumber: s.nr,
      issueDate: '2026-09-01',
      grossAmount: s.brutto,
      netAmount: s.brutto,
      taxAmount: 0,
      isCreditNote: Boolean(s.gutschrift),
      status: 'gebucht',
    } as Parameters<typeof addExpense>[0]);
    if (!res.success) throw new Error(`seed ${s.nr}`);
    if (s.bezahlt) {
      const pay = recordExpensePayment(res.expense.id, { date: '2026-10-10', amount: s.bezahlt } as Parameters<typeof recordExpensePayment>[1]);
      if (!pay.success) throw new Error(`pay ${s.nr}`);
    }
  }
}

async function durchlaufe(seeds: Seed[], pages: string[], importSource?: 'email') {
  seed(seeds);
  const ausgabenVorher = JSON.stringify(getAllExpenses());
  const recognizedText = pages.join('\n');
  const pageTexts = pages.map((text, index) => ({ pageNumber: index + 1, text }));
  const name = `e02b-${++seq}.pdf`;
  const bytes = new TextEncoder().encode(`${name}:${recognizedText}`);
  const result = await intakeCachedDocumentFile(
    { bytes, fileName: name, mimeType: 'application/pdf', fileSize: bytes.byteLength },
    {
      sourceFileName: name,
      recognizedText,
      pageTexts,
      previewClassification: classifyDocument({ sourceFileName: name, recognizedText }),
      userDecision: 'save_permanently',
      ...(importSource ? { importSource } : {}),
    } as Parameters<typeof intakeCachedDocumentFile>[1],
  );
  if (!result.success) throw new Error('intake');
  const id = result.inboxItem.id;
  hydrateInboxStore([{ ...getInboxItemById(id)!, markedAsCompanyDocument: true }]);
  processUploadedDocument(id);
  const item = getInboxItemById(id)!;
  const workflow = analyzeUploadedDocument(id);
  const semantic = workflow?.businessInterpretation?.semantic;
  const summary = buildDocumentSummary(item, workflow ?? null, { translate: de });
  const assessment = deriveIntakeAssessment({ item, summary, ownCompanyName: OWN, hasLinkedExpense: false, semantic });
  const reference = resolveDocumentFinanceReference(item);
  const meaningNote = resolveDunningMeaningNote(item, semantic, de);
  const anzahlVorher = getAllExpenses().length;
  const erfassen = createExpenseFromInbox(getInboxItemById(id)!);
  const anzahlNachher = getAllExpenses().length;
  const archived = importInboxDocumentForTests(getInboxItemById(id)!, OWN);
  if (archived.success) markInboxImportedToArchive(id, archived.document.id);
  confirmFiling(id);
  const tasks = () => getAllTasks().filter((task) => task.linkedInboxId === id);
  return {
    id,
    item,
    semantic,
    assessment,
    reference,
    meaningNote,
    erfassen,
    anzahlVorher,
    anzahlNachher,
    ausgabenVorher,
    tasks,
    ausgabenUnveraendert: () => JSON.stringify(getAllExpenses()) === ausgabenVorher,
  };
}

const mahnung = (nr: string, rest = 'Bitte zahlen Sie den Betrag bis zum 31.10.2026.') =>
  `${LF}\nMahnung\nUnsere Rechnung ${nr} vom 01.09.2026 über 1.000,00 EUR ist noch offen. ${rest}`;

function erwarteKeineBuchung(r: Awaited<ReturnType<typeof durchlaufe>>) {
  expect(r.item.classifiedKind === 'mahnung' || r.item.classifiedKind === 'zahlungserinnerung').toBe(true);
  expect(r.anzahlNachher).toBe(r.anzahlVorher);
  expect(r.erfassen.ok).toBe(true);
  expect(r.ausgabenUnveraendert()).toBe(true);
}

describe('EINGANG-02B Mahnung und Forderungswahrheit', () => {
  it('M1 offene Rechnung + Mahnung: Bezug aus „Unsere Rechnung RE-100 vom", Prüfaufgabe, keine Ausgabe', async () => {
    const r = await durchlaufe([{ nr: 'RE-100', brutto: 1000 }], [mahnung('RE-100')]);
    expect(r.reference.status).toBe('exact');
    expect(r.reference.matched?.invoiceNumber).toBe('RE-100');
    expect(r.semantic?.dunning?.stage).toBe('dunning');
    expect(r.assessment.actionNeed).toBe('check_dunning');
    expect(r.assessment.dunning?.state).toBe('open');
    expect(r.assessment.dunning?.openAmount).toBe(1000);
    expect(r.assessment.deadline?.display).toBe('31.10.2026');
    expect(r.meaningNote).toContain('RE-100');
    erwarteKeineBuchung(r);
    expect(r.tasks().map((task) => task.title)).toEqual(['Mahnung/Forderung prüfen']);
    expect(r.tasks()[0].dueDate).toBe('2026-10-31');
  });

  it('M2 bezahlte Rechnung + Mahnung: Widerspruch sichtbar, keine Zahlungsaufforderung, Zahlungen unverändert', async () => {
    const r = await durchlaufe([{ nr: 'RE-101', brutto: 1000, bezahlt: 1000 }], [mahnung('RE-101')]);
    expect(r.reference.status).toBe('paid_conflict');
    expect(r.assessment.actionNeed).toBe('check_payment_status');
    expect(r.assessment.status).toBe('pruefen');
    expect(r.assessment.dunning).toMatchObject({ state: 'paid', paidAmount: 1000, openAmount: 0 });
    expect(r.meaningNote).toMatch(/bezahlt/i);
    erwarteKeineBuchung(r);
    expect(getAllExpenses()[0].payments).toHaveLength(1);
    expect(r.tasks().map((task) => task.title)).toEqual(['Mahnung gegen Zahlungsstatus prüfen']);
  });

  it('M2b Wortlaut „Rechnung Nr." und „Re.-Nr." liefern denselben Bezug', async () => {
    const a = await durchlaufe([{ nr: 'RE-100', brutto: 1000 }], [`${LF}\nMahnung\nRechnung Nr. RE-100 über 1.000,00 EUR ist offen. Bitte zahlen Sie bis zum 31.10.2026.`]);
    expect(a.reference.status).toBe('exact');
    hydrateExpenseStore([]);
    const b = await durchlaufe([{ nr: 'RE-100', brutto: 1000 }], [`${LF}\nMahnung\nRe.-Nr. RE-100 über 1.000,00 EUR ist offen. Bitte zahlen Sie bis zum 31.10.2026.`]);
    expect(b.reference.status).toBe('exact');
  });

  it('M3 bezahlt laut OfficeTakt: Bankabgleich wird ehrlich als nicht verfügbar genannt', async () => {
    const r = await durchlaufe([{ nr: 'RE-101', brutto: 1000, bezahlt: 1000 }], [mahnung('RE-101')]);
    expect(r.assessment.dunning?.state).toBe('paid');
    expect(de('intakeAssessment.bankReconciliation.unavailable')).toBe('In OfficeTakt noch nicht verfügbar');
  });

  it('M4 Teilzahlung 400 von 1.000: Restforderung 600, nicht der volle Betrag', async () => {
    const r = await durchlaufe(
      [{ nr: 'RE-103', brutto: 1000, bezahlt: 400 }],
      [`${LF}\nMahnung\nUnsere Rechnung RE-103 über 1.000,00 EUR ist noch offen. Bitte zahlen Sie 1.000,00 EUR bis zum 31.10.2026.`],
    );
    expect(r.assessment.actionNeed).toBe('check_remaining_claim');
    expect(r.assessment.dunning).toMatchObject({ state: 'partially_paid', paidAmount: 400, openAmount: 600 });
    expect(buildDunningExplanation(r.assessment.dunning!, de)).toContain('600,00');
    erwarteKeineBuchung(r);
    expect(r.tasks().map((task) => task.title)).toEqual(['Restforderung prüfen']);
    expect(r.tasks()[0].description).toContain('Offen laut OfficeTakt: 600,00');
  });

  it('M5 Mahnkosten nur aus beschrifteter Zeile', async () => {
    const r = await durchlaufe(
      [{ nr: 'RE-102', brutto: 1000 }],
      [`${LF}\nMahnung\nRechnung RE-102 über 1.000,00 EUR\nHauptforderung 1.000,00 EUR\nMahnkosten 5,00 EUR\nGesamtforderung 1.005,00 EUR\nBitte zahlen Sie die Gesamtforderung bis zum 31.10.2026.`],
    );
    expect(r.semantic?.dunning).toMatchObject({ principalAmount: 1000, reminderFees: 5, totalClaim: 1005 });
    expect(r.assessment.dunning).toMatchObject({ state: 'open', claimAmount: 1005, openAmount: 1000 });
    erwarteKeineBuchung(r);
  });

  it('M6 Mahnkosten + Verzugszinsen werden getrennt ausgewiesen', async () => {
    const r = await durchlaufe(
      [{ nr: 'RE-102', brutto: 1000 }],
      [`${LF}\nMahnung\nRechnung RE-102 über 1.000,00 EUR\nHauptforderung 1.000,00 EUR\nMahnkosten 5,00 EUR\nVerzugszinsen 12,50 EUR\nGesamtforderung 1.017,50 EUR\nBitte zahlen Sie bis zum 31.10.2026.`],
    );
    expect(r.semantic?.dunning).toMatchObject({ principalAmount: 1000, reminderFees: 5, interestAmount: 12.5, totalClaim: 1017.5 });
    erwarteKeineBuchung(r);
  });

  it('M6b unbeschriftete Beträge erzeugen keine Aufschlüsselung', () => {
    const d = readDunningSemantics(`${LF}\nMahnung\nRechnung RE-102 über 1.000,00 EUR, dazu 5,00 EUR und 12,50 EUR.`);
    expect(d?.reminderFees).toBeUndefined();
    expect(d?.interestAmount).toBeUndefined();
    expect(d?.totalClaim).toBeUndefined();
  });

  it('M7 Zahlungserinnerung und M8 letzte Mahnung: Stufe erkannt, gleiche Prüfaufgabe', async () => {
    const m7 = await durchlaufe(
      [{ nr: 'RE-100', brutto: 1000 }],
      [`${LF}\nZahlungserinnerung\nSicher haben Sie übersehen, dass unsere Rechnung RE-100 über 1.000,00 EUR noch offen ist. Bitte überweisen Sie den Betrag bis zum 31.10.2026.`],
    );
    expect(m7.semantic?.dunning?.stage).toBe('payment_reminder');
    expect(m7.tasks().map((task) => task.title)).toEqual(['Mahnung/Forderung prüfen']);
    erwarteKeineBuchung(m7);
    hydrateExpenseStore([]);
    const m8 = await durchlaufe(
      [{ nr: 'RE-100', brutto: 1000 }],
      [`${LF}\nLetzte Mahnung\nUnsere Rechnung RE-100 über 1.000,00 EUR ist weiterhin offen. Bitte zahlen Sie bis zum 31.10.2026, sonst übergeben wir die Forderung an ein Inkassobüro.`],
    );
    expect(m8.semantic?.dunning?.stage).toBe('final_dunning');
    expect(m8.assessment.actionNeed).toBe('check_dunning');
    erwarteKeineBuchung(m8);
  });

  it('M9 mehrere Rechnungen: kein falscher Einzelbezug', async () => {
    const r = await durchlaufe(
      [{ nr: 'RE-100', brutto: 500 }, { nr: 'RE-101', brutto: 300 }, { nr: 'RE-102', brutto: 200 }],
      [`${LF}\nMahnung\nFolgende Rechnungen sind offen:\nRE-100 500,00 EUR\nRE-101 300,00 EUR\nRE-102 200,00 EUR\nGesamtbetrag 1.000,00 EUR\nBitte zahlen Sie bis zum 31.10.2026.`],
    );
    expect(r.reference.status).not.toBe('exact');
    expect(r.assessment.actionNeed).toBe('check_invoice_reference');
    expect(r.tasks().map((task) => task.title)).toEqual(['Rechnungsbezug prüfen']);
    erwarteKeineBuchung(r);
  });

  it('M10 ohne Nummer, M12 zwei mögliche Rechnungen, M13 keine Eingangsrechnung: Rechnungsbezug prüfen', async () => {
    const m10 = await durchlaufe([{ nr: 'RE-100', brutto: 1000 }], [`${LF}\nMahnung\nIhre Zahlung über 1.000,00 EUR für unsere Lieferung vom September steht noch aus. Bitte zahlen Sie bis zum 31.10.2026.`]);
    expect(m10.assessment.dunning?.state).toBe('reference_unclear');
    expect(m10.assessment.dunning?.invoiceNumber).toBeUndefined();
    erwarteKeineBuchung(m10);
    hydrateExpenseStore([]);
    const m12 = await durchlaufe(
      [{ nr: 'RE-200', brutto: 1000 }, { nr: 'RE-201', brutto: 1000 }],
      [`${LF}\nMahnung\nEine Rechnung über 1.000,00 EUR ist noch offen. Bitte zahlen Sie bis zum 31.10.2026.`],
    );
    expect(m12.assessment.actionNeed).toBe('check_invoice_reference');
    erwarteKeineBuchung(m12);
    hydrateExpenseStore([]);
    const m13 = await durchlaufe([], [mahnung('RE-999')]);
    expect(m13.reference.status).toBe('not_found');
    expect(m13.assessment.actionNeed).toBe('check_invoice_reference');
    expect(m13.tasks().map((task) => task.title)).toEqual(['Rechnungsbezug prüfen']);
    expect(getAllExpenses()).toHaveLength(0);
  });

  it('M11 gleiche Nummer, anderer Lieferant: kein Bezug, Rechnungsbezug prüfen', async () => {
    const r = await durchlaufe([{ nr: 'RE-100', brutto: 1000, lieferant: 'Andere Firma GmbH' }], [mahnung('RE-100')]);
    expect(r.reference.status).toBe('conflict');
    expect(r.assessment.dunning?.state).toBe('reference_unclear');
    expect(r.assessment.dunning?.openAmount).toBeUndefined();
    erwarteKeineBuchung(r);
  });

  it('M14 Gutschrift vorhanden: keine automatische Verrechnung, nichts geändert', async () => {
    const r = await durchlaufe([{ nr: 'RE-100', brutto: 1000 }, { nr: 'GS-100', brutto: 1000, gutschrift: true }], [mahnung('RE-100')]);
    expect(r.reference.matched?.invoiceNumber).toBe('RE-100');
    erwarteKeineBuchung(r);
    expect(getAllExpenses()).toHaveLength(2);
  });

  it('M15 Mahnung + Rechnungskopie: Frist und Forderung aus der Mahnung, nicht aus der Kopie', async () => {
    const r = await durchlaufe(
      [{ nr: 'RE-100', brutto: 1000 }],
      [
        `${LF}\nMahnung\nUnsere Rechnung RE-100 über 1.000,00 EUR ist noch offen. Mahnkosten 5,00 EUR. Bitte zahlen Sie 1.005,00 EUR bis zum 31.10.2026.\nAnlage: Rechnungskopie`,
        `Muster Bau GmbH\nRechnung\nRechnungsnummer: RE-100\nRechnungsdatum: 01.09.2026\nGesamtbetrag 1.000,00 EUR\nZahlbar bis zum 15.09.2026.`,
      ],
    );
    expect(r.item.classifiedKind).toBe('mahnung');
    expect(r.semantic?.pageScope).toBeDefined();
    expect(r.assessment.deadline?.display).toBe('31.10.2026');
    expect(r.semantic?.dunning?.reminderFees).toBe(5);
    expect(r.assessment.dunning?.claimAmount).toBe(1005);
    expect(r.tasks().map((task) => task.dueDate)).toEqual(['2026-10-31']);
    erwarteKeineBuchung(r);
  });

  it('M16 E-Mail-Anhang: gleicher Weg wie Upload', async () => {
    const r = await durchlaufe([{ nr: 'RE-100', brutto: 1000 }], [mahnung('RE-100')], 'email');
    expect(r.reference.status).toBe('exact');
    expect(r.assessment.actionNeed).toBe('check_dunning');
    expect(r.tasks().map((task) => task.title)).toEqual(['Mahnung/Forderung prüfen']);
    erwarteKeineBuchung(r);
  });

  it('J Inkasso: Stufe collection, fremder Absender ergibt keinen falschen Bezug', async () => {
    const r = await durchlaufe(
      [{ nr: 'RE-100', brutto: 1000 }],
      [`Inkasso Schmidt GmbH\nPostfach 1\n50667 Köln\n${TO}\nForderungsschreiben\nIm Auftrag der Muster Bau GmbH machen wir die Forderung aus Rechnung RE-100 über 1.000,00 EUR geltend.\nInkassokosten 70,00 EUR\nGesamtforderung 1.070,00 EUR\nBitte zahlen Sie bis zum 31.10.2026.`],
    );
    expect(r.semantic?.dunning).toMatchObject({ stage: 'collection', reminderFees: 70, totalClaim: 1070 });
    expect(r.reference.status).not.toBe('exact');
    expect(r.assessment.actionNeed).toBe('check_invoice_reference');
    erwarteKeineBuchung(r);
  });

  it('K gerichtlicher Mahnbescheid: keine Eingangsrechnung, relative Widerspruchsfrist ohne Datum', async () => {
    const r = await durchlaufe(
      [{ nr: 'RE-100', brutto: 1000 }],
      [`Amtsgericht Coburg - Zentrales Mahngericht\n${TO}\nMahnbescheid\nAntragsteller: Muster Bau GmbH\nHauptforderung Rechnung RE-100 1.000,00 EUR\nGegen den Anspruch können Sie innerhalb von zwei Wochen nach Zustellung Widerspruch einlegen.`],
    );
    expect(r.item.classifiedKind).toBe('mahnung');
    expect(r.semantic?.dunning?.stage).toBe('court_dunning');
    const widerspruch = r.semantic?.obligations?.find((o) => o.kind === 'response_due' && o.relativeDeadline);
    expect(widerspruch?.relativeDeadline).toMatch(/zwei Wochen nach Zustellung/);
    expect(widerspruch?.byWhen ?? undefined).toBeUndefined();
    expect(r.assessment.actionNeed).toBe('check_court_dunning');
    expect(r.assessment.status).toBe('pruefen');
    expect(r.assessment.deadline ?? undefined).toBeUndefined();
    erwarteKeineBuchung(r);
    const titel = r.tasks().map((task) => task.title);
    expect(titel).toContain('Mahnbescheid prüfen');
    expect(r.tasks().find((task) => task.title === 'Mahnbescheid prüfen')?.dueDate).toBeUndefined();
    expect(titel).not.toContain('Zahlung prüfen');
  });

  it('Dedupe: erneutes Ablegen und Aufgabenbildung verdoppeln nichts', async () => {
    const r = await durchlaufe([{ nr: 'RE-103', brutto: 1000, bezahlt: 400 }], [mahnung('RE-103')]);
    const vorher = r.tasks().length;
    confirmFiling(r.id);
    createTasksFromInboxItem(getInboxItemById(r.id)!);
    expect(r.tasks()).toHaveLength(vorher);
    expect(r.ausgabenUnveraendert()).toBe(true);
  });
});
