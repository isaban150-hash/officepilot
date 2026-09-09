import type { BrowserContext } from '@playwright/test';

/**
 * OFFICEPILOT-LOCAL-E2E-SYNTHETIC-AUTH-PROBE-01B — eine erfundene Cloud.
 *
 * OfficePilot kommt ohne Supabase-Sitzung nicht hinter die Anmeldemaske: `App`
 * zeigt ohne `session && user && !profileError` ausschliesslich öffentliche
 * Routen. Für lokale, wegwerfbare Fachtests brauchen wir deshalb einen Weg
 * hinter diese Grenze, der **weder** ein echtes Konto **noch** eine Änderung am
 * Produktivcode verlangt.
 *
 * Gefälscht wird ausschliesslich Infrastruktur: die Sitzung, das Profil und
 * die drei Workspace-Antworten. Keine Fachlogik, keine zweite Rechnungs- oder
 * Dokumentenkette, keine Sonderpfade in `src/`.
 *
 * ⚠️ Alles hier ist synthetisch und darf im Klartext stehen: erfundene UUIDs,
 * `example.invalid`-Adressen, ein Dummy-Token ohne Geheimnis. Aus dem
 * bestehenden Cloud-Testkonto stammt kein einziger Wert.
 *
 * Der Host liegt unter `.invalid` — eine per RFC 2606 dauerhaft nicht
 * auflösbare Top-Level-Domain. Selbst ein Loch in der Abfangregel könnte
 * nirgendwo ankommen. Die Abfangregel selbst ist trotzdem fail-closed.
 */

/** Nicht auflösbar per RFC 2606. Der Projektbezeichner ist die erste Marke. */
export const SYNTHETIC_SUPABASE_HOST = 'officepilot-e2e.invalid';
export const SYNTHETIC_SUPABASE_URL = `https://${SYNTHETIC_SUPABASE_HOST}`;

/** supabase-js leitet seinen Speicherschlüssel aus der ersten Marke ab. */
export const SYNTHETIC_PROJECT_REF = 'officepilot-e2e';
export const SYNTHETIC_AUTH_STORAGE_KEY = `sb-${SYNTHETIC_PROJECT_REF}-auth-token`;

/** Kein Geheimnis: ein formal passender, frei erfundener Platzhalter. */
export const SYNTHETIC_ANON_KEY =
  'e2e-synthetic-anon-key-not-a-secret-0000000000000000000000000000';

const SYNTHETIC_USER_ID = '00000000-0000-4000-8000-000000000001';
const SYNTHETIC_WORKSPACE_ID = '00000000-0000-4000-8000-000000000002';
const SYNTHETIC_EMAIL = 'probe@example.invalid';

/** Weit in der Zukunft, damit supabase-js keinen Refresh anstösst. */
const FAR_FUTURE_EPOCH_SECONDS = 4102444800; // 2100-01-01T00:00:00Z
const FIXED_ISO = '2026-01-01T00:00:00.000Z';

function base64Url(value: object): string {
  return Buffer.from(JSON.stringify(value), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Ein strukturell gültiges, aber **ungültig signiertes** JWT.
 *
 * supabase-js liest die Ablaufzeit teils aus dem Token statt aus der
 * gespeicherten Hülle. Ein blosser Platzhaltertext liesse den Client sofort
 * einen Refresh versuchen. Die Signatur ist bewusst Unsinn — geprüft wird sie
 * nur serverseitig, und einen Server gibt es hier nicht.
 */
function syntheticAccessToken(): string {
  const header = base64Url({ alg: 'HS256', typ: 'JWT' });
  const payload = base64Url({
    sub: SYNTHETIC_USER_ID,
    aud: 'authenticated',
    role: 'authenticated',
    email: SYNTHETIC_EMAIL,
    iss: `${SYNTHETIC_SUPABASE_URL}/auth/v1`,
    iat: 1767225600,
    exp: FAR_FUTURE_EPOCH_SECONDS,
  });
  return `${header}.${payload}.e2e-synthetic-signature`;
}

function syntheticUser() {
  return {
    id: SYNTHETIC_USER_ID,
    aud: 'authenticated',
    role: 'authenticated',
    email: SYNTHETIC_EMAIL,
    email_confirmed_at: FIXED_ISO,
    phone: '',
    confirmed_at: FIXED_ISO,
    last_sign_in_at: FIXED_ISO,
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: {},
    identities: [],
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    is_anonymous: false,
  };
}

function syntheticSession() {
  return {
    access_token: syntheticAccessToken(),
    token_type: 'bearer',
    expires_in: FAR_FUTURE_EPOCH_SECONDS - Math.floor(Date.now() / 1000),
    expires_at: FAR_FUTURE_EPOCH_SECONDS,
    refresh_token: 'e2e-synthetic-refresh-token',
    user: syntheticUser(),
  };
}

/**
 * Ein freigeschaltetes Profil.
 *
 * Die Felder sind nicht geraten: `ProfileRow` in `src/types/profile.ts` gibt
 * sie vor, und `isUserAllowedToUseApp` verlangt `status: 'approved'` plus eine
 * aktive Lizenz ohne abgelaufenes Ablaufdatum.
 */
function syntheticProfileRow() {
  return {
    id: SYNTHETIC_USER_ID,
    company_name: 'E2E Probe GmbH',
    first_name: 'E2E',
    last_name: 'Probe',
    email: SYNTHETIC_EMAIL,
    phone: null,
    industry: null,
    status: 'approved',
    role: 'user',
    license_status: 'active',
    license_expires_at: null,
    accepted_terms_version: '1.0',
    accepted_privacy_version: '1.0',
    accepted_license_version: '1.0',
    legal_accepted_at: FIXED_ISO,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
  };
}

function syntheticWorkspaceRow() {
  return {
    id: SYNTHETIC_WORKSPACE_ID,
    name: 'E2E Probe Workspace',
    owner_user_id: SYNTHETIC_USER_ID,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    version: 1,
  };
}

function syntheticMemberRow() {
  return {
    workspace_id: SYNTHETIC_WORKSPACE_ID,
    user_id: SYNTHETIC_USER_ID,
    role: 'owner',
    status: 'active',
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
  };
}

/**
 * Der Firmenstamm kommt als **Cloud-Antwort**, nicht als vorgeschriebener
 * lokaler Zustand.
 *
 * Das ist der ehrlichere Weg: Genau so erhält die Anwendung ihren Firmenstamm
 * auch im Betrieb. `VITE_BETA_TEST_MODE` schiede hier ohnehin aus — es setzt
 * `syncPolicy: 'disabled'`, und der Workspace-Bootstrap steigt dann aus,
 * bevor er den Scope umschaltet. Die Probe soll aber gerade den
 * Workspace-Scope belegen.
 *
 * Fachbestand bleibt leer: keine Kunden, keine Vorgänge, keine Rechnungen.
 */
function syntheticSetupPayload() {
  return {
    companyName: 'E2E Probe GmbH',
    industry: 'Handwerk – Sanitär/Heizung',
    taxStatus: 'standard_19',
    materialStandard: 'betrieb',
    language: 'de',
    setupComplete: true,
    setupVersion: 1,
    communicationChannel: 'email',
  };
}

function syntheticCompanyProfilePayload() {
  return {
    companyName: 'E2E Probe GmbH',
    legalForm: 'GmbH',
    contactPerson: 'E2E Probe',
    street: 'Teststrasse 1',
    zip: '10115',
    city: 'Berlin',
    country: 'Deutschland',
    phone: '030 0000000',
    email: SYNTHETIC_EMAIL,
    taxNumber: '00/000/00000',
    vatId: 'DE000000000',
    bankName: 'Testbank',
    iban: 'DE89370400440532013000',
    bic: 'COBADEFFXXX',
    defaultPaymentDays: 14,
    defaultPaymentTerms: 'Zahlbar innerhalb von 14 Tagen ohne Abzug.',
    defaultSkonto: '',
  };
}

/**
 * 01B2 — Pfade, die dieser Helfer **niemals** erfolgreich beantwortet.
 *
 * `upsert_workspace_sync_entity` ist der generische Sync-Push. Er wird für den
 * Auth- und Workspace-Bootstrap nicht gebraucht — der grüne Probe belegt das —,
 * und ein Fachflow, der ihn auslöst, soll daran scheitern statt eine erfundene
 * Bestätigung zu bekommen.
 */
const FORBIDDEN_WRITE_PATHS: ReadonlySet<string> = new Set([
  '/rest/v1/rpc/upsert_workspace_sync_entity',
]);

/** Was tatsächlich beantwortet bzw. abgewiesen wurde — nur Pfade, nie Werte. */
export interface SyntheticSupabaseTracker {
  /** Pfade des synthetischen Hosts, die beantwortet wurden. */
  answered: string[];
  /** Supabase-Pfade ohne Antwortregel — jeder einzelne macht die Probe rot. */
  unexpected: string[];
  /** Schreibversuche auf gesperrte Pfade — abgewiesen, nie bestätigt. */
  forbiddenWrites: string[];
  /** Fremde Hosts, die abgewiesen wurden (nur Hostname). */
  blockedHosts: string[];
}

function jsonResponse(body: unknown) {
  return {
    status: 200,
    contentType: 'application/json',
    headers: { 'access-control-allow-origin': '*' },
    body: JSON.stringify(body),
  };
}

/**
 * Legt die synthetische Sitzung vor dem ersten Skript der Seite ab.
 *
 * `addInitScript` läuft vor allem Anwendungscode — supabase-js findet die
 * Sitzung beim Start bereits vor und muss sie nicht erst holen.
 */
export async function seedSyntheticSession(context: BrowserContext): Promise<void> {
  await context.addInitScript(
    ([key, session]) => {
      try {
        window.localStorage.setItem(key as string, session as string);
      } catch {
        /* Ohne Speicher scheitert die Probe gleich sichtbar an der Anmeldemaske. */
      }
    },
    [SYNTHETIC_AUTH_STORAGE_KEY, JSON.stringify(syntheticSession())] as const,
  );
}

/**
 * Fängt allen Verkehr ab: Die eigene Anwendung darf durch, der synthetische
 * Host bekommt erfundene Antworten, **alles andere wird abgewiesen**.
 *
 * Fail-closed ist hier keine Zierde. Ein Supabase-Pfad ohne Regel wird nicht
 * durchgelassen und nicht wohlwollend leer beantwortet — er wird vermerkt und
 * macht die Probe rot. Sonst könnte ein unbemerkter Aufruf später gegen eine
 * echte Instanz laufen, sobald jemand die Adresse austauscht.
 */
export async function installSyntheticSupabase(
  context: BrowserContext,
): Promise<SyntheticSupabaseTracker> {
  const tracker: SyntheticSupabaseTracker = {
    answered: [],
    unexpected: [],
    forbiddenWrites: [],
    blockedHosts: [],
  };

  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());

    /* Die getestete Anwendung selbst — Vite, Module, Assets. */
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
      await route.continue();
      return;
    }

    if (url.hostname !== SYNTHETIC_SUPABASE_HOST) {
      /* Nur der Hostname, nie der vollständige Pfad eines fremden Ziels. */
      if (!tracker.blockedHosts.includes(url.hostname)) {
        tracker.blockedHosts.push(url.hostname);
      }
      await route.abort('blockedbyclient');
      return;
    }

    const path = url.pathname;

    /* Vorabfragen des Browsers: erlauben, aber nicht als Antwort zählen. */
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({
        status: 204,
        headers: {
          'access-control-allow-origin': '*',
          'access-control-allow-headers': '*',
          'access-control-allow-methods': '*',
        },
        body: '',
      });
      return;
    }

    const answer = (body: unknown) => {
      tracker.answered.push(path);
      return route.fulfill(jsonResponse(body));
    };

    if (path === '/auth/v1/token') {
      /* Falls der Client doch erneuern will: dieselbe Sitzung zurück. */
      return answer(syntheticSession());
    }

    if (path === '/auth/v1/user') {
      return answer(syntheticUser());
    }

    if (path === '/rest/v1/profiles') {
      /*
       * `maybeSingle()` fordert ein einzelnes Objekt an; PostgREST antwortet
       * dann nicht mit einer Liste. Genau das wird hier nachgebildet.
       */
      return answer(syntheticProfileRow());
    }

    if (path === '/rest/v1/rpc/ensure_personal_workspace') {
      return answer({
        workspace: syntheticWorkspaceRow(),
        member: syntheticMemberRow(),
        /*
         * Bewusst `false`: Ein „neuer" Workspace führt die Anwendung in den
         * Einrichtungsassistenten. Die Probe soll den fertig eingerichteten
         * Betrieb erreichen.
         */
        created: false,
      });
    }

    if (path === '/rest/v1/rpc/pull_workspace_sync_state') {
      return answer({
        workspace: syntheticWorkspaceRow(),
        members: [syntheticMemberRow()],
        settings: null,
        setup: {
          workspace_id: SYNTHETIC_WORKSPACE_ID,
          payload: syntheticSetupPayload(),
          setup_version: 1,
          row_version: 1,
          updated_at: FIXED_ISO,
          updated_by: SYNTHETIC_USER_ID,
        },
        company_profile: {
          workspace_id: SYNTHETIC_WORKSPACE_ID,
          payload: syntheticCompanyProfilePayload(),
          row_version: 1,
          updated_at: FIXED_ISO,
          updated_by: SYNTHETIC_USER_ID,
        },
        /* Leerer Fachbestand — die Probe soll auf nichts stossen. */
        vorgaenge: [],
        customers: [],
      });
    }

    if (
      path === '/rest/v1/rpc/pull_workspace_order_amendments' ||
      path === '/rest/v1/rpc/pull_workspace_invoices' ||
      path === '/rest/v1/rpc/pull_workspace_documents' ||
      path === '/rest/v1/rpc/pull_workspace_invoice_payments'
    ) {
      /*
       * Die vier Lese-Pulls, die die Vorgangsansicht beim Aufbau anstösst.
       * Alle vier erwarten ausdrücklich ein Array und behandeln alles andere
       * als Fehler — eine leere Liste ist deshalb die einzig richtige und
       * zugleich kleinstmögliche Antwort. Sie passt auch zur Sache: Der
       * Fachbestand dieser Probe ist leer.
       */
      return answer([]);
    }

    if (FORBIDDEN_WRITE_PATHS.has(path)) {
      /*
       * 01B2 — hier stand einmal eine erfolgreiche Antwort.
       *
       * Sie war der gefährlichste Teil dieses Helfers: Ein künftiger Fachflow
       * hätte einen Sync-Push ausgelöst und vom Harness eine erfundene
       * Bestätigung erhalten — der Test wäre grün geblieben, obwohl die
       * Anwendung in die Cloud zu schreiben versuchte. Ein gefälschtes „ist
       * gespeichert" ist schlimmer als gar keine Antwort.
       *
       * Jetzt wird nichts bestätigt und nichts durchgelassen: Der Versuch wird
       * vermerkt und macht den Test rot. Vermerkt wird ausschliesslich der
       * Pfadname — niemals die gesendete Nutzlast.
       */
      if (!tracker.forbiddenWrites.includes(path)) {
        tracker.forbiddenWrites.push(path);
      }
      await route.abort('blockedbyclient');
      return;
    }

    /* Kein Fallback. Was hier ankommt, war nicht vorgesehen. */
    tracker.unexpected.push(path);
    await route.abort('blockedbyclient');
  });

  return tracker;
}
