/**
 * BRANDING-01D — Pfad und Kennung eines Branding-Assets.
 *
 * Der Objektpfad lautet `<workspaceId>/<assetId>` — genau zwei Segmente, keine
 * Dateiendung, kein Dateiname des Nutzers. Aus dem Pfad lässt sich damit
 * nichts über den Betrieb ablesen, und es gibt nichts umzubenennen.
 *
 * Der Speicherpfad wird bewusst **nicht** Teil von `LogoAssetReference`: Er ist
 * jederzeit aus Workspace und Kennung ableitbar, und ihn in historischen
 * Geschäftsdaten einzufrieren hiesse, eine Infrastrukturentscheidung dort zu
 * verankern, wo sie nicht hingehört.
 *
 * Reine Funktionen: kein Netz, kein Store, keine Persistenz.
 */

/** Kanonische UUID-Form. Dieselbe Prüfung führt die Storage-Policy serverseitig. */
const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Erlaubte Zeichen einer Asset-Kennung — eine Positivliste.
 *
 * Neu erzeugte Kennungen sind UUIDs; die Liste ist etwas weiter gefasst, damit
 * später importierte oder migrierte Kennungen nicht am Vertrag scheitern. Was
 * sie ausschliesst, ist alles, was einen Pfad verlassen oder verändern könnte:
 * `/`, `\`, Doppelpunkt, Prozentzeichen, Leerzeichen, Steuerzeichen. Eine
 * Denylist müsste jede dieser Formen einzeln treffen — diese Liste lässt von
 * vornherein nur Harmloses durch.
 */
const ASSET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function isValidBrandingWorkspaceId(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export function isPathSafeBrandingAssetId(value: string): boolean {
  if (!ASSET_ID_PATTERN.test(value)) return false;
  // `..` ist zeichenweise erlaubt, als Folge aber ein Aufstieg im Pfad.
  return !value.includes('..');
}

/**
 * Erzeugt eine neue Asset-Kennung.
 *
 * `crypto.randomUUID` ist an einen sicheren Kontext gebunden und fehlt auf
 * einer HTTP-Adresse im lokalen Netz — genau dort, wo die Realtests laufen.
 * Deshalb der zweite Weg über `crypto.getRandomValues` mit korrekt gesetzten
 * Versions- und Variantenbits (RFC 4122, Version 4).
 *
 * Fehlt auch der, wird **geworfen**. Eine Kennung aus `Math.random()` oder
 * einem Zeitstempel wäre vorhersagbar und kollisionsanfällig — und weil
 * Assets unveränderlich sind und nicht gelöscht werden können, wäre eine
 * Kollision nicht reparabel.
 */
export function generateBrandingAssetId(): string {
  const source: Crypto | undefined = typeof crypto === 'undefined' ? undefined : crypto;

  if (source && typeof source.randomUUID === 'function') {
    return source.randomUUID();
  }

  if (source && typeof source.getRandomValues === 'function') {
    const bytes = source.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40; // Version 4
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // Variante 10xx
    const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    return [
      hex.slice(0, 8),
      hex.slice(8, 12),
      hex.slice(12, 16),
      hex.slice(16, 20),
      hex.slice(20),
    ].join('-');
  }

  throw new SecureRandomUnavailableError();
}

/**
 * Eigener Fehlertyp, damit der Aufrufer diesen **erwartbaren**
 * Infrastrukturfall von einem Programmierfehler unterscheiden kann, statt
 * jede Ausnahme pauschal zu verschlucken.
 */
export class SecureRandomUnavailableError extends Error {
  constructor() {
    super(
      'BRANDING-ASSET: keine sichere Zufallsquelle verfügbar – es wird keine schwache Kennung erzeugt.',
    );
    this.name = 'SecureRandomUnavailableError';
  }
}

export type BrandingAssetPathError = 'invalid_workspace' | 'invalid_asset';

export type BrandingAssetPathResult =
  | { ok: true; path: string }
  | { ok: false; error: BrandingAssetPathError };

/**
 * Baut den Objektpfad. Beide Segmente werden geprüft, nicht nur eines — der
 * Workspace ist die Sicherheitsgrenze, die Kennung der Pfadbestandteil.
 * Nichts wird getrimmt oder zurechtgebogen: Ungültig bleibt ungültig.
 */
export function buildBrandingAssetPath(
  workspaceId: string,
  assetId: string,
): BrandingAssetPathResult {
  if (typeof workspaceId !== 'string' || !isValidBrandingWorkspaceId(workspaceId)) {
    return { ok: false, error: 'invalid_workspace' };
  }
  if (typeof assetId !== 'string' || !isPathSafeBrandingAssetId(assetId)) {
    return { ok: false, error: 'invalid_asset' };
  }
  return { ok: true, path: `${workspaceId}/${assetId}` };
}
