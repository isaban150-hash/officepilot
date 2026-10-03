/**
 * EINGANG-01D-2 Nacharbeit 2 — Archiv-Parität.
 *
 * Eine abgelegte Gutschrift liefert der KI dieselbe bereinigte fachliche
 * Wahrheit wie der Eingang — mit vorhandenem Eingangselement, ohne es
 * (Snapshot) und ohne `sourceInboxItemId`. Geprüft wird der gesamte Prompt
 * ausserhalb des OCR-Blocks, nicht nur die Truth-Zeilen. Der Quelltext bleibt
 * unverändert erhalten.
 */
import { importInboxDocumentForTests } from './test/confirmFilingDecisionForTests';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_COMPANY_PROFILE } from './data/companyProfileDefaults';
import { hydrateCompanyProfileStore } from './services/companyProfileService';
import { buildInboxItemFromClassification, classifyDocument } from './services/documentClassificationService';
import { buildDocumentAiContextFromDocument } from './services/document/documentAiContextService';
import { buildDocumentAiPrompt } from './services/document/documentAiPromptBuilder';
import { buildDocumentFieldFillConfirmViewModel } from './services/documentFieldFillConfirmService';
import { persistFillConfirmRowsToDocumentWorkOverlay } from './services/documentFieldFillConfirmPersistService';
import { resetDocumentWorkResultStoreForTests } from './services/documentWorkResultService';
import { hydrateDocumentStore } from './services/documentService';
import { getInboxItemById, hydrateInboxStore, markInboxImportedToArchive } from './services/inboxService';
import { processUploadedDocument } from './services/intakeWorkflowService';
import { hydrateExpenseStore } from './services/expenseStore';
import { setActiveStorageScope } from './services/storage/storageScopeService';
import { resetTestStores } from './test/resetStores';
import type { DocumentAiContext } from './types/areaAi';
import type { DocumentFieldFillConfirmRow } from './types/documentFieldFillConfirm';
import type { CompanyDocument, InboxItem } from './types/models';

const OWN = 'Mustermann Sanitär GmbH';
const TO_US = `An: ${OWN}\nHandwerkerweg 7\n10115 Berlin`;
const CREDIT = `Baustoff Meyer GmbH\nGutschrift\n${TO_US}\nGutschriftsnummer: GS-2026-17\nDatum: 01.10.2026\nRücknahme Material\nGutschrift brutto 119,00 EUR`;
const CREDIT_WITH_REPLY = `${CREDIT}\nBitte bestätigen Sie den Erhalt dieser Gutschrift bis zum 20.10.2026.`;
const INVOICE_COPY = `Baustoff Meyer GmbH\nRechnung\n${TO_US}\nRechnungsnummer: RE-2026-1\nMaterial 100,00 EUR\nGesamtbetrag 119,00 EUR\nZahlbar bis 15.09.2026`;

/**
 * Fremde Rechnungsinformation ausserhalb des Quelltexts — als Wahrheit, Bedeutung, Termin oder Handlungsbedarf.
 * „; ist eine Forderung an uns" ist die Rolle eines einzelnen Betrags („Gesamtforderung; ist eine Forderung
 * an uns"); der Sammelsatz „Keiner der genannten Beträge ist eine Forderung an uns" ist korrekt.
 * Ein Handlungsbedarf aus Zahlung ist fremd; eine eigene Antwortfrist der Gutschrift darf ihn tragen.
 */
const FOREIGN_INVOICE_TRUTH =
  /15\.09\.2026|2026-09-15|RE-2026-1|Rechnungsdaten prüfen|; ist eine Forderung an uns|Zahlungsfrist[^\n]*(?<!KEINE )Handlung durch uns erforderlich|Zusammenfassung: Eingangsrechnung/;
/** Gutschrift ohne eigene Frist: überhaupt kein Handlungsbedarf. */
const ANY_ACTION_REQUIRED = /(?<!KEINE )Handlung durch uns erforderlich/;

beforeEach(() => {
  setActiveStorageScope({ type: 'guest' });
  localStorage.clear();
  resetDocumentWorkResultStoreForTests();
  hydrateDocumentStore([]);
  hydrateExpenseStore([]);
  hydrateCompanyProfileStore({ ...DEFAULT_COMPANY_PROFILE, companyName: OWN, street: 'Handwerkerweg 7', zip: '10115', city: 'Berlin' });
});

afterEach(() => {
  resetDocumentWorkResultStoreForTests();
  resetTestStores();
  localStorage.clear();
});

function intakeItem(id: string, pages: string[]): InboxItem {
  const text = pages.join('\n');
  const pageTexts = pages.length > 1 ? pages.map((page, index) => ({ pageNumber: index + 1, text: page })) : undefined;
  const classification = classifyDocument({ recognizedText: text, sourceFileName: 'beleg.pdf', pageTexts });
  return {
    ...buildInboxItemFromClassification(classification),
    id,
    status: 'neu',
    receivedAt: '2026-10-01T10:00:00.000Z',
    createdAt: '2026-10-01T10:00:00.000Z',
    updatedAt: '2026-10-01T10:00:00.000Z',
    markedAsCompanyDocument: true,
    recognizedData: {
      ...classification.recognizedData,
      _extractedText: text,
      ...(pageTexts ? { _pageTexts: JSON.stringify(pageTexts) } : {}),
    },
  } as InboxItem;
}

/** Analyse festschreiben und über den echten Ablageweg archivieren (inkl. Archiv-Snapshot). */
function analyze(item: InboxItem): void {
  hydrateInboxStore([item]);
  expect(processUploadedDocument(item.id)).not.toBeNull();
}

function archive(item: InboxItem): CompanyDocument {
  const imported = importInboxDocumentForTests(getInboxItemById(item.id)!, OWN);
  if (!imported.success) throw new Error('Ablage fehlgeschlagen');
  markInboxImportedToArchive(item.id, imported.document.id);
  expect(imported.document.archiveTruthSnapshot).toBeTruthy();
  return imported.document;
}

const prompt = (context: DocumentAiContext) => buildDocumentAiPrompt('Bis wann muss ich das bezahlen?', context, 'de');
const outsideSourceText = (text: string) => text.replace(/<<<OCR_DATEN>>>[\s\S]*?<<<ENDE_OCR_DATEN>>>/g, '');
const truthOf = (context: DocumentAiContext) => (context.documentWorkTruthFactLines ?? []).join('\n');

function expectCleanCreditArchive(context: DocumentAiContext): void {
  const full = prompt(context);
  // Der Quelltext bleibt vollständig erhalten — inklusive der Rechnungskopie.
  expect(full).toMatch(/<<<OCR_DATEN>>>[\s\S]*Zahlbar bis 15\.09\.2026[\s\S]*<<<ENDE_OCR_DATEN>>>/);
  expect(full).toMatch(/<<<OCR_DATEN>>>[\s\S]*RE-2026-1[\s\S]*<<<ENDE_OCR_DATEN>>>/);
  // Ausserhalb des Quelltexts: keine fremde Frist, kein Termin, keine Forderung, kein Rechnungsschritt.
  expect(outsideSourceText(full)).not.toMatch(FOREIGN_INVOICE_TRUTH);
  expect(outsideSourceText(full)).not.toMatch(ANY_ACTION_REQUIRED);
  expect(context.semantic?.deadlines.some((frist) => frist.type === 'payment_due')).toBe(false);
  expect(context.semantic?.primaryActionDeadline?.type).not.toBe('payment_due');
  expect(context.semantic?.amounts.some((betrag) => betrag.isClaimAgainstUs)).toBe(false);
  const truth = truthOf(context);
  expect(truth.length).toBeGreaterThan(0);
  expect(truth).not.toMatch(/^Frist:|Rechnungsdaten|rechnungsnummer|zahlbar|Forderung|Eingangsrechnung/im);
}

describe('Archiv-Parität — abgelegte Gutschrift mit Rechnungskopie', () => {
  it('Archiv 1: Eingangselement vorhanden → gesamter Prompt ausserhalb OCR sauber, Gutschrift-Schritt', () => {
    const item = intakeItem('inbox-arch-1', [CREDIT, INVOICE_COPY]);
    analyze(item);
    const document = archive(item);
    expect(document.classifiedKind).toBe('gutschrift');
    const context = buildDocumentAiContextFromDocument(document);
    expectCleanCreditArchive(context);
    expect(truthOf(context)).toMatch(/^Nächster Schritt: Gutschrift als Ausgabe erfassen$/m);
  });

  it('Archiv 2: Eingangselement nicht mehr vorhanden (Snapshot) → keine Rückkehr der Rechnungsdaten', () => {
    const item = intakeItem('inbox-arch-2', [CREDIT, INVOICE_COPY]);
    analyze(item);
    const document = archive(item);
    hydrateInboxStore([]);
    expect(getInboxItemById(item.id)).toBeUndefined();
    const context = buildDocumentAiContextFromDocument(document);
    expectCleanCreditArchive(context);
    expect(truthOf(context)).toMatch(/^Nächster Schritt: Gutschrift als Ausgabe erfassen$/m);
  });

  it('Archiv 3: ohne sourceInboxItemId (Snapshot) → sauber; ohne Snapshot (Altbestand) → Bedeutung sauber', () => {
    const item = intakeItem('inbox-arch-3', [CREDIT, INVOICE_COPY]);
    analyze(item);
    const document = archive(item);
    hydrateInboxStore([]);
    const withoutSource = { ...document, sourceInboxItemId: undefined } as CompanyDocument;
    expectCleanCreditArchive(buildDocumentAiContextFromDocument(withoutSource));

    const legacy = { ...withoutSource, archiveTruthSnapshot: undefined } as CompanyDocument;
    const legacyContext = buildDocumentAiContextFromDocument(legacy);
    const legacyPrompt = prompt(legacyContext);
    expect(legacyPrompt).toMatch(/<<<OCR_DATEN>>>[\s\S]*Zahlbar bis 15\.09\.2026/);
    expect(outsideSourceText(legacyPrompt)).not.toMatch(FOREIGN_INVOICE_TRUTH);
    expect(outsideSourceText(legacyPrompt)).not.toMatch(ANY_ACTION_REQUIRED);
    expect(legacyContext.semantic?.deadlines.some((frist) => frist.type === 'payment_due')).toBe(false);
  });
});

describe('Archiv-Parität — Gegenkontrollen', () => {
  it('Archiv 4: normale Eingangsrechnung im Archiv behält ihre echten Rechnungsdaten (mit und ohne Eingangselement)', () => {
    const item = intakeItem('inbox-arch-4', [INVOICE_COPY]);
    expect(item.classifiedKind).toBe('eingangsrechnung');
    analyze(item);
    const document = archive(item);
    for (const inbox of [[getInboxItemById(item.id)!], []]) {
      hydrateInboxStore(inbox);
      const context = buildDocumentAiContextFromDocument(document);
      const outside = outsideSourceText(prompt(context));
      expect(outside).toMatch(/Termin: 15\.09\.2026 — Zahlungsfrist/);
      expect(context.semantic?.deadlines.some((frist) => frist.type === 'payment_due')).toBe(true);
      expect(truthOf(context)).toMatch(/^Frist: 15\.09\.2026$/m);
      expect(truthOf(context)).toMatch(/Rechnungsdaten prüfen/);
    }
  });

  it('Archiv 5: Gutschrift mit eigener Antwortfrist behält sie (mit und ohne Eingangselement), fremde Frist bleibt draussen', () => {
    const item = intakeItem('inbox-arch-5', [CREDIT_WITH_REPLY, INVOICE_COPY]);
    expect(item.deadline).toBe('2026-10-20');
    analyze(item);
    const document = archive(item);
    for (const inbox of [[getInboxItemById(item.id)!], []]) {
      hydrateInboxStore(inbox);
      const context = buildDocumentAiContextFromDocument(document);
      expect(truthOf(context)).toMatch(/^Frist: 20\.10\.2026$/m);
      expect(context.semantic?.deadlines.some((frist) => frist.type === 'response_due' && frist.date === '2026-10-20')).toBe(true);
      const outside = outsideSourceText(prompt(context));
      expect(outside).not.toMatch(FOREIGN_INVOICE_TRUTH);
      expect(outside).toMatch(/Termin: 20\.10\.2026 — Antwortfrist[^\n]*; Handlung durch uns erforderlich/);
    }
  });

  it('Archiv 6: echte Nutzerbestätigung und -korrektur bleiben im Archiv erhalten (mit und ohne Eingangselement)', () => {
    const item = intakeItem('inbox-arch-6', [CREDIT, INVOICE_COPY]);
    analyze(item);
    const rows = buildDocumentFieldFillConfirmViewModel(getInboxItemById(item.id)!).rows.map((row): DocumentFieldFillConfirmRow => {
      if (row.fieldKey === 'Betrag') return { ...row, status: 'confirmed', confirmedValue: '125,00 EUR' };
      // Eine vom Nutzer korrigierte Frist ist Nutzerwahrheit — die Projektion würde eine analysierte Frist entfernen.
      if (row.fieldKey === 'Frist') return { ...row, status: 'confirmed', confirmedValue: '30.10.2026' };
      if (row.fieldKey === 'Absender') return { ...row, status: 'confirmed', confirmedValue: row.proposedValue.trim() };
      return row;
    });
    expect(persistFillConfirmRowsToDocumentWorkOverlay({ inboxItemId: item.id, rows }).success).toBe(true);
    const document = archive(item);
    for (const inbox of [[getInboxItemById(item.id)!], []]) {
      hydrateInboxStore(inbox);
      const context = buildDocumentAiContextFromDocument(document);
      const truth = truthOf(context);
      expect(truth).toMatch(/125,00.*\[Nutzerkorrektur\]$/m);
      expect(truth).toMatch(/Baustoff Meyer GmbH \[Nutzerbestätigung\]$/m);
      expect(truth).toMatch(/^Frist: (30\.10\.2026|2026-10-30) \[Nutzerkorrektur\]$/m);
      expect(outsideSourceText(prompt(context))).not.toMatch(FOREIGN_INVOICE_TRUTH);
    }
  });
});

/*
 * Nacharbeit 3 — Archiv-Seitengrenzen. Die Fristen einer Gutschrift gehören
 * Seite 1. Das Archivformat ist exakt das von `buildRecognizedTextFromInbox`:
 * `_pageTexts: <JSON>` als eine Zeile, danach weitere Zeilen und der angehängte
 * Vorschlagstext.
 */
const COPY_WITH_REPLY = `${INVOICE_COPY}\nBitte antworten Sie bis zum 25.10.2026.`;
const PAGE_TWO_VARIANTS = {
  'A Antwortfrist': COPY_WITH_REPLY,
  'B nur Zahlungsfrist': INVOICE_COPY,
  'C Unterlagenfrist': `${INVOICE_COPY}\nBitte reichen Sie die Lieferscheine bis zum 25.10.2026 ein.`,
} as const;
const PAGE_TWO_DATES = /25\.10\.2026|2026-10-25|15\.09\.2026|2026-09-15/;

function expectProductionArchiveFormat(document: CompanyDocument, item: InboxItem): void {
  const suggestion = getInboxItemById(item.id)?.officePilotSuggestion ?? item.officePilotSuggestion;
  expect(suggestion, 'Vorschlagstext fehlt — Testfall wäre nicht produktionsnah').toBeTruthy();
  expect(document.recognizedText).toMatch(/\n_pageTexts: \[\{.*\}\]\n/);
  expect(document.recognizedText.endsWith(`\n\n${suggestion}`)).toBe(true);
}

function archivedWithoutSource(document: CompanyDocument): Array<[string, CompanyDocument]> {
  return [
    ['Quelle fehlt', document],
    ['ohne sourceInboxItemId', { ...document, sourceInboxItemId: undefined } as CompanyDocument],
  ];
}

describe('Archiv-Seitengrenzen — Fristen einer Gutschrift gehören Seite 1', () => {
  for (const [variant, pageTwo] of Object.entries(PAGE_TWO_VARIANTS)) {
    it(`Seite 2 (${variant}) ohne Eingangselement → keine Frist, kein Termin mit Handlungsbedarf, OCR vollständig`, () => {
      const item = intakeItem(`inbox-pages-${variant[0]}`, [CREDIT, pageTwo]);
      expect(item.deadline ?? null).toBeNull();
      analyze(item);
      const document = archive(item);
      expectProductionArchiveFormat(document, item);
      hydrateInboxStore([]);
      for (const [label, archived] of archivedWithoutSource(document)) {
        const context = buildDocumentAiContextFromDocument(archived);
        const full = prompt(context);
        expect(truthOf(context), label).not.toMatch(/^Frist:/m);
        expect(outsideSourceText(full), label).not.toMatch(PAGE_TWO_DATES);
        expect(outsideSourceText(full), label).not.toMatch(ANY_ACTION_REQUIRED);
        expect(context.semantic?.deadlines.some((frist) => frist.actionRequired), label).toBe(false);
        expect(full, label).toMatch(/<<<OCR_DATEN>>>[\s\S]*Zahlbar bis 15\.09\.2026[\s\S]*<<<ENDE_OCR_DATEN>>>/);
        if (pageTwo.includes('25.10.2026')) {
          expect(full, label).toMatch(/<<<OCR_DATEN>>>[\s\S]*25\.10\.2026[\s\S]*<<<ENDE_OCR_DATEN>>>/);
        }
      }
    });
  }

  it('eigene Antwortfrist auf Seite 1 (20.10.) bleibt, fremde Frist von Seite 2 (25.10.) bleibt draussen — ohne Eingangselement', () => {
    const item = intakeItem('inbox-pages-own', [CREDIT_WITH_REPLY, COPY_WITH_REPLY]);
    expect(item.deadline).toBe('2026-10-20');
    analyze(item);
    const document = archive(item);
    expectProductionArchiveFormat(document, item);
    hydrateInboxStore([]);
    for (const [label, archived] of archivedWithoutSource(document)) {
      const context = buildDocumentAiContextFromDocument(archived);
      const outside = outsideSourceText(prompt(context));
      expect(truthOf(context), label).toMatch(/^Frist: 20\.10\.2026$/m);
      expect(context.semantic?.deadlines.some((frist) => frist.type === 'response_due' && frist.date === '2026-10-20'), label).toBe(true);
      expect(outside, label).toMatch(/Termin: 20\.10\.2026 — Antwortfrist[^\n]*; Handlung durch uns erforderlich/);
      expect(outside, label).not.toMatch(PAGE_TWO_DATES);
      expect(prompt(context), label).toMatch(/<<<OCR_DATEN>>>[\s\S]*25\.10\.2026[\s\S]*<<<ENDE_OCR_DATEN>>>/);
    }
  });

  it('mit Eingangselement (deadline null) → die Seite-2-Frist wird nicht über die Archivlogik eingeschleust', () => {
    const item = intakeItem('inbox-pages-source', [CREDIT, COPY_WITH_REPLY]);
    expect(item.deadline ?? null).toBeNull();
    analyze(item);
    const document = archive(item);
    expect(getInboxItemById(item.id)?.deadline ?? null).toBeNull();
    const context = buildDocumentAiContextFromDocument(document);
    expect(truthOf(context)).not.toMatch(/^Frist:/m);
    expect(outsideSourceText(prompt(context))).not.toMatch(PAGE_TWO_DATES);
    expect(outsideSourceText(prompt(context))).not.toMatch(ANY_ACTION_REQUIRED);
  });

  it('Source-Priorität: die kanonische Frist des Eingangselements gilt, auch wenn Seite 1 etwas anderes nahelegt (keine Umdeutung)', () => {
    const item = intakeItem('inbox-pages-priority', [CREDIT_WITH_REPLY, COPY_WITH_REPLY]);
    expect(item.deadline).toBe('2026-10-20');
    analyze(item);
    const document = archive(item);
    // Die Eingangswahrheit trägt eine andere kanonische Frist — sie wird nicht aus dem Archivtext neu abgeleitet.
    hydrateInboxStore([{ ...getInboxItemById(item.id)!, deadline: '2026-11-05', deadlineType: 'response_due' }]);
    const context = buildDocumentAiContextFromDocument(document);
    expect(truthOf(context)).toMatch(/^Frist: 05\.11\.2026$/m);
    expect(truthOf(context)).not.toMatch(/^Frist: 20\.10\.2026$/m);
  });

  it('Altbestand mit _pageTexts (ohne Snapshot, ohne Eingangselement) → Seitenregel gilt auch für die Bedeutung', () => {
    const item = intakeItem('inbox-pages-legacy', [CREDIT, COPY_WITH_REPLY]);
    analyze(item);
    const document = archive(item);
    hydrateInboxStore([]);
    const legacy = { ...document, sourceInboxItemId: undefined, archiveTruthSnapshot: undefined } as CompanyDocument;
    const context = buildDocumentAiContextFromDocument(legacy);
    expect(outsideSourceText(prompt(context))).not.toMatch(PAGE_TWO_DATES);
    expect(context.semantic?.deadlines.some((frist) => frist.actionRequired)).toBe(false);
  });

  it('normale Rechnung mit Antwortfrist auf Seite 2 → Rechnungsfristen bleiben (ohne Eingangselement)', () => {
    const item = intakeItem('inbox-pages-invoice', [INVOICE_COPY, 'Baustoff Meyer GmbH\nAnlage\nBitte antworten Sie bis zum 25.10.2026.']);
    expect(item.classifiedKind).toBe('eingangsrechnung');
    analyze(item);
    const document = archive(item);
    hydrateInboxStore([]);
    const context = buildDocumentAiContextFromDocument(document);
    const outside = outsideSourceText(prompt(context));
    expect(context.semantic?.deadlines.some((frist) => frist.type === 'payment_due' && frist.date === '2026-09-15')).toBe(true);
    expect(context.semantic?.deadlines.some((frist) => frist.type === 'response_due' && frist.date === '2026-10-25')).toBe(true);
    expect(outside).toMatch(/Termin: 15\.09\.2026 — Zahlungsfrist[^\n]*; Handlung durch uns erforderlich/);
    expect(truthOf(context)).toMatch(/^Frist: 15\.09\.2026$/m);
  });
});

/*
 * Nacharbeit 4 — operative Hauptfrist und semantische Pflichten sind zwei
 * Ebenen. Die Hauptfrist bleibt genau eine (`Frist:` in der Truth); die
 * Bedeutung darf mehrere eigene Pflichten des Hauptdokuments tragen. Fremd
 * sind nur Pflichten späterer Seiten.
 */
const TWO_DUTIES = `${CREDIT}\nBitte bestätigen Sie den Erhalt dieser Gutschrift bis zum 20.10.2026.\nBitte senden Sie das Leergut bis zum 31.10.2026 zurück.`;
const COPY_PAYABLE_2510 = `Baustoff Meyer GmbH\nRechnung\n${TO_US}\nRechnungsnummer: RE-2026-1\nMaterial 100,00 EUR\nGesamtbetrag 119,00 EUR\nZahlbar bis 25.10.2026`;

function expectOwnDuty(context: DocumentAiContext, iso: string, sentence: RegExp, label: string): void {
  const display = `${iso.slice(8, 10)}.${iso.slice(5, 7)}.${iso.slice(0, 4)}`;
  expect(
    context.semantic?.obligations.some((pflicht) => pflicht.who === 'own_company' && pflicht.byWhen === iso),
    `${label}: eigene Pflicht bis ${display}`,
  ).toBe(true);
  expect(
    context.semantic?.deadlines.some((frist) => frist.actionRequired && frist.date === iso),
    `${label}: Termin ${display} mit Handlungsbedarf`,
  ).toBe(true);
  const outside = outsideSourceText(prompt(context));
  expect(outside, label).toMatch(new RegExp(`Von uns verlangt: ${sentence.source}[^\\n]*\\(bis ${display.replace(/\./g, '\\.')}\\)`));
  expect(outside, label).toMatch(new RegExp(`Termin: ${display.replace(/\./g, '\\.')} — [^\\n]*; Handlung durch uns erforderlich`));
}
const CONFIRM_RECEIPT = /Bitte bestätigen Sie den Erhalt dieser Gutschrift bis zum 20\.10\.2026\./;
const RETURN_EMPTIES = /Bitte senden Sie das Leergut bis zum 31\.10\.2026 zurück\./;

describe('Nacharbeit 4 — mehrere eigene Pflichten einer Gutschrift bleiben, fremde Seiten nicht', () => {
  it('A/B: einseitige Gutschrift, zwei eigene Pflichten — mit Eingangselement (Hauptfrist 20.10.), ohne und ohne sourceInboxItemId', () => {
    const item = intakeItem('inbox-duties-one', [TWO_DUTIES]);
    expect(item.deadline).toBe('2026-10-20');
    analyze(item);
    const document = archive(item);
    const variants: Array<[string, CompanyDocument, InboxItem[]]> = [
      ['mit Eingangselement', document, [getInboxItemById(item.id)!]],
      ['Quelle fehlt', document, []],
      ['ohne sourceInboxItemId', { ...document, sourceInboxItemId: undefined } as CompanyDocument, []],
    ];
    for (const [label, archived, inbox] of variants) {
      hydrateInboxStore(inbox);
      const context = buildDocumentAiContextFromDocument(archived);
      expectOwnDuty(context, '2026-10-20', CONFIRM_RECEIPT, label);
      expectOwnDuty(context, '2026-10-31', RETURN_EMPTIES, label);
      expect(outsideSourceText(prompt(context)), label).toMatch(/Anliegen: 2 Handlungen werden verlangt/);
      // Genau eine operative Hauptfrist.
      expect(truthOf(context).match(/^Frist:/gm), label).toHaveLength(1);
      expect(truthOf(context), label).toMatch(/^Frist: 20\.10\.2026$/m);
    }
  });

  it('C: Eingangselement mit deadline null → beide eigenen Pflichten bleiben, keine Hauptfrist erfunden', () => {
    const item = intakeItem('inbox-duties-null', [TWO_DUTIES]);
    analyze(item);
    const document = archive(item);
    hydrateInboxStore([{ ...getInboxItemById(item.id)!, deadline: null, deadlineType: undefined }]);
    const context = buildDocumentAiContextFromDocument(document);
    expect(truthOf(context)).not.toMatch(/^Frist:/m);
    expectOwnDuty(context, '2026-10-20', CONFIRM_RECEIPT, 'deadline null');
    expectOwnDuty(context, '2026-10-31', RETURN_EMPTIES, 'deadline null');
  });

  it('D: Seite 1 zwei eigene Pflichten + Seite 2 fremde Zahlungsfrist → 20.10. und 31.10. bleiben, 25.10. ist keine eigene Pflicht', () => {
    const item = intakeItem('inbox-duties-pages', [TWO_DUTIES, COPY_PAYABLE_2510]);
    expect(item.deadline).toBe('2026-10-20');
    analyze(item);
    const document = archive(item);
    expectProductionArchiveFormat(document, item);
    const variants: Array<[string, CompanyDocument, InboxItem[]]> = [
      ['mit Eingangselement', document, [getInboxItemById(item.id)!]],
      ['Quelle fehlt', document, []],
      ['ohne sourceInboxItemId', { ...document, sourceInboxItemId: undefined } as CompanyDocument, []],
    ];
    for (const [label, archived, inbox] of variants) {
      hydrateInboxStore(inbox);
      const context = buildDocumentAiContextFromDocument(archived);
      expectOwnDuty(context, '2026-10-20', CONFIRM_RECEIPT, label);
      expectOwnDuty(context, '2026-10-31', RETURN_EMPTIES, label);
      // Fremd: die Zahlungsfrist der Rechnungskopie — weder als Termin, Pflicht noch Hauptfrist.
      expect(context.semantic?.deadlines.some((frist) => frist.date === '2026-10-25'), label).toBe(false);
      expect(context.semantic?.obligations.some((pflicht) => pflicht.byWhen === '2026-10-25'), label).toBe(false);
      expect(outsideSourceText(prompt(context)), label).not.toMatch(/25\.10\.2026|2026-10-25/);
      expect(truthOf(context), label).toMatch(/^Frist: 20\.10\.2026$/m);
      expect(prompt(context), label).toMatch(/<<<OCR_DATEN>>>[\s\S]*Zahlbar bis 25\.10\.2026[\s\S]*<<<ENDE_OCR_DATEN>>>/);
      expect(outsideSourceText(prompt(context)), label).toMatch(/Anliegen: 2 Handlungen werden verlangt/);
    }
  });

  it('F: Seite 1 ohne eigene Frist, Seite 2 payment_due → keine eigene Zahlungsfrist, keine eigene Zahlungspflicht', () => {
    const item = intakeItem('inbox-duties-pay', [CREDIT, INVOICE_COPY]);
    analyze(item);
    const document = archive(item);
    hydrateInboxStore([]);
    for (const archived of [document, { ...document, sourceInboxItemId: undefined } as CompanyDocument]) {
      const context = buildDocumentAiContextFromDocument(archived);
      expect(context.semantic?.deadlines.some((frist) => frist.type === 'payment_due')).toBe(false);
      expect(context.semantic?.obligations.some((pflicht) => pflicht.who === 'own_company')).toBe(false);
      expect(outsideSourceText(prompt(context))).not.toMatch(/Von uns verlangt|15\.09\.2026/);
    }
  });

  it('ohne Originaltext (nur Feldliste, Snapshot, ohne Eingangselement) → keine Pflicht der Kopie aus Feldern oder gespeicherter Analyse', () => {
    const item = intakeItem('inbox-duties-fields', [CREDIT, COPY_WITH_REPLY]);
    analyze(item);
    const document = archive(item);
    hydrateInboxStore([]);
    const fieldListOnly = document.recognizedText
      .split('\n')
      .filter((line) => /^[A-Za-zÄÖÜäöüß]+: /.test(line))
      .join('\n');
    expect(fieldListOnly).toMatch(/^Frist: /m);
    expect(fieldListOnly).not.toMatch(/_extractedText|_pageTexts|25\.10\.2026/);
    const context = buildDocumentAiContextFromDocument({ ...document, recognizedText: fieldListOnly, sourceInboxItemId: undefined } as CompanyDocument);
    expect(truthOf(context)).not.toMatch(/^Frist:/m);
    expect(context.semantic?.deadlines.some((frist) => frist.actionRequired)).toBe(false);
    expect(outsideSourceText(prompt(context))).not.toMatch(ANY_ACTION_REQUIRED);
  });

  it('G: kanonische 05.11. des Eingangselements bleibt einzige Hauptfrist; eigene Seite-1-Pflichten bleiben in der Bedeutung', () => {
    const item = intakeItem('inbox-duties-canonical', [TWO_DUTIES, COPY_PAYABLE_2510]);
    analyze(item);
    const document = archive(item);
    hydrateInboxStore([{ ...getInboxItemById(item.id)!, deadline: '2026-11-05', deadlineType: 'response_due' }]);
    const context = buildDocumentAiContextFromDocument(document);
    expect(truthOf(context).match(/^Frist:/gm)).toHaveLength(1);
    expect(truthOf(context)).toMatch(/^Frist: 05\.11\.2026$/m);
    expectOwnDuty(context, '2026-10-20', CONFIRM_RECEIPT, 'kanonisch 05.11.');
    expectOwnDuty(context, '2026-10-31', RETURN_EMPTIES, 'kanonisch 05.11.');
    expect(outsideSourceText(prompt(context))).not.toMatch(/25\.10\.2026/);
  });
});
