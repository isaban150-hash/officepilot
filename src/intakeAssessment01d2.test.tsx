/**
 * EINGANG-01D-2 — sichtbare Einschätzung und korrekte Aktionen.
 *
 * Echter Pfad: Klassifikation → Eingang → `EingangDetailPage`
 * (`DocumentReviewExperience` mit Karte, Einschätzung und Bedeutungsbereich) →
 * Hauptaktion → bestehender `createExpenseFromInbox`-Weg. Dazu reine Fälle der
 * Projection für die Zuordnung (sicher / Vorschlag / mehrdeutig).
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { AppProvider } from './context/AppContext';
import { DEFAULT_SETUP } from './data/mockData';
import { DEFAULT_COMPANY_PROFILE } from './data/companyProfileDefaults';
import { EingangDetailPage } from './pages/EingangDetailPage';
import { hydrateCompanyProfileStore } from './services/companyProfileService';
import { buildInboxItemFromClassification, classifyDocument } from './services/documentClassificationService';
import { buildDocumentSummary } from './services/documentSummary';
import {
  deriveIntakeAssessment,
  formatIntakeAssessmentAssignment,
} from './services/document/intakeAssessmentService';
import { hydrateInboxStore } from './services/inboxService';
import { hydrateVorgangStore } from './services/vorgangService';
import { hydrateCustomerStore } from './services/customerStoreService';
import { hydrateExpenseStore } from './services/expenseStore';
import { addExpense, cancelExpense, getAllExpenses } from './services/expenseService';
import * as officeActionService from './services/officeActionService';
import { setActiveStorageScope } from './services/storage/storageScopeService';
import { t } from './i18n';
import {
  buildDocumentAiContextFromDocument,
  buildDocumentAiContextFromInbox,
  projectCreditNoteTruthFactLines,
} from './services/document/documentAiContextService';
import { buildDocumentAiPrompt } from './services/document/documentAiPromptBuilder';
import { buildDocumentGuidance, buildPrioritizedDocumentGuidance } from './services/documentGuidanceService';
import { analyzeUploadedDocument, commitUploadedDocumentAnalysis } from './services/intakeWorkflowService';
import { getDocumentWorkResult } from './services/documentWorkResultStoreService';
import { recordExpensePayment } from './services/expensePaymentService';
import { createTestVorgang } from './test/fixtures';
import type { DocumentSummary } from './types/documentSummary';
import type { CompanyDocument, InboxItem } from './types/models';

const ITEM_ID = 'inbox-01d2';
const OWN = 'Mustermann Sanitär GmbH';
const TO_US = `An: ${OWN}\nHandwerkerweg 7\n10115 Berlin`;
const translate = (key: Parameters<typeof t>[0]) => t(key, 'de');

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  setActiveStorageScope({ type: 'guest' });
  localStorage.clear();
  sessionStorage.clear();
  hydrateVorgangStore([]);
  hydrateCustomerStore([]);
  hydrateExpenseStore([]);
  hydrateCompanyProfileStore({ ...DEFAULT_COMPANY_PROFILE, companyName: OWN, street: 'Handwerkerweg 7', zip: '10115', city: 'Berlin' });
  host = document.createElement('div');
  host.className = 'app-shell__main';
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = '';
  localStorage.clear();
  vi.restoreAllMocks();
});

async function settle(rounds = 30): Promise<void> {
  for (let attempt = 0; attempt < rounds; attempt += 1) {
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
  }
}

function LocationProbe() {
  const location = useLocation();
  return createElement('span', { 'data-testid': 'location-probe' }, location.pathname + location.search);
}

function itemFrom(text: string, overrides: Partial<InboxItem> = {}, pageTexts?: Array<{ pageNumber: number; text: string }>): InboxItem {
  const classification = classifyDocument({ recognizedText: text, sourceFileName: 'beleg.pdf', pageTexts });
  return {
    ...buildInboxItemFromClassification(classification),
    id: ITEM_ID,
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
    ...overrides,
  } as InboxItem;
}

async function renderDetail(item: InboxItem): Promise<void> {
  hydrateInboxStore([item]);
  await act(async () => {
    root.render(
      createElement(
        MemoryRouter,
        { initialEntries: [`/ablage/${ITEM_ID}`] },
        createElement(
          AppProvider,
          { initialSetup: { ...DEFAULT_SETUP, setupComplete: true } },
          createElement(
            Routes,
            null,
            createElement(Route, { path: '/ablage/:id', element: createElement(EingangDetailPage) }),
            createElement(Route, { path: '*', element: createElement(LocationProbe) }),
          ),
        ),
      ),
    );
  });
  await settle();
}

const find = (testId: string): HTMLElement | null => host.querySelector(`[data-testid="${testId}"]`);
const text = (testId: string): string | null => find(testId)?.textContent?.trim() ?? null;
const cardText = (): string => find('document-experience-card')?.textContent ?? '';
const meaningText = (): string => find('document-meaning-panel')?.textContent ?? '';

async function click(element: HTMLElement): Promise<void> {
  await act(async () => {
    element.click();
  });
  await settle(10);
}

async function runPrimaryWithFilingConfirm(): Promise<void> {
  const primary = find('document-review-apply-button');
  expect(primary, 'Hauptaktion fehlt').not.toBeNull();
  await click(primary!);
  const confirm = find('document-filing-decision-confirm');
  if (confirm) await click(confirm);
  await settle(20);
}

const CREDIT = `Baustoff Meyer GmbH\nGutschrift\n${TO_US}\nGutschriftsnummer: GS-2026-17\nDatum: 01.10.2026\nRücknahme Material\nGutschrift brutto 119,00 EUR`;
const INVOICE_COPY = `Baustoff Meyer GmbH\nRechnung\n${TO_US}\nRechnungsnummer: RE-2026-1\nMaterial 100,00 EUR\nGesamtbetrag 119,00 EUR\nZahlbar bis 15.09.2026`;

describe('Einschätzung im Detail — sichtbar und aus vorhandener Wahrheit', () => {
  it('A: normale Eingangsrechnung ohne Ausgabe → Art, Absender, Zuordnung, Zahlungsfrist, Erfassen, Ausgabe erfassen, Sicher', async () => {
    await renderDetail(
      itemFrom(`Baustoff Meyer GmbH\nRechnung\n${TO_US}\nRechnungsnummer: R-2026-100\nRechnungsdatum: 01.10.2026\nNetto 100,00 EUR\nUSt 19,00 EUR\nGesamtbetrag 119,00 EUR\nZahlbar bis 15.10.2026`),
    );
    expect(text('intake-assessment-kind')).toBe('Eingangsrechnung');
    expect(text('intake-assessment-sender')).toBe('Baustoff Meyer GmbH');
    expect(text('intake-assessment-assignment')).toBe('Noch nicht zugeordnet');
    expect(text('intake-assessment-deadline')).toBe('Zahlung bis 15.10.2026');
    // Bestehender Aktionsvertrag: ohne Ausgabe zuerst erfassen, nicht „Zahlen".
    expect(text('intake-assessment-action')).toBe('Erfassen');
    expect(text('intake-assessment-next-step')).toBe('Ausgabe erfassen');
    expect(text('intake-assessment-status')).toBe('Sicher');
    expect(find('document-review-apply-button')?.textContent).toMatch(/Ausgabe erfassen/);
  });

  it('B: Lieferantengutschrift → Gutschrift, keine Zahlungsaufforderung, eigene Nummer, „Ausgabe erfassen" über den bestehenden Weg', async () => {
    const spy = vi.spyOn(officeActionService, 'createExpenseFromInbox');
    await renderDetail(itemFrom(CREDIT));
    expect(text('intake-assessment-kind')).toBe('Lieferantengutschrift');
    expect(text('intake-assessment-number')).toBe('GS-2026-17');
    expect(text('intake-assessment-action')).toBe('Erfassen');
    expect(text('intake-assessment-next-step')).toBe('Gutschrift als Ausgabe erfassen');
    expect(find('intake-assessment-deadline')).toBeNull();
    expect(cardText()).not.toMatch(/in Rechnung|Offene Gesamtforderung|Rechnung erkannt|Zahlung bis/);
    expect(meaningText()).not.toMatch(/Offene Gesamtforderung|Zahlung bis/);
    expect(find('document-review-apply-button')?.textContent).toMatch(/Gutschrift als Ausgabe erfassen/);

    await runPrimaryWithFilingConfirm();
    expect(spy).toHaveBeenCalled();
    expect(text('location-probe')).toBe(`/ausgaben/neu?inboxId=${ITEM_ID}`);
    expect(getAllExpenses()).toHaveLength(0);
  });

  it('C: Gutschrift + angehängte Rechnungskopie → keine Fälligkeit, keine fremde Nummer, kein „Zahlung bis", kein falsches „Ja"', async () => {
    await renderDetail(
      itemFrom(`${CREDIT}\n${INVOICE_COPY}`, {}, [
        { pageNumber: 1, text: CREDIT },
        { pageNumber: 2, text: INVOICE_COPY },
      ]),
    );
    expect(text('intake-assessment-kind')).toBe('Lieferantengutschrift');
    expect(find('intake-assessment-deadline')).toBeNull();
    expect(text('intake-assessment-number')).toBe('GS-2026-17');
    expect(cardText()).not.toMatch(/15\.09\.2026|RE-2026-1|Fällig\b|\bfällig\.|in Rechnung/);
    expect(meaningText()).not.toMatch(/Zahlung bis|15\.09\.2026|Offene Gesamtforderung/);
    expect(text('document-meaning-action')).not.toMatch(/^Ja\b|Muss ich etwas tun\?\s*Ja/);
  });

  it('D: eigene Kundengutschrift → Prüfen, kein „Ausgabe erfassen"', async () => {
    await renderDetail(
      itemFrom(`${OWN}\nGutschrift an Kunden\nHandwerkerweg 7 · 10115 Berlin\nSägewerk Flisch GmbH\nGutschrift GS-K-1\nDatum 01.10.2026\nGutschrift brutto -2.856,00 €`),
    );
    expect(text('intake-assessment-kind')).toBe('Gutschrift Ihres Betriebs');
    expect(text('intake-assessment-action')).toBe('Prüfen');
    expect(text('intake-assessment-status')).toBe('Prüfen');
    expect(find('document-review-apply-button')?.textContent ?? '').not.toMatch(/Ausgabe/);
    expect(find('document-review-apply-button')?.textContent ?? '').toMatch(/Prüfen und Ablage bestätigen/);
    expect(cardText()).not.toMatch(/Ausgabe erfassen/);
  });

  it.each([
    ['E: Rechnungskorrektur', `Baustoff Meyer GmbH\nRechnungskorrektur\n${TO_US}\nzur Rechnung R-2026-100 vom 01.10.2026\nRechnungsnummer: RK-2026-3\nGesamtbetrag 107,10 EUR`, 'Rechnungskorrektur', /Rechnungskorrektur erkannt/],
    ['F: Abrechnungsgutschrift', `Kunde AG\nAbrechnungsgutschrift\nGutschrift im Gutschriftsverfahren gemäß § 14 Abs. 2 UStG\nGutschriftsnummer: AG-55\nGesamtbetrag 1.190,00 EUR`, 'Abrechnungsgutschrift', /Abrechnungsgutschrift erkannt/],
  ])('%s → sichtbar als Prüffall, keine Ausgabe', async (_label, body, kind, lead) => {
    await renderDetail(itemFrom(body));
    expect(text('intake-assessment-kind')).toBe(kind);
    expect(text('intake-assessment-action')).toBe('Prüfen');
    expect(text('intake-assessment-status')).toBe('Prüfen');
    expect(text('intake-assessment-next-step')).toBe('Prüfen und Ablage bestätigen');
    expect(find('document-experience-lead')?.textContent ?? '').toMatch(lead);
    expect(find('document-review-apply-button')?.textContent ?? '').toMatch(/Prüfen und Ablage bestätigen/);
    expect(cardText()).not.toMatch(/Ausgabe erfassen/);
  });

  it('G: response_due → „Antwort bis", Antworten', async () => {
    await renderDetail(itemFrom(`Landratsamt Musterkreis\nAnhörung\n${TO_US}\nbitte nehmen Sie bis zum 20.10.2026 Stellung zu dem Sachverhalt.`));
    expect(text('intake-assessment-deadline')).toBe('Antwort bis 20.10.2026');
    expect(text('intake-assessment-action')).toBe('Antworten');
  });

  it('H: document_submission_due → „Unterlagen bis", Unterlagen einreichen', async () => {
    await renderDetail(itemFrom(`Landratsamt Musterkreis\nAnforderung\n${TO_US}\nBitte die fehlenden Unterlagen bis zum 25.10.2026 einreichen.`));
    expect(text('intake-assessment-deadline')).toBe('Unterlagen bis 25.10.2026');
    expect(text('intake-assessment-action')).toBe('Unterlagen einreichen');
  });

  it('I: Freistellung → Gültigkeit ist keine Handlungsfrist', async () => {
    await renderDetail(itemFrom(`Finanzamt Musterstadt\nFreistellungsbescheinigung nach § 48 b EStG\n${TO_US}\nDie Freistellung gilt bis zum 31.08.2029.`));
    expect(find('intake-assessment-deadline')).toBeNull();
    expect(text('intake-assessment-action')).not.toBe('Frist beachten');
  });

  it('J: bestätigt verknüpfter Vorgang mit VG-Nummer → Zugeordnet, Sicher', async () => {
    hydrateVorgangStore([createTestVorgang({ id: 'v-01d2', title: 'Bad Nordlicht', vorgangNumber: 'VG-2026-0007' })]);
    await renderDetail(
      itemFrom(`Baustoff Meyer GmbH\nRechnung\n${TO_US}\nRechnungsnummer: R-2026-101\nGesamtbetrag 119,00 EUR\nZahlbar bis 15.10.2026`, {
        vorgangId: 'v-01d2',
        vorgangTitle: 'Bad Nordlicht',
        vorgangLinkStatus: 'linked',
      }),
    );
    expect(text('intake-assessment-assignment')).toBe('Zugeordnet: VG-2026-0007');
    expect(text('intake-assessment-status')).toBe('Sicher');
  });

  it('L: bereits erfasste Gutschrift → keine zweite Ausgabe, vorhandene Ausgabe öffnen', async () => {
    const existing = addExpense({
      title: 'Gutschrift',
      category: 'material',
      supplierName: 'Baustoff Meyer GmbH',
      invoiceNumber: 'GS-2026-17',
      issueDate: '2026-10-01',
      grossAmount: -119,
      linkedInboxId: ITEM_ID,
    });
    expect(existing.success).toBe(true);
    if (!existing.success) return;
    await renderDetail(itemFrom(CREDIT));
    expect(text('intake-assessment-next-step')).toBe('Erfasste Ausgabe öffnen');
    expect(text('intake-assessment-action')).toBe('Keine Aktion');
    await runPrimaryWithFilingConfirm();
    expect(text('location-probe')).toBe(`/ausgaben/${existing.expense.id}`);
    expect(getAllExpenses()).toHaveLength(1);
  });
});

describe('Zuordnung in der Projection — exakt sicher, unscharf nie sicher', () => {
  const base = itemFrom(`Baustoff Meyer GmbH\nRechnung\n${TO_US}\nRechnungsnummer: R-2026-102\nGesamtbetrag 119,00 EUR`);
  function summaryWith(caseMatch: DocumentSummary['caseMatch']): DocumentSummary {
    hydrateInboxStore([base]);
    return { ...buildDocumentSummary(base, null, { translate }), caseMatch };
  }

  it('J2: exakter deterministischer Treffer (nicht verknüpft) → „Passender Vorgang", Sicher', () => {
    const assessment = deriveIntakeAssessment({
      item: base,
      summary: summaryWith({ matchStatus: 'exact', matchedCaseId: 'v-1', matchedCaseTitle: 'Bad Nordlicht', reasons: ['same_invoice_number'], candidates: [] }),
      hasLinkedExpense: false,
      ownCompanyName: OWN,
    });
    expect(assessment.assignment).toEqual({ state: 'exact', target: 'Bad Nordlicht' });
    expect(formatIntakeAssessmentAssignment(assessment, translate)).toBe('Passender Vorgang: Bad Nordlicht');
    expect(assessment.status).toBe('sicher');
  });

  it('K: unscharfer Vorschlag → „Vorschlag … – bitte prüfen", Wahrscheinlich, nie sicher', () => {
    const assessment = deriveIntakeAssessment({
      item: base,
      summary: summaryWith({ matchStatus: 'likely', matchedCaseId: 'v-1', matchedCaseTitle: 'Bad Nordlicht', reasons: ['same_supplier'], candidates: [] }),
      hasLinkedExpense: false,
      ownCompanyName: OWN,
    });
    expect(assessment.assignment.state).toBe('likely');
    expect(formatIntakeAssessmentAssignment(assessment, translate)).toBe('Vorschlag: Bad Nordlicht – bitte prüfen');
    expect(assessment.status).toBe('wahrscheinlich');
  });

  it('K2: mehrere Kandidaten → „Mehrere mögliche Vorgänge", Prüfen', () => {
    const assessment = deriveIntakeAssessment({
      item: base,
      summary: summaryWith({ matchStatus: 'multiple', matchedCaseId: null, matchedCaseTitle: null, reasons: [], candidates: [] }),
      hasLinkedExpense: false,
      ownCompanyName: OWN,
    });
    expect(assessment.assignment.state).toBe('multiple');
    expect(assessment.status).toBe('pruefen');
  });
});

describe('KI-/Assistenten-Kontext folgt der Hauptdokument-Wahrheit', () => {
  it('Gutschrift + Rechnungskopie → keine fremde Frist, keine fremde Nummer, keine Zahlungsfrist im Kern', () => {
    const item = itemFrom(`${CREDIT}\n${INVOICE_COPY}`, {}, [
      { pageNumber: 1, text: CREDIT },
      { pageNumber: 2, text: INVOICE_COPY },
    ]);
    hydrateInboxStore([item]);
    const context = buildDocumentAiContextFromInbox(item);
    expect(context.deadline ?? null).toBeNull();
    // Strukturierte Angaben (der Rohtext `_…` bleibt bewusst Referenzkontext).
    const structured = context.recognizedDataLines.filter((line) => !line.startsWith('_')).join('\n');
    expect(structured).not.toMatch(/RE-2026-1|15\.09\.2026|^Rechnungsnummer:|^Frist:/m);
    expect(structured).toMatch(/^Gutschriftsnummer: GS-2026-17$/m);
    expect(context.semantic?.primaryActionDeadline).toBeUndefined();
    expect(context.semantic?.deadlines.some((frist) => frist.type === 'payment_due')).toBe(false);
    expect(context.semantic?.amounts.some((betrag) => betrag.isClaimAgainstUs)).toBe(false);
  });

  it('Kontrolle: normale Rechnung behält Zahlungsfrist und Rechnungsnummer im Kontext', () => {
    const item = itemFrom(INVOICE_COPY);
    hydrateInboxStore([item]);
    const context = buildDocumentAiContextFromInbox(item);
    expect(context.deadline).toBe('2026-09-15');
    expect(context.recognizedDataLines.join('\n')).toMatch(/RE-2026-1/);
  });
});

describe('Nacharbeit 1 — „Zahlen" nur bei offenem Betrag (bestehende Finanzwahrheit)', () => {
  const INVOICE = `Baustoff Meyer GmbH\nRechnung\n${TO_US}\nRechnungsnummer: R-2026-700\nRechnungsdatum: 01.10.2026\nNetto 100,00 EUR\nUSt 19,00 EUR\nGesamtbetrag 119,00 EUR\nZahlbar bis 15.10.2026`;
  function linkedExpense(): string {
    const created = addExpense({
      title: 'Rechnung',
      category: 'material',
      supplierName: 'Baustoff Meyer GmbH',
      invoiceNumber: 'R-2026-700',
      issueDate: '2026-10-01',
      grossAmount: 119,
      netAmount: 100,
      taxAmount: 19,
      linkedInboxId: ITEM_ID,
    } as Parameters<typeof addExpense>[0]);
    if (!created.success) throw new Error('Ausgabe nicht angelegt');
    return created.expense.id;
  }

  it('A: verknüpfte offene Ausgabe → Zahlen', async () => {
    linkedExpense();
    await renderDetail(itemFrom(INVOICE));
    expect(text('intake-assessment-action')).toBe('Zahlen');
  });

  it('B: teilweise bezahlt, Restbetrag offen → Zahlen', async () => {
    const id = linkedExpense();
    expect(recordExpensePayment(id, { date: '2026-10-05', amount: 50 }).success).toBe(true);
    await renderDetail(itemFrom(INVOICE));
    expect(text('intake-assessment-action')).toBe('Zahlen');
  });

  it('C: vollständig bezahlt → nicht Zahlen', async () => {
    const id = linkedExpense();
    expect(recordExpensePayment(id, { date: '2026-10-05', amount: 119 }).success).toBe(true);
    await renderDetail(itemFrom(INVOICE));
    expect(text('intake-assessment-action')).not.toBe('Zahlen');
  });

  it('D: keine Ausgabe → bestehender Aktionsvertrag (Erfassen / Ausgabe erfassen)', async () => {
    await renderDetail(itemFrom(INVOICE));
    expect(text('intake-assessment-action')).toBe('Erfassen');
    expect(text('intake-assessment-next-step')).toBe('Ausgabe erfassen');
    expect(find('document-review-apply-button')?.textContent).toMatch(/Ausgabe erfassen/);
  });

  it('E: Gutschrift → nie Zahlen', async () => {
    await renderDetail(itemFrom(CREDIT));
    expect(text('intake-assessment-action')).not.toBe('Zahlen');
  });

  it('F: stornierte Ausgabe → nicht Zahlen', async () => {
    const id = linkedExpense();
    expect(cancelExpense(id, 'Doppelt erfasst').success).toBe(true);
    await renderDetail(itemFrom(INVOICE));
    expect(text('intake-assessment-action')).not.toBe('Zahlen');
  });
});

describe('Nacharbeit 1 — aufgelöste Wahrheit im KI-Kontext folgt dem Hauptdokument', () => {
  function withStoredAnalysis(item: InboxItem) {
    hydrateInboxStore([item]);
    const workflow = analyzeUploadedDocument(item.id)!;
    commitUploadedDocumentAnalysis(workflow, 'onlyIfMissing');
    return workflow;
  }
  const outsideSourceText = (prompt: string): string =>
    prompt.replace(/<<<OCR_DATEN>>>[\s\S]*?<<<ENDE_OCR_DATEN>>>/g, '');
  const creditWithCopy = () =>
    itemFrom(`${CREDIT}\n${INVOICE_COPY}`, {}, [
      { pageNumber: 1, text: CREDIT },
      { pageNumber: 2, text: INVOICE_COPY },
    ]);

  it('A: Gutschrift + Rechnungskopie → Truth ohne fremde Frist, Nummer, Forderung, Rechnungs-Schritt; Frist nur im Quelltext; E: Analyseergebnis unverändert', () => {
    const item = creditWithCopy();
    const workflow = withStoredAnalysis(item);
    const storedBefore = JSON.stringify(getDocumentWorkResult(item.id));
    expect(storedBefore).not.toBe('null');
    const context = buildDocumentAiContextFromInbox(item, { liveWorkflow: workflow });
    const truth = (context.documentWorkTruthFactLines ?? []).join('\n');
    expect(truth.length).toBeGreaterThan(0);
    expect(truth).not.toMatch(/15\.09\.2026|2026-09-15|RE-2026-1|Rechnungsdaten|zahlbar|Forderung/i);
    expect(truth).toMatch(/Nächster Schritt: Gutschrift als Ausgabe erfassen/);
    expect(truth).not.toMatch(/^Frist:/m);
    const prompt = buildDocumentAiPrompt('Bis wann muss ich das bezahlen?', context, 'de');
    expect(prompt).toMatch(/15\.09\.2026/); // Quelltext bleibt vollständig erhalten
    expect(outsideSourceText(prompt)).not.toMatch(/15\.09\.2026|2026-09-15|RE-2026-1|Rechnungsdaten prüfen/);
    expect(JSON.stringify(getDocumentWorkResult(item.id))).toBe(storedBefore);
  });

  it('B: normale Rechnung → Zahlungsfrist 15.09. bleibt im strukturierten Kontext', () => {
    const item = itemFrom(INVOICE_COPY);
    const workflow = withStoredAnalysis(item);
    const context = buildDocumentAiContextFromInbox(item, { liveWorkflow: workflow });
    expect(context.deadline).toBe('2026-09-15');
    expect(outsideSourceText(buildDocumentAiPrompt('Bis wann?', context, 'de'))).toMatch(/15\.09\.2026|2026-09-15/);
  });

  it('C: Gutschrift mit eigener Antwortfrist → eigene Frist bleibt in der Truth', () => {
    const item = itemFrom(`${CREDIT}\nBitte bestätigen Sie den Erhalt dieser Gutschrift bis zum 20.10.2026.`);
    expect(item.deadline).toBe('2026-10-20');
    const workflow = withStoredAnalysis(item);
    const context = buildDocumentAiContextFromInbox(item, { liveWorkflow: workflow });
    expect(context.deadline).toBe('2026-10-20');
    expect((context.documentWorkTruthFactLines ?? []).join('\n')).toMatch(/^Frist: 20\.10\.2026$/m);
  });

  it('D: GS-17 mit Bezug RE-1 → Gutschriftsnummer GS-17, RE-1 nie als eigene Nummer', () => {
    const body = `Baustoff Meyer GmbH\nGutschrift\n${TO_US}\nGutschrift-Nr. GS-17\nzu Rechnung RE-1 vom 01.09.2026\nGutschrift brutto 50,00 EUR`;
    const item = itemFrom(body);
    const workflow = withStoredAnalysis(item);
    const context = buildDocumentAiContextFromInbox(item, { liveWorkflow: workflow });
    const structured = context.recognizedDataLines.join('\n');
    expect(structured).toMatch(/^Gutschriftsnummer: GS-17$/m);
    expect(structured).not.toMatch(/^Rechnungsnummer:/m);
    expect((context.documentWorkTruthFactLines ?? []).join('\n')).not.toMatch(/RE-1\b/);
  });
});

describe('Nacharbeit 1 — aufgeklappter Hinweisbereich folgt der kanonischen Frist', () => {
  function guidanceFor(item: InboxItem) {
    hydrateInboxStore([item]);
    const workflow = analyzeUploadedDocument(item.id);
    return {
      guidance: buildDocumentGuidance(item, workflow, 'de'),
      prioritized: buildPrioritizedDocumentGuidance(item, workflow, 'de'),
    };
  }

  it('Gutschrift + Rechnungskopie → kein „Möglicherweise gilt die Frist 15.09.", kein „Rechnungsdaten prüfen"', () => {
    const { guidance, prioritized } = guidanceFor(
      itemFrom(`${CREDIT}\n${INVOICE_COPY}`, {}, [
        { pageNumber: 1, text: CREDIT },
        { pageNumber: 2, text: INVOICE_COPY },
      ]),
    );
    expect(JSON.stringify(guidance.deadline)).not.toMatch(/15\.09\.2026|2026-09-15/);
    expect(JSON.stringify(prioritized)).not.toMatch(/15\.09\.2026|Rechnungsdaten prüfen/);
    expect(JSON.stringify(guidance.actions)).not.toMatch(/Rechnungsdaten prüfen/);
  });

  it('normale Rechnung → bestehender Fristhinweis bleibt', () => {
    const { guidance } = guidanceFor(itemFrom(INVOICE_COPY));
    expect(JSON.stringify(guidance.deadline)).toMatch(/15\.09\.2026|2026-09-15/);
  });

  it('Gutschrift mit eigener Antwortfrist → eigene Frist im Hinweis', () => {
    const { guidance } = guidanceFor(
      itemFrom(`${CREDIT}\nBitte bestätigen Sie den Erhalt dieser Gutschrift bis zum 20.10.2026.`),
    );
    expect(JSON.stringify(guidance.deadline)).toMatch(/20\.10\.2026|2026-10-20/);
  });
});

describe('Nacharbeit 1 — Detailseite, „Warum diese Empfehlung?" aufgeklappt', () => {
  async function expandedWhy(): Promise<string> {
    // Wie im Browser: erst „Weitere Optionen", dann „Warum diese Empfehlung?".
    if (!find('review-group-toggle-why-recommendation')) await click(find('document-review-more-toggle')!);
    const toggle = find('review-group-toggle-why-recommendation');
    expect(toggle, 'Detail-Einstieg fehlt').not.toBeNull();
    await click(toggle!);
    const content = find('review-group-content-why-recommendation');
    expect(content?.hidden).toBe(false);
    return content?.textContent ?? '';
  }

  it('Gutschrift + Rechnungskopie → aufgeklappte Hinweise ohne fremde Frist und ohne Rechnungs-Schritt', async () => {
    await renderDetail(
      itemFrom(`${CREDIT}\n${INVOICE_COPY}`, {}, [
        { pageNumber: 1, text: CREDIT },
        { pageNumber: 2, text: INVOICE_COPY },
      ]),
    );
    const why = await expandedWhy();
    expect(find('document-experience-guidance')).not.toBeNull();
    expect(why).not.toMatch(/15\.09\.2026|Möglicherweise gilt die Frist|Rechnungsdaten prüfen|RE-2026-1/);
  });

  it('Kontrolle: normale Rechnung → aufgeklappter Fristhinweis bleibt', async () => {
    await renderDetail(itemFrom(INVOICE_COPY));
    expect(await expandedWhy()).toMatch(/15\.09\.2026/);
  });
});

describe('Nacharbeit 1 — Truth-Projektion: Nutzerangaben bleiben, Archivpfad folgt ebenfalls', () => {
  it('Nutzerbestätigte/-korrigierte Zeilen bleiben; analysierte Rechnungszeilen fallen weg', () => {
    const projected = projectCreditNoteTruthFactLines(
      [
        'Betrag: 119,00 €',
        'Frist: 15.09.2026',
        'Nächster Schritt: Rechnungsdaten prüfen und erst nach Freigabe finalisieren.',
        'Zusammenfassung: Eingangsrechnung — Ausgabe und möglicher Vorgangsbezug, keine Buchung ohne Freigabe',
        'Gegenpartei: Baustoff Meyer GmbH [Nutzerbestätigung]',
        'Frist: 30.10.2026 [Nutzerkorrektur]',
      ],
      { canonicalDeadline: null, nextStepLabel: 'Gutschrift als Ausgabe erfassen' },
    );
    expect(projected).toEqual([
      'Betrag: 119,00 €',
      'Gegenpartei: Baustoff Meyer GmbH [Nutzerbestätigung]',
      'Frist: 30.10.2026 [Nutzerkorrektur]',
      'Nächster Schritt: Gutschrift als Ausgabe erfassen',
    ]);
  });

  it('abgelegtes Archivdokument einer Gutschrift + Kopie → KI-Truth ohne fremde Frist/Rechnungsschritt', () => {
    const item = itemFrom(`${CREDIT}\n${INVOICE_COPY}`, { status: 'abgelegt' }, [
      { pageNumber: 1, text: CREDIT },
      { pageNumber: 2, text: INVOICE_COPY },
    ]);
    hydrateInboxStore([item]);
    commitUploadedDocumentAnalysis(analyzeUploadedDocument(item.id)!, 'onlyIfMissing');
    const document = {
      id: 'doc-01d2-gs',
      title: 'Gutschrift GS-2026-17',
      category: 'beleg',
      issuer: 'Baustoff Meyer GmbH',
      recognizedText: `${CREDIT}\n${INVOICE_COPY}`,
      issueDate: '2026-10-01',
      tags: [],
      classifiedKind: 'gutschrift',
      sourceInboxItemId: item.id,
      archived: true,
      createdAt: '2026-10-01T10:00:00.000Z',
      updatedAt: '2026-10-01T10:00:00.000Z',
    } as unknown as CompanyDocument;
    const context = buildDocumentAiContextFromDocument(document);
    const truth = (context.documentWorkTruthFactLines ?? []).join('\n');
    expect(truth.length).toBeGreaterThan(0);
    expect(truth).not.toMatch(/15\.09\.2026|Rechnungsdaten/);
  });
});
