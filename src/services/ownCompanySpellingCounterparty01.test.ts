/**
 * OWN-COMPANY-NAME-NORMALIZATION-01 — der Realfall bis zum Kundenformular.
 *
 * Firmenprofil: „Çırmak Haustechnik GmbH". Der Vertrag nennt die eigene Firma
 * als Auftragnehmer in der Schreibweise „Cirmak Haustechnik GmbH" — mit
 * abweichender Anschrift, ohne Ansprechpartner, ohne E-Mail, ohne Telefon. Die
 * alternativen Identitätswege in `isOwnCompanyParty` können damit nicht
 * greifen; der Name **ist** hier der Identitätsweg.
 *
 * Bleibt die eigene Firma unerkannt, liefert `resolveCounterpartyFromWorkflow`
 * bei zwei Parteien folgerichtig nichts — und das Formular „Neuer Kunde" bleibt
 * leer, einschliesslich Name.
 *
 * Geprüft wird die ganze Kette bis zu den Werten, die im Formular stehen
 * sollen. Kein Prefill-Sonderweg für Werkverträge: Die bestehende Kette muss
 * durch die reparierte Namensnormalisierung von selbst wieder tragen.
 *
 * Neutrale Beispieldaten ausser dem realen Firmennamen des Betriebs.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { resetTestStores } from '../test/resetStores';
import { hydrateCompanyProfileStore } from './companyProfileService';
import { resolveCounterpartyFromWorkflow } from './businessInterpretationFacts';
import { buildCustomerExtraFromParty } from '../components/customer/customerDecisionUi';
import { getCustomerStoreSnapshot } from './customerStoreService';
import type {
  ContractIntelligenceResult,
  ContractOrderProposal,
  DetectedContractParty,
} from '../types/documentIntelligence';
import type { WorkflowResult } from '../types/models';

/** Exakt der reale Profilstand des Testgeräts. */
const OWN_PROFILE = {
  companyName: 'Çırmak Haustechnik GmbH',
  street: 'Bahnhofstraße 12',
  zip: '32105',
  city: 'Bad Salzuflen',
  contactPerson: 'Saban Irmak',
  email: 'info@irmak-haustechnik.de',
};

/** Die eigene Firma, wie sie im Testvertrag steht: andere Schreibweise, andere Anschrift. */
const OWN_IN_CONTRACT: DetectedContractParty = {
  role: 'auftragnehmer',
  name: 'Cirmak Haustechnik GmbH',
  street: 'Testbetrieb fuer OfficePilot',
  zip: '32108',
  city: 'Bad Salzuflen',
  status: 'confirmed',
  confidence: 'high',
};

const RHEINWEST: DetectedContractParty = {
  role: 'auftraggeber',
  name: 'RheinWest Industriebau GmbH',
  street: 'Lippstädter Straße 118',
  zip: '33129',
  city: 'Delbrück',
  contactPerson: 'Jan Keller',
  status: 'confirmed',
  confidence: 'high',
};

/** Eine fremde Firma, deren Name der eigenen nach der Faltung ähnelt. */
const CIRMAK_BAU: DetectedContractParty = {
  role: 'auftragnehmer',
  name: 'Cirmak Bau GmbH',
  street: 'Fremdweg 9',
  zip: '44444',
  city: 'Fremdstadt',
  status: 'confirmed',
  confidence: 'high',
};

function buildWorkflow(parties: DetectedContractParty[], customer?: string): WorkflowResult {
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
      family: 'subunternehmervertrag',
      labelKey: 'documentIntelligence.label.werkvertrag',
      confidence: 'high',
      status: 'confirmed',
      evidence: [],
    },
    parties,
    positions: [],
    clauses: [],
    paymentTerms: [],
    openReviewHints: [],
  } as unknown as ContractIntelligenceResult;

  const proposal = {
    customer,
    positions: [],
    reviewHints: [],
    intelligence,
  } as unknown as ContractOrderProposal;

  return {
    inboxItemId: 'inbox-own-spelling-01',
    contractIntelligence: intelligence,
    contractOrderProposal: proposal,
  } as unknown as WorkflowResult;
}

describe('OWN-COMPANY-NAME-NORMALIZATION-01 — Gegenpartei und Prefill', () => {
  beforeEach(() => {
    resetTestStores();
    hydrateCompanyProfileStore(OWN_PROFILE);
  });

  it('A: die Schreibvariante der eigenen Firma gibt die Gegenpartei frei', () => {
    const counterparty = resolveCounterpartyFromWorkflow(
      buildWorkflow([RHEINWEST, OWN_IN_CONTRACT], 'RheinWest Industriebau GmbH'),
    );
    expect(counterparty?.name).toBe('RheinWest Industriebau GmbH');
  });

  it('B: das Kundenformular wird aus der Gegenpartei vorbelegt', () => {
    const counterparty = resolveCounterpartyFromWorkflow(
      buildWorkflow([RHEINWEST, OWN_IN_CONTRACT], 'RheinWest Industriebau GmbH'),
    );
    expect(buildCustomerExtraFromParty(counterparty)).toEqual({
      contactPerson: 'Jan Keller',
      street: 'Lippstädter Straße 118',
      zip: '33129',
      city: 'Delbrück',
      // Der Vertrag nennt für RheinWest keine Kontaktdaten — nichts wird erfunden.
      email: '',
      phone: '',
    });
  });

  it('C: eine ähnlich geschriebene fremde Firma gilt nicht als eigene', () => {
    /*
     * Weder „Cirmak Bau GmbH" noch RheinWest sind die eigene Firma. Damit
     * bleibt die Richtung unklar und das Sicherheitstor aus 8ccfd8b greift —
     * ein leeres Formular ist hier richtig.
     */
    const counterparty = resolveCounterpartyFromWorkflow(
      buildWorkflow([RHEINWEST, CIRMAK_BAU], 'RheinWest Industriebau GmbH'),
    );
    expect(counterparty).toBeUndefined();
    expect(buildCustomerExtraFromParty(counterparty)).toEqual({
      contactPerson: '',
      street: '',
      zip: '',
      city: '',
      email: '',
      phone: '',
    });
  });

  it('D: ohne identifizierbare eigene Firma bleibt es beim leeren Formular', () => {
    hydrateCompanyProfileStore({ ...OWN_PROFILE, companyName: 'Ganz Andere GmbH' });
    const counterparty = resolveCounterpartyFromWorkflow(
      buildWorkflow([RHEINWEST, OWN_IN_CONTRACT], 'RheinWest Industriebau GmbH'),
    );
    expect(counterparty).toBeUndefined();
  });

  it('E: das Vorbelegen speichert keinen Kunden', () => {
    // Confirm-first: Erkennen ist nicht Speichern.
    const counterparty = resolveCounterpartyFromWorkflow(
      buildWorkflow([RHEINWEST, OWN_IN_CONTRACT], 'RheinWest Industriebau GmbH'),
    );
    buildCustomerExtraFromParty(counterparty);
    expect(getCustomerStoreSnapshot()).toHaveLength(0);
  });
});
