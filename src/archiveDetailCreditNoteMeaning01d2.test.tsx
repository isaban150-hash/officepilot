/**
 * EINGANG-01D-2 Archiv-Detailfix 1 — das sichtbare Bedeutungsfeld der
 * Archiv-Detailseite folgt bei einer Gutschrift mit Seitenstruktur derselben
 * Hauptdokument-Wahrheit wie Eingang und Archiv-KI-Kontext.
 *
 * Echter Weg: Aufnahme wie in der Produktion (Vorschau ohne Seitentexte,
 * Speichern mit Seitentexten) → echte Ablage → `DokumentDetailPage` →
 * `document-meaning-panel`. Geprüft wird die gerenderte Bedeutung strukturiert:
 * Termine mit Handlungsbedarf, eigene Pflichten, Forderungen, „Handlung nötig?".
 */
import { useDocumentBlobDatabaseReset } from './test/documentBlobTestReset';
import { importInboxDocumentForTests } from './test/confirmFilingDecisionForTests';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppProvider } from './context/AppContext';
import { DEFAULT_SETUP } from './data/mockData';
import { DEFAULT_COMPANY_PROFILE } from './data/companyProfileDefaults';
import { DokumentDetailPage } from './pages/DokumentDetailPage';
import type { CachedDocumentFilePayload } from './services/cachedDocumentFileService';
import { hydrateCompanyProfileStore } from './services/companyProfileService';
import { classifyDocument } from './services/documentClassificationService';
import { intakeCachedDocumentFile } from './services/documentIntakeService';
import { hydrateDocumentFileStore } from './services/documentFileStoreService';
import { getAllDocuments, hydrateDocumentStore } from './services/documentService';
import { resetDocumentWorkResultStoreForTests } from './services/documentWorkResultService';
import { hydrateExpenseStore } from './services/expenseStore';
import { getInboxItemById, hydrateInboxStore, markInboxImportedToArchive } from './services/inboxService';
import { processUploadedDocument } from './services/intakeWorkflowService';
import { setActiveStorageScope } from './services/storage/storageScopeService';
import { hydrateVorgangStore } from './services/vorgangService';
import { resetTestStores } from './test/resetStores';
import type { CompanyDocument, InboxItem } from './types/models';

const OWN = 'Mustermann Sanitär GmbH';
const TO_US = `An: ${OWN}\nHandwerkerweg 7\n10115 Berlin`;
const CREDIT = `Baustoff Meyer GmbH\nGutschrift\n${TO_US}\nGutschriftsnummer: GS-2026-17\nDatum: 01.10.2026\nRücknahme Material\nGutschrift brutto 119,00 EUR`;
const OWN_REPLY = `${CREDIT}\nBitte bestätigen Sie den Erhalt dieser Gutschrift bis zum 20.10.2026.`;
const TWO_DUTIES = `${OWN_REPLY}\nBitte senden Sie das Leergut bis zum 31.10.2026 zurück.`;
const COPY = (tail: string) =>
  `Baustoff Meyer GmbH\nRechnung\n${TO_US}\nRechnungsnummer: RE-2026-1\nMaterial 100,00 EUR\nGesamtbetrag 119,00 EUR\n${tail}`;
const CLAIM = /Gesamtforderung|Forderung an uns/;
const DATE = /\d\d\.\d\d\.\d{4}/g;

useDocumentBlobDatabaseReset();

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let seq = 0;

beforeEach(() => {
  setActiveStorageScope({ type: 'guest' });
  localStorage.clear();
  resetDocumentWorkResultStoreForTests();
  hydrateInboxStore([]);
  hydrateVorgangStore([]);
  hydrateDocumentStore([]);
  hydrateDocumentFileStore([], {});
  hydrateExpenseStore([]);
  hydrateCompanyProfileStore({ ...DEFAULT_COMPANY_PROFILE, companyName: OWN, street: 'Handwerkerweg 7', zip: '10115', city: 'Berlin' });
});

afterEach(() => {
  unmount();
  resetDocumentWorkResultStoreForTests();
  resetTestStores();
  localStorage.clear();
});

function unmount(): void {
  if (root) act(() => root!.unmount());
  host?.remove();
  root = null;
  host = null;
}

/** Produktionsnah aufnehmen und über den echten Ablageweg archivieren. */
async function archivedFromRealIntake(
  pages: string[],
  options: { withPageTexts?: boolean } = {},
): Promise<{ document: CompanyDocument; item: InboxItem }> {
  const name = `archiv-${++seq}.pdf`;
  const recognizedText = pages.join('\n');
  const previewClassification = classifyDocument({ sourceFileName: name, recognizedText });
  const bytes = new TextEncoder().encode(`${name}:${recognizedText}`);
  const payload: CachedDocumentFilePayload = { bytes, fileName: name, mimeType: 'application/pdf', fileSize: bytes.byteLength };
  const result = await intakeCachedDocumentFile(payload, {
    sourceFileName: name,
    recognizedText,
    ...(options.withPageTexts === false ? {} : { pageTexts: pages.map((text, index) => ({ pageNumber: index + 1, text })) }),
    previewClassification,
    userDecision: 'save_permanently',
  });
  if (!result.success || result.duplicate) throw new Error('Aufnahme fehlgeschlagen');
  hydrateInboxStore([{ ...getInboxItemById(result.inboxItem.id)!, markedAsCompanyDocument: true }]);
  processUploadedDocument(result.inboxItem.id);
  const imported = importInboxDocumentForTests(getInboxItemById(result.inboxItem.id)!, OWN);
  if (!imported.success) throw new Error('Ablage fehlgeschlagen');
  markInboxImportedToArchive(result.inboxItem.id, imported.document.id);
  return { document: imported.document, item: getInboxItemById(result.inboxItem.id)! };
}

type Meaning = { actionDates: string[]; infoDates: string[]; obligationDates: string[]; claims: boolean; actionNeed: string; purpose: string; text: string };

async function detailMeaning(document: CompanyDocument): Promise<Meaning> {
  unmount();
  host = window.document.createElement('div');
  window.document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      createElement(
        MemoryRouter,
        { initialEntries: [`/dokumente/${document.id}`] },
        createElement(
          AppProvider,
          { initialSetup: { ...DEFAULT_SETUP, setupComplete: true } },
          createElement(Routes, null, createElement(Route, { path: '/dokumente/:id', element: createElement(DokumentDetailPage) })),
        ),
      ),
    );
  });
  // Unter Last rendert die Detailseite langsamer: warten, bis das Bedeutungsfeld steht (dann noch ruhen lassen).
  for (let i = 0; i < 400 && !host.querySelector('[data-testid="document-meaning-panel"]'); i += 1) {
    await act(async () => {
      await new Promise((done) => setTimeout(done, 5));
    });
  }
  for (let i = 0; i < 10; i += 1) {
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
  }
  const panel = host.querySelector('[data-testid="document-meaning-panel"]');
  expect(panel, 'Bedeutungsfeld fehlt').not.toBeNull();
  // Je Zeile genau ein Datum (das erste) — der Zeilentext kann das Datum im zitierten Satz wiederholen.
  const dates = (selector: string) =>
    Array.from(panel!.querySelectorAll(selector)).flatMap((node) => (node.textContent?.match(DATE) ?? []).slice(0, 1));
  return {
    actionDates: dates('[data-testid="document-meaning-deadlines"] .document-meaning__item--action').sort(),
    infoDates: dates('[data-testid="document-meaning-deadlines"] .document-meaning__item--info').sort(),
    obligationDates: dates('[data-testid="document-meaning-obligations"] li').sort(),
    claims: CLAIM.test(panel!.querySelector('[data-testid="document-meaning-amounts"]')?.textContent ?? ''),
    actionNeed: panel!.querySelector('[data-testid="document-meaning-action"]')?.textContent?.trim() ?? '',
    purpose: panel!.querySelector('[data-testid="document-meaning-purpose"]')?.textContent?.trim() ?? '',
    text: panel!.textContent ?? '',
  };
}

/** Archiv mit Eingangselement, ohne Eingangselement und ohne `sourceInboxItemId`. */
async function variants(document: CompanyDocument, item: InboxItem): Promise<Array<[string, Meaning]>> {
  const out: Array<[string, Meaning]> = [];
  hydrateInboxStore([item]);
  out.push(['mit Eingangselement', await detailMeaning(document)]);
  hydrateInboxStore([]);
  out.push(['Eingangselement fehlt', await detailMeaning(document)]);
  hydrateDocumentStore(getAllDocuments().map((doc) => (doc.id === document.id ? { ...doc, sourceInboxItemId: undefined } : doc)));
  out.push(['ohne sourceInboxItemId', await detailMeaning(document)]);
  return out;
}

// Je Test: echte Aufnahme + bis zu drei Renderings der Detailseite — realistisches Zeitbudget unter Last.
describe('Archiv-Detailfix 1 — sichtbare Bedeutung einer archivierten Gutschrift', { timeout: 30_000 }, () => {
  it('A: Seite 2 response_due 25.10. (+ Zahlbar 15.09.) → kein fremder Termin, keine Pflicht, keine Forderung, kein „Ja" wegen Seite 2', async () => {
    const { document, item } = await archivedFromRealIntake([CREDIT, COPY('Zahlbar bis 15.09.2026\nBitte antworten Sie bis zum 25.10.2026.')]);
    for (const [label, meaning] of await variants(document, item)) {
      expect(meaning.actionDates, label).toEqual([]);
      expect(meaning.obligationDates, label).toEqual([]);
      expect(meaning.claims, label).toBe(false);
      expect(meaning.text, label).not.toMatch(/25\.10\.2026|15\.09\.2026/);
      expect(meaning.actionNeed, label).not.toMatch(/^Ja\b/);
    }
  });

  it('B: Seite 2 payment_due 15.09. → keine Zahlungspflicht, keine Forderung, kein Handlungstermin', async () => {
    const { document, item } = await archivedFromRealIntake([CREDIT, COPY('Zahlbar bis 15.09.2026')]);
    for (const [label, meaning] of await variants(document, item)) {
      expect(meaning.actionDates, label).toEqual([]);
      expect(meaning.claims, label).toBe(false);
      expect(meaning.text, label).not.toMatch(/15\.09\.2026/);
    }
  });

  it('B2: Zahlungshinweis auf Seite 1 selbst → keine Zahlungsfrist und keine Forderung der Gutschrift (Hauptdokument-Abgleich)', async () => {
    const { document, item } = await archivedFromRealIntake([`${CREDIT}\nZahlbar bis 15.09.2026`, COPY('Zahlbar bis 15.09.2026')]);
    for (const [label, meaning] of await variants(document, item)) {
      expect(meaning.actionDates, label).toEqual([]);
      expect(meaning.claims, label).toBe(false);
      expect(meaning.actionNeed, label).not.toMatch(/^Ja\b/);
    }
  });

  it('C: eigene 20.10. auf Seite 1 + fremde 25.10. auf Seite 2 → 20.10. Pflicht und Termin, 25.10. nicht', async () => {
    const { document, item } = await archivedFromRealIntake([OWN_REPLY, COPY('Bitte antworten Sie bis zum 25.10.2026.')]);
    for (const [label, meaning] of await variants(document, item)) {
      expect(meaning.actionDates, label).toEqual(['20.10.2026']);
      expect(meaning.obligationDates, label).toEqual(['20.10.2026']);
      expect(meaning.text, label).not.toMatch(/25\.10\.2026/);
      expect(meaning.actionNeed, label).toMatch(/^Ja\b/);
    }
  });

  it('D: zwei eigene Pflichten auf Seite 1 + fremde Zahlung 25.10. → beide Pflichten und Termine, Anliegen 2 Handlungen, keine fremde Pflicht/Forderung', async () => {
    const { document, item } = await archivedFromRealIntake([TWO_DUTIES, COPY('Zahlbar bis 25.10.2026')]);
    for (const [label, meaning] of await variants(document, item)) {
      expect(meaning.actionDates, label).toEqual(['20.10.2026', '31.10.2026']);
      expect(meaning.obligationDates, label).toEqual(['20.10.2026', '31.10.2026']);
      expect(meaning.purpose, label).toMatch(/2 Handlungen werden verlangt/);
      expect(meaning.claims, label).toBe(false);
      expect(meaning.text, label).not.toMatch(/25\.10\.2026/);
    }
  });

  it('E: kanonische Hauptfrist (05.11. bzw. null) — Bedeutung widerspricht nicht, eigene Seite-1-Pflichten bleiben, keine fremde', async () => {
    const { document, item } = await archivedFromRealIntake([TWO_DUTIES, COPY('Bitte antworten Sie bis zum 25.10.2026.')]);
    for (const deadline of ['2026-11-05', null]) {
      hydrateInboxStore([{ ...item, deadline, deadlineType: deadline ? 'response_due' : undefined }]);
      const meaning = await detailMeaning(document);
      expect(meaning.actionDates, String(deadline)).toEqual(['20.10.2026', '31.10.2026']);
      expect(meaning.actionNeed, String(deadline)).toMatch(/^Ja\b/);
      expect(meaning.text, String(deadline)).not.toMatch(/25\.10\.2026/);
    }
  });
});

describe('Archiv-Detailfix 1 — Gegenkontrollen (unverändert)', { timeout: 30_000 }, () => {
  it('F: normale mehrseitige Rechnung → Zahlungsfrist, Seite-2-Antwortfrist und Forderung bleiben sichtbar', async () => {
    const { document } = await archivedFromRealIntake([COPY('Zahlbar bis 15.09.2026'), 'Baustoff Meyer GmbH\nAnlage\nBitte antworten Sie bis zum 25.10.2026.']);
    expect(document.classifiedKind).toBe('eingangsrechnung');
    const meaning = await detailMeaning(document);
    expect(meaning.actionDates).toEqual(expect.arrayContaining(['15.09.2026', '25.10.2026']));
    expect(meaning.claims).toBe(true);
    expect(meaning.actionNeed).toMatch(/^Ja\b/);
  });

  it('F2: Rechnungskorrektur mit Anlagenseite → unverändert (keine Seite-1-Regel)', async () => {
    const { document } = await archivedFromRealIntake([
      `Baustoff Meyer GmbH\nRechnungskorrektur\n${TO_US}\nzur Rechnung R-1 vom 01.10.2026\nRechnungsnummer: RK-3\nDatum: 05.10.2026\nGesamtbetrag 107,10 EUR`,
      'Anlage\nBitte antworten Sie bis zum 25.10.2026.',
    ]);
    expect(document.classifiedKind).not.toBe('gutschrift');
    expect((await detailMeaning(document)).actionDates).toContain('25.10.2026');
  });

  it('G: Gutschrift ohne Seitentexte → bisheriger Vertrag (Volltext, keine erfundene Seitengrenze)', async () => {
    const { document } = await archivedFromRealIntake([CREDIT, COPY('Bitte antworten Sie bis zum 25.10.2026.')], { withPageTexts: false });
    expect(document.recognizedText).not.toMatch(/\n_pageTexts: /);
    expect((await detailMeaning(document)).actionDates).toContain('25.10.2026');
  });
});
