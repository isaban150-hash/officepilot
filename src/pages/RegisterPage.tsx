import { FormEvent, useState } from 'react';

import { Link, useNavigate } from 'react-router-dom';

import { AuthLayout } from '../components/auth/AuthLayout';

import { PasswordInput } from '../components/auth/PasswordInput';

import { Button } from '../components/ui/Button';

import { LICENSE_VERSION, PRIVACY_VERSION, TERMS_VERSION } from '../config/legalVersions';

import { useAuth } from '../context/AuthContext';

import { getRegisterErrorMessage } from '../services/auth/authService';



const PASSWORD_MISMATCH_MESSAGE = 'Die Passwörter stimmen nicht überein.';

const EMAIL_CONFIRMATION_SUCCESS_MESSAGE =

  'Registrierung erfolgreich. Bitte bestätigen Sie Ihre E-Mail-Adresse.';



export function RegisterPage() {

  const { register } = useAuth();

  const navigate = useNavigate();

  const [companyName, setCompanyName] = useState('');

  const [firstName, setFirstName] = useState('');

  const [lastName, setLastName] = useState('');

  const [email, setEmail] = useState('');

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

      setError(getRegisterErrorMessage('terms_required'));

      return;

    }



    if (password !== passwordConfirm) {

      setError(PASSWORD_MISMATCH_MESSAGE);

      return;

    }



    setLoading(true);

    const result = await register({

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

    setLoading(false);



    if (!result.success) {

      setError(getRegisterErrorMessage(result.error));

      return;

    }



    if (result.outcome === 'email_confirmation_required') {

      setSuccess(EMAIL_CONFIRMATION_SUCCESS_MESSAGE);

      return;

    }



    navigate('/waiting-approval', { replace: true });

  }



  return (

    <AuthLayout

      title="Registrieren"

      subtitle="Erstellen Sie Ihren OfficePilot-Zugang. Die Freischaltung erfolgt durch einen Administrator."

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

        <label className="auth-form__field">

          <span>Firma</span>

          <input value={companyName} onChange={(e) => setCompanyName(e.target.value)} required data-testid="register-company" />

        </label>

        <div className="auth-form__row">

          <label className="auth-form__field">

            <span>Vorname</span>

            <input value={firstName} onChange={(e) => setFirstName(e.target.value)} required data-testid="register-first-name" />

          </label>

          <label className="auth-form__field">

            <span>Nachname</span>

            <input value={lastName} onChange={(e) => setLastName(e.target.value)} required data-testid="register-last-name" />

          </label>

        </div>

        <label className="auth-form__field">

          <span>E-Mail</span>

          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required data-testid="register-email" />

        </label>

        <PasswordInput

          label="Passwort"

          testId="register-password"

          toggleTestId="register-password-toggle"

          value={password}

          onChange={(e) => setPassword(e.target.value)}

          required

          minLength={8}

          autoComplete="new-password"

        />

        <PasswordInput

          label="Passwort wiederholen"

          testId="register-password-confirm"

          toggleTestId="register-password-confirm-toggle"

          value={passwordConfirm}

          onChange={(e) => setPasswordConfirm(e.target.value)}

          required

          minLength={8}

          autoComplete="new-password"

        />

        <label className="auth-form__field">

          <span>Telefon (optional)</span>

          <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} data-testid="register-phone" />

        </label>

        <label className="auth-form__field">

          <span>Branche (optional)</span>

          <input value={industry} onChange={(e) => setIndustry(e.target.value)} data-testid="register-industry" />

        </label>

        <label className="auth-form__checkbox">

          <input type="checkbox" checked={acceptTerms} onChange={(e) => setAcceptTerms(e.target.checked)} data-testid="register-terms" />

          <span>

            Ich akzeptiere die{' '}

            <Link to="/agb" target="_blank" rel="noopener noreferrer">

              AGB

            </Link>{' '}

            (Version {TERMS_VERSION})

          </span>

        </label>

        <label className="auth-form__checkbox">

          <input type="checkbox" checked={acceptPrivacy} onChange={(e) => setAcceptPrivacy(e.target.checked)} data-testid="register-privacy" />

          <span>

            Ich habe die{' '}

            <Link to="/datenschutz" target="_blank" rel="noopener noreferrer">

              Datenschutzerklärung

            </Link>{' '}

            gelesen (Version {PRIVACY_VERSION})

          </span>

        </label>

        <label className="auth-form__checkbox">

          <input type="checkbox" checked={acceptLicense} onChange={(e) => setAcceptLicense(e.target.checked)} data-testid="register-license" />

          <span>

            Ich akzeptiere die{' '}

            <Link to="/lizenzbedingungen" target="_blank" rel="noopener noreferrer">

              Lizenzbedingungen

            </Link>{' '}

            (Version {LICENSE_VERSION})

          </span>

        </label>

        <Button type="submit" fullWidth disabled={loading} data-testid="register-submit">

          {loading ? 'Wird registriert…' : 'Registrieren'}

        </Button>

        <p className="auth-form__links">

          <Link to="/login">Bereits registriert? Anmelden</Link>

        </p>

      </form>

    </AuthLayout>

  );

}


