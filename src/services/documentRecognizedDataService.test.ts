import { afterEach, describe, expect, it } from 'vitest';
import { setOcrOnlyRecognizedDataEnabledForTests, setPaymentScoringCutoverEnabledForTests } from '../config/documentIntelligenceConfig';
import { classifyDocument } from './documentClassificationService';
import {
  buildEvidenceBasedRecognizedData,
  shouldUseEvidenceBasedRecognizedData,
} from './documentRecognizedDataService';
import { buildExpenseInputFromInbox } from './officeActionService';
import type { InboxItem } from '../types/models';

const TANK_RECEIPT_WITH_AMOUNT = [
  'ARAL Tankstelle München',
  'Diesel 52,18 EUR',
  'Kartenzahlung Girocard',
  'Vielen Dank für Ihren Einkauf',
  'ARAL AG',
  'HRB 12345 Amtsgericht München',
  'Geschäftsführer: Max Mustermann',
].join('\n');

const EC_RECEIPT = [
  'REWE Markt München',
  'EC-Beleg',
  'Datum 14.07.2026',
  'Kartenzahlung Girocard',
  'Summe 18,42 EUR',
  'Terminal-ID 04',
  'Beleg-Nr. EC-4421',
  'Danke für Ihren Einkauf',
].join('\n');

const KASSEN_RECEIPT = [
  'Bäckerei Schmidt',
  'Kassenbeleg',
  'Beleg-Nr. 4421',
  'Datum: 14.07.2026',
  'Brötchen    2,40 EUR',
  'Kaffee      2,50 EUR',
  'Croissant   3,00 EUR',
  'Summe       8,90 EUR',
  'Bar gezahlt',
  'Vielen Dank',
].join('\n');

const INCOMING_INVOICE = [
  'Müller Bau GmbH',
  'Musterstraße 1',
  '12345 Musterstadt',
  'Rechnungsnummer: INV-2026-77',
  'Datum: 12.03.2026',
  'Leistung: Sanierung Dach',
  'Position 1    450,00 EUR',
  'Position 2    320,00 EUR',
  'Gesamtbetrag 1.247,80 EUR',
  'IBAN: DE89 3704 0044 0532 0130 00',
  'zahlbar bis 31.03.2026',
].join('\n');

describe('documentRecognizedDataService', () => {
  afterEach(() => {
    setOcrOnlyRecognizedDataEnabledForTests(null);
    setPaymentScoringCutoverEnabledForTests(null);
  });

  describe('receipt family', () => {
    it('uses OCR amount and station instead of demo values for tankbeleg', () => {
      const recognizedData = buildEvidenceBasedRecognizedData({
        classifiedKind: 'tankbeleg',
        recognizedText: TANK_RECEIPT_WITH_AMOUNT,
      });

      expect(recognizedData.Dokumentart).toBe('tankbeleg');
      expect(recognizedData.Betrag).toContain('52,18');
      expect(recognizedData.Betrag).not.toBe('85,40 €');
      expect(recognizedData.Tankstelle).toBe('ARAL Tankstelle München');
      expect(recognizedData.Tankstelle).not.toBe('Tankstelle');
    });

    it('entfernt die Logo-Initiale, ohne den Händlernamen zu kürzen', () => {
      const recognizedData = buildEvidenceBasedRecognizedData({
        classifiedKind: 'tankbeleg',
        recognizedText: [
          'A Aral Station Nord',
          'Diesel 41,90 EUR',
          'Kartenzahlung Girocard',
        ].join('\n'),
      });

      // Initiale entfernt …
      expect(recognizedData.Tankstelle).toBe('Aral Station Nord');
      expect(recognizedData.Tankstelle).not.toMatch(/^A\s/);
      // … und der Rest des Namens bleibt vollständig.
      expect(recognizedData.Tankstelle).not.toBe('Aral');
    });

    it('uses OCR-only fields for ec_beleg', () => {
      const recognizedData = buildEvidenceBasedRecognizedData({
        classifiedKind: 'ec_beleg',
        recognizedText: EC_RECEIPT,
      });

      expect(recognizedData.Dokumentart).toBe('ec_beleg');
      expect(recognizedData.Betrag).toContain('18,42');
      expect(recognizedData.Lieferant).toBe('REWE Markt München');
      expect(recognizedData.Belegnummer).toBe('EC-4421');
    });

    it('uses OCR-only fields for kassenbeleg including receipt number', () => {
      const recognizedData = buildEvidenceBasedRecognizedData({
        classifiedKind: 'kassenbeleg',
        recognizedText: KASSEN_RECEIPT,
      });

      expect(recognizedData.Dokumentart).toBe('kassenbeleg');
      expect(recognizedData.Betrag).toContain('8,90');
      expect(recognizedData.Datum).toBe('14.07.2026');
      expect(recognizedData.Lieferant).toBe('Bäckerei Schmidt');
      expect(recognizedData.Belegnummer).toBe('4421');
    });

    it('does not inject sender hints as merchant name for tankbeleg', () => {
      const result = classifyDocument({
        recognizedText: TANK_RECEIPT_WITH_AMOUNT,
        senderHint: 'Shell Autobahn',
      });

      expect(result.classifiedKind).toBe('tankbeleg');
      expect(result.recognizedData.Tankstelle).toBe('ARAL Tankstelle München');
      expect(result.recognizedData.Tankstelle).not.toBe('Shell Autobahn');
    });

    it('feeds OCR amount into the expense flow for tankbeleg', () => {
      const classification = classifyDocument({ recognizedText: TANK_RECEIPT_WITH_AMOUNT });
      const inboxItem = {
        id: 'inbox-tank-ocr',
        title: 'Tankbeleg',
        sender: classification.recognizedData.Tankstelle ?? '',
        recognizedData: classification.recognizedData,
        classifiedKind: classification.classifiedKind,
      } as InboxItem;

      const expenseInput = buildExpenseInputFromInbox(inboxItem, 'tankbeleg');

      expect(expenseInput.grossAmount).toBe(52.18);
      expect(expenseInput.category).toBe('fahrzeug');
    });

    it('uses OCR-only fields for kreditkartenbeleg without demo values', () => {
      const recognizedData = buildEvidenceBasedRecognizedData({
        classifiedKind: 'kreditkartenbeleg',
        recognizedText: [
          'REWE Markt München',
          'Kreditkartenbeleg',
          'Visa contactless',
          'Summe 42,80 EUR',
          'Datum: 14.07.2026',
          'Beleg-Nr. KC-8821',
        ].join('\n'),
      });

      expect(recognizedData.Dokumentart).toBe('kreditkartenbeleg');
      expect(recognizedData.Betrag).toContain('42,80');
      expect(recognizedData.Betrag).not.toBe('85,40 €');
      expect(recognizedData.Lieferant).toBe('REWE Markt München');
      expect(recognizedData.Datum).toBe('14.07.2026');
      expect(recognizedData.Belegnummer).toBe('KC-8821');
    });

    it('uses OCR-only fields for quittung without demo values', () => {
      const recognizedData = buildEvidenceBasedRecognizedData({
        classifiedKind: 'quittung',
        recognizedText: [
          'Handwerker Müller',
          'Quittung',
          'Bar erhalten',
          'Betrag: 150,00 EUR',
          'Datum: 14.07.2026',
        ].join('\n'),
      });

      expect(recognizedData.Dokumentart).toBe('quittung');
      expect(recognizedData.Betrag).toContain('150,00');
      expect(recognizedData.Lieferant).toBe('Handwerker Müller');
      expect(recognizedData.Datum).toBe('14.07.2026');
    });

    it('returns only Dokumentart when OCR text is missing for receipt kinds', () => {
      const recognizedData = buildEvidenceBasedRecognizedData({
        classifiedKind: 'quittung',
      });

      expect(recognizedData).toEqual({ Dokumentart: 'quittung' });
      expect(recognizedData.Betrag).toBeUndefined();
    });

    it('enables evidence-based recognizedData for all receipt cutover kinds', () => {
      expect(shouldUseEvidenceBasedRecognizedData('kreditkartenbeleg')).toBe(true);
      expect(shouldUseEvidenceBasedRecognizedData('quittung')).toBe(true);
    });

    /*
     * DOCUMENT-RECEIPT-MERCHANT-HEADER-01 — die Kopfzeilensuche nahm bisher die
     * erste Zeile, die die vorhandenen Filter überlebte. Anschrift, Kontakt-,
     * Kassen-, Bediener- und Filialzeilen kamen damit als Händler durch.
     * Ausgeschlossen wird ausschließlich am Zeilenanfang; die Prioritätsregeln
     * der fünf Belegarten bleiben unverändert.
     */
    describe('DOCUMENT-RECEIPT-MERCHANT-HEADER-01 — ungeeignete Kopfzeilen', () => {
      const tankstelle = (lines: string[]): string | undefined =>
        buildEvidenceBasedRecognizedData({
          classifiedKind: 'tankbeleg',
          recognizedText: lines.join('\n'),
        }).Tankstelle;

      it('A: eine PLZ-/Ortszeile wird nicht zum Händler', () => {
        expect(
          tankstelle(['12345 Musterstadt', 'ARAL Tankstelle München', 'Diesel 41,90 EUR']),
        ).toBe('ARAL Tankstelle München');
      });

      it('B: eine Kontaktzeile wird nicht zum Händler', () => {
        for (const contact of [
          'Tel. 030 1234567',
          'Telefon 030 1234567',
          'Fax 030 7654321',
          'E-Mail info@aral.example',
          'www.aral.example',
        ]) {
          expect(tankstelle([contact, 'ARAL Tankstelle München']), contact).toBe(
            'ARAL Tankstelle München',
          );
        }
      });

      it('C: eine Kassierer-/Bedienerzeile wird nicht zum Händler', () => {
        expect(tankstelle(['Kassierer: Max Mustermann', 'ARAL Tankstelle München'])).toBe(
          'ARAL Tankstelle München',
        );
        expect(tankstelle(['Bediener 7', 'ARAL Tankstelle München'])).toBe(
          'ARAL Tankstelle München',
        );
        expect(tankstelle(['Kasse 3', 'ARAL Tankstelle München'])).toBe(
          'ARAL Tankstelle München',
        );
      });

      it('D: eine Filialzeile wird nicht zum Händler', () => {
        expect(tankstelle(['Filiale 123', 'ARAL Tankstelle München'])).toBe(
          'ARAL Tankstelle München',
        );
      });

      it('E: die Regeln wirken nur am Zeilenanfang und mit Wortgrenze', () => {
        // Firmennamen, die einen Filterbegriff enthalten, bleiben erhalten.
        expect(tankstelle(['Kassenhaus Meier GmbH', 'Diesel 41,90 EUR'])).toBe(
          'Kassenhaus Meier GmbH',
        );
        expect(tankstelle(['Filialbäckerei Nord', 'Diesel 41,90 EUR'])).toBe(
          'Filialbäckerei Nord',
        );
        expect(tankstelle(['Tellerhaus GmbH', 'Diesel 41,90 EUR'])).toBe('Tellerhaus GmbH');
        // Auch mitten in der Zeile darf ein Begriff nichts auslösen.
        expect(tankstelle(['Autohof Nord Filiale 4', 'Diesel 41,90 EUR'])).toBe(
          'Autohof Nord Filiale 4',
        );
      });

      it('F: ein echter Händlername in Zeile 1 bleibt unverändert', () => {
        expect(tankstelle(['ARAL Tankstelle München', 'Diesel 41,90 EUR'])).toBe(
          'ARAL Tankstelle München',
        );
      });

      it('G: bei kassenbeleg gewinnt weiterhin der extrahierte Lieferant', () => {
        const recognizedData = buildEvidenceBasedRecognizedData({
          classifiedKind: 'kassenbeleg',
          recognizedText: [
            'Filiale 123',
            'Kopfzeile Markt Nord',
            'Lieferant: REWE Markt München',
            'Summe 18,42 EUR',
          ].join('\n'),
        });
        expect(recognizedData.Lieferant).toBe('REWE Markt München');
      });

      it('H: bei tankbeleg gewinnt weiterhin die Kopfzeile vor dem Absender', () => {
        const recognizedData = buildEvidenceBasedRecognizedData({
          classifiedKind: 'tankbeleg',
          recognizedText: [
            'ARAL Tankstelle München',
            'Absender: ARAL AG Zentrale',
            'Diesel 41,90 EUR',
          ].join('\n'),
        });
        expect(recognizedData.Tankstelle).toBe('ARAL Tankstelle München');
      });

      it('I: leerer oder reiner Whitespace-Text erfindet keinen Händler', () => {
        expect(tankstelle([''])).toBeUndefined();
        expect(tankstelle(['   ', '\t'])).toBeUndefined();
      });

      it('J: eine Eingangsrechnung bleibt unbeeinflusst', () => {
        const recognizedData = buildEvidenceBasedRecognizedData({
          classifiedKind: 'eingangsrechnung',
          recognizedText: [
            '12345 Musterstadt',
            'Müller Bau GmbH',
            'Rechnungsnummer RE-2026-0001',
            'Gesamtbetrag 342,16 EUR',
          ].join('\n'),
        });
        expect(recognizedData.Lieferant).toBe('Müller Bau GmbH');
      });

      it('K: bekannte Restlücke — ein Werbeslogan wird weiterhin übernommen', () => {
        /*
         * Bewusst als Ist-Zustand festgeschrieben, nicht künstlich grün
         * gemacht: Slogans und freie Straßenzeilen ohne PLZ ließen sich nur
         * über eine Kandidatenbewertung erkennen, die dieser Sprint
         * ausdrücklich nicht einführt.
         */
        expect(tankstelle(['24 Stunden geöffnet', 'ARAL Tankstelle München'])).toBe(
          '24 Stunden geöffnet',
        );
        expect(tankstelle(['Musterweg 1', 'ARAL Tankstelle München'])).toBe('Musterweg 1');
      });
    });

    /*
     * OFFICEPILOT-RECEIPT-MERCHANT-SELECTION-FIX-01 — auf dem realen Beleg las
     * das OCR die Logofläche als verstümmelte erste Kopfzeile, während wenige
     * Zeilen darunter ein sauberer Händlername stand. Bisher gewann die erste
     * Zeile, die die Ausschlussfilter überlebte — es gab keinen Vergleich.
     *
     * Der Vertrag ist bewusst eng: ein sauberer Kandidat verdrängt einen
     * längeren nur dann, wenn er dessen vollständiges Wortpräfix ist und der
     * Rest überwiegend aus Fragmenten besteht. Gibt es keinen besseren
     * Kandidaten, bleibt das bisherige Ergebnis erhalten.
     */
    describe('OFFICEPILOT-RECEIPT-MERCHANT-SELECTION-FIX-01 — Kandidatenauswahl', () => {
      const merchantOf = (kind: 'tankbeleg' | 'kassenbeleg', lines: string[]) =>
        buildEvidenceBasedRecognizedData({
          classifiedKind: kind,
          recognizedText: lines.join('\n'),
        });

      const tankstelleOf = (lines: string[]) => merchantOf('tankbeleg', lines).Tankstelle;

      const REAL_HEAD = [
        'ARAL EEE nn Ef Enz',
        'ARAL',
        'Aral Tankstelle',
        'Musterstraße 1',
        '12345 Musterstadt',
      ];

      it('A: ein sauberer Kandidat verdrängt die verstümmelte erste Kopfzeile', () => {
        expect(tankstelleOf(REAL_HEAD)).toBe('ARAL');
      });

      it('B: steht der saubere Händler bereits oben, ändert sich nichts', () => {
        expect(
          tankstelleOf(['ARAL', 'Aral Tankstelle', 'Musterstraße 1', '12345 Musterstadt']),
        ).toBe('ARAL');
      });

      it('C: ein mehrteiliger Firmenname bleibt vollständig', () => {
        expect(
          tankstelleOf(['Musterstadt Baustoffhandel GmbH', 'Musterstraße 1', '12345 Musterstadt']),
        ).toBe('Musterstadt Baustoffhandel GmbH');
      });

      it('D–I: legitime kurze und gemischte Firmennamen bleiben unverändert', () => {
        for (const name of [
          'H&M',
          'C&A',
          'ATU',
          'OBI',
          'IKEA',
          'T.Bau',
          'Müller GmbH & Co. KG',
          'Firma 24 GmbH',
          'A & O Bau',
        ]) {
          expect(tankstelleOf([name, 'Musterstraße 1', '12345 Musterstadt']), name).toBe(name);
        }
      });

      it('J: eine Adresse wird nicht Bestandteil des Händlernamens', () => {
        expect(tankstelleOf(REAL_HEAD)).not.toContain('Musterstraße');
        expect(tankstelleOf(REAL_HEAD)).not.toContain('12345');
      });

      it('K: Terminaldaten werden nicht Bestandteil des Händlernamens', () => {
        const value = tankstelleOf([
          'ARAL EEE nn Ef Enz',
          'ARAL',
          'Terminal-ID 12345678',
          'Trace-Nr. 004821',
        ]);
        expect(value).toBe('ARAL');
      });

      it('L: ohne besseren Kandidaten bleibt der bisherige erhalten', () => {
        // Kein Präfixkandidat vorhanden — das bisherige Ergebnis bleibt stehen,
        // statt auf leer zu verschlechtern.
        expect(tankstelleOf(['ARAL EEE nn Ef Enz', 'Musterstraße 1', '12345 Musterstadt'])).toBe(
          'ARAL EEE nn Ef Enz',
        );
      });

      /*
       * 01B — Tokenlänge allein beweist keinen OCR-Müll. „Bau", „Pro", „Ost",
       * „Max" sind gewöhnliche Namensbestandteile; ein Kandidat darf nicht
       * gekürzt werden, nur weil ein Präfix zufällig als eigene Kopfzeile
       * auftaucht.
       */
      it('Q: ein echtes kurzes Namenswort wird nicht als OCR-Müll gekürzt', () => {
        expect(tankstelleOf(['Muster Bau GmbH', 'Muster', 'Musterstraße 1'])).toBe(
          'Muster Bau GmbH',
        );
        expect(tankstelleOf(['Max Bau GmbH', 'Max', 'Musterstraße 1'])).toBe('Max Bau GmbH');
        expect(tankstelleOf(['ABC Pro Service GmbH', 'ABC', 'Musterstraße 1'])).toBe(
          'ABC Pro Service GmbH',
        );
        expect(tankstelleOf(['Bau & Co. KG', 'Bau', 'Musterstraße 1'])).toBe('Bau & Co. KG');
      });

      it('R: auch ein einzelnes Restwort mit Rechtsform bleibt erhalten', () => {
        expect(tankstelleOf(['Nordtal Ost GmbH', 'Nordtal', 'Musterstraße 1'])).toBe(
          'Nordtal Ost GmbH',
        );
        expect(tankstelleOf(['Muster Top Handel', 'Muster', 'Musterstraße 1'])).toBe(
          'Muster Top Handel',
        );
      });

      /*
       * 01B — die eigentliche Lücke: ein zweiteiliger Name ohne Rechtsform.
       * Hier bricht kein Strukturwort die Prüfung ab, und ein einzelnes kurzes
       * Namenswort galt allein schon als Beweis für OCR-Müll.
       */
      it('S: ein zweiteiliger Name ohne Rechtsform wird nicht gekürzt', () => {
        expect(tankstelleOf(['Muster Bau', 'Muster', 'Musterstraße 1'])).toBe('Muster Bau');
        expect(tankstelleOf(['Nordtal Ost', 'Nordtal', 'Musterstraße 1'])).toBe('Nordtal Ost');
        expect(tankstelleOf(['Muster Top', 'Muster', 'Musterstraße 1'])).toBe('Muster Top');
      });

      it('T: auch zwei kurze Restwörter genügen nicht als Beweis', () => {
        expect(tankstelleOf(['Muster Bau Ost', 'Muster', 'Musterstraße 1'])).toBe(
          'Muster Bau Ost',
        );
      });

      /*
       * 01D — der reale Scan liest die Logofläche als eigene Rauschzeile und
       * stellt dem sauberen Namen ein OCR-Zeichen voran („= ARAL"). Die
       * Präfixprüfung scheiterte bisher an genau diesem Zeichen.
       */
      it('U: eine führende OCR-Punktion blockiert den sauberen Kandidaten nicht mehr', () => {
        for (const alternative of ['= ARAL', '=ARAL', ': ARAL', '| ARAL', '* ARAL', '~ ARAL']) {
          expect(
            tankstelleOf(['ARAL EEE nn Ef Enz', alternative, 'Musterstraße 1']),
            alternative,
          ).toBe('ARAL');
        }
      });

      it('V: eine Zeile aus reinem Rauschen wird nicht zum Händler', () => {
        // Nach dem Abschneiden bliebe kein Name übrig — der bisherige Wert bleibt.
        expect(tankstelleOf(['ARAL EEE nn Ef Enz', '=====', 'Musterstraße 1'])).toBe(
          'ARAL EEE nn Ef Enz',
        );
      });

      it('W: realer Gerätekopf — Händler, Absender und Betreff sind sauber', () => {
        const REAL_DEVICE_HEAD = [
          'Sep EEE ae Zn',
          '= ARAL',
          'EEE nn Ef Enz',
          'Musterstraße 1',
          '12345 Musterstadt',
        ];

        const result = classifyDocument({
          recognizedText: [
            ...REAL_DEVICE_HEAD,
            'Datum: 22.08.2026',
            'Diesel B7',
            '39,32 Liter',
            'Gesamtbetrag 70,51 EUR',
          ].join('\n'),
        });

        expect(result.classifiedKind).toBe('tankbeleg');
        expect(result.sender).toContain('ARAL');
        expect(result.sender).not.toContain('EEE');
        expect(result.title).toContain('ARAL');
        expect(result.title).not.toContain('EEE');
      });

      it('O/P: Absender und der daraus erzeugte Betreff tragen den sauberen Namen', () => {
        const result = classifyDocument({
          recognizedText: [
            ...REAL_HEAD,
            'Datum: 22.08.2026',
            'Diesel B7',
            '39,32 Liter',
            'Gesamtbetrag 70,51 EUR',
          ].join('\n'),
        });

        expect(result.classifiedKind).toBe('tankbeleg');
        expect(result.sender).not.toContain('EEE');
        expect(result.sender).toContain('ARAL');
        // Der Betreff ist reines Downstream aus `sender` — keine eigene Logik.
        expect(result.title).not.toContain('EEE');
        expect(result.title).toContain(result.sender);
      });

      it('N: der allgemeine Kassenbeleg-Pfad verhält sich gleich', () => {
        expect(merchantOf('kassenbeleg', REAL_HEAD).Lieferant).toBe('ARAL');
        expect(
          merchantOf('kassenbeleg', ['Bäckerei Schmidt', 'Musterstraße 1', '12345 Musterstadt'])
            .Lieferant,
        ).toBe('Bäckerei Schmidt');
      });
    });
  });

  describe('eingangsrechnung', () => {
    it('uses OCR-only invoice fields instead of demo values', () => {
      const recognizedData = buildEvidenceBasedRecognizedData({
        classifiedKind: 'eingangsrechnung',
        recognizedText: INCOMING_INVOICE,
      });

      expect(recognizedData.Dokumentart).toBe('eingangsrechnung');
      expect(recognizedData.Rechnungsnummer).toBe('INV-2026-77');
      expect(recognizedData.Rechnungsnummer).not.toBe('RE-2026-0001');
      expect(recognizedData.Betrag).toContain('1.247,80');
      expect(recognizedData.Betrag).not.toBe('342,16 €');
      expect(recognizedData.Lieferant).toBe('Müller Bau GmbH');
      expect(recognizedData.Datum).toBe('12.03.2026');
      expect(recognizedData.Frist).toBe('31.03.2026');
    });

    it('prefers invoice total over line item amounts', () => {
      const recognizedData = buildEvidenceBasedRecognizedData({
        classifiedKind: 'eingangsrechnung',
        recognizedText: INCOMING_INVOICE,
      });

      expect(recognizedData.Betrag).toContain('1.247,80');
      expect(recognizedData.Betrag).not.toContain('450,00');
      expect(recognizedData.Betrag).not.toContain('320,00');
    });

    it('returns only Dokumentart when OCR text is missing', () => {
      const recognizedData = buildEvidenceBasedRecognizedData({
        classifiedKind: 'eingangsrechnung',
      });

      expect(recognizedData).toEqual({ Dokumentart: 'eingangsrechnung' });
      expect(recognizedData.Betrag).toBeUndefined();
      expect(recognizedData.Rechnungsnummer).toBeUndefined();
      expect(recognizedData.Frist).toBeUndefined();
    });

    it('does not inject sender hints as Lieferant', () => {
      const result = classifyDocument({
        recognizedText: INCOMING_INVOICE,
        senderHint: 'Falscher Lieferant AG',
      });

      expect(result.classifiedKind).toBe('eingangsrechnung');
      expect(result.recognizedData.Lieferant).toBe('Müller Bau GmbH');
      expect(result.recognizedData.Lieferant).not.toBe('Falscher Lieferant AG');
    });

    it('feeds OCR amount and invoice number into the expense flow', () => {
      const classification = classifyDocument({ recognizedText: INCOMING_INVOICE });
      const inboxItem = {
        id: 'inbox-invoice-ocr',
        title: 'Eingangsrechnung',
        sender: classification.recognizedData.Lieferant ?? '',
        recognizedData: classification.recognizedData,
        classifiedKind: classification.classifiedKind,
      } as InboxItem;

      const expenseInput = buildExpenseInputFromInbox(inboxItem, 'eingangsrechnung');

      expect(classification.classifiedKind).toBe('eingangsrechnung');
      expect(expenseInput.grossAmount).toBe(1247.8);
      expect(expenseInput.invoiceNumber).toBe('INV-2026-77');
    });

    it('enables evidence-based recognizedData for eingangsrechnung', () => {
      const result = classifyDocument({ recognizedText: INCOMING_INVOICE });

      expect(shouldUseEvidenceBasedRecognizedData(result.classifiedKind)).toBe(true);
      expect(result.recognizedData.Betrag).not.toBe('342,16 €');
    });
  });

  describe('payment family', () => {
    const MAHNUNG_OCR = [
      'Müller Bau GmbH',
      '2. Mahnung',
      'Rechnungsnummer: INV-2026-77',
      'Datum: 12.03.2026',
      'Offener Betrag: 1.247,80 EUR',
      'Zahlungsaufforderung',
      'Zahlbar bis 31.03.2026',
    ].join('\n');

    it('uses OCR-only payment fields instead of demo values for mahnung', () => {
      const recognizedData = buildEvidenceBasedRecognizedData({
        classifiedKind: 'mahnung',
        recognizedText: MAHNUNG_OCR,
      });

      expect(recognizedData.Dokumentart).toBe('mahnung');
      expect(recognizedData.Rechnungsnummer).toBe('INV-2026-77');
      expect(recognizedData.Rechnungsnummer).not.toBe('BZ-2026-8842');
      expect(recognizedData.Betrag).toContain('1.247,80');
      expect(recognizedData.Betrag).not.toBe('342,16 €');
      expect(recognizedData.Fälligkeit).toBe('31.03.2026');
      expect(recognizedData.Fälligkeit).not.toBe('30.03.2026');
      expect(recognizedData.Lieferant).toBe('Müller Bau GmbH');
      expect(recognizedData.Hinweis).toMatch(/mahnung/i);
    });

    it('uses OCR-only fields for zahlungserinnerung', () => {
      const recognizedData = buildEvidenceBasedRecognizedData({
        classifiedKind: 'zahlungserinnerung',
        recognizedText: [
          'Müller Bau GmbH',
          'Zahlungserinnerung',
          'Rechnungsnummer: INV-2026-55',
          'Datum: 08.03.2026',
          'Offener Betrag: 842,50 EUR',
          'Zahlbar bis 22.03.2026',
        ].join('\n'),
      });

      expect(recognizedData.Dokumentart).toBe('zahlungserinnerung');
      expect(recognizedData.Rechnungsnummer).toBe('INV-2026-55');
      expect(recognizedData.Betrag).toContain('842,50');
      expect(recognizedData.Fälligkeit).toBe('22.03.2026');
      expect(recognizedData.Hinweis).toMatch(/zahlungserinnerung/i);
    });

    it('returns only Dokumentart when OCR text is missing for payment kinds', () => {
      const recognizedData = buildEvidenceBasedRecognizedData({
        classifiedKind: 'mahnung',
      });

      expect(recognizedData).toEqual({ Dokumentart: 'mahnung' });
      expect(recognizedData.Betrag).toBeUndefined();
      expect(recognizedData.Rechnungsnummer).toBeUndefined();
      expect(recognizedData.Fälligkeit).toBeUndefined();
    });
  });

  describe('certificate family', () => {
    it('uses OCR-only certificate fields instead of demo values for freistellungsbescheinigung', () => {
      const recognizedData = buildEvidenceBasedRecognizedData({
        classifiedKind: 'freistellungsbescheinigung',
        recognizedText: [
          'Finanzamt München',
          'Freistellungsbescheinigung §48b',
          'Betreff: Freistellungsbescheinigung nach §48b EStG',
          'Aussteller: Finanzamt München',
          'Datum: 15.03.2026',
          'gültig bis 31.12.2027',
        ].join('\n'),
      });

      expect(recognizedData.Dokumentart).toBe('freistellungsbescheinigung');
      expect(recognizedData.Betreff).toBe('Freistellungsbescheinigung nach §48b EStG');
      expect(recognizedData.Aussteller).toBe('Finanzamt München');
      expect(recognizedData.Gültig_bis).toBe('31.12.2027');
      expect(recognizedData.Gültig_bis).not.toBe('31.12.2026');
      expect(recognizedData.Datum).toBe('15.03.2026');
    });

    it('uses OCR-only fields for unbedenklichkeitsbescheinigung without default BG BAU', () => {
      const recognizedData = buildEvidenceBasedRecognizedData({
        classifiedKind: 'unbedenklichkeitsbescheinigung',
        recognizedText: [
          'BG BAU',
          'Unbedenklichkeitsbescheinigung',
          'Aussteller: BG BAU',
          'gültig bis 30.06.2027',
        ].join('\n'),
      });

      expect(recognizedData.Dokumentart).toBe('unbedenklichkeitsbescheinigung');
      expect(recognizedData.Aussteller).toBe('BG BAU');
      expect(recognizedData.Gültig_bis).toBe('30.06.2027');
    });

    it('returns only Dokumentart when OCR text is missing for certificate kinds', () => {
      const recognizedData = buildEvidenceBasedRecognizedData({
        classifiedKind: 'freistellungsbescheinigung',
      });

      expect(recognizedData).toEqual({ Dokumentart: 'freistellungsbescheinigung' });
      expect(recognizedData.Gültig_bis).toBeUndefined();
    });
  });

  describe('contract family', () => {
    it('uses OCR-only contract fields instead of demo values for werkvertrag', () => {
      const recognizedData = buildEvidenceBasedRecognizedData({
        classifiedKind: 'werkvertrag',
        recognizedText: [
          'Werkvertrag',
          'Auftraggeber: Müller Bau GmbH',
          'Subunternehmer: Mustermann Sanitär GmbH',
          'Baustellenadresse: Hauptstr. 12, 10115 Berlin',
          'Vertragsdatum: 15.03.2026',
          'Auftragsnummer: AV-2026-0042',
        ].join('\n'),
      });

      expect(recognizedData.Dokumentart).toBe('werkvertrag');
      expect(recognizedData.Auftraggeber).toBe('Müller Bau GmbH');
      expect(recognizedData.Auftragnehmer).toBe('Mustermann Sanitär GmbH');
      expect(recognizedData.Baustelle).toBe('Hauptstr. 12, 10115 Berlin');
      expect(recognizedData.Baustelle).not.toBe('Baustelle laut Vertrag');
      expect(recognizedData.Vertragsdatum).toBe('15.03.2026');
      expect(recognizedData.Auftragsnummer).toBe('AV-2026-0042');
    });

    it('uses OCR-only fields for subunternehmervertrag without default baustelle', () => {
      const recognizedData = buildEvidenceBasedRecognizedData({
        classifiedKind: 'subunternehmervertrag',
        recognizedText: [
          'Subunternehmervertrag',
          'Auftraggeber: Großbau AG',
          'Nachunternehmer: Klempner Meier OHG',
          'Baustelle: Schulweg 5, 80331 München',
          'Vertragsdatum: 20.02.2026',
          'Auftragsnummer: SU-2026-118',
        ].join('\n'),
      });

      expect(recognizedData.Dokumentart).toBe('subunternehmervertrag');
      expect(recognizedData.Auftraggeber).toBe('Großbau AG');
      expect(recognizedData.Baustelle).toBe('Schulweg 5, 80331 München');
    });

    it('returns only Dokumentart when OCR text is missing for contract kinds', () => {
      const recognizedData = buildEvidenceBasedRecognizedData({
        classifiedKind: 'werkvertrag',
      });

      expect(recognizedData).toEqual({ Dokumentart: 'werkvertrag' });
      expect(recognizedData.Baustelle).toBeUndefined();
    });
  });

  describe('customer family', () => {
    it('uses OCR-only customer fields instead of demo values for auftrag', () => {
      const recognizedData = buildEvidenceBasedRecognizedData({
        classifiedKind: 'auftrag',
        recognizedText: [
          'Kundenauftrag',
          'Betreff: Sanierung Fassade',
          'Auftraggeber: Stadt München',
          'Baustelle: Hauptstr. 12, 80331 München',
          'Auftragsnummer: KA-2026-0042',
          'Auftragssumme: 45.000,00 EUR',
          'Datum: 15.03.2026',
        ].join('\n'),
      });

      expect(recognizedData.Dokumentart).toBe('auftrag');
      expect(recognizedData.Auftraggeber).toBe('Stadt München');
      expect(recognizedData.Baustelle).toBe('Hauptstr. 12, 80331 München');
      expect(recognizedData.Auftragsnummer).toBe('KA-2026-0042');
      expect(recognizedData.Auftragssumme).toBe('45.000,00 EUR');
      expect(recognizedData.Leistung).toBeUndefined();
      expect(recognizedData.Baustelle).not.toBe('Baustelle laut Auftrag');
    });

    it('uses OCR-only fields for angebot with labeled summe only', () => {
      const recognizedData = buildEvidenceBasedRecognizedData({
        classifiedKind: 'angebot',
        recognizedText: [
          'Angebot',
          'Betreff: Elektroinstallation',
          'Kunde: Weber GmbH',
          'Angebotsnummer: AN-2026-118',
          'Angebotssumme: 12.500,00 EUR',
          'Datum: 20.02.2026',
        ].join('\n'),
      });

      expect(recognizedData.Dokumentart).toBe('angebot');
      expect(recognizedData.Kunde).toBe('Weber GmbH');
      expect(recognizedData.Angebotsnummer).toBe('AN-2026-118');
      expect(recognizedData.Angebotssumme).toBe('12.500,00 EUR');
      expect(recognizedData.Angebotssumme).not.toBe('ca. 5.000 €');
    });

    it('omits unlabeled amounts and baustelle for auftragsbestaetigung', () => {
      const recognizedData = buildEvidenceBasedRecognizedData({
        classifiedKind: 'auftragsbestaetigung',
        recognizedText: [
          'Auftragsbestätigung',
          'Betreff: Bestätigung Auftrag',
          'Auftraggeber: Großbau AG',
          'Auftragsnummer: AB-2026-77',
          '45.000,00 EUR',
          'Datum: 01.04.2026',
        ].join('\n'),
      });

      expect(recognizedData.Dokumentart).toBe('auftragsbestaetigung');
      expect(recognizedData.Auftraggeber).toBe('Großbau AG');
      expect(recognizedData.Auftragsnummer).toBe('AB-2026-77');
      expect(recognizedData.Auftragssumme).toBeUndefined();
      expect(recognizedData.Baustelle).toBeUndefined();
    });

    it('returns only Dokumentart when OCR text is missing for customer kinds', () => {
      const recognizedData = buildEvidenceBasedRecognizedData({
        classifiedKind: 'auftrag',
      });

      expect(recognizedData).toEqual({ Dokumentart: 'auftrag' });
      expect(recognizedData.Leistung).toBeUndefined();
    });
  });

  describe('authority family', () => {
    it('uses OCR-only authority fields instead of demo values for finanzamt', () => {
      const recognizedData = buildEvidenceBasedRecognizedData({
        classifiedKind: 'finanzamt',
        recognizedText: [
          'Finanzamt München',
          'Betreff: Umsatzsteuervoranmeldung',
          'Aktenzeichen: 143/123/45678',
          'Frist: 10.05.2026',
        ].join('\n'),
      });

      expect(recognizedData.Dokumentart).toBe('finanzamt');
      expect(recognizedData.Betreff).toBe('Umsatzsteuervoranmeldung');
      expect(recognizedData.Aktenzeichen).toBe('143/123/45678');
      expect(recognizedData.Frist).toBe('10.05.2026');
      expect(recognizedData.Frist).not.toBe('10.04.2026');
      expect(recognizedData.Absender).toBe('Finanzamt München');
    });

    it('uses OCR-only fields for bg_bau with labeled amount only', () => {
      const recognizedData = buildEvidenceBasedRecognizedData({
        classifiedKind: 'bg_bau',
        recognizedText: [
          'BG BAU',
          'Beitragsbescheid 2026',
          'Aktenzeichen: BEI-2026-4455',
          'Betrag: 1.250,00 EUR',
          'Frist: 30.04.2026',
        ].join('\n'),
      });

      expect(recognizedData.Dokumentart).toBe('bg_bau');
      expect(recognizedData.Aktenzeichen).toBe('BEI-2026-4455');
      expect(recognizedData.Betrag).toContain('1.250,00');
      expect(recognizedData.Frist).toBe('30.04.2026');
    });

    it('uses OCR-only fields for krankenkasse without demo betreff', () => {
      const recognizedData = buildEvidenceBasedRecognizedData({
        classifiedKind: 'krankenkasse',
        recognizedText: [
          'Techniker Krankenkasse',
          'Betreff: Beitragsbescheid Krankenversicherung',
          'Aktenzeichen: KK-2026-8891',
          'Frist: 30.04.2026',
          'Datum: 15.03.2026',
        ].join('\n'),
      });

      expect(recognizedData.Dokumentart).toBe('krankenkasse');
      expect(recognizedData.Betreff).toBe('Beitragsbescheid Krankenversicherung');
      expect(recognizedData.Aktenzeichen).toBe('KK-2026-8891');
      expect(recognizedData.Frist).toBe('30.04.2026');
      expect(recognizedData.Datum).toBe('15.03.2026');
      expect(recognizedData.Betreff).not.toBe('Mitteilung Krankenkasse');
    });

    it('uses OCR-only fields for soka_bau with beitragsnummer and labeled amount', () => {
      const recognizedData = buildEvidenceBasedRecognizedData({
        classifiedKind: 'soka_bau',
        recognizedText: [
          'SOKA-BAU',
          'Betreff: Beitragsabrechnung SOKA-BAU',
          'Beitragsnummer: SB-2026-3344',
          'Betrag: 890,50 EUR',
          'Frist: 31.05.2026',
        ].join('\n'),
      });

      expect(recognizedData.Dokumentart).toBe('soka_bau');
      expect(recognizedData.Betreff).toBe('Beitragsabrechnung SOKA-BAU');
      expect(recognizedData.Aktenzeichen).toBe('SB-2026-3344');
      expect(recognizedData.Betrag).toContain('890,50');
      expect(recognizedData.Frist).toBe('31.05.2026');
    });

    it('returns only Dokumentart when OCR text is missing for authority kinds', () => {
      const recognizedData = buildEvidenceBasedRecognizedData({
        classifiedKind: 'steuerbescheid',
      });

      expect(recognizedData).toEqual({ Dokumentart: 'steuerbescheid' });
      expect(recognizedData.Frist).toBeUndefined();
      expect(recognizedData.Betreff).toBeUndefined();
    });
  });

  describe('legacy and rollback', () => {
    it('leaves mahnung without demo values when cutover is disabled', () => {
      setPaymentScoringCutoverEnabledForTests(false);
      const result = classifyDocument({
        recognizedText: 'Mahnung Zahlungsaufforderung',
      });

      expect(shouldUseEvidenceBasedRecognizedData(result.classifiedKind)).toBe(true);
      expect(result.recognizedData.Betrag).toBeUndefined();
      expect(result.recognizedData.Fälligkeit).toBeUndefined();
      expect(result.recognizedData.Rechnungsnummer).toBeUndefined();
    });

    it('leaves mahnung with empty fields on kindHint legacy path', () => {
      const result = classifyDocument({
        recognizedText: 'Mahnung Zahlungsaufforderung',
        kindHint: 'mahnung',
      });

      expect(shouldUseEvidenceBasedRecognizedData(result.classifiedKind)).toBe(true);
      expect(result.recognizedData.Betrag).toBeUndefined();
      expect(result.recognizedData.Fälligkeit).toBeUndefined();
    });

    it('can be disabled via feature flag for rollback', () => {
      setOcrOnlyRecognizedDataEnabledForTests(false);

      const tank = classifyDocument({ recognizedText: 'Tankstelle Diesel Beleg' });
      const invoice = classifyDocument({
        recognizedText: 'Eingangsrechnung ohne erkennbare Details',
        kindHint: 'eingangsrechnung',
      });

      expect(tank.recognizedData.Betrag).toBe('85,40 €');
      expect(invoice.recognizedData.Betrag).toBe('342,16 €');
      expect(invoice.recognizedData.Rechnungsnummer).toBe('RE-2026-0001');
    });
  });
});
