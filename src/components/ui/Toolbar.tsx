import type { InputHTMLAttributes } from 'react';
import { Icon } from './Icon';

/**
 * UIUX-FOUNDATION-01D — Toolbar-Primitives: Suchfeld und Filter-Chips.
 * Ersetzen die verstreuten `input.document-search` / `chip-group`-Muster.
 * Zustand und Logik bleiben beim Aufrufer.
 */
export interface SearchFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  /** Sichtbares Label für Screenreader; wird auch als Placeholder verwendet, wenn keiner gesetzt ist. */
  label: string;
  testId?: string;
}

export function SearchField({ label, placeholder, className = '', testId = 'search-field', ...props }: SearchFieldProps) {
  return (
    <label className={['search-field', className].filter(Boolean).join(' ')} data-testid={testId}>
      <Icon id="search" size="sm" className="search-field__icon" />
      <span className="sr-only">{label}</span>
      <input type="search" className="input search-field__input" placeholder={placeholder ?? label} {...props} />
    </label>
  );
}

export interface FilterChipOption<T extends string> {
  id: T;
  label: string;
  count?: number;
}

export interface FilterChipsProps<T extends string> {
  options: readonly FilterChipOption<T>[];
  value: T;
  onChange: (value: T) => void;
  label: string;
  testIdPrefix?: string;
  testId?: string;
  className?: string;
}

export function FilterChips<T extends string>({ options, value, onChange, label, testIdPrefix = 'filter-chip', testId, className = '' }: FilterChipsProps<T>) {
  return (
    <div className={['chip-group', 'filter-chips', className].filter(Boolean).join(' ')} role="group" aria-label={label} data-testid={testId}>
      {options.map((option) => {
        const active = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            className={['chip', active ? 'chip--active' : ''].filter(Boolean).join(' ')}
            aria-pressed={active}
            onClick={() => onChange(option.id)}
            data-testid={`${testIdPrefix}-${option.id}`}
          >
            {option.label}
            {typeof option.count === 'number' ? <span className="chip__count">{option.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
