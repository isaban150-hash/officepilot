/**
 * SKONTO-NUMERIC-INPUT-01B — eine Zahl eingeben, ohne gegen das Feld zu kämpfen.
 *
 * Bis hierher hingen die numerischen Firmendatenfelder direkt am Zahlwert:
 *
 *   value={draft.skontoPercent ?? 0}
 *   onChange={(e) => handleChange('skontoPercent', Number(e.target.value) || 0)}
 *
 * `Number('')` ist `0`. Der leere Zwischenzustand — der einzige natürliche Weg,
 * eine Zahl zu ersetzen — konnte den Handler nicht überleben. Weil der Handler
 * ausserdem bei jedem Tastendruck ein neues Entwurfsobjekt erzeugt, rendert
 * React unmittelbar neu und schreibt die `0` in ein Feld zurück, das der Nutzer
 * gerade geleert hatte. Auf dem iPhone hiess das: Die Null liess sich nicht
 * löschen, und aus einer getippten `2` wurde `02`.
 *
 * Der Baustein trennt deshalb zwei Dinge, die nie dasselbe waren:
 *
 *   - **die Anzeige** — ein Text, der auch leer oder halb getippt (`2,`) sein
 *     darf, solange das Feld bearbeitet wird
 *   - **den fachlichen Wert** — immer eine Zahl, nie ein leerer String, nie NaN
 *
 * Das Datenmodell bleibt unangetastet: Nach aussen gibt dieser Baustein
 * ausschliesslich `number` heraus.
 */
import { useState } from 'react';

export type NumericInputMode = 'integer' | 'decimal';

export interface NumericInputProps {
  id: string;
  value: number;
  onChange: (value: number) => void;
  mode: NumericInputMode;
  className?: string;
  min?: number;
  max?: number;
  'data-testid'?: string;
}

/** Ganze Zahlen ohne Trennzeichen; Dezimalzahlen mit höchstens einem. */
function sanitize(raw: string, mode: NumericInputMode): string {
  const digitsOnly = raw.replace(/[^\d.,]/g, '');
  if (mode === 'integer') return digitsOnly.replace(/[.,]/g, '');

  // Nur das erste Trennzeichen zählt — „2,5,3" wird zu „2,53".
  let seenSeparator = false;
  let result = '';
  for (const character of digitsOnly) {
    if (character === '.' || character === ',') {
      if (seenSeparator) continue;
      seenSeparator = true;
      result += character;
      continue;
    }
    result += character;
  }
  return result;
}

/**
 * Der fachliche Wert eines Anzeigetexts.
 *
 * `null` bedeutet „noch keine vollständige Zahl" — etwa bei `''` oder `'2,'`.
 * Der Aufrufer entscheidet, was das für den Entwurf heisst; **NaN entsteht hier
 * nie**.
 */
export function parseNumericInput(text: string): number | null {
  const normalized = text.replace(',', '.');
  if (!normalized || normalized === '.') return null;
  if (normalized.endsWith('.')) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

/** Die Anzeige eines gespeicherten Werts — deutsch, ohne unnötige Nachkommastelle. */
export function formatNumericValue(value: number, mode: NumericInputMode): string {
  if (!Number.isFinite(value)) return '';
  if (mode === 'integer') return String(Math.trunc(value));
  return Number.isInteger(value) ? String(value) : String(value).replace('.', ',');
}

export function NumericInput({
  id,
  value,
  onChange,
  mode,
  className,
  min,
  max,
  'data-testid': testId,
}: NumericInputProps) {
  /*
   * `null` heisst: Das Feld wird gerade nicht bearbeitet und zeigt den Wert des
   * Elternteils. Damit übernimmt es externe Änderungen — Wiederaufnahme nach
   * einem Neuaufbau, geladenes Profil — von selbst, ohne einen Abgleichseffekt.
   */
  const [draftText, setDraftText] = useState<string | null>(null);

  const displayed = draftText ?? formatNumericValue(value, mode);

  const handleChange = (raw: string) => {
    const next = sanitize(raw, mode);
    setDraftText(next);

    const parsed = parseNumericInput(next);
    /*
     * Ein leeres oder halbes Feld ergibt fachlich `0`. Der Elternteil bekommt
     * damit sofort einen gültigen Wert — auch wenn der Nutzer direkt auf
     * „Speichern" tippt, ohne das Feld zu verlassen. Die Anzeige bleibt davon
     * unberührt: Sie zeigt weiter den Text des Nutzers, nicht die `0`.
     */
    onChange(parsed ?? 0);
  };

  return (
    <input
      id={id}
      type="text"
      inputMode={mode === 'integer' ? 'numeric' : 'decimal'}
      autoComplete="off"
      className={className}
      value={displayed}
      data-testid={testId}
      aria-valuemin={min}
      aria-valuemax={max}
      onFocus={() => setDraftText(formatNumericValue(value, mode))}
      onChange={(event) => handleChange(event.target.value)}
      // Zurück zur Darstellung des fachlichen Werts — erst jetzt normalisiert.
      onBlur={() => setDraftText(null)}
    />
  );
}
