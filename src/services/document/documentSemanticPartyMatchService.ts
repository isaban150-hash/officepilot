/**
 * DOKUMENTVERSTAENDNIS-01B — Kunden- und Auftragskandidaten aus dem Text.
 *
 * Der Anlass ist ein belegter Fehlschlag: Eine Mängelanzeige nannte im Kopf
 * „Westfalen Projektbau GmbH" — einen bestehenden Kunden — und im Betreff
 * „Bauvorhaben Gewerbepark Senne, Gebäude B" — einen bestehenden Auftrag.
 * OfficeTakt meldete trotzdem „Gegenpartei unklar. Vorgangsbezug unklar", weil
 * die vorhandene Zuordnung erst nach erfolgreicher Klassifikation greift und
 * die Dokumentart hier „Sonstiges" war.
 *
 * Dieser Dienst kennt die Dokumentart nicht und fragt auch nicht danach. Er
 * vergleicht Namen mit dem Bestand und begründet jeden Treffer.
 *
 * **Er verknüpft nichts.** Das Ergebnis sind Vorschläge mit Begründung; die
 * Verknüpfung bleibt eine Entscheidung des Benutzers. Bei zwei fast gleich
 * guten Treffern wird bewusst keiner bevorzugt.
 */
import type { SemanticPartyCandidate } from '../../types/documentSemanticCore';
import type { Customer, Vorgang } from '../../types/models';

/** Ab hier gilt ein Treffer als vorschlagswürdig. */
const MINDESTWERT = 0.45;
/** Liegen zwei Treffer so dicht beieinander, ist keiner belastbar. */
const ZU_KNAPP = 0.1;

const RECHTSFORMEN = /\b(gmbh|mbh|ug|ag|kg|ohg|gbr|e\.?\s?k\.?|co\.?|kgaa|se)\b/gi;
const FUELLWOERTER = new Set([
  'der', 'die', 'das', 'und', 'für', 'fuer', 'von', 'vom', 'zum', 'zur', 'des',
  'bauvorhaben', 'projekt', 'objekt', 'baustelle', 'gebäude', 'gebaeude',
]);

function normalisiere(wert: string): string {
  return wert
    .toLowerCase()
    .replace(/[^a-zäöüß0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function kernbegriffe(wert: string): string[] {
  return normalisiere(wert.replace(RECHTSFORMEN, ' '))
    .split(' ')
    .filter((w) => w.length >= 4 && !FUELLWOERTER.has(w));
}

/**
 * Wie gut passt ein Name zum Text?
 *
 * Ein vollständiger Treffer des Namenskerns zählt ganz; sonst entscheidet der
 * Anteil der wiedergefundenen Kernbegriffe. Kurze und häufige Wörter sind
 * vorher aussortiert, damit nicht „Bau" schon eine Firma findet.
 */
function bewerte(name: string, heuhaufen: string): { score: number; treffer: string[] } {
  const begriffe = kernbegriffe(name);
  if (begriffe.length === 0) return { score: 0, treffer: [] };

  const ganzerKern = begriffe.join(' ');
  if (ganzerKern.length >= 6 && heuhaufen.includes(ganzerKern)) {
    return { score: 1, treffer: begriffe };
  }

  const gefunden = begriffe.filter((b) => heuhaufen.includes(b));
  if (gefunden.length === 0) return { score: 0, treffer: [] };

  const anteil = gefunden.length / begriffe.length;
  /* Ein einzelnes Wort aus einem mehrteiligen Namen bleibt schwach. */
  const gewicht = gefunden.length === 1 && begriffe.length > 1 ? 0.6 : 1;
  return { score: anteil * gewicht, treffer: gefunden };
}

function sortiereUndFiltere(kandidaten: SemanticPartyCandidate[]): SemanticPartyCandidate[] {
  const sortiert = kandidaten
    .filter((k) => k.score >= MINDESTWERT)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  /*
   * Zwei gleich starke Treffer sind kein Ergebnis, sondern eine Frage. Beide
   * bleiben stehen — mit dem Hinweis, dass sie sich nicht unterscheiden lassen.
   */
  if (sortiert.length >= 2 && sortiert[0].score - sortiert[1].score < ZU_KNAPP) {
    return sortiert.map((k) => ({
      ...k,
      reasons: [...k.reasons, 'Mehrere Treffer liegen zu dicht beieinander — bitte selbst auswählen.'],
    }));
  }
  return sortiert;
}

export interface PartyMatchInput {
  /** Der Volltext des Schreibens. */
  text: string;
  /** Der erkannte Absender, falls vorhanden — ein zusätzlicher Hinweis. */
  sender?: string;
  customers: Customer[];
  vorgaenge: Vorgang[];
}

export interface PartyMatchResult {
  customerCandidates: SemanticPartyCandidate[];
  vorgangCandidates: SemanticPartyCandidate[];
}

export function findSemanticPartyCandidates(input: PartyMatchInput): PartyMatchResult {
  const text = input.text ?? '';
  if (!text.trim()) return { customerCandidates: [], vorgangCandidates: [] };

  const heuhaufen = normalisiere(text);
  const absender = input.sender ? normalisiere(input.sender) : '';

  const kunden: SemanticPartyCandidate[] = [];
  for (const kunde of input.customers) {
    const name = kunde.name?.trim();
    if (!name) continue;

    const imText = bewerte(name, heuhaufen);
    const imAbsender = absender ? bewerte(name, absender) : { score: 0, treffer: [] };
    const score = Math.max(imText.score, imAbsender.score);
    if (score <= 0) continue;

    const gruende: string[] = [];
    if (imAbsender.score > 0) gruende.push(`Der Absender heisst „${name}".`);
    else gruende.push(`Der Name „${name}" steht im Schreiben.`);
    if (kunde.city?.trim() && heuhaufen.includes(normalisiere(kunde.city))) {
      gruende.push(`Der Ort „${kunde.city}" kommt ebenfalls vor.`);
    }
    if (kunde.street?.trim() && heuhaufen.includes(normalisiere(kunde.street))) {
      gruende.push(`Die Anschrift stimmt überein.`);
    }

    /* Ein zweiter, unabhängiger Treffer hebt die Bewertung — aber nie über 1. */
    const bonus = Math.min(0.15 * (gruende.length - 1), 0.3);
    kunden.push({ id: kunde.id, name, score: Math.min(score + bonus, 1), reasons: gruende });
  }

  const auftraege: SemanticPartyCandidate[] = [];
  for (const vorgang of input.vorgaenge) {
    const titel = vorgang.title?.trim();
    if (!titel) continue;

    const ausTitel = bewerte(titel, heuhaufen);
    const ausBaustelle = vorgang.baustelle?.trim()
      ? bewerte(vorgang.baustelle, heuhaufen)
      : { score: 0, treffer: [] };
    const score = Math.max(ausTitel.score, ausBaustelle.score);
    if (score <= 0) continue;

    const gruende: string[] = [];
    if (ausTitel.score > 0) {
      gruende.push(`Der Auftragstitel „${titel}" findet sich im Text (${ausTitel.treffer.join(', ')}).`);
    }
    if (ausBaustelle.score > 0) gruende.push(`Die Baustelle „${vorgang.baustelle}" wird genannt.`);
    if (vorgang.customer?.trim() && heuhaufen.includes(normalisiere(vorgang.customer))) {
      gruende.push(`Der Kunde des Auftrags „${vorgang.customer}" kommt ebenfalls vor.`);
    }

    const bonus = Math.min(0.15 * (gruende.length - 1), 0.3);
    auftraege.push({ id: vorgang.id, name: titel, score: Math.min(score + bonus, 1), reasons: gruende });
  }

  return {
    customerCandidates: sortiereUndFiltere(kunden),
    vorgangCandidates: sortiereUndFiltere(auftraege),
  };
}
