/**
 * EINGANG-02A-1 — Absenderwahrheit und Vertragsfehldeutung bei Behörden- und
 * Versicherungsschreiben.
 *
 * P1-1: Bei Versicherungs- und Stadt-/Gemeinde-Schreiben wurde die eigene Firma
 *       aus dem Empfängerblock zum Absender.
 * P1-2: „Versicherungsschein-Nr." machte ein Versicherungsschreiben zum
 *       Versicherungsvertrag mit Hauptaktion „Auftrag annehmen".
 *
 * Geprüft über den echten Aufnahmepfad (Vorschau-Klassifikation → Aufnahme →
 * Analyse → Zusammenfassung), ergänzt um die reinen Regeln.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_COMPANY_PROFILE } from './data/companyProfileDefaults';
import { hydrateCompanyProfileStore } from './services/companyProfileService';
import { classifyDocument } from './services/documentClassificationService';
import { intakeCachedDocumentFile } from './services/documentIntakeService';
import { hydrateDocumentFileStore } from './services/documentFileStoreService';
import { hydrateDocumentStore } from './services/documentService';
import { resetDocumentWorkResultStoreForTests } from './services/documentWorkResultService';
import { hydrateExpenseStore } from './services/expenseStore';
import { getInboxItemById, hydrateInboxStore } from './services/inboxService';
import { analyzeUploadedDocument, processUploadedDocument } from './services/intakeWorkflowService';
import { setActiveStorageScope } from './services/storage/storageScopeService';
import { hydrateVorgangStore } from './services/vorgangService';
import { buildDocumentSummary } from './services/documentSummary';
import { inferUnlabeledSenderFromText } from './services/documentFieldExtractionService';
import { detectContractType, hasContractFamilyTitle } from './services/contractIntelligenceExtraction';
import { hasInstitutionalLetterhead } from './services/document/institutionalSenderTruth';
import { detectClassifiedKindWithReason } from './services/documentClassificationService';
import {
  admitsContractIntelligenceForKind,
  analyzeContractIntelligenceFromText,
  buildContractOrderProposal,
} from './services/contractIntelligenceService';
import { isOwnCompanySenderCandidate } from './services/document/institutionalSenderTruth';
import { useDocumentBlobDatabaseReset } from './test/documentBlobTestReset';
import { createTestVorgang } from './test/fixtures';
import { t } from './i18n';

const OWN = 'Mustermann Sanitär GmbH';
const TO = `${OWN}\nHandwerkerweg 7\n10115 Berlin`;
const ALLIANZ = 'Allianz Versicherungs-AG';
const VERS = `${ALLIANZ}\nSchadennummer: S-2026-0077\nVersicherungsschein-Nr. VS-998877\n${TO}`;
const STADT = 'Stadt Musterstadt - Bauordnungsamt';

const TEXT = {
  E: `${VERS}\nWir bestätigen den Eingang Ihrer Schadenmeldung vom 01.10.2026. Wir melden uns in Kürze bei Ihnen.`,
  F: `${VERS}\nZu Ihrem Schaden vom 28.09.2026: Bitte reichen Sie uns bis zum 31.10.2026 folgende Unterlagen ein: Kostenvoranschlag, Fotos des Schadens.`,
  F2: `${VERS}\nNach Prüfung des Sachverhalts müssen wir Ihnen leider mitteilen, dass wir für den Schaden vom 28.09.2026 keine Leistung erbringen können. Der Schaden ist nicht versichert.`,
  F3: `${VERS}\nBitte melden Sie den Schaden bis zum 30.10.2026 und geben Sie uns bis zum 25.10.2026 eine Rückmeldung.`,
  G: `Gemeinde Musterdorf\nDer Bürgermeister\n${TO}\nMitteilung zur Straßenreinigungssatzung. Eine Reaktion ist nicht erforderlich.`,
  I: `${STADT}\nAktenzeichen: BA-2026-123\n${TO}\nIhr Auftrag AU-2026-0501, Baustelle Werkstraße 1\nBitte reichen Sie die Baustellenzeichnung bis zum 30.10.2026 ein.`,
  J: `${STADT}\nAktenzeichen: BA-2026-124\n${TO}\nBitte reichen Sie die Baustellenzeichnung bis zum 30.10.2026 ein.`,
  FA: `Finanzamt Musterstadt\nSteuernummer 12/345/67890\n${TO}\nAktenzeichen: St-2026/4711\nBitte nehmen Sie bis zum 20.10.2026 Stellung.`,
  BG: `Berufsgenossenschaft der Bauwirtschaft\nMitgliedsnummer: 123456789\n${TO}\nBeitragsbescheid für das Umlagejahr 2025\nDer Beitrag beträgt 2.345,67 EUR und ist bis zum 15.11.2026 zu zahlen.`,
  AOK: `AOK Nordost - Die Gesundheitskasse\nBetriebsnummer 12345678\n${TO}\nBitte überweisen Sie den Nachforderungsbetrag von 456,78 EUR bis zum 30.11.2026.`,
  VERTRAG: `${ALLIANZ}\nVersicherungsvertrag Betriebshaftpflicht\nVersicherungsschein-Nr. VS-998877\nVersicherer: ${ALLIANZ}\nVersicherungsnehmer: ${OWN}\nDeckung: Personen- und Sachschäden bis 5.000.000 EUR\nSelbstbeteiligung: 500 EUR\nJahresbeitrag: 1.200,00 EUR\nVertragsbeginn: 01.01.2027`,
  // Unbekannter Briefkopf ohne Rechtsform: nur der Ausschluss verhindert die eigene Firma.
  NETZ: `Nordlicht Assekuranz\n${TO}\nIhre Versicherung: Wir bestätigen den Eingang Ihrer Schadenmeldung.`,
  // Eigenes Schreiben an die Versicherung: die eigene Firma IST der Absender.
  EIGEN: `${TO}\n${ALLIANZ}\nSchadenabteilung\nSchadenmeldung Versicherungsschein-Nr. VS-998877\nHiermit melden wir einen Wasserschaden vom 28.09.2026.`,
  // Eigene Rechnung an eine Stadt: der kommunale Empfänger ist kein Briefkopf.
  STADT_RECHNUNG: `${TO}\nStadt Musterstadt\nRathausplatz 1\nRechnung Nr. 2026-0042\nRechnungsdatum 01.10.2026\nGesamtbetrag 1.190,00 EUR`,
} as const;

type CaseKey = keyof typeof TEXT;

useDocumentBlobDatabaseReset();

let seq = 0;

function hydrateProfile(companyName = OWN) {
  hydrateCompanyProfileStore({
    ...DEFAULT_COMPANY_PROFILE,
    companyName,
    street: 'Handwerkerweg 7',
    zip: '10115',
    city: 'Berlin',
  });
}

beforeEach(() => {
  setActiveStorageScope({ type: 'guest' });
  localStorage.clear();
  resetDocumentWorkResultStoreForTests();
  hydrateInboxStore([]);
  hydrateDocumentStore([]);
  hydrateDocumentFileStore([], {});
  hydrateExpenseStore([]);
  hydrateProfile();
  hydrateVorgangStore([
    createTestVorgang({
      id: 'v-au',
      title: 'Baustelle Werkstraße 1',
      customer: 'Ernst Flisch',
      baustelle: 'Werkstraße 1',
      orderNumber: 'AU-2026-0501',
    }),
  ]);
});

async function intake(recognizedText: string) {
  const name = `a02a1-${++seq}.pdf`;
  const bytes = new TextEncoder().encode(`${name}:${recognizedText}`);
  const result = await intakeCachedDocumentFile(
    { bytes, fileName: name, mimeType: 'application/pdf', fileSize: bytes.byteLength },
    {
      sourceFileName: name,
      recognizedText,
      previewClassification: classifyDocument({ sourceFileName: name, recognizedText }),
      userDecision: 'save_permanently',
    },
  );
  const id = result.inboxItem!.id;
  hydrateInboxStore([{ ...getInboxItemById(id)!, markedAsCompanyDocument: true }]);
  processUploadedDocument(id);
  const item = getInboxItemById(id)!;
  const workflow = analyzeUploadedDocument(id)!;
  const summary = buildDocumentSummary(item, workflow, { translate: (key) => t(key, 'de') });
  const shownSender = summary.facts.find((fact) => fact.id === 'authority' || fact.id === 'sender' || fact.id === 'supplier')?.value;
  return { item, workflow, summary, shownSender };
}

describe('02A-1 P1-1 — Absenderwahrheit über den echten Aufnahmepfad', () => {
  const institutional: Array<[CaseKey, string]> = [
    ['E', ALLIANZ],
    ['F', ALLIANZ],
    ['F2', ALLIANZ],
    ['F3', ALLIANZ],
    ['G', 'Gemeinde Musterdorf'],
    ['I', STADT],
    ['J', STADT],
    ['VERTRAG', ALLIANZ],
  ];

  it.each(institutional)('%s: Absender ist die Institution, nie die eigene Firma', async (key, expected) => {
    const { item, workflow, shownSender } = await intake(TEXT[key]);
    expect(item.sender).toBe(expected);
    expect(item.recognizedData.Absender).toBe(expected);
    expect(workflow.documentUnderstanding?.sender).toBe(expected);
    // Die Vertragsansicht zeigt Parteien statt einer Absender-Kachel.
    if (key !== 'VERTRAG') expect(shownSender).toBe(expected);
    for (const value of [item.sender, item.recognizedData.Absender, item.recognizedData.Lieferant, workflow.documentUnderstanding?.sender, shownSender]) {
      expect(isOwnCompanySenderCandidate(value, OWN)).toBe(false);
    }
  });

  it.each([
    ['FA', 'Finanzamt Musterstadt'],
    ['BG', 'Berufsgenossenschaft der Bauwirtschaft'],
    ['AOK', 'AOK Nordost - Die Gesundheitskasse'],
  ] as Array<[CaseKey, string]>)('Kontrolle %s: Absender bleibt unverändert korrekt', async (key, expected) => {
    const { item } = await intake(TEXT[key]);
    expect(item.sender).toBe(expected);
    expect(item.recognizedData.Absender).toBe(expected);
  });

  it('unbekannter Briefkopf: eigene Firma wird ausgeschlossen, nichts erfunden', async () => {
    const { item, workflow, shownSender } = await intake(TEXT.NETZ);
    expect(item.classifiedKind).toBe('versicherung');
    for (const value of [item.sender, item.recognizedData.Absender, workflow.documentUnderstanding?.sender, shownSender]) {
      expect(isOwnCompanySenderCandidate(value, OWN)).toBe(false);
    }
    expect(item.recognizedData.Absender).toBeUndefined();
  });

  it('eigene Firma ausgeschlossen auch bei abweichender Schreibweise (GmbH & Co. KG)', async () => {
    hydrateProfile('Mustermann Sanitär GmbH & Co. KG');
    const text = `Nordlicht Assekuranz\nMUSTERMANN  Sanitär GmbH & Co KG\nHandwerkerweg 7\n10115 Berlin\nIhre Versicherung: Wir bestätigen den Eingang Ihrer Schadenmeldung.`;
    const { item, shownSender } = await intake(text);
    expect(isOwnCompanySenderCandidate(item.sender, 'Mustermann Sanitär GmbH & Co. KG')).toBe(false);
    expect(isOwnCompanySenderCandidate(shownSender, 'Mustermann Sanitär GmbH & Co. KG')).toBe(false);
  });

  it('eigenes Schreiben an die Versicherung behält die eigene Firma als Absender', async () => {
    const { item } = await intake(TEXT.EIGEN);
    expect(item.sender).toBe(OWN);
  });

  it('eigene Rechnung an eine Stadt behält den eigenen Briefkopf', async () => {
    const { item } = await intake(TEXT.STADT_RECHNUNG);
    expect(item.sender).toBe(OWN);
  });
});

describe('02A-1 P1-1 — Briefkopf-Regeln', () => {
  it('Rechtsform mit Bindestrich: „Versicherungs-AG" wird erkannt', () => {
    expect(inferUnlabeledSenderFromText(`${ALLIANZ}\n${TO}\nText`)).toBe(ALLIANZ);
  });

  it('eine „-AG" im Fließtext verdrängt keinen früheren Briefkopf', () => {
    expect(inferUnlabeledSenderFromText(`Müller Haustechnik GmbH\nProtokoll zum Treffen der Arbeits-AG Energie`)).toBe(
      'Müller Haustechnik GmbH',
    );
  });

  it.each([
    'Stadt Musterstadt',
    'Stadtverwaltung Musterstadt',
    'Gemeinde Musterdorf',
    'Landratsamt Musterkreis',
    'Landkreis Musterland',
    'Kreisverwaltung Musterkreis',
    'Bezirksamt Mitte',
    'Bauordnungsamt Musterstadt',
  ])('kommunaler Briefkopf „%s" vor dem Empfängerblock', (letterhead) => {
    expect(inferUnlabeledSenderFromText(`${letterhead}\n${TO}\nMitteilung.`)).toBe(letterhead);
  });

  it('kommunale Wörter im Fließtext sind kein Briefkopf', () => {
    expect(
      inferUnlabeledSenderFromText(`Müller Haustechnik GmbH\nWir arbeiten für die Stadt Köln am Rathaus.`),
    ).toBe('Müller Haustechnik GmbH');
  });

  it('mit Ausschluss wird die nächste Rechtsform statt der eigenen Firma gewählt', () => {
    const text = `${TO}\nNordlicht Versicherung AG\nMitteilung.`;
    expect(inferUnlabeledSenderFromText(text)).toBe(OWN);
    expect(inferUnlabeledSenderFromText(text, { excludeCandidate: (c) => isOwnCompanySenderCandidate(c, OWN) })).toBe(
      'Nordlicht Versicherung AG',
    );
  });

  it('Firmenvergleich: Schreibweise, Leerraum und Satzzeichen — aber kein Teilstring', () => {
    expect(isOwnCompanySenderCandidate('mustermann sanitär gmbh', OWN)).toBe(true);
    expect(isOwnCompanySenderCandidate('  Mustermann   Sanitär GmbH ', OWN)).toBe(true);
    expect(isOwnCompanySenderCandidate('Mustermann Sanitär GmbH,', OWN)).toBe(true);
    expect(isOwnCompanySenderCandidate('Mustermann Sanitär GmbH & Co KG', 'Mustermann Sanitär GmbH & Co. KG')).toBe(true);
    expect(isOwnCompanySenderCandidate('Mustermann Bau AG', 'Mustermann Bau AG')).toBe(true);
    expect(isOwnCompanySenderCandidate('Mustermann Sanitär GmbH Niederlassung Nord', OWN)).toBe(false);
    expect(isOwnCompanySenderCandidate(ALLIANZ, OWN)).toBe(false);
    expect(isOwnCompanySenderCandidate(OWN, '')).toBe(false);
  });
});

describe('02A-1 P1-2 — keine Vertragsfehldeutung', () => {
  it.each(['E', 'F', 'F2', 'F3'] as CaseKey[])(
    '%s: Versicherungsschein-Nr. erzeugt keinen Vertrag und kein „Auftrag annehmen"',
    async (key) => {
      const { workflow, summary } = await intake(TEXT[key]);
      expect(workflow.contractOrderProposal).toBeNull();
      expect(workflow.contractIntelligence?.contractType.family ?? 'none').not.toBe('versicherungsvertrag');
      expect(summary.family).not.toBe('contract');
      expect(summary.primaryAction.id).not.toBe('accept_contract_order');
    },
  );

  it('echter Versicherungsvertrag bleibt ein Vertrag mit legitimem Vertragsworkflow', async () => {
    const { workflow, summary } = await intake(TEXT.VERTRAG);
    expect(workflow.contractIntelligence?.contractType.family).toBe('versicherungsvertrag');
    expect(workflow.contractIntelligence?.contractType.evidence).toContain('heading:versicherungsvertrag');
    expect(workflow.contractIntelligence?.contractType.confidence).toBe('high');
    expect(workflow.contractOrderProposal).not.toBeNull();
    expect(summary.family).toBe('contract');
    expect(summary.primaryAction.id).toBe('accept_contract_order');
  });

  it('„Versicherungsschein" als Titel bleibt eine Vertragsüberschrift, die Nummernzeile nicht', () => {
    expect(detectContractType('Versicherungsschein\nNr. VS-1').evidence).toContain('heading:versicherungsvertrag');
    for (const reference of ['Versicherungsschein-Nr. VS-1', 'Versicherungsschein Nr. VS-1', 'Versicherungsschein-Nummer VS-1', 'Versicherungsschein No. 1']) {
      expect(detectContractType(`Allianz\n${reference}\nWir bestätigen den Eingang.`).family).toBe('unknown');
    }
  });
});

/*
 * EINGANG-02A-1 Nacharbeit 1 — Bestandskommunikation einer Versicherung nennt
 * „Ihren Versicherungsvertrag", „Versicherungsnehmer", „Beitrag", „Deckung" oder
 * „Selbstbeteiligung". Das macht sie nicht zu einem neu anzunehmenden Vertrag.
 */
const BESTAND = {
  'P2-A Beitragsanpassung': `${ALLIANZ}\n${TO}\nZu Ihrem Versicherungsvertrag VS-998877 teilen wir Ihnen mit, dass sich Ihr Beitrag ab dem 01.01.2027 auf 1.260,00 EUR jährlich ändert. Sie müssen nichts weiter tun.`,
  'P2-A2 Adressänderung mit Betreff': `${ALLIANZ}\n${TO}\nBetreff: Ihr Versicherungsvertrag VS-998877\nSehr geehrte Damen und Herren,\nwir haben Ihre neue Anschrift in unseren Unterlagen geändert.`,
  'P2-A3 Kündigungsbestätigung': `${ALLIANZ}\n${TO}\nKündigungsbestätigung zu Ihrem Versicherungsvertrag VS-998877\nHiermit bestätigen wir die Kündigung zum 31.12.2026.`,
  'P2-A4 Betreffzeile ohne Label': `${ALLIANZ}\n${TO}\nVersicherungsvertrag VS-998877\nIhr Beitrag ändert sich ab dem 01.01.2027 auf 1.260,00 EUR.`,
  'P2-B Deckungsinformation': `${ALLIANZ}\n${TO}\nVersicherungsnehmer: ${OWN}\nWir bestätigen Ihnen, dass Ihre bestehende Deckung für Arbeiten an Fremdobjekten unverändert fortbesteht.`,
  'P2-B2 Schadenregulierung': `${ALLIANZ}\nSchadennummer: S-2026-0077\n${TO}\nVersicherungsnehmer: ${OWN}\nWir übernehmen den Schaden vom 28.09.2026 abzüglich der vereinbarten Selbstbeteiligung von 500,00 EUR. Die Zahlung von 1.700,00 EUR erfolgt in den nächsten Tagen.`,
  'P2-B3 Beitragsrechnung': `${ALLIANZ}\n${TO}\nBeitragsrechnung 2027\nVersicherungsnehmer: ${OWN}\nDer Jahresbeitrag von 1.260,00 EUR ist am 01.01.2027 fällig.`,
  'P2-B4 Eingangsbestätigung': `${ALLIANZ}\nSchadennummer: S-2026-0077\n${TO}\nWir bestätigen den Eingang Ihrer Schadenmeldung vom 01.10.2026.`,
  'P2-B5 nur Versicherungsnehmer': `${ALLIANZ}\n${TO}\nVersicherungsnehmer: ${OWN}\nWir haben Ihre neue Anschrift in unseren Unterlagen geändert.`,
} as const;

const VERTRAGSDOKUMENT = {
  'P2-C Versicherungsvertrag': `${ALLIANZ}\nVersicherungsvertrag Betriebshaftpflicht\nVersicherer: ${ALLIANZ}\nVersicherungsnehmer: ${OWN}, Handwerkerweg 7, 10115 Berlin\nVersicherungsumfang: gesetzliche Haftpflicht aus dem Betrieb eines Sanitärhandwerks\nDeckung: Personen- und Sachschäden bis 5.000.000 EUR\nSelbstbeteiligung: 500 EUR je Schadenfall\nJahresbeitrag: 1.200,00 EUR\nVertragsbeginn: 01.01.2027\nLaufzeit: 1 Jahr, Verlängerung um jeweils 1 Jahr`,
  'P2-D Versicherungsschein': `${ALLIANZ}\nVersicherungsschein\nNr. VS-998877\nVersicherer: ${ALLIANZ}\nVersicherungsnehmer: ${OWN}\nVersicherungssumme: 5.000.000 EUR\nSelbstbeteiligung: 500 EUR\nBeitrag: 1.200,00 EUR jährlich\nBeginn: 01.01.2027`,
} as const;

describe('02A-1 Nacharbeit 1 — Versicherungs-Bestandskommunikation ist kein Vertrag', () => {
  it.each(Object.entries(BESTAND))('%s: keine Vertragswahrheit, kein Vorschlag, keine Vertragsaktion', async (_label, text) => {
    const { item, workflow, summary } = await intake(text);
    expect(item.classifiedKind).toBe('versicherung');
    // Die falsche Vertragsintelligenz selbst ist weg — nicht nur der Vorschlag.
    expect(workflow.contractIntelligence).toBeNull();
    expect(workflow.contractOrderProposal).toBeNull();
    const interpretation = workflow.businessInterpretation;
    expect(interpretation?.contractFamily).toBeUndefined();
    expect((interpretation?.effects ?? []).map((effect) => effect.kind)).not.toContain('contract');
    expect(interpretation?.meaning.summary ?? '').not.toMatch(/Vertragsdokument/);
    expect(summary.family).not.toBe('contract');
    expect(summary.primaryAction.id).not.toBe('accept_contract_order');
    // P1-1 bleibt: der Versicherer ist Absender.
    expect(item.sender).toBe(ALLIANZ);
  });

  it.each(Object.entries(VERTRAGSDOKUMENT))('%s: echtes Vertragsdokument bleibt Vertrag', async (_label, text) => {
    const { item, workflow, summary } = await intake(text);
    expect(['versicherung', 'betriebshaftpflicht']).toContain(item.classifiedKind);
    expect(workflow.contractIntelligence?.contractType.family).toBe('versicherungsvertrag');
    expect(workflow.contractIntelligence?.contractType.confidence).toBe('high');
    expect(workflow.businessInterpretation?.contractFamily).toBe('versicherungsvertrag');
    expect(workflow.contractOrderProposal).not.toBeNull();
    expect(summary.family).toBe('contract');
    expect(summary.primaryAction.id).toBe('accept_contract_order');
    expect(item.sender).toBe(ALLIANZ);
  });

  it('Vorschau-Pfad mit eigener Intelligenz nutzt denselben Gate', async () => {
    const { item } = await intake(BESTAND['P2-B Deckungsinformation']);
    // Ungegatete Intelligenz aus dem reinen Text erkennt Rollen + Themen …
    const raw = analyzeContractIntelligenceFromText(BESTAND['P2-B Deckungsinformation']);
    expect(raw).not.toBeNull();
    // … der Vorschlag entsteht trotzdem nicht.
    expect(admitsContractIntelligenceForKind(item.classifiedKind, raw)).toBe(false);
    expect(buildContractOrderProposal(item, raw)).toBeNull();

    const contract = await intake(VERTRAGSDOKUMENT['P2-C Versicherungsvertrag']);
    const rawContract = analyzeContractIntelligenceFromText(VERTRAGSDOKUMENT['P2-C Versicherungsvertrag']);
    expect(buildContractOrderProposal(contract.item, rawContract)).not.toBeNull();
  });

  it('Gate gilt nur für Behörden-/Versicherungsarten — andere Vertragsarten unverändert', () => {
    const raw = analyzeContractIntelligenceFromText(BESTAND['P2-B Deckungsinformation']);
    expect(admitsContractIntelligenceForKind('werkvertrag', raw)).toBe(true);
    expect(admitsContractIntelligenceForKind(undefined, raw)).toBe(true);
    expect(admitsContractIntelligenceForKind('versicherung', raw)).toBe(false);
  });

  it('Titel-Evidenz: nur eine echte Titelzeile ist Versicherungs-Überschrift', () => {
    const heading = (text: string) => detectContractType(text).evidence.includes('heading:versicherungsvertrag');
    expect(heading('Versicherungsvertrag Betriebshaftpflicht')).toBe(true);
    expect(heading('Allianz\nVersicherungsvertrag\nVersicherer: Allianz')).toBe(true);
    expect(heading('Allianz\nVersicherungsschein\nNr. 123456')).toBe(true);
    for (const notATitle of [
      'Zu Ihrem Versicherungsvertrag teilen wir Ihnen mit, dass sich nichts ändert.',
      'Betreff: Ihr Versicherungsvertrag VS-998877',
      'Kündigungsbestätigung zu Ihrem Versicherungsvertrag',
      'Versicherungsvertrag VS-998877',
      'Versicherungsvertrag Nr. 4711',
      'Versicherungsschein-Nr.: 123456',
      'Versicherungsvertrag und Beitrag bleiben unverändert.',
      'Anbei erhalten Sie Ihren Versicherungsschein.',
    ]) {
      expect(heading(`Allianz\n${notATitle}`), notATitle).toBe(false);
    }
  });
});

/*
 * EINGANG-02A-1 Nacharbeit 2 — Behörden- und Versicherungsschreiben, die einen
 * anderen Vertrag nur erwähnen oder anfordern, sind kein Vertrag. Echte
 * Verträge mit Titelzeile bleiben Vertrag — auch mit Stadt oder Behörde als
 * Partei.
 */
const ERWAEHNUNG = {
  'X1 Haftpflicht erwähnt Werkvertrag': `${ALLIANZ}\nSchadennummer: S-2026-0081\n${TO}\nZu Ihrer Betriebshaftpflicht: Ihr Auftraggeber, die Wohnbau Nord GmbH, macht Schadenersatzansprüche aus dem Werkvertrag vom 01.03.2026 geltend. Der Wasserschaden entstand im Zusammenhang mit Arbeiten aus dem Werkvertrag auf der Baustelle Werkstraße 1.\nBitte senden Sie uns bis zum 31.10.2026 eine Stellungnahme.`,
  'X2 BG BAU fordert Subunternehmervertrag an': `Berufsgenossenschaft der Bauwirtschaft\nMitgliedsnummer: 123456789\n${TO}\nPrüfung der Nachunternehmerhaftung\nBitte reichen Sie den Subunternehmervertrag mit der Fliesen Kaya GmbH sowie die Unbedenklichkeitsbescheinigung für die Baustelle Werkstraße 1 bis zum 31.10.2026 ein.`,
  'X2b BG BAU fragt nach Subunternehmern': `Berufsgenossenschaft der Bauwirtschaft\nMitgliedsnummer: 123456789\n${TO}\nPrüfung der Nachunternehmerhaftung\nBitte nennen Sie uns alle Subunternehmer, die Sie 2026 auf der Baustelle Werkstraße 1 eingesetzt haben.`,
  'X3 Finanzamt fordert Mietvertrag an': `Finanzamt Musterstadt\nSteuernummer 12/345/67890\n${TO}\nAnfrage zur Umsatzsteuer 2025\nBitte reichen Sie den Mietvertrag für die Lagerhalle ein. Vermieter ist laut Ihren Angaben die Hallenbau KG, die Kaltmiete beträgt 1.200,00 EUR monatlich, Mietbeginn war der 01.01.2025.\nFrist: 31.10.2026`,
  'X4 Kfz-Versicherung erwähnt Leasingvertrag': `${ALLIANZ}\n${TO}\nIhre Kfz-Versicherung B-MS 1234\nZu Ihrem Leasingvertrag teilen wir Ihnen mit: Für das Fahrzeug besteht eine Vollkaskopflicht. Leasinggeber ist die Auto Leasing GmbH. Die Leasingrate ist nicht Teil Ihres Beitrags.`,
  'X5 Bauamt fordert Bauvertrag an': `Stadt Musterstadt - Bauordnungsamt\nAktenzeichen: BA-2026-200\n${TO}\nIm Rahmen der Bauüberwachung bitten wir um Vorlage des Bauvertrags zwischen dem Bauherrn als Auftraggeber und Ihnen als Auftragnehmer für das Bauvorhaben Werkstraße 1.`,
} as const;

const INSTITUTIONELLER_VERTRAG = {
  'Y1 Mietvertrag der Stadt': {
    family: 'mietvertrag',
    text: `Stadt Musterstadt - Bauamt\nRathausplatz 1, 10115 Musterstadt\nMIETVERTRAG\nzwischen der Stadt Musterstadt, vertreten durch das Bauamt (Vermieter)\nund ${OWN}, Handwerkerweg 7, 10115 Berlin (Mieter)\nMietobjekt: Lagerhalle Hafenstraße 3, 400 qm\nMietbeginn: 01.01.2027\nKaltmiete: 1.200,00 EUR monatlich zzgl. Nebenkosten\nKaution: 3.600,00 EUR`,
  },
  'Y2 Werkvertrag des Hochbauamts': {
    family: 'werkvertrag',
    text: `Stadt Musterstadt - Hochbauamt\nRathausplatz 1, 10115 Musterstadt\nWERKVERTRAG\nAuftraggeber: Stadt Musterstadt, Hochbauamt\nAuftragnehmer: ${OWN}, Handwerkerweg 7, 10115 Berlin\nBauvorhaben: Sanierung Sanitäranlagen Grundschule Nord\nLeistungsgegenstand: Erneuerung der Sanitärinstallation gemäß Leistungsverzeichnis\nBaustelle: Schulweg 5, 10115 Musterstadt\nVergütung: 48.000,00 EUR netto\nAusführungsfrist: 01.03.2027 bis 30.06.2027`,
  },
  'Y3 Bauvertrag des Bauordnungsamts': {
    family: 'werkvertrag',
    text: `Stadt Musterstadt - Bauordnungsamt\nRathausplatz 1, 10115 Musterstadt\nBauvertrag\nAuftraggeber: Stadt Musterstadt\nAuftragnehmer: ${OWN}, Handwerkerweg 7, 10115 Berlin\nBauvorhaben: Erneuerung der Sanitäranlagen im Rathaus\nGewerk: Sanitär\nBaustelle: Rathausplatz 1, 10115 Musterstadt\nVergütung: 12.000,00 EUR netto`,
  },
} as const;

const CONTRACT_KINDS = ['werkvertrag', 'subunternehmervertrag', 'nachunternehmervertrag', 'leasingvertrag', 'mietvertrag'];

describe('02A-1 Nacharbeit 2 — erwähnte Verträge machen kein Behörden-/Versicherungsschreiben zum Vertrag', () => {
  it.each(Object.entries(ERWAEHNUNG))('%s: bleibt Behörden-/Versicherungsschreiben ohne jede Vertragswahrheit', async (_label, text) => {
    const { item, workflow, summary } = await intake(text);
    expect(CONTRACT_KINDS).not.toContain(item.classifiedKind);
    expect(item.documentType).toBe('behoerde');
    expect(workflow.contractIntelligence).toBeNull();
    expect(workflow.contractAnalysis).toBeNull();
    expect(workflow.contractOrderProposal).toBeNull();
    const interpretation = workflow.businessInterpretation;
    expect(interpretation?.contractFamily).toBeUndefined();
    expect((interpretation?.effects ?? []).map((effect) => effect.kind)).not.toContain('contract');
    expect(summary.family).not.toBe('contract');
    expect(summary.primaryAction.id).not.toBe('accept_contract_order');
    expect((workflow.nextActions ?? []).map((action) => action.id)).not.toContain('create_vorgang');
  });

  it.each(Object.entries(INSTITUTIONELLER_VERTRAG))('%s: echter Vertrag mit Titelzeile bleibt Vertrag', async (_label, { family, text }) => {
    const { workflow, summary } = await intake(text);
    expect(workflow.contractIntelligence?.contractType.family).toBe(family);
    expect(workflow.contractIntelligence?.contractType.titleEvidence).toBe(true);
    expect(workflow.businessInterpretation?.contractFamily).toBe(family);
    expect(workflow.contractOrderProposal).not.toBeNull();
    expect(summary.family).toBe('contract');
    expect(summary.primaryAction.id).toBe('accept_contract_order');
  });

  it('Y1/Y3: institutionelle Art bleibt, Vertrag wird über die Titelzeile zugelassen', async () => {
    const y1 = await intake(INSTITUTIONELLER_VERTRAG['Y1 Mietvertrag der Stadt'].text);
    expect(y1.item.documentType).toBe('behoerde');
    const y3 = await intake(INSTITUTIONELLER_VERTRAG['Y3 Bauvertrag des Bauordnungsamts'].text);
    expect(y3.item.documentType).toBe('behoerde');
    expect(y3.workflow.contractAnalysis?.isContract).toBe(true);
  });

  it('Titelwahrheit je Familie: Titelzeile ja, Erwähnung nein', () => {
    const cases: Array<[Parameters<typeof hasContractFamilyTitle>[1], string, string]> = [
      ['mietvertrag', 'MIETVERTRAG', 'Bitte reichen Sie den Mietvertrag ein.'],
      ['leasingvertrag', 'Leasingvertrag', 'Zu Ihrem Leasingvertrag teilen wir Ihnen mit, dass sich nichts ändert'],
      ['werkvertrag', 'WERKVERTRAG', 'Die Arbeiten erfolgten aus dem Werkvertrag.'],
      ['werkvertrag', 'Bauvertrag', 'Wir bitten um Vorlage des Bauvertrags'],
      ['subunternehmervertrag', 'Subunternehmervertrag', 'Wir benötigen den Subunternehmervertrag.'],
      ['subunternehmervertrag', 'Bau-Subunternehmervertrag', 'Prüfung: Subunternehmervertrag fehlt'],
      ['kaufvertrag', 'Kaufvertrag über ein Firmenfahrzeug', 'Laut Kaufvertrag gilt Eigentumsvorbehalt'],
      ['liefervertrag', 'Liefervertrag', 'Ihr Liefervertrag Nr. 4711'],
      ['wartungsvertrag', 'Wartungsvertrag Heizungsanlage', 'Ihr Wartungsvertrag läuft aus.'],
      ['rahmenvertrag', 'Rahmenvertrag', 'Sehr geehrte Damen und Herren,\nRahmenvertrag Nr. 12'],
      ['versicherungsvertrag', 'Versicherungsvertrag', 'Zu Ihrem Versicherungsvertrag teilen wir mit'],
    ];
    for (const [family, title, mention] of cases) {
      expect(hasContractFamilyTitle(`Absender\n${title}\nInhalt`, family), title).toBe(true);
      expect(hasContractFamilyTitle(`Absender\n${mention}\nInhalt`, family), mention).toBe(false);
    }
  });

  it('titleEvidence ist eigene Wahrheit — unabhängig vom gekürzten evidence-Array', () => {
    // Vier frühere Familien füllen die acht Evidenz-Plätze; die Miet-Überschrift fällt heraus.
    const text = 'Stadt Musterstadt\nMIETVERTRAG\nVermieter: Stadt Musterstadt\nKaltmiete: 900 EUR\nSubunternehmer sind nicht zugelassen. Baustelle entfällt.\nAuftraggeber und Kunde vereinbaren ein Wartungsintervall und eine Pauschale.';
    const type = detectContractType(text);
    expect(type.family).toBe('mietvertrag');
    expect(type.evidence).not.toContain('heading:mietvertrag');
    expect(type.titleEvidence).toBe(true);
    // Erwähnung: hohe Sicherheit, aber keine Titelzeile.
    const mention = detectContractType(ERWAEHNUNG['X3 Finanzamt fordert Mietvertrag an']);
    expect(mention.family).toBe('mietvertrag');
    expect(mention.confidence).toBe('high');
    expect(mention.titleEvidence).toBe(false);
  });

  it('Klassifikation: Vertragserwähnung im Behördenbrief bleibt Behörde, echter Vertrag und Upload-Hinweis unverändert', () => {
    const kind = (recognizedText: string, kindHint?: 'werkvertrag') =>
      detectClassifiedKindWithReason({ sourceFileName: 'x.pdf', recognizedText, kindHint }).kind;
    expect(kind(ERWAEHNUNG['X1 Haftpflicht erwähnt Werkvertrag'])).toBe('versicherung');
    expect(kind(ERWAEHNUNG['X2 BG BAU fordert Subunternehmervertrag an'])).toBe('bg_bau');
    expect(kind(INSTITUTIONELLER_VERTRAG['Y2 Werkvertrag des Hochbauamts'].text)).toBe('werkvertrag');
    expect(kind(`Müller Bau GmbH\n${TO}\nWerkvertrag\nAuftraggeber: ${OWN}\nBaustelle Werkstraße 1`)).toBe('werkvertrag');
    expect(kind(ERWAEHNUNG['X1 Haftpflicht erwähnt Werkvertrag'], 'werkvertrag')).toBe('werkvertrag');
  });
});

/*
 * EINGANG-02A-1 Nacharbeit 3 — die Schutzwahrheit ist der institutionelle
 * Briefkopf, nicht nur die Dokumentart. Frühere Katalogregeln
 * (Abnahmeprotokoll, Arbeitsvertrag, Freistellungsbescheinigung) und
 * Briefköpfe ohne Katalogart („Stadt Musterstadt", „LVM Versicherung") dürfen
 * keinen Vertragsworkflow mehr auslösen.
 */
const BRIEFKOPF = {
  'Z1 Versicherung fordert Abnahmeprotokoll': `${ALLIANZ}\nSchadennummer: S-2026-0090\n${TO}\nZu Ihrem Haftpflichtschaden auf der Baustelle Werkstraße 1: Bitte senden Sie uns das Abnahmeprotokoll Ihrer Arbeiten aus dem Werkvertrag sowie Ihre Rechnung an den Auftraggeber, die Wohnbau Nord GmbH, für das Bauvorhaben Werkstraße 1 bis zum 31.10.2026.`,
  'Z2 Lebensversicherung (bAV) erwähnt Arbeitsvertrag': `Allianz Lebensversicherungs-AG\n${TO}\nDirektversicherung für Ihren Arbeitnehmer Herrn Max Weber\nGemäß Arbeitsvertrag und Entgeltumwandlungsvereinbarung zahlt der Arbeitgeber einen Beitrag von 150,00 EUR monatlich. Eintrittsdatum des Arbeitnehmers: 01.04.2024. Bitte prüfen Sie die Angaben.`,
  'Z4 Finanzamt Bauabzugsteuer': `Finanzamt Musterstadt\nSteuernummer 12/345/67890\n${TO}\nBauabzugsteuer\nBitte reichen Sie für das Bauvorhaben Werkstraße 1 das Abnahmeprotokoll und die Freistellungsbescheinigung Ihres Auftraggebers ein. Baustelle: Werkstraße 1.`,
  'Z5 LVM Versicherung ohne Rechtsform': `LVM Versicherung\n${TO}\nZu Ihrer Betriebshaftpflicht: Ihr Auftraggeber, die Wohnbau Nord GmbH, macht Ansprüche aus dem Werkvertrag vom 01.03.2026 geltend. Der Schaden entstand auf der Baustelle Werkstraße 1.`,
  'Z7 Stadt ohne Amtsbezeichnung': `Stadt Musterstadt\nRathausplatz 1\n${TO}\nSehr geehrte Damen und Herren, für das Bauvorhaben Schulweg 5 bitten wir um Vorlage des Werkvertrags zwischen dem Auftraggeber und Ihnen als Auftragnehmer. Baustelle Schulweg 5.`,
} as const;

const OHNE_INSTITUTION = {
  'Z10 Firmenvertrag': `Wohnbau Nord GmbH\nIndustriestraße 5, 20095 Hamburg\nWerkvertrag Nr. 2026-14\nAuftraggeber: Wohnbau Nord GmbH\nAuftragnehmer: ${OWN}\nBauvorhaben: Wohnanlage Werkstraße 1\nBaustelle: Werkstraße 1\nVergütung: 48.000,00 EUR netto`,
  'Z10b Firmenvertrag, Stadt/Versicherung/Finanzamt nur im Text': `Wohnbau Nord GmbH\nIndustriestraße 5, 20095 Hamburg\nWerkvertrag Nr. 2026-15\nAuftraggeber: Wohnbau Nord GmbH\nAuftragnehmer: ${OWN}\nBauvorhaben: Kita Sonnenschein\nLeistungsort: Stadt Musterstadt, Kitaweg 2\nBaustelle: Kitaweg 2\nDer Auftragnehmer weist die Betriebshaftpflicht nach; der Nachweis ist der Versicherung vorzulegen.\nFinanzamt-Freistellungsbescheinigung nach § 48b EStG ist beizufügen.\nVergütung: 36.000,00 EUR netto`,
  'EIGEN eigener Vertrag an die Stadt': `${TO}\nStadt Musterstadt\nRathausplatz 1\nWerkvertrag Nr. 2026-20\nAuftraggeber: Stadt Musterstadt\nAuftragnehmer: ${OWN}\nBauvorhaben: Sanitär Rathaus\nBaustelle: Rathausplatz 1\nVergütung: 9.000,00 EUR netto`,
} as const;

const INSTITUTIONELL_MIT_TITEL = {
  'Z8 Werkvertrag Nr. 2026-14 des Hochbauamts': {
    kind: 'werkvertrag',
    text: `Stadt Musterstadt - Hochbauamt\nRathausplatz 1, 10115 Musterstadt\nWerkvertrag Nr. 2026-14\nAuftraggeber: Stadt Musterstadt, Hochbauamt\nAuftragnehmer: ${OWN}, Handwerkerweg 7, 10115 Berlin\nBauvorhaben: Sanierung Sanitäranlagen Grundschule Nord\nLeistungsgegenstand: Erneuerung der Sanitärinstallation\nBaustelle: Schulweg 5, 10115 Musterstadt\nVergütung: 48.000,00 EUR netto`,
  },
  'Z9 Bauvertrag (VOB/B) des Hochbauamts': {
    kind: 'bauamt',
    text: `Stadt Musterstadt - Hochbauamt\nRathausplatz 1, 10115 Musterstadt\nBauvertrag (VOB/B)\nVergabenummer: 2026-14\nAuftraggeber: Stadt Musterstadt, Hochbauamt\nAuftragnehmer: ${OWN}, Handwerkerweg 7, 10115 Berlin\nBauvorhaben: Sanierung Sanitäranlagen Grundschule Nord\nBaustelle: Schulweg 5, 10115 Musterstadt\nVergütung: 48.000,00 EUR netto`,
  },
} as const;

describe('02A-1 Nacharbeit 3 — institutioneller Briefkopf ist gemeinsame Schutzwahrheit', () => {
  it.each(Object.entries(BRIEFKOPF))('%s: kein Vertragsworkflow über den echten Pfad', async (_label, text) => {
    expect(hasInstitutionalLetterhead(text)).toBe(true);
    const { item, workflow, summary } = await intake(text);
    expect(CONTRACT_KINDS).not.toContain(item.classifiedKind);
    expect(['abnahmeprotokoll', 'arbeitsvertrag']).not.toContain(item.classifiedKind);
    expect(workflow.contractIntelligence).toBeNull();
    expect(workflow.contractAnalysis).toBeNull();
    expect(workflow.contractOrderProposal).toBeNull();
    const interpretation = workflow.businessInterpretation;
    expect(interpretation?.contractFamily).toBeUndefined();
    expect((interpretation?.effects ?? []).map((effect) => effect.kind)).not.toContain('contract');
    expect(['possible_new_business_case', 'acceptance_recorded', 'business_case_update']).not.toContain(
      interpretation?.meaning.eventType,
    );
    expect(summary.family).not.toBe('contract');
    expect(summary.primaryAction.id).not.toBe('accept_contract_order');
    expect((workflow.nextActions ?? []).map((action) => action.id)).not.toContain('create_vorgang');
  });

  it('Z5/Z7: Briefkopf ohne Katalogtreffer der Senderextraktion wird trotzdem erkannt', async () => {
    const z5 = await intake(BRIEFKOPF['Z5 LVM Versicherung ohne Rechtsform']);
    expect(z5.item.classifiedKind).toBe('versicherung');
    // Der institutionelle Briefkopf ist Absender — weder die eigene Firma noch die Firma aus dem Fließtext.
    expect(z5.item.sender).toBe('LVM Versicherung');
    expect(z5.shownSender).toBe('LVM Versicherung');
    expect((await intake(BRIEFKOPF['Z7 Stadt ohne Amtsbezeichnung'])).item.classifiedKind).toBe('brief');
  });

  it.each(Object.entries(OHNE_INSTITUTION))('%s: kein institutioneller Briefkopf — Vertrag bleibt voll positiv', async (_label, text) => {
    expect(hasInstitutionalLetterhead(text)).toBe(false);
    const { item, workflow, summary } = await intake(text);
    expect(item.classifiedKind).toBe('werkvertrag');
    expect(workflow.contractIntelligence?.contractType.family).toBe('werkvertrag');
    expect(workflow.contractOrderProposal).not.toBeNull();
    expect(summary.primaryAction.id).toBe('accept_contract_order');
  });

  it.each(Object.entries(INSTITUTIONELL_MIT_TITEL))('%s: institutioneller Briefkopf mit Vertragstitel bleibt Vertrag', async (_label, { kind, text }) => {
    expect(hasInstitutionalLetterhead(text)).toBe(true);
    const { item, workflow, summary } = await intake(text);
    expect(item.classifiedKind).toBe(kind);
    expect(workflow.contractIntelligence?.contractType.titleEvidence).toBe(true);
    expect(workflow.contractAnalysis?.isContract).toBe(true);
    expect(workflow.contractOrderProposal).not.toBeNull();
    expect(summary.primaryAction.id).toBe('accept_contract_order');
  });

  it('echtes Abnahmeprotokoll einer Stadt (Titelzeile) bleibt Abnahmeprotokoll', async () => {
    const { item } = await intake(
      `Stadt Musterstadt - Hochbauamt\nRathausplatz 1, 10115 Musterstadt\nAbnahmeprotokoll\nBauvorhaben: Sanierung Sanitäranlagen Grundschule Nord\nAuftraggeber: Stadt Musterstadt\nAuftragnehmer: ${OWN}\nAbnahmetermin: 30.06.2027\nDie Leistung wird ohne wesentliche Mängel abgenommen.`,
    );
    expect(item.classifiedKind).toBe('abnahmeprotokoll');
  });

  it('eigenes Schreiben an eine Institution ist kein institutioneller Fremdbrief', async () => {
    const eigen = `${TO}\nLVM Versicherung\nSchadenabteilung\nSchadenmeldung zur Betriebshaftpflicht\nBei Arbeiten aus dem Werkvertrag mit der Wohnbau Nord GmbH entstand auf der Baustelle Werkstraße 1 ein Wasserschaden.`;
    expect(hasInstitutionalLetterhead(eigen)).toBe(false);
    const { item } = await intake(eigen);
    expect(item.classifiedKind).not.toBe('versicherung');
    expect(item.sender).toBe(OWN);
  });

  it('Briefkopf-Wahrheit: nur Kopfzeile und ausdrücklicher Absender-Hinweis, nie Fließtext oder eigene Firma', () => {
    const body = `Müller Haustechnik GmbH\nBaustelle der Stadt Musterstadt. Nachweis für die Versicherung vorlegen. Finanzamt informiert.`;
    expect(hasInstitutionalLetterhead(body)).toBe(false);
    expect(hasInstitutionalLetterhead(body, { senderHint: 'Finanzamt Musterstadt' })).toBe(true);
    expect(hasInstitutionalLetterhead(body, { senderHint: OWN })).toBe(false);
    for (const letterhead of ['Gemeinde Musterdorf', 'Landkreis Musterland', 'Kreis Lippe - Der Landrat', 'Landratsamt Musterkreis', 'Bezirksamt Mitte', 'HDI Versicherung', 'Berufsgenossenschaft der Bauwirtschaft']) {
      expect(hasInstitutionalLetterhead(`${letterhead}\n${TO}\nText`), letterhead).toBe(true);
    }
    // Eigene Firma in der Kopfzeile: auch ein Empfänger „Stadt Musterstadt" darunter macht keinen Fremdbrief.
    expect(hasInstitutionalLetterhead(`${OWN}\nStadt Musterstadt\nRathausplatz 1`)).toBe(false);
  });

  it('Vertragstitel mit Nummer: Vertragsdokument ja, Brief-Betreff nein, Versicherung streng', () => {
    expect(
      hasContractFamilyTitle('Stadt Musterstadt\nWerkvertrag Nr. 2026-14\nAuftraggeber: Stadt\nAuftragnehmer: Musterbau GmbH', 'werkvertrag'),
    ).toBe(true);
    expect(
      hasContractFamilyTitle('Stadt Musterstadt\nWerkvertrag Nr. 2026-14\nSehr geehrte Damen und Herren,\nbitte senden Sie …', 'werkvertrag'),
    ).toBe(false);
    expect(hasContractFamilyTitle('Allianz\nVersicherungsvertrag Nr. 4711\nVersicherer: Allianz', 'versicherungsvertrag')).toBe(false);
  });
});

/*
 * EINGANG-02A-1 Nacharbeit 4 — ein Vertragstitel mit direkter Nummer
 * („Werkvertrag Nr. 2026-14") ist in einem Brief nur ein Betreff. Als Titel
 * zählt er allein mit Vertragsstruktur: mindestens zwei beschriftete Parteien
 * der vorhandenen PARTY_PATTERNS — unabhängig von Anrede oder Grußformel.
 */
const NUMMERN_BETREFF = {
  'N5 Hochbauamt-Formschreiben ohne Anrede': `Stadt Musterstadt - Hochbauamt\n${TO}\nWerkvertrag Nr. 2026-14\nAufforderung zur Mängelbeseitigung\nDer Auftraggeber fordert Sie auf, die Mängel an der Baustelle Schulweg 5 bis zum 30.10.2026 zu beseitigen.`,
  'N6 Versicherung knapp ohne Anrede': `${ALLIANZ}\nSchadennummer: S-2026-0099\n${TO}\nWerkvertrag Nr. 2026-14\nIhr Auftraggeber macht Ansprüche wegen eines Wasserschadens auf der Baustelle Werkstraße 1 geltend. Wir prüfen den Vorgang.`,
  'N7 Versicherung „Guten Tag" / „Freundliche Grüße"': `${ALLIANZ}\nSchadennummer: S-2026-0099\n${TO}\nWerkvertrag Nr. 2026-14 – Wasserschaden Werkstraße 1\nGuten Tag Herr Mustermann,\nIhr Auftraggeber, die Wohnbau Nord GmbH, macht Ansprüche wegen eines Wasserschadens auf der Baustelle Werkstraße 1 geltend. Wir prüfen den Vorgang und melden uns.\nFreundliche Grüße\nIhre Allianz`,
  'N8 Hochbauamt „Guten Tag" / „Freundliche Grüße"': `Stadt Musterstadt - Hochbauamt\n${TO}\nWerkvertrag Nr. 2026-14 – Sanierung Grundschule Nord\nGuten Tag,\nder Auftraggeber bittet um Vorlage des Bauzeitenplans für die Baustelle Schulweg 5.\nFreundliche Grüße\nIm Auftrag`,
} as const;

describe('02A-1 Nacharbeit 4 — Vertragstitel mit Nummer nur mit Vertragsstruktur', () => {
  it.each(Object.entries(NUMMERN_BETREFF))('%s: Betreff mit Vertragsnummer macht keinen neuen Vertrag', async (_label, text) => {
    expect(hasContractFamilyTitle(text, 'werkvertrag')).toBe(false);
    const { item, workflow, summary } = await intake(text);
    expect(CONTRACT_KINDS).not.toContain(item.classifiedKind);
    expect(item.documentType).toBe('behoerde');
    expect(workflow.contractIntelligence).toBeNull();
    expect(workflow.contractAnalysis).toBeNull();
    expect(workflow.contractOrderProposal).toBeNull();
    const interpretation = workflow.businessInterpretation;
    expect(interpretation?.contractFamily).toBeUndefined();
    expect((interpretation?.effects ?? []).map((effect) => effect.kind)).not.toContain('contract');
    expect(interpretation?.meaning.eventType).not.toBe('possible_new_business_case');
    expect(summary.family).not.toBe('contract');
    expect(summary.primaryAction.id).not.toBe('accept_contract_order');
    expect((workflow.nextActions ?? []).map((action) => action.id)).not.toContain('create_vorgang');
  });

  it('Grenzen der Strukturbedingung (PARTY_PATTERNS-Zeilen)', () => {
    const titled = (body: string) => hasContractFamilyTitle(`Stadt Musterstadt - Hochbauamt\nWerkvertrag Nr. 12\n${body}`, 'werkvertrag');
    // A: ohne Parteienstruktur
    expect(titled('Bauvorhaben: Grundschule Nord\nBaustelle: Schulweg 5')).toBe(false);
    // B: nur eine beschriftete Partei
    expect(titled('Auftraggeber: Stadt Musterstadt\nBaustelle: Schulweg 5')).toBe(false);
    // C: zwei beschriftete Parteien
    expect(titled('Auftraggeber: Stadt Musterstadt\nAuftragnehmer: Musterbau GmbH')).toBe(true);
    // D: Brief mit zwei Firmennamen im Fließtext, aber ohne Beschriftung
    expect(titled('Guten Tag,\nzwischen der Stadt Musterstadt und der Musterbau GmbH besteht der Vertrag weiter.\nFreundliche Grüße')).toBe(false);
    // Prosa mit Rollenwort ohne Zeilenbeschriftung zählt nicht
    expect(titled('Ihr Auftraggeber: laut Akte die Stadt.\nDer Auftragnehmer ist informiert.')).toBe(false);
    // E: Versicherungsregel bleibt streng
    expect(
      hasContractFamilyTitle('Allianz\nVersicherungsschein-Nr.: 123456\nVersicherer: Allianz\nVersicherungsnehmer: Musterbau GmbH', 'versicherungsvertrag'),
    ).toBe(false);
    // Titel ohne direkte Nummer bleiben unverändert Titel — auch ohne Parteien.
    expect(hasContractFamilyTitle('Stadt\nWERKVERTRAG\nBaustelle: Schulweg 5', 'werkvertrag')).toBe(true);
    expect(hasContractFamilyTitle('Stadt\nBauvertrag (VOB/B)\nVergabenummer: 2026-14', 'werkvertrag')).toBe(true);
  });

  it('weitere Familie: Mietvertrag mit Nummer braucht Vermieter UND Mieter — eine Zeile zählt nur einmal', () => {
    const miet = (body: string) => hasContractFamilyTitle(`Stadt Musterstadt\nMietvertrag Nr. 2027-03\n${body}`, 'mietvertrag');
    expect(miet('Vermieter: Stadt Musterstadt\nMieter: Musterbau GmbH')).toBe(true);
    // „Vermieter:" trifft auch das Muster „mieter" — bleibt trotzdem eine Partei.
    expect(miet('Vermieter: Stadt Musterstadt\nMietobjekt: Lagerhalle')).toBe(false);
    expect(hasContractFamilyTitle('Absender\nKaufvertrag Nr. 7\nVerkäufer: Autohaus Nord GmbH\nKäufer: Musterbau GmbH', 'kaufvertrag')).toBe(true);
  });
});

describe('02A-1 — 01C-Zuordnung unverändert', () => {
  it('I: eigene AU-Nummer ordnet weiterhin exakt zu', async () => {
    const { summary } = await intake(TEXT.I);
    expect(summary.caseMatch?.matchStatus).toBe('exact');
    expect(summary.caseMatch?.candidates[0]?.caseId).toBe('v-au');
  });

  it('J: fremdes Aktenzeichen erzeugt keinen eigenen Vorgang', async () => {
    const { item, workflow, summary } = await intake(TEXT.J);
    expect(summary.caseMatch?.matchStatus ?? 'none').toBe('none');
    expect(item.vorgangId).toBeUndefined();
    expect(workflow.suggestedVorgang ?? null).toBeNull();
  });
});
