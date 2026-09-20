/**
 * DOKUMENT-FACHWISSEN-01I3 — belegtes Wissen zur Ansässigkeitsbescheinigung.
 *
 * Die USt 1 TS ist der schwierigste der drei Fälle, weil sie sich dieselbe
 * Vorschrift mit der USt 1 TG teilt. Der naheliegendste Fehler wäre, ihr die
 * Dreijahresfrist der TG mitzugeben — sie stünde dann hinter einer echten
 * Quellenangabe und wäre trotzdem erfunden. Genau darauf zielen mehrere Tests
 * hier.
 */
import { describe, expect, it } from 'vitest';
import { recognizeCertificate } from './documentCertificateRecognition';
import {
  findDocumentKnowledge,
  resolveKnowledgeTopics,
  verifyUsedKnowledge,
} from './documentKnowledgeService';
import { buildDocumentSemanticCore } from './documentSemanticCoreService';
import {
  DOMAIN_KNOWLEDGE_SOURCES,
  DOMAIN_KNOWLEDGE_STATEMENTS,
  KNOWLEDGE_TOPIC_UST1TG,
  KNOWLEDGE_TOPIC_UST1TS,
} from '../domainKnowledge/domainKnowledgeRegistry';
import { findKnowledgeStatements } from '../domainKnowledge/domainKnowledgeRetrieval';
import { validateAiOutput } from '../ai/aiOutputGuardService';
import { isServerClaimGuardedOperation } from '../../../supabase/functions/_shared/legalClaimCore';

const HEUTE = '2026-09-20';

const UST1TS = `Finanzamt Musterstadt
USt 1 TS
Bescheinigung ueber die Ansaessigkeit im Inland nach § 13b Absatz 7 UStG
Steuernummer 123/456/7890
Gueltig bis 31.12.2027.`;

const UST1TG = `Finanzamt Musterstadt
USt 1 TG
Bescheinigung fuer Zwecke der Steuerschuldnerschaft des Leistungsempfaengers bei Bauleistungen
nach § 13b Abs. 5 UStG`;

const FREISTELLUNG = `Finanzamt Musterstadt
Freistellungsbescheinigung nach § 48b EStG
Steuerabzug bei Bauleistungen`;

function signale(text: string, question: string) {
  return {
    question,
    classifiedKind: null,
    subject: null,
    purpose: null,
    certificate: recognizeCertificate(text),
    documentDates: ['2027-12-31'],
    asOf: HEUTE,
  };
}

const themen = (text: string, question: string) => resolveKnowledgeTopics(signale(text, question));
const wissen = (text: string, question: string) => findDocumentKnowledge(signale(text, question));
const wissenstext = (text: string, question: string) =>
  wissen(text, question)
    .map((t) => t.statement.statement)
    .join(' ');

/* ------------------------- A — der Bestand ------------------------------- */

describe('A — was aufgenommen wurde und was nicht', () => {
  it('sieben Aussagen, getragen von Gesetz und amtlichem Muster', () => {
    const ts = DOMAIN_KNOWLEDGE_STATEMENTS.filter((s) => s.topic === KNOWLEDGE_TOPIC_UST1TS);
    expect(ts).toHaveLength(7);
    expect([...new Set(ts.map((s) => s.sourceId))].sort()).toEqual([
      'src-bmf-ust1ts',
      'src-ustg-13b',
    ]);
  });

  it('§ 13b UStG wurde nicht ein zweites Mal angelegt', () => {
    expect(DOMAIN_KNOWLEDGE_SOURCES.filter((q) => q.id === 'src-ustg-13b')).toHaveLength(1);
    const ustg = DOMAIN_KNOWLEDGE_STATEMENTS.filter((s) => s.sourceId === 'src-ustg-13b');
    expect(new Set(ustg.map((s) => s.topic)).size).toBe(2);
  });

  it('die neue BMF-Quelle ist amtlich eingeordnet und https', () => {
    const quelle = DOMAIN_KNOWLEDGE_SOURCES.find((q) => q.id === 'src-bmf-ust1ts');
    expect(quelle?.trust).toBe('official_guidance');
    expect(quelle?.url?.startsWith('https://')).toBe(true);
    expect(quelle?.identifier).toContain('10.04.2026');
  });

  it('keine Dreijahresfrist und keine pauschale Ansässigkeit im TS-Bestand', () => {
    const text = wissenstext(UST1TS, 'Wie lange gilt sie?').toLowerCase();
    expect(text).not.toContain('drei jahre');
    expect(text).not.toContain('befristet');
    expect(text).not.toContain('sind sie in deutschland ansässig');
  });

  it('keine der verbotenen Verkürzungen steht im Gesamtbestand', () => {
    const text = DOMAIN_KNOWLEDGE_STATEMENTS.map((s) => s.statement).join(' ').toLowerCase();
    expect(text).not.toContain('beweist immer');
    expect(text).not.toContain('gilt § 13b nicht');
    expect(text).not.toContain('reicht immer aus');
    expect(text).not.toContain('befreit von');
  });
});

/* ------------------------- B — Routing ----------------------------------- */

describe('B — drei Papiere, drei Themen', () => {
  it('eine USt 1 TS lädt ihr eigenes Thema', () => {
    expect(themen(UST1TS, 'Was bescheinigt dieses Dokument?')).toEqual([KNOWLEDGE_TOPIC_UST1TS]);
  });

  it('eine USt 1 TG lädt kein TS-Wissen', () => {
    const geladen = wissen(UST1TG, 'Geht es hier um Ansässigkeit im Inland?');
    expect(geladen.length).toBeGreaterThan(0);
    expect(geladen.every((t) => t.statement.topic === KNOWLEDGE_TOPIC_UST1TG)).toBe(true);
  });

  it('eine Freistellungsbescheinigung lädt kein TS-Wissen', () => {
    const geladen = wissen(FREISTELLUNG, 'Muss mein Auftraggeber Bauabzugsteuer einbehalten?');
    expect(geladen.every((t) => t.statement.topic !== KNOWLEDGE_TOPIC_UST1TS)).toBe(true);
  });

  it('unbekannt und widersprüchlich bekommen nichts', () => {
    expect(
      resolveKnowledgeTopics({
        question: 'Geht es hier um Ansässigkeit im Inland?',
        classifiedKind: 'sonstiges',
        subject: 'Maengelanzeige',
        purpose: null,
        asOf: HEUTE,
      }),
    ).toEqual([]);
    expect(themen('USt 1 TS. Freistellungsbescheinigung nach § 48b EStG.', 'Was ist das?')).toEqual(
      [],
    );
  });

  it('§ 13b allein macht noch keine USt 1 TS', () => {
    expect(
      themen(
        'Werkvertrag ueber Bauleistungen. Abrechnung nach § 13b UStG.',
        'Geht es hier um Ansässigkeit im Inland?',
      ),
    ).toEqual([]);
  });

  it('die Formularkennung bleibt das tragende Erkennungssignal', () => {
    expect(recognizeCertificate(UST1TS)?.formId).toBe('USt 1 TS');
    expect(recognizeCertificate(UST1TS)?.type).toBe('domestic_establishment');
  });
});

/* ------------------------- C — die sieben Fragen ------------------------- */

describe('C — die Fragen A bis G', () => {
  const fragen = [
    'Was bescheinigt dieses Dokument?',
    'Ist das eine Freistellungsbescheinigung?',
    'Was bedeutet Ansässigkeit im Inland?',
    'Hat das mit USt 1 TG zu tun?',
    'Wie lange gilt sie?',
    'Bedeutet das, dass mein Auftraggeber keine Umsatzsteuer schuldet?',
    'Wir haben eine Betriebsstätte in Deutschland. Reicht das?',
  ];

  for (const frage of fragen) {
    it(`„${frage}" lädt ausschliesslich das TS-Thema`, () => {
      expect(themen(UST1TS, frage)).toEqual([KNOWLEDGE_TOPIC_UST1TS]);
    });
  }

  it('B: kein § 48b-Wissen als Erklärung des TS-Dokuments', () => {
    const text = wissenstext(UST1TS, 'Ist das eine Freistellungsbescheinigung?');
    expect(text).not.toContain('48b');
    expect(text).not.toContain('15 Prozent');
  });

  it('D: kein TG-Wissen als Erklärung des TS-Dokuments', () => {
    const text = wissenstext(UST1TS, 'Hat das mit USt 1 TG zu tun?');
    expect(text).not.toContain('Gebäudereinigung');
    expect(text).not.toContain('längstens drei Jahre');
  });

  it('F: der Zweifelsfall steht im geladenen Wissen, kein pauschales Ja', () => {
    const text = wissenstext(
      UST1TS,
      'Bedeutet das, dass mein Auftraggeber keine Umsatzsteuer schuldet?',
    );
    expect(text).toContain('zweifelhaft');
    expect(text).toContain('nur dann nicht');
  });

  it('G: die Betriebsstätte steht mit ihrer Bedingung da, nicht als Freibrief', () => {
    const text = wissenstext(UST1TS, 'Wir haben eine Betriebsstätte in Deutschland. Reicht das?');
    expect(text).toContain('an diesem Umsatz nicht beteiligt');
    expect(text).toContain('Maßgebend ist der Zeitpunkt');
  });
});

/* ------------------------- D — Kern, Ablage, Fristen --------------------- */

describe('D — der semantische Kern bleibt unverändert streng', () => {
  it('eine USt 1 TS wird kein Buchungsbeleg', () => {
    const kern = buildDocumentSemanticCore({ text: UST1TS, companyProfile: null });
    expect(kern.accounting.relevance).not.toBe('booking_candidate');
  });

  it('das Gültigkeitsende bleibt keine Handlungsfrist', () => {
    const kern = buildDocumentSemanticCore({ text: UST1TS, companyProfile: null });
    const frist = kern.deadlines.find((f) => f.date === '2027-12-31');
    expect(frist?.actionRequired).toBe(false);
    expect(kern.primaryActionDeadline).toBeUndefined();
  });
});

/* ------------------------- E — Quellen und Stand ------------------------- */

describe('E — Quellenbindung und Aktualität', () => {
  it('nur vorgelegte Kennungen werden zu Quellen', () => {
    const angeboten = wissen(UST1TS, 'Was bescheinigt dieses Dokument?');
    expect(verifyUsedKnowledge(['stmt-bmf-muster-ust1tg'], angeboten)).toEqual([]);
    expect(verifyUsedKnowledge(['stmt-erfunden'], angeboten)).toEqual([]);
  });

  it('die Adresse stammt aus dem Bestand', () => {
    const angeboten = wissen(UST1TS, 'Was bescheinigt dieses Dokument?');
    const belege = verifyUsedKnowledge(['stmt-bmf-muster-ust1ts'], angeboten);
    expect(belege).toHaveLength(1);
    expect(belege[0]?.url).toContain('bundesfinanzministerium.de');
    expect(belege[0]?.reviewedAt).toBe(HEUTE);
  });

  it('die bestehende Prüffrist gilt auch hier', () => {
    const spaeter = findKnowledgeStatements({ topic: KNOWLEDGE_TOPIC_UST1TS, asOf: '2027-09-20' });
    expect(spaeter.all.length).toBeGreaterThan(0);
    expect(spaeter.usable).toEqual([]);
  });
});

/* ------------------------- F — die Schranken ----------------------------- */

describe('F — Client- und Serverguard bleiben', () => {
  it('der Serverguard ist weiterhin verdrahtet', () => {
    expect(isServerClaimGuardedOperation('document_question')).toBe(true);
  });

  it('eine Quelle kauft die verbindliche Einzelfallentscheidung nicht frei', () => {
    const ergebnis = validateAiOutput(
      'Nach § 13b Absatz 7 UStG kommt es auf den Zeitpunkt der Leistung an. Mit dieser Bescheinigung schuldet Ihr Auftraggeber rechtlich keine Umsatzsteuer.',
      'qa',
    );
    expect(ergebnis.safeText).toBeDefined();
    expect(ergebnis.safeText).not.toContain('schuldet Ihr Auftraggeber rechtlich keine');
    expect(ergebnis.safeText).toContain('Zeitpunkt der Leistung');
  });
});
