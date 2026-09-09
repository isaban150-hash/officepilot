import type { BrowserContext } from '@playwright/test';
import type { WorkspaceCompanyIdentity } from './localTestWorldCompany';

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
function syntheticSetupPayload(operator?: WorkspaceCompanyIdentity) {
  return {
    /*
     * Legacy-Spiegel, nicht die Identität: Massgeblich ist
     * `CompanyProfile.companyName`. Er wird trotzdem mitgezogen, damit nicht
     * zwei Felder auf zwei verschiedene Firmen zeigen — `isDefaultSetup` und
     * die Altbestandsrettung lesen diesen Spiegel.
     */
    companyName: operator?.companyName ?? 'E2E Probe GmbH',
    /*
     * Alle fachlichen Einstellungen bleiben unberührt. Insbesondere
     * `taxStatus`: Der §13b-Pfad ist eine bewusste Festlegung und wird
     * niemals aus der Testwelt-Firmendatei abgeleitet.
     */
    industry: 'Handwerk – Sanitär/Heizung',
    taxStatus: 'standard_19',
    materialStandard: 'betrieb',
    language: 'de',
    setupComplete: true,
    setupVersion: 1,
    communicationChannel: 'email',
  };
}

/**
 * Der Firmenstamm des Workspace.
 *
 * Ohne `operator` bleibt es bei der neutralen, frei erfundenen Firma — so
 * laufen Auth-Probe und Cloud-Guard weiter ohne jede fachliche Identität.
 *
 * Mit `operator` übernimmt der Workspace die Betreiberfirma der Testwelt. Das
 * ist **Stammdatenpflege**, kein Analyseergebnis: Ersetzt werden nur die
 * Felder, die die Testwelt kennt; alles Übrige — Rechtsform, Ansprechpartner,
 * Zahlungsbedingungen, Skonto, Fussnoten — bleibt neutral und wird
 * ausdrücklich **nicht** aus dem Dokumentinhalt abgeleitet.
 */
function syntheticCompanyProfilePayload(operator?: WorkspaceCompanyIdentity) {
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
    website: '',
    taxNumber: '00/000/00000',
    vatId: 'DE000000000',
    bankName: 'Testbank',
    iban: 'DE89370400440532013000',
    bic: 'COBADEFFXXX',
    defaultPaymentDays: 14,
    defaultPaymentTerms: 'Zahlbar innerhalb von 14 Tagen ohne Abzug.',
    defaultSkonto: '',
    ...(operator ?? {}),
  };
}

/**
 * OFFICEPILOT-LOCAL-E2E-CLOUD-BLOCK-GUARD-01B — die Klassifikation.
 *
 * ⚠️ Die Sicherheit dieses Guards kommt **nicht** aus der Verbotsliste.
 *
 * Sie kommt aus dem Grundsatz: Was nicht ausdrücklich Auth-Infrastruktur, ein
 * bekannter Lesezugriff oder die eine Bootstrap-Ausnahme ist, wird abgewiesen.
 * Die Verbotsliste macht daraus nur eine bessere Diagnose — „gesperrter
 * Cloud-Write" statt „unbekannter Aufruf". Wäre sie die einzige Verteidigung,
 * genügte ein RPC, den heute noch niemand kennt, um sie zu umgehen.
 */
export type GuardRequestClass =
  | 'app_origin'
  | 'auth'
  | 'allowed_read'
  | 'bootstrap_exception'
  | 'forbidden_write'
  | 'unexpected'
  | 'blocked_external';

/**
 * Reine Lesezugriffe. Exakte Pfade, keine Muster — `get_workspace_invoice_sent`
 * liest, `update_workspace_invoice_sent` schreibt, und ein Präfix könnte beide
 * nicht auseinanderhalten.
 *
 * `admin_list_profiles` fehlt bewusst, obwohl es liest: Ein lokaler Fachtest
 * hat in der Nutzerverwaltung nichts zu suchen und soll dort auflaufen.
 */
const ALLOWED_READ_PATHS: ReadonlySet<string> = new Set([
  '/rest/v1/rpc/pull_workspace_sync_state',
  '/rest/v1/rpc/pull_workspace_invoices',
  '/rest/v1/rpc/pull_workspace_documents',
  '/rest/v1/rpc/pull_workspace_invoice_payments',
  '/rest/v1/rpc/pull_workspace_order_amendments',
  '/rest/v1/rpc/get_workspace_invoice_sent',
  '/rest/v1/rpc/get_workspace_invoice_service_period_confirmation',
]);

/** Die vier Pulls antworten mit einer Liste, die übrigen mit einem Objekt. */
const EMPTY_LIST_READ_PATHS: ReadonlySet<string> = new Set([
  '/rest/v1/rpc/pull_workspace_invoices',
  '/rest/v1/rpc/pull_workspace_documents',
  '/rest/v1/rpc/pull_workspace_invoice_payments',
  '/rest/v1/rpc/pull_workspace_order_amendments',
]);

/** Sitzungsinfrastruktur — ausdrücklich **keine** Freigabe für Business-Writes. */
const AUTH_PATHS: ReadonlySet<string> = new Set([
  '/auth/v1/token',
  '/auth/v1/user',
  '/auth/v1/logout',
]);

/**
 * Die einzige schreibfähige Ausnahme — und sie heisst absichtlich nicht „Read".
 *
 * `ensure_personal_workspace` legt serverseitig einen Workspace samt
 * Mitgliedschaft an. Ohne sie bricht `bootstrapWorkspaceCloudSyncIfNeeded` ab,
 * `switchToWorkspaceScope` läuft nie, und der lokale Zustand bliebe
 * guest-gebunden — der Nachweis „workspace == 1, guest == 0" wäre unmöglich.
 *
 * Gebunden ist sie an vier Achsen zugleich: Pfad, Methode POST, den
 * `.invalid`-Host und **genau einen** Aufruf pro BrowserContext.
 */
const BOOTSTRAP_EXCEPTION_PATH = '/rest/v1/rpc/ensure_personal_workspace';

/**
 * Bekannte Schreibwege. Vollständig aus dem Inventar der 01A-Analyse, allein
 * für die Fehlermeldung — abgewiesen würden sie ohnehin.
 */
const FORBIDDEN_WRITE_PATHS: ReadonlySet<string> = new Set([
  '/rest/v1/rpc/upsert_workspace_sync_entity',
  '/rest/v1/rpc/finalize_workspace_invoice',
  '/rest/v1/rpc/confirm_workspace_invoice_service_period',
  '/rest/v1/rpc/update_workspace_invoice_sent',
  '/rest/v1/rpc/add_workspace_invoice_payment',
  '/rest/v1/rpc/reverse_workspace_invoice_payment',
  '/rest/v1/rpc/upsert_workspace_generated_invoice_document',
  '/rest/v1/rpc/tombstone_workspace_document',
  '/rest/v1/rpc/confirm_workspace_order_amendment',
  '/rest/v1/rpc/update_own_profile',
  '/rest/v1/rpc/admin_approve_user',
  '/rest/v1/rpc/admin_block_user',
  '/rest/v1/rpc/admin_activate_license',
  '/rest/v1/rpc/admin_deactivate_license',
  '/rest/v1/rpc/admin_expire_license',
  '/rest/v1/rpc/admin_set_license_expiry',
  '/rest/v1/rpc/admin_clear_license_expiry',
]);

const STORAGE_PREFIX = '/storage/v1/';
const STORAGE_READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);

/** Was geschah — ausschliesslich Pfade, Hostnamen und Anzahlen. */
export interface SyntheticSupabaseTracker {
  /** Pfade, die synthetisch beantwortet wurden. */
  answered: string[];
  /** Erkannte Schreibversuche — abgewiesen, nie bestätigt. Macht Tests rot. */
  forbiddenWrites: string[];
  /** Supabase-Pfade ohne Regel — ebenfalls abgewiesen. Macht Tests rot. */
  unexpected: string[];
  /**
   * Abgewiesene fremde Hosts (nur Hostname). Macht ausdrücklich **nicht** rot:
   * Die Anwendung lädt Schriften von Google, und das ist reine Darstellung.
   */
  blockedExternal: string[];
  /** Wie oft die Bootstrap-Ausnahme gewährt wurde. Mehr als 1 gibt es nicht. */
  bootstrapExceptionCount: number;
  /**
   * Quittiert **einen** erwarteten Eintrag — nur für den Guard-Nachweis in
   * `localCloudBlockGuard.spec.ts`.
   *
   * Bewusst kein Schalter, der den Guard abstellt, und kein „alles leeren":
   * Es lässt sich nur ein namentlich genannter, tatsächlich vorhandener
   * Eintrag entfernen, und der Aufruf schlägt fehl, wenn es ihn nicht gibt.
   * Ein Test kann damit nichts verstecken, was er nicht selbst ausgelöst hat.
   */
  acknowledgeExpectedGuardEvent(path: string): void;
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
export interface SyntheticSupabaseOptions {
  /**
   * Wer den Testworkspace betreibt — und **nur** das.
   *
   * Bewusst eng typisiert statt eines beliebigen Zustandsobjekts: Über diesen
   * Weg sollen Betreiber-Stammdaten hereinkommen, niemals Kunden, Vorgänge,
   * Dokumente, Rechnungen oder sonstige Analyseergebnisse. Ohne die Option
   * bleibt der Workspace neutral.
   */
  operatorCompany?: WorkspaceCompanyIdentity;
}

export async function installSyntheticSupabase(
  context: BrowserContext,
  options: SyntheticSupabaseOptions = {},
): Promise<SyntheticSupabaseTracker> {
  const operator = options.operatorCompany;
  const tracker: SyntheticSupabaseTracker = {
    answered: [],
    forbiddenWrites: [],
    unexpected: [],
    blockedExternal: [],
    bootstrapExceptionCount: 0,
    acknowledgeExpectedGuardEvent(path: string) {
      const lists: Array<keyof Pick<SyntheticSupabaseTracker, 'forbiddenWrites' | 'unexpected'>> = [
        'forbiddenWrites',
        'unexpected',
      ];
      for (const list of lists) {
        const index = tracker[list].indexOf(path);
        if (index >= 0) {
          tracker[list].splice(index, 1);
          return;
        }
      }
      throw new Error(
        `Guard-Quittung ins Leere: Für "${path}" liegt kein erfasster Eintrag vor.`,
      );
    },
  };

  /** Genau einmal pro BrowserContext — danach ist die Ausnahme geschlossen. */
  let bootstrapExceptionUsed = false;

  await context.route('**/*', async (route) => {
    const url = new URL(route.request().url());

    /* Die getestete Anwendung selbst — Vite, Module, Assets. */
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
      await route.continue();
      return;
    }

    if (url.hostname !== SYNTHETIC_SUPABASE_HOST) {
      /* Nur der Hostname, nie der vollständige Pfad eines fremden Ziels. */
      if (!tracker.blockedExternal.includes(url.hostname)) {
        tracker.blockedExternal.push(url.hostname);
      }
      await route.abort('blockedbyclient');
      return;
    }

    /* Ohne Query: Suchparameter können Kennungen tragen. */
    const path = url.pathname;
    const method = route.request().method();

    const block = async (list: 'forbiddenWrites' | 'unexpected') => {
      if (!tracker[list].includes(path)) tracker[list].push(path);
      await route.abort('blockedbyclient');
    };

    /* Vorabfragen des Browsers: erlauben, aber nicht als Antwort zählen. */
    if (method === 'OPTIONS') {
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

    /*
     * Storage vor allem anderen: Es ist kein RPC, und über die Methode
     * entscheidet sich alles. Der Bucketname taugt nicht als Kriterium — ein
     * zweiter Bucket wäre sonst unbemerkt frei.
     */
    if (path.startsWith(STORAGE_PREFIX)) {
      if (STORAGE_READ_METHODS.has(method)) {
        /*
         * Auch Lesen bleibt hier gesperrt: Im lokalen Lauf existiert kein
         * Asset, und ein stiller Erfolg wäre eine Erfindung. Wird ein
         * Storage-Read je gebraucht, soll er sichtbar auflaufen.
         */
        return block('unexpected');
      }
      /* Upload, Update, Löschen — darunter der Branding-Upload. */
      return block('forbiddenWrites');
    }

    if (AUTH_PATHS.has(path)) {
      /* Falls der Client erneuern will: dieselbe Sitzung zurück. */
      if (path === '/auth/v1/user') return answer(syntheticUser());
      if (path === '/auth/v1/logout') return answer({});
      return answer(syntheticSession());
    }

    /* Jeder andere Auth-Pfad ist eine Verhaltensänderung, die man sehen will. */
    if (path.startsWith('/auth/v1/')) {
      return block('unexpected');
    }

    if (path === '/rest/v1/profiles' && method === 'GET') {
      /*
       * `maybeSingle()` fordert ein einzelnes Objekt an; PostgREST antwortet
       * dann nicht mit einer Liste. Genau das wird hier nachgebildet.
       */
      return answer(syntheticProfileRow());
    }

    if (path === BOOTSTRAP_EXCEPTION_PATH) {
      /*
       * Vier Bedingungen, alle zwingend: der `.invalid`-Host (oben bereits
       * geprüft), dieser exakte Pfad, die Methode POST — und der erste
       * Aufruf in diesem Kontext.
       *
       * Der Zähler ersetzt bewusst jedes Zeitfenster und jedes Signal aus dem
       * Produktivcode: Der Bootstrap läuft einmal, alles Weitere gehört in den
       * Fachflow und hat dort nichts verloren.
       */
      if (method !== 'POST' || bootstrapExceptionUsed) {
        return block('forbiddenWrites');
      }
      bootstrapExceptionUsed = true;
      tracker.bootstrapExceptionCount += 1;
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
          payload: syntheticSetupPayload(operator),
          setup_version: 1,
          row_version: 1,
          updated_at: FIXED_ISO,
          updated_by: SYNTHETIC_USER_ID,
        },
        company_profile: {
          workspace_id: SYNTHETIC_WORKSPACE_ID,
          payload: syntheticCompanyProfilePayload(operator),
          row_version: 1,
          updated_at: FIXED_ISO,
          updated_by: SYNTHETIC_USER_ID,
        },
        /* Leerer Fachbestand — die Probe soll auf nichts stossen. */
        vorgaenge: [],
        customers: [],
      });
    }

    if (ALLOWED_READ_PATHS.has(path)) {
      /*
       * Die Pulls erwarten ausdrücklich ein Array und behandeln alles andere
       * als Fehler; die beiden `get_*` liefern einen Einzelbefund. Eine leere
       * Antwort ist die einzig richtige und zugleich kleinstmögliche — sie
       * passt zur Sache: Der Fachbestand eines lokalen Laufs beginnt leer.
       */
      return answer(EMPTY_LIST_READ_PATHS.has(path) ? [] : null);
    }

    /*
     * Ab hier wird nichts mehr beantwortet.
     *
     * 01B2 — an dieser Stelle stand einmal eine erfolgreiche Antwort für den
     * Sync-Push. Sie war der gefährlichste Teil dieses Helfers: Ein Fachflow
     * hätte eine erfundene Bestätigung erhalten und wäre grün geblieben,
     * obwohl die Anwendung in die Cloud zu schreiben versuchte. Ein
     * gefälschtes „ist gespeichert" ist schlimmer als gar keine Antwort.
     */
    if (FORBIDDEN_WRITE_PATHS.has(path)) {
      return block('forbiddenWrites');
    }

    /*
     * Kein Fallback — und das ist der eigentliche Schutz. Ein RPC, den es
     * heute noch nicht gibt, landet hier und nicht in einer Erfolgsmeldung.
     */
    return block('unexpected');
  });

  return tracker;
}
