import { existsSync, readFileSync } from 'node:fs';
import { expect, type Page } from '@playwright/test';

/**
 * OFFICEPILOT-E2E-CLOUD-WRITE-GATE-01B — das technische Schreib-Gate.
 *
 * Cloud-Daten dieser Anwendung sind praktisch dauerhaft: In keiner Migration
 * existiert eine DELETE-Policy oder ein DELETE-Statement. Ein schreibender
 * Cloud-Test im falschen Workspace liesse sich deshalb nicht zurücknehmen.
 * Dieses Gate ist die einzige Stelle, an der ein solcher Test scheitern darf,
 * bevor Schaden entsteht — es ist **fail-closed**: Jeder Zweifel bricht ab.
 *
 * ⚠️ Datenschutz ist hier Bauvorschrift, nicht Beiwerk:
 *
 * Die rohe Workspace-Kennung verlässt den Browserkontext **nie**. Sie wird dort
 * aus dem Schlüsselnamen gelesen, dort mit Web Crypto zu SHA-256 verdichtet,
 * und nur der Fingerprint erreicht den Testprozess. Weder Datei noch Terminal
 * noch Fehlermeldung tragen jemals eine echte Kennung, ein Token oder einen
 * Geschäftswert.
 *
 * Gelesen wird ausschliesslich, **welche** Schlüssel existieren — niemals deren
 * Werte. Der Geschäftsbestand liegt im selben `localStorage`; ihn anzufassen
 * wäre ein Datenexport.
 */

/**
 * Die lokale Autorisierung. Liegt unter `playwright/.auth/`, das bereits
 * gitignored ist — sie darf niemals im Repository landen.
 */
export const CLOUD_WRITE_AUTHORIZATION_FILE = 'playwright/.auth/e2e-write-authorization.json';

/** Nur diese Fassung wird akzeptiert. Kein Migrationspfad, keine Toleranz. */
export const CLOUD_WRITE_AUTHORIZATION_SCHEMA_VERSION = 1;

const BUSINESS_PREFIX = 'officepilot-state';

/** `sha256:` plus genau 64 Hexziffern in Kleinschreibung. */
const FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/;

/**
 * Alles, was ausser Schema und Fingerprint in der Datei stehen darf. Bewusst
 * eine Positivliste: Ein unbekannter Schlüssel könnte eine Kennung, eine
 * Adresse oder ein Token sein, und ein neuer Schlüsselname wäre nicht
 * vorhersehbar.
 */
const ALLOWED_AUTHORIZATION_KEYS = new Set(['schemaVersion', 'workspaceFingerprint', 'createdAt']);

/** Strukturbefund des Browserzustands. Enthält niemals einen Wert. */
export interface CloudScopeSnapshot {
  workspaceKeys: number;
  userKeys: number;
  guestKeys: number;
  authKeys: number;
  /** `null`, wenn kein eindeutiger Workspace-Schlüssel vorlag. */
  workspaceFingerprint: string | null;
  /** `false`, wenn Web Crypto im Browserkontext nicht verfügbar war. */
  cryptoAvailable: boolean;
}

export interface CloudWriteAuthorization {
  schemaVersion: number;
  workspaceFingerprint: string;
}

export type CloudWriteGateVerdict = { allowed: true } | { allowed: false; reason: string };

/** Alle Ablehnungsgründe — generisch formuliert, ohne Kennungen oder Tokens. */
export const GATE_MESSAGES = {
  scope: 'Cloud-Schreibtest blockiert: Es liegt kein eindeutiger Workspace-Scope vor.',
  crypto:
    'Cloud-Schreibtest blockiert: Web Crypto steht im Browserkontext nicht zur Verfügung; ein Workspace-Fingerprint kann nicht sicher gebildet werden.',
  missingAuthorization:
    'Cloud-Schreibtest blockiert: Es liegt keine lokale Autorisierung für einen OfficePilot-E2E-Schreibworkspace vor. Eine Autorisierung ist bewusst manuell zu erteilen.',
  malformedAuthorization:
    'Cloud-Schreibtest blockiert: Die lokale Autorisierungsdatei ist strukturell ungültig.',
  schemaVersion:
    'Cloud-Schreibtest blockiert: Die lokale Autorisierungsdatei hat eine nicht unterstützte Schemafassung.',
  fingerprintFormat:
    'Cloud-Schreibtest blockiert: Der hinterlegte Workspace-Fingerprint hat kein gültiges Format.',
  mismatch:
    'Cloud-Schreibtest blockiert: Der aktuelle Workspace ist nicht als OfficePilot-E2E-Schreibworkspace autorisiert.',
  loginPage:
    'Cloud-Schreibtest blockiert: Es besteht keine gültige Sitzung; die Anmeldemaske ist aktiv.',
  bootstrap:
    'Cloud-Schreibtest blockiert: Die Anwendung konnte nicht in einen prüfbaren Zustand gebracht werden (Anmeldung, Seitenaufbau oder Zustandserhebung fehlgeschlagen).',
} as const;

/**
 * Liest die Autorisierungsdatei — **ohne** ihren Inhalt auszugeben.
 *
 * Gibt `null` zurück, wenn die Datei fehlt oder kein Objekt enthält. Ein
 * Parse-Fehler wird bewusst verschluckt statt weitergereicht: Die
 * Ausnahmemeldung von `JSON.parse` zitiert den fehlerhaften Dateiausschnitt.
 */
export function readCloudWriteAuthorization(
  path: string = CLOUD_WRITE_AUTHORIZATION_FILE,
): unknown | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as unknown;
  } catch {
    return null;
  }
}

/** Erkennt einen strukturell gültigen Fingerprint. */
export function isValidWorkspaceFingerprint(value: unknown): value is string {
  return typeof value === 'string' && FINGERPRINT_PATTERN.test(value);
}

/**
 * Prüft die Autorisierungsdatei strukturell. Erlaubt sind ausschliesslich die
 * Schlüssel aus `ALLOWED_AUTHORIZATION_KEYS`; alles andere gilt als ungültig,
 * damit die Datei nicht unbemerkt zum Ablageort für Kennungen wird.
 */
export function validateAuthorizationShape(
  raw: unknown,
): { ok: true; value: CloudWriteAuthorization } | { ok: false; reason: string } {
  if (raw === null) return { ok: false, reason: GATE_MESSAGES.missingAuthorization };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: GATE_MESSAGES.malformedAuthorization };
  }

  const record = raw as Record<string, unknown>;

  for (const key of Object.keys(record)) {
    if (!ALLOWED_AUTHORIZATION_KEYS.has(key)) {
      /* Bewusst ohne den Schlüsselnamen: Er könnte selbst sprechend sein. */
      return { ok: false, reason: GATE_MESSAGES.malformedAuthorization };
    }
  }

  if (record.schemaVersion !== CLOUD_WRITE_AUTHORIZATION_SCHEMA_VERSION) {
    return { ok: false, reason: GATE_MESSAGES.schemaVersion };
  }

  if (!isValidWorkspaceFingerprint(record.workspaceFingerprint)) {
    return { ok: false, reason: GATE_MESSAGES.fingerprintFormat };
  }

  return {
    ok: true,
    value: {
      schemaVersion: CLOUD_WRITE_AUTHORIZATION_SCHEMA_VERSION,
      workspaceFingerprint: record.workspaceFingerprint,
    },
  };
}

/**
 * Die reine Entscheidungslogik — ohne Browser, ohne Dateisystem.
 *
 * Getrennt gehalten, damit der Fail-closed-Fall mit erfundenen Werten geprüft
 * werden kann. Ein Negativtest, der die echte Autorisierung anfassen müsste,
 * wäre selbst ein Risiko.
 */
export function evaluateCloudWriteGate(input: {
  scope: CloudScopeSnapshot;
  authorization: unknown | null;
}): CloudWriteGateVerdict {
  const { scope } = input;

  /*
   * Zuerst der Scope. Ein Fingerprint aus mehrdeutigem Zustand wäre bereits
   * bedeutungslos — er dürfte gar nicht erst gegen die Autorisierung gehalten
   * werden.
   */
  if (
    scope.workspaceKeys !== 1 ||
    scope.userKeys !== 0 ||
    scope.guestKeys !== 0 ||
    scope.authKeys !== 1
  ) {
    return { allowed: false, reason: GATE_MESSAGES.scope };
  }

  if (!scope.cryptoAvailable) return { allowed: false, reason: GATE_MESSAGES.crypto };

  if (!isValidWorkspaceFingerprint(scope.workspaceFingerprint)) {
    return { allowed: false, reason: GATE_MESSAGES.fingerprintFormat };
  }

  const authorization = validateAuthorizationShape(input.authorization);
  if (!authorization.ok) return { allowed: false, reason: authorization.reason };

  if (authorization.value.workspaceFingerprint !== scope.workspaceFingerprint) {
    return { allowed: false, reason: GATE_MESSAGES.mismatch };
  }

  return { allowed: true };
}

/**
 * Erhebt den Strukturbefund **im Browser** und bildet dort den Fingerprint.
 *
 * Alles Sensible bleibt in der Seite: Der Schlüsselname wird dort zerlegt, die
 * Kennung dort gehasht. Zurück kommen nur Zahlen und ein Hash. Werte werden
 * nirgends gelesen — `localStorage.key(i)` liefert Namen, nicht Inhalte.
 */
export async function readCloudScopeSnapshot(page: Page): Promise<CloudScopeSnapshot> {
  return page.evaluate(async (prefix) => {
    const names: string[] = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const name = window.localStorage.key(index);
      if (name !== null) names.push(name);
    }

    const workspacePrefix = `${prefix}:workspace:`;
    const userPrefix = `${prefix}:user:`;
    const guestKey = `${prefix}:guest`;

    const workspaceNames = names.filter((name) => name.startsWith(workspacePrefix));
    const userNames = names.filter((name) => name.startsWith(userPrefix));
    const guestNames = names.filter((name) => name === guestKey);
    const authNames = names.filter((name) => name.startsWith('sb-') && name.endsWith('-auth-token'));

    const cryptoAvailable =
      typeof crypto !== 'undefined' && typeof crypto.subtle?.digest === 'function';

    let workspaceFingerprint: string | null = null;

    /*
     * Nur bei Eindeutigkeit. Bei mehreren Schlüsseln wäre jede Auswahl
     * willkürlich — und der Test bricht ohnehin am Scope-Gate ab.
     */
    if (workspaceNames.length === 1 && cryptoAvailable) {
      const identifier = workspaceNames[0].slice(workspacePrefix.length);
      const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(identifier),
      );
      const hex = Array.from(new Uint8Array(digest))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
      workspaceFingerprint = `sha256:${hex}`;
    }

    return {
      workspaceKeys: workspaceNames.length,
      userKeys: userNames.length,
      guestKeys: guestNames.length,
      authKeys: authNames.length,
      workspaceFingerprint,
      cryptoAvailable,
    };
  }, BUSINESS_PREFIX);
}

/** Stellt sicher, dass eine getragene Sitzung und die App-Hülle vorliegen. */
async function assertSignedInShell(page: Page): Promise<void> {
  if (await page.getByTestId('login-page').isVisible().catch(() => false)) {
    throw new Error(GATE_MESSAGES.loginPage);
  }
  await expect(page.getByTestId('app-shell'), GATE_MESSAGES.loginPage).toBeVisible();
}

/**
 * WRITE-GATE-01B2 — Geschäfts-DOM abräumen, bevor ein Fehler entsteht.
 *
 * Playwright hängt an jeden fehlgeschlagenen Test einen `error-context.md` mit
 * einem Accessibility-Abbild der Seite — **unabhängig** davon, dass `trace`,
 * `screenshot` und `video` in dieser Konfiguration aus sind. Scheitert das Gate
 * also auf der geladenen Anwendung, landete der sichtbare Geschäftsbestand im
 * Testausgabeverzeichnis.
 *
 * Deshalb wird die Seite vor dem Werfen auf `about:blank` gesetzt. Danach gibt
 * es kein OfficePilot-DOM mehr, das abgebildet werden könnte.
 *
 * Scheitert selbst das Abräumen, wird es geschluckt: Das darf den eigentlichen
 * Gate-Fehler nicht ersetzen — rot bleibt rot.
 */
async function sanitizePage(page: Page): Promise<void> {
  try {
    await page.goto('about:blank', { waitUntil: 'load' });
  } catch {
    /* Bewusst still. Der Gate-Fehler ist die wichtigere Nachricht. */
  }
}

/**
 * Setzt einen Fail-closed-Spruch durch: erst abräumen, dann werfen.
 *
 * Eigene Funktion, damit der Fehlerpfad mit erfundenen Werten geprüft werden
 * kann, ohne die echte Autorisierung anzufassen.
 */
export async function enforceCloudWriteVerdict(
  page: Page,
  verdict: CloudWriteGateVerdict,
): Promise<void> {
  /* Erfolg räumt **nicht** ab — der Write-Test braucht die Seite gleich weiter. */
  if (verdict.allowed) return;

  await sanitizePage(page);
  throw new Error(verdict.reason);
}

/**
 * Das Gate. **Vor** jedem fachlichen Cloud-Write aufzurufen.
 *
 * Kehrt ausschliesslich zurück, wenn die laufende Sitzung nachweislich im
 * einmalig und bewusst autorisierten E2E-Schreibworkspace steht. In jedem
 * anderen Fall wird geworfen — es gibt keinen Rückfall, keine Nachsicht und
 * **keine automatische Neu-Autorisierung**. Eine neue Autorisierung ist immer
 * ein eigenes, bewusstes Kommando.
 */
export async function assertCloudWriteAllowed(page: Page): Promise<void> {
  let scope: CloudScopeSnapshot;

  /*
   * Auch der Weg **vor** der Messung kann scheitern — Anmeldemaske, halb
   * aufgebaute Seite, fehlgeschlagene Erhebung. Zu diesem Zeitpunkt kann
   * bereits Geschäfts-DOM sichtbar sein, deshalb wird auch hier abgeräumt.
   *
   * Der ursprüngliche Fehler wird dabei durch eine generische Meldung ersetzt:
   * Eine Playwright-Zusicherung führt im Text ihren Aufrufverlauf mit, und der
   * kann die echte Adresse enthalten. Verschluckt wird nichts — der Test bleibt
   * rot, nur die Ursache steht knapper da.
   */
  try {
    await assertSignedInShell(page);
    scope = await readCloudScopeSnapshot(page);
  } catch (error) {
    await sanitizePage(page);
    const isLogin = error instanceof Error && error.message === GATE_MESSAGES.loginPage;
    throw new Error(isLogin ? GATE_MESSAGES.loginPage : GATE_MESSAGES.bootstrap);
  }

  const authorization = readCloudWriteAuthorization();
  await enforceCloudWriteVerdict(page, evaluateCloudWriteGate({ scope, authorization }));
}
