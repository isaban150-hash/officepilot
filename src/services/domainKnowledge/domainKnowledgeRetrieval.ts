/**
 * DOKUMENT-ASSISTENT-01H1 — die Suche im kuratierten Bestand.
 *
 * Eine Funktion, kein Apparat. Es gibt nichts abzurufen ausser einer kleinen
 * Liste im Programm; ein Retrieval-System dafür zu bauen hiesse, Architektur
 * für eine Zukunft zu erfinden, die noch niemand gesehen hat.
 *
 * Zwei Rückgaben, weil sie zwei verschiedene Fragen beantworten:
 *
 *   `all`    — alles Passende samt Zustand. Für Prüfung und Wartung: Woran
 *              liegt es, dass hier nichts ankommt?
 *   `usable` — nur das, was als geltendes Fachwissen dienen darf. Das ist,
 *              was ein späterer Oberflächenblock verwenden wird.
 *
 * Getrennt, damit 01H3 nicht versehentlich aus der Diagnoseliste zitiert.
 *
 * **Dieser Block zeigt noch nichts an.** Es gibt keine Anbindung an den
 * Dokument-Assistenten, keinen Prompt, keine gelockerte Schranke.
 */
import type {
  KnowledgeHit,
  KnowledgeJurisdiction,
  KnowledgeSource,
  KnowledgeStatement,
} from '../../types/domainKnowledge';
import {
  DOMAIN_KNOWLEDGE_SOURCES,
  DOMAIN_KNOWLEDGE_STATEMENTS,
} from './domainKnowledgeRegistry';
import { evaluateKnowledgeFreshness } from './knowledgeFreshnessPolicy';

export interface KnowledgeQuery {
  /** Das gesuchte Sachthema; auch Aliasse treffen. */
  topic?: string;
  /** Wofür die Aussage gelten soll. */
  jurisdiction?: KnowledgeJurisdiction;
  /** Der Stichtag. Immer ausdrücklich — nie heimlich die Uhr lesen. */
  asOf: string;
}

export interface KnowledgeQueryResult {
  /** Alle Treffer mit ihrem Zustand — für Diagnose und Wartung. */
  all: KnowledgeHit[];
  /** Nur die, die als geltendes Fachwissen dienen dürfen. */
  usable: KnowledgeHit[];
}

/**
 * Eigener Bestand statt des ausgelieferten — für Tests und später für
 * serverseitig geliefertes Wissen. Die fachliche Struktur bleibt dieselbe;
 * deshalb muss 01H4 nichts an diesem Modell ändern.
 */
export interface KnowledgeStock {
  statements: readonly KnowledgeStatement[];
  sources: readonly KnowledgeSource[];
}

function normalisiere(wert: string): string {
  return wert
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, '');
}

function trifftThema(statement: KnowledgeStatement, gesucht: string): boolean {
  const ziel = normalisiere(gesucht);
  if (!ziel) return true;
  if (normalisiere(statement.topic) === ziel) return true;
  return (statement.aliases ?? []).some((alias) => normalisiere(alias) === ziel);
}

/**
 * Passt die Aussage zur gefragten Rechtsordnung?
 *
 * Das Land muss stimmen. Eine bundesweite Aussage (ohne `region`) passt auch
 * dann, wenn nach einem Bundesland gefragt wird — eine Aussage **für** ein
 * Bundesland dagegen nicht, wenn nach einem anderen gefragt wird.
 */
function trifftRechtsordnung(
  quelle: KnowledgeSource,
  gesucht: KnowledgeJurisdiction | undefined,
): boolean {
  if (!gesucht) return true;
  if (quelle.jurisdiction.country !== gesucht.country) return false;
  if (!quelle.jurisdiction.region) return true;
  return quelle.jurisdiction.region === gesucht.region;
}

export function findKnowledgeStatements(
  query: KnowledgeQuery,
  stock: KnowledgeStock = {
    statements: DOMAIN_KNOWLEDGE_STATEMENTS,
    sources: DOMAIN_KNOWLEDGE_SOURCES,
  },
): KnowledgeQueryResult {
  const quellen = new Map(stock.sources.map((quelle) => [quelle.id, quelle]));
  const all: KnowledgeHit[] = [];

  for (const statement of stock.statements) {
    if (query.topic !== undefined && !trifftThema(statement, query.topic)) continue;

    const quelle = quellen.get(statement.sourceId);
    if (quelle && !trifftRechtsordnung(quelle, query.jurisdiction)) continue;

    /*
     * Eine Aussage ohne auffindbare Quelle wird nicht verschwiegen — sie
     * erscheint in der Diagnose als `unverified`. Stilles Wegfallen würde
     * einen Pflegefehler unsichtbar machen.
     */
    const freshness = evaluateKnowledgeFreshness(statement, quelle, query.asOf);
    all.push({ statement, source: quelle ?? fehlendeQuelle(statement.sourceId), freshness });
  }

  return { all, usable: all.filter((treffer) => treffer.freshness.usableAsCurrent) };
}

/** Ein Platzhalter, der sich als solcher zu erkennen gibt. */
function fehlendeQuelle(id: string): KnowledgeSource {
  return {
    id,
    title: '(Quelle nicht im Bestand)',
    publisher: '(unbekannt)',
    kind: 'internal_curated',
    trust: 'curated_secondary',
    jurisdiction: { country: 'DE' },
  };
}
