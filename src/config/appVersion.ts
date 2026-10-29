import { isProductionBuild, isStagingEnvironment } from './productionGuard';

/**
 * EINRICHTUNG-01 (AP5; N-06.1) — Version und Stand dieser App für die Seite „Hilfe und Rechtliches › Version“.
 *
 * - `APP_VERSION` folgt `package.json` (der Test `einrichtung01HubAp5` vergleicht beide).
 * - `APP_VERSION_STATE` ist der Stand der Version (Datum ihrer letzten Festlegung, ISO). Beim Veröffentlichen wird er
 *   mit der Version nachgeführt (RELEASE-01).
 * - Eine Build-Kennung (z. B. Commit) kann der Build über `VITE_APP_BUILD_ID` mitgeben. Fehlt sie, zeigt die Seite
 *   „lokaler Entwicklungsstand“. Nur Ziffern, Buchstaben, Punkt, Bindestrich und Unterstrich werden angezeigt.
 */
export const APP_VERSION = '1.0.0';
export const APP_VERSION_STATE = '2026-10-24';

const BUILD_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export function resolveAppBuildId(raw: unknown = import.meta.env.VITE_APP_BUILD_ID): string | null {
  const value = typeof raw === 'string' ? raw.trim() : '';
  return BUILD_ID_PATTERN.test(value) ? value : null;
}

export type AppEnvironment = 'production' | 'staging' | 'development';

export function resolveAppEnvironment(): AppEnvironment {
  if (isStagingEnvironment()) return 'staging';
  return isProductionBuild() ? 'production' : 'development';
}
