/**
 * OFFICEPILOT-PARTY-CONTACT-SCOPING-AND-CUSTOMER-CONTACT-01B
 *
 * Kontaktdaten gehören zu genau einer Partei. Die Extraktion trennte sie schon
 * korrekt, die Auftragskarte hängte aber einen einzigen dokumentweit gelesenen
 * `ansprechpartner` an jede Party-Zeile — dadurch stand derselbe Ansprechpartner
 * bei Auftraggeber und Auftragnehmer.
 *
 * E-Mail und Telefon laufen deshalb denselben blockgebundenen Weg wie der
 * Ansprechpartner: gefunden nur im eigenen Block, erster Treffer gewinnt, kein
 * dokumentweiter Fallback. Fehlt die Zuordnung, bleibt das Feld leer.
 *
 * Neutrale Beispieldaten, kein Netzwerk.
 */
import { describe, expect, it } from 'vitest';
import { extractContractParties } from './contractIntelligenceExtraction';
import {
  buildCustomerExtraFromParty,
  createEmptyCustomerExtraFields,
} from '../components/customer/customerDecisionUi';
import type { BusinessStructuredParty } from '../types/businessInterpretation';

/** Aufbau wie im realen Kontrollvertrag: Kontaktblock nur beim Auftraggeber. */
const WESTFALEN = [
  'OfficePilot Testvertrag - Westfalen Projektbau GmbH / Cirmak Haustechnik GmbH',
  'WERKVERTRAG / BAU-SUBUNTERNEHMERVERTRAG',
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
  'Bauvorhaben Logistikzentrum - Dachsanierung',
].join('\n');

/** Beide Parteien mit eigenen Kontaktdaten — der schärfste Leakage-Fall. */
const BEIDE_MIT_KONTAKT = [
  'Auftraggeber Erste Bau GmbH',
  'Erstweg 1',
  '11111 Erststadt',
  'Ansprechpartner: Anna Erst',
  'E-Mail: anna.erst@erste.test',
  'Telefon: 0111 111 1111',
  'Auftragnehmer Zweite Technik GmbH',
  'Zweitweg 2',
  '22222 Zweitstadt',
  'Geschäftsführer: Bernd Zweit',
  'E-Mail: bernd.zweit@zweite.test',
  'Tel.: 0222 222 2222',
].join('\n');

/** Kontaktdaten stehen erst nach beiden Blöcken, in einer Fußzeile. */
const FOOTER_KONTAKT = [
  'Auftraggeber Alpha Bau GmbH',
  'Alphaweg 1',
  '11111 Alphastadt',
  'Auftragnehmer Beta Technik GmbH',
  'Betaweg 2',
  '22222 Betastadt',
  'Bauvorhaben Halle 1',
  'E-Mail: zentrale@beispiel.test',
  'Telefon: 0999 999 9999',
].join('\n');

const partyOf = (text: string, role: string) =>
  extractContractParties(text).find((party) => party.role === role);

describe('OFFICEPILOT-PARTY-CONTACT-SCOPING-01B', () => {
  it('A: der Auftraggeber trägt Ansprechpartner, E-Mail und Telefon aus seinem Block', () => {
    const auftraggeber = partyOf(WESTFALEN, 'auftraggeber');

    expect(auftraggeber?.name).toBe('Westfalen Projektbau GmbH');
    expect(auftraggeber?.street).toBe('Industriestraße 27');
    expect(auftraggeber?.zip).toBe('33689');
    expect(auftraggeber?.city).toBe('Bielefeld');
    expect(auftraggeber?.contactPerson).toBe('Daniel Krüger');
    expect(auftraggeber?.email).toBe('daniel.krueger@westfalen-projektbau.test');
    expect(auftraggeber?.phone).toBe('0521 555 0147');
  });

  it('B: der Auftragnehmer behält seine eigenen Daten und erbt keine Kontaktdaten', () => {
    const auftragnehmer = partyOf(WESTFALEN, 'auftragnehmer');

    expect(auftragnehmer?.name).toBe('Cirmak Haustechnik GmbH');
    expect(auftragnehmer?.street).toBe('Bahnhofstraße 15');
    expect(auftragnehmer?.zip).toBe('32105');
    expect(auftragnehmer?.city).toBe('Bad Salzuflen');
    expect(auftragnehmer?.contactPerson).toBe('Saban Irmak');
    expect(auftragnehmer?.email).toBeUndefined();
    expect(auftragnehmer?.phone).toBeUndefined();
  });

  it('C: keine Kontaktdaten laufen über die Party-Grenze hinweg', () => {
    const auftraggeber = partyOf(WESTFALEN, 'auftraggeber');
    const auftragnehmer = partyOf(WESTFALEN, 'auftragnehmer');

    expect(auftragnehmer?.contactPerson).not.toBe('Daniel Krüger');
    expect(auftragnehmer?.email).not.toBe('daniel.krueger@westfalen-projektbau.test');
    expect(auftragnehmer?.phone).not.toBe('0521 555 0147');
    expect(auftraggeber?.contactPerson).not.toBe('Saban Irmak');
  });

  it('D: zwei Parteien mit eigenen Kontaktdaten bleiben sauber getrennt', () => {
    const erste = partyOf(BEIDE_MIT_KONTAKT, 'auftraggeber');
    const zweite = partyOf(BEIDE_MIT_KONTAKT, 'auftragnehmer');

    expect(erste?.contactPerson).toBe('Anna Erst');
    expect(erste?.email).toBe('anna.erst@erste.test');
    expect(erste?.phone).toBe('0111 111 1111');

    expect(zweite?.contactPerson).toBe('Bernd Zweit');
    expect(zweite?.email).toBe('bernd.zweit@zweite.test');
    expect(zweite?.phone).toBe('0222 222 2222');
  });

  it('E: eine Fußzeile nach beiden Blöcken wird keiner Partei zugeschlagen', () => {
    const alpha = partyOf(FOOTER_KONTAKT, 'auftraggeber');
    const beta = partyOf(FOOTER_KONTAKT, 'auftragnehmer');

    expect(alpha?.email).toBeUndefined();
    expect(alpha?.phone).toBeUndefined();
    expect(beta?.email).toBeUndefined();
    expect(beta?.phone).toBeUndefined();
    // Die Adressen der beiden Blöcke bleiben davon unberührt.
    expect(alpha?.street).toBe('Alphaweg 1');
    expect(beta?.street).toBe('Betaweg 2');
  });

  it('F: der Kundenvorschlag der Gegenpartei ist vollständig', () => {
    const extra = buildCustomerExtraFromParty({
      name: 'Westfalen Projektbau GmbH',
      relation: 'counterparty',
      certainty: 'recognized',
      source: 'contractIntelligence',
      contactPerson: 'Daniel Krüger',
      street: 'Industriestraße 27',
      zip: '33689',
      city: 'Bielefeld',
      email: 'daniel.krueger@westfalen-projektbau.test',
      phone: '0521 555 0147',
    } as BusinessStructuredParty);

    expect(extra).toEqual({
      contactPerson: 'Daniel Krüger',
      street: 'Industriestraße 27',
      zip: '33689',
      city: 'Bielefeld',
      email: 'daniel.krueger@westfalen-projektbau.test',
      phone: '0521 555 0147',
    });
  });

  it('G: die eigene Firma erreicht den Kundenvorschlag auch mit Kontaktdaten nicht', () => {
    const extra = buildCustomerExtraFromParty({
      name: 'Cirmak Haustechnik GmbH',
      relation: 'own_company',
      certainty: 'recognized',
      source: 'contractIntelligence',
      contactPerson: 'Saban Irmak',
      street: 'Bahnhofstraße 15',
      email: 'info@cirmak.test',
      phone: '0521 000 0000',
    } as BusinessStructuredParty);

    expect(extra).toEqual(createEmptyCustomerExtraFields());
  });
});
