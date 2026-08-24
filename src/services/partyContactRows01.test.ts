/**
 * OFFICEPILOT-PARTY-CONTACT-SCOPING-01B — die Auftragskarte zeigt je Partei
 * deren eigenen Ansprechpartner.
 *
 * `buildPartyRows` las bisher einmal dokumentweit `fields.ansprechpartner` und
 * hängte diesen Wert an jede Zeile; `party.contactPerson` blieb ungenutzt. Bei
 * zwei Parteien stand dadurch derselbe Ansprechpartner auf beiden Seiten.
 *
 * Neutrale Beispieldaten, kein Netzwerk.
 */
import { describe, expect, it } from 'vitest';
import { extractContractParties } from './contractIntelligenceExtraction';
import { buildContractWorkspaceSummaryView } from './contractWorkspaceSummaryView';
import type {
  ContractIntelligenceResult,
  ContractOrderProposal,
  DetectedContractParty,
} from '../types/documentIntelligence';

const WESTFALEN = [
  'Auftraggeber Westfalen Projektbau GmbH',
  'Industriestraße 27',
  '33689 Bielefeld',
  'Ansprechpartner: Daniel Krüger',
  'E-Mail: daniel.krueger@westfalen-projektbau.test',
  'Telefon: 0521 555 0147',
  'Auftragnehmer Cirmak Haustechnik GmbH',
  'Bahnhofstraße 15',
  '32105 Bad Salzuflen',
  'Geschäftsführer: Saban Irmak',
].join('\n');

function buildProposal(parties: DetectedContractParty[]): ContractOrderProposal {
  const intelligence = {
    documentLabelKey: 'documentIntelligence.label.werkvertrag',
    classifiedKind: 'werkvertrag',
    reviewRequired: false,
    segmentation: {
      pages: [],
      contractCorePages: [1],
      billOfQuantitiesPages: [],
      technicalAttachmentPages: [],
      commercialAttachmentPages: [],
      unknownPages: [],
    },
    // Der dokumentweite Ansprechpartner ist bewusst gesetzt: genau er wurde
    // bisher an beide Parteien kopiert.
    contractFields: {
      ansprechpartner: { value: 'Daniel Krüger', status: 'confirmed', confidence: 'high' },
    },
    commonFields: {},
    typeSpecificFields: {},
    visibleFields: [],
    contractType: { family: 'werkvertrag', labelKey: 'documentIntelligence.label.werkvertrag', confidence: 'high', status: 'confirmed', evidence: [] },
    parties,
    positions: [],
    clauses: [],
    paymentTerms: [],
    openReviewHints: [],
  } as unknown as ContractIntelligenceResult;

  return {
    customer: 'Westfalen Projektbau GmbH',
    contractor: 'Cirmak Haustechnik GmbH',
    positions: [],
    reviewHints: [],
    intelligence,
  } as unknown as ContractOrderProposal;
}

const rowsOf = () => {
  const view = buildContractWorkspaceSummaryView(buildProposal(extractContractParties(WESTFALEN)));
  return view.partyRows;
};

describe('OFFICEPILOT-PARTY-CONTACT-ROWS-01B', () => {
  it('A: jede Party-Zeile trägt ihren eigenen Ansprechpartner', () => {
    const rows = rowsOf();
    const auftraggeber = rows.find((row) => row.name === 'Westfalen Projektbau GmbH');
    const auftragnehmer = rows.find((row) => row.name === 'Cirmak Haustechnik GmbH');

    expect(auftraggeber?.contact).toBe('Daniel Krüger');
    expect(auftragnehmer?.contact).toBe('Saban Irmak');
  });

  it('B: der Ansprechpartner der einen Partei erscheint nicht bei der anderen', () => {
    const rows = rowsOf();

    expect(rows.filter((row) => row.contact === 'Daniel Krüger')).toHaveLength(1);
    expect(rows.find((row) => row.name === 'Cirmak Haustechnik GmbH')?.contact).not.toBe(
      'Daniel Krüger',
    );
  });

  it('C: die Anzeigeadresse stammt aus den Feldern der jeweiligen Partei', () => {
    const rows = rowsOf();

    expect(rows.find((row) => row.name === 'Westfalen Projektbau GmbH')?.address).toBe(
      'Industriestraße 27, 33689 Bielefeld',
    );
    expect(rows.find((row) => row.name === 'Cirmak Haustechnik GmbH')?.address).toBe(
      'Bahnhofstraße 15, 32105 Bad Salzuflen',
    );
  });

  it('D: bei genau einer Partei bleibt der dokumentweite Ansprechpartner nutzbar', () => {
    const single: DetectedContractParty[] = [
      { role: 'auftraggeber', name: 'Einzel Bau GmbH', status: 'confirmed', confidence: 'high' },
    ];
    const rows = buildContractWorkspaceSummaryView(buildProposal(single)).partyRows;

    expect(rows).toHaveLength(1);
    expect(rows[0]!.contact).toBe('Daniel Krüger');
  });
});
