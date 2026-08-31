/**
 * BRANDING-01E-1 — der Cloud-Contract des Branding-Blocks im `CompanyProfile`.
 *
 * Zuständig für genau eine Frage: Was von einem aus der Cloud gelesenen
 * `branding` darf lokal übernommen werden?
 *
 * Der Contract ist **geschlossen**. Erlaubt sind ausschliesslich:
 *
 *   branding.logo.assetId
 *   branding.logo.mimeType
 *   branding.primaryColor
 *
 * Alles andere wird verworfen — auch scheinbar harmlose Zusatzfelder. Ein
 * Speicherpfad, eine signierte URL oder ein zweiter Farbwert hätten in einem
 * Geschäftsdatensatz nichts verloren; stillschweigend mitgeführte Metadaten
 * wären zudem nirgends geprüft und würden beim nächsten Push unbesehen wieder
 * hochgeladen.
 *
 * Abgrenzung zu BRANDING-01E-0: Der Server bewahrt einen **komplett fehlenden**
 * `branding`-Schlüssel, damit ein alter Client keinen neuen Block löscht. Das
 * ist eine Aussage über den Block als Ganzes und ausdrücklich **keine**
 * allgemeine Regel, unbekannte Unterfelder zu konservieren.
 *
 * Bewusst NICHT hier: Datei-Upload, Magic Bytes, Asset-Existenz, Storage,
 * Resolver, Cache, URL-Erzeugung. `brandingLogoValidation.ts` prüft hochgeladene
 * **Dateien** und ist für einen reinen Referenz-Contract das falsche Werkzeug.
 */

import { LOGO_MIME_TYPES } from '../../types/branding';
import type { BrandingProfile, LogoMimeType } from '../../types/branding';

/**
 * Genau `#RRGGBB`. Keine Kurzform, kein Alpha, keine Farbnamen.
 *
 * Die Prüfung ist bewusst streng und **korrigiert nichts**: kein `trim`, keine
 * Gross-/Kleinschreibung, keine Reparatur. Eine Farbe mit Leerzeichen ist
 * ungültig und wird verworfen, nicht stillschweigend zurechtgebogen — sonst
 * wüsste niemand mehr, ob der gespeicherte Wert der eingegebene ist.
 */
const PRIMARY_COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLogoMimeType(value: unknown): value is LogoMimeType {
  return typeof value === 'string' && (LOGO_MIME_TYPES as readonly string[]).includes(value);
}

/**
 * Das Logo ist **atomar**: Eine `assetId` ohne gültigen `mimeType` ist nicht
 * ladbar, und eine halbe Referenz ist schlechter als keine — sie erzeugt später
 * eine Fehlanzeige statt eines sauberen Leerzustands.
 *
 * `assetId` wird nur geprüft, nicht verändert. `trim()` dient allein der
 * Leerprüfung; gespeichert wird der ursprüngliche String.
 */
function sanitizeLogo(value: unknown): BrandingProfile['logo'] | undefined {
  if (!isPlainObject(value)) return undefined;
  const { assetId, mimeType } = value;
  if (typeof assetId !== 'string' || assetId.trim().length === 0) return undefined;
  if (!isLogoMimeType(mimeType)) return undefined;
  return { assetId, mimeType };
}

/**
 * Ein Branding-Block, auf den erlaubten Vertrag reduziert — **in beide
 * Richtungen**.
 *
 * Dieselbe Funktion prüft, was aus der Cloud übernommen wird, und was in die
 * Cloud geschrieben wird. Zwei getrennte Regelsätze würden zwangsläufig
 * auseinanderlaufen, und ein Typ allein ist kein Laufzeitschutz: Ein lokal
 * verunreinigtes Objekt — aus einem Import, einem älteren Bundle, einer
 * fehlerhaften Zuweisung — käme sonst am Write ungeprüft vorbei.
 *
 * Rückgabewerte:
 *
 *   `undefined` — kein gültiger Branding-Block; der Schlüssel wird nicht
 *                 gesetzt. Das gilt für ein fehlendes Feld ebenso wie für
 *                 `null`, einen String, eine Zahl, einen Boolean oder ein Array.
 *                 Beim Write bedeutet das ausdrücklich **kein** Löschsignal:
 *                 Der Schlüssel fehlt, und der Server bewahrt (D-022).
 *   `{}`        — ausdrücklich leeres Branding. Dieser Zustand bleibt erhalten
 *                 und wird **nicht** zu „fehlt" umgedeutet: Seit 01E-0 ist `{}`
 *                 das einzige Löschsignal, und der Unterschied muss den
 *                 Roundtrip überleben.
 *
 * Teilweise ungültig wird feldweise behandelt: Ein kaputter Farbwert darf keine
 * gültige Logo-Referenz mitreissen und umgekehrt.
 */
export function sanitizeBrandingProfile(value: unknown): BrandingProfile | undefined {
  if (!isPlainObject(value)) return undefined;

  const sanitized: BrandingProfile = {};

  const logo = sanitizeLogo(value.logo);
  if (logo) sanitized.logo = logo;

  const { primaryColor } = value;
  if (typeof primaryColor === 'string' && PRIMARY_COLOR_PATTERN.test(primaryColor)) {
    sanitized.primaryColor = primaryColor;
  }

  return sanitized;
}

/**
 * Wendet den Contract auf ein `CompanyProfile`-artiges Objekt an und gibt eine
 * flache Kopie zurück. Genau diese Funktion steht auf **beiden** Seiten der
 * Cloud-Grenze — Read wie Write —, damit die Schlüsselbehandlung nicht an zwei
 * Stellen gepflegt werden muss.
 *
 * Wichtig ist die Unterscheidung zwischen „Schlüssel entfernen" und „Wert auf
 * `undefined` setzen". Nur das Entfernen ergibt in beide Richtungen das
 * Richtige: lokal ein Profil ohne gesetztes Feld, ausgehend ein Payload ohne den
 * Schlüssel — und damit das Preserve-Verhalten aus 01E-0 statt eines
 * versehentlichen Löschsignals.
 *
 * Ausschliesslich `branding` wird angefasst. Es gibt bewusst keinen allgemeinen
 * `CompanyProfile`-Sanitizer.
 */
export function applyBrandingContract<T extends Record<string, unknown>>(profileLike: T): T {
  if (!('branding' in profileLike)) return { ...profileLike };

  const next = { ...profileLike } as Record<string, unknown>;
  const branding = sanitizeBrandingProfile(profileLike.branding);
  if (branding) {
    next.branding = branding;
  } else {
    delete next.branding;
  }
  return next as T;
}
