import type { BrandingProfile, LogoAssetReference } from '../../types/branding';

/**
 * BRANDING-01E-2 / SETTINGS-01B3 — die beiden Änderungen am Branding-Block,
 * die eine Oberfläche vornehmen darf. Herausgezogen aus den Firmendaten,
 * damit Design-Seite und Legacy-Formular dieselbe Regel teilen.
 */

/** Die Logo-Referenz setzen, ohne den Branding-Block zu überschreiben. */
export function withLogoReference(
  branding: BrandingProfile | undefined,
  logo: LogoAssetReference,
): BrandingProfile {
  return { ...branding, logo };
}

/**
 * Die Logo-Referenz entfernen.
 *
 * Bleibt danach kein gültiges Unterfeld übrig, wird `{}` gesetzt und **nicht**
 * der Schlüssel weggelassen: Nur `{}` ist nach D-022 das ausdrückliche Leeren;
 * ein fehlender Schlüssel bedeutet serverseitig „bewahren". Gab es vorher gar
 * kein Branding, entsteht auch keines. Das historische Asset bleibt im Bucket —
 * alte Dokumente referenzieren es über ihren `brandingSnapshot`.
 */
export function withoutLogoReference(branding: BrandingProfile | undefined): BrandingProfile | undefined {
  if (!branding) return undefined;
  const { logo: _logo, ...rest } = branding;
  return rest;
}
