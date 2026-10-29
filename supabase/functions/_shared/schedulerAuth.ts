/**
 * EINRICHTUNG-01 (AP7) — Aufrufer der Dienstwege `account-deletion-resume` und `workspace-deletion-run`.
 *
 * Erlaubt sind nur (a) der Planer über pg_net mit dem Geheimnis aus dem Vault (Header `x-officetakt-scheduler`, geprüft
 * per `einrichtung01_scheduler_secret_valid`) und (b) ein direkter Aufruf mit dem Dienstrollen-Schlüssel (Betrieb und
 * lokale Prüfung). Kein Benutzerkonto erreicht diese Wege.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
}

export async function isSchedulerOrServiceCall(
  request: Request,
  serviceRoleKey: string,
  secretName: string,
  secretValid: (name: string, secret: string) => Promise<boolean>,
): Promise<boolean> {
  const authorization = request.headers.get('Authorization') ?? '';
  const bearer = authorization.toLowerCase().startsWith('bearer ') ? authorization.slice(7).trim() : '';
  if (bearer && constantTimeEqual(bearer, serviceRoleKey)) return true;
  const secret = request.headers.get('x-officetakt-scheduler') ?? '';
  if (secret.length < 32 || secret.length > 256) return false;
  return secretValid(secretName, secret);
}
