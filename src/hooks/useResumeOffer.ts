import { useCallback, useState } from 'react';
import { useFormResume, type FormResumeInput } from './useFormResume';

/**
 * EINRICHTUNG-01 (AP8; Vertrag 1.27, X-02/X-03) — Wiederaufnahme mit Angebot, auf `useFormResume` (unverändert).
 *
 * Das Formular zeigt zuerst den gespeicherten Stand. Gibt es einen passenden Entwurf (je Konto, Betrieb und Datensatz
 * über die UI-Sitzung), bietet die Seite „Fortsetzen“ oder „Verwerfen“ an; solange das Angebot offen ist, bleibt der
 * Entwurf gemeldet und damit erhalten. Ein veralteter Entwurf (Daten inzwischen geändert) wird verworfen; `stale`
 * zeigt den Hinweis. Nach erfolgreichem Speichern `clear()`: kein Entwurf mehr.
 *
 * App-Eigenprüfung (N-08; 1.27) — ändert jemand bei offenem Angebot selbst etwas, wird ab dann diese Eingabe gemeldet.
 * Vorher blieb der alte Entwurf stehen: Die Rückfrage beim Verlassen sagte „Ihre Eingaben bleiben als Entwurf
 * erhalten …“, nach der Rückkehr setzte „Fortsetzen“ aber den alten Entwurf ein, die neue Eingabe war fort. Das Angebot
 * bleibt sichtbar; „Fortsetzen“ holt den alten Entwurf ausdrücklich zurück. Ohne eigene Änderung (oder nach deren
 * Rücknahme) bleibt der alte Entwurf gemeldet.
 */
export interface ResumeOffer<T extends object> {
  pending: boolean;
  stale: boolean;
  /** Übernimmt den Entwurf: die Werte zum Einsetzen in den Formularzustand. */
  continueDraft(): Partial<T>;
  /** Verwirft den Entwurf; spätere Eingaben werden wieder zum Entwurf. */
  discardDraft(): void;
  dismissStale(): void;
  /** Nach erfolgreichem Speichern. */
  clear(): void;
}

export function useResumeOffer<T extends object>(input: FormResumeInput<T> & { current: T }): ResumeOffer<T> {
  const { current, ...resumeInput } = input;
  const resume = useFormResume<T>(resumeInput);
  const [pending, setPending] = useState(() => Object.keys(resume.restored).length > 0);
  const [stale, setStale] = useState(resume.staleDiscarded);

  // Während des Renders melden (Vertrag von `useFormResume`): offen → der Entwurf, sonst der aktuelle Stand; offen mit
  // eigener Änderung (das Formular weicht vom gespeicherten Stand ab) → ebenfalls der aktuelle Stand (N-08).
  const eigeneAenderung = pending && input.fields.some((field) => current[field] !== input.saved[field]);
  resume.observe(pending && !eigeneAenderung ? ({ ...input.saved, ...resume.restored } as T) : current);

  const continueDraft = useCallback(() => {
    setPending(false);
    return resume.restored;
  }, [resume.restored]);
  const discardDraft = useCallback(() => setPending(false), []);
  const dismissStale = useCallback(() => setStale(false), []);
  return { pending, stale, continueDraft, discardDraft, dismissStale, clear: resume.clearResume };
}
