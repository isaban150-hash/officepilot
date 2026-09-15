import type { ReactNode, SelectHTMLAttributes } from 'react';
import { FormField } from './FormField';

/**
 * UIUX-FOUNDATION-01B — kanonische Select-Komponente (gehärtet, nicht
 * ersetzt): baut jetzt auf `FormField` auf. Der native `<select>` bleibt —
 * er ist mobil (iOS/Android-Picker) die verlässlichste Wahl.
 */
export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  helperText?: string;
  error?: string;
  children: ReactNode;
  fieldClassName?: string;
  fieldTestId?: string;
}

export function Select({
  label,
  helperText,
  error,
  className = '',
  id,
  required,
  disabled,
  children,
  fieldClassName,
  fieldTestId,
  ...props
}: SelectProps) {
  return (
    <FormField
      label={label}
      hint={helperText}
      error={error}
      required={required}
      disabled={disabled}
      id={id}
      className={fieldClassName}
      testId={fieldTestId}
    >
      {({ readOnly: _readOnly, ...control }) => (
        <span className="select-wrap">
          <select
            {...control}
            className={['select', error ? 'input--error form-field__control--error' : '', className]
              .filter(Boolean)
              .join(' ')}
            {...props}
          >
            {children}
          </select>
        </span>
      )}
    </FormField>
  );
}
