/**
 * DOKUMENT-ASSISTENT-01H3 — belegtes Fachwissen im Dokument-Assistenten.
 *
 * Die Tests sind nach der Kette geordnet, die der Block baut: Wann wird
 * Fachwissen überhaupt geholt, was darf davon in den Prompt, was darf das
 * Modell daraus machen, und was davon erreicht die Oberfläche.
 *
 * Der wichtigste Teil ist der erste. Ein Assistent, der bei jeder Frage eine
 * Steuerregel beilegt, ist gefährlicher als einer, der keine kennt.
 */
import { describe, expect, it } from 'vitest';
import {
  findDocumentKnowledge,
  resolveKnowledgeTopics,
  sichereQuellenadresse,
  verifyUsedKnowledge,
  type DocumentKnowledgeSignals,
} from './documentKnowledgeService';
import { buildDocumentAiPrompt } from './documentAiPromptBuilder';
import { parseDocumentAiAnswer } from './documentAiAnswerParser';
import {
  DOMAIN_KNOWLEDGE_SOURCES,
  DOMAIN_KNOWLEDGE_STATEMENTS,
} from '../domainKnowledge/domainKnowledgeRegistry';
import { isServerClaimGuardedOperation } from '../../../supabase/functions/_shared/legalClaimCore';
import { validateAiOutput } from '../ai/aiOutputGuardService';
import type { DocumentAiContext } from '../../types/areaAi';

/** Der Prüftag der amtlichen Einträge — an ihm ist alles frisch. */
const HEUTE = '2026-09-20';

const FREISTELLUNG: Omit<DocumentKnowledgeSignals, 'question'> = {
  classifiedKind: 'Freistellungsbescheinigung',
  subject: 'Finanzamt Musterstadt · Freistellungsbescheinigung',
  purpose: 'Bescheinigung den Auftraggebern vorlegen',
  documentDates: ['2029-08-31'],
  asOf: HEUTE,
};

function themen(question: string, signals = FREISTELLUNG): string[] {
  return resolveKnowledgeTopics({ ...signals, question });
}

function wissen(question: string, signals = FREISTELLUNG) {
  return findDocumentKnowledge({ ...signals, question });
}

describe('A — wann Fachwissen geholt wird', () => {
  it('die Frage nennt das Thema selbst', () => {
    expect(wissen('Muss mein Auftraggeber Bauabzugsteuer einbehalten?').length).toBeGreaterThan(0);
  });

  it('die Frage nennt ein Datum aus dem Schreiben — das ist ein Bezug darauf', () => {
    expect(wissen('Was passiert nach dem 31.08.2029?').length).toBeGreaterThan(0);
  });

  it('eine reine Betragsfrage bekommt kein Fachwissen', () => {
    expect(themen('Wie hoch ist der Betrag auf diesem Dokument?')).toEqual([]);
    expect(wissen('Wie hoch ist der Betrag auf diesem Dokument?')).toEqual([]);
  });

  it('eine reine Nachschlagefrage nach der Gültigkeit bekommt kein Fachwissen', () => {
    expect(wissen('Bis wann ist die Bescheinigung gültig?')).toEqual([]);
  });

  it('eine fremde Begriffsfrage wird nicht in die Bauabzugsteuer gezogen', () => {
    expect(wissen('Was ist eine Abschlagsrechnung?')).toEqual([]);
  });

  it('ohne themenbezogenes Dokument und ohne Themenwort bleibt es leer', () => {
    const fremd = { ...FREISTELLUNG, classifiedKind: 'Mahnung', subject: 'Mahnung', purpose: 'Zahlung' };
    expect(themen('Was bedeutet dieses Schreiben für meinen Betrieb?', fremd)).toEqual([]);
  });
});

describe('B — nur geltendes Wissen wird verwendet', () => {
  it('am Prüftag ist der amtliche Bestand verwendbar', () => {
    expect(wissen('Wie bekomme ich eine neue Freistellungsbescheinigung?').length).toBeGreaterThan(
      0,
    );
  });

  it('vor dem Aufnahmetag gilt noch nichts davon — future ist keine geltende Regel', () => {
    const vorher = { ...FREISTELLUNG, asOf: '2026-09-01' };
    expect(wissen('Muss mein Auftraggeber Bauabzugsteuer einbehalten?', vorher)).toEqual([]);
  });

  it('nach Ablauf des Prüfstands gilt es nicht mehr als aktuell — stale ist keine geltende Regel', () => {
    /* Steuerregeln sind nach 180 Tagen prüfbedürftig; ein Jahr später ist nichts mehr frisch. */
    const spaeter = { ...FREISTELLUNG, asOf: '2027-09-20' };
    expect(wissen('Muss mein Auftraggeber Bauabzugsteuer einbehalten?', spaeter)).toEqual([]);
  });
});

describe('C — der Bestand selbst', () => {
  it('jede Aussage hat eine auffindbare Quelle', () => {
    const ids = new Set(DOMAIN_KNOWLEDGE_SOURCES.map((quelle) => quelle.id));
    for (const statement of DOMAIN_KNOWLEDGE_STATEMENTS) {
      expect(ids.has(statement.sourceId), statement.id).toBe(true);
    }
  });

  it('jede amtliche Quelle hat eine https-Adresse und ist nicht als kuratiert kleingeredet', () => {
    for (const quelle of DOMAIN_KNOWLEDGE_SOURCES) {
      if (quelle.trust === 'curated_secondary') continue;
      expect(sichereQuellenadresse(quelle.url), quelle.id).toBe(true);
      expect(['official_primary', 'official_guidance'], quelle.id).toContain(quelle.trust);
    }
  });

  it('die Betragsgrenzen des § 48 Abs. 2 sind bewusst nicht im Bestand', () => {
    const text = DOMAIN_KNOWLEDGE_STATEMENTS.map((s) => s.statement).join(' ');
    expect(text).not.toContain('5.000');
    expect(text).not.toContain('15 000');
    expect(text).not.toContain('15.000');
  });
});

describe('D — der Prompt trennt Dokument und Regel', () => {
  const basis: DocumentAiContext = {
    sourceType: 'inbox',
    title: 'Freistellungsbescheinigung',
    issuerOrSender: 'Finanzamt Musterstadt',
    category: 'Behörde',
    recognizedDataLines: [],
    missingDocuments: [],
    tags: [],
    uncertainFieldNotes: [],
    missingFieldNotes: [],
  };

  it('mit Fachwissen entsteht ein eigener Abschnitt mit Kennungen und Regeln', () => {
    const treffer = wissen('Muss mein Auftraggeber Bauabzugsteuer einbehalten?');
    const prompt = buildDocumentAiPrompt('Muss mein Auftraggeber Bauabzugsteuer einbehalten?', {
      ...basis,
      knowledge: treffer,
    }, 'de');

    expect(prompt).toContain('BELEGTES FACHWISSEN');
    expect(prompt).toContain('NICHT aus diesem Dokument');
    expect(prompt).toContain('[stmt-estg48-steuerabzug-15]');
    expect(prompt).toContain('Ergaenze nichts aus eigenem Wissen');
    expect(prompt).toContain('nicht als Feststellung auf diesen Betrieb an');
    expect(prompt).toContain('usedKnowledgeStatementIds');
  });

  it('ohne Fachwissen sieht der Prompt aus wie bisher', () => {
    const prompt = buildDocumentAiPrompt('Wie hoch ist der Betrag?', basis, 'de');
    expect(prompt).not.toContain('BELEGTES FACHWISSEN');
  });
});

describe('E — was das Modell behauptet, wird geprüft', () => {
  const angeboten = () => wissen('Muss mein Auftraggeber Bauabzugsteuer einbehalten?');

  it('der Parser liest die genannten Kennungen', () => {
    const parsed = parseDocumentAiAnswer(
      JSON.stringify({
        directAnswer: 'Allgemein gilt ein Steuerabzug.',
        explanation: 'Näheres siehe Quelle.',
        usedKnowledgeStatementIds: ['stmt-estg48-steuerabzug-15'],
      }),
    );
    expect(parsed.usedKnowledgeStatementIds).toEqual(['stmt-estg48-steuerabzug-15']);
  });

  it('eine erfundene Kennung wird verworfen', () => {
    expect(verifyUsedKnowledge(['stmt-gibt-es-nicht'], angeboten())).toEqual([]);
  });

  it('eine echte, aber nicht vorgelegte Kennung wird verworfen', () => {
    expect(verifyUsedKnowledge(['stmt-abschlagsrechnung'], angeboten())).toEqual([]);
  });

  it('die Adresse stammt aus dem Bestand, nicht aus dem Modelltext', () => {
    const belege = verifyUsedKnowledge(['stmt-estg48-steuerabzug-15'], angeboten());
    expect(belege).toHaveLength(1);
    expect(belege[0]?.url).toBe('https://www.gesetze-im-internet.de/estg/__48.html');
    expect(belege[0]?.publisher).toContain('gesetze-im-internet');
    expect(belege[0]?.reviewedAt).toBe(HEUTE);
  });

  it('ohne genannte Kennungen gibt es keine Quellenanzeige', () => {
    expect(verifyUsedKnowledge(undefined, angeboten())).toEqual([]);
    expect(verifyUsedKnowledge([], angeboten())).toEqual([]);
  });
});

describe('F — Adressen', () => {
  it('nur https wird verlinkt', () => {
    expect(sichereQuellenadresse('https://www.bzst.de/x')).toBe(true);
    expect(sichereQuellenadresse('http://www.bzst.de/x')).toBe(false);
    expect(sichereQuellenadresse('javascript:alert(1)')).toBe(false);
    expect(sichereQuellenadresse('data:text/html,<b>x</b>')).toBe(false);
    expect(sichereQuellenadresse('kein-link')).toBe(false);
    expect(sichereQuellenadresse(undefined)).toBe(false);
  });
});

describe('G — die Schranken aus 01H2 und 01H2B bleiben', () => {
  it('der Serverguard ist für document_question weiterhin verdrahtet', () => {
    expect(isServerClaimGuardedOperation('document_question')).toBe(true);
  });

  it('eine Quelle erlaubt keine Einzelfallentscheidung', () => {
    const ergebnis = validateAiOutput(
      'Nach § 48 EStG gilt allgemein ein Steuerabzug. Sie müssen keine Bauabzugsteuer zahlen, das ist rechtlich geklärt.',
      'qa',
    );
    expect(ergebnis.safeText).toBeDefined();
    expect(ergebnis.safeText).not.toContain('rechtlich geklärt');
  });
});
