/**
 * BRANDING-FOUNDATION-01B — der Branding-Vertrag.
 *
 * Firmenstammdaten sagen, **wer** der Absender ist. Branding sagt, **wie** er
 * auf einem Dokument erscheint. Beides bleibt getrennt: Der
 * `SharedPresentationContext` trägt Absender, Empfänger und Projektbezug und
 * bleibt ausdrücklich brandingfrei. Ein Renderer bekommt später drei Dinge —
 * Fachmodell, Präsentations-Context und Branding.
 *
 * Was hier ausdrücklich **nicht** hineingehört:
 *
 *  - Keine Bilddaten. `assetId` verweist auf ein unveränderliches Asset; das
 *    Bild selbst reist nie im Geschäftsdatensatz mit. Sonst läge dasselbe
 *    Base64 in jeder Rechnung — der Fehler, den `CompanyProfile.logoDataUrl`
 *    heute an vier Stellen zum Herausschneiden zwingt.
 *  - Kein Speicherpfad. Er ist später aus Workspace und `assetId` ableitbar;
 *    ihn einzufrieren hiesse, eine Infrastrukturentscheidung in historischen
 *    Geschäftsdaten zu verankern.
 *  - Keine Schriften, keine Template-Wahl, keine Sekundärfarben, keine
 *    Kopf-/Fusszeilen. Das folgt erst, wenn es die Komponenten dazu gibt.
 */

/**
 * Zulässige Logo-Formate. Bewusst eng und ohne SVG: Ein SVG ist ein Dokument
 * mit eigenen Referenzen, kein reines Bild — als Logo bringt es Risiko ohne
 * Gewinn.
 */
export const LOGO_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

export type LogoMimeType = (typeof LOGO_MIME_TYPES)[number];

/**
 * Die stabile, unveränderliche Referenz auf ein Logo-Asset.
 *
 * Ein Logowechsel erzeugt später ein **neues** Asset mit neuer `assetId`; die
 * alte bleibt gültig. So behält ein historisches Dokument sein damaliges Logo,
 * ohne dass irgendetwas kopiert oder nachgeführt werden müsste.
 */
export interface LogoAssetReference {
  assetId: string;
  mimeType: LogoMimeType;
}

/**
 * Das aktuelle Branding des Betriebs. Beide Felder sind optional — ein Betrieb
 * ohne Logo und ohne gesetzte Markenfarbe ist ein gültiger Zustand.
 */
export interface BrandingProfile {
  logo?: LogoAssetReference;
  primaryColor?: string;
}

/** Feste Version des Snapshot-Vertrags. Kein Schema-/Cloud-Versionssystem. */
export const BRANDING_SNAPSHOT_VERSION = 1;

/**
 * Das Branding **zum Zeitpunkt eines Dokuments** — historische Wahrheit.
 *
 * Bewusst ein eigener Type und kein Alias auf `BrandingProfile`: Die beiden
 * bedeuten Verschiedenes. Das Profil ist veränderlich und beschreibt das Heute;
 * der Snapshot ist eingefroren und beschreibt ein Damals. Ein späterer
 * Farbwechsel oder ein neues Logo darf einen bestehenden Entwurf und erst recht
 * eine finalisierte Rechnung nicht verändern. Diese Grenze soll im Typ sichtbar
 * sein, bevor der erste Renderer sie braucht.
 */
export interface BrandingSnapshot {
  version: typeof BRANDING_SNAPSHOT_VERSION;
  logo?: LogoAssetReference;
  primaryColor?: string;
}
