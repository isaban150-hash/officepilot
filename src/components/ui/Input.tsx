import type { InputHTMLAttributes, ReactNode } from 'react';

export interface InputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'prefix' | 'suffix'> {
  label?: string;
  helperText?: string;
  error?: string;
  prefix?: ReactNode;
  suffix?: ReactNode;
}

export function Input({
  label,
  helperText,
  error,
  prefix,
  suffix,
  className = '',
  id,
  ...props
}: InputProps) {
  const inputId = id ?? (label ? `input-${label.replace(/\s+/g, '-').toLowerCase()}` : undefined);
  const describedBy = error ? `${inputId}-error` : helperText ? `${inputId}-helper` : undefined;

  const control = (
    <input
      id={inputId}
      className={[
        'input',
        error ? 'input--error form-field__control--error' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      aria-invalid={error ? true : undefined}
      aria-describedby={describedBy}
      {...props}
    />
  );

  return (
    <div className="form-field">
      {label ? (
        <label className="form-field__label" htmlFor={inputId}>
          {label}
        </label>
      ) : null}
      {prefix || suffix ? (
        <div className="form-field__control-wrap">
          {prefix ? <span className="form-field__affix">{prefix}</span> : null}
          {control}
          {suffix ? <span className="form-field__affix">{suffix}</span> : null}
        </div>
      ) : (
        control
      )}
      {helperText && !error ? (
        <p className="form-field__helper" id={`${inputId}-helper`}>
          {helperText}
        </p>
      ) : null}
      {error ? (
        <p className="form-field__error" id={`${inputId}-error`} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
