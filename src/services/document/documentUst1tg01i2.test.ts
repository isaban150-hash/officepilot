/**
 * DOKUMENT-FACHWISSEN-01I2 — belegtes Wissen zur Bescheinigung USt 1 TG.
 *
 * Der gefährlichste Fehler dieses Blocks wäre nicht eine fehlende Auskunft,
 * sondern eine zu weitgehende: „Damit rechnen Sie ohne Umsatzsteuer ab." Die
 * Bescheinigung betrifft **ein** Merkmal unter mehreren. Deshalb prüfen die
 * meisten Tests hier, was **nicht** im Bestand steht und was **nicht** geladen
 * wird.
 *
 * Die Beispieltexte sind knappe Prüftexte, keine echten Bescheinigungen.
 */
import { describe, expect, it } from 'vitest';
import { recognizeCertificate } from './documentCertificateRecognition';
import {
  findDocumentKnowledge,
  resolveKnowledgeTopics,
  verifyUsedKnowledge,
} from './documentKnowledgeService';
import {
  DOMAIN_KNOWLEDGE_SOURCES,
  DOMAIN_KNOWLEDGE_STATEMENTS,
  KNOWLEDGE_TOPIC_UST1TG,
} from '../domainKnowledge/domainKnowledgeRegistry';
import { findKnowledgeStatements } from '../domainKnowledge/domainKnowledgeRetrieval';
import { validateAiOutput } from '../ai/aiOutputGuardService';
import { isServerClaimGuardedOperation } from '../../../supabase/functions/_shared/legalClaimCore';

const HEUTE = '2026-09-20';

const UST1TG = `Finanzamt Musterstadt
USt 1 TG
Bescheinigung fuer Zwecke der Steuerschuldnerschaft des Leistungsempfaengers bei Bauleistungen und Gebaeudereinigungsleistungen
nach § 13b Abs. 5 UStG
Gueltig bis 31.12.2028.`;

const UST1TS = `Finanzamt Musterstadt
USt 1 TS
Bescheinigung ueber die Ansaessigkeit im Inland nach § 13b Absatz 7 UStG`;

const FREISTELLUNG = `Finanzamt Musterstadt
Freistellungsbescheinigung nach § 48b EStG
Steuerabzug bei Bauleistungen
Gueltig bis 31.08.2029.`;

const WERKVERTRAG = `Werkvertrag ueber Bauleistungen
Die Abrechnung erfolgt ohne Umsatzsteuer, da § 13b UStG Anwendung findet.`;

function themen(text: string, question: string): string[] {
  return resolveKnowledgeTopics({
    question,
    classifiedKind: null,
    subject: null,
    purpose: null,
    certificate: recognizeCertificate(text),
    documentDates: ['2028-12-31'],
    asOf: HEUTE,
  });
}

function wissen(text: string, question: string) {
  return findDocumentKnowledge({
    question,
    classifiedKind: null,
    subject: null,
    purpose: null,
    certificate: recognizeCertificate(text),
    documentDates: ['2028-12-31'],
    asOf: HEUTE,
  });
}

/* ------------------------- A — der Bestand ------------------------------- */

describe('A — was aufgenommen wurde und was nicht', () => {
  it('die neun Aussagen tragen ihre amtlichen Quellen', () => {
    const tg = DOMAIN_KNOWLEDGE_STATEMENTS.filter((s) => s.topic === KNOWLEDGE_TOPIC_UST1TG);
    expect(tg).toHaveLength(9);
    const quellen = new Set(tg.map((s) => s.sourceId));
    expect([...quellen].sort()).toEqual(['src-bmf-ust1tg', 'src-ustg-13b']);
  });

  it('die beiden neuen Quellen sind amtlich eingeordnet und haben eine https-Adresse', () => {
    for (const id of ['src-ustg-13b', 'src-bmf-ust1tg']) {
      const quelle = DOMAIN_KNOWLEDGE_SOURCES.find((q) => q.id === id);
      expect(quelle, id).toBeDefined();
      expect(['official_primary', 'official_guidance'], id).toContain(quelle?.trust);
      expect(quelle?.url?.startsWith('https://'), id).toBe(true);
    }
  });

  it('der Musterstand steht an der Quelle, nicht als Prüfstand der Aussage', () => {
    const bmf = DOMAIN_KNOWLEDGE_SOURCES.find((q) => q.id === 'src-bmf-ust1tg');
    expect(bmf?.identifier).toContain('10.04.2026');
    const aussage = DOMAIN_KNOWLEDGE_STATEMENTS.find((s) => s.id === 'stmt-bmf-muster-stand');
    expect(aussage?.reviewedAt).toBe(HEUTE);
  });

  it('keine zu weitgehende Aussage im Bestand', () => {
    const text = DOMAIN_KNOWLEDGE_STATEMENTS.map((s) => s.statement).join(' ').toLowerCase();
    expect(text).not.toContain('ohne umsatzsteuer');
    expect(text).not.toContain('befreit');
    expect(text).not.toContain('10 prozent');
    expect(text).not.toContain('10 %');
    /* Der Auftraggeber schuldet nicht „immer" etwas. */
    expect(text).not.toContain('schuldet immer');
  });
});

/* ------------------------- B — Routing ----------------------------------- */

describe('B — das Dokument bestimmt sein Thema', () => {
  it('eine USt 1 TG lädt ihr eigenes Thema', () => {
    expect(themen(UST1TG, 'Was bedeutet diese Bescheinigung?')).toEqual([KNOWLEDGE_TOPIC_UST1TG]);
    expect(wissen(UST1TG, 'Was bedeutet diese Bescheinigung?').length).toBeGreaterThan(0);
  });

  it('eine Freistellungsbescheinigung lädt kein USt-1-TG-Wissen', () => {
    const geladen = wissen(FREISTELLUNG, 'Muss mein Auftraggeber Bauabzugsteuer einbehalten?');
    expect(geladen.length).toBeGreaterThan(0);
    expect(geladen.every((t) => t.statement.topic !== KNOWLEDGE_TOPIC_UST1TG)).toBe(true);
  });

  /*
   * Seit 01I3 hat die USt 1 TS ein eigenes Thema. Die Zusage dieses Blocks
   * war nie „sie bekommt nichts", sondern: **kein TG-Wissen**. Geprüft wird
   * jetzt genau das.
   */
  it('eine USt 1 TS bekommt niemals das Thema der USt 1 TG', () => {
    for (const frage of ['Was bedeutet diese Bescheinigung?', 'Ist das eine Freistellungsbescheinigung?']) {
      expect(themen(UST1TS, frage), frage).not.toContain(KNOWLEDGE_TOPIC_UST1TG);
    }
  });

  it('ein widersprüchliches Papier bekommt nichts', () => {
    expect(themen('USt 1 TG. Freistellungsbescheinigung nach § 48b EStG.', 'Was bedeutet das?')).toEqual(
      [],
    );
  });

  it('ein Werkvertrag mit § 13b wird keine Bescheinigung und bekommt nichts', () => {
    expect(themen(WERKVERTRAG, 'Was bedeutet § 13b hier?')).toEqual([]);
  });

  it('eine reine Betragsfrage lädt auch auf der USt 1 TG nichts', () => {
    expect(themen(UST1TG, 'Wie hoch ist der Betrag auf diesem Dokument?')).toEqual([]);
  });

  it('eine fremde Begriffsfrage lädt auf der USt 1 TG nichts', () => {
    expect(themen(UST1TG, 'Was ist eine Abschlagsrechnung?')).toEqual([]);
  });
});

/* ------------------------- C — Cross-Topic ------------------------------- */

describe('C — keine Vermischung der beiden Bescheinigungen', () => {
  it('„Hat das mit Bauabzugsteuer zu tun?" holt auf einer USt 1 TG kein § 48b-Wissen', () => {
    const geladen = wissen(UST1TG, 'Hat das mit Bauabzugsteuer zu tun?');
    expect(geladen.length).toBeGreaterThan(0);
    expect(geladen.every((t) => t.statement.topic === KNOWLEDGE_TOPIC_UST1TG)).toBe(true);
    const text = geladen.map((t) => t.statement.statement).join(' ');
    expect(text).not.toContain('15 Prozent');
    expect(text).not.toContain('48b');
  });

  it('umgekehrt holt eine Umsatzsteuerfrage auf der Freistellungsbescheinigung kein TG-Wissen', () => {
    const geladen = wissen(FREISTELLUNG, 'Kann ich ohne Umsatzsteuer abrechnen?');
    expect(geladen.every((t) => t.statement.topic !== KNOWLEDGE_TOPIC_UST1TG)).toBe(true);
  });
});

/* ------------------------- D — die sieben Fragen ------------------------- */

describe('D — die Fragen A bis G laden das Richtige', () => {
  const fragen = [
    'Was bedeutet diese Bescheinigung?',
    'Hat das mit Bauabzugsteuer zu tun?',
    'Was bedeutet § 13b hier?',
    'Wie lange gilt sie?',
    'Was muss ich meinem Auftraggeber geben?',
    'Kann ich jetzt ohne Umsatzsteuer abrechnen?',
    'Bin ich damit von der Umsatzsteuer befreit?',
  ];

  for (const frage of fragen) {
    it(`„${frage}" lädt das Thema der Bescheinigung`, () => {
      expect(themen(UST1TG, frage)).toEqual([KNOWLEDGE_TOPIC_UST1TG]);
    });
  }

  it('die Dreijahresgrenze und der Widerruf stehen im geladenen Wissen', () => {
    const text = wissen(UST1TG, 'Wie lange gilt sie?')
      .map((t) => t.statement.statement)
      .join(' ');
    expect(text).toContain('längstens drei Jahre');
    expect(text).toContain('mit Wirkung für die Zukunft');
  });

  it('keine Vorlagepflicht gegenüber dem Auftraggeber wird behauptet', () => {
    const text = wissen(UST1TG, 'Was muss ich meinem Auftraggeber geben?')
      .map((t) => t.statement.statement)
      .join(' ')
      .toLowerCase();
    expect(text).not.toContain('vorlegen');
    expect(text).not.toContain('aushändigen');
  });
});

/* ------------------------- E — Quellen und Stand ------------------------- */

describe('E — Quellenbindung und Aktualität', () => {
  it('nur vorgelegte Kennungen werden zu Quellen', () => {
    const angeboten = wissen(UST1TG, 'Was bedeutet diese Bescheinigung?');
    expect(verifyUsedKnowledge(['stmt-gibt-es-nicht'], angeboten)).toEqual([]);
    expect(verifyUsedKnowledge(['stmt-estg48-steuerabzug-15'], angeboten)).toEqual([]);
  });

  it('die Adresse stammt aus dem Bestand', () => {
    const angeboten = wissen(UST1TG, 'Was bedeutet diese Bescheinigung?');
    const belege = verifyUsedKnowledge(['stmt-bmf-muster-ust1tg'], angeboten);
    expect(belege).toHaveLength(1);
    expect(belege[0]?.url).toContain('bundesfinanzministerium.de');
    expect(belege[0]?.publisher).toBe('Bundesministerium der Finanzen');
  });

  it('die bestehende Prüffrist gilt auch hier — ein Jahr später ist nichts mehr aktuell', () => {
    const spaeter = findKnowledgeStatements({ topic: KNOWLEDGE_TOPIC_UST1TG, asOf: '2027-09-20' });
    expect(spaeter.all.length).toBeGreaterThan(0);
    expect(spaeter.usable).toEqual([]);
  });
});

/* ------------------------- F — die Schranken ----------------------------- */

describe('F — Client- und Serverguard bleiben', () => {
  it('der Serverguard ist weiterhin verdrahtet', () => {
    expect(isServerClaimGuardedOperation('document_question')).toBe(true);
  });

  it('ein verbindliches Ja zur Abrechnung wird weiterhin entfernt', () => {
    const ergebnis = validateAiOutput(
      'Nach § 13b UStG kann die Steuerschuld übergehen. Sie können diese Rechnung ohne Umsatzsteuer stellen, das ist rechtlich zulässig.',
      'qa',
    );
    expect(ergebnis.safeText).toBeDefined();
    expect(ergebnis.safeText).not.toContain('rechtlich zulässig');
  });
});
