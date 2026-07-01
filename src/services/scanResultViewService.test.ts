import { describe, expect, it } from 'vitest';
import { buildScanResultView } from './scanResultViewService';
import type { InboxItem } from '../types/models';

function createItem(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: 'test-1',
    title: 'Schreiben Finanzamt',
    documentType: 'behoerde',
    sender: 'Finanzamt Berlin',
    priority: 'hoch',
    deadline: null,
    recommendedAction: 'abheften',
    digitalFolder: { id: 'behoerde', path: '/Behoerde', name: 'Behörde' },
    paperFiling: { folderId: 'folder-5', label: 'Behörden', register: '2026' },
    status: 'neu',
    receivedAt: '2026-06-01',
    recognizedData: { betreff: 'Steuerbescheid 2025' },
    officePilotSuggestion: 'Ablegen und Frist beachten',
    nextTaskLabel: 'Ablegen',
    securityHint: '',
    isNewUpload: true,
    ...overrides,
  };
}

describe('scanResultViewService', () => {
  it('baut ein Werbe-Ergebnis ohne Speicher-Hinweis', () => {
    const view = buildScanResultView(
      createItem({
        isAdvertisement: true,
        title: 'Sonderangebot Rohre',
        recommendedAction: 'entsorgen',
      }),
    );

    expect(view.recognizedTitle).toBe('Werbung');
    expect(view.assistantMessageKey).toBe('scanResult.message.advertisement');
    expect(view.paperInstruction).toBeUndefined();
  });

  it('enthält Papierablage-Hinweis für Briefe', () => {
    const view = buildScanResultView(createItem());

    expect(view.recognizedTitle).toContain('Finanzamt');
    expect(view.paperInstruction).toMatch(/Behörden/);
    expect(view.nextActions.length).toBeGreaterThan(0);
    expect(view.nextActions.length).toBeLessThanOrEqual(3);
  });
});
