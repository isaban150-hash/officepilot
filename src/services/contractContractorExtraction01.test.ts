/**
 * CONTRACT-CONTRACTOR-EXTRACTION-01 — Parteienlabels sind Zeilenlabels.
 *
 * Zuvor genügte es, dass das Rollenwort irgendwo in einer Zeile vorkam. Damit
 * wurde „Unterschrift Auftragnehmer“ zum Label und die beiden folgenden
 * Klauselüberschriften zum Parteinamen. Umgekehrt sammelte ein echtes Label
 * die nachfolgenden Feldzeilen mit ein.
 */
import { describe, expect, it } from 'vitest';
import { extractAllContractFields, extractContractParties } from './contractIntelligenceExtraction';
import type { DocumentPageText } from '../types/documentIntelligence';
import { analyzeContractIntelligenceFromText, buildContractOrderProposal } from './contractIntelligenceService';
import { createAuftragInboxItem } from '../test/fixtures';
import {
  buildSyntheticWerkvertragPages,
  buildSyntheticWerkvertragText,
} from '../test/werkvertragMultiSectionFixtures';
import type { InboxItem } from '../types/models';

function partyByRole(text: string, role: string): string | undefined {
  return extractContractParties(text).find((party) => party.role === role)?.name;
}

function fieldsOf(text: string) {
  const pages: DocumentPageText[] = [{ pageNumber: 1, text }];
  return extractAllContractFields(text, pages);
}

/** Rolle + Prädikat ohne Trennzeichen — Fließtext, kein Label. */
const PROSE_LINES = [
  'Auftragnehmer führt die Leistungen fachgerecht aus.',
  'Auftraggeber erteilt die Freigabe nach Prüfung.',
  'Subunternehmer übernimmt die Abdichtungsarbeiten.',
  'Dienstleister wartet die Anlage einmal jährlich.',
  'Arbeitnehmer verpflichtet sich zur Verschwiegenheit.',
];

function syntheticWerkvertragItem(): InboxItem {
  return {
    ...createAuftragInboxItem(),
    id: 'inbox-contractor-extraction-01',
    sender: 'Isobautec GmbH',
    recognizedData: {
      Kunde: 'Isobautec GmbH',
      _vertragstext: buildSyntheticWerkvertragText(),
      _pageTexts: JSON.stringify(buildSyntheticWerkvertragPages()),
    },
  };
}

describe('CONTRACT-CONTRACTOR-EXTRACTION-01 – synthetischer Werkvertrag', () => {
  it('A: proposal.contractor ist der reine Name', () => {
    const proposal = buildContractOrderProposal(syntheticWerkvertragItem());

    expect(proposal?.customer).toBe('Isobautec GmbH');
    expect(proposal?.contractor).toBe('Ivan Iliev');
    expect(proposal?.contractor).not.toMatch(/Baustellen|Vertragsbedingungen|SEITE/i);
  });

  it('B: intelligence.parties enthält keinen Klauseltext', () => {
    const intelligence = analyzeContractIntelligenceFromText(
      buildSyntheticWerkvertragText(),
      buildSyntheticWerkvertragPages(),
    );
    const parties = intelligence?.parties ?? [];

    expect(parties.find((party) => party.role === 'auftraggeber')?.name).toBe('Isobautec GmbH');
    expect(parties.find((party) => party.role === 'subunternehmer')?.name).toBe('Ivan Iliev');
    for (const party of parties) {
      expect(party.name).not.toMatch(/Vertragsbedingungen|SEITE|Unterschrift/i);
    }
  });

  it('B2: contractFields.auftragnehmer trägt keine Folgefelder', () => {
    const intelligence = analyzeContractIntelligenceFromText(
      buildSyntheticWerkvertragText(),
      buildSyntheticWerkvertragPages(),
    );

    expect(intelligence?.contractFields.auftragnehmer?.value).toBe('Ivan Iliev');
  });
});

describe('CONTRACT-CONTRACTOR-EXTRACTION-01 – Labelerkennung', () => {
  it('C: Unterschriftszeile erzeugt keine Partei', () => {
    const text = [
      'Unterschrift Auftragnehmer',
      'Allgemeine Vertragsbedingungen',
      'Besondere Vertragsbedingungen',
    ].join('\n');

    expect(extractContractParties(text)).toEqual([]);
  });

  it('D: eigenständige Labelzeile nimmt die Folgezeile', () => {
    const text = ['Auftragnehmer:', 'Cirmak Haustechnik GmbH'].join('\n');

    expect(partyByRole(text, 'auftragnehmer')).toBe('Cirmak Haustechnik GmbH');
  });

  it('D2: eigenständige Labelzeile ohne Doppelpunkt funktioniert weiterhin', () => {
    const text = ['Auftragnehmer', 'Cirmak Haustechnik GmbH'].join('\n');

    expect(partyByRole(text, 'auftragnehmer')).toBe('Cirmak Haustechnik GmbH');
  });

  it('E: direktes Label endet an der Zeile', () => {
    const text = [
      'Subunternehmer: Ivan Iliev',
      'Baustellenbezeichnung: BV Sägewerk Fisch',
      'Baustellenadresse: Möhnetal 55, 59602 Rüthen',
    ].join('\n');

    expect(partyByRole(text, 'subunternehmer')).toBe('Ivan Iliev');
  });

  it('F: Rollenwort im Fließtext erzeugt keine Partei', () => {
    const cases = [
      'Pflichten des Auftragnehmers',
      'Freigabe durch den Auftraggeber',
      'Leistungen des Subunternehmers',
      'Unterschrift des Auftragnehmers',
    ];

    for (const line of cases) {
      expect(extractContractParties(`${line}\nSonstige Regelungen bleiben unberührt.`), line).toEqual(
        [],
      );
    }
  });

  it('F2: eigenständiges Label stoppt vor Seitenmarker und Klauselzeile', () => {
    const text = ['Auftragnehmer', '--- SEITE 6 ---', 'Allgemeine Vertragsbedingungen'].join('\n');

    expect(extractContractParties(text)).toEqual([]);
  });

  it('G: gängige Familienrollen bleiben erkennbar', () => {
    const miete = ['Vermieter: Haus & Hof GmbH', 'Mieter: Büro Partner UG'].join('\n');
    const wartung = ['Auftraggeber: Nord Technik AG', 'Dienstleister: Klima Service GmbH'].join('\n');
    const arbeit = ['Arbeitgeber: Bau Nord GmbH', 'Arbeitnehmer: Jens Peters'].join('\n');

    expect(partyByRole(miete, 'vermieter')).toBe('Haus & Hof GmbH');
    expect(partyByRole(miete, 'mieter')).toBe('Büro Partner UG');
    expect(partyByRole(wartung, 'dienstleister')).toBe('Klima Service GmbH');
    expect(partyByRole(arbeit, 'arbeitgeber')).toBe('Bau Nord GmbH');
    expect(partyByRole(arbeit, 'arbeitnehmer')).toBe('Jens Peters');
  });
});

/**
 * CONTRACT-CONTRACTOR-EXTRACTION-01B — ohne echtes Trennzeichen ist eine
 * Rollenzeile Fließtext. Die Regel muss auf allen Eintrittswegen gelten:
 * Parteienextraktion, PARTY_PATTERNS-Fallback und der directRegex in
 * extractFieldByLabelFallback.
 */
describe('CONTRACT-CONTRACTOR-EXTRACTION-01B – Trennzeichenpflicht bei Parteien', () => {
  it.each(PROSE_LINES)('A: „%s" erzeugt keine Partei', (line) => {
    expect(extractContractParties(line)).toEqual([]);
  });

  it.each(PROSE_LINES)('B: „%s" erzeugt kein Parteienfeld', (line) => {
    const fields = fieldsOf(line);

    expect(fields.auftraggeber?.value ?? null).toBeNull();
    expect(fields.auftragnehmer?.value ?? null).toBeNull();
  });

  it('B2: auch im Fließtextabsatz entsteht keine Partei', () => {
    const text = [
      ...PROSE_LINES,
      'Die Vertragsparteien vereinbaren die Geltung der VOB/B.',
    ].join('\n');

    expect(extractContractParties(text)).toEqual([]);
    expect(fieldsOf(text).auftragnehmer?.value ?? null).toBeNull();
  });

  it('C: direktes Label mit Doppelpunkt funktioniert', () => {
    expect(partyByRole('Auftragnehmer: Cirmak Haustechnik GmbH', 'auftragnehmer')).toBe(
      'Cirmak Haustechnik GmbH',
    );
  });

  /**
   * Gedankenstrich (– / —). Der ASCII-Bindestrich ist hier bewusst nicht
   * abgedeckt: normalizeContractText() repariert damit Silbentrennung und
   * entfernt ihn zwischen zwei Wörtern — bestehendes Verhalten, unverändert.
   */
  it('D: direktes Label mit Gedankenstrich funktioniert', () => {
    expect(partyByRole('Auftragnehmer – Cirmak Haustechnik GmbH', 'auftragnehmer')).toBe(
      'Cirmak Haustechnik GmbH',
    );
    expect(partyByRole('Auftragnehmer — Cirmak Haustechnik GmbH', 'auftragnehmer')).toBe(
      'Cirmak Haustechnik GmbH',
    );
  });

  it('E: eigenständiges Label mit und ohne Doppelpunkt funktioniert', () => {
    expect(partyByRole('Auftragnehmer:\nCirmak Haustechnik GmbH', 'auftragnehmer')).toBe(
      'Cirmak Haustechnik GmbH',
    );
    expect(partyByRole('Auftragnehmer\nCirmak Haustechnik GmbH', 'auftragnehmer')).toBe(
      'Cirmak Haustechnik GmbH',
    );
  });
});

describe('CONTRACT-CONTRACTOR-EXTRACTION-01B – Firmennamen vs. Struktur', () => {
  const ACCEPTED = [
    'Allgemeine Bau GmbH',
    'Besondere Dienste GmbH',
    'Seite & Sohn GmbH',
    'Anlage Technik GmbH',
    'Vertragsbedingungen Consulting GmbH',
  ];

  it.each(ACCEPTED)('F–J: „%s" wird als direktes Label akzeptiert', (name) => {
    expect(partyByRole(`Auftragnehmer: ${name}`, 'auftragnehmer')).toBe(name);
  });

  it.each(ACCEPTED)('F–J: „%s" wird nach eigenständigem Label akzeptiert', (name) => {
    expect(partyByRole(`Auftragnehmer\n${name}`, 'auftragnehmer')).toBe(name);
  });

  it('K: § 7 Projektbau GmbH wird abgelehnt', () => {
    expect(partyByRole('Auftragnehmer: § 7 Projektbau GmbH', 'auftragnehmer')).toBeUndefined();
    expect(partyByRole('Auftragnehmer\n§ 7 Projektbau GmbH', 'auftragnehmer')).toBeUndefined();
  });

  it('L: strukturelle Texte bleiben abgelehnt', () => {
    const structural = [
      'Allgemeine Vertragsbedingungen',
      'Besondere Vertragsbedingungen',
      '--- SEITE 6 ---',
      'Seite 6',
      'Anlage 1',
      'Anlage: Leistungsverzeichnis',
      '§ 7 Behinderungen und Unterbrechungen',
      'Unterschrift Auftragnehmer',
    ];

    for (const line of structural) {
      expect(extractContractParties(`Auftragnehmer\n${line}`), line).toEqual([]);
    }
  });
});

describe('CONTRACT-CONTRACTOR-EXTRACTION-01B – Nicht-Parteienfelder', () => {
  it('M: Formate ohne Trennzeichen bleiben erhalten', () => {
    const text = [
      'Vertragsnummer OP-2026-17',
      'Vertragsdatum 11.08.2026',
      'Bauvorhaben BV Rüthen',
      'Baustelle Möhnetal 55, 59602 Rüthen',
    ].join('\n');
    const fields = fieldsOf(text);

    expect(fields.vertragsnummer?.value).toBe('OP-2026-17');
    expect(fields.vertragsdatum?.value).toBe('11.08.2026');
    expect(fields.bauvorhaben?.value).toBe('BV Rüthen');
    expect(fields.baustelle?.value).toBe('Möhnetal 55, 59602 Rüthen');
  });
});

/**
 * CONTRACT-CONTRACTOR-EXTRACTION-01E — mehrere Feldlabels in einer Zeile.
 *
 * Nicht-Parteienfelder dürfen sich eine Zeile teilen; jeder Wert endet am
 * nächsten bekannten Feldlabel. Die strengen Parteienregeln bleiben unberührt.
 */
describe('CONTRACT-CONTRACTOR-EXTRACTION-01E – Feldgrenze innerhalb einer Zeile', () => {
  it('Bauvorhaben und Baustelle in einer Zeile werden getrennt', () => {
    const fields = fieldsOf('Bauvorhaben: Umbau Verwaltungsgebäude Baustelle: Industriestraße 12');

    expect(fields.bauvorhaben?.value).toBe('Umbau Verwaltungsgebäude');
    expect(fields.baustelle?.value).toBe('Industriestraße 12');
  });

  it('umgekehrte Feldreihenfolge wird ebenso getrennt', () => {
    const fields = fieldsOf('Baustelle: Hafenweg 3 Bauvorhaben: Neubau Lagerhalle');

    expect(fields.baustelle?.value).toBe('Hafenweg 3');
    expect(fields.bauvorhaben?.value).toBe('Neubau Lagerhalle');
  });

  it('Vertragsnummer und Vertragsdatum in einer Zeile werden getrennt', () => {
    const fields = fieldsOf('Vertragsnummer: WV-2027-004 Vertragsdatum: 03.02.2027');

    expect(fields.vertragsnummer?.value).toBe('WV-2027-004');
    expect(fields.vertragsdatum?.value).toBe('03.02.2027');
  });

  it('Trennzeichen U+2013 und U+2014 funktionieren auch hier', () => {
    const enDash = fieldsOf('Bauvorhaben – Sanierung Schulzentrum Baustelle – Ringstraße 8');
    const emDash = fieldsOf('Vertragsnummer — DL-2027-118 Vertragsdatum — 14.03.2027');

    expect(enDash.bauvorhaben?.value).toBe('Sanierung Schulzentrum');
    expect(enDash.baustelle?.value).toBe('Ringstraße 8');
    expect(emDash.vertragsnummer?.value).toBe('DL-2027-118');
    expect(emDash.vertragsdatum?.value).toBe('14.03.2027');
  });

  it('neutrale Vertragsvariante A bleibt vollständig getrennt', () => {
    const fields = fieldsOf(
      [
        'Werkvertrag',
        'Auftraggeber: Stadtwerke Melle AöR',
        'Auftragnehmer: Elbe Metallbau GmbH',
        'Bauvorhaben: Erweiterung Betriebshof Baustelle: Osnabrücker Straße 91',
        'Vertragsnummer: SW-2027-0042 Vertragsdatum: 12.01.2027',
      ].join('\n'),
    );

    expect(fields.auftraggeber?.value).toBe('Stadtwerke Melle AöR');
    expect(fields.auftragnehmer?.value).toBe('Elbe Metallbau GmbH');
    expect(fields.bauvorhaben?.value).toBe('Erweiterung Betriebshof');
    expect(fields.baustelle?.value).toBe('Osnabrücker Straße 91');
    expect(fields.vertragsnummer?.value).toBe('SW-2027-0042');
    expect(fields.vertragsdatum?.value).toBe('12.01.2027');
  });

  it('neutrale Vertragsvariante B mit anderer Reihenfolge und Gedankenstrich', () => {
    const fields = fieldsOf(
      [
        'Subunternehmervertrag',
        'Baustelle – Am Alten Hafen 4 Bauvorhaben – Kaimauer Instandsetzung',
        'Auftraggeber – Hansa Wasserbau AG',
        'Subunternehmer – Nordstrand Tiefbau GmbH',
      ].join('\n'),
    );

    expect(fields.baustelle?.value).toBe('Am Alten Hafen 4');
    expect(fields.bauvorhaben?.value).toBe('Kaimauer Instandsetzung');
    expect(fields.auftraggeber?.value).toBe('Hansa Wasserbau AG');
    expect(fields.auftragnehmer?.value).toBe('Nordstrand Tiefbau GmbH');
  });

  it('einlabelige Zeilen bleiben unverändert', () => {
    const fields = fieldsOf(
      ['Bauvorhaben: Dachsanierung Turnhalle', 'Baustelle: Lindenallee 7'].join('\n'),
    );

    expect(fields.bauvorhaben?.value).toBe('Dachsanierung Turnhalle');
    expect(fields.baustelle?.value).toBe('Lindenallee 7');
  });

  it('die strengen Parteienregeln bleiben unberührt', () => {
    const prose = 'Auftragnehmer stellt das Gerüst Baustelle: Ringstraße 8';

    expect(extractContractParties(prose).some((party) => party.role === 'auftragnehmer')).toBe(false);
    expect(fieldsOf(prose).auftragnehmer?.value ?? null).toBeNull();
  });
});

describe('CONTRACT-CONTRACTOR-EXTRACTION-01B – Fallback-Kette', () => {
  it('N: ohne Partei und ohne Feld greift item.sender', () => {
    const text = [
      'Werkvertrag',
      'Vertragsdatum: 11.08.2026',
      'Bauvorhaben: BV Rüthen',
      'Leistungsverzeichnis',
      'Pos. 1 4,00 qm Abdichtung EP 10,00 € GP 40,00 €',
    ].join('\n');
    const item: InboxItem = {
      ...createAuftragInboxItem(),
      id: 'inbox-sender-fallback-01',
      sender: 'Dach & Wand Nord GmbH',
      recognizedData: { _vertragstext: text },
    };

    const intelligence = analyzeContractIntelligenceFromText(text, [{ pageNumber: 1, text }]);
    expect(intelligence?.parties?.some((party) => party.role === 'auftragnehmer')).toBeFalsy();
    expect(intelligence?.contractFields.auftragnehmer?.value ?? null).toBeNull();

    const proposal = buildContractOrderProposal(item, intelligence ?? undefined);
    expect(proposal?.contractor).toBe(item.sender);
  });
});
