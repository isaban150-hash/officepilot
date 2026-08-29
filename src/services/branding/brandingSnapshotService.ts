/**
 * BRANDING-FOUNDATION-01B — der Branding-Snapshot-Builder.
 *
 * Eine reine Funktion: keine Store-Zugriffe, keine Services, kein Netz, kein
 * Storage, keine Persistenz, kein Zeitstempel, kein Zufall. Gleiche Eingabe
 * ergibt denselben Snapshot.
 *
 * Der Builder prüft ausschliesslich **strukturelle** Invarianten — dass ein
 * gesetzter Farbwert die vereinbarte Form hat und eine gesetzte Logo-Referenz
 * vollständig ist. Er prüft **nicht**, ob das Asset im Storage existiert: Das
 * wäre ein Netzzugriff und würde diese Schicht an Infrastruktur binden.
 *
 * Und er erfindet nichts. Fehlt eine Markenfarbe, bleibt sie leer; ein Renderer
 * darf dann seinen eigenen festen Wert verwenden. Ein hier gesetzter Standard
 * wäre eine Gestaltungsentscheidung an der falschen Stelle.
 */
import {
  BRANDING_SNAPSHOT_VERSION,
  LOGO_MIME_TYPES,
  type BrandingProfile,
  type BrandingSnapshot,
  type LogoAssetReference,
  type LogoMimeType,
} from '../../types/branding';

/**
 * Genau `#rrggbb`, Gross- und Kleinschreibung erlaubt.
 *
 * Bewusst eng: Der Wert fliesst später in Style-Attribute und in die
 * PDF-Farbangabe. Ein freier CSS-Text (`var(...)`, `rgb(...)`, ein Farbname)
 * wäre dort eine Einfallstelle und liesse sich in einem PDF ohnehin nicht
 * auflösen. Kurzformen wie `#fff` sind ausgeschlossen, damit es genau eine
 * gültige Schreibweise gibt.
 */
const PRIMARY_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

/**
 * Prüft die Form — **ohne** zu trimmen, zu normalisieren oder die Schreibweise
 * zu vereinheitlichen. `' #112233 '` ist deshalb ungültig und wird nicht
 * stillschweigend repariert: Ein Snapshot ist historische Wahrheit, und wer ihn
 * beim Erzeugen säubert, ändert ihn.
 */
export function isValidBrandingPrimaryColor(value: string): boolean {
  return PRIMARY_COLOR_PATTERN.test(value);
}

export function isLogoMimeType(value: string): value is LogoMimeType {
  return (LOGO_MIME_TYPES as readonly string[]).includes(value);
}

/**
 * Baut die Logo-Referenz neu auf. Die Rückgabe teilt bewusst **keine** Referenz
 * mit der Eingabe: Eine spätere Änderung am übergebenen Objekt darf einen
 * bereits erzeugten Snapshot nicht rückwirkend verändern.
 */
function toLogoAssetReference(logo: LogoAssetReference): LogoAssetReference {
  if (typeof logo.assetId !== 'string' || logo.assetId === '') {
    throw new Error('BRANDING-SNAPSHOT: assetId fehlt.');
  }
  if (!isLogoMimeType(logo.mimeType)) {
    throw new Error(`BRANDING-SNAPSHOT: unzulässiger Logo-Typ "${String(logo.mimeType)}".`);
  }
  return { assetId: logo.assetId, mimeType: logo.mimeType };
}

/**
 * Friert das übergebene Branding ein.
 *
 * Ein leeres Profil ist gültig und ergibt `{ version: 1 }` — keine leeren
 * Platzhalterfelder.
 */
export function buildBrandingSnapshot(profile: BrandingProfile): BrandingSnapshot {
  const snapshot: BrandingSnapshot = { version: BRANDING_SNAPSHOT_VERSION };

  if (profile.logo !== undefined) {
    snapshot.logo = toLogoAssetReference(profile.logo);
  }

  if (profile.primaryColor !== undefined) {
    if (!isValidBrandingPrimaryColor(profile.primaryColor)) {
      throw new Error(
        `BRANDING-SNAPSHOT: primaryColor "${profile.primaryColor}" ist kein #rrggbb-Wert.`,
      );
    }
    snapshot.primaryColor = profile.primaryColor;
  }

  return snapshot;
}
