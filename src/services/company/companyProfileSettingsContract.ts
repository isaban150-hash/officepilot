import type { CompanyProfile, TaxStatus } from '../../types/models';
import { DEFAULT_DOCUMENT_TEMPLATE, isDocumentTemplateId, type DocumentTemplateId } from '../../types/branding';

/**
 * SETTINGS-01B1 — die kanonische Lesesemantik der neuen Profilfelder.
 *
 * Eine Funktion, beide Seiten der Cloud-Grenze und der lokale Ladepfad:
 * Was hier durchläuft, ist danach in genau einer Form gespeichert —
 * getrimmte Texte, ein gültiger Steuerstatus oder gar keiner. Altprofile
 * ohne die Felder bleiben unverändert (kein Backfill); fehlende Werte lesen
 * sich über die `resolve*`-Helfer als Vorgabe.
 *
 * Bewusst **nur** diese Felder. Es gibt weiterhin keinen allgemeinen
 * `CompanyProfile`-Sanitizer; Branding hat seinen eigenen Vertrag.
 */
export const COMPANY_PROFILE_TEXT_LIMITS = {
  /** Kontoinhaber — wie ein Firmenname. */
  accountHolder: 120,
  /** Einleitungs-/Schlusstext — mehrzeilig, wie Fussnoten. */
  defaultIntroText: 2000,
  defaultClosingText: 2000,
} as const;

export const TAX_STATUS_VALUES: readonly TaxStatus[] = [
  'standard_19',
  'standard_7',
  'kleinunternehmer_19',
  'reverse_charge_13b',
  'tax_free',
  'unclear',
];

export function isTaxStatus(value: unknown): value is TaxStatus {
  return typeof value === 'string' && (TAX_STATUS_VALUES as readonly string[]).includes(value);
}

const TEXT_FIELDS = ['accountHolder', 'defaultIntroText', 'defaultClosingText'] as const;

/**
 * Wendet den Vertrag auf ein Profil-artiges Objekt an und gibt eine flache
 * Kopie zurück. Ungültige Werte werden **entfernt** (nicht auf `undefined`
 * gesetzt), damit ein Payload ohne den Schlüssel entsteht.
 */
export function applyCompanyProfileSettingsContract<T extends Record<string, unknown>>(
  profileLike: T,
): T {
  const next = { ...profileLike } as Record<string, unknown>;

  for (const field of TEXT_FIELDS) {
    if (!(field in next)) continue;
    const value = next[field];
    if (typeof value !== 'string') {
      delete next[field];
      continue;
    }
    next[field] = value.trim();
  }

  if ('defaultTaxStatus' in next && !isTaxStatus(next.defaultTaxStatus)) {
    delete next.defaultTaxStatus;
  }

  return next as T;
}

/** Fehlend/leer → keine Vorgabe; der Aufrufer nimmt den Legacy-Fallback. */
export function resolveProfileDefaultTaxStatus(
  profile: Pick<CompanyProfile, 'defaultTaxStatus'>,
): TaxStatus | undefined {
  return isTaxStatus(profile.defaultTaxStatus) ? profile.defaultTaxStatus : undefined;
}

export function resolveProfileDefaultIntroText(
  profile: Pick<CompanyProfile, 'defaultIntroText'>,
): string {
  return (profile.defaultIntroText ?? '').trim();
}

export function resolveProfileDefaultClosingText(
  profile: Pick<CompanyProfile, 'defaultClosingText'>,
): string {
  return (profile.defaultClosingText ?? '').trim();
}

/**
 * Fehlend → `classic`. Ein unbekannter Wert (z. B. aus einer neueren Version)
 * wird **fail-closed** als `classic` angezeigt — SETTINGS-01B3. Nie eine
 * Profilmutation: das Feld bleibt im Profil, wie es ist.
 */
export function resolveProfileDocumentTemplate(
  profile: Pick<CompanyProfile, 'branding'>,
): DocumentTemplateId {
  const value = profile.branding?.documentTemplate;
  return value !== undefined && isDocumentTemplateId(value) ? value : DEFAULT_DOCUMENT_TEMPLATE;
}
