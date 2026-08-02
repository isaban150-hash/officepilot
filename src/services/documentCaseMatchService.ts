/**
 * VORGANG-INTELLIGENCE — deterministic document → Vorgang matching.
 * Presentation only: no storage, no domain mutation, no AI.
 */
import type {
  DocumentCaseMatch,
  DocumentCaseMatchCandidate,
  DocumentCaseMatchReasonId,
  DocumentCaseMatchStatus,
} from '../types/documentCaseMatch';
import type { InboxItem, Vorgang } from '../types/models';
import { getAllVorgaenge, getVorgangById } from './vorgangService';

/** Priority weights (Projekt → Baustelle → Kunde → …). */
const WEIGHT: Record<DocumentCaseMatchReasonId, number> = {
  known_link: 100,
  same_project: 40,
  same_site: 30,
  same_contract_number: 35,
  same_invoice_number: 35,
  same_reference: 25,
  same_customer: 20,
  same_supplier: 10,
  same_subject: 8,
};

const EXACT_SCORE = 50;
const LIKELY_SCORE = 20;
/** Candidates within this gap of the top score count as a cluster. */
const CLUSTER_GAP = 15;

export type DocumentCaseSignals = {
  project?: string;
  site?: string;
  customer?: string;
  contractNumber?: string;
  invoiceNumber?: string;
  supplier?: string;
  subject?: string;
  reference?: string;
  knownCaseId?: string;
};

function normalize(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/ä/g, 'ae')
    .replace(/ö/g, 'oe')
    .replace(/ü/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstNonEmpty(...values: Array<string | undefined | null>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

function tokensOverlap(a: string, b: string, minTokenLength = 3): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  if (na.length >= 4 && nb.length >= 4 && (na.includes(nb) || nb.includes(na))) return true;
  const tokensA = na.split(' ').filter((t) => t.length >= minTokenLength);
  const tokensB = new Set(nb.split(' ').filter((t) => t.length >= minTokenLength));
  let hits = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) hits += 1;
  }
  return hits >= 2 || (hits === 1 && tokensA.length === 1);
}

function equalsLoose(a: string, b: string): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

/** Collect match signals from existing Inbox / RD fields only. */
export function extractDocumentCaseSignals(item: InboxItem): DocumentCaseSignals {
  const rd = item.recognizedData;
  return {
    project: firstNonEmpty(rd.Bauvorhaben, rd.Projekt),
    site: firstNonEmpty(rd.Baustelle, rd.Baustellenadresse),
    customer: firstNonEmpty(rd.Auftraggeber, rd.Kunde, rd.Empfänger),
    contractNumber: firstNonEmpty(
      rd.Vertragsnummer,
      rd.Vertragsnr,
      rd.Auftragsnummer,
      rd.Auftragnummer,
    ),
    invoiceNumber: firstNonEmpty(rd.Rechnungsnummer, rd.Belegnummer),
    supplier: firstNonEmpty(rd.Lieferant, rd.Absender, rd.Tankstelle, item.sender),
    subject: firstNonEmpty(rd.Betreff, item.title),
    reference: firstNonEmpty(rd.Aktenzeichen, rd.Az, rd.Beitragsnummer, rd.Referenz),
    knownCaseId: item.vorgangId?.trim() || undefined,
  };
}

function vorgangHaystack(vorgang: Vorgang): string {
  const parts = [
    vorgang.title,
    vorgang.customer,
    vorgang.baustelle,
    ...vorgang.documents.map((d) => d.name),
    ...vorgang.invoices.map((inv) => inv.number),
    ...vorgang.orderPositions.map((p) => p.description),
  ];
  return parts.filter(Boolean).join(' ');
}

function scoreVorgang(
  signals: DocumentCaseSignals,
  vorgang: Vorgang,
): DocumentCaseMatchCandidate | null {
  const reasons: DocumentCaseMatchReasonId[] = [];

  if (signals.knownCaseId && signals.knownCaseId === vorgang.id) {
    reasons.push('known_link');
  }
  // Prefer title identity (equalsLoose) over token-family overlap so sibling
  // projects that share a customer prefix (e.g. "Sägewerk Ernst Flisch – …")
  // do not all receive same_project from a unique Bauvorhaben string.
  if (signals.project && equalsLoose(signals.project, vorgang.title)) {
    reasons.push('same_project');
  } else if (signals.project && equalsLoose(signals.project, vorgang.baustelle)) {
    reasons.push('same_project');
  }

  if (signals.site && equalsLoose(signals.site, vorgang.baustelle)) {
    reasons.push('same_site');
  }

  if (signals.customer && equalsLoose(signals.customer, vorgang.customer)) {
    reasons.push('same_customer');
  }

  if (signals.contractNumber) {
    const hay = vorgangHaystack(vorgang);
    if (equalsLoose(signals.contractNumber, hay) || tokensOverlap(signals.contractNumber, hay, 4)) {
      reasons.push('same_contract_number');
    }
  }

  if (signals.invoiceNumber) {
    const hit = vorgang.invoices.some((inv) => equalsLoose(inv.number, signals.invoiceNumber!));
    if (hit || equalsLoose(signals.invoiceNumber, vorgang.title)) {
      reasons.push('same_invoice_number');
    }
  }

  if (signals.supplier && equalsLoose(signals.supplier, vorgang.customer)) {
    reasons.push('same_supplier');
  }

  if (signals.subject && tokensOverlap(signals.subject, vorgang.title)) {
    reasons.push('same_subject');
  }

  if (signals.reference) {
    const hay = vorgangHaystack(vorgang);
    if (tokensOverlap(signals.reference, hay, 3) || equalsLoose(signals.reference, hay)) {
      reasons.push('same_reference');
    }
  }

  if (reasons.length === 0) return null;

  const unique = [...new Set(reasons)];
  const score = unique.reduce((sum, id) => sum + WEIGHT[id], 0);
  return {
    caseId: vorgang.id,
    caseTitle: vorgang.title,
    reasons: unique,
    score,
  };
}

function isStrongExactCandidate(candidate: DocumentCaseMatchCandidate): boolean {
  return (
    candidate.score >= EXACT_SCORE ||
    (candidate.reasons.includes('same_project') && candidate.reasons.includes('same_customer')) ||
    (candidate.reasons.includes('same_site') && candidate.reasons.includes('same_customer')) ||
    candidate.reasons.includes('same_contract_number') ||
    candidate.reasons.includes('same_invoice_number')
  );
}

function decideStatus(ranked: DocumentCaseMatchCandidate[]): {
  status: DocumentCaseMatchStatus;
  primary: DocumentCaseMatchCandidate | null;
  cluster: DocumentCaseMatchCandidate[];
} {
  if (ranked.length === 0) {
    return { status: 'none', primary: null, cluster: [] };
  }

  const top = ranked[0]!;
  const cluster = ranked.filter((c) => top.score - c.score <= CLUSTER_GAP && c.score >= LIKELY_SCORE);

  if (top.reasons.includes('known_link')) {
    return { status: 'exact', primary: top, cluster: [top] };
  }

  const strongExact = isStrongExactCandidate(top);
  const exactPeers = cluster.filter(isStrongExactCandidate);

  // Ambiguous only when ≥2 exact-quality peers compete — a lone strongExact
  // must not be downgraded just because weaker likely peers sit nearby.
  if (exactPeers.length >= 2) {
    return { status: 'multiple', primary: top, cluster };
  }

  if (strongExact) {
    return { status: 'exact', primary: top, cluster: [top] };
  }

  if (cluster.length >= 2) {
    return { status: 'multiple', primary: top, cluster };
  }

  if (top.score >= LIKELY_SCORE) {
    return { status: 'likely', primary: top, cluster: [top] };
  }

  return { status: 'none', primary: null, cluster: [] };
}

export function emptyDocumentCaseMatch(): DocumentCaseMatch {
  return {
    matchStatus: 'none',
    matchedCaseId: null,
    matchedCaseTitle: null,
    reasons: [],
    candidates: [],
  };
}

/**
 * Deterministic match against existing Vorgänge.
 * Never mutates domain state.
 */
export function buildDocumentCaseMatch(
  item: InboxItem,
  candidates?: Vorgang[],
): DocumentCaseMatch {
  const signals = extractDocumentCaseSignals(item);
  const pool = candidates ?? getAllVorgaenge();

  // Known link short-circuit (still verify the Vorgang exists).
  if (signals.knownCaseId) {
    const linked = getVorgangById(signals.knownCaseId) ?? pool.find((v) => v.id === signals.knownCaseId);
    if (linked) {
      const scored = scoreVorgang(signals, linked) ?? {
        caseId: linked.id,
        caseTitle: linked.title,
        reasons: ['known_link' as const],
        score: WEIGHT.known_link,
      };
      if (!scored.reasons.includes('known_link')) {
        scored.reasons = ['known_link', ...scored.reasons];
        scored.score += WEIGHT.known_link;
      }
      return {
        matchStatus: 'exact',
        matchedCaseId: linked.id,
        matchedCaseTitle: linked.title,
        reasons: scored.reasons,
        candidates: [scored],
      };
    }
  }

  const ranked = pool
    .map((vorgang) => scoreVorgang(signals, vorgang))
    .filter((c): c is DocumentCaseMatchCandidate => c != null)
    .sort((a, b) => b.score - a.score || a.caseTitle.localeCompare(b.caseTitle));

  const decision = decideStatus(ranked);

  if (decision.status === 'none' || !decision.primary) {
    return emptyDocumentCaseMatch();
  }

  if (decision.status === 'multiple') {
    return {
      matchStatus: 'multiple',
      matchedCaseId: null,
      matchedCaseTitle: null,
      reasons: decision.primary.reasons,
      candidates: decision.cluster,
    };
  }

  return {
    matchStatus: decision.status,
    matchedCaseId: decision.primary.caseId,
    matchedCaseTitle: decision.primary.caseTitle,
    reasons: decision.primary.reasons,
    candidates: decision.cluster,
  };
}
