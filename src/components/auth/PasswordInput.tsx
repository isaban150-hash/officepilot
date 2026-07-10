import { useId, useState, type InputHTMLAttributes } from 'react';

interface PasswordInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  label: string;
  testId: string;
  toggleTestId?: string;
}

export function PasswordInput({
  label,
  testId,
  toggleTestId,
  id,
  className,
  ...inputProps
}: PasswordInputProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const [visible, setVisible] = useState(false);

  return (
    <label className={`auth-form__field auth-form__field--password ${className ?? ''}`.trim()}>
      <span>{label}</span>
      <div className="auth-form__password-wrap">
        <input
          {...inputProps}
          id={inputId}
          type={visible ? 'text' : 'password'}
          data-testid={testId}
          className="auth-form__password-input"
        />
        <button
          type="button"
          className="auth-form__password-toggle"
          aria-label={visible ? 'Passwort ausblenden' : 'Passwort anzeigen'}
          aria-pressed={visible}
          data-testid={toggleTestId ?? `${testId}-toggle`}
          onClick={() => setVisible((current) => !current)}
        >
          {visible ? (
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path
                d="M3 3l18 18M10.58 10.58A2 2 0 0 0 12 15a2 2 0 0 0 1.42-.58M9.88 5.09A10.94 10.94 0 0 1 12 5c5 0 9.27 3.11 11 7.5a11.62 11.62 0 0 1-2.16 3.19M6.12 6.12A11.62 11.62 0 0 0 3 12.5C4.73 16.89 9 20 14 20a10.94 10.94 0 0 0 4.12-.79"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path
                d="M2 12.5C3.73 8.11 8 5 13 5s9.27 3.11 11 7.5c-1.73 4.39-6 7.5-11 7.5S3.73 16.89 2 12.5Z"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.75"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <circle cx="13" cy="12.5" r="3" fill="none" stroke="currentColor" strokeWidth="1.75" />
            </svg>
          )}
        </button>
      </div>
    </label>
  );
}
