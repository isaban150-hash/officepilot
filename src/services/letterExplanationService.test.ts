import { describe, expect, it } from 'vitest';
import type { InboxItem } from '../types/models';
import {
  detectLetterKind,
  getLetterExplanation,
  isExplainableLetter,
} from './letterExplanationService';

function createInboxItem(overrides: Partial<InboxItem> = {}): InboxItem {
  return {
    id: 'inbox-test',
    title: 'Testschreiben',
    documentType: 'brief',
    sender: 'Test Absender',
    priority: 'mittel',
    deadline: null,
    recommendedAction: 'abheften',
    digitalFolder: { id: 'dig-1', name: 'Briefe', path: '/Firma/Briefe/' },
    paperFiling: { folderId: 'folder-5', register: 'A', label: 'Behörden & Versicherungen' },
    status: 'neu',
    receivedAt: '2026-03-27',
    recognizedData: {},
    officePilotSuggestion: 'Mock',
    nextTaskLabel: 'Prüfen',
    securityHint: 'Mock',
    ...overrides,
  };
}

describe('detectLetterKind', () => {
  it('detects brief document type', () => {
    expect(detectLetterKind(createInboxItem({ documentType: 'brief' }))).toBe('brief');
  });

  it('detects BG BAU from sender', () => {
    expect(
      detectLetterKind(
        createInboxItem({
          documentType: 'behoerde',
          sender: 'BG BAU – Berufsgenossenschaft',
        }),
      ),
    ).toBe('bg_bau');
  });

  it('detects Finanzamt', () => {
    expect(
      detectLetterKind(
        createInboxItem({
          documentType: 'behoerde',
          sender: 'Finanzamt Berlin',
          title: 'Steuerbescheid 2025',
        }),
      ),
    ).toBe('finanzamt');
  });

  it('detects Krankenkasse / AOK', () => {
    expect(
      detectLetterKind(
        createInboxItem({
          documentType: 'behoerde',
          sender: 'AOK Nordost',
        }),
      ),
    ).toBe('krankenkasse');
  });

  it('detects SOKA-BAU', () => {
    expect(
      detectLetterKind(
        createInboxItem({
          documentType: 'behoerde',
          sender: 'SOKA-BAU',
        }),
      ),
    ).toBe('soka_bau');
  });

  it('detects Versicherung', () => {
    expect(
      detectLetterKind(
        createInboxItem({
          documentType: 'behoerde',
          sender: 'Allianz Versicherung',
          title: 'Haftpflicht Mitteilung',
        }),
      ),
    ).toBe('versicherung');
  });

  it('returns null for invoices', () => {
    expect(
      detectLetterKind(createInboxItem({ documentType: 'eingangsrechnung' })),
    ).toBeNull();
  });

  it('returns null for advertisement', () => {
    expect(
      detectLetterKind(createInboxItem({ documentType: 'sonstiges', isAdvertisement: true })),
    ).toBeNull();
  });
});

describe('isExplainableLetter', () => {
  it('is true for brief and behoerde types', () => {
    expect(isExplainableLetter(createInboxItem({ documentType: 'brief' }))).toBe(true);
    expect(isExplainableLetter(createInboxItem({ documentType: 'behoerde' }))).toBe(true);
  });

  it('is false for kundenauftrag', () => {
    expect(isExplainableLetter(createInboxItem({ documentType: 'kundenauftrag' }))).toBe(false);
  });
});

describe('getLetterExplanation', () => {
  it('returns all required sections', () => {
    const explanation = getLetterExplanation(
      createInboxItem({
        documentType: 'behoerde',
        sender: 'BG BAU',
        deadline: '2026-04-10',
        recognizedData: { Betreff: 'Beitragsbescheid Q1' },
      }),
    );

    expect(explanation).not.toBeNull();
    expect(explanation!.kind).toBe('bg_bau');
    expect(explanation!.about).toContain('BG BAU');
    expect(explanation!.importance).toBeTruthy();
    expect(explanation!.deadline).toContain('2026-04-10');
    expect(explanation!.nextSteps).toBeTruthy();
    expect(explanation!.digitalStorage).toContain('Briefe');
    expect(explanation!.paperStorage).toContain('abheften');
    expect(explanation!.disclaimer).toContain('Steuerberater');
    expect(explanation!.disclaimer).toContain('Rechts- oder Steuerberatung');
  });

  it('includes uncertain hint when no deadline', () => {
    const explanation = getLetterExplanation(createInboxItem({ deadline: null }));
    expect(explanation!.deadline).toContain('Bitte prüfen');
  });

  it('returns null for non-letter documents', () => {
    expect(
      getLetterExplanation(createInboxItem({ documentType: 'eingangsrechnung' })),
    ).toBeNull();
  });
});
