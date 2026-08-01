/**
 * DOCUMENT-SUMMARY-ROLL-OUT-01 — one presentation source for compact document UIs.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { AppProvider } from './context/AppContext';
import { DEFAULT_SETUP } from './data/mockData';
import { DeskDocumentAttention } from './components/home/DeskDocumentAttention';
import { InboxCard } from './components/inbox/InboxCard';
import {
  buildSummaryForCompanyDocument,
  buildSummaryForInboxItem,
  createPresentationTranslate,
  presentDocumentSummaryForSnippet,
  toDocumentSummaryCompactView,
} from './services/documentSummaryPresentation';
import { searchOffice } from './services/officeSearchService';
import { hydrateDocumentStore } from './services/documentService';
import { hydrateInboxStore } from './services/inboxService';
import { createAuftragInboxItem } from './test/fixtures';
import { resetTestStores } from './test/resetStores';
import { t, type TranslationKey } from './i18n';
import { UNKNOWN_SENDER_CANONICAL } from './i18n/resolveStoredText';
import type { CompanyDocument } from './types/models';
import { DOCUMENT_SUMMARY_MAX_FACTS } from './types/documentSummary';

function translate(key: TranslationKey): string {
  return t(key, 'de');
}

function archiveDoc(overrides: Partial<CompanyDocument> = {}): CompanyDocument {
  return {
    id: 'doc-roll-1',
    title: 'Alte Rohüberschrift mit Technik',
    category: 'vertrag',
    issuer: 'Isobautec GmbH',
    recognizedText: '',
    issueDate: '2026-03-01',
    validUntil: null,
    digitalFolder: { id: 'd1', name: 'Verträge', path: '/vertraege/' },
    paperFolder: { folderId: 'f1', register: 'V', label: 'Vertrag' },
    tags: [],
    linkedCompany: '',
    linkedVorgang: null,
    archived: true,
    createdAt: '2026-03-01T00:00:00.000Z',
    classifiedKind: 'werkvertrag',
    documentDate: '2026-03-01',
    ...overrides,
  };
}

describe('DOCUMENT-SUMMARY-ROLL-OUT-01', () => {
  beforeEach(() => {
    resetTestStores();
  });

  afterEach(() => {
    resetTestStores();
  });

  it('Inbox und Dashboard nutzen dieselbe Summary-Headline/Facts', () => {
    const item = createAuftragInboxItem({
      id: 'roll-inbox-1',
      classifiedKind: 'werkvertrag',
      status: 'neu',
      title: 'Subunternehmervertrag – Absender nicht eindeutig erkannt',
      sender: UNKNOWN_SENDER_CANONICAL,
      recognizedData: {
        Auftraggeber: 'Isobautec GmbH',
        Bauvorhaben: 'Dach',
        Vertragssumme: '10.000,00 €',
      },
    });
    hydrateInboxStore([item]);

    const summary = buildSummaryForInboxItem(item, { translate });
    const view = toDocumentSummaryCompactView(summary, translate);
    expect(view.title).toBe('Werkvertrag');
    expect(summary.facts.length).toBeLessThanOrEqual(DOCUMENT_SUMMARY_MAX_FACTS);
    expect(summary.alerts.some((a) => a.id === 'sender-uncertain')).toBe(true);

    const inboxHtml = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(
          AppProvider,
          { initialSetup: { ...DEFAULT_SETUP, setupComplete: true } },
          createElement(InboxCard, {
            item,
            onReview: () => undefined,
            onUpdated: () => undefined,
          }),
        ),
      ),
    );
    expect(inboxHtml).toContain('Werkvertrag');
    expect(inboxHtml).toContain('Isobautec GmbH');
    expect(inboxHtml).toContain('Neuen Vorgang anlegen');

    const deskHtml = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        null,
        createElement(
          AppProvider,
          { initialSetup: { ...DEFAULT_SETUP, setupComplete: true } },
          createElement(DeskDocumentAttention),
        ),
      ),
    );
    expect(deskHtml).toContain('data-testid="desk-document-attention"');
    expect(deskHtml).toContain('Werkvertrag');
    expect(deskHtml).toContain('Isobautec GmbH');
    expect(deskHtml).not.toContain('Subunternehmervertrag – Absender nicht eindeutig erkannt');
  });

  it('Suche: Inbox-Treffer aus DocumentSummary, keine Roh-Titel', () => {
    const item = createAuftragInboxItem({
      id: 'roll-search-1',
      classifiedKind: 'eingangsrechnung',
      documentType: 'eingangsrechnung',
      title: 'Gerade erfasst: RE-99 Technik',
      sender: 'Baumarkt GmbH',
      recognizedData: {
        Lieferant: 'Baumarkt GmbH',
        Rechnungsnummer: 'RE-99',
        Betrag: '120,00 €',
      },
    });
    hydrateInboxStore([item]);

    const results = searchOffice({ query: 'Baumarkt', limit: 10 });
    const hit = results.find((r) => r.type === 'inbox' && r.route.includes(item.id));
    expect(hit).toBeTruthy();
    expect(hit!.title).not.toContain('Gerade erfasst');
    expect(hit!.title).not.toContain('Technik');
    const expected = presentDocumentSummaryForSnippet(
      buildSummaryForInboxItem(item, { translate }),
      translate,
    );
    expect(hit!.title).toBe(expected.title);
    expect(hit!.subtitle).toBe(expected.subtitle);
  });

  it('Archivliste: Titel aus DocumentSummary', () => {
    const doc = archiveDoc();
    hydrateDocumentStore([doc]);
    const summary = buildSummaryForCompanyDocument(doc, { translate });
    const view = toDocumentSummaryCompactView(summary, translate);
    expect(view.title).toBe('Werkvertrag');
    expect(view.title).not.toBe(doc.title);
  });

  it('Assistant-Snippet und Compact-View teilen Facts/Alerts', () => {
    const item = createAuftragInboxItem({
      id: 'roll-assist-1',
      classifiedKind: 'tankbeleg',
      recognizedData: {
        Tankstelle: 'ARAL',
        Betrag: '55,00 €',
        Datum: '01.02.2026',
      },
    });
    const translateFn = createPresentationTranslate('de');
    const summary = buildSummaryForInboxItem(item, { translate: translateFn });
    const a = toDocumentSummaryCompactView(summary, translateFn);
    const b = presentDocumentSummaryForSnippet(summary, translateFn);
    expect(a.title).toBe(b.title);
    expect(a.facts.map((f) => f.id)).toEqual(summary.facts.map((f) => f.id));
    expect(a.alerts.map((x) => x.id)).toEqual(summary.alerts.map((x) => x.id));
    expect(a.primaryActionLabel).toBeTruthy();
  });
});
