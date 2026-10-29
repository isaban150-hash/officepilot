/**
 * EINRICHTUNG-01 (AP8; Vertrag 1.28, X-04) — neue Rückfragen: „Abbrechen“ sendet nichts, „Bestätigen“ führt aus.
 *
 *   Wissenseintrag löschen — Rückfrage im Gefahrenstil; Abbrechen lässt den Eintrag, Bestätigen löscht
 *   (Bestätigungswege der übrigen neuen Rückfragen: lokale Wiederherstellung in BackupExportPanel.test und
 *   einrichtung01BackupPanelAp0, Logo entfernen in designSettingsPage01b3, Übergabeantrag widerrufen in
 *   einrichtung01TeamAp4; das Verhalten von „Abbrechen“ ist das gemeinsame von SimpleConfirmDialog.)
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { KnowledgePanel } from './components/knowledge/KnowledgePanel';
import { TestProviders } from './test/testProviders';
import { DEFAULT_SETUP } from './data/mockData';
import { addKnowledgeFact, getKnowledgeFacts, resetKnowledgeFacts } from './services/knowledgeService';

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  resetKnowledgeFacts();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  resetKnowledgeFacts();
});

const q = (selector: string) => host.querySelector(selector) as HTMLElement | null;

describe('EINRICHTUNG-01 AP8 — Rückfragen (1.28)', () => {
  it('Wissenseintrag löschen: Rückfrage; „Abbrechen“ lässt ihn, „Eintrag löschen“ löscht', () => {
    const angelegt = addKnowledgeFact({ scope: 'company', category: 'pricing_history', key: 'stundensatz', value: '68 €', displayText: 'Stundensatz 68 €' });
    expect(angelegt.success).toBe(true);
    act(() => {
      root.render(createElement(MemoryRouter, null, createElement(TestProviders, { initialSetup: DEFAULT_SETUP }, createElement(KnowledgePanel))));
    });
    const id = getKnowledgeFacts()[0].id;
    act(() => q(`[data-testid="knowledge-delete-${id}"]`)!.click());
    expect(q('[data-testid="knowledge-delete-dialog"]')).not.toBeNull();
    act(() => q('[data-testid="knowledge-delete-cancel"]')!.click());
    expect(q('[data-testid="knowledge-delete-dialog"]')).toBeNull();
    expect(getKnowledgeFacts()).toHaveLength(1);
    act(() => q(`[data-testid="knowledge-delete-${id}"]`)!.click());
    act(() => q('[data-testid="knowledge-delete-confirm"]')!.click());
    expect(getKnowledgeFacts()).toHaveLength(0);
  });
});
