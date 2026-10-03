/**
 * VORGANG-INTELLIGENCE — deterministic document → Vorgang matching.
 * Presentation only: no storage, no domain mutation, no AI.
 */
import type {
  DocumentCaseMatch,
  DocumentCaseMatchCandidate,
  DocumentCaseMatchReasonId,
  DocumentCaseMatchStatus,
  DocumentOwnReference,
} from '../types/documentCaseMatch';
import { getInboxExtractedDocumentText } from './inboxDocumentText';
import type { ClassifiedDocumentKind, InboxItem, Vorgang } from '../types/models';
import { getAllVorgaenge, getVorgangById } from './vorgangService';
import { pickExternalCustomerName } from './customerOwnCompanyGuard';

/**
 * INBOX-CONTRACT-SECOND-UPLOAD-01B — Vertragsrollen im Fallabgleich.
 *
 * Bei einem Vertrag ist die Gegenpartei der Auftraggeber/Kunde; der Absender
 * des Dokuments kann der Kunde **oder** die eigene Firma (Auftragnehmer) sein.
 * Deshalb darf `item.sender` hier nicht pauschal „Lieferant" bedeuten, und die
 * eigene Betreiberfirma ist nie die Gegenpartei. Die Own-Company-Erkennung
 * ist dieselbe wie beim Vorgangsentwurf (`pickExternalCustomerName`).
 * Lieferantensemantik (Eingangsrechnung, Lieferschein, Tankbeleg, …) bleibt
 * unveraendert.
 */
const CONTRACT_CASE_KINDS: ReadonlySet<ClassifiedDocumentKind> = new Set([
  'werkvertrag',
  'subunternehmervertrag',
  'nachunternehmervertrag',
  'auftrag',
]);

export function isContractCaseItem(item: InboxItem): boolean {
  return (
    (item.classifiedKind !== undefined && CONTRACT_CASE_KINDS.has(item.classifiedKind)) ||
    item.documentType === 'kundenauftrag'
  );
}

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
  const contract = isContractCaseItem(item);
  // Vertrag: Gegenpartei aus den Vertragsrollen, eigene Firma nie; Absender als letzter Kandidat.
  const customer = contract
    ? pickExternalCustomerName([rd.Auftraggeber, rd.Kunde, rd.Empfänger, item.sender]) || undefined
    : firstNonEmpty(rd.Auftraggeber, rd.Kunde, rd.Empfänger);
  // Vertrag: nur ein ausdrueckliches Lieferantenfeld zaehlt — der Absender ist kein Lieferant.
  const supplier = contract
    ? firstNonEmpty(rd.Lieferant, rd.Tankstelle)
    : firstNonEmpty(rd.Lieferant, rd.Absender, rd.Tankstelle, item.sender);
  return {
    project: firstNonEmpty(rd.Bauvorhaben, rd.Projekt),
    site: firstNonEmpty(rd.Baustelle, rd.Baustellenadresse),
    customer,
    contractNumber: firstNonEmpty(
      rd.Vertragsnummer,
      rd.Vertragsnr,
      rd.Auftragsnummer,
      rd.Auftragnummer,
    ),
    invoiceNumber: firstNonEmpty(rd.Rechnungsnummer, rd.Belegnummer),
    supplier,
    subject: firstNonEmpty(rd.Betreff, item.title),
    reference: firstNonEmpty(rd.Aktenzeichen, rd.Az, rd.Beitragsnummer, rd.Schadennummer, rd.Referenz),
    /*
     * EINGANG-01C-1 — nur eine bestätigte Verknüpfung (`linked`/`created`) ist
     * ein bekannter Link. Eine nackte `vorgangId` (Alt-/Mock-Daten, nie bestätigt)
     * ist kein Identitätsbeweis und erzeugt kein `exact`.
     */
    knownCaseId:
      item.vorgangLinkStatus === 'linked' || item.vorgangLinkStatus === 'created'
        ? item.vorgangId?.trim() || undefined
        : undefined,
  };
}

/*
 * EINGANG-01C-1 — eigene Nummern als vollständige Tokens.
 *
 * Eigene Nummern (Auftrag AU-…, Angebot AN-…, Rechnung nach Nummernformat)
 * bestehen nur aus Buchstaben, Ziffern und Bindestrichen. Ein Token ist daher
 * eine Folge aus [A-Z0-9-]; alles andere trennt. Bewusst keine weitere
 * Normalisierung: Präfixe, Bindestriche und Buchstaben bleiben Teil der Nummer.
 * Nur typografische Striche (‐ ‑ ‒ – — −) werden zu „-" — sie sind derselbe
 * Trenner, kein anderes Zeichen. `AU-2026-0012` bleibt so von `2026-0012`
 * verschieden, und aus `RE-2026-0012` entsteht kein Teiltreffer „0012".
 */
function canonicalReference(value: string | undefined | null): string | null {
  const canonical = (value ?? '').replace(/[\u2010-\u2015\u2212]/g, '-').trim().toUpperCase();
  return /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/.test(canonical) && /\d/.test(canonical) ? canonical : null;
}

function referenceTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const raw of text.replace(/[\u2010-\u2015\u2212]/g, '-').toUpperCase().split(/[^A-Z0-9-]+/)) {
    const token = canonicalReference(raw.replace(/^-+|-+$/g, ''));
    if (token) tokens.add(token);
  }
  return tokens;
}

type OwnReferenceHit = { kind: DocumentOwnReference['kind'] | 'invoice'; value: string; vorgangId: string };

/** Die Nummern, die das Dokument selbst trägt (Absender-Rechnung/-Beleg) — keine Referenz auf Eigenes. */
function issuerNumbers(item: InboxItem): Set<string> {
  const rd = item.recognizedData;
  return new Set(
    [rd.Rechnungsnummer, rd.Belegnummer].map(canonicalReference).filter((value): value is string => value !== null),
  );
}

/**
 * Alle Stellen, an denen das Dokument eine eigene Nummer als ganzes Token nennt:
 * strukturierte Felder und gespeicherter Text. Auftrags- und Angebotsnummern
 * sind deterministisch; Rechnungsnummern nur Vorschlag (am Eingang gibt es
 * keinen Kundenbeweis, und fremde Nummernkreise gleichen oft dem eigenen).
 */
export function resolveOwnReferenceHits(item: InboxItem, pool: Vorgang[]): OwnReferenceHit[] {
  const rd = item.recognizedData;
  const text = [
    ...Object.entries(rd)
      .filter(([key]) => !key.startsWith('_'))
      .map(([, value]) => value),
    getInboxExtractedDocumentText(item),
  ].join('\n');
  const tokens = referenceTokens(text);
  if (tokens.size === 0) return [];
  const ownIssuer = issuerNumbers(item);
  const hits: OwnReferenceHit[] = [];
  for (const vorgang of pool) {
    const order = canonicalReference(vorgang.orderNumber);
    if (order && tokens.has(order) && !ownIssuer.has(order)) hits.push({ kind: 'order', value: order, vorgangId: vorgang.id });
    const offer = canonicalReference(vorgang.sourceOfferNumber);
    if (offer && tokens.has(offer) && !ownIssuer.has(offer)) hits.push({ kind: 'offer', value: offer, vorgangId: vorgang.id });
    for (const invoice of vorgang.invoices ?? []) {
      const number = canonicalReference(invoice.number);
      if (number && tokens.has(number)) hits.push({ kind: 'invoice', value: number, vorgangId: vorgang.id });
    }
  }
  return hits;
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
  referenceHits: OwnReferenceHit[] = [],
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

  /*
   * EINGANG-01C-1 (P1) — Nummern nur noch als ganze eigene Nummer.
   *
   * Bisher genügte ein Teilstring in beide Richtungen (`equalsLoose`) gegen
   * Titel, Positionen und die EIGENEN Ausgangsrechnungen — und ein einzelner
   * solcher Treffer galt als „exact". Die Lieferanten-Rechnungsnummer
   * `2026-0012` verknüpfte so ein Eingangsdokument mit dem Vorgang der eigenen
   * Rechnung `2026-0012`. Jetzt:
   *  * `same_contract_number` nur für die eigene Auftrags-/Angebotsnummer als
   *    ganzes Token (deterministisch);
   *  * `same_invoice_number` nur für eine eigene Rechnungsnummer als ganzes
   *    Token — und auch dann nur Vorschlag;
   *  * die frühere unscharfe Nummernähnlichkeit bleibt als `same_reference`
   *    (Vorschlag), nie als sichere Zuordnung.
   */
  const ownHits = referenceHits.filter((hit) => hit.vorgangId === vorgang.id);
  if (ownHits.some((hit) => hit.kind === 'order' || hit.kind === 'offer')) {
    reasons.push('same_contract_number');
  } else if (signals.contractNumber) {
    const hay = vorgangHaystack(vorgang);
    if (equalsLoose(signals.contractNumber, hay) || tokensOverlap(signals.contractNumber, hay, 4)) {
      reasons.push('same_reference');
    }
  }

  if (ownHits.some((hit) => hit.kind === 'invoice')) {
    reasons.push('same_invoice_number');
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

/*
 * EINGANG-01C-1 — Gründe, die nie zu „exact" beitragen dürfen: Nummern und
 * Nummernähnlichkeit. Eine eigene Auftrags-/Angebotsnummer wird gesondert und
 * vorrangig entschieden (`resolveDeterministicReference`); Rechnungsnummern
 * und unscharfe Referenzen bleiben Vorschlag — auch nicht zusammen mit einem
 * gleichen Kundennamen (die frühere Hintertür über die Punktsumme).
 */
const NUMBER_REASONS: ReadonlySet<DocumentCaseMatchReasonId> = new Set([
  'same_contract_number',
  'same_invoice_number',
  'same_reference',
]);

function nonNumberScore(candidate: DocumentCaseMatchCandidate): number {
  return candidate.reasons
    .filter((reason) => !NUMBER_REASONS.has(reason))
    .reduce((sum, reason) => sum + WEIGHT[reason], 0);
}

/*
 * EINGANG-01C-1 (P1-A) — die frühere Namens-/Baustellenregel.
 *
 * Kunde+Baustelle, Projekt+Kunde oder Nicht-Nummern-Punkte ≥ 50 beruhen auf
 * `equalsLoose` (Teilstring in beide Richtungen) — „Müller" ⊂ „Familie Müller",
 * „Berlin" ⊂ „Hauptstr. 12, Berlin". Das beweist keine Identität: Ein
 * Stammkunde mit neuem Auftrag an derselben Adresse ist ein neuer Vorgang.
 * Diese Kandidaten bleiben für Rangfolge und Konflikterkennung „stark", werden
 * aber höchstens `likely` (bzw. `multiple`) — nie `exact`.
 */
function isStrongFuzzyCandidate(candidate: DocumentCaseMatchCandidate): boolean {
  return (
    nonNumberScore(candidate) >= EXACT_SCORE ||
    (candidate.reasons.includes('same_project') && candidate.reasons.includes('same_customer')) ||
    (candidate.reasons.includes('same_site') && candidate.reasons.includes('same_customer'))
  );
}

function isInvoiceOrDeliveryLike(item: InboxItem): boolean {
  const kind = item.classifiedKind;
  const docType = item.documentType;
  return (
    kind === 'eingangsrechnung' ||
    kind === 'rechnung' ||
    kind === 'lieferschein' ||
    docType === 'eingangsrechnung'
  );
}

function shouldPromoteLikelyToMultiple(
  item: InboxItem,
  primary: DocumentCaseMatchCandidate,
): boolean {
  if (!isInvoiceOrDeliveryLike(item)) return false;
  // EINGANG-01C-1 — nur eine bekannte Verknüpfung oder eigene Auftrags-/Angebotsnummer ist deterministisch.
  if (primary.reasons.includes('known_link') || primary.reasons.includes('same_contract_number')) {
    return false;
  }
  // For invoice-/delivery-like documents, a non-deterministic link must be confirmed explicitly.
  return primary.score >= LIKELY_SCORE;
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

  // Nur eine bestätigte Verknüpfung ist hier `exact` (knownCaseId ist nur dann gesetzt).
  if (top.reasons.includes('known_link')) {
    return { status: 'exact', primary: top, cluster: [top] };
  }

  const strongFuzzy = isStrongFuzzyCandidate(top);
  const strongPeers = cluster.filter(isStrongFuzzyCandidate);

  // Mehrere starke unscharfe Kandidaten: mehrdeutig.
  if (strongPeers.length >= 2) {
    return { status: 'multiple', primary: top, cluster };
  }

  // EINGANG-01C-1 (P1-A) — ein einzelner starker unscharfer Kandidat ist ein Vorschlag.
  if (strongFuzzy) {
    return { status: 'likely', primary: top, cluster: [top] };
  }

  if (cluster.length >= 2) {
    return { status: 'multiple', primary: top, cluster };
  }

  if (top.score >= LIKELY_SCORE) {
    return { status: 'likely', primary: top, cluster: [top] };
  }

  return { status: 'none', primary: null, cluster: [] };
}

/**
 * EINGANG-01C-1 — die deterministische Stufe, vor jeder Punktwertung.
 *
 * Exakt ist ein Vorgang nur, wenn das Dokument genau EINEN Vorgang über eine
 * eigene Auftrags-/Angebotsnummer nennt und nichts dagegen spricht. Fail-closed
 * (`multiple`, keine automatische Zuordnung) bei:
 *  * eigenen Referenzen auf mehrere Vorgänge;
 *  * derselben oder einer weiteren eigenen Rechnungsnummer eines anderen Vorgangs
 *    (z. B. eine Nummer, die Auftrag von A und Rechnung von B ist);
 *  * einem anderen Vorgang, der nach der bestehenden Namens-/Baustellenregel
 *    ebenfalls sicher wäre.
 * Ohne eigene Auftrags-/Angebotsnummer: `null` — die übrige Wertung entscheidet,
 * und die kann aus Nummern allein nie mehr „exact" machen.
 */
function resolveDeterministicReference(
  hits: OwnReferenceHit[],
  ranked: DocumentCaseMatchCandidate[],
): DocumentCaseMatch | null {
  const deterministicHits = hits.filter((hit) => hit.kind === 'order' || hit.kind === 'offer');
  if (deterministicHits.length === 0) return null;
  const referencedIds = [...new Set(deterministicHits.map((hit) => hit.vorgangId))];
  const conflictingIds = new Set<string>(referencedIds);
  for (const hit of hits) if (hit.kind === 'invoice') conflictingIds.add(hit.vorgangId);
  for (const candidate of ranked) if (isStrongFuzzyCandidate(candidate)) conflictingIds.add(candidate.caseId);

  const byId = new Map(ranked.map((candidate) => [candidate.caseId, candidate]));
  if (conflictingIds.size > 1) {
    const candidates = [...conflictingIds]
      .map((id) => byId.get(id))
      .filter((candidate): candidate is DocumentCaseMatchCandidate => candidate !== undefined);
    return {
      matchStatus: 'multiple',
      matchedCaseId: null,
      matchedCaseTitle: null,
      reasons: [...new Set(candidates.flatMap((candidate) => candidate.reasons))],
      candidates,
    };
  }

  const primary = byId.get(referencedIds[0]!);
  if (!primary) return null;
  const hit = deterministicHits[0]!;
  return {
    matchStatus: 'exact',
    matchedCaseId: primary.caseId,
    matchedCaseTitle: primary.caseTitle,
    reasons: primary.reasons,
    candidates: [primary],
    reference: { kind: hit.kind as DocumentOwnReference['kind'], value: hit.value },
  };
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

  const referenceHits = resolveOwnReferenceHits(item, pool);
  const ranked = pool
    .map((vorgang) => scoreVorgang(signals, vorgang, referenceHits))
    .filter((c): c is DocumentCaseMatchCandidate => c != null)
    .sort((a, b) => b.score - a.score || a.caseTitle.localeCompare(b.caseTitle));

  const deterministic = resolveDeterministicReference(referenceHits, ranked);
  if (deterministic) return deterministic;

  const decision = decideStatus(ranked);

  if (
    decision.status === 'likely' &&
    decision.primary &&
    shouldPromoteLikelyToMultiple(item, decision.primary)
  ) {
    return {
      matchStatus: 'multiple',
      matchedCaseId: null,
      matchedCaseTitle: null,
      reasons: decision.primary.reasons,
      candidates: ranked.filter((candidate) => candidate.score >= LIKELY_SCORE),
    };
  }

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
