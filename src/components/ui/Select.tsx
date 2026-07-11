import type { ReactNode, SelectHTMLAttributes } from 'react';

export interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  helperText?: string;
  error?: string;
  children: ReactNode;
}

export function Select({
  label,
  helperText,
  error,
  className = '',
  id,
  children,
  ...props
}: SelectProps) {
  const selectId = id ?? (label ? `select-${label.replace(/\s+/g, '-').toLowerCase()}` : undefined);
  const describedBy = error ? `${selectId}-error` : helperText ? `${selectId}-helper` : undefined;

  return (
    <div className="form-field">
      {label ? (
        <label className="form-field__label" htmlFor={selectId}>
          {label}
        </label>
      ) : null}
      <select
        id={selectId}
        className={[
          'select',
          error ? 'input--error form-field__control--error' : '',
          className,
        ]
          .filter(Boolean)
          .join(' ')}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        {...props}
      >
        {children}
      </select>
      {helperText && !error ? (
        <p className="form-field__helper" id={`${selectId}-helper`}>
          {helperText}
        </p>
      ) : null}
      {error ? (
        <p className="form-field__error" id={`${selectId}-error`} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
