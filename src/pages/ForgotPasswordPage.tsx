import { Link } from 'react-router-dom';
import { AuthLayout } from '../components/auth/AuthLayout';
import { useApp } from '../context/AppContext';

export function ForgotPasswordPage() {
  const { translate } = useApp();

  return (
    <AuthLayout
      title={translate('auth.forgotPassword.title')}
      subtitle={translate('auth.forgotPassword.subtitle')}
      testId="forgot-password-page"
    >
      <div className="auth-info">
        <p>{translate('auth.forgotPassword.body')}</p>
        <Link to="/login" className="btn btn--outline btn--full">
          {translate('auth.forgotPassword.backToLogin')}
        </Link>
      </div>
    </AuthLayout>
  );
}
