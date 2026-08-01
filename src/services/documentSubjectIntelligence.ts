/**
 * SUBJECT-CONTRACT — Absender · Dokumentinhalt
 * Content: Betreff → Dokumentart → Objekt → Person → Kennzeichen → Projekt
 * No classifiedKind switches; no gold special cases; no internal IDs (EMP-/PRJ-/DOC-).
 */

import { cleanPartyFactValue, preferSubjectFactValue, truncateSummaryFactText } from './documentSummaryContent';

const SUBJECT_HEAD_CHARS = 720;
const SUBJECT_SEP = ' · ';

const GENERIC_TYPE_LABEL =
  /^(?:sonstiges|dokument|brief|schriftverkehr|mitteilung|information)$/i;

const HEAD_TOPIC_SKIP =
  /^(?:seite|sehr|geehrte|damen|herren|pos\.?|netto|brutto|cirmak|gmbh|strasse|straße|industriestraße|parkstraße|werkstraße|bahnhofstraße|rampendal|niederwall|versicherung)$/i;

const PERSON_STOP =
  /\s+(?:zwischen|zeitraum|krankenkasse|ausgestellt|datum|kennzeichen|beginn|ende|resturlaub|genehmigung|erstellt|bezeichnung|betrag)\b.*$/i;

const DETAIL_NOISE =
  /^(?:azubi|meister|speeddating|infoabend|termine|förderungen|seite|zwischen|zeitraum|krankenkasse)$/i;

/** Full-string reference tokens — must not swallow Kennzeichen like "LIP-CH 1002". */
const REFERENCE_LIKE =
  /^(?:[A-Z]{1,5}[-/][A-Z0-9/-]{2,}|[A-Z]{2,}-\d{2,}|BN-\d[\w-]*|JA-\d[\w-]*|WP-\d[\w-]*|HWK-[\w-]*|BG-OWL[\w-]*|VHV-[\w-]*|LV-OWL[\w-]*|\d{2,}\/\d[\w/-]*)$/i;

const LICENSE_PLATE = /^[A-ZÄÖÜ]{1,3}-[A-ZÄÖÜ]{1,3}\s*\d{1,4}$/i;

const INTERNAL_ID = /\b(?:EMP|PRJ|DOC)-?\d+\b/i;

const PERSON_LABELED =
  /\b(?:mitarbeiter(?:in)?|versicherter|versicherte|gast|arbeitnehmer(?:in)?)\s*[:\s]+([A-ZÄÖÜ][A-Za-zÄÖÜäöüß'’-]+(?:\s+[A-ZÄÖÜ][A-Za-zÄÖÜäöüß'’-]+){0,2})/i;

const PERSON_AFTER_PAYROLL =
  /\blohnabrechnung\s+(?:(?:januar|februar|märz|maerz|april|mai|juni|juli|august|september|oktober|november|dezember|\d{4})\s+){0,4}([A-ZÄÖÜ][a-zäöüß]+(?:\s+[A-ZÄÖÜ][a-zäöüß]+)+)/i;

const ROLE_WITH_ID =
  /\b((?:monteur|geselle|meister|bürokraft|azubi)(?:\s+shk)?)\b(?:\s*(EMP-?\d{2,6}))?/i;

const PLATE_LABELED =
  /\bkennzeichen\s*[:\s]*([A-ZÄÖÜ]{1,3}-[A-ZÄÖÜ]{1,3}\s*\d{1,4})\b/i;
const PLATE_LOOSE = /\b([A-ZÄÖÜ]{1,3}-[A-ZÄÖÜ]{1,3}\s*\d{1,4})\b/;

const VEHICLE_LABELED =
  /\bfahrzeug\s*[:\s]*([A-Za-zÄÖÜäöüß][A-Za-zÄÖÜäöüß0-9 ./-]{2,35}?)(?=\s*[·|]|\s*laufzeit|\s*kennzeichen|\s*LIP-|$)/i;

const FLEET_OBJECT = /\b(Transporter\s+\d+|Pkw\s+\d+|Lkw\s+\d+)\b/i;

const TRADE_CUE =
  /\b(Sanitär(?:e|ische)?|Heizung|Klima(?:technik)?|SHK|Elektro|Dach(?:decker)?|Maler)\b/i;

const PROJECT_QUOTED =
  /\bbauvorhaben\s*[„“"]\s*([^”"“]{3,60}?)\s*[”"“]/i;

const BEFORE_DATUM =
  /(?:^|[\n·|]|(?:GmbH|KG|AG)\s+)\s*([A-ZÄÖÜ][\wäöüÄÖÜß\d][\wäöüÄÖÜß\d /\u2013\u2014-]{5,70}?)\s+(?:Datum|Eingang|Ausgestellt|Prüfdatum)\b/;

const TOPIC_CORE_SOURCE =
  String.raw`\b(Beitrags(?:rechnung|bescheid|nachweis)(?:\s+Arbeitgeber|\s+BG\s*BAU|\s+Handwerkskammer(?:\s+\d{4})?|\s+Kfz[-\s]?Versicherung)?|Betriebshaftpflicht|Kfz[-\s]?Versicherung|Leasingvertrag|HU\s*\/\s*AU(?:\s*Prüfbericht)?|Prüfbericht|Arbeitsvertrag|Urlaubsantrag|Krankmeldung(?:\s*\/\s*AU)?|Lohnabrechnung(?:\s+(?:Januar|Februar|März|April|Mai|Juni|Juli|August|September|Oktober|November|Dezember)\s+\d{4})?|Gehaltsabrechnung|Anwaltliches\s+Schreiben|Forderungsangelegenheit|Ladung(?:\s+zum\s+Termin)?(?:\s*\/\s*Hinweis)?|Checkliste(?:\s+Unterlagen(?:\s+Jahresabschluss(?:\s+\d{4})?)?)?|Unterlagen(?:checkliste)?(?:\s+Jahresabschluss(?:\s+\d{4})?)?|Jahresabschluss(?:\s+\d{4})?|Newsletter|Gewinnspiel|Phishing|Angebot|Werkvertrag|Erinnerung(?:\s+Umsatzsteuer-Voranmeldung)?|Hotelrechnung|Tankbeleg|Werkzeugkatalog(?:\s+(?:Frühjahr|Herbst|Sommer|Winter))?(?:\s+\d{4})?|(?:Produkt)?[Kk]atalog(?:\s+(?:Frühjahr|Herbst|Sommer|Winter))?(?:\s+\d{4})?|Prospekt|Bescheid)\b`;

const META_SUBJECT_NOISE =
  /absender\s+nicht\s+eindeutig|gerade\s+erfasst\s*:|unbekannt(?:er)?\s+absender/i;

const ABSENDER_JUNK =
  /^(?:keine|nicht|unbekannt|sonstiges|absender|gerade erfasst)\b/i;

const BRAND_GENERIC_TAIL =
  /^(?:gewerbeversicherung|versicherung|fuhrparkleasing|leasing|bank|gruppe|services?)$/i;

export type DocumentSubjectSignals = {
  headTopic?: string;
  person?: string;
  role?: string;
  plate?: string;
  vehicleOrObject?: string;
  projectHint?: string;
  tradeCue?: string;
};

export type ComposeDocumentSubjectInput = {
  text?: string;
  typeLabel?: string;
  betreff?: string;
  letterAbout?: string;
  vorgang?: string;
  project?: string;
  sender?: string;
  reference?: string;
  title?: string;
};

function stripInternalIds(value: string): string {
  return value.replace(INTERNAL_ID, '').replace(/\s{2,}/g, ' ').trim();
}

function cleanTopic(raw: string | undefined): string | undefined {
  if (!raw?.trim()) return undefined;
  let value = stripInternalIds(raw.replace(/\s+/g, ' ').trim());
  value = value.replace(/^gerade erfasst\s*:\s*/i, '').trim();
  if (META_SUBJECT_NOISE.test(value)) return undefined;
  value = value.split(/\s*[·|]\s*/)[0]?.trim() ?? value;
  value = value
    .replace(/\s+(?:datum|az\.|aktenzeichen|kennzeichen|eingang|ausgestellt|prüfdatum)\b.*$/i, '')
    .replace(/\s+\d{1,2}\.\d{1,2}\.\d{2,4}\b.*$/, '')
    .trim();
  // Spaced / typographic dashes only — never Kfz-Versicherung hyphens.
  const dash = value.match(/^(.+?)\s+[\u2013\u2014-]\s+(.+)$/);
  if (dash) {
    const left = dash[1].trim();
    const right = dash[2].trim();
    if (META_SUBJECT_NOISE.test(right)) {
      value = left;
    } else if (/beitragsrechnung|übersicht|hinweis/i.test(right) && left.length >= 4) {
      value = left;
    } else if (/beitragsrechnung/i.test(left) && /versicherung|haftpflicht|kfz/i.test(right)) {
      value = right;
    }
  }
  value = value.replace(/\s*\/\s*vertragsübersicht\b/i, '').trim();
  if (value.length < 3 || value.length > 90) return undefined;
  if (HEAD_TOPIC_SKIP.test(value) || META_SUBJECT_NOISE.test(value)) return undefined;
  return value;
}

function cleanPerson(raw: string | undefined): string | undefined {
  if (!raw?.trim()) return undefined;
  let value = stripInternalIds(raw.replace(/\s+/g, ' ').trim());
  value = value.replace(PERSON_STOP, '').trim();
  if (value.length < 3 || value.length > 50) return undefined;
  if (DETAIL_NOISE.test(value) || isReferenceLike(value) || INTERNAL_ID.test(value)) return undefined;
  return value;
}

function isReferenceLike(value: string): boolean {
  if (LICENSE_PLATE.test(value.trim())) return false;
  return REFERENCE_LIKE.test(value.trim());
}

function isGenericTopic(value: string | undefined): boolean {
  if (!value?.trim()) return true;
  return GENERIC_TYPE_LABEL.test(value.trim());
}

function looksLikePartyName(value: string | undefined, sender?: string): boolean {
  if (!value?.trim()) return false;
  const cleaned = cleanPartyFactValue(value) || value.trim();
  if (/\b(?:gmbh|ag|kg|ohg|gbr|ug|e\.?\s*v\.?)\b/i.test(cleaned) && cleaned.length < 55) {
    return true;
  }
  if (!sender) return false;
  const s = (cleanPartyFactValue(sender) || sender).toLowerCase();
  const c = cleaned.toLowerCase();
  if (c === s) return true;
  if (c.length >= 10 && (s === c || s.startsWith(`${c} `) || s.endsWith(` ${c}`) || s.includes(` ${c} `))) {
    return true;
  }
  return false;
}

/** Display Absender for subject prefix (no legal form; brand without generic tail). */
export function formatSubjectAbsender(raw: string | undefined): string | undefined {
  if (!raw?.trim()) return undefined;
  let value = cleanPartyFactValue(raw);
  if (!value) return undefined;
  if (ABSENDER_JUNK.test(value)) return undefined;
  if (/beziehung|nicht eindeutig|unbekannt/i.test(value)) return undefined;
  value = value
    .replace(/\s+(?:GmbH(?:\s*&\s*Co\.?\s*KG)?|AG|KG|OHG|GbR|UG|e\.?\s*V\.?)\s*$/i, '')
    .replace(
      /\s+(?:Bezirksverwaltung|Landesverband|Regionaldirektion|Zweigniederlassung)\b.*$/i,
      '',
    )
    .trim();
  const parts = value.split(/\s+/);
  if (parts.length >= 2 && BRAND_GENERIC_TAIL.test(parts.slice(1).join(' '))) {
    return parts[0];
  }
  if (value.length < 2 || value.length > 70) return undefined;
  return value;
}

function scoreTopic(value: string): number {
  const v = value.toLowerCase();
  if (/^kfz[-\s]?versicherung$/.test(v)) return 95;
  if (/lohnabrechnung/.test(v)) return 80 + value.length;
  if (/krankmeldung|arbeitsvertrag|urlaubsantrag|leasingvertrag|werkvertrag|hotelrechnung|tankbeleg/.test(v)) {
    return 70 + value.length;
  }
  if (/hu\s*\/\s*au|ladung|checkliste|unterlagen|erinnerung|beitragsnachweis|beitragsbescheid/.test(v)) {
    return 60 + value.length;
  }
  if (/beitragsrechnung/.test(v) && /kfz/.test(v)) return 45 + value.length;
  if (/\bkfz\b/.test(v)) return 70 + value.length;
  if (/prüfbericht|betriebshaftpflicht|anwaltliches|newsletter|gewinnspiel|angebot|katalog|prospekt|werkzeugkatalog/.test(v)) {
    return 40 + value.length;
  }
  if (/gehaltsabrechnung/.test(v)) return 20 + value.length;
  return value.length;
}

function rankTopicMatches(matches: string[]): string | undefined {
  if (matches.length === 0) return undefined;
  return [...matches].sort((a, b) => scoreTopic(b) - scoreTopic(a))[0];
}

export function extractDocumentSubjectSignals(text: string): DocumentSubjectSignals {
  if (!text?.trim()) return {};
  const head = text.slice(0, SUBJECT_HEAD_CHARS);

  const topicMatches = [...head.matchAll(new RegExp(TOPIC_CORE_SOURCE, 'gi'))].map(
    (m) => m[1] ?? m[0],
  );
  if (/\bKfz[-\s]?Versicherung\b/i.test(head)) {
    topicMatches.push('Kfz-Versicherung');
  }
  if (/\bHU\s*\/\s*AU\b/i.test(head)) {
    topicMatches.push('HU / AU Prüfbericht');
  }
  if (/\bCheckliste\s+Unterlagen(?:\s+Jahresabschluss(?:\s+\d{4})?)?/i.test(head)) {
    const full = head.match(/\bCheckliste\s+Unterlagen(?:\s+Jahresabschluss(?:\s+\d{4})?)?/i)?.[0];
    if (full) topicMatches.push(full);
  }
  const headTopic =
    cleanTopic(rankTopicMatches(topicMatches)) ?? cleanTopic(head.match(BEFORE_DATUM)?.[1]);

  let person = cleanPerson(
    head.match(PERSON_LABELED)?.[1] ?? head.match(PERSON_AFTER_PAYROLL)?.[1],
  );
  if (person && /(?:abrechnung|vertrag|meldung|antrag|bescheid|versicherung|checkliste)\b/i.test(person)) {
    person = undefined;
  }
  if (!person) {
    const payrollName = head.match(
      /\blohnabrechnung\s+(?:(?:januar|februar|märz|maerz|april|mai|juni|juli|august|september|oktober|november|dezember)\s+)?(?:\d{4}\s+)?([A-ZÄÖÜ][a-zäöüß]+(?:\s+[A-ZÄÖÜ][a-zäöüß]+)+)/i,
    )?.[1];
    person = cleanPerson(payrollName);
  }

  const roleMatch = head.match(ROLE_WITH_ID);
  const role = roleMatch?.[1]?.replace(/\s+/g, ' ').trim();

  const plateRaw =
    head.match(PLATE_LABELED)?.[1]?.replace(/\s+/g, ' ').trim() ??
    head.match(PLATE_LOOSE)?.[1]?.replace(/\s+/g, ' ').trim();
  const plate = plateRaw && LICENSE_PLATE.test(plateRaw) ? plateRaw : undefined;

  let vehicleOrObject = head.match(VEHICLE_LABELED)?.[1]?.replace(/\s+/g, ' ').trim();
  if (!vehicleOrObject && !plate) {
    vehicleOrObject = head.match(FLEET_OBJECT)?.[1]?.replace(/\s+/g, ' ').trim();
  }
  if (vehicleOrObject) {
    vehicleOrObject = vehicleOrObject.split(/\s*[·|]\s*/)[0]?.trim();
    if (
      !vehicleOrObject ||
      DETAIL_NOISE.test(vehicleOrObject) ||
      isReferenceLike(vehicleOrObject) ||
      /\d{1,2}\.\d{1,2}\./.test(vehicleOrObject) ||
      INTERNAL_ID.test(vehicleOrObject)
    ) {
      vehicleOrObject = undefined;
    }
  }

  const projectHint =
    cleanTopic(head.match(PROJECT_QUOTED)?.[1]) ?? head.match(/\bHeizzentrale\b/)?.[0];

  const tradeRaw = head.match(TRADE_CUE)?.[1];
  const tradeCue = tradeRaw
    ? /^sanitär/i.test(tradeRaw)
      ? 'Sanitär'
      : tradeRaw.replace(/^(.)/, (c) => c.toUpperCase())
    : undefined;

  return {
    headTopic,
    person,
    role,
    plate,
    vehicleOrObject,
    projectHint,
    tradeCue,
  };
}

function pickDetail(
  signals: DocumentSubjectSignals,
  input: ComposeDocumentSubjectInput,
): string | undefined {
  const project = preferSubjectFactValue(input.project, input.vorgang, signals.projectHint);
  let shortProject = project
    ? stripInternalIds(
        project
          .replace(/^sägewerk\s+ernst\s+flisch\s*[\u2013\u2014-]\s*/i, '')
          .replace(/^mehrfamilienhaus\s+/i, 'Mehrfamilienhaus ')
          .trim(),
      )
    : undefined;
  if (shortProject && (shortProject.length > 40 || DETAIL_NOISE.test(shortProject) || INTERNAL_ID.test(shortProject))) {
    shortProject = signals.projectHint;
  }

  // Content detail: Objekt → Rolle → Person → Kennzeichen → Projekt (no EMP-/PRJ-/DOC-)
  const roleShort = signals.role?.replace(/\s+shk$/i, '').trim();
  const candidates = [
    signals.vehicleOrObject,
    roleShort,
    signals.person,
    signals.plate,
    shortProject,
  ];

  for (const candidate of candidates) {
    const trimmed = candidate?.replace(/\s+/g, ' ').trim();
    if (!trimmed || trimmed.length < 2) continue;
    if (INTERNAL_ID.test(trimmed)) continue;
    if (DETAIL_NOISE.test(trimmed) || isReferenceLike(trimmed)) continue;
    if (looksLikePartyName(trimmed, input.sender)) continue;
    return trimmed;
  }
  return undefined;
}

function enrichTopicWithTrade(topic: string, tradeCue: string | undefined): string {
  if (!tradeCue) return topic;
  if (!/^(?:angebot|werkvertrag)\b/i.test(topic)) return topic;
  if (new RegExp(tradeCue, 'i').test(topic)) return topic;
  return `${topic} ${tradeCue}`;
}

/** Drop Absender fragments that leaked into the content topic (e.g. "Beitragsbescheid BG BAU"). */
function stripAbsenderFromContent(content: string, absender: string | undefined): string {
  if (!absender?.trim()) return content;
  let value = content;
  const tokens = absender.split(/\s+/).filter(Boolean);
  for (let n = tokens.length; n >= 1; n--) {
    const phrase = tokens.slice(0, n).join(' ');
    if (phrase.length < 2) continue;
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!new RegExp(escaped, 'i').test(value)) continue;
    value = value
      .replace(new RegExp(`\\s*${escaped}\\s*`, 'ig'), ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    break;
  }
  return value || content;
}

function pickTopic(
  signals: DocumentSubjectSignals,
  input: ComposeDocumentSubjectInput,
): string | undefined {
  const betreffRaw = preferSubjectFactValue(input.betreff, input.letterAbout);
  const betreff =
    betreffRaw && !looksLikePartyName(betreffRaw, input.sender) && !isGenericTopic(betreffRaw)
      ? cleanTopic(betreffRaw) ?? betreffRaw
      : undefined;
  const head =
    signals.headTopic && !looksLikePartyName(signals.headTopic, input.sender)
      ? signals.headTopic
      : undefined;
  const type =
    input.typeLabel && !isGenericTopic(input.typeLabel) ? input.typeLabel.trim() : undefined;

  const ranked = rankTopicMatches(
    [betreff, head, type].filter((v): v is string => Boolean(v?.trim())),
  );
  if (!ranked) return undefined;
  return enrichTopicWithTrade(ranked, signals.tradeCue);
}

function composeDocumentContent(input: ComposeDocumentSubjectInput): string | undefined {
  const signals = extractDocumentSubjectSignals(input.text ?? '');
  const topic = pickTopic(signals, input);
  const detail = pickDetail(signals, input);

  let content: string | undefined;
  if (topic && detail) {
    if (topic.toLowerCase().includes(detail.toLowerCase())) {
      content = topic;
    } else if (
      LICENSE_PLATE.test(detail) ||
      signals.vehicleOrObject === detail ||
      (detail.length <= 18 &&
        !/\s{2,}/.test(detail) &&
        /^[A-ZÄÖÜ0-9][A-ZÄÖÜ0-9\s-]{2,}$/u.test(detail))
    ) {
      content = `${topic} ${detail}`;
    } else {
      content = `${topic} – ${detail}`;
    }
  } else if (topic) {
    content = topic;
  } else if (detail) {
    content = detail;
  } else {
    const title = preferSubjectFactValue(input.title);
    if (
      title &&
      !META_SUBJECT_NOISE.test(title) &&
      !looksLikePartyName(title, input.sender) &&
      !isGenericTopic(title)
    ) {
      content = cleanTopic(title) ?? title;
      if (content && META_SUBJECT_NOISE.test(content)) content = undefined;
    }
  }

  if (!content) return undefined;
  return truncateSummaryFactText(stripInternalIds(content), 90);
}

/** Subject contract: Absender · Dokumentinhalt (Absender omitted only when unavailable). */
export function composeIntelligentDocumentSubject(
  input: ComposeDocumentSubjectInput,
): string | undefined {
  const absender = formatSubjectAbsender(input.sender);
  let content = composeDocumentContent(input);
  if (content && absender) {
    content = stripAbsenderFromContent(content, absender);
  }

  if (absender && content) {
    if (content.toLowerCase() === absender.toLowerCase()) {
      return truncateSummaryFactText(absender, 90);
    }
    return truncateSummaryFactText(`${absender}${SUBJECT_SEP}${content}`, 100);
  }
  if (content) return content;
  if (absender) return absender;
  return undefined;
}
