import type { TextareaHTMLAttributes } from 'react';
import { FormField } from './FormField';

/**
 * UIUX-FOUNDATION-01B — kanonisches mehrzeiliges Feld. Ersetzt künftig die
 * verstreuten `*__textarea`-Klassen; nutzt dieselbe Control-Optik wie Input.
 */
export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  helperText?: string;
  error?: string;
  fieldClassName?: string;
  fieldTestId?: string;
}

export function Textarea({
  label,
  helperText,
  error,
  className = '',
  id,
  required,
  disabled,
  readOnly,
  rows = 4,
  fieldClassName,
  fieldTestId,
  ...props
}: TextareaProps) {
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
      {(control) => (
        <textarea
          {...control}
          rows={rows}
          className={['input', 'textarea', error ? 'input--error form-field__control--error' : '', className]
            .filter(Boolean)
            .join(' ')}
          {...props}
        />
      )}
    </FormField>
  );
}
