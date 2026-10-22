/**
 * DOKUMENTE-01 / D-017 — die gesetzliche Aufbewahrung eines abgelegten Dokuments.
 *
 * OfficeTakt wendet nur zwei Regeln an, die ohne Einzelfallprüfung feststehen:
 *
 *   - Buchungsbelege und Rechnungen: 8 Jahre (§ 147 Abs. 1 Nr. 4, Abs. 3 AO;
 *     § 257 Abs. 1 Nr. 4, Abs. 4 HGB; § 14b Abs. 1 UStG — jeweils in der
 *     Fassung des Vierten Bürokratieentlastungsgesetzes).
 *   - Empfangene und abgesandte Handels- oder Geschäftsbriefe: 6 Jahre
 *     (§ 147 Abs. 1 Nr. 2 und 3, Abs. 3 AO; § 257 Abs. 1 Nr. 2 und 3, Abs. 4 HGB).
 *
 * Alles andere heißt „Aufbewahrung prüfen": keine Frist, kein Löschvorschlag,
 * Löschen nur nach ausdrücklicher Bestätigung. Dazu gehören bewusst auch
 * Personal-, Behörden- und Versicherungsunterlagen, Lieferscheine, Angebote
 * und Bescheide — dort hängt die Frist vom Einzelfall ab.
 *
 * Die Frist beginnt mit dem Schluss des Kalenderjahres (§ 147 Abs. 4 AO,
 * § 257 Abs. 5 HGB). Als Jahr gilt das späteste aus Dokumentdatum und
 * Erfassung: Die Frist wird dadurch eher länger als nötig, nicht kürzer. Auch
 * nach ihrem rechnerischen Ende läuft sie weiter, solange das Dokument für eine
 * noch offene Steuerfestsetzung von Bedeutung ist (§ 147 Abs. 3 AO). Deshalb
 * gibt es auch dann keinen Löschvorschlag, nur das Löschen nach Prüfung.
 *
 * Reine Regel ohne Speicherzugriff. Dieselbe Regel steht serverseitig in
 * `workspace_retention_rule` (20261125120000); beide prüfen dieselben
 * Testvektoren (`documentRetentionVectors.ts`). Keine Rechtsberatung.
 */

export type DocumentRetentionClass = 'buchungsbeleg' | 'geschaeftsbrief' | 'pruefen';

/** `abgelaufen` heißt nur „rechnerisch": Die Ablaufhemmung kann die Frist verlängern. */
export type DocumentRetentionStatus = 'laeuft' | 'abgelaufen' | 'pruefen';

export type DocumentRetentionReason =
  | 'zahlungsnachweis'
  | 'ausgabenbeleg'
  | 'rechnungsbeleg'
  | 'rechnung_nicht_festgeschrieben'
  | 'belegart'
  | 'geschaeftsbrief'
  | 'keine_feste_regel';

/** Ein von OfficeTakt erzeugter Rechnungsbeleg und der Stand seiner Rechnung. */
export type GeneratedInvoiceRetentionState = 'offen' | 'festgeschrieben' | 'korrektur';

export interface DocumentRetentionFacts {
  /** Gesetzt nur für erzeugte Rechnungs- und Korrekturbelege. */
  rechnungsbeleg?: GeneratedInvoiceRetentionState | null;
  classifiedKind?: string | null;
  category?: string | null;
  /** Beleg einer Ausgabe. */
  ausgabenbeleg?: boolean;
  /** Nachweis einer Zahlung oder Quittung einer Mitarbeiterzahlung. */
  zahlungsnachweis?: boolean;
  documentDate?: string | null;
  issueDate?: string | null;
  uploadedAt?: string | null;
  createdAt?: string | null;
}

export interface DocumentRetention {
  klasse: DocumentRetentionClass;
  grund: DocumentRetentionReason;
  /** 8 oder 6 Jahre; `null` bei „prüfen". */
  jahre: number | null;
  /** Jahr, an dessen Ende die Frist beginnt; `null` bei „prüfen". */
  bezugsjahr: number | null;
  /** Letzter Tag der gesetzlichen Mindestfrist (`YYYY-12-31`); `null` bei „prüfen". */
  fristEnde: string | null;
  status: DocumentRetentionStatus;
}

/** Dokumentarten, die stets Buchungsbeleg oder Rechnung sind. */
export const RETENTION_BOOKING_RECORD_KINDS: readonly string[] = [
  'eingangsrechnung',
  'rechnung',
  'rechnungskorrektur',
  'ausgangsrechnung',
  'gutschrift',
  'quittung',
  'kassenbeleg',
  'ec_beleg',
  'kreditkartenbeleg',
  'kontoauszug',
  'reparaturrechnung',
  'tankbeleg',
];

/** Dokumentarten, die stets einen Geschäftsvorfall anbahnen, abschließen oder abwickeln. */
export const RETENTION_BUSINESS_LETTER_KINDS: readonly string[] = [
  'auftrag',
  'auftragsbestaetigung',
  'werkvertrag',
  'subunternehmervertrag',
  'nachunternehmervertrag',
  'nachtrag',
  'mahnung',
  'zahlungserinnerung',
];

const RETENTION_YEARS: Record<Exclude<DocumentRetentionClass, 'pruefen'>, number> = {
  buchungsbeleg: 8,
  geschaeftsbrief: 6,
};

const BERLIN_YEAR = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric' });
const BERLIN_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Berlin',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const MIN_YEAR = 1900;
const MAX_YEAR = 2200;

function plausibleYear(year: number): number | null {
  return Number.isInteger(year) && year >= MIN_YEAR && year <= MAX_YEAR ? year : null;
}

/**
 * Das Kalenderjahr eines Datums oder Zeitstempels, in Berliner Zeit.
 *
 * Nur ISO-Formate. Ein Zeitstempel ohne Zonenangabe gilt als UTC — genau wie
 * im Server. Ungültige oder unplausible Werte zählen nicht.
 */
export function retentionYearOf(value: string | null | undefined): number | null {
  const text = (value ?? '').trim();
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (dateOnly) {
    const [year, month, day] = dateOnly.slice(1).map(Number);
    const probe = new Date(Date.UTC(year, month - 1, day));
    if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) {
      return null;
    }
    return plausibleYear(year);
  }
  if (!/^\d{4}-\d{2}-\d{2}[T ]/.test(text)) return null;
  const withZone = /(Z|[+-]\d{2}(:?\d{2})?)$/i.test(text) ? text : `${text}Z`;
  const instant = new Date(withZone.replace(' ', 'T'));
  if (Number.isNaN(instant.getTime())) return null;
  return plausibleYear(Number(BERLIN_YEAR.format(instant)));
}

/** Der heutige Tag in Berliner Zeit (`YYYY-MM-DD`). */
export function retentionToday(heute: Date): string {
  return BERLIN_DAY.format(heute);
}

function classify(facts: DocumentRetentionFacts): {
  klasse: DocumentRetentionClass;
  grund: DocumentRetentionReason;
} {
  if (facts.zahlungsnachweis) return { klasse: 'buchungsbeleg', grund: 'zahlungsnachweis' };
  if (facts.ausgabenbeleg) return { klasse: 'buchungsbeleg', grund: 'ausgabenbeleg' };
  if (facts.rechnungsbeleg) {
    // Erst die festgeschriebene Rechnung ist ausgestellt; ein Entwurf ist kein Beleg.
    return facts.rechnungsbeleg === 'offen'
      ? { klasse: 'pruefen', grund: 'rechnung_nicht_festgeschrieben' }
      : { klasse: 'buchungsbeleg', grund: 'rechnungsbeleg' };
  }
  // Gross-/Kleinschreibung und Leerzeichen ändern die Art nicht — im Zweifel greift die Frist.
  const kind = facts.classifiedKind?.trim().toLowerCase() ?? '';
  const category = facts.category?.trim().toLowerCase() ?? '';
  if (RETENTION_BOOKING_RECORD_KINDS.includes(kind) || category === 'ausgangsrechnung') {
    return { klasse: 'buchungsbeleg', grund: 'belegart' };
  }
  if (RETENTION_BUSINESS_LETTER_KINDS.includes(kind)) {
    return { klasse: 'geschaeftsbrief', grund: 'geschaeftsbrief' };
  }
  return { klasse: 'pruefen', grund: 'keine_feste_regel' };
}

export function resolveDocumentRetention(facts: DocumentRetentionFacts, heute: Date = new Date()): DocumentRetention {
  const { klasse, grund } = classify(facts);
  if (klasse === 'pruefen') {
    return { klasse, grund, jahre: null, bezugsjahr: null, fristEnde: null, status: 'pruefen' };
  }

  const jahre = RETENTION_YEARS[klasse];
  const today = retentionToday(heute);
  const years = [facts.documentDate, facts.issueDate, facts.uploadedAt, facts.createdAt]
    .map(retentionYearOf)
    .filter((year): year is number => year !== null);
  // Ohne lesbares Datum beginnt die Frist frühestens heute: lieber zu lang als zu kurz.
  const bezugsjahr = years.length > 0 ? Math.max(...years) : Number(today.slice(0, 4));
  const fristEnde = `${bezugsjahr + jahre}-12-31`;
  return {
    klasse,
    grund,
    jahre,
    bezugsjahr,
    fristEnde,
    status: today <= fristEnde ? 'laeuft' : 'abgelaufen',
  };
}

/** Während der Frist wird nicht gelöscht — auf keinem Weg. */
export function retentionBlocksDelete(retention: Pick<DocumentRetention, 'status'>): boolean {
  return retention.status === 'laeuft';
}

const RETENTION_CLASS_RANK: Record<DocumentRetentionClass, number> = {
  buchungsbeleg: 2,
  geschaeftsbrief: 1,
  pruefen: 0,
};

/**
 * Während der Frist macht keine Änderung aus einem Beleg ein „prüfen" — wie
 * FINANZ-CORE-01A (STO-03) beim Rechnungsbeleg. Ein anderes Datum dagegen
 * bleibt änderbar: Es verkürzt die Frist nie unter das Jahr der Erfassung.
 */
export function isRetentionDowngrade(
  vorher: Pick<DocumentRetention, 'klasse' | 'status'>,
  nachher: Pick<DocumentRetention, 'klasse'>,
): boolean {
  return vorher.status === 'laeuft' && RETENTION_CLASS_RANK[nachher.klasse] < RETENTION_CLASS_RANK[vorher.klasse];
}

/** Was mit dem Papieroriginal geschehen soll (Werte wie `OriginalGuidanceStatus`). */
export type OriginalRetentionAdvice = 'keep' | 'keep_until_tax' | 'dispose_after_digital' | 'uncertain';

const TAX_RELEVANT_ORIGINAL_KINDS: readonly string[] = ['freistellungsbescheinigung', 'lohnabrechnung'];

/**
 * D-017 — die Empfehlung zum Papieroriginal folgt der Aufbewahrung.
 *
 * Entsorgen empfiehlt OfficeTakt nur bei erkannter Werbung. Dass ein Dokument
 * digital abgelegt ist, ist kein Grund: OfficeTakt sichert kein ersetzendes
 * Scannen zu, und ohne Aufbewahrungsprüfung wäre der Hinweis leichtfertig.
 */
export function resolveOriginalRetentionAdvice(input: {
  isAdvertisement?: boolean;
  classifiedKind?: string | null;
  hasDeadline?: boolean;
  /** Steuerrelevante Art aus Sicht des Aufrufers (z. B. DATEV). */
  taxRelevant?: boolean;
}): OriginalRetentionAdvice {
  if (input.isAdvertisement) return 'dispose_after_digital';
  const { klasse } = classify({ classifiedKind: input.classifiedKind });
  if (klasse === 'buchungsbeleg') return 'keep_until_tax';
  if (klasse === 'geschaeftsbrief') return 'keep';
  const kind = input.classifiedKind?.trim().toLowerCase() ?? '';
  if (input.taxRelevant || TAX_RELEVANT_ORIGINAL_KINDS.includes(kind)) return 'keep_until_tax';
  if (input.hasDeadline) return 'keep';
  return 'uncertain';
}
