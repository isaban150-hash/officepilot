/**
 * CONTRACT-PARTY-ROLES-01 — fachlich erkannte Vertragsrollen haben Vorrang.
 *
 * proposal.customer/contractor sind generische Gegenpartei-Slots: Beim
 * Mietvertrag steht dort der Vermieter bzw. Mieter. Werden sie als
 * Auftraggeber/Auftragnehmer etikettiert, verdrängt die Namens-Deduplizierung
 * anschließend die richtigen Rollen.
 *
 * Geprüft werden die Party-Rows des ViewModels, nicht der HTML-Volltext — im
 * eingebetteten Originaltext steht „Vermieter“ ohnehin.
 */
import { describe, expect, it } from 'vitest';
import { buildContractWorkspaceSummaryView } from './services/contractWorkspaceSummaryView';
import { t } from './i18n';
import type {
  ContractIntelligenceResult,
  ContractOrderProposal,
  DetectedContractParty,
} from './types/documentIntelligence';

function buildProposal(
  parties: DetectedContractParty[],
  overrides: Partial<ContractOrderProposal> = {},
): ContractOrderProposal {
  const intelligence: ContractIntelligenceResult = {
    documentLabelKey: 'documentIntelligence.label.unknown',
    classifiedKind: 'sonstiges',
    reviewRequired: false,
    segmentation: {
      pages: [],
      contractCorePages: [1],
      billOfQuantitiesPages: [],
      technicalAttachmentPages: [],
      commercialAttachmentPages: [],
      unknownPages: [],
    },
    contractFields: {},
    parties,
    positions: [],
    paymentTerms: [],
    progressBillingAllowed: false,
    finalInvoiceMentioned: false,
    technicalAttachmentCount: 0,
    openReviewHints: [],
  };

  return {
    customer: '',
    contractor: '',
    constructionSite: '',
    positionCount: 0,
    paymentTermsSummary: '',
    reviewHints: [],
    positions: [],
    intelligence,
    ...overrides,
  };
}

/** Sichtbares Rollen-Label je Partei, wie es die Komponente rendert. */
function partyLabels(proposal: ContractOrderProposal): Array<{ role: string; name: string }> {
  return buildContractWorkspaceSummaryView(proposal).partyRows.map((row) => ({
    role: t(row.roleLabelKey, 'de'),
    name: row.name,
  }));
}

describe('CONTRACT-PARTY-ROLES-01 – fachliche Rollen vor generischem Fallback', () => {
  it('A: Mietvertrag zeigt Vermieter und Mieter, nicht Auftraggeber/Auftragnehmer', () => {
    const proposal = buildProposal([
      { role: 'vermieter', name: 'Haus & Hof GmbH' },
      { role: 'mieter', name: 'Büro Partner UG' },
    ]);

    expect(partyLabels(proposal)).toEqual([
      { role: 'Vermieter', name: 'Haus & Hof GmbH' },
      { role: 'Mieter', name: 'Büro Partner UG' },
    ]);
  });

  it('B: generische Slots mit denselben Namen erzeugen keine zweite Zeile', () => {
    const proposal = buildProposal(
      [
        { role: 'vermieter', name: 'Haus & Hof GmbH' },
        { role: 'mieter', name: 'Büro Partner UG' },
      ],
      { customer: 'Haus & Hof GmbH', contractor: 'Büro Partner UG' },
    );

    const rows = partyLabels(proposal);
    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.role)).toEqual(['Vermieter', 'Mieter']);
    expect(rows.map((row) => row.name)).toEqual(['Haus & Hof GmbH', 'Büro Partner UG']);
  });

  it('C: Werkvertrag behält Auftraggeber/Auftragnehmer inklusive eigenem Betrieb', () => {
    const proposal = buildProposal(
      [
        { role: 'auftraggeber', name: 'NordWest Dachbau GmbH' },
        { role: 'auftragnehmer', name: 'Cirmak Haustechnik GmbH' },
      ],
      { customer: 'NordWest Dachbau GmbH', contractor: 'Cirmak Haustechnik GmbH' },
    );

    const view = buildContractWorkspaceSummaryView(proposal);
    expect(partyLabels(proposal)).toEqual([
      { role: 'Auftraggeber', name: 'NordWest Dachbau GmbH' },
      { role: 'Auftragnehmer', name: 'Cirmak Haustechnik GmbH' },
    ]);
    expect(view.partyRows.find((row) => row.name === 'Cirmak Haustechnik GmbH')?.isOwnCompany).toBe(
      true,
    );
  });

  it('D: weitere Familien behalten ihre eigenen Rollen', () => {
    const wartung = buildProposal(
      [
        { role: 'auftraggeber', name: 'Nord Technik AG' },
        { role: 'dienstleister', name: 'Klima Service GmbH' },
      ],
      { customer: 'Nord Technik AG', contractor: 'Klima Service GmbH' },
    );
    const arbeit = buildProposal(
      [
        { role: 'arbeitgeber', name: 'Bau Nord GmbH' },
        { role: 'arbeitnehmer', name: 'Jens Peters' },
      ],
      { customer: 'Bau Nord GmbH', contractor: 'Jens Peters' },
    );

    expect(partyLabels(wartung).map((row) => row.role)).toEqual(['Auftraggeber', 'Dienstleister']);
    expect(partyLabels(arbeit).map((row) => row.role)).toEqual(['Arbeitgeber', 'Arbeitnehmer']);
  });

  it('E: ohne erkannte Parteien bleibt der generische Fallback erhalten', () => {
    const proposal = buildProposal([], {
      customer: 'Isobautec GmbH',
      contractor: 'Ivan Iliev',
    });

    expect(partyLabels(proposal)).toEqual([
      { role: 'Auftraggeber', name: 'Isobautec GmbH' },
      { role: 'Auftragnehmer', name: 'Ivan Iliev' },
    ]);
  });

  it('E2: fehlt nur eine Seite, füllt der Fallback genau diese Lücke', () => {
    const proposal = buildProposal([{ role: 'vermieter', name: 'Haus & Hof GmbH' }], {
      customer: 'Haus & Hof GmbH',
      contractor: 'Büro Partner UG',
    });

    expect(partyLabels(proposal)).toEqual([
      { role: 'Vermieter', name: 'Haus & Hof GmbH' },
      { role: 'Auftragnehmer', name: 'Büro Partner UG' },
    ]);
  });
});
