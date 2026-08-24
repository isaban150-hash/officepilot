/**
 * OFFICEPILOT-CUSTOMER-PREFILL-COUNTERPARTY-IDENTITY-02B
 *
 * Der Kundenvorschlag folgte bisher der Annahme „Auftragnehmer ist die eigene
 * Firma, Auftraggeber ist der Kunde". Beauftragt der Nutzer selbst einen
 * Subunternehmer, kehrt sich das um — und die eigene Anschrift landete im
 * Formular „Neuer Kunde".
 *
 * Deshalb gilt hier dieselbe Ordnung wie beim Direct-Confirmation-Pfad:
 * **Identität zuerst, Rolle danach**. Die eigene Firma wird an ihren eigenen
 * Daten erkannt, nie an ihrer Vertragsrolle; die verbleibende Partei ist die
 * Gegenpartei. Bleibt etwas unklar, gibt es keinen Vorschlag.
 *
 * Neutrale Beispieldaten, kein Netzwerk.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resetTestStores } from '../test/resetStores';
import { hydrateCompanyProfileStore } from './companyProfileService';
import { resolveCounterpartyFromWorkflow } from './businessInterpretationFacts';
import { buildCustomerExtraFromParty } from '../components/customer/customerDecisionUi';
import type {
  ContractIntelligenceResult,
  ContractOrderProposal,
  DetectedContractParty,
} from '../types/documentIntelligence';
import type { WorkflowResult } from '../types/models';

const OWN_PROFILE = {
  companyName: 'Cirmak Haustechnik GmbH',
  street: 'Bahnhofstraße 15',
  zip: '32105',
  city: 'Bad Salzuflen',
  contactPerson: 'Saban Irmak',
};

const CIRMAK = (role: DetectedContractParty['role']): DetectedContractParty => ({
  role,
  name: 'Cirmak Haustechnik GmbH',
  street: 'Bahnhofstraße 15',
  zip: '32105',
  city: 'Bad Salzuflen',
  contactPerson: 'Saban Irmak',
  status: 'confirmed',
  confidence: 'high',
});

const WESTFALEN = (role: DetectedContractParty['role']): DetectedContractParty => ({
  role,
  name: 'Westfalen Projektbau GmbH',
  street: 'Industriestraße 27',
  zip: '33689',
  city: 'Bielefeld',
  contactPerson: 'Daniel Krüger',
  email: 'daniel.krueger@westfalen-projektbau.test',
  phone: '0521 555 0147',
  status: 'confirmed',
  confidence: 'high',
});

const SUBBAU = (role: DetectedContractParty['role']): DetectedContractParty => ({
  role,
  name: 'Beispiel Subbau GmbH',
  street: 'Subweg 4',
  zip: '44444',
  city: 'Substadt',
  contactPerson: 'Sabine Sub',
  email: 'sabine.sub@subbau.test',
  phone: '0444 444 4444',
  status: 'confirmed',
  confidence: 'high',
});

function buildWorkflow(options: {
  parties: DetectedContractParty[];
  family?: string;
  customer?: string;
}): WorkflowResult {
  const intelligence = {
    documentLabelKey: 'documentIntelligence.label.werkvertrag',
    classifiedKind: 'subunternehmervertrag',
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
    commonFields: {},
    typeSpecificFields: {},
    visibleFields: [],
    contractType: {
      family: options.family ?? 'subunternehmervertrag',
      labelKey: 'documentIntelligence.label.werkvertrag',
      confidence: 'high',
      status: 'confirmed',
      evidence: [],
    },
    parties: options.parties,
    positions: [],
    clauses: [],
    paymentTerms: [],
    openReviewHints: [],
  } as unknown as ContractIntelligenceResult;

  const proposal = {
    customer: options.customer,
    positions: [],
    reviewHints: [],
    intelligence,
  } as unknown as ContractOrderProposal;

  return {
    inboxItemId: 'inbox-02b',
    contractIntelligence: intelligence,
    contractOrderProposal: proposal,
  } as unknown as WorkflowResult;
}

const counterpartyOf = (workflow: WorkflowResult) => resolveCounterpartyFromWorkflow(workflow);

describe('OFFICEPILOT-CUSTOMER-COUNTERPARTY-IDENTITY-02B', () => {
  beforeEach(() => {
    resetTestStores();
    hydrateCompanyProfileStore(OWN_PROFILE);
  });

  it('A: Westfalen-Richtung bleibt unverändert vollständig', () => {
    const workflow = buildWorkflow({
      parties: [WESTFALEN('auftraggeber'), CIRMAK('auftragnehmer')],
      customer: 'Westfalen Projektbau GmbH',
    });

    const counterparty = counterpartyOf(workflow);
    expect(counterparty?.name).toBe('Westfalen Projektbau GmbH');

    expect(buildCustomerExtraFromParty(counterparty)).toEqual({
      contactPerson: 'Daniel Krüger',
      street: 'Industriestraße 27',
      zip: '33689',
      city: 'Bielefeld',
      email: 'daniel.krueger@westfalen-projektbau.test',
      phone: '0521 555 0147',
    });
  });

  it('B: umgekehrte Richtung wählt die fremde Partei', () => {
    const workflow = buildWorkflow({
      parties: [CIRMAK('auftraggeber'), SUBBAU('auftragnehmer')],
      customer: 'Cirmak Haustechnik GmbH',
    });

    const counterparty = counterpartyOf(workflow);
    expect(counterparty?.name).toBe('Beispiel Subbau GmbH');

    const extra = buildCustomerExtraFromParty(counterparty);
    expect(extra.street).toBe('Subweg 4');
    expect(extra.contactPerson).toBe('Sabine Sub');
    // Nichts von der eigenen Firma darf im Formular stehen.
    expect(extra.street).not.toBe('Bahnhofstraße 15');
    expect(extra.zip).not.toBe('32105');
    expect(extra.city).not.toBe('Bad Salzuflen');
    expect(extra.contactPerson).not.toBe('Saban Irmak');
  });

  it('C: die Rolle allein macht keine fremde Partei zur eigenen Firma', () => {
    hydrateCompanyProfileStore({
      companyName: 'Ganz Andere GmbH',
      street: 'Anderweg 1',
      zip: '11111',
      city: 'Anderstadt',
      contactPerson: 'Anna Anders',
    });
    const workflow = buildWorkflow({
      parties: [WESTFALEN('auftraggeber'), SUBBAU('auftragnehmer')],
    });

    // Keine Partei ist die eigene Firma — also keine gerichtete Auflösung.
    expect(counterpartyOf(workflow)).toBeUndefined();
  });

  it('D: ohne sichere Identität gibt es keinen gerichteten Vorschlag', () => {
    hydrateCompanyProfileStore({ companyName: '', street: '', zip: '', city: '' });
    const workflow = buildWorkflow({
      parties: [WESTFALEN('auftraggeber'), CIRMAK('auftragnehmer')],
    });

    expect(counterpartyOf(workflow)).toBeUndefined();
  });

  it('E: bei mehrdeutiger Identität gibt es keinen Vorschlag', () => {
    const workflow = buildWorkflow({
      parties: [CIRMAK('auftraggeber'), CIRMAK('auftragnehmer')],
    });

    expect(counterpartyOf(workflow)).toBeUndefined();
  });

  it('F: mehr als zwei Parteien nur mit eindeutigem Kundenkandidaten', () => {
    const parties = [CIRMAK('auftragnehmer'), WESTFALEN('auftraggeber'), SUBBAU('kunde')];

    expect(counterpartyOf(buildWorkflow({ parties }))).toBeUndefined();

    const withCandidate = buildWorkflow({ parties, customer: 'Beispiel Subbau GmbH' });
    expect(counterpartyOf(withCandidate)?.name).toBe('Beispiel Subbau GmbH');
  });

  it('G: eine einzige Partei, die die eigene Firma ist, wird nicht Kunde', () => {
    const workflow = buildWorkflow({ parties: [CIRMAK('auftraggeber')] });

    expect(counterpartyOf(workflow)?.name).not.toBe('Cirmak Haustechnik GmbH');
  });

  it('H: der bestehende Fallback über den Kundenkandidaten bleibt erhalten', () => {
    // Ohne erkannte Parteien trägt allein der Kundenkandidat den Vorschlag.
    const workflow = buildWorkflow({
      parties: [],
      customer: 'Westfalen Projektbau GmbH',
    });

    expect(counterpartyOf(workflow)?.name).toBe('Westfalen Projektbau GmbH');
  });

  it('H2: eine nicht gerichtete Dokumentart verhält sich unverändert', () => {
    // Bei family "unknown" liefert buildPartiesBlock schon bisher keine
    // Gegenpartei aus proposal.customer — dieser Test hält den Ist-Stand fest,
    // damit die Korrektur ihn weder herstellt noch entfernt.
    const workflow = buildWorkflow({
      parties: [],
      family: 'unknown',
      customer: 'Westfalen Projektbau GmbH',
    });

    expect(counterpartyOf(workflow)).toBeUndefined();
  });

  it('I: ist der Kundenkandidat die eigene Firma, wird er nicht vorgeschlagen', () => {
    const workflow = buildWorkflow({
      parties: [],
      family: 'unknown',
      customer: 'Cirmak Haustechnik GmbH',
    });

    expect(counterpartyOf(workflow)?.name).not.toBe('Cirmak Haustechnik GmbH');
  });

  it('J: die Kontaktdaten bleiben party-scoped', () => {
    const workflow = buildWorkflow({
      parties: [WESTFALEN('auftraggeber'), CIRMAK('auftragnehmer')],
      customer: 'Westfalen Projektbau GmbH',
    });
    const extra = buildCustomerExtraFromParty(counterpartyOf(workflow));

    expect(extra.contactPerson).toBe('Daniel Krüger');
    expect(extra.contactPerson).not.toBe('Saban Irmak');
    expect(extra.email).toBe('daniel.krueger@westfalen-projektbau.test');
  });
});
