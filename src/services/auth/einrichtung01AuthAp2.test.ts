/**
 * EINRICHTUNG-01 (AP2) — Anmeldung und Sitzung, Dienstebene (Katalog V3, Gruppe A).
 *
 *   A-07 / EIN-17  Fehlerzuordnung als Tabelle: über Code, Status und Fehlerart, nie über den Wortlaut; kein Rohtext.
 *   A-08           Registrierung: bekannte Adresse = dieselbe neutrale Antwort; schwaches Passwort über den Code.
 *   A-07.6         „Bestätigung erneut senden“: immer neutral.
 *   A-16.1         `emailRedirectTo` = eigene Origin plus Pfad aus der Positivliste.
 *   A-12           Rücksprungpfade: nur relative App-Pfade, keine Schleife, Plattformseiten nur für Plattform-Admins.
 *   A-04/A-05      Abmelden `local` als Vorgabe, `global` ausdrücklich.
 *   A-01/A-10      Einordnung des Profilabrufs: nur bestätigt fehlend bzw. abgewiesen beendet die Anmeldung.
 *   A-13/A-14      gültige Zustimmung nur zur geltenden Fassung mit Zeitpunkt; Zustimmen nur für das eigene Konto.
 *   A-01.4/A-02.3  unbestätigte Rechte: lokale Änderungen ja, cloudbestätigte Aktionen nein.
 *   A-11.1         Wiederherstellungsmerker gilt tabübergreifend und läuft ab.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PASSWORD_RECOVERY_FLAG_KEY,
  PASSWORD_RECOVERY_SHARED_KEY,
  buildAuthRedirectUrl,
  clearPasswordRecoveryPending,
  getLoginErrorMessage,
  getRegisterErrorMessage,
  mapSupabaseLoginError,
  mapSupabaseSignUpError,
  markPasswordRecoveryPending,
  readPasswordRecoveryPendingFlag,
  resendSignupConfirmation,
  signOutUser,
  signUpUser,
} from './supabaseAuthService';
import { buildLoginRedirect, resolvePendingReturnPath, resolveReturnPathForUser, sanitizeReturnPath } from './authReturnPath';
import { PROFILE_FETCH_TIMEOUT_MS, classifyProfileFetchError, fetchProfileById } from './profileService';
import { acceptCurrentLegalTerms, hasCurrentLegalConsent } from './legalConsentService';
import { clearCloudRightsState, isCloudRightsUnconfirmed, markCloudRightsConfirmed, markCloudRightsUnconfirmed } from './cloudRightsState';
import { LEGAL_DOCUMENT_VERSIONS, LICENSE_VERSION, PRIVACY_VERSION, TERMS_VERSION } from '../../config/legalVersions';
import { resolveCloudConfirmedActionAccess, resolveWorkspaceWriteAccess } from '../workspace/workspaceRoleService';
import { hydrateWorkspaceStore } from '../workspace/workspaceStore';
import { login, registerAndApproveUser, resetAuthForTests } from '../../test/authFixtures';
import {
  getMockCurrentSession,
  getMockLastSignOutScope,
  getMockLastSignUpOptions,
  getMockResendCalls,
  releaseMockProfileFetches,
  setMockProfileFetchMode,
  setMockSignUpMode,
} from '../../test/mockSupabaseAuth';
import type { AuthErrorCode, RegisterErrorCode, UserAccount } from '../../types/auth';

beforeEach(() => {
  resetAuthForTests();
  localStorage.clear();
  sessionStorage.clear();
  clearCloudRightsState();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setMockSignUpMode('with_session');
  clearCloudRightsState();
});

describe('A-07 / EIN-17 — Fehlerzuordnung über Codes', () => {
  it('ordnet jeden Fall eigenständig zu und nie über den Wortlaut', () => {
    const faelle: Array<[Parameters<typeof mapSupabaseLoginError>[0], AuthErrorCode]> = [
      [{ name: 'AuthApiError', code: 'invalid_credentials', status: 400, message: 'Invalid login credentials' }, 'invalid_credentials'],
      [{ name: 'AuthApiError', status: 400, message: 'irgendwas' }, 'invalid_credentials'],
      [{ name: 'AuthApiError', code: 'email_not_confirmed', status: 400, message: 'Email not confirmed' }, 'email_not_confirmed'],
      [{ name: 'AuthApiError', code: 'over_request_rate_limit', status: 429, message: 'x' }, 'rate_limited'],
      [{ name: 'AuthApiError', status: 429, message: 'x' }, 'rate_limited'],
      [{ name: 'AuthRetryableFetchError', status: 0, message: 'Failed to fetch' }, 'network'],
      [{ name: 'AuthApiError', status: 500, message: 'Internal' }, 'unknown'],
      [{ name: 'AuthApiError', code: 'neuer_unbekannter_code', status: 422, message: 'Invalid login credentials' }, 'unknown'],
      // Der Wortlaut allein entscheidet nichts mehr.
      [{ message: 'Email not confirmed' }, 'unknown'],
    ];
    for (const [fehler, erwartet] of faelle) {
      expect(mapSupabaseLoginError(fehler), JSON.stringify(fehler)).toBe(erwartet);
    }
  });

  it('jeder Code hat einen eigenen verständlichen Hinweis ohne Rohtext (A-07.1 bis A-07.5)', () => {
    const codes: AuthErrorCode[] = ['invalid_credentials', 'email_not_confirmed', 'rate_limited', 'network', 'unknown'];
    const texte = codes.map((code) => getLoginErrorMessage(code, 'de'));
    expect(new Set(texte).size).toBe(codes.length);
    for (const text of texte) {
      expect(text.length).toBeGreaterThan(10);
      expect(text).not.toMatch(/Invalid|JWT|AuthApiError|fetch|429|500|auth\.error/);
    }
    expect(getLoginErrorMessage('email_not_confirmed', 'de')).toContain('nicht bestätigt');
    expect(getLoginErrorMessage('rate_limited', 'de')).toContain('Zu viele Versuche');
    expect(getLoginErrorMessage('network', 'de')).toContain('Verbindung');
    for (const sprache of ['tr', 'bg'] as const) {
      expect(getLoginErrorMessage('network', sprache)).not.toBe(getLoginErrorMessage('network', 'de'));
    }
  });

  it('Registrierung: bekannte Adresse wird neutral, schwaches Passwort über den Code (A-08.2)', () => {
    const faelle: Array<[Parameters<typeof mapSupabaseSignUpError>[0], RegisterErrorCode | 'existing']> = [
      [{ code: 'user_already_exists', status: 422, message: 'User already registered' }, 'existing'],
      [{ code: 'email_exists', status: 422, message: 'x' }, 'existing'],
      [{ code: 'weak_password', status: 422, message: 'Password should be' }, 'weak_password'],
      [{ code: 'email_address_invalid', status: 400, message: 'x' }, 'invalid_email'],
      [{ name: 'AuthRetryableFetchError', status: 0, message: 'Failed to fetch' }, 'network'],
      [{ status: 429, message: 'x' }, 'rate_limited'],
      [{ message: 'User already registered' }, 'registration_failed'],
    ];
    for (const [fehler, erwartet] of faelle) {
      expect(mapSupabaseSignUpError(fehler), JSON.stringify(fehler)).toBe(erwartet);
    }
    expect(getRegisterErrorMessage('weak_password', 'de')).toContain('zu schwach');
  });
});

const EINGABE = {
  companyName: 'Neutral GmbH',
  firstName: 'Nora',
  lastName: 'Neutral',
  password: 'TestPasswort1',
  acceptedTermsVersion: TERMS_VERSION,
  acceptedPrivacyVersion: PRIVACY_VERSION,
  acceptedLicenseVersion: LICENSE_VERSION,
};

describe('A-08 / A-16 — Registrierung', () => {
  it('A-08.1 eine schon registrierte Adresse bekommt dieselbe neutrale Antwort wie eine neue', async () => {
    setMockSignUpMode('email_confirmation');
    const neu = await signUpUser({ ...EINGABE, email: 'neu-ap2@example.invalid' });
    const bekannt = await signUpUser({ ...EINGABE, email: 'neu-ap2@example.invalid' });
    expect(neu).toMatchObject({ success: true, outcome: 'email_confirmation_required' });
    expect(bekannt).toMatchObject({ success: true, outcome: 'email_confirmation_required' });
    if (bekannt.success && neu.success) expect(Object.keys(bekannt).sort()).toEqual(Object.keys(neu).sort());
  });

  it('A-16.1 Bestätigungslink führt auf die eigene Origin und einen Pfad der Positivliste', async () => {
    setMockSignUpMode('email_confirmation');
    await signUpUser({ ...EINGABE, email: 'redirect-ap2@example.invalid' });
    expect(getMockLastSignUpOptions()).toMatchObject({ emailRedirectTo: `${window.location.origin}/login` });
    expect(buildAuthRedirectUrl('/login')).toBe(`${window.location.origin}/login`);
    expect(buildAuthRedirectUrl('/reset-password')).toBe(`${window.location.origin}/reset-password`);
    expect(buildAuthRedirectUrl('/admin' as never)).toBeUndefined();
  });

  it('A-07.6 „Bestätigung erneut senden“ antwortet neutral und nennt die Rückkehradresse', async () => {
    expect(await resendSignupConfirmation('gibt-es-nicht@example.invalid')).toBe('sent');
    expect(await resendSignupConfirmation('kein-mail')).toBe('invalid_email');
    expect(getMockResendCalls()).toEqual([
      { type: 'signup', email: 'gibt-es-nicht@example.invalid', emailRedirectTo: `${window.location.origin}/login` },
    ]);
  });
});

describe('A-12 — Rücksprung nach der Anmeldung', () => {
  it('nur relative App-Pfade; keine Anmeldeseiten; Plattformseiten nach Rolle', () => {
    expect(sanitizeReturnPath('/einstellungen/firma')).toBe('/einstellungen/firma');
    expect(sanitizeReturnPath('/kunden?suche=a#x')).toBe('/kunden?suche=a#x');
    for (const boese of ['https://evil.example/x', '//evil.example', '/\\evil.example', 'javascript:alert(1)', ' /\u0000x', 'kunden', '', null, undefined]) {
      expect(sanitizeReturnPath(boese as string), String(boese)).toBeNull();
    }
    for (const schleife of ['/login', '/login?next=%2F', '/register', '/reset-password', '/forgot-password/', '/']) {
      expect(sanitizeReturnPath(schleife), schleife).toBeNull();
    }
    const mitglied = { id: 'u', role: 'user' } as UserAccount;
    const admin = { id: 'a', role: 'admin' } as UserAccount;
    expect(resolveReturnPathForUser('/admin/users', mitglied)).toBeNull();
    expect(resolveReturnPathForUser('/admin/users', admin)).toBe('/admin/users');
    expect(resolveReturnPathForUser('/einstellungen/betrieb', mitglied)).toBe('/einstellungen/betrieb');
    expect(buildLoginRedirect('/einstellungen/firma', '?x=1')).toBe(`/login?next=${encodeURIComponent('/einstellungen/firma?x=1')}`);
    expect(buildLoginRedirect('/login')).toBe('/login');
  });

  // EINRICHTUNG-01 (Eigenprüfung; N-01.3) — im Browser landete `/firmendaten#logo` nach dem Umweg über /login auf den
  // Firmendaten, weil der Anker im Rücksprung fehlte.
  it('der Anker bleibt im Rücksprung erhalten; die Zielprüfung gilt für den ganzen Text', () => {
    expect(buildLoginRedirect('/firmendaten', '', '#logo')).toBe(`/login?next=${encodeURIComponent('/firmendaten#logo')}`);
    expect(buildLoginRedirect('/einstellungen/rechnungen', '?a=1', '#settings-invoices-defaultPaymentDays')).toBe(
      `/login?next=${encodeURIComponent('/einstellungen/rechnungen?a=1#settings-invoices-defaultPaymentDays')}`,
    );
    expect(resolveReturnPathForUser('/firmendaten#rechnungstexte', { id: 'u', role: 'user' } as UserAccount)).toBe('/firmendaten#rechnungstexte');
    // ein Anker darf kein unsicheres Ziel einschleusen
    expect(buildLoginRedirect('/firmendaten', '', '#\\evil')).toBe('/login');
    expect(buildLoginRedirect('/firmendaten', '', `#${'x'.repeat(600)}`)).toBe('/login');
    expect(buildLoginRedirect('/login', '', '#x')).toBe('/login');
  });

  it('EINRICHTUNG-01 AP4 (Weg C): ein wartendes Konto kehrt nur zur Einladungsseite zurück', () => {
    const wartend = { id: 'w', role: 'user', status: 'pending' } as UserAccount;
    expect(resolvePendingReturnPath('/einladung/Tok-123_abc', wartend)).toBe('/einladung/Tok-123_abc');
    expect(resolvePendingReturnPath('/einladung/Tok-123?email=x%40y.example', wartend)).toBe('/einladung/Tok-123?email=x%40y.example');
    for (const anderes of ['/einstellungen/firma', '/', '/einladung/', '/einladung/a/b', '//evil.example/einladung/x', 'https://evil.example/einladung/x', '/admin/users']) {
      expect(resolvePendingReturnPath(anderes, wartend), anderes).toBeNull();
    }
  });
});

describe('A-04 / A-05 — Abmelden', () => {
  it('ohne Angabe nur dieses Gerät; „überall“ ausdrücklich', async () => {
    await registerAndApproveUser('abmelden-ap2@example.invalid');
    await login('abmelden-ap2@example.invalid', 'TestPasswort1');
    await signOutUser();
    expect(getMockLastSignOutScope()).toBe('local');
    await login('abmelden-ap2@example.invalid', 'TestPasswort1');
    await signOutUser('global');
    expect(getMockLastSignOutScope()).toBe('global');
  });
});

describe('A-01 / A-10 — Einordnung des Profilabrufs', () => {
  it('nur eine bestätigte Abweisung beendet die Anmeldung', () => {
    expect(classifyProfileFetchError({ status: 401, message: 'JWT expired' })).toBe('session_invalid');
    expect(classifyProfileFetchError({ code: 'PGRST301', message: 'x' })).toBe('session_invalid');
    expect(classifyProfileFetchError({ code: '42501', message: 'session_not_active: Die Sitzung ist beendet' })).toBe('session_invalid');
    for (const fehler of [{ status: 500, message: 'x' }, { status: 503 }, { code: '57014', message: 'canceling statement' }, { message: 'unbekannt' }, null]) {
      expect(classifyProfileFetchError(fehler), JSON.stringify(fehler)).toBe('temporary');
    }
  });

  it('Netz, Zeitüberschreitung, 401 und fehlendes Profil am echten Abrufweg', async () => {
    const konto = await registerAndApproveUser('profil-ap2@example.invalid');
    await login('profil-ap2@example.invalid', 'TestPasswort1');
    setMockProfileFetchMode('network');
    expect(await fetchProfileById(konto.id)).toEqual({ success: false, error: 'temporary' });
    setMockProfileFetchMode('unauthorized');
    expect(await fetchProfileById(konto.id)).toEqual({ success: false, error: 'session_invalid' });
    setMockProfileFetchMode('missing');
    expect(await fetchProfileById(konto.id)).toEqual({ success: false, error: 'not_found' });
    vi.useFakeTimers();
    setMockProfileFetchMode('hold');
    const haengt = fetchProfileById(konto.id);
    await vi.advanceTimersByTimeAsync(PROFILE_FETCH_TIMEOUT_MS + 10);
    expect(await haengt).toEqual({ success: false, error: 'temporary' });
    releaseMockProfileFetches();
    vi.useRealTimers();
    setMockProfileFetchMode(null);
    expect(await fetchProfileById(konto.id)).toMatchObject({ success: true });
  });
});

describe('A-13 / A-14 — Zustimmung', () => {
  it('gilt nur für die geltende Fassung mit Zeitpunkt', () => {
    const basis = {
      acceptedTermsVersion: LEGAL_DOCUMENT_VERSIONS.terms,
      acceptedPrivacyVersion: LEGAL_DOCUMENT_VERSIONS.privacy,
      acceptedLicenseVersion: LEGAL_DOCUMENT_VERSIONS.license,
      legalAcceptedAt: '2026-10-23T08:00:00.000Z',
    } as UserAccount;
    expect(hasCurrentLegalConsent(basis)).toBe(true);
    expect(hasCurrentLegalConsent({ ...basis, legalAcceptedAt: undefined })).toBe(false);
    expect(hasCurrentLegalConsent({ ...basis, acceptedTermsVersion: '0.9' })).toBe(false);
    expect(hasCurrentLegalConsent({ ...basis, acceptedLicenseVersion: undefined })).toBe(false);
    expect(hasCurrentLegalConsent(null)).toBe(false);
  });

  it('A-14.3 Zustimmen nur für das angemeldete Konto', async () => {
    const konto = await registerAndApproveUser('zustimmung-ap2@example.invalid');
    await login('zustimmung-ap2@example.invalid', 'TestPasswort1');
    expect(await acceptCurrentLegalTerms('anderes-konto')).toBe('account_mismatch');
    expect(await acceptCurrentLegalTerms(konto.id)).toBe('ok');
    expect(getMockCurrentSession()?.user.id).toBe(konto.id);
  });
});

describe('A-01.4 / A-02.3 — unbestätigte Rechte', () => {
  it('lokale Änderungen bleiben möglich, cloudbestätigte Aktionen nicht', () => {
    hydrateWorkspaceStore({
      workspace: { id: 'ws-ap2', name: 'B', ownerUserId: 'konto-ap2', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', version: 1 },
      workspaceMembers: [{ workspaceId: 'ws-ap2', userId: 'konto-ap2', role: 'owner', status: 'active', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }],
    });
    const actor = { userId: 'konto-ap2', cloudConfigured: true };
    expect(resolveCloudConfirmedActionAccess(resolveWorkspaceWriteAccess(actor))).toBe(true);
    markCloudRightsUnconfirmed('konto-ap2', 'profile_unconfirmed');
    expect(isCloudRightsUnconfirmed('konto-ap2')).toBe(true);
    const zugang = resolveWorkspaceWriteAccess(actor);
    expect(zugang).toMatchObject({ canWrite: true, role: 'owner', rightsUnconfirmed: true });
    expect(resolveCloudConfirmedActionAccess(zugang)).toBe(false);
    // Ein anderes Konto ist nicht betroffen; der lokale Betrieb kennt das Kennzeichen nicht.
    expect(isCloudRightsUnconfirmed('konto-anderes')).toBe(false);
    expect(resolveWorkspaceWriteAccess({ userId: 'konto-ap2', cloudConfigured: false })).not.toHaveProperty('rightsUnconfirmed');
    markCloudRightsConfirmed('konto-ap2', 'profile_unconfirmed');
    expect(resolveCloudConfirmedActionAccess(resolveWorkspaceWriteAccess(actor))).toBe(true);
  });
});

describe('A-11.1 — Wiederherstellungsmerker', () => {
  it('gilt tabübergreifend, läuft nach einer Stunde ab und wird vollständig gelöscht', () => {
    markPasswordRecoveryPending();
    expect(sessionStorage.getItem(PASSWORD_RECOVERY_FLAG_KEY)).toBe('1');
    expect(localStorage.getItem(PASSWORD_RECOVERY_SHARED_KEY)).not.toBeNull();
    // Ein anderer Tab sieht nur den gemeinsamen Merker.
    sessionStorage.clear();
    expect(readPasswordRecoveryPendingFlag()).toBe(true);
    // Abgelaufen: nicht mehr gültig und entfernt.
    localStorage.setItem(PASSWORD_RECOVERY_SHARED_KEY, JSON.stringify({ at: Date.now() - 61 * 60 * 1000 }));
    expect(readPasswordRecoveryPendingFlag()).toBe(false);
    expect(localStorage.getItem(PASSWORD_RECOVERY_SHARED_KEY)).toBeNull();
    markPasswordRecoveryPending();
    clearPasswordRecoveryPending();
    expect(readPasswordRecoveryPendingFlag()).toBe(false);
    expect(localStorage.getItem(PASSWORD_RECOVERY_SHARED_KEY)).toBeNull();
  });
});
