import type { ButtonHTMLAttributes, ReactNode } from 'react';

export type ButtonVariant =
  | 'primary'
  | 'secondary'
  | 'outline'
  | 'ghost'
  | 'danger'
  | 'on-dark'
  | 'on-dark-outline';

export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  loading?: boolean;
  icon?: ReactNode;
  iconPosition?: 'start' | 'end';
  children: ReactNode;
}

export function Button({
  variant = 'primary',
  size = 'md',
  fullWidth = false,
  loading = false,
  icon,
  iconPosition = 'start',
  className = '',
  disabled,
  children,
  ...props
}: ButtonProps) {
  const isDisabled = disabled || loading;

  return (
    <button
      className={[
        'btn',
        `btn--${variant}`,
        size !== 'md' ? `btn--${size}` : '',
        fullWidth ? 'btn--full' : '',
        loading ? 'btn--loading' : '',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
      disabled={isDisabled}
      aria-busy={loading || undefined}
      {...props}
    >
      {!loading && icon && iconPosition === 'start' ? (
        <span className="btn__icon btn__icon--start" aria-hidden>
          {icon}
        </span>
      ) : null}
      {children}
      {!loading && icon && iconPosition === 'end' ? (
        <span className="btn__icon btn__icon--end" aria-hidden>
          {icon}
        </span>
      ) : null}
    </button>
  );
}
