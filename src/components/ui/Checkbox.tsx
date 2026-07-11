import type { InputHTMLAttributes, ReactNode } from 'react';

export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label: ReactNode;
}

export function Checkbox({ label, className = '', disabled, id, ...props }: CheckboxProps) {
  const checkboxId = id ?? `checkbox-${String(label).replace(/\s+/g, '-').toLowerCase()}`;

  return (
    <label
      className={[
        'checkbox-field',
        disabled ? 'checkbox-field--disabled' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      htmlFor={checkboxId}
    >
      <input
        id={checkboxId}
        type="checkbox"
        className="checkbox-field__input"
        disabled={disabled}
        {...props}
      />
      <span>{label}</span>
    </label>
  );
}
