import type { DocumentPageText } from '../types/documentIntelligence';
import { buildPageMarker } from '../services/documentSegmentationService';

function page(pageNumber: number, text: string): DocumentPageText {
  return { pageNumber, text };
}

export function buildSyntheticWerkvertragPages(): DocumentPageText[] {
  return [
    page(1, `
Werkvertrag
Auftraggeber: Isobautec GmbH
Subunternehmer: Ivan Iliev
Baustellenbezeichnung: BV Sägewerk Fisch
Baustellenadresse: Möhnetal 55, 59602 Rüthen
Vertragsdatum: 02.03.2026
Vertragsgegenstand: Abdichtungsarbeiten Flachdach
Zahlungsbedingungen: 14 Tage mit 2 % Skonto oder 30 Tage netto
Abschlagsrechnungen sind wöchentlich möglich. Schlussrechnung nach Abnahme.
    `.trim()),
    page(2, 'Vergütung und Termine. Nachweispflichten: Freistellungsbescheinigung, BG BAU.'),
    page(3, 'Gewährleistungsfrist 5 Jahre. Vertragsstrafe bei Verzug 0,5 % pro Tag.'),
    page(4, 'Unterschrift Auftraggeber'),
    page(5, 'Unterschrift Auftragnehmer'),
    page(6, 'Allgemeine Vertragsbedingungen.'),
    page(7, 'Besondere Vertragsbedingungen.'),
    page(8, `
Leistungsverzeichnis
Pos. Menge Einheit Bezeichnung EP GP
1 4.799,00 qm PE-Folie verlegen EP 0,35 € GP 1.679,65 €
2 4.799,00 qm Dämmung verlegen EP 2,80 € GP 13.437,20 €
3 4.799,00 qm PVC-Folie verlegen EP 2,80 € GP 13.437,20 €
4 255,00 lfdm Traufanschluss EP 10,00 € GP 2.550,00 €
5 125,00 lfdm Attikaanschluss EP 10,00 € GP 1.250,00 €
6 4 Stück Lichtkuppel eindichten EP 60,00 € GP 240,00 €
7 1.200,00 qm Randdämmung EP 1,20 € GP 1.440,00 €
8 980,00 qm Gefälledämmung EP 2,10 € GP 2.058,00 €
9 45,00 lfdm Anschlussblech EP 18,00 € GP 810,00 €
10 12,00 Stück Dachdurchführung EP 95,00 € GP 1.140,00 €
11 1 pauschal Kleinmaterial und Hilfsmittel EP 386,00 € GP 386,00 €
Gesamtsumme netto 36.029,05 €
    `.trim()),
    page(9, 'Technische Zeichnung Dachaufsicht Maßstab 1:100'),
    page(10, 'Windlastberechnung nach DIN EN 1991-1-4'),
    page(11, 'Befestigungsplan Lichtkuppel Detail A'),
    page(12, 'Montagezeichnung Attikaanschluss'),
  ];
}

export function buildSyntheticWerkvertragText(): string {
  return buildSyntheticWerkvertragPages()
    .map((entry) => `${buildPageMarker(entry.pageNumber)}${entry.text}`)
    .join('');
}

export const SAMPLE_EINGANGSRECHNUNG_TEXT = `
Rechnung
Rechnungsnummer: RE-2026-9912
Rechnungsdatum: 05.03.2026
Rechnungsempfänger: Mustermann Sanitär GmbH
Leistungszeitraum: 01.03.2026 – 05.03.2026
Nettobetrag: 1.240,00 €
Umsatzsteuer 19 %: 235,60 €
Bruttobetrag: 1.475,60 €
Bitte überweisen Sie den Betrag auf unsere Bankverbindung.
`.trim();

export const SAMPLE_STUNDENPREIS_CONTRACT_TEXT = `
Werkvertrag
Auftraggeber: Beispiel Bau GmbH
Subunternehmer: Demo Montage
Stundensatz Monteur: 35 €/Stunde
Vertragssumme netto: 12.500,00 €
`.trim();
