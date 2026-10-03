/**
 * EINGANG-02A-2A — semantischer Kern: absolute Fristen und Pflichten.
 *
 * Geprüft wird, dass Zahlungen mit „fällig", Unterlagen in getrennter
 * Verbform, Stellungnahmen und Mitteilungen als Frist UND als Pflicht der
 * richtigen Art erkannt werden — mit dem Pflichtdatum der Handlungsfrist,
 * nicht des ersten Datums im Satz. Die Hauptfrist bleibt die früheste
 * Handlungsfrist. Relative Fristen, Einschätzung und Aufgaben sind nicht
 * Gegenstand dieses Pakets.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_COMPANY_PROFILE } from './data/companyProfileDefaults';
import { hydrateCompanyProfileStore } from './services/companyProfileService';
import { classifyDocument } from './services/documentClassificationService';
import { intakeCachedDocumentFile } from './services/documentIntakeService';
import { hydrateDocumentFileStore } from './services/documentFileStoreService';
import { hydrateDocumentStore } from './services/documentService';
import { resetDocumentWorkResultStoreForTests } from './services/documentWorkResultService';
import { hydrateExpenseStore } from './services/expenseStore';
import { getInboxItemById, hydrateInboxStore } from './services/inboxService';
import { analyzeUploadedDocument, processUploadedDocument } from './services/intakeWorkflowService';
import { setActiveStorageScope } from './services/storage/storageScopeService';
import { hydrateVorgangStore } from './services/vorgangService';
import { buildDocumentSemanticCore } from './services/document/documentSemanticCoreService';
import { useDocumentBlobDatabaseReset } from './test/documentBlobTestReset';
import type { DocumentSemanticCore } from './types/documentSemanticCore';

const OWN = 'Mustermann Sanitär GmbH';
const TO = `${OWN}\nHandwerkerweg 7\n10115 Berlin`;
const FA = `Finanzamt Musterstadt\nSteuernummer 12/345/67890\n${TO}\nAktenzeichen: St-2026/4711`;
const AZ = `Allianz Versicherungs-AG\nSchadennummer: S-2026-0077\n${TO}`;
const ST = `Stadt Musterstadt - Bauordnungsamt\nAktenzeichen: BA-2026-123\n${TO}`;
const LF = `Muster Baustoffe GmbH\nIndustriestr. 3\n20095 Hamburg\n${TO}`;

const core = (text: string): DocumentSemanticCore => buildDocumentSemanticCore({ text, companyProfile: null });
const eigenePflichten = (c: DocumentSemanticCore) =>
  c.obligations.filter((o) => o.who === 'own_company').map((o) => `${o.kind ?? '?'}@${o.byWhen ?? '-'}`);
const handlungsfristen = (c: DocumentSemanticCore) =>
  c.deadlines.filter((d) => d.actionRequired).map((d) => `${d.type}@${d.date}`);

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
  hydrateCompanyProfileStore({ ...DEFAULT_COMPANY_PROFILE, companyName: OWN, street: 'Handwerkerweg 7', zip: '10115', city: 'Berlin' });
  hydrateVorgangStore([]);
});

async function intake(recognizedText: string, pageTexts?: string[]) {
  const name = `s02a2a-${++seq}.pdf`;
  const bytes = new TextEncoder().encode(`${name}:${recognizedText}`);
  const result = await intakeCachedDocumentFile(
    { bytes, fileName: name, mimeType: 'application/pdf', fileSize: bytes.byteLength },
    {
      sourceFileName: name,
      recognizedText,
      ...(pageTexts ? { pageTexts: pageTexts.map((text, index) => ({ pageNumber: index + 1, text })) } : {}),
      previewClassification: classifyDocument({ sourceFileName: name, recognizedText }),
      userDecision: 'save_permanently',
    },
  );
  const id = result.inboxItem!.id;
  hydrateInboxStore([{ ...getInboxItemById(id)!, markedAsCompanyDocument: true }]);
  processUploadedDocument(id);
  const item = getInboxItemById(id)!;
  const workflow = analyzeUploadedDocument(id)!;
  return { item, semantic: workflow.businessInterpretation?.semantic };
}

/* Echter Aufnahmepfad: Hauptfrist, Fristart, Pflichten mit Art und Datum. */
const PFAD: Array<[string, string, string, string, string[]]> = [
  ['F1 Schadendatum + Einreichfrist', `${AZ}\nDer Schaden ereignete sich am 01.09.2026. Bitte reichen Sie die Unterlagen bis zum 20.10.2026 ein.`, '2026-10-20', 'document_submission_due', ['document_submission_due@2026-10-20']],
  ['F1b ein Satz, „reichen Sie … ein"', `${AZ}\nZu Ihrem Schaden vom 01.09.2026 reichen Sie bitte die Unterlagen bis zum 20.10.2026 ein.`, '2026-10-20', 'document_submission_due', ['document_submission_due@2026-10-20']],
  ['F2 Bescheid + Stellungnahme', `${FA}\nBescheid vom 05.10.2026. Nehmen Sie bitte bis zum 25.10.2026 Stellung.`, '2026-10-25', 'response_due', ['response_due@2026-10-25']],
  ['F3 Betrag „am … fällig"', `${FA}\nRechnung vom 01.10.2026. Der Betrag ist am 31.10.2026 fällig.`, '2026-10-31', 'payment_due', ['payment_due@2026-10-31']],
  ['F4 Versicherungsfall + Mitteilung', `${AZ}\nVersicherungsfall vom 12.09.2026. Bitte teilen Sie uns Ihre Entscheidung bis 15.10.2026 mit.`, '2026-10-15', 'response_due', ['response_due@2026-10-15']],
  ['U2 getrennte Verbform', `${ST}\nReichen Sie die Unterlagen bitte bis zum 20.10.2026 ein.`, '2026-10-20', 'document_submission_due', ['document_submission_due@2026-10-20']],
  ['Z2 Selbstbeteiligung fällig', `${AZ}\nDie Selbstbeteiligung in Höhe von 500,00 EUR ist bis zum 31.10.2026 fällig.`, '2026-10-31', 'payment_due', ['payment_due@2026-10-31']],
  ['Z3 Gebühr fällig am', `${ST}\nGebühr 75,00 EUR, fällig am 20.10.2026.`, '2026-10-20', 'payment_due', ['payment_due@2026-10-20']],
  [
    'M1 drei Pflichten',
    `${ST}\nBitte nehmen Sie bis zum 20.10.2026 Stellung.\nReichen Sie die angeforderten Fotos bis zum 25.10.2026 ein.\nDie Gebühr von 75,00 EUR ist bis zum 31.10.2026 zu zahlen.`,
    '2026-10-20',
    'response_due',
    ['response_due@2026-10-20', 'document_submission_due@2026-10-25', 'payment_due@2026-10-31'],
  ],
  ['G1 Information + echte Pflicht', `${AZ}\nZu Ihrer Information: Die Bearbeitung dauert noch an. Bitte senden Sie uns jedoch die Fotos bis zum 20.10.2026.`, '2026-10-20', 'document_submission_due', ['document_submission_due@2026-10-20']],
  /* Nacharbeit 1 — eine vergangene Fälligkeit verdrängt nicht die aktuelle Zahlungsfrist. */
  ['H1 Zahlungserinnerung „war am … fällig"', `${LF}\nZahlungserinnerung\nDer Rechnungsbetrag von 500,00 EUR war am 27.08.2026 fällig. Bitte zahlen Sie bis zum 15.10.2026.`, '2026-10-15', 'payment_due', ['payment_due@2026-10-15']],
  ['H2 Rechnung „war am … fällig" + überweisen', `${LF}\nZahlungserinnerung\nUnsere Rechnung RE-77 war am 27.08.2026 fällig. Bitte überweisen Sie den Betrag bis zum 15.10.2026.`, '2026-10-15', 'payment_due', ['payment_due@2026-10-15']],
  ['H3 Behörde Gebühr „war am … fällig"', `${ST}\nDie Gebühr war am 01.09.2026 fällig. Bitte zahlen Sie bis zum 20.10.2026.`, '2026-10-20', 'payment_due', ['payment_due@2026-10-20']],
];

describe('02A-2A — Fristen und Pflichten über den echten Aufnahmepfad', () => {
  it.each(PFAD)('%s', async (_label, text, deadline, deadlineType, pflichten) => {
    const { item, semantic } = await intake(text);
    // Die Hauptfrist bleibt die früheste Handlungsfrist.
    expect(item.deadline).toBe(deadline);
    expect(item.deadlineType).toBe(deadlineType);
    expect(semantic).toBeDefined();
    expect(eigenePflichten(semantic!)).toEqual(pflichten);
  });
});

describe('02A-2A — Fristen und Pflichten im semantischen Kern', () => {
  it.each([
    ['S1 Stellung nehmen', `${FA}\nNehmen Sie bitte bis zum 20.10.2026 Stellung.`],
    ['S2 beantworten', `${FA}\nBitte beantworten Sie unser Schreiben bis zum 20.10.2026.`],
    ['S3 Rückmeldung', `${AZ}\nWir bitten um Ihre Rückmeldung bis zum 20.10.2026.`],
    ['S4 Teilen Sie uns mit', `${AZ}\nTeilen Sie uns bitte bis zum 20.10.2026 mit, ob die Arbeiten abgeschlossen sind.`],
  ])('%s → response_due mit Pflicht', (_label, text) => {
    const c = core(text);
    expect(handlungsfristen(c)).toEqual(['response_due@2026-10-20']);
    expect(eigenePflichten(c)).toEqual(['response_due@2026-10-20']);
  });

  it.each([
    ['U3 wir benötigen', `${AZ}\nWir benötigen die Fotos bis zum 20.10.2026.`],
    ['senden Sie die Belege', `${AZ}\nBitte senden Sie die Belege bis zum 20.10.2026.`],
    ['reichen Sie die Nachweise … ein', `${ST}\nReichen Sie die Nachweise bis zum 20.10.2026 ein.`],
    ['reichen Sie … ein ohne Unterlagenwort', `${ST}\nReichen Sie die Baustellenzeichnung bis zum 20.10.2026 ein.`],
  ])('%s → document_submission_due mit Pflicht', (_label, text) => {
    const c = core(text);
    expect(handlungsfristen(c)).toEqual(['document_submission_due@2026-10-20']);
    expect(eigenePflichten(c)).toEqual(['document_submission_due@2026-10-20']);
  });

  it('Z1 „Bitte zahlen Sie" bleibt payment_due mit Pflicht', () => {
    const c = core(`${FA}\nBitte zahlen Sie 1.250,00 EUR bis zum 31.10.2026.`);
    expect(handlungsfristen(c)).toEqual(['payment_due@2026-10-31']);
    expect(eigenePflichten(c)).toEqual(['payment_due@2026-10-31']);
  });
});

describe('02A-2A — negative Grenzen', () => {
  it('Ereignis- und Bescheiddatum werden weder Frist noch Pflichtdatum', () => {
    const f1 = core(`${AZ}\nDer Schaden ereignete sich am 01.09.2026. Bitte reichen Sie die Unterlagen bis zum 20.10.2026 ein.`);
    expect(f1.deadlines.find((d) => d.date === '2026-09-01')?.actionRequired).toBe(false);
    expect(f1.obligations.map((o) => o.byWhen)).not.toContain('2026-09-01');
    const f2 = core(`${FA}\nBescheid vom 05.10.2026. Nehmen Sie bitte bis zum 25.10.2026 Stellung.`);
    expect(f2.deadlines.find((d) => d.date === '2026-10-05')?.actionRequired).toBe(false);
    expect(f2.primaryActionDeadline?.date).toBe('2026-10-25');
  });

  it('„keine weiteren Unterlagen erforderlich" erzeugt weder Pflicht noch Frist — auch mit Datum', () => {
    const g2 = core(`${AZ}\nEs sind keine weiteren Unterlagen erforderlich. Wir regulieren den Schaden in den nächsten Tagen.`);
    expect(eigenePflichten(g2)).toEqual([]);
    expect(handlungsfristen(g2)).toEqual([]);
    const mitDatum = core(`${AZ}\nEs sind bis zum 20.10.2026 keine weiteren Unterlagen erforderlich.`);
    expect(handlungsfristen(mitDatum)).toEqual([]);
    expect(eigenePflichten(mitDatum)).toEqual([]);
  });

  it('Aussagen der Gegenseite sind keine Pflicht des Betriebs', () => {
    for (const text of ['Wir werden Ihnen die Unterlagen bis zum 20.10.2026 senden.', 'Die Versicherung wird bis zum 20.10.2026 Stellung nehmen.']) {
      expect(eigenePflichten(core(`${AZ}\n${text}`)), text).toEqual([]);
    }
  });

  it('„seit dem … fällig" ist ein vergangener Fälligkeitstag, keine Frist', () => {
    const c = core(`Muster Baustoffe GmbH\n${TO}\nDie Rechnung MB-1 über 4.286,50 EUR ist seit dem 27.08.2026 fällig.\nWir fordern Sie auf, den Betrag bis zum 19.09.2026 zu überweisen.`);
    expect(c.deadlines.find((d) => d.date === '2026-08-27')?.actionRequired).toBe(false);
    expect(c.primaryActionDeadline?.date).toBe('2026-09-19');
  });

  it('H5 „fällig" ohne Zahlungsgegenstand ist keine Zahlung', () => {
    const c = core(`${ST}\nDie Leistung ist am 30.10.2026 fällig.`);
    expect(c.deadlines.map((d) => d.type)).not.toContain('payment_due');
  });

  it.each([
    ['war am', 'Der Betrag war am 27.08.2026 fällig.'],
    ['waren am', 'Die Beträge waren am 27.08.2026 fällig.'],
    ['wurde am', 'Der Betrag wurde am 27.08.2026 fällig.'],
    ['bereits am', 'Der Betrag ist bereits am 27.08.2026 fällig.'],
    ['war bereits am', 'Der Betrag war bereits am 27.08.2026 fällig.'],
    ['ist seit dem', 'Der Betrag ist seit dem 27.08.2026 fällig.'],
    ['fällig gewesen', 'Der Betrag wäre zum 27.08.2026 fällig gewesen.'],
    ['war fällig am', 'Der Betrag war fällig am 27.08.2026.'],
  ])('vergangene Fälligkeit „%s" ist weder Frist noch Pflicht', (_form, satz) => {
    const c = core(`${LF}\n${satz} Bitte zahlen Sie bis zum 15.10.2026.`);
    expect(handlungsfristen(c)).toEqual(['payment_due@2026-10-15']);
    expect(eigenePflichten(c)).toEqual(['payment_due@2026-10-15']);
    expect(c.primaryActionDeadline?.date).toBe('2026-10-15');
  });

  it('H6 „Seit dem … ist der Betrag fällig" ist keine aktuelle Handlungsfrist', () => {
    const c = core(`${LF}\nSeit dem 27.08.2026 ist der Betrag fällig.`);
    expect(handlungsfristen(c)).toEqual([]);
    expect(eigenePflichten(c)).toEqual([]);
  });

  it('H4 nachgestelltes „fällig" ohne belegte Art wird keine Antwortfrist', () => {
    const c = core(`${LF}\nDie Rechnung RE-77 ist am 31.10.2026 fällig.`);
    expect(c.deadlines.map((d) => d.type)).not.toContain('response_due');
    expect(c.obligations.map((o) => o.kind)).not.toContain('response_due');
  });

  it('der Vergangenheitsschutz bleibt am Datum — aktuelle Fristen im selben Satz bleiben', () => {
    const zahlung = core(`${LF}\nDer Betrag, der bereits fällig war, ist bis zum 15.10.2026 zu zahlen.`);
    expect(handlungsfristen(zahlung)).toEqual(['payment_due@2026-10-15']);
    const unterlagen = core(`${ST}\nBitte reichen Sie die Unterlagen schon bis zum 20.10.2026 ein.`);
    expect(handlungsfristen(unterlagen)).toEqual(['document_submission_due@2026-10-20']);
  });

  it('Gültigkeitsende bleibt handlungsfrei', () => {
    const c = core(`Finanzamt Musterstadt\nFreistellungsbescheinigung nach § 48b EStG\nDiese Bescheinigung ist gültig bis zum 31.12.2026.`);
    expect(c.deadlines.find((d) => d.date === '2026-12-31')?.type).toBe('validity_period_end');
    expect(handlungsfristen(c)).toEqual([]);
    expect(c.primaryActionDeadline).toBeUndefined();
  });

  it('Gutschrift bekommt keine fremde payment_due-Frist aus der beigefügten Rechnung', async () => {
    const seite1 = ['Baustoff Meyer GmbH', 'Gutschrift', `An: ${OWN}`, 'Gutschriftsnummer: GS-2026-7', 'Datum: 01.10.2026', 'Gutschrift brutto 119,00 EUR'].join('\n');
    const seite2 = ['Baustoff Meyer GmbH', 'Rechnung', 'Rechnungsnummer: RE-2026-1', 'Gesamtbetrag 119,00 EUR', 'Der Betrag ist am 31.10.2026 fällig.'].join('\n');
    const { item } = await intake(`${seite1}\n${seite2}`, [seite1, seite2]);
    expect(item.classifiedKind).toBe('gutschrift');
    expect(item.deadlineType).not.toBe('payment_due');
    expect(item.deadline ?? null).toBeNull();
  });
});
