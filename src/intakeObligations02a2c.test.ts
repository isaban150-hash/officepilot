/**
 * EINGANG-02A-2C — mehrere Pflichten, Aktionsvorschläge und Unterlagenlisten.
 *
 * Über den echten Pfad: Aufnahme → Analyse → semantischer Kern → DWR →
 * Einschätzung und Bedeutung → Vorschläge → Archiv → `confirmFiling` →
 * tatsächlich angelegte Aufgaben.
 *
 *   - Ausdrücklich angeforderte Unterlagen bleiben als Liste im Wortlaut.
 *   - Mehrere eigene Pflichten werden zu mehreren unterscheidbaren
 *     Vorschlägen — je Pflicht das eigene Datum, nie die Hauptfrist für alle.
 *   - Relative und undatierte Pflichten bekommen kein erfundenes Datum.
 *   - Wiederholtes Ablegen legt keine zweiten Aufgaben an.
 *   - Nichts wird gezahlt, gebucht oder versendet.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_COMPANY_PROFILE } from './data/companyProfileDefaults';
import { t } from './i18n';
import { getCompanyProfile, hydrateCompanyProfileStore } from './services/companyProfileService';
import { classifyDocument } from './services/documentClassificationService';
import { intakeCachedDocumentFile } from './services/documentIntakeService';
import { hydrateDocumentFileStore } from './services/documentFileStoreService';
import { hydrateDocumentStore } from './services/documentService';
import { buildDocumentSummary } from './services/documentSummary';
import { getDocumentWorkResultForItem, resetDocumentWorkResultStoreForTests } from './services/documentWorkResultService';
import { getAllExpenses } from './services/expenseService';
import { hydrateExpenseStore } from './services/expenseStore';
import { getInboxItemById, hydrateInboxStore, markInboxImportedToArchive } from './services/inboxService';
import { confirmFiling, createTaskForItem } from './services/inboxTaskService';
import { analyzeUploadedDocument, processUploadedDocument } from './services/intakeWorkflowService';
import { setActiveStorageScope } from './services/storage/storageScopeService';
import { proposeInboxTasks } from './services/taskEngineService';
import { getAllTasks } from './services/taskService';
import { hydrateTaskStore } from './services/taskStore';
import { hydrateVorgangStore } from './services/vorgangService';
import { buildDocumentMeaningViewFromCore } from './services/document/documentMeaningPresentationService';
import { deriveIntakeAssessment } from './services/document/intakeAssessmentService';
import { importInboxDocumentForTests } from './test/confirmFilingDecisionForTests';
import { useDocumentBlobDatabaseReset } from './test/documentBlobTestReset';

const OWN = 'Mustermann Sanitär GmbH';
const TO = `${OWN}\nHandwerkerweg 7\n10115 Berlin`;
const AZ = `Allianz Versicherungs-AG\nSchadennummer: S-2026-0077\n${TO}`;
const ST = `Stadt Musterstadt - Bauordnungsamt\nAktenzeichen: BA-2026-123\n${TO}`;

const M1 = `${ST}\nBitte nehmen Sie bis zum 20.10.2026 Stellung.\nReichen Sie die angeforderten Unterlagen bis zum 25.10.2026 ein:\n- Rechnung\n- Fotos\n- Reparaturbericht\nDie Gebühr von 75 EUR ist bis zum 31.10.2026 zu zahlen.`;

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

async function durchlaufe(recognizedText: string) {
  const name = `e02a2c-${++seq}.pdf`;
  const bytes = new TextEncoder().encode(`${name}:${recognizedText}`);
  const result = await intakeCachedDocumentFile(
    { bytes, fileName: name, mimeType: 'application/pdf', fileSize: bytes.byteLength },
    {
      sourceFileName: name,
      recognizedText,
      previewClassification: classifyDocument({ sourceFileName: name, recognizedText }),
      userDecision: 'save_permanently',
    },
  );
  const id = result.inboxItem!.id;
  hydrateInboxStore([{ ...getInboxItemById(id)!, markedAsCompanyDocument: true }]);
  processUploadedDocument(id);
  const item = getInboxItemById(id)!;
  const workflow = analyzeUploadedDocument(id)!;
  const semantic = workflow.businessInterpretation?.semantic ?? null;
  const summary = buildDocumentSummary(item, workflow, { translate: (key) => t(key, 'de') });
  const assessment = deriveIntakeAssessment({
    item,
    summary,
    ownCompanyName: OWN,
    hasLinkedExpense: false,
    needsKindReview: Boolean(workflow.classification?.needsKindReview),
    semantic,
  });
  const meaning = semantic ? buildDocumentMeaningViewFromCore(semantic) : null;
  let archiviert = false;
  const ablegen = () => {
    // Wie der Ablagefluss: einmal ins Archiv übernehmen, dann Ablage bestätigen.
    if (!archiviert) {
      const archiv = importInboxDocumentForTests(getInboxItemById(id)!, OWN);
      expect(archiv.success).toBe(true);
      if (archiv.success) markInboxImportedToArchive(id, archiv.document.id);
      archiviert = true;
    }
    const filing = confirmFiling(id);
    expect(filing?.success).toBe(true);
    return aufgaben(id);
  };
  return { id, item, workflow, semantic, assessment, meaning, ablegen };
}

const aufgaben = (id: string) =>
  getAllTasks()
    .filter((task) => task.linkedInboxId === id)
    .map((task) => `${task.title}@${task.dueDate ?? '-'}`)
    .sort();

const eigenePflichten = (semantic: { obligations: Array<{ who: string; kind?: string; byWhen?: string }> } | null) =>
  (semantic?.obligations ?? []).filter((o) => o.who === 'own_company').map((o) => `${o.kind ?? '?'}@${o.byWhen ?? '-'}`);

const unterlagen = (semantic: { requestedDocuments?: Array<{ label: string }> } | null) =>
  (semantic?.requestedDocuments ?? []).map((d) => d.label);

describe('02A-2C — M1 drei Pflichten mit Unterlagenliste', () => {
  it('drei Pflichten, Liste, Hauptfrist 20.10., drei Aufgaben mit je eigenem Datum', async () => {
    const run = await durchlaufe(M1);
    expect(eigenePflichten(run.semantic)).toEqual([
      'response_due@2026-10-20',
      'document_submission_due@2026-10-25',
      'payment_due@2026-10-31',
    ]);
    // Die Liste gehört zur Einreichpflicht — genau die genannten Unterlagen.
    expect(run.semantic!.requestedDocuments).toEqual([
      expect.objectContaining({ label: 'Rechnung', obligationIndex: 1 }),
      expect.objectContaining({ label: 'Fotos', obligationIndex: 1 }),
      expect.objectContaining({ label: 'Reparaturbericht', obligationIndex: 1 }),
    ]);
    // Die Hauptfrist bleibt die früheste kanonische Handlungsfrist.
    expect(run.item.deadline).toBe('2026-10-20');
    expect(run.item.deadlineType).toBe('response_due');
    expect(run.assessment.deadline?.date).toBe('2026-10-20');
    // Sichtbar: drei Pflichten, die Unterlagen stehen bei der Einreichpflicht.
    expect(run.meaning!.obligations).toHaveLength(3);
    expect(run.meaning!.obligations[1].text).toContain('Rechnung, Fotos, Reparaturbericht');
    // Drei unterscheidbare Vorschläge — auch in der Vorschlagsliste der Analyse.
    const vorschlaege = proposeInboxTasks(run.item, getCompanyProfile(), { autoCreated: true });
    expect(vorschlaege.map((p) => `${p.title}@${p.dueDate ?? '-'}`)).toEqual([
      'Stellungnahme abgeben@2026-10-20',
      'Unterlagen einreichen@2026-10-25',
      'Zahlung prüfen@2026-10-31',
    ]);
    expect(vorschlaege[1].description).toContain('Unterlagen: Rechnung, Fotos, Reparaturbericht');
    expect(run.workflow.suggestedTasks.map((p) => p.title)).toEqual([
      'Stellungnahme abgeben',
      'Unterlagen einreichen',
      'Zahlung prüfen',
    ]);
    // Operativ: die Ablage legt genau diese drei Aufgaben an. Nichts gezahlt oder gebucht.
    expect(run.ablegen()).toEqual([
      'Stellungnahme abgeben@2026-10-20',
      'Unterlagen einreichen@2026-10-25',
      'Zahlung prüfen@2026-10-31',
    ]);
    expect(getAllExpenses()).toEqual([]);
  });

  it('M7 Idempotenz: zweimal ablegen und manuell anlegen — weiterhin genau drei Aufgaben', async () => {
    const run = await durchlaufe(M1);
    expect(run.ablegen()).toHaveLength(3);
    expect(run.ablegen()).toHaveLength(3);
    createTaskForItem(run.id);
    expect(aufgaben(run.id)).toEqual([
      'Stellungnahme abgeben@2026-10-20',
      'Unterlagen einreichen@2026-10-25',
      'Zahlung prüfen@2026-10-31',
    ]);
  });

  it('Persistenz: drei Pflichten und die Unterlagenliste im DWR, JSON-Rundreise', async () => {
    const run = await durchlaufe(M1);
    const gespeichert = getDocumentWorkResultForItem(run.id);
    const kern = JSON.parse(JSON.stringify(gespeichert)).businessInterpretation.semantic;
    expect(eigenePflichten(kern)).toHaveLength(3);
    expect(unterlagen(kern)).toEqual(['Rechnung', 'Fotos', 'Reparaturbericht']);
    expect(kern.primaryActionDeadline.date).toBe('2026-10-20');
  });
});

describe('02A-2C — Unterlagenlisten', () => {
  it('A „folgende Unterlagen ein:" mit Spiegelstrichen', async () => {
    const run = await durchlaufe(`${AZ}\nBitte reichen Sie bis zum 25.10.2026 folgende Unterlagen ein:\n- Rechnung\n- Fotos\n- Reparaturbericht`);
    expect(eigenePflichten(run.semantic)).toEqual(['document_submission_due@2026-10-25']);
    expect(unterlagen(run.semantic)).toEqual(['Rechnung', 'Fotos', 'Reparaturbericht']);
  });

  it('M2 „Wir benötigen:" mit Nummern — eine Einreichpflicht ohne Datum, ein Vorschlag', async () => {
    const run = await durchlaufe(`${AZ}\nWir benötigen:\n1. Kostenvoranschlag\n2. Fotos\n3. Versicherungsnachweis`);
    expect(eigenePflichten(run.semantic)).toEqual(['document_submission_due@-']);
    expect(unterlagen(run.semantic)).toEqual(['Kostenvoranschlag', 'Fotos', 'Versicherungsnachweis']);
    expect(run.item.deadline ?? null).toBeNull();
    expect(run.meaning!.actionNeed).toBe('yes');
    expect(run.assessment.actionNeed).toBe('submit_documents');
    expect(run.assessment.status).toBe('pruefen');
    const angelegt = run.ablegen();
    expect(angelegt).toHaveLength(1);
    expect(angelegt[0].endsWith('@-')).toBe(true);
  });

  it('M3 Inline-Liste „Rechnung, Fotos und Reparaturbericht" — ein Vorschlag ohne Datum', async () => {
    const run = await durchlaufe(`${AZ}\nBitte senden Sie uns Rechnung, Fotos und Reparaturbericht.`);
    expect(eigenePflichten(run.semantic)).toEqual(['document_submission_due@-']);
    expect(unterlagen(run.semantic)).toEqual(['Rechnung', 'Fotos', 'Reparaturbericht']);
    const angelegt = run.ablegen();
    expect(angelegt).toHaveLength(1);
    expect(angelegt[0].endsWith('@-')).toBe(true);
  });

  it.each([
    ['M6 Schadenspositionen', `${AZ}\nDer Schaden umfasst:\n- Dach\n- Fenster\n- Fassade`],
    ['Beträge', `${AZ}\nFolgende Unterlagen haben wir erstattet:\n- Rechnung 1.250,00 EUR\n- Gutachten 300,00 EUR`],
    ['Ansprechpartner', `${AZ}\nBei Fragen zu den Unterlagen erreichen Sie:\n- Frau Müller, Tel. 030 123456\n- Herr Schmidt`],
    ['eine einzelne Unterlage ist keine Liste', `${AZ}\nBitte senden Sie uns die Unterlagen.`],
  ])('keine Unterlagenliste: %s', async (_label, text) => {
    const run = await durchlaufe(text);
    expect(run.semantic!.requestedDocuments).toBeUndefined();
  });
});

describe('02A-2C — relative, gemischte und informierende Schreiben', () => {
  it('M4 zwei relative Pflichten: zwei Vorschläge, kein Datum, Wortlaut erhalten', async () => {
    const run = await durchlaufe(`${AZ}\nBitte nehmen Sie innerhalb von zwei Wochen nach Zugang Stellung.\nBitte reichen Sie die Fotos unverzüglich ein.`);
    expect(eigenePflichten(run.semantic)).toEqual(['response_due@-', 'document_submission_due@-']);
    expect(run.semantic!.relativeDeadlines?.map((r) => r.phrase)).toEqual(['innerhalb von zwei Wochen nach Zugang', 'unverzüglich']);
    expect(run.item.deadline ?? null).toBeNull();
    const vorschlaege = proposeInboxTasks(run.item, getCompanyProfile(), { autoCreated: true });
    expect(vorschlaege.map((p) => p.title)).toEqual(['Stellungnahme abgeben', 'Unterlagen einreichen']);
    expect(vorschlaege.every((p) => !p.dueDate)).toBe(true);
    expect(vorschlaege[0].description).toContain('innerhalb von zwei Wochen nach Zugang – Datum nicht berechnet');
    expect(run.ablegen()).toEqual(['Stellungnahme abgeben@-', 'Unterlagen einreichen@-']);
  });

  it('gemischt: Information unterdrückt die zwei echten Pflichten nicht', async () => {
    const run = await durchlaufe(
      `${AZ}\nZu Ihrer Information wurde der Schaden aufgenommen.\nBitte nehmen Sie bis 20.10.2026 Stellung.\nBitte reichen Sie bis 25.10.2026 Fotos und Kostenvoranschlag ein.`,
    );
    expect(run.semantic!.informationOnly).toBeUndefined();
    expect(unterlagen(run.semantic)).toEqual(['Fotos', 'Kostenvoranschlag']);
    expect(run.ablegen()).toEqual(['Stellungnahme abgeben@2026-10-20', 'Unterlagen einreichen@2026-10-25']);
  });

  it('M5 reine Information: keine Pflicht, keine Liste, keine Aufgabe', async () => {
    const run = await durchlaufe(`${AZ}\nWir bestätigen den Eingang Ihrer Unterlagen. Von Ihnen ist derzeit nichts weiter zu veranlassen.`);
    expect(eigenePflichten(run.semantic)).toEqual([]);
    expect(run.semantic!.requestedDocuments).toBeUndefined();
    expect(run.semantic!.informationOnly).toBeDefined();
    expect(run.ablegen()).toEqual([]);
  });

  it('eine einzige Pflicht bleibt beim bisherigen einzelnen Vorschlag', async () => {
    const run = await durchlaufe(`${ST}\nBitte nehmen Sie bis zum 20.10.2026 Stellung.`);
    const vorschlaege = proposeInboxTasks(run.item, getCompanyProfile(), { autoCreated: true });
    expect(vorschlaege).toHaveLength(1);
    expect(vorschlaege[0].dedupeKey).toBe(`inbox:${run.id}:follow_up`);
    expect(run.ablegen()).toHaveLength(1);
  });
});

/*
 * Nacharbeit 1 — gleiche Art und gleiche Frist sind eine interne Handlung.
 * Sie werden gruppiert, ohne dass eine Pflicht, ihr Text oder ihre Unterlagen
 * verloren gehen. Andere Daten oder andere Arten bleiben getrennt.
 */
const aufgabenMitText = (id: string) =>
  getAllTasks()
    .filter((task) => task.linkedInboxId === id)
    .sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? '') || a.title.localeCompare(b.title));

describe('02A-2C Nacharbeit 1 — gleiche Art, gleiche Frist: gruppieren statt verwerfen', () => {
  const K1 = `${AZ}\nBitte nehmen Sie bis zum 20.10.2026 Stellung.\nBitte reichen Sie die Fotos bis zum 25.10.2026 ein.\nBitte senden Sie uns den Kostenvoranschlag bis zum 25.10.2026.`;

  it('K1 zwei Einreichpflichten am 25.10.: eine Aufgabe mit Fotos und Kostenvoranschlag', async () => {
    const run = await durchlaufe(K1);
    // Der Kern bleibt unverändert: drei einzelne Pflichten.
    expect(eigenePflichten(run.semantic)).toEqual([
      'response_due@2026-10-20',
      'document_submission_due@2026-10-25',
      'document_submission_due@2026-10-25',
    ]);
    run.ablegen();
    const tasks = aufgabenMitText(run.id);
    expect(tasks.map((task) => `${task.title}@${task.dueDate}`)).toEqual([
      'Stellungnahme abgeben@2026-10-20',
      'Unterlagen einreichen@2026-10-25',
    ]);
    expect(tasks[1].description).toContain('Fotos');
    expect(tasks[1].description).toContain('Kostenvoranschlag');
  });

  it('K2 Idempotenz: wiederholt ablegen, manuell anlegen, neu analysieren — weiterhin zwei vollständige Aufgaben', async () => {
    const run = await durchlaufe(K1);
    run.ablegen();
    run.ablegen();
    createTaskForItem(run.id);
    analyzeUploadedDocument(run.id);
    run.ablegen();
    const tasks = aufgabenMitText(run.id);
    expect(tasks).toHaveLength(2);
    expect(tasks[1].description).toContain('Fotos');
    expect(tasks[1].description).toContain('Kostenvoranschlag');
  });

  it('K3 unterschiedliche Daten bleiben getrennte Aufgaben', async () => {
    const run = await durchlaufe(
      `${AZ}\nBitte reichen Sie die Fotos bis zum 25.10.2026 ein.\nBitte senden Sie uns die Belege zum Kostenvoranschlag bis zum 30.10.2026.`,
    );
    expect(eigenePflichten(run.semantic)).toEqual(['document_submission_due@2026-10-25', 'document_submission_due@2026-10-30']);
    expect(run.ablegen()).toEqual(['Unterlagen einreichen@2026-10-25', 'Unterlagen einreichen@2026-10-30']);
  });

  it('K3 im Wortlaut des Auftrags: zwei getrennte Aufgaben mit 25.10. und 30.10.', async () => {
    const run = await durchlaufe(
      `${AZ}\nBitte reichen Sie die Fotos bis zum 25.10.2026 ein.\nBitte senden Sie uns den Kostenvoranschlag bis zum 30.10.2026.`,
    );
    run.ablegen();
    expect(aufgabenMitText(run.id).map((task) => task.dueDate)).toEqual(['2026-10-25', '2026-10-30']);
  });

  it('K4 gleiche relative Frist: eine Aufgabe ohne Datum mit beiden Pflichten', async () => {
    const run = await durchlaufe(`${AZ}\nBitte reichen Sie die Fotos unverzüglich ein.\nBitte senden Sie uns die Belege unverzüglich.`);
    expect(eigenePflichten(run.semantic)).toEqual(['document_submission_due@-', 'document_submission_due@-']);
    expect(run.item.deadline ?? null).toBeNull();
    run.ablegen();
    const tasks = aufgabenMitText(run.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe('Unterlagen einreichen');
    expect(tasks[0].dueDate ?? undefined).toBeUndefined();
    expect(tasks[0].description).toContain('Fotos');
    expect(tasks[0].description).toContain('Belege');
    expect(tasks[0].description).toContain('unverzüglich – Datum nicht berechnet');
  });

  it('K5 beide ohne Frist: eine Aufgabe ohne Datum mit beiden Pflichten — kein generischer Rückfall', async () => {
    const run = await durchlaufe(`${AZ}\nBitte reichen Sie die Fotos ein.\nBitte senden Sie uns die Belege.`);
    expect(eigenePflichten(run.semantic)).toEqual(['document_submission_due@-', 'document_submission_due@-']);
    run.ablegen();
    const tasks = aufgabenMitText(run.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe('Unterlagen einreichen');
    expect(tasks[0].dueDate ?? undefined).toBeUndefined();
    expect(tasks[0].description).toContain('Fotos');
    expect(tasks[0].description).toContain('Belege');
    expect(tasks[0].description).toContain('Keine Frist genannt');
  });

  it('K6 doppelte Unterlage: Fotos nur einmal, Gutachten und Kostenvoranschlag beide', async () => {
    const run = await durchlaufe(
      `${AZ}\nBitte reichen Sie bis zum 25.10.2026 Fotos und Gutachten ein.\nBitte reichen Sie bis zum 25.10.2026 Fotos und Kostenvoranschlag ein.`,
    );
    // Der Kern behält beide Pflichten mit ihren eigenen Unterlagen.
    expect(run.semantic!.requestedDocuments?.map((d) => `${d.label}#${d.obligationIndex}`)).toEqual([
      'Fotos#0',
      'Gutachten#0',
      'Fotos#1',
      'Kostenvoranschlag#1',
    ]);
    run.ablegen();
    const tasks = aufgabenMitText(run.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].description).toContain('Unterlagen: Fotos, Gutachten, Kostenvoranschlag');
  });
});
