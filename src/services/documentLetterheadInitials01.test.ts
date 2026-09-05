/**
 * GOLD-LETTERHEAD-INITIALS-01 — eine vorangestellte Logo-Initiale darf nicht als Teil
 * des Organisationsnamens in ein Feld gelangen.
 *
 * Betroffen sind drei Verbrauchsstellen einer rohen Briefkopfzeile:
 *   - inferMerchantFromHeader   (Beleg-/Merchant-Pfad)
 *   - applyAuthorityOcrSender   (Behörden-recognizedData)
 *   - deriveSenderEntity        (Dokumentprofil-Sender)
 * Alle drei nutzen jetzt dieselbe bestehende Bereinigung cleanLetterheadCandidate.
 * Das Strukturmerkmal structure.authority_letter bleibt absichtlich roh.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { setOcrOnlyRecognizedDataEnabledForTests } from '../config/documentIntelligenceConfig';
import {
  cleanLetterheadCandidate,
  extractFieldsWithConfidence,
  inferUnlabeledSenderFromText,
} from './documentFieldExtractionService';
import { buildEvidenceBasedRecognizedData } from './documentRecognizedDataService';
import { buildDocumentProfile } from './documentProfileService';
import { runReceiptAnalysisPipeline } from './documentReceiptAnalysisPipelineService';

const TANKBELEG_TEXT = [
  'A Aral Station Nord',
  'Tankstelle',
  'Vlothoer Str. 55 · 32105 Bad Salzuflen',
  'Kundenbeleg / Tankbeleg',
  'Datum 10.02.2026 · Beleg 884421',
  'Diesel 52,40 l 1,689 €/l 88,50 €',
  'Gesamtbetrag 92,95 €',
].join('\n');

const FINANZAMT_TEXT = [
  'F Finanzamt Detmold',
  'Behördenschreiben',
  'Büchenstraße 6 · 32756 Detmold',
  'Cirmak Haustechnik GmbH',
  'Industriestraße 18',
  '32105 Bad Salzuflen',
  'Erinnerung Umsatzsteuer-Voranmeldung',
  'Datum 01.03.2026 · Az. 305/5803/1234-USt',
].join('\n');

const BG_BAU_TEXT = [
  'B BG BAU Bezirksverwaltung OWL',
  'Behördenschreiben',
  'Bielefeld',
  'Cirmak Haustechnik GmbH',
  'Industriestraße 18',
  '32105 Bad Salzuflen',
  'Beitragsbescheid',
  'Datum 15.02.2026 · Az. BG-OWL-88421',
].join('\n');

afterEach(() => {
  setOcrOnlyRecognizedDataEnabledForTests(null);
});

function recognizedDataFor(kind: string, recognizedText: string): Record<string, string> {
  setOcrOnlyRecognizedDataEnabledForTests(true);
  return buildEvidenceBasedRecognizedData({
    classifiedKind: kind as never,
    recognizedText,
  });
}

function profileSenderFor(recognizedText: string): string | undefined {
  const pipeline = runReceiptAnalysisPipeline({ recognizedText });
  return buildDocumentProfile({ pipeline, recognizedText }).senderEntity;
}

describe('LETTERHEAD-INITIALS-01 — Initiale wird in allen drei Pfaden entfernt', () => {
  it('Tankstellenpfad entfernt die Initiale vor dem Stationsnamen', () => {
    const data = recognizedDataFor('tankbeleg', TANKBELEG_TEXT);
    expect(data.Tankstelle).toBe('Aral Station Nord');
    expect(data.Tankstelle).not.toMatch(/^A\s/);
  });

  it('Behörden-Absender entfernt die Initiale vor dem Behördennamen', () => {
    const data = recognizedDataFor('finanzamt', FINANZAMT_TEXT);
    expect(data.Absender).toBe('Finanzamt Detmold');
    expect(data.Absender).not.toMatch(/^F\s/);
  });

  it('Profile-Sender entfernt die Initiale vor dem Behördennamen', () => {
    expect(profileSenderFor(BG_BAU_TEXT)).toBe('BG BAU Bezirksverwaltung OWL');
  });

  it('Absender und Lieferant widersprechen sich nicht mehr wegen der Initiale', () => {
    const data = recognizedDataFor('finanzamt', FINANZAMT_TEXT);
    expect(data.Absender).toBeTruthy();
    expect(data.Lieferant).toBeTruthy();
    expect(data.Absender).toBe(data.Lieferant);
  });
});

describe('LETTERHEAD-INITIALS-01 — Gegenbeispiele bleiben unverändert', () => {
  const UNCHANGED = [
    'AOK NordWest',
    'BG BAU Bezirksverwaltung OWL',
    'SOKA-BAU',
    'Praxis Dr. Vogt',
    'Sägewerk Ernst Flisch GmbH',
  ];

  for (const name of UNCHANGED) {
    it(`bleibt unverändert: ${name}`, () => {
      expect(cleanLetterheadCandidate(name)).toBe(name);
    });
  }

  it('entfernt ausschließlich eine alleinstehende Initiale', () => {
    expect(cleanLetterheadCandidate('A Aral Station Nord')).toBe('Aral Station Nord');
    expect(cleanLetterheadCandidate('B BG BAU Bezirksverwaltung OWL')).toBe(
      'BG BAU Bezirksverwaltung OWL',
    );
  });
});

/**
 * AUTHORITY-SENDER-EXTRACTION-01B — Kontaktspalte im Briefkopf.
 *
 * Realbefund iPhone/Safari: Ein fotografierter Finanzamt-Briefkopf ist zweispaltig.
 * Die OCR verschmilzt die Zeilen, und aus „Finanzamt Detmold" plus rechter Spalte
 * wird eine einzige Kopfzeile. Der Absender lautete deshalb sichtbar
 * „Finanzamt Detmold Telefon" statt „Finanzamt Detmold".
 *
 * Der Cleaner kannte Strassen- und Rubrikgrenzen, aber keine Kontaktgrenzen.
 * Geprueft wird ueber dieselben produktiven Pfade wie oben, nicht ueber eine
 * Nachbildung.
 */
const AUTHORITY_CONTACT_TEXT = [
  'Finanzamt Detmold Telefon: 05231 703-0',
  'Paulinenstraße 4 Telefax: 05231 703-199',
  '32756 Detmold E-Mail: poststelle@fa-detmold.nrw.de',
  'Behördenschreiben',
  'Cirmak Haustechnik GmbH',
  'Erinnerung Umsatzsteuer-Voranmeldung',
  'Datum 01.03.2026 · Az. 305/5803/1234-USt',
].join('\n');

describe('AUTHORITY-SENDER-EXTRACTION-01B — Kontaktlabel beendet den Organisationsnamen', () => {
  it('R1: Telefonspalte gehört nicht zum Behördennamen', () => {
    expect(cleanLetterheadCandidate('Finanzamt Detmold Telefon: 05231 703-0')).toBe(
      'Finanzamt Detmold',
    );
  });

  it('R2: Telefaxspalte gehört nicht zum Behördennamen', () => {
    expect(cleanLetterheadCandidate('Finanzamt Detmold Telefax: 05231 703-199')).toBe(
      'Finanzamt Detmold',
    );
  });

  it('R3: E-Mail-Spalte gehört nicht zum Behördennamen', () => {
    expect(
      cleanLetterheadCandidate('Finanzamt Detmold E-Mail: poststelle@fa-detmold.nrw.de'),
    ).toBe('Finanzamt Detmold');
  });

  /*
   * R4 — die Gegenprobe. Die Grenze haengt am Kontaktkontext (Label plus
   * Trennzeichen), nicht am blossen Wort. Ein legitimer Firmenname mit „Telefon"
   * darf nicht gekuerzt werden.
   */
  it('R4: legitime Organisationsnamen bleiben unverändert', () => {
    expect(cleanLetterheadCandidate('Muster Telefon GmbH')).toBe('Muster Telefon GmbH');
    expect(cleanLetterheadCandidate('Telefonbau GmbH')).toBe('Telefonbau GmbH');
    expect(cleanLetterheadCandidate('Faxdienst Nord GmbH')).toBe('Faxdienst Nord GmbH');
  });

  it('R9: dieselbe Grenze gilt für andere Behörden — kein Finanzamt-Sonderfall', () => {
    expect(
      cleanLetterheadCandidate('BG BAU Bezirksverwaltung OWL Telefon: 030 85781-0'),
    ).toBe('BG BAU Bezirksverwaltung OWL');
    expect(cleanLetterheadCandidate('AOK NordWest Fax: 0800 2655-0')).toBe('AOK NordWest');
  });

  it('R7: der Profil-/Vorschau-Sender liefert den reinen Behördennamen', () => {
    expect(profileSenderFor(AUTHORITY_CONTACT_TEXT)).toBe('Finanzamt Detmold');
  });

  it('R8: der Behörden-recognizedData-Pfad liefert denselben sauberen Absender', () => {
    const data = recognizedDataFor('finanzamt', AUTHORITY_CONTACT_TEXT);
    expect(data.Absender).toBe('Finanzamt Detmold');
  });
});

/**
 * DOCUMENT-INTELLIGENCE-SENDER-BOUNDARY-01B — der Briefkopf endet, wo die
 * Kontaktspalte beginnt.
 *
 * Realbefund iPhone/Safari: Die Textvorschau zeigte vollstaendig
 * „Finanzamt Detmold Telefon: 05231 703-0", der Absender lautete trotzdem
 * „Finanzamt Detmold Telefon". Beide Werte entstehen im selben Lauf aus
 * demselben Text — der Sender durchlaeuft aber eine eigene Erfassung.
 *
 * **Die Tests hier zielen bewusst auf die oeffentliche Ebene, die den falschen
 * Wert erzeugt** (`inferUnlabeledSenderFromText` bzw.
 * `extractFieldsWithConfidence(...).Absender`), nicht auf
 * `cleanLetterheadCandidate` isoliert. Genau diese Ebenenverwechslung hat einen
 * frueheren Fix gruen werden lassen, waehrend das Geraet rot blieb.
 *
 * Kein Behoerden-Sonderfall: geprueft werden Finanzamt, Berufsgenossenschaft,
 * Krankenkasse, Kammer, Gericht und Stadtwerke ueber dieselbe Regel.
 */
const REAL_DEVICE_HEADER = [
  'Finanzamt Detmold Telefon: 05231 703-0',
  'Paulinenstraße 4 Telefax: 05231 703-199',
  '32756 Detmold E-Mail: poststelle@fa-detmold.nrw.de',
  'Datum: 30.06.2025',
  'Steuernummer: 313/5700/1234',
  'Cirmak Haustechnik GmbH',
  'Festsetzung der Vorauszahlungen für 2025',
].join('\n');

describe('SENDER-BOUNDARY-01B — Briefkopf-Grenzen auf der echten Extraktionsebene', () => {
  it('R1: der Realgeraetefall liefert den reinen Behoerdennamen', () => {
    expect(inferUnlabeledSenderFromText(REAL_DEVICE_HEADER)).toBe('Finanzamt Detmold');
    expect(extractFieldsWithConfidence(REAL_DEVICE_HEADER).Absender?.value).toBe(
      'Finanzamt Detmold',
    );
  });

  /*
   * R2–R9 — dieselbe Grenze quer durch die Institutionsarten. Die Kopfzeile wird
   * jeweils als erste Zeile eines Briefes geprueft, damit die Erfassung im
   * Briefkopffenster stattfindet.
   */
  const BOUNDARY_CASES: ReadonlyArray<{ name: string; head: string; expected: string }> = [
    {
      name: 'R2: Institution + Ort ohne Kontakt bleibt unveraendert',
      head: 'Finanzamt Detmold',
      expected: 'Finanzamt Detmold',
    },
    {
      name: 'R3: Berufsgenossenschaft + Bezirksverwaltung + Telefon',
      head: 'BG BAU Bezirksverwaltung OWL Telefon: 030 85781-0',
      expected: 'BG BAU Bezirksverwaltung OWL',
    },
    {
      name: 'R4: Krankenkasse + Servicezentrum + Telefon',
      head: 'AOK NordWest Servicezentrum Bielefeld Telefon: 0800 2655-0',
      expected: 'AOK NordWest Servicezentrum Bielefeld',
    },
    {
      name: 'R5: Kammer mit langem legitimen Namen + Telefon',
      head: 'Handwerkskammer Ostwestfalen-Lippe zu Bielefeld Telefon: 0521 5608-0',
      expected: 'Handwerkskammer Ostwestfalen-Lippe zu Bielefeld',
    },
    {
      name: 'R6: Gericht + Telefax',
      head: 'Amtsgericht Detmold Telefax: 05231 12-345',
      expected: 'Amtsgericht Detmold',
    },
    {
      name: 'R7: Ansprechpartner gehoert nicht in den Namen',
      head: 'Finanzamt Detmold Ansprechpartner: Frau Meier',
      expected: 'Finanzamt Detmold',
    },
    {
      name: 'R8: Aktenzeichen gehoert nicht in den Namen',
      head: 'Finanzamt Detmold Aktenzeichen: 313/5700/1234',
      expected: 'Finanzamt Detmold',
    },
    {
      name: 'R9: Datum gehoert nicht in den Namen',
      head: 'Stadtwerke Bielefeld Datum: 05.09.2026',
      expected: 'Stadtwerke Bielefeld',
    },
  ];

  for (const testCase of BOUNDARY_CASES) {
    it(testCase.name, () => {
      const text = [testCase.head, 'Cirmak Haustechnik GmbH', 'Betreff: Mitteilung'].join('\n');
      expect(inferUnlabeledSenderFromText(text)).toBe(testCase.expected);
    });
  }

  it('R11: ein langer Institutionsname ohne Grenze bleibt vollstaendig', () => {
    const text = [
      'Berufsgenossenschaft der Bauwirtschaft Regionalstelle Nord',
      'Cirmak Haustechnik GmbH',
    ].join('\n');
    expect(inferUnlabeledSenderFromText(text)).toBe(
      'Berufsgenossenschaft der Bauwirtschaft Regionalstelle Nord',
    );
  });

  /*
   * R10 — die Gegenprobe. Die Grenze haengt am Briefkopf-Label, nicht am Wort:
   * ohne Trennzeichen und Wert bleibt der Firmenname unangetastet.
   */
  it('R10: legitime Firmennamen mit Kontaktwoertern bleiben unveraendert', () => {
    expect(cleanLetterheadCandidate('Muster Telefon GmbH')).toBe('Muster Telefon GmbH');
    expect(cleanLetterheadCandidate('Telefonbau GmbH')).toBe('Telefonbau GmbH');
    expect(cleanLetterheadCandidate('Faxdienst Nord GmbH')).toBe('Faxdienst Nord GmbH');
    expect(inferUnlabeledSenderFromText('Telefonbau GmbH\nMusterweg 5')).toBe('Telefonbau GmbH');
  });

  it('R12: ohne erkennbaren Absender entsteht kein geratener Wert', () => {
    expect(inferUnlabeledSenderFromText('Telefon: 05231 703-0\n32756 Detmold')).toBeUndefined();
  });
});

describe('LETTERHEAD-INITIALS-01 — kein Überschreiben mit unsicherem Wert', () => {
  it('ein unsicherer Kandidat ersetzt keinen bereits sauberen Absender', () => {
    // Die Behörden-Kopfzeile besteht nur aus einer Straßenangabe: cleanLetterheadCandidate
    // liefert dafür keinen sicheren Wert. Der zuvor aus den extrahierten Feldern
    // gesetzte Absender muss erhalten bleiben — weder undefined noch Rohtext.
    const text = [
      'Büchenstraße 6',
      'Behördenschreiben',
      'Absender: Finanzamt Detmold',
      'Erinnerung Umsatzsteuer-Voranmeldung',
      'Datum 01.03.2026 · Az. 305/5803/1234-USt',
    ].join('\n');

    const data = recognizedDataFor('finanzamt', text);
    expect(data.Absender).toBeTruthy();
    expect(data.Absender).not.toBe('Büchenstraße 6');
    expect(data.Absender).toContain('Finanzamt Detmold');
  });
});
