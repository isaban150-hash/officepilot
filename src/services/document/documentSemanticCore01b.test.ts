/**
 * DOKUMENTVERSTAENDNIS-01B — die Zusagen, die sich in der Oberfläche (noch)
 * nicht ablesen lassen.
 *
 * Betreff, Betrag und Frist sind in der App sichtbar geprüft. Anliegen,
 * Pflichten, die vollständige Fristliste und die Kunden-/Auftragskandidaten
 * liegen in 01B bewusst noch ohne Anzeige im Datenkern — sie sind nur hier
 * belegbar. Dazu die Buchungsschranke, deren gefährlichste Fälle man nicht
 * durch Ausprobieren in einer echten Buchhaltung prüfen möchte.
 *
 * Alle Texte sind frei erfunden.
 */
import { describe, expect, it } from 'vitest';
import {
  buildDocumentSemanticCore,
  resolvePrimaryClaimAmount,
} from './documentSemanticCoreService';
import { findSemanticPartyCandidates } from './documentSemanticPartyMatchService';
import { resolveAccountingGate } from './documentAccountingGateService';
import type { CompanyProfile, Customer, Vorgang } from '../../types/models';

const PROFIL = {
  companyName: 'Beispiel Haustechnik GmbH',
  street: 'Bahnhofstrasse 12',
  zip: '32105',
  city: 'Bad Salzuflen',
  taxNumber: '000/000/00000',
} as unknown as CompanyProfile;

const MAENGELANZEIGE = [
  'Westfalen Projektbau GmbH',
  'Industriestrasse 27, 33689 Bielefeld',
  '',
  'Beispiel Haustechnik GmbH',
  'Bahnhofstrasse 12',
  '32105 Bad Salzuflen',
  '',
  'Bielefeld, 12.09.2026',
  '',
  'Maengelanzeige - Bauvorhaben Gewerbepark Senne, Gebaeude B',
  '',
  'Sehr geehrte Damen und Herren,',
  '',
  'bei der Begehung am 11.09.2026 haben wir Maengel festgestellt.',
  'Wir fordern Sie auf, die Maengel bis zum 30.09.2026 zu beseitigen.',
  'Bitte bestaetigen Sie uns bis zum 22.09.2026 einen Begehungstermin.',
  'Bis zur vollstaendigen Maengelbeseitigung behalten wir von der Schlussrechnung einen Betrag von 5.000,00 EUR ein.',
  'Eine Zahlung Ihrerseits ist nicht zu leisten.',
].join('\n');

const MAHNUNG = [
  'Muster Baustoffe GmbH',
  '',
  'Beispiel Haustechnik GmbH',
  'Bahnhofstrasse 12',
  '32105 Bad Salzuflen',
  '',
  'Halle, 05.09.2026',
  '',
  '2. Mahnung zur Rechnung MB-2026-4471',
  '',
  'Sehr geehrte Damen und Herren,',
  '',
  'trotz unserer Zahlungserinnerung vom 22.08.2026 konnten wir keinen Zahlungseingang feststellen.',
  'Die Rechnung MB-2026-4471 ueber 4.286,50 EUR ist seit dem 27.08.2026 faellig.',
  'Wir fordern Sie auf, den Betrag zuzueglich Mahngebuehren von 5,00 EUR, insgesamt also 4.291,50 EUR, bis zum 19.09.2026 zu ueberweisen.',
].join('\n');

const FREISTELLUNG = [
  'Finanzamt Musterstadt',
  '',
  'Beispiel Haustechnik GmbH',
  'Bahnhofstrasse 12',
  '32105 Bad Salzuflen',
  '',
  'Musterstadt, 01.09.2026',
  '',
  'Freistellungsbescheinigung nach Paragraf 48b EStG',
  '',
  'Sehr geehrte Damen und Herren,',
  '',
  'auf Ihren Antrag vom 18.08.2026 erteilen wir Ihnen die Freistellungsbescheinigung.',
  'Die Bescheinigung gilt vom 01.09.2026 bis zum 31.08.2029.',
  'Eine Zahlung ist nicht zu leisten.',
].join('\n');

const RECHNUNG = [
  'Muster Baustoffe GmbH',
  '',
  'Beispiel Haustechnik GmbH',
  'Bahnhofstrasse 12',
  '32105 Bad Salzuflen',
  '',
  'Rechnung Nr. MB-2026-5120',
  '',
  'Pos 1 Bitumenbahn 2.880,00 EUR',
  'Nettobetrag 3.520,00 EUR',
  'Umsatzsteuer 19 % 668,80 EUR',
  'Rechnungsbetrag 4.188,80 EUR',
  '',
  'Zahlbar bis 16.09.2026 ohne Abzug.',
].join('\n');

const kern = (text: string) => buildDocumentSemanticCore({ text, companyProfile: PROFIL });

describe('01B — Fristen tragen Bedeutung', () => {
  it('behält beide Fristen eines Schreibens', () => {
    const core = kern(MAENGELANZEIGE);
    const handlungsfristen = core.deadlines.filter((f) => f.actionRequired).map((f) => f.date);

    expect(handlungsfristen).toContain('2026-09-30');
    expect(handlungsfristen).toContain('2026-09-22');
  });

  it('unterscheidet Leistungsfrist von Antwortfrist', () => {
    const core = kern(MAENGELANZEIGE);
    const leistung = core.deadlines.find((f) => f.date === '2026-09-30');
    const antwort = core.deadlines.find((f) => f.date === '2026-09-22');

    expect(leistung?.type).toBe('service_due');
    expect(antwort?.type).toBe('response_due');
  });

  it('nimmt die früheste Handlungsfrist als die maßgebliche', () => {
    expect(kern(MAENGELANZEIGE).primaryActionDeadline?.date).toBe('2026-09-22');
  });

  it('macht aus einem Gültigkeitsende keine Handlungsfrist', () => {
    const core = kern(FREISTELLUNG);
    const gueltigkeit = core.deadlines.find((f) => f.date === '2029-08-31');

    expect(gueltigkeit?.type).toBe('validity_period_end');
    expect(gueltigkeit?.actionRequired).toBe(false);
    /* Und damit gibt es für dieses Schreiben gar keine Handlungsfrist. */
    expect(core.primaryActionDeadline).toBeUndefined();
  });

  it('hält das Briefdatum von den Fristen getrennt', () => {
    const core = kern(MAHNUNG);
    const briefdatum = core.deadlines.find((f) => f.date === '2026-09-05');

    expect(briefdatum?.actionRequired).toBe(false);
    expect(core.primaryActionDeadline?.date).toBe('2026-09-19');
  });
});

describe('01B — Beträge tragen eine Rolle', () => {
  it('nennt bei einer Mahnung die Gesamtforderung, nicht den ersten Betrag', () => {
    const core = kern(MAHNUNG);
    expect(resolvePrimaryClaimAmount(core)?.value).toBe(4291.5);
  });

  it('nennt bei einer Rechnung die Rechnungssumme, nicht den ersten Posten', () => {
    const core = kern(RECHNUNG);
    expect(resolvePrimaryClaimAmount(core)?.value).toBe(4188.8);
  });

  it('behandelt einen Einbehalt nicht als Forderung an uns', () => {
    const core = kern(MAENGELANZEIGE);
    const einbehalt = core.amounts.find((b) => b.value === 5000);

    expect(einbehalt?.role).toBe('retention');
    expect(einbehalt?.isClaimAgainstUs).toBe(false);
    expect(resolvePrimaryClaimAmount(core)).toBeUndefined();
  });

  it('zählt Steuer und Netto nicht als eigene Forderung', () => {
    const core = kern(RECHNUNG);
    expect(core.amounts.find((b) => b.value === 668.8)?.role).toBe('tax_amount');
    expect(core.amounts.find((b) => b.value === 3520)?.role).toBe('net_amount');
    expect(core.amounts.find((b) => b.value === 668.8)?.isClaimAgainstUs).toBe(false);
  });
});

describe('01B — Buchungsschranke', () => {
  it('sperrt ein Mängelschreiben mit Einbehalt trotz fünfstelligem Betrag', () => {
    const core = kern(MAENGELANZEIGE);
    const tor = resolveAccountingGate({ core, classifiedKind: 'sonstiges' });

    expect(core.accounting.relevance).toBe('none');
    expect(tor.decision).toBe('blocked');
  });

  it('führt eine Mahnung auf den vorhandenen Beleg statt auf eine neue Ausgabe', () => {
    const core = kern(MAHNUNG);
    expect(core.accounting.relevance).toBe('reference_only');
    expect(resolveAccountingGate({ core, classifiedKind: 'sonstiges' }).decision).toBe('reference_only');
  });

  it('lässt eine Rechnung als Buchungskandidat zu — mit Bestätigung', () => {
    const core = kern(RECHNUNG);
    expect(core.accounting.relevance).toBe('booking_candidate');
    expect(resolveAccountingGate({ core, classifiedKind: 'rechnung' }).decision).toBe('needs_confirmation');
  });

  it('sperrt ein Behördenschreiben ohne Zahlungspflicht', () => {
    expect(resolveAccountingGate({ core: kern(FREISTELLUNG) }).decision).toBe('blocked');
  });

  it('lässt die bestehende Artenliste die Entscheidung nur verschärfen', () => {
    /*
     * Selbst wenn die Textanalyse eine Rechnung sieht: Ist die Dokumentart als
     * Verweisdokument bekannt, bleibt es dabei. Der erprobte Schutz aus
     * DOCUMENT-ACCOUNTING-REFERENCE-SAFETY-01B wird nie schwächer.
     */
    const tor = resolveAccountingGate({ core: kern(RECHNUNG), classifiedKind: 'mahnung' });
    expect(tor.decision).toBe('reference_only');
    expect(tor.source).toBe('kind');
  });

  it('bucht ohne auswertbaren Text nichts ohne Bestätigung', () => {
    const tor = resolveAccountingGate({ core: null, classifiedKind: 'sonstiges' });
    expect(tor.decision).toBe('needs_confirmation');
  });
});

describe('01B — Betreff und Anliegen', () => {
  it('liest die echte Betreffzeile', () => {
    expect(kern(MAENGELANZEIGE).subject?.value).toBe(
      'Maengelanzeige - Bauvorhaben Gewerbepark Senne, Gebaeude B',
    );
  });

  it('erfindet keinen Betreff, wenn keiner erkennbar ist', () => {
    const core = kern('Hallo,\n\nanbei die Unterlagen.\n\nViele Gruesse');
    expect(core.subject).toBeUndefined();
  });

  it('fasst das Anliegen zusammen und nennt die Anzahl der Fristen', () => {
    const anliegen = kern(MAENGELANZEIGE).purpose?.value ?? '';
    expect(anliegen).toContain('Maengelanzeige');
    expect(anliegen).toContain('Fristen');
  });
});

describe('01B — Pflichten', () => {
  it('erkennt, was von uns verlangt wird', () => {
    const eigene = kern(MAENGELANZEIGE).obligations.filter((p) => p.who === 'own_company');

    expect(eigene.length).toBeGreaterThanOrEqual(2);
    expect(eigene.some((p) => /beseitigen/i.test(p.what))).toBe(true);
    expect(eigene.some((p) => /bestaetigen/i.test(p.what))).toBe(true);
  });

  it('hängt an eine befristete Pflicht ihre Frist', () => {
    const beseitigung = kern(MAENGELANZEIGE).obligations.find((p) => /beseitigen/i.test(p.what));
    expect(beseitigung?.byWhen).toBe('2026-09-30');
  });

  it('trennt, was die Gegenseite selbst tun will', () => {
    const fremd = kern(MAENGELANZEIGE).obligations.filter((p) => p.who === 'counterparty');
    expect(fremd.some((p) => /behalten/i.test(p.what))).toBe(true);
  });
});

describe('01B — Empfängerprüfung', () => {
  it('erkennt, dass das Schreiben an den eigenen Betrieb geht', () => {
    const pruefung = kern(MAENGELANZEIGE).recipientCheck;
    expect(pruefung.addressedToOwnCompany).toBe('yes');
    expect(pruefung.matchedOn.length).toBeGreaterThanOrEqual(2);
  });

  it('bleibt bei fremder Post unentschieden, statt zu raten', () => {
    const core = buildDocumentSemanticCore({
      text: 'Ganz Andere GmbH\nFremdweg 1\n12345 Anderstadt\n\nSehr geehrte Damen und Herren,\n\nanbei.',
      companyProfile: PROFIL,
    });
    expect(core.recipientCheck.addressedToOwnCompany).toBe('unknown');
  });
});

describe('01B — Kunde und Auftrag trotz unbekannter Dokumentart', () => {
  const kunden = [
    { id: 'cust-1', name: 'Westfalen Projektbau GmbH', city: 'Bielefeld', street: 'Industriestrasse 27' },
    { id: 'cust-2', name: 'Nordlicht Immobilien AG', city: 'Hamburg' },
  ] as unknown as Customer[];

  const vorgaenge = [
    { id: 'vg-1', title: 'Gewerbepark Senne - Dachsanierung Gebaeude B', customer: 'Westfalen Projektbau GmbH', baustelle: 'Gewerbepark Senne' },
    { id: 'vg-2', title: 'Wohnanlage Nordstadt - Heizungstausch', customer: 'Nordlicht Immobilien AG', baustelle: 'Nordstadt' },
  ] as unknown as Vorgang[];

  it('findet den bestehenden Kunden, obwohl die Dokumentart unbekannt ist', () => {
    const treffer = findSemanticPartyCandidates({
      text: MAENGELANZEIGE,
      sender: 'Westfalen Projektbau GmbH',
      customers: kunden,
      vorgaenge,
    });

    expect(treffer.customerCandidates[0]?.id).toBe('cust-1');
    expect(treffer.customerCandidates[0]?.reasons.length).toBeGreaterThan(0);
  });

  it('findet den bestehenden Auftrag über das Bauvorhaben im Text', () => {
    const treffer = findSemanticPartyCandidates({
      text: MAENGELANZEIGE,
      sender: 'Westfalen Projektbau GmbH',
      customers: kunden,
      vorgaenge,
    });

    expect(treffer.vorgangCandidates[0]?.id).toBe('vg-1');
  });

  it('schlägt keinen fremden Kunden vor', () => {
    const treffer = findSemanticPartyCandidates({
      text: MAENGELANZEIGE,
      customers: kunden,
      vorgaenge,
    });
    expect(treffer.customerCandidates.some((k) => k.id === 'cust-2')).toBe(false);
  });

  it('liefert Vorschläge, niemals eine fertige Verknüpfung', () => {
    const treffer = findSemanticPartyCandidates({
      text: MAENGELANZEIGE,
      sender: 'Westfalen Projektbau GmbH',
      customers: kunden,
      vorgaenge,
    });
    /* Ein Kandidat trägt eine Bewertung und eine Begründung — mehr nicht. */
    for (const kandidat of [...treffer.customerCandidates, ...treffer.vorgangCandidates]) {
      expect(kandidat.score).toBeGreaterThan(0);
      expect(kandidat.score).toBeLessThanOrEqual(1);
      expect(Array.isArray(kandidat.reasons)).toBe(true);
    }
  });
});

describe('01B — unbekanntes Schreiben bleibt verwertbar', () => {
  it('liefert auch ohne erkannte Dokumentart Bedeutung', () => {
    const core = kern(MAENGELANZEIGE);

    /* Nichts davon hängt an einer Klassifikation — sie wird nie übergeben. */
    expect(core.subject).toBeDefined();
    expect(core.deadlines.length).toBeGreaterThan(0);
    expect(core.obligations.length).toBeGreaterThan(0);
    expect(core.amounts.length).toBeGreaterThan(0);
    expect(core.accounting.relevance).toBe('none');
  });

  it('bleibt bei leerem Text still, statt etwas zu behaupten', () => {
    const core = buildDocumentSemanticCore({ text: '   ', companyProfile: PROFIL });
    expect(core.subject).toBeUndefined();
    expect(core.deadlines).toHaveLength(0);
    expect(core.obligations).toHaveLength(0);
    expect(core.accounting.relevance).toBe('none');
  });
});
