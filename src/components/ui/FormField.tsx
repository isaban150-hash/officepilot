import { useId, type ReactNode } from 'react';

/**
 * UIUX-FOUNDATION-01B — gemeinsames Label-/Hinweis-/Fehler-Pattern.
 *
 * `Input`, `Select` und `Textarea` bauen darauf auf; eigene Controls
 * (z. B. Datumsauswahl, Segmented Controls) nutzen die Render-Funktion und
 * erhalten die fertige ARIA-Verdrahtung (`id`, `aria-describedby`,
 * `aria-invalid`, `aria-required`).
 */
export interface FormFieldControlProps {
  id: string;
  'aria-describedby'?: string;
  'aria-invalid'?: true;
  'aria-required'?: true;
  required?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
}

export interface FormFieldProps {
  label?: ReactNode;
  /** Ergänzender Hinweis unter dem Control; wird bei Fehler ausgeblendet. */
  hint?: ReactNode;
  error?: ReactNode;
  required?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  /** Fester Bezeichner; sonst wird eine stabile React-ID erzeugt. */
  id?: string;
  /** Sichtbarer Pflicht-Marker; Standard „*“. */
  requiredMarker?: ReactNode;
  className?: string;
  testId?: string;
  children: (control: FormFieldControlProps) => ReactNode;
}

export function FormField({
  label,
  hint,
  error,
  required,
  disabled,
  readOnly,
  id,
  requiredMarker = '*',
  className = '',
  testId,
  children,
}: FormFieldProps) {
  const generatedId = useId();
  const controlId = id ?? `field${generatedId}`;
  const hintId = `${controlId}-hint`;
  const errorId = `${controlId}-error`;
  const showHint = Boolean(hint) && !error;
  const describedBy = error ? errorId : showHint ? hintId : undefined;

  return (
    <div
      className={[
        'form-field',
        error ? 'form-field--error' : '',
        disabled ? 'form-field--disabled' : '',
        readOnly ? 'form-field--readonly' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      data-testid={testId}
    >
      {label ? (
        <label className="form-field__label" htmlFor={controlId}>
          {label}
          {required ? (
            <span className="form-field__required" aria-hidden>
              {' '}
              {requiredMarker}
            </span>
          ) : null}
        </label>
      ) : null}
      {children({
        id: controlId,
        'aria-describedby': describedBy,
        'aria-invalid': error ? true : undefined,
        'aria-required': required ? true : undefined,
        required,
        disabled,
        readOnly,
      })}
      {showHint ? (
        <p className="form-field__helper" id={hintId}>
          {hint}
        </p>
      ) : null}
      {error ? (
        <p className="form-field__error" id={errorId} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
