/**
 * OFFICEPILOT-CUSTOMER-PREFILL-NAME-HANDOFF-02D
 *
 * Das Kundenformular speiste sich aus zwei Quellen: die sechs Zusatzfelder aus
 * der identitätsbasiert bestimmten Gegenpartei, der Name dagegen aus einer
 * rollenbasierten Kandidatenkette. Beauftragt der Nutzer selbst einen
 * Subunternehmer, stand deshalb die eigene Firma im Namensfeld über der
 * Anschrift der Gegenpartei.
 *
 * Dieser Test bildet den Handoff der Seite nach — dieselben drei Aufrufe in
 * derselben Reihenfolge wie im Reset-Effekt — und prüft alle sieben sichtbaren
 * Felder gemeinsam. Genau diese Zusammensetzung fehlte den bisherigen Tests.
 *
 * Neutrale Beispieldaten, kein Netzwerk.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resetTestStores } from './test/resetStores';
import { hydrateCompanyProfileStore } from './services/companyProfileService';
import { resolveCounterpartyFromWorkflow } from './services/businessInterpretationFacts';
import { buildCustomerExtraFromParty } from './components/customer/customerDecisionUi';
import { resolveSuggestedCustomerName } from './pages/EingangDetailPage';
import type {
  ContractIntelligenceResult,
  ContractOrderProposal,
  DetectedContractParty,
} from './types/documentIntelligence';
import type { InboxItem, WorkflowResult } from './types/models';

const OWN_PROFILE = {
  companyName: 'Çırmak Haustechnik GmbH',
  street: 'Bahnhofstraße 12',
  zip: '32105',
  city: 'Bad Salzuflen',
  contactPerson: 'Saban Irmak',
};

const OWN = (role: DetectedContractParty['role']): DetectedContractParty => ({
  role,
  name: 'Çırmak Haustechnik GmbH',
  street: 'Bahnhofstraße 12',
  zip: '32105',
  city: 'Bad Salzuflen',
  contactPerson: 'Saban Irmak',
  status: 'confirmed',
  confidence: 'high',
});

const OWL = (role: DetectedContractParty['role']): DetectedContractParty => ({
  role,
  name: 'OWL Subbau GmbH',
  street: 'Am Stadtholz 42',
  zip: '33609',
  city: 'Bielefeld',
  contactPerson: 'Murat Demir',
  email: 'murat.demir@owl-subbau.test',
  phone: '0521 555 0188',
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

const FREMD = (role: DetectedContractParty['role']): DetectedContractParty => ({
  role,
  name: 'Fremd Dach GmbH',
  street: 'Fremdweg 9',
  zip: '44444',
  city: 'Fremdstadt',
  status: 'confirmed',
  confidence: 'high',
});

function buildScene(options: {
  parties: DetectedContractParty[];
  family?: string;
  customer?: string;
  recognizedAuftraggeber?: string;
  sender?: string;
}) {
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

  const workflow = {
    inboxItemId: 'inbox-02d',
    contractIntelligence: intelligence,
    contractOrderProposal: proposal,
  } as unknown as WorkflowResult;

  const item = {
    id: 'inbox-02d',
    sender: options.sender ?? '',
    recognizedData: options.recognizedAuftraggeber
      ? { Auftraggeber: options.recognizedAuftraggeber }
      : {},
  } as unknown as InboxItem;

  return { workflow, item, proposal };
}

/** Bildet den Reset-Effekt der Seite nach: eine Gegenpartei, beide Setter. */
function formFields(scene: ReturnType<typeof buildScene>) {
  const counterparty = resolveCounterpartyFromWorkflow(scene.workflow);
  const detected = scene.workflow.contractIntelligence?.parties ?? [];
  return {
    name: resolveSuggestedCustomerName(
      scene.item,
      scene.workflow.contractOrderProposal,
      counterparty,
      detected.length < 2,
    ),
    ...buildCustomerExtraFromParty(counterparty),
  };
}

describe('OFFICEPILOT-CUSTOMER-COUNTERPARTY-FORM-HANDOFF-02D', () => {
  beforeEach(() => {
    resetTestStores();
    hydrateCompanyProfileStore(OWN_PROFILE);
  });

  it('A: umgekehrte Richtung — alle sieben Felder gehören der Gegenpartei', () => {
    const fields = formFields(
      buildScene({
        parties: [OWN('auftraggeber'), OWL('auftragnehmer')],
        customer: 'Çırmak Haustechnik GmbH',
        recognizedAuftraggeber: 'Çırmak Haustechnik GmbH',
      }),
    );

    expect(fields).toEqual({
      name: 'OWL Subbau GmbH',
      contactPerson: 'Murat Demir',
      street: 'Am Stadtholz 42',
      zip: '33609',
      city: 'Bielefeld',
      email: 'murat.demir@owl-subbau.test',
      phone: '0521 555 0188',
    });
  });

  it('A2: nichts von der eigenen Firma erscheint im Formular', () => {
    const fields = formFields(
      buildScene({
        parties: [OWN('auftraggeber'), OWL('auftragnehmer')],
        customer: 'Çırmak Haustechnik GmbH',
      }),
    );

    expect(fields.name).not.toBe('Çırmak Haustechnik GmbH');
    expect(fields.contactPerson).not.toBe('Saban Irmak');
    expect(fields.street).not.toBe('Bahnhofstraße 12');
  });

  it('B: Westfalen-Richtung bleibt vollständig erhalten', () => {
    const fields = formFields(
      buildScene({
        parties: [WESTFALEN('auftraggeber'), OWN('auftragnehmer')],
        customer: 'Westfalen Projektbau GmbH',
        recognizedAuftraggeber: 'Westfalen Projektbau GmbH',
      }),
    );

    expect(fields).toEqual({
      name: 'Westfalen Projektbau GmbH',
      contactPerson: 'Daniel Krüger',
      street: 'Industriestraße 27',
      zip: '33689',
      city: 'Bielefeld',
      email: 'daniel.krueger@westfalen-projektbau.test',
      phone: '0521 555 0147',
    });
  });

  it('C: zwei Parteien ohne sichere Identität lassen das Formular leer', () => {
    hydrateCompanyProfileStore({
      companyName: 'Ganz Andere GmbH',
      street: 'Anderweg 1',
      zip: '11111',
      city: 'Anderstadt',
    });
    const fields = formFields(
      buildScene({
        parties: [OWN('auftraggeber'), FREMD('auftragnehmer')],
        // Der rollenbasierte Kandidat wäre die eigene Firma — er darf nicht greifen.
        customer: 'Çırmak Haustechnik GmbH',
        recognizedAuftraggeber: 'Çırmak Haustechnik GmbH',
      }),
    );

    expect(fields).toEqual({
      name: '',
      contactPerson: '',
      street: '',
      zip: '',
      city: '',
      email: '',
      phone: '',
    });
  });

  it('D: ohne erkannte Parteien bleibt der bestehende Namensfallback erhalten', () => {
    const fields = formFields(
      buildScene({
        parties: [],
        customer: 'Westfalen Projektbau GmbH',
      }),
    );

    expect(fields.name).toBe('Westfalen Projektbau GmbH');
  });

  it('D2: der Fallback überspringt weiterhin die eigene Firma', () => {
    const fields = formFields(
      buildScene({
        parties: [],
        customer: 'Çırmak Haustechnik GmbH',
        recognizedAuftraggeber: 'OWL Subbau GmbH',
      }),
    );

    expect(fields.name).toBe('OWL Subbau GmbH');
  });

  it('E: Name und Zusatzfelder stammen nie aus verschiedenen Parteien', () => {
    for (const parties of [
      [OWN('auftraggeber'), OWL('auftragnehmer')],
      [WESTFALEN('auftraggeber'), OWN('auftragnehmer')],
    ]) {
      const fields = formFields(buildScene({ parties, customer: 'Çırmak Haustechnik GmbH' }));
      if (!fields.name) {
        expect(fields.street).toBe('');
        continue;
      }
      const source = parties.find((party) => party.name === fields.name);
      expect(source).toBeDefined();
      expect(fields.street).toBe(source!.street ?? '');
      expect(fields.contactPerson).toBe(source!.contactPerson ?? '');
    }
  });
});
