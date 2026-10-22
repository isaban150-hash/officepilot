/**
 * DOKUMENTE-01 — „Als Firmendokument markieren" behält die erkannte Dokumentart.
 *
 * Im Browser gefunden: Die Kategorieauswahl stand ungefragt auf „Sonstiges", und
 * das Markieren überschrieb damit die erkannte Art. Eine Eingangsrechnung landete
 * als „sonstiges" im Archiv — ohne Ausgabe wäre sie dort nur „Aufbewahrung
 * prüfen" gewesen und damit löschbar (D-017).
 *
 * Neutrale Beispieldaten.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetTestStores } from '../test/resetStores';
import { addInboxItem, getInboxItemById, markInboxAsCompanyDocument } from './inboxService';
import { createMockInboxItemFromUpload } from './inboxUploadFactory';
import { CompanyRelevancePanel } from '../components/inbox/CompanyRelevancePanel';
import { t, type TranslationKey } from '../i18n';
import type { ClassifiedDocumentKind, CompanyRelevanceResult } from '../types/models';

function rechnung(): string {
  const item = createMockInboxItemFromUpload({ sourceFileName: 'rechnung.pdf', recognizedText: 'Rechnung' });
  return addInboxItem({ ...item, classifiedKind: 'eingangsrechnung', documentType: 'eingangsrechnung' }).id;
}

beforeEach(() => resetTestStores());
afterEach(() => resetTestStores());

describe('DOKUMENTE-01 — Firmendokument markieren', () => {
  it('ohne gewählte Kategorie bleibt die erkannte Art', () => {
    const id = rechnung();
    const markiert = markInboxAsCompanyDocument(id);
    expect(markiert?.markedAsCompanyDocument).toBe(true);
    expect(getInboxItemById(id)?.classifiedKind).toBe('eingangsrechnung');
  });

  it('eine ausdrücklich gewählte Kategorie ersetzt sie', () => {
    const id = rechnung();
    markInboxAsCompanyDocument(id, 'brief');
    expect(getInboxItemById(id)?.classifiedKind).toBe('brief');
  });

  it('die Auswahl zeigt die erkannte Art statt einer stillen Vorauswahl „Sonstiges"', async () => {
    const container = window.document.createElement('div');
    window.document.body.appendChild(container);
    const root: Root = createRoot(container);
    const relevance = { isRelevant: false } as unknown as CompanyRelevanceResult;
    await act(async () => {
      root.render(
        createElement(CompanyRelevancePanel, {
          relevance,
          translate: (key: TranslationKey) => t(key),
          markedAsCompanyDocument: false,
          selectedCategory: null,
          recognizedKind: 'rechnung' as ClassifiedDocumentKind,
          onCategoryChange: () => {},
          onMarkAsCompanyDocument: () => {},
        }),
      );
    });
    const aktiv = [...container.querySelectorAll('.chip--active')].map((el) => el.textContent);
    expect(aktiv).toEqual([t('classifiedKind.rechnung' as TranslationKey)]);
    expect(container.querySelector('[data-testid="company-relevance-recognized-kind"]')?.textContent).toBe(
      'Erkannt: Rechnung. Ohne andere Auswahl bleibt diese Dokumentart erhalten.',
    );
    act(() => root.unmount());
    container.remove();
  });
});
