import { describe, expect, it, beforeEach } from 'vitest';
import { createTestVorgang } from '../test/fixtures';
import {
  CLASSIFIED_DOCUMENT_KINDS,
  classifyDocument,
  classifyInboxItem,
  detectClassifiedKind,
  detectClassifiedKindWithReason,
  getClassifiedKindFromItem,
  getClassificationForItem,
  mapKindToDocumentType,
  suggestActions,
  suggestDigitalFolder,
  suggestPaperFolder,
  suggestRelatedVorgang,
} from './documentClassificationService';
import { suggestProcessType } from './documentClassificationCatalog';
import { createMockInboxItemFromUpload } from './inboxUploadFactory';
import { isDocumentAnalysisAllowed } from './companyRelevanceService';
import { hydrateVorgangStore } from './vorgangService';
import type { CompanyProfile, InboxItem } from '../types/models';

const testProfile: CompanyProfile = {
  companyName: 'Muster GmbH',
  legalForm: 'GmbH',
  street: 'Test 1',
  zip: '10115',
  city: 'Berlin',
  country: 'Deutschland',
  contactPerson: 'Max',
  phone: '030',
  email: 'info@muster.de',
  website: '',
  taxNumber: '123',
  vatId: 'DE123',
  bankName: 'Bank',
  iban: 'DE00',
  bic: 'BIC',
  defaultPaymentDays: 14,
  defaultPaymentTerms: '14 Tage',
  defaultSkonto: '',
  invoiceFooterNotes: '',
};

describe('detectClassifiedKind', () => {
  it('detects kinds from upload hints', () => {
    expect(detectClassifiedKind({ kindHint: 'bg_bau' })).toBe('bg_bau');
    expect(detectClassifiedKind({ kindHint: 'materialrechnung' })).toBe('eingangsrechnung');
    expect(detectClassifiedKind({ kindHint: 'zahlungserinnerung' })).toBe('zahlungserinnerung');
    expect(detectClassifiedKind({ kindHint: 'auftrag' })).toBe('auftrag');
    expect(detectClassifiedKind({ kindHint: 'kontoauszug' })).toBe('kontoauszug');
  });

  it('detects Behörden from text patterns', () => {
    expect(detectClassifiedKind({ recognizedText: 'Hauptzollamt Mitteilung' })).toBe('zoll');
    expect(detectClassifiedKind({ recognizedText: 'Handwerkskammer München' })).toBe('handwerkskammer');
    expect(detectClassifiedKind({ recognizedText: 'IHK Berlin Schreiben' })).toBe('ihk');
    expect(detectClassifiedKind({ recognizedText: 'Bauamt Genehmigung' })).toBe('bauamt');
    expect(detectClassifiedKind({ recognizedText: 'Agentur für Arbeit Bescheid' })).toBe('agentur_fuer_arbeit');
  });

  it('detects Krankenkassen from text patterns', () => {
    expect(detectClassifiedKind({ senderHint: 'AOK Nordost', recognizedText: 'Beitragsbescheid' })).toBe('aok');
    expect(detectClassifiedKind({ recognizedText: 'Barmer Beitragsrechnung' })).toBe('barmer');
    expect(detectClassifiedKind({ recognizedText: 'Techniker Krankenkasse' })).toBe('tk');
    expect(detectClassifiedKind({ recognizedText: 'DAK Gesundheit Mitteilung' })).toBe('dak');
    expect(detectClassifiedKind({ recognizedText: 'SOKA-BAU Bescheinigung' })).toBe('soka_bau');
  });

  it('detects Buchhaltung from text patterns', () => {
    expect(detectClassifiedKind({ recognizedText: 'Eingangsrechnung Nr. 1234' })).toBe('eingangsrechnung');
    expect(detectClassifiedKind({ recognizedText: 'Ausgangsrechnung an Kunde' })).toBe('ausgangsrechnung');
    expect(detectClassifiedKind({ recognizedText: 'Gutschrift 2026' })).toBe('gutschrift');
    expect(detectClassifiedKind({ recognizedText: 'Kontoauszug Sparkasse' })).toBe('kontoauszug');
    expect(detectClassifiedKind({ recognizedText: 'Steuerbescheid Finanzamt' })).toBe('steuerbescheid');
  });

  it('löst U15-Grenzfälle: ER mit Lieferschein-Ref, Ausgangs-Abschlag, AOK, Honorar, HU/AU', () => {
    expect(
      detectClassifiedKind({
        recognizedText:
          'GC-Großhandel OWL GmbH Rechnung RE-2026-11842 Lieferschein LS-11840 Netto 100,00 € USt 19,00 € Brutto 119,00 € Zahlungsziel 14 Tage',
      }),
    ).toBe('eingangsrechnung');
    expect(
      detectClassifiedKind({
        recognizedText:
          'Cirmak Haustechnik GmbH Ausgangsrechnung Abschlagsrechnung Nr. AR-2026-0028 zu Werkvertrag WV-2025-0912 Netto 5.000,00 € Brutto 5.950,00 €',
      }),
    ).toBe('ausgangsrechnung');
    expect(
      detectClassifiedKind({
        recognizedText:
          'AOK NordWest Behördenschreiben Beitragsnachweis Arbeitgeber Februar 2026 Forderung / Beitrag 6.120,15 €',
      }),
    ).toBe('aok');
    expect(
      detectClassifiedKind({
        recognizedText:
          'Steuerberatung Ostwestfalen GmbH Honorarrechnung StB-2026-041 Lohnabrechnung Feb. 2026 (10 MA) 320,00 € Netto 800,00 € USt 152,00 € Brutto 952,00 €',
      }),
    ).toBe('eingangsrechnung');
    expect(
      detectClassifiedKind({
        recognizedText:
          'AutoService Teutoburger GmbH HU / AU Prüfbericht Kennzeichen LIP-CH 1001 Ergebnis HU ohne Mangel Nächste HU 02/2028',
      }),
    ).toBe('tuev_bericht');
    expect(
      detectClassifiedKind({
        recognizedText:
          'AutoService Teutoburger GmbH Werkstattrechnung Rechnung WR-2026-0222 Netto 548,00 € USt 104,12 € Brutto 652,12 €',
      }),
    ).toBe('reparaturrechnung');
  });

  it('detects Utility-, Hotel- und Telekom-Rechnungen ohne Rechnungsnummer', () => {
    expect(
      detectClassifiedKind({
        recognizedText:
          'Stadtwerke Bad Salzuflen Energie / Versorgung Stromrechnung 02/2026 Netto 1.124,60 € USt 213,67 € Brutto 1.338,27 €',
      }),
    ).toBe('rechnung');
    expect(
      detectClassifiedKind({
        recognizedText: 'Stadtwerke Musterstadt Gasrechnung 01/2026 Kundenkonto 123 Verbrauch 1200 kWh',
      }),
    ).toBe('rechnung');
    expect(
      detectClassifiedKind({
        recognizedText: 'Stadtwerke Musterstadt Wasser-/Abwasserrechnung Zählerstand 8821',
      }),
    ).toBe('rechnung');
    expect(
      detectClassifiedKind({
        recognizedText: 'Telekom Geschäftskunden Mobilfunkrechnung 03/2026 Rufnummer 0151 88421001',
      }),
    ).toBe('eingangsrechnung');
    expect(
      detectClassifiedKind({
        recognizedText: 'Telekom Geschäftskunden Rechnung Internet & Festnetz Company Flex 250',
      }),
    ).toBe('eingangsrechnung');
    expect(
      detectClassifiedKind({
        recognizedText: 'Hotel Lipperland Hotelrechnung Parkstraße 10 Aufenthalt 24.–25.01.2026',
      }),
    ).toBe('eingangsrechnung');
    expect(
      detectClassifiedKind({
        recognizedText: 'Aral Station Nord Tankstelle Diesel 52,40 l Tankbeleg Betrag 92,95 €',
      }),
    ).toBe('tankbeleg');
  });

  it('detects Werkvertrag and customer documents', () => {
    expect(detectClassifiedKind({ recognizedText: 'Werkvertrag Sanierung' })).toBe('werkvertrag');
    expect(detectClassifiedKind({ recognizedText: 'Subunternehmervertrag' })).toBe('subunternehmervertrag');
    expect(detectClassifiedKind({ recognizedText: 'Abnahmeprotokoll Baustelle' })).toBe('abnahmeprotokoll');
    expect(detectClassifiedKind({ recognizedText: 'Leistungsverzeichnis LV' })).toBe('leistungsverzeichnis');
  });

  it('detects Mitarbeiterdokumente', () => {
    expect(detectClassifiedKind({ recognizedText: 'Lohnabrechnung Januar' })).toBe('lohnabrechnung');
    expect(detectClassifiedKind({ recognizedText: 'Stundenzettel KW 12' })).toBe('stundenzettel');
    expect(detectClassifiedKind({ recognizedText: 'Arbeitsvertrag unbefristet' })).toBe('arbeitsvertrag');
    expect(detectClassifiedKind({ recognizedText: 'AU-Bescheinigung Krankenkasse' })).toBe(
      'arbeitsunfaehigkeitsbescheinigung',
    );
  });

  it('detects Versicherungen', () => {
    expect(detectClassifiedKind({ recognizedText: 'Betriebshaftpflicht Police' })).toBe('betriebshaftpflicht');
    expect(detectClassifiedKind({ recognizedText: 'Versicherungsbescheid 2026' })).toBe('versicherungsbescheid');
  });

  it('detects Fahrzeug- und Baustellendokumente', () => {
    expect(detectClassifiedKind({ recognizedText: 'TÜV Hauptuntersuchung' })).toBe('tuev_bericht');
    expect(detectClassifiedKind({ recognizedText: 'Tankstelle Diesel Beleg' })).toBe('tankbeleg');
    expect(detectClassifiedKind({ recognizedText: 'Entsorgungsnachweis Baustelle' })).toBe('entsorgungsnachweis');
    expect(detectClassifiedKind({ sourceFileName: 'baustelle.jpg' })).toBe('baustellenfoto');
  });

  it('covers all classified document kinds in registry', () => {
    expect(CLASSIFIED_DOCUMENT_KINDS.length).toBeGreaterThanOrEqual(80);
    for (const kind of CLASSIFIED_DOCUMENT_KINDS) {
      expect(mapKindToDocumentType(kind)).toBeTruthy();
    }
  });

  it('returns detection reason key', () => {
    const detection = detectClassifiedKindWithReason({
      recognizedText: 'Freistellungsbescheinigung nach §48b UStG',
    });
    expect(detection.kind).toBe('freistellungsbescheinigung');
    expect(detection.reasonKey).toBe('classification.detect.freistellung');
  });
});

describe('processType', () => {
  it('assigns create_vorgang to Werkvertrag', () => {
    const result = classifyDocument({ recognizedText: 'Werkvertrag Müller' });
    expect(result.processType).toBe('create_vorgang');
  });

  it('assigns record_expense to Eingangsrechnung', () => {
    const result = classifyDocument({ kindHint: 'materialrechnung' });
    expect(result.processType).toBe('record_expense');
  });

  it('assigns reminder_required to Mahnung', () => {
    const result = classifyDocument({ recognizedText: '2. Mahnung offener Betrag' });
    expect(result.processType).toBe('reminder_required');
  });

  it('assigns payment_check to Kontoauszug', () => {
    expect(suggestProcessType('kontoauszug')).toBe('payment_check');
  });

  it('assigns send_to_client to Freistellungsbescheinigung', () => {
    expect(suggestProcessType('freistellungsbescheinigung')).toBe('send_to_client');
  });
});

describe('classifyDocument', () => {
  it('classifies BG BAU with folder and action suggestions', () => {
    const result = classifyDocument({ kindHint: 'bg_bau', senderHint: 'BG BAU' });

    expect(result.classifiedKind).toBe('bg_bau');
    expect(result.documentType).toBe('behoerde');
    expect(result.digitalFolder.path).toContain('BG-BAU');
    expect(result.paperFiling.folderId).toBe('paper-behoerden');
    expect(result.paperFiling.register).toBe('BG BAU');
    expect(result.actions.map((a) => a.id)).toContain('save_bg_bau_folder');
    expect(result.actions.map((a) => a.id)).toContain('create_task');
    expect(result.detectionReasonKey).toBe('classification.detect.uploadHint');
  });

  it('classifies Eingangsrechnung with expense actions', () => {
    const result = classifyDocument({ kindHint: 'materialrechnung' });

    expect(result.classifiedKind).toBe('eingangsrechnung');
    expect(result.recommendedAction).toBe('zuordnen');
    expect(result.digitalFolder.path).toContain('Steuerberater');
    expect(result.actions.map((a) => a.id)).toEqual(
      expect.arrayContaining(['record_expense', 'link_vorgang', 'save_tax_folder']),
    );
  });

  it('classifies Freistellungsbescheinigung with tax actions', () => {
    const result = classifyDocument({
      recognizedText: 'Freistellungsbescheinigung gültig bis 31.12.2026',
    });

    expect(result.classifiedKind).toBe('freistellungsbescheinigung');
    expect(result.digitalFolder.path).toContain('Freistellungsbescheinigungen');
    expect(result.actions.map((a) => a.id)).toContain('save_tax_folder');
    expect(result.actions.map((a) => a.id)).toContain('monitor_validity');
    expect(result.actions.map((a) => a.id)).toContain('send_to_customer');
  });

  it('classifies Mahnung as critical with mark important action', () => {
    const result = classifyDocument({ recognizedText: 'Mahnung Zahlungsaufforderung' });

    expect(result.classifiedKind).toBe('mahnung');
    expect(result.priority).toBe('kritisch');
    expect(result.actions.map((a) => a.id)).toContain('mark_important');
    expect(result.actions.map((a) => a.id)).toContain('create_task');
  });

  it('classifies Werkvertrag with vorgang and proof actions', () => {
    const result = classifyDocument({ recognizedText: 'Werkvertrag Sanierung', senderHint: 'Familie Müller' });

    expect(result.classifiedKind).toBe('werkvertrag');
    expect(result.documentType).toBe('kundenauftrag');
    expect(result.digitalFolder.path).toContain('/Verträge/');
    expect(result.actions.map((a) => a.id)).toContain('create_vorgang');
    expect(result.actions.map((a) => a.id)).toContain('check_proof_requirements');
  });

  it('classifies Abnahmeprotokoll with schlussrechnung suggestion', () => {
    const result = classifyDocument({ recognizedText: 'Abnahmeprotokoll Badezimmer' });

    expect(result.classifiedKind).toBe('abnahmeprotokoll');
    expect(result.processType).toBe('create_invoice');
    expect(result.actions.map((a) => a.id)).toContain('suggest_schlussrechnung');
  });

  it('classifies Stundenzettel with import hours action', () => {
    const result = classifyDocument({ recognizedText: 'Stundenzettel März 2026' });

    expect(result.classifiedKind).toBe('stundenzettel');
    expect(result.actions.map((a) => a.id)).toContain('import_hours');
  });

  it('classifies Tankbeleg with expense folder', () => {
    const result = classifyDocument({ recognizedText: 'Tankstelle Diesel Beleg' });

    expect(result.classifiedKind).toBe('tankbeleg');
    expect(result.digitalFolder.path).toContain('Fahrzeuge/Tankbelege');
    expect(result.actions.map((a) => a.id)).toContain('record_expense');
  });

  it('marks werbung as advertisement', () => {
    const result = classifyDocument({ kindHint: 'werbung', recognizedText: 'Sommer-Sale Prospekt' });

    expect(result.isAdvertisement).toBe(true);
    expect(result.recommendedAction).toBe('entsorgen');
    expect(result.processType).toBe('archive_only');
  });
});

describe('suggestDigitalFolder and suggestPaperFolder', () => {
  it('suggests AOK health folder', () => {
    const folder = suggestDigitalFolder('aok');
    expect(folder.path).toContain('Krankenkassen/AOK');
  });

  it('suggests steuer folder for eingangsrechnung', () => {
    const folder = suggestDigitalFolder('eingangsrechnung');
    expect(folder.path).toContain('Steuerberater');
    expect(folder.path).toContain('Eingangsrechnungen');
  });

  it('suggests Betriebshaftpflicht insurance folder', () => {
    const folder = suggestDigitalFolder('betriebshaftpflicht');
    expect(folder.path).toContain('Versicherungen/Betriebshaftpflicht');
  });

  it('suggests steuer paper folder for kontoauszug', () => {
    const paper = suggestPaperFolder('kontoauszug');
    expect(paper?.folderId).toBe('folder-4');
  });

  it('suggests employee folder for lohnabrechnung', () => {
    const folder = suggestDigitalFolder('lohnabrechnung');
    expect(folder.path).toContain('Mitarbeiter/Lohnunterlagen');
  });

  it('suggests Aufträge folder for auftrag', () => {
    const folder = suggestDigitalFolder('auftrag', { customer: 'Müller GmbH' });
    expect(folder.path).toContain('/Kunden/Müller-GmbH/Aufträge/');
    expect(folder.path).not.toContain('/Verträge/');
  });
});

describe('suggestActions limits', () => {
  it('returns at most 3 primary-visible actions before toggle in UI contract', () => {
    const actions = suggestActions('werkvertrag');
    expect(actions.length).toBeGreaterThan(3);
    expect(actions.slice(0, 3).every((a) => a.variant !== undefined)).toBe(true);
  });

  it('removes vorgang actions when already linked', () => {
    const actions = suggestActions('werkvertrag', { vorgangLinkStatus: 'linked' });
    expect(actions.map((a) => a.id)).not.toContain('create_vorgang');
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

    expect(item.classifiedKind).toBe('eingangsrechnung');
    expect(item.isNewUpload).toBe(true);
    expect(item.recognizedData.Rechnungsnummer).toBeUndefined();
    expect(getClassifiedKindFromItem(item)).toBe('eingangsrechnung');
  });

  it('derives full classification for existing inbox item', () => {
    const item = createMockInboxItemFromUpload({ kind: 'bg_bau' });
    const classification = getClassificationForItem(item);

    expect(classification.actions.length).toBeGreaterThan(0);
    expect(classification.processType).toBeTruthy();
    expect(classification.detectionReasonKey).toBeTruthy();
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
    expect(suggestActions(item.classifiedKind!, item).some((a) => a.id === 'create_vorgang')).toBe(true);
  });
});

describe('company relevance gating', () => {
  it('blocks analysis for non-company documents', () => {
    const item: InboxItem = {
      id: 'private-1',
      title: 'Privater Brief',
      documentType: 'brief',
      sender: 'Unbekannt',
      priority: 'niedrig',
      deadline: null,
      recommendedAction: 'klaeren',
      digitalFolder: { id: 'd', name: 'n', path: '/' },
      paperFiling: { folderId: 'folder-5', register: 'A', label: 'x' },
      status: 'neu',
      receivedAt: '2026-01-01',
      recognizedData: { Betreff: 'Privat' },
      officePilotSuggestion: '',
      nextTaskLabel: '',
      securityHint: '',
    };

    expect(isDocumentAnalysisAllowed(item, testProfile)).toBe(false);
  });

  it('allows analysis when marked as company document', () => {
    const item: InboxItem = {
      id: 'marked-1',
      title: 'BG BAU',
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
      markedAsCompanyDocument: true,
    };

    expect(isDocumentAnalysisAllowed(item, testProfile)).toBe(true);
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
