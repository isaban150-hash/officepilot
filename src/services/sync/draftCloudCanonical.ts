/**
 * CLOUD-SYNC S6 — schlüsselstabile Textform für die Inhaltsschlüssel der
 * Auftrags- und Nachtragsentwürfe.
 *
 * `jsonb` bewahrt die Schlüsselreihenfolge nicht: Ein roher
 * `JSON.stringify`-Vergleich hielte denselben Inhalt nach einem Abzug für
 * verändert, und jede Rückschreibung löste den nächsten Push aus. Arrays
 * behalten ihre Reihenfolge (sie ist fachlich), `undefined` entfällt wie in
 * JSON, `null` bleibt eine Aussage — dieselbe Regel wie beim
 * Rechnungsentwurf (S5).
 */
export function canonicalDraftJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalDraftJson(item === undefined ? null : item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalDraftJson(entry)}`).join(',')}}`;
}

/** Tiefe, JSON-treue Kopie — ein Cloud-Inhalt teilt nie Referenzen mit dem lokalen Entwurf. */
export function detachDraftValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function isNonEmptyDraftString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function isPlainDraftObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
