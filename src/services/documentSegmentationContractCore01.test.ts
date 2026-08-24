/**
 * OFFICEPILOT-DOCUMENT-SEGMENTATION-CONTRACT-CORE-01B
 *
 * Ein Bauvertrag nennt sein Leistungsverzeichnis fast immer — als
 * Vertragsgrundlage in den ersten Paragraphen und als Abrechnungsmaßstab beim
 * Zahlungsteil. Bisher genügte diese bloße Erwähnung, um die Seite als
 * Leistungsverzeichnis einzustufen; der Parteiblock der ersten Seite fiel damit
 * aus `contractCorePages` und aus dem Text, aus dem die Vertragsparteien
 * gelesen werden.
 *
 * Die Unterscheidung läuft daher über Struktur, nicht über Vokabeln: echte
 * Positionszeilen und Tabellenköpfe gegen Vertragsüberschrift, Parteiblock und
 * Paragraphenfolge.
 *
 * Neutrale Beispieldaten, kein Netzwerk.
 */
import { describe, expect, it } from 'vitest';
import { joinSectionText, segmentDocumentPages } from './documentSegmentationService';
import { extractContractParties } from './contractIntelligenceExtraction';
import { analyzeContractIntelligenceFromText } from './contractIntelligenceService';
import type { DocumentPageText } from '../types/documentIntelligence';

/** Seite 1 des realen Kontrollvertrags: Parteiblock plus LV-Erwähnung. */
const PAGE_1 = [
  'OfficePilot Testvertrag - NordWest Dachbau GmbH / Cirmak Haustechnik GmbH',
  'TESTDOKUMENT - NICHT RECHTSVERBINDLICH',
  'WERKVERTRAG / BAU-SUBUNTERNEHMERVERTRAG',
  'Auftraggeber NordWest Dachbau GmbH',
  'Westring 88',
  '33330 Gütersloh',
  'Geschäftsführer: Martin Voss',
  'Auftragnehmer Cirmak Haustechnik GmbH',
  'Bahnhofstraße 15',
  '32105 Bad Salzuflen',
  'Geschäftsführer: Saban Irmak',
  'Bauvorhaben Logistikzentrum Avenwedde - Dachsanierung Halle 3',
  'Baustelle Carl-Bertelsmann-Straße 211, 33335 Gütersloh',
  'Vertragsdatum 09.08.2026',
  '§ 1 Gegenstand des Vertrages',
  'Der Auftragnehmer übernimmt die Dachabdichtungsarbeiten.',
  '§ 2 Vertragsgrundlagen',
  'Es gelten die VOB/B sowie das Leistungsverzeichnis in Anlage 2.',
].join('\n');

/** Seite 2: reiner Zahlungsteil, verweist auf das LV als Abrechnungsmaßstab. */
const PAGE_2 = [
  '§ 3 Vergütung',
  'Vertragssumme netto 34.624,00 EUR',
  '§ 4 Abschlags- und Schlussrechnungen',
  'Die Abrechnung erfolgt nach Leistungsverzeichnis. Zahlungsziel 30 Tage netto.',
  '§ 5 Bauabzugsteuer / Freistellungsbescheinigung',
  'Eine gültige Freistellungsbescheinigung ist vorzulegen.',
].join('\n');

const PAGE_3 = [
  '§ 6 Gewährleistung',
  'Die Gewährleistungsfrist beträgt 5 Jahre ab Abnahme.',
  '§ 7 Kündigung',
  'Die Kündigung bedarf der Schriftform.',
].join('\n');

const PAGE_4 = 'Unterschrift Auftraggeber';
const PAGE_5 = 'Unterschrift Auftragnehmer';
const PAGE_6 = 'Allgemeine Vertragsbedingungen.';

/** Seite 7: echtes Leistungsverzeichnis mit Tabellenkopf und Positionszeilen. */
const PAGE_7 = [
  'Anlage 2 - Leistungsverzeichnis',
  'Pos. Menge Einh. Bezeichnung EP netto Gesamt netto',
  '1 100,00 qm Abdichtung herstellen 5,00 500,00',
  '2 250,00 m2 Dampfsperre verlegen 4,00 1.000,00',
  '3 40,00 lfm Randabschluss 12,00 480,00',
].join('\n');

/** Seite 8: LV-Fortsetzung, ebenfalls mit echten Positionszeilen. */
const PAGE_8 = [
  '4 12,00 Stück Dachdurchführung 95,00 1.140,00',
  '5 1 pauschal Kleinmaterial 386,00 386,00',
  'Gesamtsumme netto 34.624,00 EUR',
].join('\n');

const PAGES: DocumentPageText[] = [
  { pageNumber: 1, text: PAGE_1 },
  { pageNumber: 2, text: PAGE_2 },
  { pageNumber: 3, text: PAGE_3 },
  { pageNumber: 4, text: PAGE_4 },
  { pageNumber: 5, text: PAGE_5 },
  { pageNumber: 6, text: PAGE_6 },
  { pageNumber: 7, text: PAGE_7 },
  { pageNumber: 8, text: PAGE_8 },
];

const sectionOf = (pageNumber: number) =>
  segmentDocumentPages(PAGES).pages.find((page) => page.pageNumber === pageNumber);

describe('OFFICEPILOT-DOCUMENT-SEGMENTATION-CONTRACT-CORE-01B', () => {
  it('A: Vertragsseite mit LV nur als Vertragsgrundlage bleibt Vertragskern', () => {
    expect(sectionOf(1)?.sectionType).toBe('contract_core');
  });

  it('B: Zahlungsseite mit LV als Abrechnungsmaßstab bleibt Vertragskern', () => {
    expect(sectionOf(2)?.sectionType).toBe('contract_core');
  });

  it('C: eine echte LV-Seite bleibt Leistungsverzeichnis', () => {
    const page7 = sectionOf(7);
    expect(page7?.sectionType).toBe('bill_of_quantities');
    expect(page7?.confidence).toBe('high');
  });

  it('D: das gemischte Dokument wird durchgängig richtig getrennt', () => {
    const result = segmentDocumentPages(PAGES);

    expect(result.contractCorePages).toContain(1);
    expect(result.contractCorePages).toContain(2);
    expect(result.billOfQuantitiesPages).toEqual([7, 8]);
    expect(result.contractCorePages).not.toContain(7);
    expect(result.contractCorePages).not.toContain(8);
  });

  it('D2: der Parteiblock steht im zusammengefügten Vertragskern', () => {
    const result = segmentDocumentPages(PAGES);
    const contractText = joinSectionText(PAGES, result.contractCorePages);

    expect(contractText).toContain('Auftraggeber NordWest Dachbau GmbH');
    expect(contractText).toContain('Westring 88');
    expect(contractText).toContain('33330 Gütersloh');
    expect(contractText).toContain('Geschäftsführer: Martin Voss');
  });

  it('E: die Party-Extraktion erreicht Adresse und Ansprechpartner über den Vertragskern', () => {
    const result = segmentDocumentPages(PAGES);
    const contractText = joinSectionText(PAGES, result.contractCorePages);
    const auftraggeber = extractContractParties(contractText).find(
      (party) => party.role === 'auftraggeber',
    );

    expect(auftraggeber?.name).toBe('NordWest Dachbau GmbH');
    expect(auftraggeber?.street).toBe('Westring 88');
    expect(auftraggeber?.zip).toBe('33330');
    expect(auftraggeber?.city).toBe('Gütersloh');
    expect(auftraggeber?.contactPerson).toBe('Martin Voss');
  });

  it('E2: dieselbe Strecke über die reale Contract-Intelligence mit pageTexts', () => {
    const fullText = PAGES.map((page) => page.text).join('\n\n');
    const intelligence = analyzeContractIntelligenceFromText(fullText, PAGES);
    const auftraggeber = intelligence?.parties.find((party) => party.role === 'auftraggeber');

    expect(auftraggeber?.name).toBe('NordWest Dachbau GmbH');
    expect(auftraggeber?.street).toBe('Westring 88');
    expect(auftraggeber?.zip).toBe('33330');
    expect(auftraggeber?.city).toBe('Gütersloh');
    expect(auftraggeber?.contactPerson).toBe('Martin Voss');
  });

  it('F: eine LV-Seite ohne Vertragssignale bleibt auch ohne Positionszeilen LV', () => {
    const pages: DocumentPageText[] = [
      { pageNumber: 1, text: 'Leistungsverzeichnis Fortsetzung\nGesamtsumme netto 1.000,00 EUR' },
    ];

    expect(segmentDocumentPages(pages).pages[0]?.sectionType).toBe('bill_of_quantities');
  });
});
