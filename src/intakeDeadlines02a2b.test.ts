/**
 * EINGANG-02A-2B — relative Fristen, Handlungsbedarf und Informationsschreiben.
 *
 * Über den echten Pfad: Aufnahme → Analyse → semantischer Kern → Einschätzung
 * und Bedeutung → Ablage (`confirmFiling`) → tatsächlich angelegte Aufgabe.
 *
 *   - Relative Fristen bleiben im Wortlaut erhalten; es entsteht nie ein Datum.
 *   - Eine eigene Pflicht ohne absolutes Datum ist Handlungsbedarf („prüfen"),
 *     nie „Archivieren / sicher".
 *   - Eine sicher erkannte Zahlungsfrist heisst „Zahlung prüfen" — nichts wird
 *     gezahlt, erfasst oder gebucht.
 *   - Ein ausdrücklich reines Behörden-/Versicherungsschreiben braucht keine
 *     Aktion; beim Ablegen entsteht keine Aufgabe allein aus der Dokumentart.
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
import { confirmFiling } from './services/inboxTaskService';
import { analyzeUploadedDocument, processUploadedDocument } from './services/intakeWorkflowService';
import { setActiveStorageScope } from './services/storage/storageScopeService';
import { proposePrimaryInboxTask } from './services/taskEngineService';
import { getAllTasks } from './services/taskService';
import { hydrateTaskStore } from './services/taskStore';
import { hydrateVorgangStore } from './services/vorgangService';
import { buildDocumentMeaningViewFromCore } from './services/document/documentMeaningPresentationService';
import { deriveIntakeAssessment } from './services/document/intakeAssessmentService';
import { importInboxDocumentForTests } from './test/confirmFilingDecisionForTests';
import { useDocumentBlobDatabaseReset } from './test/documentBlobTestReset';

const OWN = 'Mustermann Sanitär GmbH';
const TO = `${OWN}\nHandwerkerweg 7\n10115 Berlin`;
const FA = `Finanzamt Musterstadt\nSteuernummer 12/345/67890\n${TO}\nAktenzeichen: St-2026/4711`;
const AZ = `Allianz Versicherungs-AG\nSchadennummer: S-2026-0077\n${TO}`;
const ST = `Stadt Musterstadt - Bauordnungsamt\nAktenzeichen: BA-2026-123\n${TO}`;

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

/** Echter Pfad bis zur Einschätzung; danach auf Wunsch die echte Ablage. */
async function durchlaufe(recognizedText: string) {
  const name = `e02a2b-${++seq}.pdf`;
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
  const ablegen = () => {
    // Wie der Ablagefluss: ins Archiv übernehmen, dann Ablage bestätigen.
    const archiv = importInboxDocumentForTests(getInboxItemById(id)!, OWN);
    expect(archiv.success).toBe(true);
    if (archiv.success) markInboxImportedToArchive(id, archiv.document.id);
    const filing = confirmFiling(id);
    expect(filing?.success).toBe(true);
    return { filing, tasks: getAllTasks().filter((task) => task.linkedInboxId === id) };
  };
  return { id, item, semantic, assessment, meaning, ablegen };
}

const eigenePflichten = (semantic: { obligations: Array<{ who: string; kind?: string; byWhen?: string }> } | null) =>
  (semantic?.obligations ?? []).filter((o) => o.who === 'own_company').map((o) => `${o.kind ?? '?'}@${o.byWhen ?? '-'}`);

describe('02A-2B — relative Fristen: Wortlaut, Handlungsbedarf, kein Datum', () => {
  it.each([
    ['R1', `${FA}\nBitte nehmen Sie innerhalb von zwei Wochen nach Zugang dieses Schreibens Stellung.`, 'response_due', 'innerhalb von zwei Wochen nach Zugang dieses Schreibens'],
    ['R2', `${AZ}\nBitte reichen Sie die Unterlagen binnen 14 Tagen nach Erhalt ein.`, 'document_submission_due', 'binnen 14 Tagen nach Erhalt'],
    ['R3', `${FA}\nTeilen Sie uns Ihre Entscheidung innerhalb eines Monats nach Bekanntgabe mit.`, 'response_due', 'innerhalb eines Monats nach Bekanntgabe'],
    ['R4', `${AZ}\nBitte senden Sie uns die Unterlagen unverzüglich.`, 'document_submission_due', 'unverzüglich'],
    ['R5', `${FA}\nBitte antworten Sie innerhalb der gesetzlichen Frist.`, 'response_due', 'innerhalb der gesetzlichen Frist'],
  ])('%s', async (_label, text, kind, phrase) => {
    const run = await durchlaufe(text);
    // Kein erfundenes Datum — weder am Eingang noch im Kern.
    expect(run.item.deadline ?? null).toBeNull();
    expect(run.semantic!.deadlines.filter((d) => d.actionRequired)).toEqual([]);
    expect(run.semantic!.primaryActionDeadline).toBeUndefined();
    // Die relative Frist im Wortlaut, mit eigener Pflicht der richtigen Art.
    expect(run.semantic!.relativeDeadlines).toEqual([expect.objectContaining({ phrase, kind, certainty: 'uncertain' })]);
    expect(eigenePflichten(run.semantic)).toEqual([`${kind}@-`]);
    // Handlungsbedarf, „Frist prüfen", nie „Archivieren / sicher".
    expect(run.meaning!.actionNeed).toBe('yes');
    expect(run.meaning!.deadlines[0]).toEqual(expect.objectContaining({ isAction: true }));
    expect(run.meaning!.deadlines[0].text).toContain(phrase);
    expect(run.assessment.actionNeed).toBe('check_deadline');
    expect(run.assessment.status).toBe('pruefen');
    expect(run.assessment.deadline).toBeNull();
    expect(run.assessment.openDeadline).toEqual({ phrase });
    // Beim Ablegen bleibt die Handlung sichtbar, ohne berechnetes Datum.
    const { tasks } = run.ablegen();
    expect(tasks.every((task) => !task.dueDate)).toBe(true);
  });
});

describe('02A-2B — eigene Pflicht ohne Datum ist Handlungsbedarf', () => {
  it.each([
    ['P1', `${FA}\nBitte nehmen Sie hierzu Stellung.`, 'response_due', 'reply'],
    ['P2', `${AZ}\nBitte senden Sie uns die Unterlagen.`, 'document_submission_due', 'submit_documents'],
    ['P3', `${AZ}\nWir benötigen noch den Versicherungsnachweis.`, 'document_submission_due', 'submit_documents'],
  ])('%s', async (_label, text, kind, actionNeed) => {
    const run = await durchlaufe(text);
    expect(run.item.deadline ?? null).toBeNull();
    expect(eigenePflichten(run.semantic)).toEqual([`${kind}@-`]);
    expect(run.semantic!.relativeDeadlines).toBeUndefined();
    expect(run.semantic!.informationOnly).toBeUndefined();
    expect(run.meaning!.actionNeed).toBe('yes');
    expect(run.meaning!.uncertainties).toContain('documentMeaning.uncertain.noDeadline');
    expect(run.assessment.actionNeed).toBe(actionNeed);
    expect(run.assessment.status).toBe('pruefen');
    expect(run.assessment.openDeadline).toEqual({ notStated: true });
    // Nicht als Information unterdrückt: die Ablage legt die Wiedervorlage an.
    const { tasks } = run.ablegen();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].dueDate ?? undefined).toBeUndefined();
  });
});

describe('02A-2B — Zahlungsfrist heisst „Zahlung prüfen"', () => {
  it('Z1 Behördengebühr mit Datum: Zahlung prüfen, Frist 20.10., nichts gezahlt oder gebucht', async () => {
    const run = await durchlaufe(`${ST}\nBitte zahlen Sie die Gebühr von 75,00 EUR bis zum 20.10.2026.`);
    expect(run.item.deadline).toBe('2026-10-20');
    expect(run.item.deadlineType).toBe('payment_due');
    expect(eigenePflichten(run.semantic)).toEqual(['payment_due@2026-10-20']);
    expect(run.assessment.actionNeed).toBe('check_payment');
    expect(run.assessment.deadline).toEqual(expect.objectContaining({ date: '2026-10-20', type: 'payment_due' }));
    expect(run.assessment.status).toBe('sicher');
    expect(t('intakeAssessment.action.check_payment', 'de')).toBe('Zahlung prüfen');
    // Keine automatische Ausgabe, Zahlung oder Buchung.
    run.ablegen();
    expect(getAllExpenses()).toEqual([]);
  });
});

describe('02A-2B — reine Information: kein Handlungsbedarf, keine Ablage-Aufgabe', () => {
  it.each([
    ['I1', `${AZ}\nWir bestätigen den Eingang Ihrer Unterlagen. Von Ihnen ist derzeit nichts weiter zu veranlassen.`],
    ['I2', `${FA}\nZu Ihrer Information teilen wir Ihnen mit, dass die Bearbeitung andauert.`],
    ['I3', `${AZ}\nWir haben Ihren Schaden unter der Schadennummer 12345 aufgenommen. Die Bearbeitung wurde eingeleitet.`],
    ['G2', `${AZ}\nZu Ihrer Information: Es sind derzeit keine weiteren Unterlagen erforderlich.`],
  ])('%s', async (_label, text) => {
    const run = await durchlaufe(text);
    expect(eigenePflichten(run.semantic)).toEqual([]);
    expect(run.semantic!.deadlines.filter((d) => d.actionRequired)).toEqual([]);
    expect(run.semantic!.relativeDeadlines).toBeUndefined();
    expect(run.semantic!.informationOnly).toBeDefined();
    expect(run.meaning!.actionNeed).toBe('no');
    // Sichtbar: „Muss ich etwas tun? Nein" — der Bereich bleibt nicht leer.
    expect(run.meaning!.isEmpty).toBe(false);
    expect(run.assessment.actionNeed).toBe('none');
    expect(run.assessment.informationOnly).toBe(true);
    expect(run.assessment.nextStep.labelKey).toBe('intakeAssessment.next.fileOnly');
    // Ablegen bleibt möglich — ohne automatisch angelegte follow_up-Aufgabe.
    expect(proposePrimaryInboxTask(run.item, getCompanyProfile(), { autoCreated: true })).toBeNull();
    const { filing, tasks } = run.ablegen();
    expect(filing?.item?.status).toBe('abgelegt');
    expect(filing?.taskCreated).toBeUndefined();
    expect(tasks).toEqual([]);
  });

  it('wer ausdrücklich eine Aufgabe anlegt, bekommt sie auch bei reiner Information', async () => {
    const run = await durchlaufe(`${AZ}\nWir bestätigen den Eingang Ihrer Unterlagen. Von Ihnen ist derzeit nichts weiter zu veranlassen.`);
    expect(proposePrimaryInboxTask(run.item, getCompanyProfile(), { autoCreated: false })).not.toBeNull();
  });
});

describe('02A-2B — Information unterdrückt keine echte Pflicht', () => {
  it('G1 Information + Fotos bis 20.10.: Unterlagenpflicht, Frist, Aufgabe beim Ablegen', async () => {
    const run = await durchlaufe(
      `${AZ}\nZu Ihrer Information teilen wir Ihnen mit, dass die Bearbeitung andauert. Bitte senden Sie uns jedoch die Fotos bis zum 20.10.2026.`,
    );
    expect(run.item.deadline).toBe('2026-10-20');
    expect(run.item.deadlineType).toBe('document_submission_due');
    expect(eigenePflichten(run.semantic)).toEqual(['document_submission_due@2026-10-20']);
    expect(run.semantic!.informationOnly).toBeUndefined();
    expect(run.meaning!.actionNeed).toBe('yes');
    expect(run.assessment.actionNeed).toBe('submit_documents');
    const { tasks } = run.ablegen();
    expect(tasks).toHaveLength(1);
    expect(tasks[0].dueDate).toBe('2026-10-20');
  });
});

describe('02A-2B — negative Grenzen', () => {
  it('„unverzüglich" der Gegenseite ist keine eigene Pflicht und keine relative Frist', async () => {
    const run = await durchlaufe(`${AZ}\nWir werden den Schaden unverzüglich regulieren.`);
    expect(eigenePflichten(run.semantic)).toEqual([]);
    expect(run.semantic!.relativeDeadlines).toBeUndefined();
  });

  it('„gesetzliche Frist" einer anderen Partei ist keine eigene Pflicht', async () => {
    const run = await durchlaufe(`${AZ}\nDie Versicherung entscheidet innerhalb der gesetzlichen Frist über Ihren Antrag.`);
    expect(eigenePflichten(run.semantic)).toEqual([]);
    expect(run.semantic!.relativeDeadlines).toBeUndefined();
    expect(run.assessment.actionNeed).not.toBe('check_deadline');
  });

  it('eine absolute Frist im selben Satz geht der relativen Angabe vor', async () => {
    const run = await durchlaufe(`${AZ}\nBitte senden Sie uns die Fotos unverzüglich, spätestens bis zum 20.10.2026.`);
    expect(run.item.deadline).toBe('2026-10-20');
    expect(run.semantic!.relativeDeadlines).toBeUndefined();
    expect(run.assessment.openDeadline).toBeUndefined();
  });

  it('die Sperre bleibt eng: Mahnung ohne Datum behält ihre Aufgabe', async () => {
    const run = await durchlaufe(
      `Muster Baustoffe GmbH\nIndustriestr. 3\n20095 Hamburg\n${TO}\nZahlungserinnerung\nZu Ihrer Information: Unsere Rechnung RE-77 über 500,00 EUR ist noch offen.`,
    );
    expect(proposePrimaryInboxTask(run.item, getCompanyProfile(), { autoCreated: true })).not.toBeNull();
  });

  it('Gebrauchshinweis einer Freistellungsbescheinigung bleibt ohne neue Pflichtart', async () => {
    const run = await durchlaufe(
      `Finanzamt Musterstadt\nFreistellungsbescheinigung nach § 48b EStG\n${TO}\nDiese Bescheinigung ist gültig bis zum 31.12.2026. Bitte legen Sie diese Bescheinigung Ihren Auftraggebern vor.`,
    );
    expect(run.semantic!.deadlines.find((d) => d.date === '2026-12-31')?.type).toBe('validity_period_end');
    expect(run.semantic!.primaryActionDeadline).toBeUndefined();
    expect(run.semantic!.relativeDeadlines).toBeUndefined();
    expect(run.assessment.openDeadline).toBeUndefined();
    expect(run.assessment.actionNeed).not.toBe('check_deadline');
  });
});

describe('02A-2B — Persistenz: relative Frist im gespeicherten Kern', () => {
  it('der gespeicherte Arbeitsstand trägt relativeDeadlines im Wortlaut', async () => {
    const run = await durchlaufe(`${AZ}\nBitte reichen Sie die Unterlagen binnen 14 Tagen nach Erhalt ein.`);
    const gespeichert = getDocumentWorkResultForItem(run.id);
    expect(gespeichert?.businessInterpretation?.semantic?.relativeDeadlines).toEqual([
      expect.objectContaining({ phrase: 'binnen 14 Tagen nach Erhalt', kind: 'document_submission_due' }),
    ]);
    // Rundreise über JSON (jsonb): nichts geht verloren, nichts wird zum Datum.
    const zurueck = JSON.parse(JSON.stringify(gespeichert));
    expect(zurueck.businessInterpretation.semantic.relativeDeadlines[0].phrase).toBe('binnen 14 Tagen nach Erhalt');
    expect(zurueck.businessInterpretation.semantic.primaryActionDeadline).toBeUndefined();
  });
});
