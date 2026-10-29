import { Navigate, useLocation, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { RETURN_PATH_PARAM, buildLoginRedirect, resolvePendingReturnPath, resolveReturnPathForUser } from '../services/auth/authReturnPath';

/**
 * EINRICHTUNG-01 (AP2, A-12.1) — abgemeldet eine Seite aufrufen: zur Anmeldung, mit der Seite als Rücksprungziel.
 */
export function LoginRedirect() {
  const location = useLocation();
  return <Navigate to={buildLoginRedirect(location.pathname, location.search, location.hash)} replace />;
}

/**
 * EINRICHTUNG-01 (AP2, A-12) — angemeldet auf `/login`: zum geprüften Rücksprungziel, sonst zur Startseite.
 */
export function AuthenticatedLoginRedirect() {
  const { user } = useAuth();
  const [searchParams] = useSearchParams();
  const target = resolveReturnPathForUser(searchParams.get(RETURN_PATH_PARAM), user);
  return <Navigate to={target ?? '/'} replace />;
}

/**
 * EINRICHTUNG-01 (AP4, Weg C; A-12) — ein wartendes Konto auf `/login`: Rücksprung nur zur Einladungsseite, über die
 * es sich gerade angemeldet hat; jedes andere Ziel führt zur Warteseite.
 */
export function PendingLoginRedirect() {
  const { user } = useAuth();
  const [searchParams] = useSearchParams();
  return <Navigate to={resolvePendingReturnPath(searchParams.get(RETURN_PATH_PARAM), user) ?? '/waiting-approval'} replace />;
}
