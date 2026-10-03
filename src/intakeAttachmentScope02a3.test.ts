/**
 * EINGANG-02A-3 — institutionelle Seitenwahrheit, Fremdanlagen und Referenzen.
 *
 * Über den echten Pfad: Aufnahme mit Seitentexten (Vorschau wie im Produkt
 * ohne Seiten) → Seitenrollen → Klassifikation → Felder → semantischer Kern →
 * DWR → Einschätzung und Bedeutung → Archiv → `confirmFiling` → Aufgaben.
 *
 *   - Nur eine sicher erkannte Fremdanlage (fremder Firmenkopf + eigener
 *     Belegtitel + Nummer/Summe) an einem institutionellen Schreiben wird
 *     abgegrenzt; alles andere bleibt Hauptschreiben.
 *   - Art, Referenz, Betrag, Fristen, Pflichten, Information und Aufgaben
 *     kommen dann nur aus den Hauptseiten.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_COMPANY_PROFILE } from './data/companyProfileDefaults';
import { t } from './i18n';
import { hydrateCompanyProfileStore } from './services/companyProfileService';
import { classifyDocument, getClassificationForItem } from './services/documentClassificationService';
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
import { getAllTasks } from './services/taskService';
import { hydrateTaskStore } from './services/taskStore';
import { hydrateVorgangStore } from './services/vorgangService';
import { buildDocumentAiContextFromDocument, resolveArchivedMainDocumentText } from './services/document/documentAiContextService';
import { resolveDocumentWorkTruthViewForCompanyDocument } from './services/documentWorkResultTruthOrchestration';
import { buildDocumentMeaningViewFromCore } from './services/document/documentMeaningPresentationService';
import { deriveIntakeAssessment } from './services/document/intakeAssessmentService';
import { resolveMainDocumentPageScope } from './services/document/mainDocumentPageScope';
import { importInboxDocumentForTests } from './test/confirmFilingDecisionForTests';
import { useDocumentBlobDatabaseReset } from './test/documentBlobTestReset';

const OWN = 'Mustermann Sanitär GmbH';
const TO = `${OWN}\nHandwerkerweg 7\n10115 Berlin`;
const ST = `Stadt Musterstadt - Bauordnungsamt\n${TO}\nAktenzeichen: BA-2026-123`;
const FA = `Finanzamt Musterstadt\n${TO}\nAktenzeichen: St-2026/4711`;
const AZ = `Allianz Versicherungs-AG\n${TO}\nSchadennummer: S-2026-0077`;
const RECHNUNG = (nummer: string, betrag: string, zeile: string) =>
  `Muster Bau GmbH\nIndustriestr. 3\n20095 Hamburg\nRechnung\nRechnungsnummer: ${nummer}\nGesamtbetrag ${betrag} EUR\n${zeile}`;

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

async function durchlaufe(pages: string[]) {
  const recognizedText = pages.join('\n');
  const pageTexts = pages.map((text, index) => ({ pageNumber: index + 1, text }));
  const name = `e02a3-${++seq}.pdf`;
  const bytes = new TextEncoder().encode(`${name}:${recognizedText}`);
  // Wie im Produkt: die Vorschau-Klassifikation kennt (ohne Fremdanlage) keine Seiten.
  const result = await intakeCachedDocumentFile(
    { bytes, fileName: name, mimeType: 'application/pdf', fileSize: bytes.byteLength },
    {
      sourceFileName: name,
      recognizedText,
      pageTexts,
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
  const assessment = deriveIntakeAssessment({ item, summary, ownCompanyName: OWN, hasLinkedExpense: false, semantic });
  const meaning = semantic ? buildDocumentMeaningViewFromCore(semantic) : null;
  // Vorschau mit Seiten (Produkt bei Fremdanlage) und spätere Klassifikation müssen übereinstimmen.
  const vorschauMitSeiten = classifyDocument({ sourceFileName: name, recognizedText, pageTexts }).classifiedKind;
  const spaeter = getClassificationForItem(item).classifiedKind;
  const ablegen = () => {
    const archiv = importInboxDocumentForTests(getInboxItemById(id)!, OWN);
    expect(archiv.success).toBe(true);
    if (!archiv.success) throw new Error('Archiv');
    markInboxImportedToArchive(id, archiv.document.id);
    expect(confirmFiling(id)?.success).toBe(true);
    return {
      dokument: archiv.document,
      archivText: resolveArchivedMainDocumentText(archiv.document),
      aufgaben: getAllTasks()
        .filter((task) => task.linkedInboxId === id)
        .map((task) => `${task.title}@${task.dueDate ?? '-'}`),
    };
  };
  return { id, item, semantic, summary, assessment, meaning, vorschauMitSeiten, spaeter, ablegen };
}

const eigenePflichten = (semantic: { obligations: Array<{ who: string; kind?: string; byWhen?: string }> } | null) =>
  (semantic?.obligations ?? []).filter((o) => o.who === 'own_company').map((o) => `${o.kind ?? '?'}@${o.byWhen ?? '-'}`);
const fakt = (summary: { facts: Array<{ id: string; value?: string }> }, id: string) => summary.facts.find((f) => f.id === id)?.value;

describe('02A-3 — institutionelles Schreiben mit sicherer Fremdanlage', () => {
  it('A1 Behörde + fremde Rechnung: Behörde, Az, Frist 20.10., keine Rechnungslogik', async () => {
    const run = await durchlaufe([`${ST}\nBitte nehmen Sie bis zum 20.10.2026 Stellung.\nAnlage: Rechnung`, RECHNUNG('RE-77', '1.190,00', 'Zahlbar bis zum 31.10.2026.')]);
    expect(run.item.classifiedKind).toBe('ordnungsamt');
    expect(run.vorschauMitSeiten).toBe('ordnungsamt');
    expect(run.spaeter).toBe('ordnungsamt');
    expect(run.item.recognizedData.Aktenzeichen).toBe('BA-2026-123');
    expect(run.item.recognizedData.Rechnungsnummer).toBeUndefined();
    expect(run.item.recognizedData.Betrag).toBeUndefined();
    expect(run.item.deadline).toBe('2026-10-20');
    expect(run.item.deadlineType).toBe('response_due');
    expect(eigenePflichten(run.semantic)).toEqual(['response_due@2026-10-20']);
    expect(run.semantic!.pageScope).toEqual(expect.objectContaining({ mainPageNumbers: [1], attachmentPageNumbers: [2] }));
    expect(fakt(run.summary, 'reference')).toBe('BA-2026-123');
    expect(fakt(run.summary, 'invoiceNumber')).toBeUndefined();
    expect(fakt(run.summary, 'amount')).toBeUndefined();
    expect(run.assessment.role).toBe('other');
    expect(run.assessment.actionNeed).toBe('reply');
    expect(run.meaning!.amounts).toEqual([]);
    const { archivText, aufgaben } = run.ablegen();
    expect(archivText).toContain('Bitte nehmen Sie bis zum 20.10.2026 Stellung.');
    expect(archivText).not.toContain('RE-77');
    expect(aufgaben).toHaveLength(1);
    expect(aufgaben[0]).toMatch(/@2026-10-20$/);
    expect(aufgaben[0]).not.toMatch(/Rechnung/);
    expect(getAllExpenses()).toEqual([]);
  });

  it('A2 Versicherung + Werkstattrechnung: Schadennummer, keine Rechnungsfrist, kein Betrag, Information', async () => {
    const run = await durchlaufe([
      `${AZ}\nAnbei erhalten Sie die Werkstattrechnung zur Kenntnis.`,
      `Autohaus Meyer GmbH\nWerkstattrechnung\nRechnungsnummer: WR-555\nGesamtbetrag 2.380,00 EUR\nZahlbar bis zum 15.11.2026.`,
    ]);
    expect(run.item.classifiedKind).toBe('versicherung');
    expect(run.spaeter).toBe('versicherung');
    expect(run.item.recognizedData.Schadennummer).toBe('S-2026-0077');
    expect(fakt(run.summary, 'reference')).toBe('S-2026-0077');
    expect(fakt(run.summary, 'invoiceNumber')).toBeUndefined();
    expect(run.item.deadline ?? null).toBeNull();
    expect(run.item.recognizedData.Betrag).toBeUndefined();
    expect(eigenePflichten(run.semantic)).toEqual([]);
    expect(run.semantic!.informationOnly).toBeDefined();
    expect(run.ablegen().aufgaben).toEqual([]);
  });

  it('A5 Finanzamt + Rechnung: Aktenzeichen bleibt Hauptreferenz', async () => {
    const run = await durchlaufe([`${FA}\nBitte nehmen Sie bis zum 20.10.2026 Stellung.\nAnlage`, RECHNUNG('RE-2026-99', '500,00', 'Vielen Dank für Ihren Auftrag.')]);
    expect(run.item.classifiedKind).toBe('finanzamt');
    expect(run.item.recognizedData.Aktenzeichen).toBe('St-2026/4711');
    expect(run.item.recognizedData.Rechnungsnummer).toBeUndefined();
    expect(fakt(run.summary, 'reference')).toBe('St-2026/4711');
    expect(run.assessment.role).toBe('other');
  });

  it('A6 Unterlagen + fremdes Angebot: Angebotspflicht 10.10. ist keine eigene Pflicht', async () => {
    const run = await durchlaufe([
      `${AZ}\nBitte reichen Sie bis zum 25.10.2026 folgende Unterlagen ein:\n- Fotos\n- Kostenvoranschlag`,
      `Malerbetrieb Schulz GmbH\nKostenvoranschlag Nr. KV-12\nGesamtbetrag 3.570,00 EUR\nBitte senden Sie uns den unterschriebenen Auftrag bis zum 10.10.2026 zurück.`,
    ]);
    expect(run.item.classifiedKind).toBe('versicherung');
    expect(run.item.deadline).toBe('2026-10-25');
    expect(eigenePflichten(run.semantic)).toEqual(['document_submission_due@2026-10-25']);
    expect(run.semantic!.requestedDocuments?.map((d) => d.label)).toEqual(['Fotos', 'Kostenvoranschlag']);
    expect(run.meaning!.amounts).toEqual([]);
    const { aufgaben } = run.ablegen();
    expect(aufgaben).toEqual(['Dokument prüfen und ablegen@2026-10-25']);
  });

  it('A7 Information + Rechnung: informationOnly, keine Zahlungspflicht, keine Aufgabe', async () => {
    const run = await durchlaufe([
      `${AZ}\nWir bestätigen den Eingang Ihrer Unterlagen. Von Ihnen ist derzeit nichts weiter zu veranlassen.`,
      `Autohaus Meyer GmbH\nRechnung\nRechnungsnummer: WR-556\nGesamtbetrag 2.380,00 EUR\nBitte überweisen Sie den Betrag bis zum 15.11.2026.`,
    ]);
    expect(run.item.classifiedKind).toBe('versicherung');
    expect(run.item.deadline ?? null).toBeNull();
    expect(eigenePflichten(run.semantic)).toEqual([]);
    expect(run.semantic!.informationOnly).toBeDefined();
    expect(run.assessment.actionNeed).toBe('none');
    expect(run.item.recognizedData.Betrag).toBeUndefined();
    expect(run.ablegen().aufgaben).toEqual([]);
  });

  it('A8 eigene Antwortfrist 31.10. + fremde frühere Zahlungsfrist: Hauptfrist bleibt 31.10.', async () => {
    const run = await durchlaufe([`${ST}\nBitte nehmen Sie bis zum 31.10.2026 Stellung.\nAnlage: Rechnung`, RECHNUNG('RE-78', '300,00', 'Bitte zahlen Sie bis zum 15.10.2026.')]);
    expect(run.item.classifiedKind).toBe('ordnungsamt');
    expect(run.item.deadline).toBe('2026-10-31');
    expect(run.item.deadlineType).toBe('response_due');
    expect(eigenePflichten(run.semantic)).toEqual(['response_due@2026-10-31']);
    expect(run.semantic!.deadlines.map((d) => d.type)).not.toContain('payment_due');
    const { aufgaben } = run.ablegen();
    expect(aufgaben).toHaveLength(1);
    expect(aufgaben[0]).toMatch(/@2026-10-31$/);
  });

  it('Persistenz: pageScope im DWR, JSON-Rundreise', async () => {
    const run = await durchlaufe([`${ST}\nBitte nehmen Sie bis zum 20.10.2026 Stellung.`, RECHNUNG('RE-77', '1.190,00', 'Zahlbar bis zum 31.10.2026.')]);
    const kern = JSON.parse(JSON.stringify(getDocumentWorkResultForItem(run.id))).businessInterpretation.semantic;
    expect(kern.pageScope.mainPageNumbers).toEqual([1]);
    expect(kern.pageScope.attachmentPageNumbers).toEqual([2]);
    expect(kern.primaryActionDeadline.date).toBe('2026-10-20');
  });
});

describe('02A-3 — Fortsetzungsseiten bleiben Hauptschreiben', () => {
  it('A3 Behörde Seite 2 mit weiterer Pflicht', async () => {
    const run = await durchlaufe([
      `${ST}\nSeite 1 von 2\nBitte nehmen Sie bis zum 20.10.2026 Stellung.`,
      `Seite 2 von 2\nAktenzeichen: BA-2026-123\nBitte reichen Sie zudem die Baupläne bis zum 25.10.2026 ein.\nMit freundlichen Grüßen\nIm Auftrag`,
    ]);
    expect(run.semantic!.pageScope).toBeUndefined();
    expect(eigenePflichten(run.semantic)).toEqual(['response_due@2026-10-20', 'document_submission_due@2026-10-25']);
    expect(run.ablegen().aufgaben).toEqual(['Stellungnahme abgeben@2026-10-20', 'Unterlagen einreichen@2026-10-25']);
  });

  it('A4 Versicherung Seite 2 mit weiterer Frist', async () => {
    const run = await durchlaufe([
      `${AZ}\nSeite 1 von 2\nBitte senden Sie uns die Fotos bis zum 20.10.2026.`,
      `Seite 2 von 2\nSchadennummer: S-2026-0077\nDie Selbstbeteiligung von 500,00 EUR ist bis zum 31.10.2026 fällig.\nMit freundlichen Grüßen`,
    ]);
    expect(run.semantic!.pageScope).toBeUndefined();
    expect(eigenePflichten(run.semantic)).toEqual(['document_submission_due@2026-10-20', 'payment_due@2026-10-31']);
  });

  it('A9 dreiseitiges Schreiben ohne Anlage: alle Pflichten', async () => {
    const run = await durchlaufe([
      `${ST}\nSeite 1 von 3\nBitte nehmen Sie bis zum 20.10.2026 Stellung.`,
      `Seite 2 von 3\nAktenzeichen: BA-2026-123\nDie Gebühr von 75,00 EUR ist bis zum 31.10.2026 zu zahlen.`,
      `Seite 3 von 3\nBitte reichen Sie die Baupläne bis zum 25.10.2026 ein.\nMit freundlichen Grüßen`,
    ]);
    expect(run.semantic!.pageScope).toBeUndefined();
    expect(eigenePflichten(run.semantic)).toHaveLength(3);
    expect(run.item.deadline).toBe('2026-10-20');
  });

  it('A10 Anlagenhinweis ohne Fremdidentität: nicht abgeschnitten', async () => {
    const run = await durchlaufe([
      `${ST}\nAnlage: Lageplan\nBitte nehmen Sie bis zum 20.10.2026 Stellung.`,
      `Seite 2\nBitte reichen Sie den Lageplan unterschrieben bis zum 25.10.2026 ein.\nMit freundlichen Grüßen`,
    ]);
    expect(run.semantic!.pageScope).toBeUndefined();
    expect(eigenePflichten(run.semantic)).toEqual(['response_due@2026-10-20', 'document_submission_due@2026-10-25']);
  });
});

describe('02A-3 — harte Negativgrenzen', () => {
  it('N1 Wort „Rechnung" auf Seite 2 ohne Fremdkopf und ohne Titel: keine Anlage', async () => {
    const run = await durchlaufe([
      `${ST}\nBitte nehmen Sie bis zum 20.10.2026 Stellung.`,
      `Seite 2 von 2\nBitte legen Sie die Rechnung des Handwerkers bis zum 25.10.2026 vor.\nMit freundlichen Grüßen`,
    ]);
    expect(run.semantic!.pageScope).toBeUndefined();
    expect(eigenePflichten(run.semantic)).toHaveLength(2);
  });

  it('N2 Betrag und MwSt. auf einer Fortsetzungsseite: keine Anlage', async () => {
    const run = await durchlaufe([
      `${ST}\nSeite 1 von 2\nBitte nehmen Sie bis zum 20.10.2026 Stellung.`,
      `Seite 2 von 2\nDie Gebühr beträgt 75,00 EUR inkl. MwSt. und ist bis zum 31.10.2026 zu zahlen.`,
    ]);
    expect(run.semantic!.pageScope).toBeUndefined();
    expect(eigenePflichten(run.semantic)).toEqual(['response_due@2026-10-20', 'payment_due@2026-10-31']);
  });

  it('N3 neue Firmenzeile ohne eigenen Belegtitel: nicht abgeschnitten, aber prüfen', async () => {
    const run = await durchlaufe([
      `${ST}\nBitte nehmen Sie bis zum 20.10.2026 Stellung.`,
      `Muster Bau GmbH\nIndustriestr. 3\nWir bestätigen die Ausführung der Arbeiten.\nGesamtbetrag 1.190,00 EUR`,
    ]);
    expect(run.semantic!.pageScope).toEqual(
      expect.objectContaining({ mainPageNumbers: [1, 2], attachmentPageNumbers: [], uncertainPageNumbers: [2] }),
    );
    expect(run.item.classifiedKind).toBe('ordnungsamt');
    expect(run.assessment.status).toBe('pruefen');
  });

  it('N4 „Seite 2 von 3" ohne Fremdkopf: Fortsetzung', async () => {
    const run = await durchlaufe([
      `${ST}\nSeite 1 von 3\nBitte nehmen Sie bis zum 20.10.2026 Stellung.`,
      `Seite 2 von 3\nAktenzeichen: BA-2026-123\nWeitere Hinweise zum Verfahren.`,
      `Seite 3 von 3\nMit freundlichen Grüßen`,
    ]);
    expect(run.semantic!.pageScope).toBeUndefined();
  });
});

describe('02A-3 — Seitenrollen-Auflöser', () => {
  const rechnung = RECHNUNG('RE-77', '1.190,00', 'Zahlbar bis zum 31.10.2026.');

  it('sichere Fremdanlage nur bei institutioneller Seite 1', () => {
    expect(resolveMainDocumentPageScope([`${ST}\nBitte nehmen Sie Stellung.`, rechnung], { ownCompanyName: OWN })).toEqual(
      expect.objectContaining({ mainPageNumbers: [1], attachmentPageNumbers: [2], uncertainPageNumbers: [] }),
    );
    // Eine Firmenrechnung auf Seite 1 ist kein institutionelles Schreiben.
    expect(resolveMainDocumentPageScope([rechnung, rechnung], { ownCompanyName: OWN })).toBeUndefined();
    // Eine Seite: nichts zu entscheiden.
    expect(resolveMainDocumentPageScope([`${ST}\nText`], { ownCompanyName: OWN })).toBeUndefined();
  });

  it('Folgeseite einer Anlage ohne eigenen Kopf gehört zur Anlage', () => {
    const scope = resolveMainDocumentPageScope(
      [`${ST}\nBitte nehmen Sie Stellung.`, rechnung, 'Pos. 3 Montage 400,00 EUR\nSumme netto 1.000,00 EUR'],
      { ownCompanyName: OWN },
    );
    expect(scope?.attachmentPageNumbers).toEqual([2, 3]);
  });

  it('Titel ohne fremden Kopf ist nur verdächtig, nicht abgegrenzt', () => {
    const scope = resolveMainDocumentPageScope(
      [`${ST}\nBitte nehmen Sie Stellung.`, 'Rechnung\nRechnungsnummer: RE-1\nGesamtbetrag 10,00 EUR'],
      { ownCompanyName: OWN },
    );
    expect(scope).toEqual(expect.objectContaining({ mainPageNumbers: [1, 2], attachmentPageNumbers: [], uncertainPageNumbers: [2] }));
  });
});

/*
 * Nacharbeit 1 — der Archiv-KI-Kontext (Dokumentfrage im Archiv) verwendet
 * dieselbe Hauptdokumentwahrheit: gespeicherter Kern, sonst archivierter
 * Hauptdokumenttext, erst ohne Seitenwahrheit der Gesamttext.
 */
type KiKern = NonNullable<ReturnType<typeof buildDocumentAiContextFromDocument>['semantic']>;
const handlung = (kern: KiKern | undefined) =>
  (kern?.deadlines ?? []).filter((d) => d.actionRequired).map((d) => `${d.type}@${d.date}`);
const forderungen = (kern: KiKern | undefined) => (kern?.amounts ?? []).filter((a) => a.isClaimAgainstUs).map((a) => a.value);

describe('02A-3 Nacharbeit 1 — Archiv-KI-Kontext mit Hauptdokumentwahrheit', () => {
  const A1 = [`${ST}\nBitte nehmen Sie bis zum 20.10.2026 Stellung.\nAnlage: Rechnung`, RECHNUNG('RE-77', '1.190,00', 'Zahlbar bis zum 31.10.2026.')];

  it('R1 A1 archiviert: Antwortfrist 20.10., keine Zahlungsfrist, keine Forderung, keine RE-77-Fakten', async () => {
    const run = await durchlaufe(A1);
    const { dokument } = run.ablegen();
    const kontext = buildDocumentAiContextFromDocument(dokument);
    expect(handlung(kontext.semantic)).toEqual(['response_due@2026-10-20']);
    expect(forderungen(kontext.semantic)).toEqual([]);
    expect((kontext.semantic?.obligations ?? []).map((o) => o.kind)).not.toContain('payment_due');
    // Eine Wahrheit mit DWR und Eingang.
    expect(handlung(kontext.semantic)).toEqual(handlung(run.semantic ?? undefined));
    // Keine Anlagen-Fakten in den strukturierten Feldern (der Originaltext bleibt Quelle).
    const { recognizedText: _quelle, ...strukturiert } = kontext as typeof kontext & { recognizedText?: string };
    expect(JSON.stringify(strukturiert)).not.toContain('RE-77');
    expect(JSON.stringify(strukturiert)).not.toContain('1.190');
  });

  it('R2 gespeicherter Kern hat Vorrang vor dem archivierten Gesamttext', async () => {
    const run = await durchlaufe([`${ST}\nBitte nehmen Sie bis zum 20.10.2026 Stellung.`, `Seite 2 von 2\nMit freundlichen Grüßen`]);
    const { dokument } = run.ablegen();
    const veraendert = {
      ...dokument,
      recognizedText: `${dokument.recognizedText}\nBitte zahlen Sie den Betrag von 999,00 EUR bis zum 01.10.2026.`,
    };
    expect(resolveDocumentWorkTruthViewForCompanyDocument({ document: veraendert }).truthView).not.toBeNull();
    const kontext = buildDocumentAiContextFromDocument(veraendert);
    expect(handlung(kontext.semantic)).toEqual(['response_due@2026-10-20']);
    expect(forderungen(kontext.semantic)).toEqual([]);
  });

  it('R3 Legacy ohne gespeicherten Kern, mit Seiten: Kern aus dem archivierten Hauptdokumenttext', async () => {
    const run = await durchlaufe(A1);
    const { dokument } = run.ablegen();
    const legacy = { ...dokument, id: `${dokument.id}-legacy`, sourceInboxItemId: undefined, archiveTruthSnapshot: undefined };
    expect(resolveDocumentWorkTruthViewForCompanyDocument({ document: legacy }).truthView).toBeNull();
    expect(resolveArchivedMainDocumentText(legacy)).not.toContain('RE-77');
    const kontext = buildDocumentAiContextFromDocument(legacy);
    expect(handlung(kontext.semantic)).toEqual(['response_due@2026-10-20']);
    expect(forderungen(kontext.semantic)).toEqual([]);
  });

  it('R4 Legacy ohne Seiten: der Gesamttext trägt weiter', async () => {
    const run = await durchlaufe(A1);
    const { dokument } = run.ablegen();
    const alt = {
      ...dokument,
      id: `${dokument.id}-alt`,
      sourceInboxItemId: undefined,
      archiveTruthSnapshot: undefined,
      recognizedText: `Stadt Musterstadt - Bauordnungsamt\n${TO}\nBitte nehmen Sie bis zum 20.10.2026 Stellung.`,
    };
    expect(resolveDocumentWorkTruthViewForCompanyDocument({ document: alt }).truthView).toBeNull();
    expect(resolveArchivedMainDocumentText(alt)).toBeNull();
    const kontext = buildDocumentAiContextFromDocument(alt);
    expect(handlung(kontext.semantic)).toEqual(['response_due@2026-10-20']);
  });

  it('R5 Gutschrift mit fremder Folgeseite bleibt auf dem 01D-2-Pfad', async () => {
    const seite1 = ['Baustoff Meyer GmbH', 'Gutschrift', `An: ${OWN}`, 'Gutschriftsnummer: GS-2026-7', 'Datum: 01.10.2026', 'Gutschrift brutto 119,00 EUR'].join('\n');
    const seite2 = ['Baustoff Meyer GmbH', 'Rechnung', 'Rechnungsnummer: RE-2026-1', 'Gesamtbetrag 119,00 EUR', 'Der Betrag ist am 31.10.2026 fällig.'].join('\n');
    const run = await durchlaufe([seite1, seite2]);
    expect(run.item.classifiedKind).toBe('gutschrift');
    expect(run.semantic!.pageScope).toBeUndefined();
    const { dokument } = run.ablegen();
    const kontext = buildDocumentAiContextFromDocument(dokument);
    expect(handlung(kontext.semantic)).not.toContain('payment_due@2026-10-31');
  });

  it('A7 archiviert: informationOnly, keine Zahlungsfrist, keine Forderung aus der Anlage', async () => {
    const run = await durchlaufe([
      `${AZ}\nWir bestätigen den Eingang Ihrer Unterlagen. Von Ihnen ist derzeit nichts weiter zu veranlassen.`,
      `Autohaus Meyer GmbH\nRechnung\nRechnungsnummer: WR-556\nGesamtbetrag 2.380,00 EUR\nBitte überweisen Sie den Betrag bis zum 15.11.2026.`,
    ]);
    const { dokument } = run.ablegen();
    const kontext = buildDocumentAiContextFromDocument(dokument);
    expect(kontext.semantic?.informationOnly).toBeDefined();
    expect(handlung(kontext.semantic)).toEqual([]);
    expect(forderungen(kontext.semantic)).toEqual([]);
  });
});
