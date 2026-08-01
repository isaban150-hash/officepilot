/**
 * REFERENZVERTRAG V1 – SPRINT C
 * Deterministic Gewerk + Hauptleistungen from existing CI / LV data.
 * No AI, no LLM, no new extraction engine.
 */
import type { ContractIntelligenceResult } from '../types/documentIntelligence';
import type { DetectedOrderPosition, OrderPosition } from '../types/models';

export type KnownGewerk =
  | 'Dachabdichtung'
  | 'Trockenbau'
  | 'Elektro'
  | 'Sanitär'
  | 'Malerarbeiten'
  | 'Rohbau'
  | 'Estrich'
  | 'Fliesenarbeiten'
  | 'Zimmererarbeiten';

export type ContractScopeDerivation = {
  gewerk?: KnownGewerk;
  hauptleistungen: string[];
};

type GewerkRule = { gewerk: KnownGewerk; patterns: RegExp[] };

/** Highest pattern-hit score wins; Dachabdichtung rules are rich for WV-LV-01. */
const GEWERK_RULES: GewerkRule[] = [
  {
    gewerk: 'Dachabdichtung',
    patterns: [
      /abdicht/i,
      /flachdach/i,
      /steildach/i,
      /pvc[- ]?folie/i,
      /dachfolie/i,
      /bitumen/i,
      /dachbahn/i,
      /lichtkuppel/i,
      /attika/i,
      /traufanschluss/i,
      /gefälle\s*dämmung|gefaelle\s*daemmung|gefälledämmung|gefaelledaemmung/i,
      /randdämmung|randdaemmung/i,
      /dachdurchführung|dachdurchfuehrung/i,
      /dachsanierung/i,
    ],
  },
  {
    gewerk: 'Trockenbau',
    patterns: [/trockenbau/i, /gipskarton/i, /\brigips\b/i, /ständerwerk|staenderwerk/i],
  },
  {
    gewerk: 'Elektro',
    patterns: [/\belektro\b/i, /elektroinstall/i, /kabelkanal/i, /unterverteilung/i],
  },
  {
    gewerk: 'Sanitär',
    patterns: [/sanitär|sanitaer/i, /\bheizung\b/i, /badezimmer/i, /rohrleitung/i, /waschbecken/i],
  },
  {
    gewerk: 'Malerarbeiten',
    patterns: [/\bmaler/i, /anstrich/i, /tapezier/i, /spachtelarbeit/i],
  },
  {
    gewerk: 'Rohbau',
    patterns: [/\brohbau\b/i, /maurerarbeit/i, /betonarbeit/i, /schalung/i],
  },
  {
    gewerk: 'Estrich',
    patterns: [/\bestrich\b/i],
  },
  {
    gewerk: 'Fliesenarbeiten',
    patterns: [/fliesen/i, /plattenbelag/i],
  },
  {
    gewerk: 'Zimmererarbeiten',
    patterns: [/zimmerer/i, /zimmermann/i, /dachkonstruktion/i, /dachstuhl/i],
  },
];

type HauptleistungRule = {
  label: string;
  pattern: RegExp;
  /** Skip noisy / auxiliary positions. */
  skip?: boolean;
};

/**
 * Ordered rules — first match wins per position; labels are deduped later preserving order.
 * WV-LV-01 canonical labels live here.
 */
const HAUPTLEISTUNG_RULES: HauptleistungRule[] = [
  { label: '', pattern: /kleinmaterial|hilfsmittel/i, skip: true },
  { label: 'PE-Folie', pattern: /pe[- ]?folie/i },
  { label: 'PVC-Dachfolie', pattern: /pvc[- ]?folie|dachfolie/i },
  { label: 'Traufanschlüsse', pattern: /traufanschluss/i },
  { label: 'Attikaanschlüsse', pattern: /attikaanschluss/i },
  { label: 'Lichtkuppeln', pattern: /lichtkuppel/i },
  { label: 'Randdämmung', pattern: /randdämmung|randdaemmung/i },
  { label: 'Gefälledämmung', pattern: /gefälledämmung|gefaelledaemmung|gefälle\s*dämmung/i },
  { label: 'Anschlussbleche', pattern: /anschlussblech/i },
  { label: 'Dachdurchführungen', pattern: /dachdurchführung|dachdurchfuehrung/i },
  { label: 'Wärmedämmung', pattern: /\bdämmung\b|\bdaemmung\b|wärmedämmung|waermedaemmung/i },
  { label: 'Dachabdichtung', pattern: /\bdachabdichtung\b|abdichtungsarbeit/i },
];

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function scoreGewerk(haystack: string, rule: GewerkRule): number {
  let score = 0;
  for (const pattern of rule.patterns) {
    if (pattern.test(haystack)) score += 1;
  }
  return score;
}

export function deriveGewerk(input: {
  vertragsgegenstand?: string;
  leistungsbeschreibung?: string;
  positionDescriptions?: string[];
}): KnownGewerk | undefined {
  const parts = [
    input.vertragsgegenstand,
    input.leistungsbeschreibung,
    ...(input.positionDescriptions ?? []),
  ]
    .map((part) => (part ? normalizeText(part) : ''))
    .filter(Boolean);

  if (parts.length === 0) return undefined;

  const haystack = parts.join('\n');
  let best: { gewerk: KnownGewerk; score: number } | undefined;

  for (const rule of GEWERK_RULES) {
    const score = scoreGewerk(haystack, rule);
    if (score === 0) continue;
    if (!best || score > best.score) {
      best = { gewerk: rule.gewerk, score };
    }
  }

  return best?.gewerk;
}

function fallbackHauptleistungLabel(description: string): string {
  const cleaned = normalizeText(description)
    .replace(/^\d+\s*[–\-.:)]\s*/, '')
    .replace(/\b(verlegen|eindichten|liefern|montieren|herstellen|einbauen)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return normalizeText(description).slice(0, 40);
  const words = cleaned.split(' ').filter(Boolean);
  return words.slice(0, 3).join(' ');
}

export function deriveHauptleistungen(
  descriptions: Array<string | undefined | null>,
): string[] {
  const labels: string[] = [];
  const seen = new Set<string>();

  for (const raw of descriptions) {
    const description = raw ? normalizeText(raw) : '';
    if (!description) continue;

    let matched = false;
    for (const rule of HAUPTLEISTUNG_RULES) {
      if (!rule.pattern.test(description)) continue;
      matched = true;
      if (rule.skip || !rule.label) break;
      if (seen.has(rule.label)) break;
      seen.add(rule.label);
      labels.push(rule.label);
      break;
    }

    if (!matched) {
      const fallback = fallbackHauptleistungLabel(description);
      if (!fallback || seen.has(fallback)) continue;
      seen.add(fallback);
      labels.push(fallback);
    }
  }

  return labels;
}

function positionDescriptionsFromDetected(
  positions: Array<Pick<DetectedOrderPosition, 'description'> | Pick<OrderPosition, 'description'>>,
): string[] {
  return positions.map((position) => position.description).filter(Boolean);
}

export function deriveContractScope(input: {
  intelligence?: ContractIntelligenceResult | null;
  vertragsgegenstand?: string;
  leistungsbeschreibung?: string;
  positions?: Array<Pick<DetectedOrderPosition, 'description'> | Pick<OrderPosition, 'description'>>;
}): ContractScopeDerivation {
  const fields = input.intelligence?.contractFields ?? {};
  const vertragsgegenstand =
    input.vertragsgegenstand?.trim() ||
    fields.vertragsgegenstand?.value?.trim() ||
    undefined;
  const leistungsbeschreibung =
    input.leistungsbeschreibung?.trim() ||
    fields.leistungsbeschreibung?.value?.trim() ||
    undefined;
  const positionDescriptions = positionDescriptionsFromDetected(
    input.positions ?? input.intelligence?.positions ?? [],
  );

  return {
    gewerk: deriveGewerk({
      vertragsgegenstand,
      leistungsbeschreibung,
      positionDescriptions,
    }),
    hauptleistungen: deriveHauptleistungen(positionDescriptions),
  };
}

/** Persistable string for Inbox recognizedData — not a new entity model. */
export function encodeHauptleistungen(labels: string[]): string | undefined {
  if (labels.length === 0) return undefined;
  return labels.join(' · ');
}

export function decodeHauptleistungen(value: string | undefined | null): string[] {
  if (!value?.trim()) return [];
  return value
    .split('·')
    .map((part) => part.trim())
    .filter(Boolean);
}
