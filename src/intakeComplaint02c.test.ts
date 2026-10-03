/**
 * EINGANG-02C — Beschwerde, Reklamation, Mängelkommunikation.
 *
 * Über den echten Pfad: Aufnahme mit Seitentexten → Seitenrollen →
 * Klassifikation → Absender → semantischer Kern (`complaint`, Pflichten,
 * Fristen, Beträge) → DWR → Vorgangsbezug → Einschätzung und Bedeutung →
 * „Erfassen"-Sperre → Archiv/KI → `confirmFiling` → Aufgaben → Dedupe.
 *
 *   - Ein sicherer Beschwerdetitel macht aus einem Schreiben mit zitierter
 *     Rechnungs- oder Auftragsnummer keine Rechnung und keinen Auftrag; eine
 *     echte Rechnung mit dem Wort „Beschwerde" bleibt Rechnung.
 *   - Was der Absender meldet und fordert, bleibt seine Angabe. Nichts wird
 *     anerkannt, gebucht, gezahlt, gutgeschrieben oder versendet.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_COMPANY_PROFILE } from './data/companyProfileDefaults';
import { t } from './i18n';
import { hydrateCompanyProfileStore } from './services/companyProfileService';
import { classifyDocument } from './services/documentClassificationService';
import { intakeCachedDocumentFile } from './services/documentIntakeService';
import { hydrateDocumentFileStore } from './services/documentFileStoreService';
import { hydrateDocumentStore } from './services/documentService';
import { buildDocumentSummary } from './services/documentSummary';
import { getDocumentWorkResultForItem, resetDocumentWorkResultStoreForTests } from './services/documentWorkResultService';
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
import { getAllVorgaenge, hydrateVorgangStore } from './services/vorgangService';
import { buildDocumentAiContextFromDocument, resolveArchivedMainDocumentText } from './services/document/documentAiContextService';
import { buildDocumentMeaningView, buildDocumentMeaningViewFromCore } from './services/document/documentMeaningPresentationService';
import { buildIntakeAssessmentLead, deriveIntakeAssessment } from './services/document/intakeAssessmentService';
import { buildComplaintMeaningLines } from './services/document/complaintTruth';
import { hasComplaintTitle } from './services/document/complaintText';
import { createAbschlagInvoice, createTestVorgang } from './test/fixtures';
import { importInboxDocumentForTests } from './test/confirmFilingDecisionForTests';
import { useDocumentBlobDatabaseReset } from './test/documentBlobTestReset';

const OWN = 'Mustermann Sanitär GmbH';
const OWNHEAD = `${OWN}\nHandwerkerweg 7\n10115 Berlin`;
const KUNDE = `Ernst Flisch\nGartenweg 5\n32105 Bad Salzuflen\n${OWNHEAD}`;
const LIEF = `Muster Bau GmbH\nIndustriestr. 3\n20095 Hamburg\n${OWNHEAD}`;
const ANREDE = 'Sehr geehrte Damen und Herren,';
const de = (key: Parameters<typeof t>[0]) => t(key, 'de');
const RECHNUNGSKOPIE = `${OWNHEAD}\nRechnung\nRechnungsnummer: RE-100\nRechnungsdatum: 01.09.2026\nGesamtbetrag 10.000,00 EUR\nZahlbar bis zum 10.10.2026.`;
const GUTACHTEN = `Sachverständigenbüro Dr. Weber GmbH\nGutachten\nGutachten Nr. G-2026-55\nDatum: 05.09.2026\nSchadenshöhe geschätzt 4.800,00 EUR\nEmpfehlung: Austausch der Dachbahnen bis zum 30.11.2026.`;

useDocumentBlobDatabaseReset();
let seq = 0;

beforeEach(() => {
  setActiveStorageScope({ type: 'guest' });
  localStorage.clear();
  resetDocumentWorkResultStoreForTests();
  hydrateInboxStore([]);
  hydrateDocumentStore([]);
  hydrateDocumentFileStore([], {});
  hydrateTaskStore([]);
  hydrateCompanyProfileStore({ ...DEFAULT_COMPANY_PROFILE, companyName: OWN, street: 'Handwerkerweg 7', zip: '10115', city: 'Berlin' });
  hydrateVorgangStore([
    createTestVorgang({
      id: 'v-au',
      title: 'Bad Flisch',
      customer: 'Ernst Flisch',
      baustelle: 'Gartenweg 5',
      orderNumber: 'AU-2026-0012',
      vorgangNumber: 'VG-2026-0007',
      invoices: [createAbschlagInvoice('pos-1', 1, { number: 'RE-100', status: 'versendet' } as Parameters<typeof createAbschlagInvoice>[2])],
    } as Parameters<typeof createTestVorgang>[0]),
  ]);
  hydrateExpenseStore([]);
  addExpense({
    title: 'Rechnung LR-55',
    category: 'material',
    supplierName: 'Muster Bau GmbH',
    invoiceNumber: 'LR-55',
    issueDate: '2026-09-01',
    grossAmount: 300,
    netAmount: 300,
    taxAmount: 0,
    status: 'gebucht',
  } as Parameters<typeof addExpense>[0]);
});

const finanzStand = () => JSON.stringify({ e: getAllExpenses(), v: getAllVorgaenge().map((v) => v.invoices) });

async function durchlaufe(pages: string[], importSource?: 'email') {
  const finanzVorher = finanzStand();
  const recognizedText = pages.join('\n');
  const pageTexts = pages.map((text, index) => ({ pageNumber: index + 1, text }));
  const name = `e02c-${++seq}.pdf`;
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
  const semantic = workflow?.businessInterpretation?.semantic ?? null;
  const summary = buildDocumentSummary(item, workflow ?? null, { translate: de });
  const assessment = deriveIntakeAssessment({ item, summary, ownCompanyName: OWN, hasLinkedExpense: false, semantic });
  const meaning = semantic ? buildDocumentMeaningViewFromCore(semantic) : null;
  /* Intl setzt vor „€" ein geschütztes Leerzeichen; verglichen wird der sichtbare Text. */
  const zeilen = (meaning?.complaint ? buildComplaintMeaningLines(meaning.complaint, de) : []).map((z) =>
    z.replace(/ /g, ' '),
  );
  const anzahlVorher = getAllExpenses().length;
  const erfassen = createExpenseFromInbox(getInboxItemById(id)!);
  const anzahlNachher = getAllExpenses().length;
  const archiv = importInboxDocumentForTests(getInboxItemById(id)!, OWN);
  if (!archiv.success) throw new Error('Archiv');
  markInboxImportedToArchive(id, archiv.document.id);
  confirmFiling(id);
  const tasks = () => getAllTasks().filter((task) => task.linkedInboxId === id);
  return {
    id,
    item,
    semantic,
    dwr: getDocumentWorkResultForItem(id),
    summary,
    assessment,
    lead: buildIntakeAssessmentLead(assessment, summary, de),
    meaning,
    zeilen,
    erfassen,
    anzahlVorher,
    anzahlNachher,
    archiv: archiv.document,
    tasks,
    finanzUnveraendert: () => finanzStand() === finanzVorher,
  };
}

type Lauf = Awaited<ReturnType<typeof durchlaufe>>;
const eigenePflichten = (lauf: Lauf) =>
  (lauf.semantic?.obligations ?? []).filter((p) => p.who === 'own_company').map((p) => `${p.kind ?? '?'}@${p.byWhen ?? p.relativeDeadline ?? '-'}`);
const aufgaben = (lauf: Lauf) => lauf.tasks().map((task) => `${task.title}@${task.dueDate ?? '-'}`);
const betragsFakt = (lauf: Lauf) => lauf.summary.facts.find((fact) => fact.id === 'amount');

function erwarteSicherheit(lauf: Lauf) {
  expect(lauf.item.classifiedKind).toBe('sonstiges');
  expect(lauf.anzahlNachher).toBe(lauf.anzahlVorher);
  expect(lauf.erfassen.ok).toBe(false);
  expect(lauf.summary.primaryAction.id).not.toBe('record_expense');
  expect(lauf.summary.primaryAction.id).not.toBe('accept_contract_order');
  expect(lauf.finanzUnveraendert()).toBe(true);
  /* Keine Aufgabe, die etwas anerkennt, zahlt oder gutschreibt. */
  for (const titel of aufgaben(lauf)) expect(titel).not.toMatch(/anerkenn|zahlen|gutschrift|korrigier|storn/i);
}

describe('EINGANG-02C Beschwerde / Reklamation / Mängel', () => {
  it('C1 einfache Beschwerde ohne Frist: Beschwerde prüfen, Meldung als Angabe des Absenders', async () => {
    const r = await durchlaufe([`${KUNDE}\nBeschwerde\n${ANREDE}\nich bin mit Ihren Arbeiten unzufrieden. Der Mitarbeiter ist zweimal nicht erschienen.`]);
    erwarteSicherheit(r);
    expect(r.semantic?.complaint).toMatchObject({ type: 'complaint', direction: 'incoming' });
    expect(r.assessment.actionNeed).toBe('check_complaint');
    expect(r.assessment.kindLabelKey).toBe('intakeAssessment.kind.complaint.complaint');
    expect(r.lead).toContain('OfficeTakt bestätigt diese Angaben nicht');
    expect(r.zeilen[0]).toMatch(/^Der Absender meldet: „/);
    expect(r.zeilen.at(-1)).toBe('OfficeTakt bestätigt diese Angaben nicht und erkennt nichts an.');
    expect(r.zeilen.join(' ')).not.toMatch(/ist mangelhaft|schulden|berechtigt/i);
    /* Keine eigene Pflicht heißt nicht „nichts zu tun": nicht sicher, selbst ansehen. */
    expect(r.meaning?.actionNeed).toBe('unclear');
    expect(r.meaning?.nextStepKey).toBe('documentMeaning.next.reviewYourself');
    expect(aufgaben(r)).toEqual(['Beschwerde prüfen@-']);
    expect(r.tasks()[0].category).toBe('dokumente');
  });

  it('C2 Mängelanzeige mit absoluter Frist: Nachbesserung prüfen bis 20.10.', async () => {
    const r = await durchlaufe([`${KUNDE}\nMängelanzeige\n${ANREDE}\ndas Dach ist undicht. Bitte beseitigen Sie den Mangel bis zum 20.10.2026.`]);
    erwarteSicherheit(r);
    expect(r.item.deadline).toBe('2026-10-20');
    expect(r.assessment.actionNeed).toBe('check_remedy');
    expect(r.assessment.kindLabelKey).toBe('intakeAssessment.kind.complaint.defect_notice');
    expect(r.zeilen).toContain('Der Absender meldet: „das Dach ist undicht."');
    expect(r.zeilen).toContain('Der Absender fordert: Nachbesserung bzw. Mangelbeseitigung (bis 20.10.2026)');
    expect(aufgaben(r)).toEqual(['Nachbesserung prüfen@2026-10-20']);
  });

  it('C3 Stellungnahmefrist: Stellungnahme vorbereiten', async () => {
    const r = await durchlaufe([`${KUNDE}\nBeschwerde\n${ANREDE}\ndas Fenster schließt nicht. Bitte nehmen Sie zu unserer Beschwerde bis zum 15.10.2026 Stellung.`]);
    erwarteSicherheit(r);
    expect(r.assessment.actionNeed).toBe('prepare_statement');
    expect(aufgaben(r)).toEqual(['Stellungnahme vorbereiten@2026-10-15']);
  });

  it('C4 „Wir fordern Nachbesserung bis …" ist eine eigene Pflicht neben der Stellungnahme (P2-6)', async () => {
    const r = await durchlaufe([`${KUNDE}\nMängelrüge\n${ANREDE}\ndie Arbeiten sind unvollständig. Bitte nehmen Sie bis zum 15.10.2026 Stellung. Wir fordern Nachbesserung bis zum 31.10.2026.`]);
    erwarteSicherheit(r);
    expect(eigenePflichten(r)).toEqual(['response_due@2026-10-15', 'service_due@2026-10-31']);
    expect(aufgaben(r)).toEqual(['Stellungnahme vorbereiten@2026-10-15', 'Nachbesserung prüfen@2026-10-31']);
    expect(r.tasks().every((task) => task.category === 'dokumente')).toBe(true);
  });

  it('C5 Fotos und Aufmaß angefordert: Unterlagen über die bestehende Liste', async () => {
    const r = await durchlaufe([`${KUNDE}\nReklamation\n${ANREDE}\nes wurde falsches Material eingebaut. Bitte senden Sie uns die Fotos und das Aufmaß bis zum 20.10.2026.`]);
    erwarteSicherheit(r);
    expect(r.semantic?.requestedDocuments?.map((d) => d.label)).toEqual(['die Fotos', 'das Aufmaß']);
    expect(r.assessment.actionNeed).toBe('submit_documents');
    expect(aufgaben(r)).toEqual(['Unterlagen senden@2026-10-20']);
  });

  it('C6 Schadenersatz 3.000: Forderung des Absenders prüfen, keine Rechnung, keine Ausgabe', async () => {
    const r = await durchlaufe([`${KUNDE}\nSchadenersatzforderung\n${ANREDE}\ndurch den Wassereintritt entstand ein Schaden von 3.000,00 EUR. Wir fordern Schadenersatz in Höhe von 3.000,00 EUR bis zum 31.10.2026.`]);
    erwarteSicherheit(r);
    expect(r.semantic?.complaint?.demands).toContainEqual(expect.objectContaining({ kind: 'damages', amount: 3000, byWhen: '2026-10-31' }));
    expect(r.semantic?.amounts.some((b) => b.isClaimAgainstUs)).toBe(false);
    expect(r.assessment.actionNeed).toBe('check_claim');
    expect(betragsFakt(r)).toMatchObject({ labelKey: 'documentExperience.fact.complaintAmount' });
    expect(r.zeilen).toContain('Der Absender fordert: Schadenersatz (3.000,00 €, bis 31.10.2026)');
    expect(aufgaben(r)).toEqual(['Forderung prüfen@2026-10-31']);
  });

  it('C7 Einbehalt 2.000 zu RE-100 über 10.000: nur 2.000 ist Einbehalt (P2-5), keine Rechnung (P2-1)', async () => {
    const r = await durchlaufe([`${KUNDE}\nMängelanzeige\n${ANREDE}\nvon Ihrer Rechnung RE-100 über 10.000,00 EUR behalten wir wegen der Mängel 2.000,00 EUR ein.`]);
    erwarteSicherheit(r);
    const rollen = Object.fromEntries((r.semantic?.amounts ?? []).map((b) => [b.value, b.role]));
    expect(rollen).toEqual({ 10000: 'invoice_total', 2000: 'retention' });
    expect(r.semantic?.amounts.some((b) => b.isClaimAgainstUs)).toBe(false);
    const erklaerung = Object.fromEntries((r.meaning?.amounts ?? []).map((row) => [row.amount, row.explanation]));
    expect(erklaerung['10.000,00 €']).toBe('Rechnungsbetrag.');
    expect(erklaerung['2.000,00 €']).toMatch(/einbehalten/);
    expect(r.semantic?.complaint?.demands).toContainEqual(expect.objectContaining({ kind: 'retention', amount: 2000 }));
    expect(r.zeilen).toContain('Der Absender kündigt an: einen Einbehalt (2.000,00 €)');
    expect(r.zeilen).toContain('Genannter Bezug: Rechnung RE-100');
    expect(betragsFakt(r)?.value?.replace(/ /g, ' ')).toBe('2.000,00 €');
    expect(r.meaning?.actionNeed).toBe('unclear');
    expect(r.assessment.actionNeed).toBe('check_claim');
    expect(aufgaben(r)).toEqual(['Forderung prüfen@-']);
  });

  it('C8 Minderung: Ankündigung des Absenders, Ausgangsrechnung unverändert', async () => {
    const r = await durchlaufe([`${KUNDE}\nBeanstandung Ihrer Rechnung\n${ANREDE}\nwegen mangelhafter Leistung mindern wir die Rechnung RE-100 um 2.000,00 EUR. Die Rechnung wird wegen mangelhafter Leistung nicht vollständig bezahlt.`]);
    erwarteSicherheit(r);
    expect(r.assessment.kindLabelKey).toBe('intakeAssessment.kind.complaint.objection');
    expect(r.semantic?.complaint?.demands).toContainEqual(expect.objectContaining({ kind: 'reduction', amount: 2000 }));
    expect(r.zeilen).toContain('Der Absender kündigt an: eine Minderung (2.000,00 €)');
    expect(r.assessment.actionNeed).toBe('check_claim');
  });

  it('C9 Ersatzvornahme angekündigt, C10 Anwalt: Ankündigung sichtbar, keine Rechtsbewertung', async () => {
    const c9 = await durchlaufe([`${KUNDE}\nLetzte Frist zur Mangelbeseitigung\n${ANREDE}\nbitte beseitigen Sie den Mangel bis zum 25.10.2026. Andernfalls kündigen wir die Ersatzvornahme an und verlangen Erstattung der Reparaturkosten.`]);
    erwarteSicherheit(c9);
    expect(c9.semantic?.complaint).toMatchObject({ type: 'remedy_request', escalation: ['substitute_performance'] });
    expect(c9.zeilen).toContain('Der Absender kündigt an: eine Ersatzvornahme');
    expect(aufgaben(c9)).toEqual(['Nachbesserung prüfen@2026-10-25']);
    const c10 = await durchlaufe([`${KUNDE}\nBeschwerde\n${ANREDE}\nsollten Sie bis zum 20.10.2026 nicht reagieren, werden wir einen Anwalt einschalten und gerichtliche Schritte einleiten.`]);
    erwarteSicherheit(c10);
    expect(c10.semantic?.complaint?.escalation).toEqual(['legal_action']);
    expect(c10.item.deadline).toBe('2026-10-20');
    expect(c10.zeilen.join(' ')).not.toMatch(/berechtigt|wirksam|rechtlich erforderlich/i);
  });

  it('C11 Mängelanzeige zu Auftrag AU-2026-0012: kein Auftrag, exakter Bezug bleibt (P2-2)', async () => {
    const r = await durchlaufe([`${KUNDE}\nAuftrag AU-2026-0012 - Mängelanzeige\n${ANREDE}\ndie Dusche ist undicht. Bitte beseitigen Sie den Mangel bis zum 20.10.2026.`]);
    erwarteSicherheit(r);
    expect(r.summary.caseMatch?.matchStatus).toBe('exact');
    expect(r.summary.caseMatch?.candidates[0]?.caseId).toBe('v-au');
    expect(r.assessment.actionNeed).toBe('check_remedy');
    expect(r.zeilen).toContain('Genannter Bezug: Auftrag AU-2026-0012');
    expect(aufgaben(r)).toEqual(['Nachbesserung prüfen@2026-10-20']);
  });

  it('C12 VG-Referenz: sichere Grenze, keine falsche Zuordnung', async () => {
    const r = await durchlaufe([`${KUNDE}\nVorgang VG-2026-0007 - Beschwerde\n${ANREDE}\nder Termin wurde nicht eingehalten. Bitte nehmen Sie bis zum 20.10.2026 Stellung.`]);
    erwarteSicherheit(r);
    expect(r.summary.caseMatch?.matchStatus ?? 'none').toBe('none');
    expect(r.assessment.actionNeed).toBe('prepare_statement');
  });

  it('C13 Beschwerde zu Rechnung RE-100: keine Eingangsrechnung, kein record_expense (P2-1)', async () => {
    const r = await durchlaufe([`${KUNDE}\nBeschwerde\n${ANREDE}\nzu Ihrer Rechnung RE-100 beanstanden wir die ausgeführten Arbeiten. Die Rechnung ist zu hoch. Bitte nehmen Sie bis zum 20.10.2026 Stellung.`]);
    erwarteSicherheit(r);
    expect(r.assessment.role).toBe('other');
    expect(r.assessment.actionNeed).toBe('prepare_statement');
    expect(r.zeilen).toContain('Genannter Bezug: Rechnung RE-100');
  });

  it('C14 unbekannte Auftragsnummer: kein Bezug, kein „Auftrag annehmen"', async () => {
    const r = await durchlaufe([`${KUNDE}\nBeschwerde zu Auftrag AU-2026-9999\n${ANREDE}\ndie Leistung ist mangelhaft. Bitte nehmen Sie bis zum 20.10.2026 Stellung.`]);
    erwarteSicherheit(r);
    expect(r.summary.caseMatch?.matchStatus ?? 'none').toBe('none');
    expect(aufgaben(r)).toEqual(['Stellungnahme vorbereiten@2026-10-20']);
  });

  it('C15 Zusage des Lieferanten „Wir melden uns bis …" ist keine eigene Frist (P2-7)', async () => {
    const r = await durchlaufe([`${LIEF}\nIhre Reklamation vom 01.10.2026\n${ANREDE}\nzu Ihrer Reklamation teilen wir mit, dass wir die Ware prüfen. Wir melden uns bis zum 20.10.2026.`]);
    expect(r.item.sender).toBe('Muster Bau GmbH');
    expect(r.item.deadline ?? null).toBeNull();
    expect(eigenePflichten(r)).toEqual([]);
    expect(r.semantic?.deadlines.filter((f) => f.actionRequired)).toEqual([]);
    expect(r.assessment.actionNeed).not.toBe('reply');
    expect(aufgaben(r)).toEqual([]);
    expect(r.finanzUnveraendert()).toBe(true);
  });

  it('C16 eigenes Reklamationsschreiben: keine Eingangsrechnung, keine eigene Pflicht, keine Gutschrift-Wahrheit (P2-8)', async () => {
    const r = await durchlaufe([`${OWNHEAD}\nMuster Bau GmbH\nIndustriestr. 3\n20095 Hamburg\nReklamation\n${ANREDE}\nhiermit reklamieren wir Ihre Rechnung LR-55. Bitte senden Sie uns bis zum 20.10.2026 eine Gutschrift über 300,00 EUR.`]);
    erwarteSicherheit(r);
    expect(r.item.sender).toBe(OWN);
    expect(r.semantic?.complaint?.direction).toBe('outgoing');
    expect(eigenePflichten(r)).toEqual([]);
    expect(r.item.deadline ?? null).toBeNull();
    expect(r.semantic?.amounts.map((b) => b.role)).not.toContain('credit_amount');
    expect(r.assessment.actionNeed).toBe('none');
    expect(r.assessment.kindLabelKey).toBe('intakeAssessment.kind.complaint.outgoing');
    expect(r.zeilen).toEqual([de('documentMeaning.complaint.outgoing')]);
    expect(r.meaning?.actionNeed).toBe('no');
    expect(aufgaben(r)).toEqual([]);
  });

  it('C17 Beschwerde + Rechnungskopie: Frist 20.10. statt 10.10., keine Ausgabe (P2-3, Finanzsicherheit)', async () => {
    const r = await durchlaufe([
      `${KUNDE}\nBeschwerde\n${ANREDE}\nzu Ihrer Rechnung RE-100 beanstanden wir die Leistung. Bitte nehmen Sie bis zum 20.10.2026 Stellung.\nAnlage: Rechnungskopie`,
      RECHNUNGSKOPIE,
    ]);
    erwarteSicherheit(r);
    expect(r.semantic?.pageScope).toMatchObject({ mainPageNumbers: [1], attachmentPageNumbers: [2] });
    expect(r.item.deadline).toBe('2026-10-20');
    expect(r.semantic?.deadlines.map((f) => f.date)).not.toContain('2026-10-10');
    expect(r.semantic?.amounts.map((b) => b.value)).not.toContain(10000);
    expect(r.item.recognizedData.Rechnungsnummer).toBeUndefined();
    expect(r.semantic?.accounting.relevance).not.toBe('booking_candidate');
    expect(aufgaben(r)).toEqual(['Stellungnahme vorbereiten@2026-10-20']);
  });

  it('C18 Beschwerde + Gutachten: Gutachten sicher als Anlage abgegrenzt', async () => {
    const r = await durchlaufe([
      `${KUNDE}\nBeschwerde\n${ANREDE}\ndas Dach ist undicht. Bitte nehmen Sie bis zum 20.10.2026 Stellung.\nAnlage: Gutachten`,
      GUTACHTEN,
    ]);
    erwarteSicherheit(r);
    expect(r.semantic?.pageScope).toMatchObject({ mainPageNumbers: [1], attachmentPageNumbers: [2] });
    expect(r.semantic?.deadlines.map((f) => f.date)).toEqual(['2026-10-20']);
    expect(r.semantic?.amounts).toEqual([]);
    expect(eigenePflichten(r)).toEqual(['response_due@2026-10-20']);
  });

  it('C19 mehrere Pflichten: Stellungnahme 15.10., Mangelbeseitigung 31.10., Fotos ohne Datum (P2-6)', async () => {
    const r = await durchlaufe([`${KUNDE}\nMängelanzeige\n${ANREDE}\nbitte nehmen Sie bis zum 15.10.2026 Stellung und beseitigen Sie den Mangel bis zum 31.10.2026. Bitte senden Sie uns anschließend Fotos.`]);
    erwarteSicherheit(r);
    expect(eigenePflichten(r)).toEqual(['response_due@2026-10-15', 'service_due@2026-10-31', 'document_submission_due@-']);
    expect(r.semantic?.deadlines.map((f) => `${f.type}@${f.date}`)).toEqual(['response_due@2026-10-15', 'service_due@2026-10-31']);
    expect(aufgaben(r)).toEqual(['Stellungnahme vorbereiten@2026-10-15', 'Nachbesserung prüfen@2026-10-31', 'Unterlagen senden@-']);
  });

  it('C20 Beschwerde als E-Mail-Anhang: gleicher Pfad wie Upload', async () => {
    const upload = await durchlaufe([`${KUNDE}\nMängelanzeige\n${ANREDE}\ndas Dach ist undicht. Bitte beseitigen Sie den Mangel bis zum 20.10.2026.`]);
    const mail = await durchlaufe([`${KUNDE}\nMängelanzeige\n${ANREDE}\ndas Dach ist undicht. Bitte beseitigen Sie den Mangel bis zum 20.10.2026.`], 'email');
    erwarteSicherheit(mail);
    expect(mail.semantic?.complaint).toEqual(upload.semantic?.complaint);
    expect(mail.assessment.actionNeed).toBe(upload.assessment.actionNeed);
    expect(aufgaben(mail)).toEqual(aufgaben(upload));
  });

  it('C21 reine Geldforderung ohne Rechnung: Forderung prüfen, keine Verbindlichkeit', async () => {
    const r = await durchlaufe([`${KUNDE}\nForderung\n${ANREDE}\nwir fordern 3.000,00 EUR Schadenersatz. Bitte überweisen Sie den Betrag bis zum 31.10.2026.`]);
    erwarteSicherheit(r);
    expect(r.semantic?.complaint?.type).toBe('damage_claim');
    expect(r.semantic?.amounts.some((b) => b.isClaimAgainstUs)).toBe(false);
    expect(r.assessment.actionNeed).toBe('check_claim');
    expect(r.lead).toContain('OfficeTakt bestätigt diese Angaben nicht');
    expect(aufgaben(r)).toEqual(['Forderung prüfen@2026-10-31']);
  });

  it('C22 echte Rechnung mit beiläufigem Wort „Beschwerde" bleibt Eingangsrechnung', async () => {
    const r = await durchlaufe([
      `Muster Bau GmbH\nIndustriestr. 3\n20095 Hamburg\n${OWNHEAD}\nRechnung\nRechnungsnummer: LR-77\nRechnungsdatum: 01.10.2026\nPos 1 Beseitigung Beschwerde Nachbar Zaun 500,00 EUR\nNettobetrag 500,00 EUR\nMwSt 95,00 EUR\nGesamtbetrag 595,00 EUR\nZahlbar bis zum 31.10.2026.`,
    ]);
    expect(r.item.classifiedKind).toBe('eingangsrechnung');
    expect(r.semantic?.complaint).toBeUndefined();
    expect(r.assessment.role).toBe('invoice');
  });

  it('C23 Mängelprotokoll bleibt Mängelprotokoll', async () => {
    const r = await durchlaufe([`${KUNDE}\nMängelprotokoll\nAbnahme vom 01.10.2026\n1. Silikonfuge Bad undicht\n2. Fliese gesprungen\nDie Mängel sind bis zum 30.10.2026 zu beseitigen.`]);
    expect(r.item.classifiedKind).toBe('maengelprotokoll');
    expect(r.assessment.complaint).toBeUndefined();
    expect(r.item.deadline).toBe('2026-10-30');
    expect(r.finanzUnveraendert()).toBe(true);
  });

  it('C24 Dedupe: erneutes Ablegen und Aufgabenbildung verdoppeln nichts', async () => {
    /* Je Lauf direkt danach prüfen: der nächste Lauf ersetzt den Eingangsbestand. */
    for (const text of [
      `${KUNDE}\nMängelanzeige\n${ANREDE}\nbitte nehmen Sie bis zum 15.10.2026 Stellung und beseitigen Sie den Mangel bis zum 31.10.2026. Bitte senden Sie uns anschließend Fotos.`,
      `${KUNDE}\nBeschwerde\n${ANREDE}\nich bin mit Ihren Arbeiten unzufrieden.`,
    ]) {
      const lauf = await durchlaufe([text]);
      const vorher = aufgaben(lauf);
      expect(vorher.length).toBeGreaterThan(0);
      confirmFiling(lauf.id);
      createTasksFromInboxItem(getInboxItemById(lauf.id)!);
      expect(aufgaben(lauf)).toEqual(vorher);
    }
  });

  it('F/R: Forderungsformen und relative Fristen ohne erfundenes Datum', async () => {
    const f5 = await durchlaufe([`${KUNDE}\nBeschwerde\n${ANREDE}\nwir fordern 3.000,00 EUR Schadenersatz.`]);
    expect(f5.semantic?.complaint?.demands).toContainEqual(expect.objectContaining({ kind: 'damages', amount: 3000 }));
    const f8 = await durchlaufe([`${KUNDE}\nBeschwerde\n${ANREDE}\nwir verlangen Erstattung der Reparaturkosten.`]);
    expect(f8.semantic?.complaint?.demands.map((d) => d.kind)).toEqual(['reimbursement']);
    const f10 = await durchlaufe([`${KUNDE}\nBeschwerde\n${ANREDE}\nwir werden einen Anwalt einschalten.`]);
    expect(eigenePflichten(f10)).toEqual([]);
    expect(f10.assessment.actionNeed).toBe('check_complaint');
    const r1 = await durchlaufe([`${KUNDE}\nMängelanzeige\n${ANREDE}\nbitte beseitigen Sie den Mangel binnen zwei Wochen.`]);
    expect(eigenePflichten(r1)).toEqual(['service_due@binnen zwei Wochen']);
    expect(r1.item.deadline ?? null).toBeNull();
    expect(r1.assessment.openDeadline).toEqual({ phrase: 'binnen zwei Wochen' });
    expect(aufgaben(r1)).toEqual(['Nachbesserung prüfen@-']);
  });

  it('S1/S2/S4 Privatperson: nie die eigene Firma als Absender (P2-4); S3 GmbH-Kunde bleibt erkannt', async () => {
    const text = `Mängelanzeige\n${ANREDE}\ndas Dach ist undicht. Bitte beseitigen Sie den Mangel bis zum 20.10.2026.`;
    for (const kopf of [
      `Ernst Flisch\nGartenweg 5\n32105 Bad Salzuflen\n${OWNHEAD}`,
      `Herr Ernst Flisch\nGartenweg 5\n32105 Bad Salzuflen\n${OWNHEAD}`,
      `Ernst Flisch, Gartenweg 5, 32105 Bad Salzuflen\n${OWNHEAD}`,
    ]) {
      const r = await durchlaufe([`${kopf}\n${text}`]);
      expect(r.item.sender).not.toBe(OWN);
      expect(r.assessment.sender).toBeUndefined();
      expect(r.item.recognizedData.Absender ?? '').not.toBe(OWN);
    }
    const gmbh = await durchlaufe([`Flisch Immobilien GmbH\nGartenweg 5\n32105 Bad Salzuflen\n${OWNHEAD}\n${text}`]);
    expect(gmbh.item.sender).toBe('Flisch Immobilien GmbH');
  });

  it('Archiv/DWR/KI: dieselbe Beschwerdewahrheit wie im Eingang, ohne Anlage', async () => {
    const r = await durchlaufe([
      `${KUNDE}\nBeschwerde\n${ANREDE}\nzu Ihrer Rechnung RE-100 beanstanden wir die Leistung. Bitte nehmen Sie bis zum 20.10.2026 Stellung.\nAnlage: Rechnungskopie`,
      RECHNUNGSKOPIE,
    ]);
    expect(r.dwr?.businessInterpretation?.semantic?.complaint).toEqual(r.semantic?.complaint);
    expect(JSON.parse(JSON.stringify(r.dwr)).businessInterpretation.semantic.complaint).toEqual(r.semantic?.complaint);
    const archivText = resolveArchivedMainDocumentText(r.archiv);
    expect(archivText).not.toContain('10.10.2026');
    expect(buildDocumentMeaningView({ text: archivText ?? '' }).complaint).toEqual(r.semantic?.complaint);
    expect(buildDocumentAiContextFromDocument(r.archiv).semantic?.complaint).toEqual(r.semantic?.complaint);
  });

  /*
   * Nacharbeit 1 / N1 — die Zusage der Gegenseite verschluckt keine
   * mitgeteilte Pflicht des Empfängers (02A-2A bleibt erhalten).
   */
  it('N1 K9/K10/K11: mitgeteilte Empfängerpflicht bleibt Frist; C15-Zusage bleibt keine', async () => {
    const ST = `Stadt Musterstadt - Bauordnungsamt\n${OWNHEAD}\nAktenzeichen: BA-2026-123`;
    const FA = `Finanzamt Musterstadt\n${OWNHEAD}\nSteuernummer 12/345/67890`;
    const VS = `Allianz Versicherungs-AG\n${OWNHEAD}\nSchadennummer: S-2026-0077`;
    const k9 = await durchlaufe([`${ST}\nAnhörung\n${ANREDE}\nwir beabsichtigen, ein Bußgeld festzusetzen. Wir geben Ihnen Gelegenheit, sich bis zum 20.10.2026 zu äußern.`]);
    expect(k9.item.classifiedKind).toBe('ordnungsamt');
    expect(k9.item.deadline).toBe('2026-10-20');
    expect(k9.item.deadlineType).toBe('response_due');
    expect(k9.assessment.actionNeed).toBe('reply');
    const k10 = await durchlaufe([`${FA}\nFestsetzung\n${ANREDE}\nwir teilen Ihnen mit, dass der Betrag von 120,00 EUR bis zum 15.11.2026 zu zahlen ist.`]);
    expect(k10.item.deadline).toBe('2026-11-15');
    expect(k10.item.deadlineType).toBe('payment_due');
    const k11 = await durchlaufe([`${VS}\nSchadenmeldung\n${ANREDE}\nwir informieren Sie, dass die Unterlagen bis zum 30.10.2026 einzureichen sind.`]);
    expect(k11.item.deadline).toBe('2026-10-30');
    expect(k11.item.deadlineType).toBe('document_submission_due');
    const c15 = await durchlaufe([`${LIEF}\nIhre Reklamation vom 01.10.2026\n${ANREDE}\nzu Ihrer Reklamation teilen wir mit, dass wir die Ware prüfen. Wir melden uns bis zum 20.10.2026.`]);
    expect(c15.item.deadline ?? null).toBeNull();
    expect(eigenePflichten(c15)).toEqual([]);
    expect(aufgaben(c15)).toEqual([]);
  });

  /*
   * Nacharbeit 1 / N2 — ein Behörden- oder Versicherungsbriefkopf (02A-1) hat
   * Vorrang vor dem Beschwerdetitel; keine Beschwerde gegen uns daraus.
   */
  it('N2 L1–L4: Behörden-/Versicherungsart bleibt, keine Beschwerde gegen uns', async () => {
    const ST = `Stadt Musterstadt - Bauordnungsamt\n${OWNHEAD}\nAktenzeichen: BA-2026-123`;
    const FA = `Finanzamt Musterstadt\n${OWNHEAD}\nSteuernummer 12/345/67890`;
    const VS = `Allianz Versicherungs-AG\n${OWNHEAD}\nSchadennummer: S-2026-0077`;
    const faelle: Array<[string, string, string]> = [
      ['L1', `${ST}\nBeanstandung\n${ANREDE}\nbei der Kontrolle wurde die Baustellenabsicherung beanstandet. Bitte nehmen Sie bis zum 20.10.2026 Stellung.`, 'ordnungsamt'],
      ['L2', `${VS}\nReklamation\n${ANREDE}\nIhre Reklamation haben wir erhalten. Bitte reichen Sie bis zum 20.10.2026 Fotos ein.`, 'versicherung'],
      ['L3', `${ST}\nMängelanzeige\n${ANREDE}\nan der Baustelle wurden Mängel festgestellt. Bitte beseitigen Sie diese bis zum 20.10.2026.`, 'ordnungsamt'],
      ['L4', `${FA}\nBeschwerde\n${ANREDE}\nIhre Beschwerde vom 01.10.2026 ist eingegangen. Wir prüfen den Vorgang.`, 'finanzamt'],
    ];
    for (const [id, text, art] of faelle) {
      const r = await durchlaufe([text]);
      expect(r.item.classifiedKind, id).toBe(art);
      expect(r.semantic?.complaint, id).toBeUndefined();
      expect(r.assessment.complaint, id).toBeUndefined();
      expect(r.zeilen, id).toEqual([]);
      for (const task of r.tasks()) {
        expect(task.title, id).not.toBe('Beschwerde prüfen');
        /* Die bestehenden institutionellen Wege (Vorlage der Art bzw. Behördenprüfung), keine 02C-Aufgabe. */
        expect(task.taskKind, id).toMatch(/^(?:inbox_template:|authority_review:)/);
      }
      expect(r.finanzUnveraendert(), id).toBe(true);
    }
  });

  it('Titelregel: nur eine eigene Kopfzeile, nie ein Wort im Fliesstext', () => {
    expect(hasComplaintTitle(`${KUNDE}\nMängelanzeige\n${ANREDE}\n…`)).toBe(true);
    expect(hasComplaintTitle(`${LIEF}\nIhre Reklamation vom 01.10.2026\n${ANREDE}\n…`)).toBe(false);
    expect(hasComplaintTitle(`${LIEF}\nRechnung\nPos 1 Beseitigung Beschwerde Nachbar Zaun 500,00 EUR`)).toBe(false);
    expect(hasComplaintTitle(`${KUNDE}\n${ANREDE}\nIch möchte eine Beschwerde einreichen.`)).toBe(false);
  });
});
