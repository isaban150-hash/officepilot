import { FormEvent, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { AuthLayout } from '../components/auth/AuthLayout';
import { PasswordInput } from '../components/auth/PasswordInput';
import { Button } from '../components/ui/Button';
import { LICENSE_VERSION, PRIVACY_VERSION, TERMS_VERSION } from '../config/legalVersions';
import { useApp } from '../context/AppContext';
import { useAuth } from '../context/AuthContext';
import { getRegisterErrorMessage, getPostLoginRoute } from '../services/auth/authService';

export function RegisterPage() {
  const { register } = useAuth();
  const { translate, language } = useApp();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [companyName, setCompanyName] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  // EINRICHTUNG-01 (AP4, M-03.1) — aus dem Einladungslink vorbelegt; die Person kann sie ändern.
  const [email, setEmail] = useState(() => searchParams.get('email')?.trim() ?? '');
  const [password, setPassword] = useState('');
  const [passwordConfirm, setPasswordConfirm] = useState('');
  const [phone, setPhone] = useState('');
  const [industry, setIndustry] = useState('');
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [acceptPrivacy, setAcceptPrivacy] = useState(false);
  const [acceptLicense, setAcceptLicense] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setSuccess(null);

    if (!acceptTerms || !acceptPrivacy || !acceptLicense) {
      setError(getRegisterErrorMessage('terms_required', language));
      return;
    }

    if (password !== passwordConfirm) {
      setError(translate('auth.error.passwordMismatch'));
      return;
    }

    setLoading(true);
    let result: Awaited<ReturnType<typeof register>>;
    try {
      result = await register({
        companyName,
        firstName,
        lastName,
        email,
        password,
        phone: phone || undefined,
        industry: industry || undefined,
        acceptedTermsVersion: TERMS_VERSION,
        acceptedPrivacyVersion: PRIVACY_VERSION,
        acceptedLicenseVersion: LICENSE_VERSION,
      });
    } catch {
      // EINRICHTUNG-01 (EIN-26, A-09.2) — eine Ausnahme lässt das Formular nie im Ladezustand.
      setLoading(false);
      setError(getRegisterErrorMessage('registration_failed', language));
      return;
    }
    setLoading(false);

    if (!result.success) {
      setError(getRegisterErrorMessage(result.error, language));
      return;
    }

    if (result.outcome === 'email_confirmation_required') {
      setSuccess(translate('auth.success.registrationEmailConfirmation'));
      return;
    }

    navigate(getPostLoginRoute(result.payload.user), { replace: true });
  }

  return (
    <AuthLayout
      title={translate('auth.register.title')}
      subtitle={translate('auth.register.subtitle')}
      testId="register-page"
    >
      <form className="auth-form" onSubmit={handleSubmit}>
        {error ? (
          <p className="auth-form__error" role="alert" data-testid="register-error">
            {error}
          </p>
        ) : null}
        {success ? (
          <p className="auth-form__success" role="status" data-testid="register-success">
            {success}
          </p>
        ) : null}
        {success ? (
          // EINRICHTUNG-01 (A-08.1) — derselbe Hinweis für neue und bekannte Adressen: keine Existenzaussage.
          <p className="form-hint" data-testid="register-success-hint">
            {translate('auth.register.successHint')}
          </p>
        ) : null}
        <label className="auth-form__field">
          <span>{translate('auth.register.companyName')}</span>
          <input
            value={companyName}
            onChange={(e) => setCompanyName(e.target.value)}
            required
            data-testid="register-company"
          />
        </label>
        <div className="auth-form__row">
          <label className="auth-form__field">
            <span>{translate('auth.register.firstName')}</span>
            <input
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              required
              data-testid="register-first-name"
            />
          </label>
          <label className="auth-form__field">
            <span>{translate('auth.register.lastName')}</span>
            <input
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              required
              data-testid="register-last-name"
            />
          </label>
        </div>
        <label className="auth-form__field">
          <span>{translate('auth.login.email')}</span>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            data-testid="register-email"
          />
        </label>
        <PasswordInput
          label={translate('auth.register.password')}
          testId="register-password"
          toggleTestId="register-password-toggle"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          minLength={8}
          autoComplete="new-password"
        />
        <PasswordInput
          label={translate('auth.register.passwordConfirm')}
          testId="register-password-confirm"
          toggleTestId="register-password-confirm-toggle"
          value={passwordConfirm}
          onChange={(e) => setPasswordConfirm(e.target.value)}
          required
          minLength={8}
          autoComplete="new-password"
        />
        <label className="auth-form__field">
          <span>{translate('auth.register.phone')}</span>
          <input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            data-testid="register-phone"
          />
        </label>
        <label className="auth-form__field">
          <span>{translate('auth.register.industry')}</span>
          <input
            value={industry}
            onChange={(e) => setIndustry(e.target.value)}
            data-testid="register-industry"
          />
        </label>
        <label className="auth-form__checkbox">
          <input
            type="checkbox"
            checked={acceptTerms}
            onChange={(e) => setAcceptTerms(e.target.checked)}
            data-testid="register-terms"
          />
          <span>
            {translate('auth.register.acceptTerms')}{' '}
            <Link to="/agb" target="_blank" rel="noopener noreferrer">
              {translate('legal.footer.terms')}
            </Link>{' '}
            ({TERMS_VERSION})
          </span>
        </label>
        <label className="auth-form__checkbox">
          <input
            type="checkbox"
            checked={acceptPrivacy}
            onChange={(e) => setAcceptPrivacy(e.target.checked)}
            data-testid="register-privacy"
          />
          <span>
            {translate('auth.register.acceptPrivacy')}{' '}
            <Link to="/datenschutz" target="_blank" rel="noopener noreferrer">
              {translate('legal.footer.privacy')}
            </Link>{' '}
            ({PRIVACY_VERSION})
          </span>
        </label>
        <label className="auth-form__checkbox">
          <input
            type="checkbox"
            checked={acceptLicense}
            onChange={(e) => setAcceptLicense(e.target.checked)}
            data-testid="register-license"
          />
          <span>
            {translate('auth.register.acceptLicense')}{' '}
            <Link to="/lizenzbedingungen" target="_blank" rel="noopener noreferrer">
              {translate('legal.footer.license')}
            </Link>{' '}
            ({LICENSE_VERSION})
          </span>
        </label>
        <Button type="submit" fullWidth disabled={loading} data-testid="register-submit">
          {loading ? translate('auth.register.submitting') : translate('auth.register.submit')}
        </Button>
        <p className="auth-form__links">
          <Link to="/login">{translate('auth.login.submit')}</Link>
        </p>
      </form>
    </AuthLayout>
  );
}
