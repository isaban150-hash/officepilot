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
/**
 * BRANDING-01F-2 — die Gegenrichtung: einen aus der Cloud gelesenen Snapshot
 * annehmen oder verwerfen.
 *
 * Bewusst **kein** Aufruf von `buildBrandingSnapshot`: Der ist ein Builder aus
 * einem `BrandingProfile` und würde einen fremden Fremdwert erst in ein Profil
 * umdeuten müssen. Ein Parser hat eine andere Aufgabe — er akzeptiert nichts,
 * was er nicht kennt.
 *
 * Der Vertrag ist geschlossen: `version`, `logo`, `primaryColor` und sonst
 * nichts; im Logo ausschliesslich `assetId` und `mimeType`. Alles andere macht
 * den ganzen Snapshot ungültig, statt still gekürzt zu werden — im Zweifel
 * lieber kein Branding als ein halbes, das nicht mehr dem Original entspricht.
 *
 * Rückgabe `null` heisst „nicht übernehmbar"; der Aufrufer entscheidet, ob das
 * eine Ablehnung oder ein fehlendes Feld bedeutet.
 */
export function parseBrandingSnapshotFromCloud(value: unknown): BrandingSnapshot | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;

  for (const key of Object.keys(raw)) {
    if (key !== 'version' && key !== 'logo' && key !== 'primaryColor') return null;
  }

  if (raw.version !== BRANDING_SNAPSHOT_VERSION) return null;
  const snapshot: BrandingSnapshot = { version: BRANDING_SNAPSHOT_VERSION };

  if (raw.logo !== undefined) {
    const logo = raw.logo;
    if (typeof logo !== 'object' || logo === null || Array.isArray(logo)) return null;
    const logoRaw = logo as Record<string, unknown>;
    for (const key of Object.keys(logoRaw)) {
      if (key !== 'assetId' && key !== 'mimeType') return null;
    }
    const { assetId, mimeType } = logoRaw;
    if (typeof assetId !== 'string' || assetId.trim().length === 0) return null;
    if (typeof mimeType !== 'string' || !isLogoMimeType(mimeType)) return null;
    snapshot.logo = { assetId, mimeType };
  }

  if (raw.primaryColor !== undefined) {
    if (typeof raw.primaryColor !== 'string') return null;
    if (!isValidBrandingPrimaryColor(raw.primaryColor)) return null;
    snapshot.primaryColor = raw.primaryColor;
  }

  return snapshot;
}

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
