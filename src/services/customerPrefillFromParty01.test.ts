/**
 * OFFICEPILOT-CUSTOMER-PREFILL-FROM-DOCUMENT-01B / -PARTY-BLOCK-01D — erkannte
 * Gegenpartei füllt den Kundenvorschlag vor.
 *
 * Der Übergabepunkt ist bewusst `BusinessStructuredParty` mit
 * `relation === 'counterparty'` — nicht `ContractOrderProposal.customer` und
 * keine dokumenttypbezogene Verzweigung.
 *
 * 01D: Die Belegtexte bilden den realen PDF-Aufbau nach — gemeinsame Kopfzeile
 * mit beiden Firmennamen, Rollenzeilen OHNE Doppelpunkt und ohne eine einzige
 * Leerzeile zwischen den Blöcken. Genau diese drei Eigenschaften hatte die
 * erste Testfassung nicht, weshalb sie eine Sicherheit vortäuschte, die der
 * Code für echte Dokumente nicht besaß.
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

/** Aufbau wie im realen Kontrollvertrag, Seite 1. */
const WERKVERTRAG = [
  'OfficePilot Testvertrag - NordWest Dachbau GmbH / Cirmak Haustechnik GmbH',
  'TESTDOKUMENT - NICHT RECHTSVERBINDLICH',
  'Nur für OfficePilot-Tests.',
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
  'Vertragssumme 34.624,00 EUR',
].join('\n');

/**
 * Gegenprobe: Die Gegenpartei hat selbst keine Adresszeilen, direkt darunter
 * steht die eigene Firma vollständig. Ohne echte Blockgrenze würde die
 * Gegenpartei hier die Daten der eigenen Firma erben.
 */
const WERKVERTRAG_OHNE_KUNDENADRESSE = [
  'OfficePilot Testvertrag - NordWest Dachbau GmbH / Cirmak Haustechnik GmbH',
  'Auftraggeber NordWest Dachbau GmbH',
  'Auftragnehmer Cirmak Haustechnik GmbH',
  'Bahnhofstraße 15',
  '32105 Bad Salzuflen',
  'Geschäftsführer: Saban Irmak',
].join('\n');

/**
 * Schärfere Gegenprobe: Die Gegenpartei hat einen Ansprechpartner, aber keine
 * Adresse. Die eigene Firma folgt unmittelbar und vollständig. Ein Block, der
 * an der Rollenzeile nicht endet, würde hier Straße, PLZ und Ort der eigenen
 * Firma an die Gegenpartei hängen — und ihren Ansprechpartner ersetzen.
 */
const GEGENPARTEI_OHNE_ADRESSE = [
  'Auftraggeber Gegenpartei GmbH',
  'Geschäftsführer: Gegen Person',
  'Auftragnehmer Eigene Firma GmbH',
  'Eigene Straße 5',
  '12345 Eigene Stadt',
  'Geschäftsführer: Eigene Person',
].join('\n');

/** Auftragsbestätigung — derselbe Pfad ohne jede Vertrags-Sonderbehandlung. */
const AUFTRAGSBESTAETIGUNG = [
  'Auftragsbestätigung Nr. AB-2026-14 für Südwest Elektro GmbH',
  'Kunde Südwest Elektro GmbH',
  'Lindenweg 4',
  '76133 Karlsruhe',
  'Geschäftsführer: Petra Lang',
  'Baustelle Industriestraße 7, 76185 Karlsruhe',
].join('\n');

const partyOf = (text: string, role: string) =>
  extractContractParties(text).find((party) => party.role === role);

describe('OFFICEPILOT-CUSTOMER-PREFILL-PARTY-BLOCK-01D', () => {
  it('A: die Gegenpartei trägt ihre eigene Anschrift und ihren Ansprechpartner', () => {
    const auftraggeber = partyOf(WERKVERTRAG, 'auftraggeber');

    expect(auftraggeber?.name).toBe('NordWest Dachbau GmbH');
    expect(auftraggeber?.street).toBe('Westring 88');
    expect(auftraggeber?.zip).toBe('33330');
    expect(auftraggeber?.city).toBe('Gütersloh');
    expect(auftraggeber?.contactPerson).toBe('Martin Voss');
  });

  it('B: die eigene Firma trägt ihre eigene Anschrift und ihren Ansprechpartner', () => {
    const auftragnehmer = partyOf(WERKVERTRAG, 'auftragnehmer');

    expect(auftragnehmer?.name).toBe('Cirmak Haustechnik GmbH');
    expect(auftragnehmer?.street).toBe('Bahnhofstraße 15');
    expect(auftragnehmer?.zip).toBe('32105');
    expect(auftragnehmer?.city).toBe('Bad Salzuflen');
    expect(auftragnehmer?.contactPerson).toBe('Saban Irmak');
  });

  it('C: keine Partei erbt die Daten der anderen', () => {
    const auftraggeber = partyOf(WERKVERTRAG, 'auftraggeber');
    const auftragnehmer = partyOf(WERKVERTRAG, 'auftragnehmer');

    expect(auftraggeber?.street).not.toBe('Bahnhofstraße 15');
    expect(auftraggeber?.zip).not.toBe('32105');
    expect(auftraggeber?.city).not.toBe('Bad Salzuflen');
    expect(auftraggeber?.contactPerson).not.toBe('Saban Irmak');

    expect(auftragnehmer?.street).not.toBe('Westring 88');
    expect(auftragnehmer?.zip).not.toBe('33330');
    expect(auftragnehmer?.city).not.toBe('Gütersloh');
    expect(auftragnehmer?.contactPerson).not.toBe('Martin Voss');
  });

  it('D: die Baustelle wird für keine Partei zur Anschrift', () => {
    for (const role of ['auftraggeber', 'auftragnehmer']) {
      const party = partyOf(WERKVERTRAG, role);
      expect(party?.street ?? '').not.toMatch(/Bertelsmann/i);
      expect(party?.zip).not.toBe('33335');
    }
  });

  it('E: die Kopfzeile mit beiden Firmennamen wird nicht zum Party-Anker', () => {
    // Wäre die Überschrift der Anker, stünde für beide Parteien dasselbe drin.
    const auftraggeber = partyOf(WERKVERTRAG, 'auftraggeber');
    const auftragnehmer = partyOf(WERKVERTRAG, 'auftragnehmer');

    expect(auftraggeber?.street).not.toBe(auftragnehmer?.street);
    expect(auftraggeber?.contactPerson).not.toBe(auftragnehmer?.contactPerson);
  });

  it('F: Gegenpartei ohne eigene Adresse erbt nichts von der eigenen Firma', () => {
    const auftraggeber = partyOf(WERKVERTRAG_OHNE_KUNDENADRESSE, 'auftraggeber');
    const auftragnehmer = partyOf(WERKVERTRAG_OHNE_KUNDENADRESSE, 'auftragnehmer');

    expect(auftraggeber?.name).toBe('NordWest Dachbau GmbH');
    expect(auftraggeber?.street).toBeUndefined();
    expect(auftraggeber?.zip).toBeUndefined();
    expect(auftraggeber?.city).toBeUndefined();
    expect(auftraggeber?.contactPerson).toBeUndefined();

    // Kontrolle: die Daten sind vorhanden — nur eben bei der richtigen Partei.
    expect(auftragnehmer?.street).toBe('Bahnhofstraße 15');
    expect(auftragnehmer?.contactPerson).toBe('Saban Irmak');
  });

  it('F2: Gegenpartei mit Ansprechpartner, aber ohne Adresse, erbt keine Anschrift', () => {
    const gegenpartei = partyOf(GEGENPARTEI_OHNE_ADRESSE, 'auftraggeber');
    const eigene = partyOf(GEGENPARTEI_OHNE_ADRESSE, 'auftragnehmer');

    expect(gegenpartei?.name).toBe('Gegenpartei GmbH');
    expect(gegenpartei?.contactPerson).toBe('Gegen Person');
    expect(gegenpartei?.street).toBeUndefined();
    expect(gegenpartei?.zip).toBeUndefined();
    expect(gegenpartei?.city).toBeUndefined();

    // Kontrolle: die Eigenfirmendaten sind da — bei der eigenen Firma.
    expect(eigene?.street).toBe('Eigene Straße 5');
    expect(eigene?.zip).toBe('12345');
    expect(eigene?.city).toBe('Eigene Stadt');
    expect(eigene?.contactPerson).toBe('Eigene Person');
  });

  it('G: E-Mail und Telefon fehlen im Dokument und bleiben leer', () => {
    const extra = buildCustomerExtraFromParty({
      name: 'NordWest Dachbau GmbH',
      relation: 'counterparty',
      certainty: 'recognized',
      source: 'contractIntelligence',
      street: 'Westring 88',
      zip: '33330',
      city: 'Gütersloh',
      contactPerson: 'Martin Voss',
    } as BusinessStructuredParty);

    expect(extra).toEqual({
      contactPerson: 'Martin Voss',
      street: 'Westring 88',
      zip: '33330',
      city: 'Gütersloh',
      email: '',
      phone: '',
    });
  });

  it('H: die eigene Firma erreicht den Vorschlag auch als Objekt nicht', () => {
    const extra = buildCustomerExtraFromParty({
      name: 'Cirmak Haustechnik GmbH',
      relation: 'own_company',
      certainty: 'recognized',
      source: 'contractIntelligence',
      street: 'Bahnhofstraße 15',
      zip: '32105',
      city: 'Bad Salzuflen',
      contactPerson: 'Saban Irmak',
    } as BusinessStructuredParty);

    expect(extra).toEqual(createEmptyCustomerExtraFields());
  });

  it('I: eine Auftragsbestätigung nutzt denselben Pfad', () => {
    const kunde = partyOf(AUFTRAGSBESTAETIGUNG, 'kunde');

    expect(kunde?.name).toBe('Südwest Elektro GmbH');
    expect(kunde?.street).toBe('Lindenweg 4');
    expect(kunde?.zip).toBe('76133');
    expect(kunde?.city).toBe('Karlsruhe');
    expect(kunde?.contactPerson).toBe('Petra Lang');
    expect(kunde?.street).not.toMatch(/Industriestraße/i);
    expect(kunde?.zip).not.toBe('76185');
  });

  it('J: eine Partei ohne Folgezeilen liefert nur den Namen', () => {
    const kunde = partyOf('Kunde Nur Name GmbH', 'kunde');

    expect(kunde?.name).toBe('Nur Name GmbH');
    expect(kunde?.street).toBeUndefined();
    expect(kunde?.zip).toBeUndefined();
    expect(kunde?.city).toBeUndefined();
    expect(kunde?.contactPerson).toBeUndefined();
  });

  it('G2: E-Mail und Telefon der Gegenpartei erreichen den Vorschlag', () => {
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

    expect(extra.email).toBe('daniel.krueger@westfalen-projektbau.test');
    expect(extra.phone).toBe('0521 555 0147');
  });

  it('K: ohne Gegenpartei entsteht ein leerer Vorschlag, keine erfundenen Werte', () => {
    expect(buildCustomerExtraFromParty(undefined)).toEqual(createEmptyCustomerExtraFields());
  });
});
