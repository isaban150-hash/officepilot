/**
 * P1 MITARBEITERZAHLUNGEN — die Referenz einer Mitarbeiterzahlung.
 *
 * `MZ-YYYYMMDD-XXXXXXXX`: Datum der Auszahlung plus acht Zeichen, die
 * deterministisch aus Workspace-Kennung und Zahlungskennung abgeleitet werden
 * (SHA-256, Crockford-Base32 ohne verwechselbare Zeichen).
 *
 * Bewusst **kein** fortlaufender Nummernkreis und keine Rechnungsnummer: Die
 * Referenz entsteht ohne Server und ohne Netz, ist auf jedem Gerät dieselbe und
 * bleibt nach der Bestätigung unverändert. Eindeutig innerhalb des Workspace
 * macht sie zusätzlich der Server (eindeutiger Index).
 */
import { sha256Bytes } from '../sha256Digest';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export const EMPLOYEE_PAYMENT_REFERENCE_PATTERN = /^MZ-\d{8}-[0-9A-HJKMNP-TV-Z]{8}$/;

function base32(bytes: Uint8Array, length: number): string {
  let result = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5 && result.length < length) {
      result += CROCKFORD[(buffer >>> (bits - 5)) & 31];
      bits -= 5;
    }
    if (result.length >= length) break;
    buffer &= (1 << bits) - 1;
  }
  return result;
}

/** `YYYY-MM-DD` → `YYYYMMDD`; ungültig → `null`. */
function compactDate(isoDay: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDay.trim());
  if (!match) return null;
  return `${match[1]}${match[2]}${match[3]}`;
}

export function buildEmployeePaymentReference(
  workspaceId: string,
  paymentId: string,
  paymentDate: string,
): string {
  const workspace = workspaceId.trim();
  const payment = paymentId.trim();
  const datum = compactDate(paymentDate);
  if (!workspace || !payment || !datum) {
    throw new Error('Referenz braucht Workspace, Zahlungskennung und ein gültiges Datum.');
  }
  const digest = sha256Bytes(new TextEncoder().encode(`${workspace}:${payment}`));
  return `MZ-${datum}-${base32(digest, 8)}`;
}

export function isEmployeePaymentReference(value: string | undefined | null): boolean {
  return typeof value === 'string' && EMPLOYEE_PAYMENT_REFERENCE_PATTERN.test(value);
}
