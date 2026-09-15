import type { InputHTMLAttributes, ReactNode } from 'react';
import { FormField } from './FormField';

/**
 * UIUX-FOUNDATION-01B — Input baut auf `FormField` auf (Label, Hinweis,
 * Fehler, Pflicht, aria-Verdrahtung). API unverändert.
 */
export interface InputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'prefix' | 'suffix'> {
  label?: string;
  helperText?: string;
  error?: string;
  prefix?: ReactNode;
  suffix?: ReactNode;
  fieldClassName?: string;
  fieldTestId?: string;
}

export function Input({
  label,
  helperText,
  error,
  prefix,
  suffix,
  className = '',
  id,
  required,
  disabled,
  readOnly,
  fieldClassName,
  fieldTestId,
  ...props
}: InputProps) {
  return (
    <FormField
      label={label}
      hint={helperText}
      error={error}
      required={required}
      disabled={disabled}
      readOnly={readOnly}
      id={id}
      className={fieldClassName}
      testId={fieldTestId}
    >
      {(control) => {
        const element = (
          <input
            {...control}
            className={['input', error ? 'input--error form-field__control--error' : '', className]
              .filter(Boolean)
              .join(' ')}
            {...props}
          />
        );
        if (!prefix && !suffix) return element;
        return (
          <div className="form-field__control-wrap">
            {prefix ? <span className="form-field__affix">{prefix}</span> : null}
            {element}
            {suffix ? <span className="form-field__affix">{suffix}</span> : null}
          </div>
        );
      }}
    </FormField>
  );
}
