/**
 * DOKUMENT-FACHWISSEN-01I1 — Bescheinigungen auseinanderhalten.
 *
 * Die Beispieltexte sind bewusst knapp und erfunden; sie enthalten genau die
 * Merkmale, um die es geht, und behaupten nichts über deutsches Recht. Wo eine
 * amtliche Formulierung zitiert wird, steht sie als Erkennungsmerkmal da, nicht
 * als Auskunft.
 *
 * Reihenfolge nach Schaden: zuerst die Verwechslungen, dann die Erkennung,
 * dann die Wirkung auf den Wissensabruf.
 */
import { describe, expect, it } from 'vitest';
import {
  isCertificateTypeReliable,
  readFormIds,
  readLegalReferences,
  recognizeCertificate,
} from './documentCertificateRecognition';
import { resolveKnowledgeTopics } from './documentKnowledgeService';
import { buildDocumentSemanticCore } from './documentSemanticCoreService';
import { isServerClaimGuardedOperation } from '../../../supabase/functions/_shared/legalClaimCore';

const HEUTE = '2026-09-20';

const FREISTELLUNG_TEXT = `Finanzamt Musterstadt
Freistellungsbescheinigung nach § 48b EStG
Hiermit wird bescheinigt, dass der Steuerabzug bei Bauleistungen nicht vorzunehmen ist.
Gueltig bis 31.08.2029.`;

const UST1TG_TEXT = `Finanzamt Musterstadt
USt 1 TG
Bescheinigung fuer Zwecke der Steuerschuldnerschaft des Leistungsempfaengers bei Bauleistungen und Gebaeudereinigungsleistungen
nach § 13b Abs. 5 UStG
Gueltig bis 31.12.2028.`;

const UST1TS_TEXT = `Finanzamt Musterstadt
USt 1 TS
Bescheinigung ueber die Ansaessigkeit im Inland nach § 13b Absatz 7 UStG
Steuernummer 123/456/7890`;

const WERKVERTRAG_TEXT = `Werkvertrag ueber Bauleistungen
Die Abrechnung erfolgt ohne Umsatzsteuer, da § 13b UStG Anwendung findet.
Auftraggeber: Westfalen Projektbau GmbH`;

/* ------------------------- A — Normalisierung ---------------------------- */

describe('A — Paragrafen in allen Schreibweisen', () => {
  it('§ 48b EStG in vier Schreibweisen', () => {
    for (const text of [
      '§ 48b EStG',
      '§48b EStG',
      '§ 48 b EStG',
      '48b Einkommensteuergesetz',
    ]) {
      expect(readLegalReferences(text), text).toEqual([{ law: 'EStG', paragraph: '48b' }]);
    }
  });

  it('§ 13b UStG in vier Schreibweisen', () => {
    for (const text of ['§ 13b UStG', '§13b UStG', '§ 13 b UStG', '13b Umsatzsteuergesetz']) {
      expect(readLegalReferences(text), text).toEqual([{ law: 'UStG', paragraph: '13b' }]);
    }
  });

  it('der Absatz wird nur übernommen, wenn er dasteht', () => {
    expect(readLegalReferences('§ 13b Abs. 5 UStG')).toEqual([
      { law: 'UStG', paragraph: '13b', subsection: '5' },
    ]);
    expect(readLegalReferences('§ 13b Absatz 7 Satz 5 UStG')).toEqual([
      { law: 'UStG', paragraph: '13b', subsection: '7' },
    ]);
    expect(readLegalReferences('§ 13b UStG')[0]?.subsection).toBeUndefined();
  });
});

/* ------------------------- B — Formularkennung --------------------------- */

describe('B — Formularkennungen aus der Texterkennung', () => {
  it('USt 1 TG in den üblichen Verstümmelungen', () => {
    for (const text of ['USt 1 TG', 'UST 1 TG', 'USt1TG', 'USt 1 T G']) {
      expect(readFormIds(text), text).toEqual(['USt 1 TG']);
    }
  });

  it('USt 1 TS ebenso — und niemals in ein TG verwandelt', () => {
    for (const text of ['USt 1 TS', 'UST 1 TS', 'USt1TS', 'USt 1 T S']) {
      expect(readFormIds(text), text).toEqual(['USt 1 TS']);
    }
  });

  it('kein Treffer mitten im Wort', () => {
    expect(readFormIds('Die USt 1 TGesamtsumme betraegt 100 EUR')).toEqual([]);
  });
});

/* ------------------------- C — Erkennung --------------------------------- */

describe('C — die drei Bescheinigungen', () => {
  it('§ 48b: Titel und Paragraf stützen sich — belastbar erkannt', () => {
    const erkannt = recognizeCertificate(FREISTELLUNG_TEXT);
    expect(erkannt?.type).toBe('construction_withholding_exemption');
    expect(erkannt?.certainty).toBe('detected');
    expect(isCertificateTypeReliable(erkannt)).toBe(true);
  });

  it('USt 1 TG: Kennung, Titel und Absatz stützen sich', () => {
    const erkannt = recognizeCertificate(UST1TG_TEXT);
    expect(erkannt?.type).toBe('reverse_charge_construction_status');
    expect(erkannt?.formId).toBe('USt 1 TG');
    expect(erkannt?.certainty).toBe('detected');
  });

  it('USt 1 TS: wird nicht mit der USt 1 TG verwechselt', () => {
    const erkannt = recognizeCertificate(UST1TS_TEXT);
    expect(erkannt?.type).toBe('domestic_establishment');
    expect(erkannt?.formId).toBe('USt 1 TS');
  });

  it('ein einzelnes starkes Merkmal genügt für einen Vorschlag, nicht mehr', () => {
    const erkannt = recognizeCertificate('Bescheinigung USt 1 TG des Finanzamts');
    expect(erkannt?.type).toBe('reverse_charge_construction_status');
    expect(erkannt?.certainty).toBe('proposed');
  });
});

/* ------------------------- D — schwache Wörter --------------------------- */

describe('D — gemeinsame Wörter entscheiden nichts', () => {
  it('Bescheinigung, Finanzamt, Steuernummer, gültig, Bauleistungen, Unternehmer', () => {
    const erkannt = recognizeCertificate(
      'Bescheinigung des Finanzamts. Steuernummer 123. Gueltig bis 2028. Der Unternehmer erbringt Bauleistungen.',
    );
    expect(erkannt).toBeUndefined();
  });

  it('ein Werkvertrag mit § 13b-Hinweis wird keine Bescheinigung', () => {
    const erkannt = recognizeCertificate(WERKVERTRAG_TEXT);
    expect(erkannt?.type).toBeUndefined();
    expect(erkannt?.certainty).toBe('uncertain');
    expect(isCertificateTypeReliable(erkannt)).toBe(false);
  });
});

/* ------------------------- E — Konflikte --------------------------------- */

describe('E — bei Widerspruch wird nicht geraten', () => {
  it('Kennung USt 1 TG und § 48b EStG im selben Text', () => {
    const erkannt = recognizeCertificate('USt 1 TG. Freistellungsbescheinigung nach § 48b EStG.');
    expect(erkannt?.type).toBeUndefined();
    expect(erkannt?.certainty).toBe('conflicting');
  });

  it('Kennung USt 1 TS mit dem Titel der USt 1 TG', () => {
    const erkannt = recognizeCertificate(
      'USt 1 TS. Bescheinigung fuer Zwecke der Steuerschuldnerschaft des Leistungsempfaengers.',
    );
    expect(erkannt?.type).toBeUndefined();
    expect(erkannt?.certainty).toBe('conflicting');
  });

  it('zwei Formularkennungen im selben Text', () => {
    const erkannt = recognizeCertificate('Anlagen: USt 1 TG und USt 1 TS');
    expect(erkannt?.type).toBeUndefined();
    expect(erkannt?.certainty).toBe('conflicting');
  });
});

/* ------------------------- F — der semantische Kern ---------------------- */

describe('F — der Kern trägt die Bescheinigungsart', () => {
  it('die Art steht im Kern und hängt an keiner Dokumentart', () => {
    const kern = buildDocumentSemanticCore({ text: UST1TG_TEXT, companyProfile: null });
    expect(kern.certificate?.type).toBe('reverse_charge_construction_status');
    expect(kern.readOnly).toBe(true);
  });

  it('ein Gültigkeitsende bleibt ein Gültigkeitsende, keine Handlungsfrist', () => {
    const kern = buildDocumentSemanticCore({ text: FREISTELLUNG_TEXT, companyProfile: null });
    const frist = kern.deadlines.find((f) => f.date === '2029-08-31');
    expect(frist?.actionRequired).toBe(false);
    expect(kern.primaryActionDeadline).toBeUndefined();
  });

  it('keine dieser Bescheinigungen wird zum Buchungsbeleg', () => {
    for (const text of [FREISTELLUNG_TEXT, UST1TG_TEXT, UST1TS_TEXT]) {
      const kern = buildDocumentSemanticCore({ text, companyProfile: null });
      expect(kern.accounting.relevance, text.slice(0, 30)).not.toBe('booking_candidate');
    }
  });
});

/* ------------------------- G — der Wissensabruf -------------------------- */

describe('G — die Frage schreibt das Dokument nicht um', () => {
  const signale = (text: string, question: string) => ({
    question,
    classifiedKind: null,
    subject: null,
    purpose: null,
    certificate: recognizeCertificate(text),
    asOf: HEUTE,
  });

  /*
   * Seit 01I2 hat die USt 1 TG ein eigenes Wissensthema. Die Zusage ist
   * dieselbe geblieben und lautete nie „gar nichts", sondern: **kein
   * § 48b-Wissen**. Geprüft wird deshalb die Abwesenheit der
   * Freistellungsthemen, nicht die Leere der Liste.
   */
  const OHNE_FREISTELLUNGSTHEMA = (themen: string[]) =>
    themen.every((thema) => !thema.includes('freistellung') && !thema.includes('bauabzug'));

  it('auf einer USt 1 TG lädt „Ist das eine Freistellungsbescheinigung?" kein § 48b-Wissen', () => {
    const themen = resolveKnowledgeTopics(
      signale(UST1TG_TEXT, 'Ist das eine Freistellungsbescheinigung?'),
    );
    expect(OHNE_FREISTELLUNGSTHEMA(themen), themen.join(',')).toBe(true);
  });

  it('auf einer USt 1 TS ebenso wenig', () => {
    const themen = resolveKnowledgeTopics(
      signale(UST1TS_TEXT, 'Ist das eine Freistellungsbescheinigung?'),
    );
    expect(OHNE_FREISTELLUNGSTHEMA(themen), themen.join(',')).toBe(true);
  });

  it('eine USt 1 TG bekommt auch bei einer Bauabzugsteuer-Frage kein § 48b-Wissen', () => {
    const themen = resolveKnowledgeTopics(
      signale(UST1TG_TEXT, 'Muss mein Auftraggeber Bauabzugsteuer einbehalten?'),
    );
    expect(OHNE_FREISTELLUNGSTHEMA(themen), themen.join(',')).toBe(true);
  });

  it('auf einer echten § 48b-Bescheinigung bleibt das Wissen von 01H3 verfügbar', () => {
    expect(
      resolveKnowledgeTopics(
        signale(FREISTELLUNG_TEXT, 'Muss mein Auftraggeber Bauabzugsteuer einbehalten?'),
      ).length,
    ).toBeGreaterThan(0);
  });

  it('ein unbekanntes Dokument bekommt nichts — fail closed', () => {
    expect(
      resolveKnowledgeTopics({
        question: 'Ist das eine Freistellungsbescheinigung?',
        classifiedKind: 'sonstiges',
        subject: 'Maengelanzeige Gewerbepark',
        purpose: 'Maengel beseitigen',
        asOf: HEUTE,
      }),
    ).toEqual([]);
  });

  it('die bisherige Bestätigung über die Dokumentart trägt weiterhin', () => {
    expect(
      resolveKnowledgeTopics({
        question: 'Wie bekomme ich eine neue Freistellungsbescheinigung?',
        classifiedKind: 'freistellungsbescheinigung',
        subject: 'Finanzamt Musterstadt · Freistellungsbescheinigung',
        purpose: null,
        asOf: HEUTE,
      }).length,
    ).toBeGreaterThan(0);
  });

  it('eine reine Betragsfrage bleibt ohne Fachwissen', () => {
    expect(
      resolveKnowledgeTopics(signale(FREISTELLUNG_TEXT, 'Wie hoch ist der Betrag auf diesem Dokument?')),
    ).toEqual([]);
  });
});

/* ------------------------- H — die Schranke bleibt ----------------------- */

describe('H — 01H2B unverändert', () => {
  it('der Serverguard ist für document_question weiterhin verdrahtet', () => {
    expect(isServerClaimGuardedOperation('document_question')).toBe(true);
  });
});
