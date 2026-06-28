import { describe, expect, it, beforeEach } from 'vitest';
import { createTestVorgang } from '../test/fixtures';
import {
  CLASSIFIED_DOCUMENT_KINDS,
  classifyDocument,
  classifyInboxItem,
  detectClassifiedKind,
  getClassifiedKindFromItem,
  getClassificationForItem,
  mapKindToDocumentType,
  suggestActions,
  suggestDigitalFolder,
  suggestPaperFolder,
  suggestRelatedVorgang,
} from './documentClassificationService';
import { createMockInboxItemFromUpload } from './inboxUploadFactory';
import { hydrateVorgangStore } from './vorgangService';
import type { InboxItem } from '../types/models';

describe('detectClassifiedKind', () => {
  it('detects kinds from upload hints', () => {
    expect(detectClassifiedKind({ kindHint: 'bg_bau' })).toBe('bg_bau');
    expect(detectClassifiedKind({ kindHint: 'materialrechnung' })).toBe('rechnung');
    expect(detectClassifiedKind({ kindHint: 'zahlungserinnerung' })).toBe('mahnung');
    expect(detectClassifiedKind({ kindHint: 'auftrag' })).toBe('auftrag');
    expect(detectClassifiedKind({ kindHint: 'kontoauszug' })).toBe('kontoauszug');
  });

  it('detects kinds from text patterns', () => {
    expect(
      detectClassifiedKind({
        recognizedText: 'Freistellungsbescheinigung nach §48b UStG',
      }),
    ).toBe('freistellungsbescheinigung');

    expect(
      detectClassifiedKind({
        senderHint: 'Finanzamt Berlin',
        recognizedText: 'Umsatzsteuervoranmeldung',
      }),
    ).toBe('finanzamt');

    expect(
      detectClassifiedKind({
        senderHint: 'AOK Nordost',
        recognizedText: 'Beitragsbescheid',
      }),
    ).toBe('aok');

    expect(
      detectClassifiedKind({
        recognizedText: 'Unbedenklichkeitsbescheinigung BG BAU',
      }),
    ).toBe('unbedenklichkeitsbescheinigung');
  });

  it('covers all classified document kinds in registry', () => {
    expect(CLASSIFIED_DOCUMENT_KINDS.length).toBeGreaterThanOrEqual(20);
    for (const kind of CLASSIFIED_DOCUMENT_KINDS) {
      expect(mapKindToDocumentType(kind)).toBeTruthy();
    }
  });
});

describe('classifyDocument', () => {
  it('classifies BG BAU with folder and action suggestions', () => {
    const result = classifyDocument({ kindHint: 'bg_bau', senderHint: 'BG BAU' });

    expect(result.classifiedKind).toBe('bg_bau');
    expect(result.documentType).toBe('behoerde');
    expect(result.digitalFolder.path).toContain('BG-BAU');
    expect(result.paperFiling.folderId).toBe('folder-5');
    expect(result.actions.map((a) => a.id)).toContain('save_bg_bau_folder');
    expect(result.actions.map((a) => a.id)).toContain('check_deadline');
    expect(result.explanation).toContain('BG-BAU');
  });

  it('classifies Rechnung with vorgang and payment actions', () => {
    const result = classifyDocument({ kindHint: 'materialrechnung' });

    expect(result.classifiedKind).toBe('rechnung');
    expect(result.recommendedAction).toBe('zuordnen');
    expect(result.actions.map((a) => a.id)).toEqual(
      expect.arrayContaining(['link_vorgang', 'check_payment', 'archive']),
    );
  });

  it('classifies Freistellungsbescheinigung with tax actions', () => {
    const result = classifyDocument({
      recognizedText: 'Freistellungsbescheinigung gültig bis 31.12.2026',
    });

    expect(result.classifiedKind).toBe('freistellungsbescheinigung');
    expect(result.digitalFolder.path).toContain('Freistellungsbescheinigungen');
    expect(result.actions.map((a) => a.id)).toContain('save_tax_folder');
    expect(result.actions.map((a) => a.id)).toContain('send_to_customer');
  });

  it('classifies Mahnung as critical with mark important action', () => {
    const result = classifyDocument({ kindHint: 'zahlungserinnerung' });

    expect(result.classifiedKind).toBe('mahnung');
    expect(result.priority).toBe('kritisch');
    expect(result.actions.map((a) => a.id)).toContain('mark_important');
  });

  it('classifies Auftrag with create vorgang actions', () => {
    const result = classifyDocument({ kindHint: 'auftrag', senderHint: 'Familie Müller' });

    expect(result.classifiedKind).toBe('auftrag');
    expect(result.documentType).toBe('kundenauftrag');
    expect(result.actions.map((a) => a.id)).toContain('create_vorgang');
    expect(result.actions.map((a) => a.id)).toContain('import_positions');
  });

  it('marks werbung as advertisement', () => {
    const result = classifyDocument({ kindHint: 'werbung', recognizedText: 'Sommer-Sale Prospekt' });

    expect(result.isAdvertisement).toBe(true);
    expect(result.recommendedAction).toBe('entsorgen');
  });
});

describe('suggestDigitalFolder and suggestPaperFolder', () => {
  it('suggests AOK health folder', () => {
    const folder = suggestDigitalFolder('aok');
    expect(folder.path).toContain('Krankenkassen/AOK');
  });

  it('suggests steuer paper folder for kontoauszug', () => {
    const paper = suggestPaperFolder('kontoauszug');
    expect(paper.folderId).toBe('folder-4');
  });
});

describe('suggestRelatedVorgang', () => {
  beforeEach(() => {
    localStorage.clear();
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-mueller',
        title: 'Badezimmer-Sanierung Müller',
        customer: 'Familie Müller',
        baustelle: 'Hauptstr. 12',
      }),
    ]);
  });

  it('suggests vorgang when customer and vorgang name match', () => {
    const link = suggestRelatedVorgang(
      { Kunde: 'Familie Müller', Vorgang: 'Badezimmer-Sanierung Müller' },
      'Hornbach',
      'Materialrechnung',
    );

    expect(link).not.toBeNull();
    expect(link?.vorgangId).toBe('v-mueller');
    expect(link?.confidence).toBe('high');
  });
});

describe('integration: upload → classification → inbox item', () => {
  beforeEach(() => {
    localStorage.clear();
    hydrateVorgangStore([
      createTestVorgang({
        id: 'v-mueller',
        title: 'Badezimmer-Sanierung Müller',
        customer: 'Familie Müller',
        baustelle: 'Hauptstr. 12',
      }),
    ]);
  });

  it('creates classified inbox item from upload', () => {
    const item = createMockInboxItemFromUpload({
      kind: 'materialrechnung',
      sourceFileName: 'hornbach_rechnung.jpg',
    });

    expect(item.classifiedKind).toBe('rechnung');
    expect(item.isNewUpload).toBe(true);
    expect(item.recognizedData.Rechnungsnummer).toBeTruthy();
    expect(getClassifiedKindFromItem(item)).toBe('rechnung');
  });

  it('derives actions for existing inbox item', () => {
    const item = createMockInboxItemFromUpload({ kind: 'bg_bau' });
    const classification = getClassificationForItem(item);

    expect(classification.actions.length).toBeGreaterThan(0);
    expect(classification.explanation).toBeTruthy();
  });

  it('classifyInboxItem produces persistable shape', () => {
    const item = classifyInboxItem({
      kindHint: 'auftrag',
      sourceFileName: 'auftrag_mueller.pdf',
    });

    expect(item.id).toMatch(/^inbox-upload-/);
    expect(item.status).toBe('neu');
    expect(item.classifiedKind).toBe('auftrag');
    expect(suggestActions(item.classifiedKind!, item).some((a) => a.id === 'create_vorgang')).toBe(
      true,
    );
  });
});

describe('getClassifiedKindFromItem legacy fallback', () => {
  it('reads Dokumentart from recognized data', () => {
    const item: InboxItem = {
      id: 'legacy-1',
      title: 'Test',
      documentType: 'behoerde',
      sender: 'BG BAU',
      priority: 'mittel',
      deadline: null,
      recommendedAction: 'abheften',
      digitalFolder: { id: 'd', name: 'n', path: '/' },
      paperFiling: { folderId: 'folder-5', register: 'A', label: 'x' },
      status: 'neu',
      receivedAt: '2026-01-01',
      recognizedData: { Dokumentart: 'bg_bau' },
      officePilotSuggestion: '',
      nextTaskLabel: '',
      securityHint: '',
    };

    expect(getClassifiedKindFromItem(item)).toBe('bg_bau');
  });
});
