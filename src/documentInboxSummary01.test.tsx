/**
 * DOCUMENT-INBOX-SUMMARY-01 — Eingangsliste aus DocumentSummary.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { AppProvider } from './context/AppContext';
import { DEFAULT_SETUP } from './data/mockData';
import { InboxCard } from './components/inbox/InboxCard';
import { buildInboxDocumentSummary } from './services/documentSummary';
import { hydrateInboxStore } from './services/inboxService';
import { createAuftragInboxItem } from './test/fixtures';
import { resetTestStores } from './test/resetStores';
import { t, type TranslationKey } from './i18n';
import { UNKNOWN_SENDER_CANONICAL } from './i18n/resolveStoredText';
import { DOCUMENT_SUMMARY_MAX_FACTS } from './types/documentSummary';

function translate(key: TranslationKey): string {
  return t(key, 'de');
}

function renderCard(item: ReturnType<typeof createAuftragInboxItem>): string {
  hydrateInboxStore([item]);
  return renderToStaticMarkup(
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
}

describe('DOCUMENT-INBOX-SUMMARY-01', () => {
  beforeEach(() => {
    resetTestStores();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetTestStores();
  });

  it('Werkvertrag: Typ als Titel, max. 6 Fakten, keine technischen Felder', () => {
    const item = createAuftragInboxItem({
      id: 'inbox-sum-wv',
      classifiedKind: 'werkvertrag',
      title: 'Subunternehmervertrag – Absender nicht eindeutig erkannt',
      sender: UNKNOWN_SENDER_CANONICAL,
      priority: 'niedrig',
      isNewUpload: true,
      status: 'neu',
      recognizedData: {
        Auftraggeber: 'Isobautec GmbH',
        Bauvorhaben: 'Dachsanierung',
        Baustelle: 'Möhnetal 55',
        Vertragssumme: '12.000,00 €',
        Gewerk: 'Dachdecker',
      },
    });

    const summary = buildInboxDocumentSummary(item, { translate });
    expect(summary.headline).toBe('Werkvertrag');
    expect(summary.facts.length).toBeLessThanOrEqual(DOCUMENT_SUMMARY_MAX_FACTS);
    expect(summary.facts.map((f) => f.id)).toEqual(
      expect.arrayContaining(['customer', 'project', 'site', 'orderValue', 'gewerk']),
    );
    expect(summary.alerts.some((a) => a.id === 'sender-uncertain')).toBe(true);
    expect(summary.primaryAction.labelKey).toBe('vorgangIntelligence.action.create');
    expect(summary.primaryAction.id).toBe('create_vorgang');
    expect(summary.caseMatch?.matchStatus).toBe('none');
    expect(summary.secondaryActions.map((a) => a.id)).toEqual(['later']);

    const html = renderCard(item);
    expect(html).toContain('data-testid="inbox-card-inbox-sum-wv"');
    expect(html).toContain('Werkvertrag');
    expect(html).toContain('Isobautec GmbH');
    expect(html).toContain('12.000,00 €');
    expect(html).toContain('Neuen Vorgang anlegen');
    expect(html).toContain('Später');
    expect(html).toContain('Absender konnte nicht eindeutig erkannt werden.');
    expect(html).not.toContain('Gerade erfasst');
    expect(html).not.toContain('Niedrig');
    expect(html).not.toContain('Digitale Ablage');
    expect(html).not.toContain('Papierablage');
    expect(html).not.toContain('Subunternehmervertrag – Absender nicht eindeutig erkannt');
    expect(html).not.toContain('data-testid="document-experience-type"');
  });

  it('Eingangsrechnung: Lieferant/Nr/Betrag/Datum', () => {
    const item = createAuftragInboxItem({
      id: 'inbox-sum-er',
      classifiedKind: 'eingangsrechnung',
      documentType: 'eingangsrechnung',
      recognizedData: {
        Lieferant: 'Baumarkt GmbH',
        Rechnungsnummer: 'RE-12',
        Betrag: '250,00 €',
        Datum: '01.04.2026',
        Frist: '15.04.2026',
      },
    });
    const summary = buildInboxDocumentSummary(item, { translate });
    expect(summary.family).toBe('invoice_in');
    expect(summary.facts.length).toBeLessThanOrEqual(6);
    expect(summary.facts.map((f) => f.id)).toEqual(
      expect.arrayContaining(['supplier', 'invoiceNumber', 'amount', 'date', 'deadline']),
    );
    const html = renderCard(item);
    expect(html).toContain('Baumarkt GmbH');
    expect(html).toContain('RE-12');
    expect(html).not.toContain('Gerade erfasst');
  });

  it('Tankbeleg: Tankstelle/Betrag/Datum', () => {
    const item = createAuftragInboxItem({
      id: 'inbox-sum-tank',
      classifiedKind: 'tankbeleg',
      recognizedData: {
        Tankstelle: 'ARAL Nord',
        Betrag: '72,40 €',
        Datum: '10.03.2026',
      },
    });
    const summary = buildInboxDocumentSummary(item, { translate });
    expect(summary.family).toBe('tank');
    expect(summary.facts.map((f) => f.id)).toEqual(
      expect.arrayContaining(['station', 'amount', 'date']),
    );
    expect(renderCard(item)).toContain('ARAL Nord');
  });

  it('Behördenbrief: Behörde/Betreff/Az/Frist', () => {
    const item = createAuftragInboxItem({
      id: 'inbox-sum-fa',
      classifiedKind: 'finanzamt',
      documentType: 'behoerde',
      sender: 'Finanzamt Musterstadt',
      deadline: '15.04.2026',
      title: 'Erinnerung',
      recognizedData: {
        Absender: 'Finanzamt Musterstadt',
        Betreff: 'USt-Voranmeldung',
        Aktenzeichen: 'FA-99',
        Frist: '15.04.2026',
      },
    });
    const summary = buildInboxDocumentSummary(item, { translate });
    expect(summary.family).toBe('authority');
    expect(summary.facts.map((f) => f.id)).toEqual(
      expect.arrayContaining(['authority', 'subject', 'reference', 'deadline']),
    );
    expect(summary.facts.length).toBeLessThanOrEqual(6);
  });

  it('Warnung unter Fakten, nicht als Titel', () => {
    const item = createAuftragInboxItem({
      id: 'inbox-sum-warn',
      classifiedKind: 'subunternehmervertrag',
      title: 'Subunternehmervertrag – Absender nicht eindeutig erkannt',
      sender: '',
      recognizedData: { Auftraggeber: 'Kunde AG' },
    });
    const summary = buildInboxDocumentSummary(item, { translate });
    expect(summary.headline).toBe('Subunternehmervertrag');
    expect(summary.headline).not.toMatch(/nicht eindeutig/);
    expect(summary.alerts[0]?.id).toBe('sender-uncertain');
  });
});
