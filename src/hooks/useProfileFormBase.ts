/**
 * FINANZ-CORE-01A (EIN-03) — der Ausgangsstand eines Einstellungsformulars über dem Firmenprofil.
 *
 * Die Einstellungsseiten bauten ihren Entwurf einmal aus dem Profil und schrieben beim Speichern
 * alle Felder der Seite zurück. Hatte ein anderes Gerät inzwischen etwa die IBAN geändert, ging
 * der alte Wert mit einer ganz anderen Änderung (eine neue Telefonnummer) zurück in die Cloud und
 * auf neue Rechnungen — ohne Konflikt.
 *
 * Jetzt merkt sich die Seite, aus welchem Stand ihr Entwurf entstand. Ändert sich das Profil
 * (Abzug aus der Cloud), übernehmen die Felder, die der Nutzer nicht angefasst hat, den neuen
 * Wert; gespeichert werden nur die Felder, die er geändert hat.
 */
import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { CompanyProfile } from '../types/models';

const wert = (value: unknown): string =>
  value === undefined || value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);

/** Nur die Felder, deren Wert vom Ausgangsstand abweicht. */
export function changedProfileFields<T extends object>(next: T, base: Partial<T>): Partial<T> {
  const changed: Partial<T> = {};
  for (const key of Object.keys(next) as Array<keyof T>) {
    if (wert(next[key]) !== wert(base[key])) changed[key] = next[key];
  }
  return changed;
}

export function useProfileFormBase<D extends object>(
  profile: CompanyProfile,
  pick: (profile: CompanyProfile) => D,
  setDraft: Dispatch<SetStateAction<D>>,
): MutableRefObject<D> {
  const picked = pick(profile);
  const fingerprint = JSON.stringify(picked);
  const baseRef = useRef<D>(picked);

  useEffect(() => {
    const vorher = baseRef.current;
    if (JSON.stringify(vorher) === fingerprint) return;
    const neu = JSON.parse(fingerprint) as D;
    setDraft((prev) => {
      const merged = { ...prev };
      for (const key of Object.keys(neu) as Array<keyof D>) {
        // Unberührt (noch der alte Ausgangswert) → der neue Stand; geänderte Felder bleiben.
        if (wert(prev[key]) === wert(vorher[key])) merged[key] = neu[key];
      }
      return merged;
    });
    baseRef.current = neu;
  }, [fingerprint, setDraft]);

  return baseRef;
}
