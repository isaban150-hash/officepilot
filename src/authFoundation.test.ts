import { describe, expect, it, vi, afterEach } from 'vitest';
import { BETA_TEST_SETUP, isBetaTestMode } from './config/betaTestMode';
import { createSeedState } from './services/persistenceService';
import {
  approveUser,
  blockUser,
  expireLicense,
  findUserByEmail,
  login,
  loginAsDefaultAdmin,
  registerAndApproveUser,
  registerPendingTestUser,
  seedDefaultAdminUser,
} from './test/authFixtures';
import {
  fetchCurrentSession,
  signInWithPassword,
  signUpUser,
} from './services/auth/authService';
import { getLicenseBlockReason, isUserAllowedToUseApp } from './services/auth/licenseService';
import { PRIVACY_VERSION, TERMS_VERSION, LICENSE_VERSION } from './config/legalVersions';

describe('SUPABASE-AUTH-02', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe('Registrierung & Login', () => {
    it('Registrierung erzeugt pending user', async () => {
      const user = await registerPendingTestUser('pending@example.com');
      expect(user.status).toBe('pending');
      expect(user.acceptedTermsVersion).toBe(TERMS_VERSION);
      expect(user.acceptedPrivacyVersion).toBe(PRIVACY_VERSION);
      expect(user.acceptedLicenseVersion).toBe(LICENSE_VERSION);
      expect(user.legalAcceptedAt).toBeTruthy();
    });

    it('Login funktioniert für freigeschalteten Nutzer', async () => {
      await registerAndApproveUser('active@example.com');
      const result = await signInWithPassword('active@example.com', 'TestPasswort1');
      expect(result.success).toBe(true);
      const session = await fetchCurrentSession();
      expect(session?.user.email).toBe('active@example.com');
    });
  });

  describe('Freischaltung & Zugriff', () => {
    it('pending user darf App nicht nutzen', async () => {
      const user = await registerPendingTestUser('wait@example.com');
      expect(getLicenseBlockReason(user)).toBe('pending');
      expect(isUserAllowedToUseApp(user)).toBe(false);
    });

    it('admin kann user freischalten', async () => {
      const user = await registerPendingTestUser('approve@example.com');
      const approved = await approveUser(user.id);
      expect(approved?.status).toBe('approved');
      expect(isUserAllowedToUseApp(approved!)).toBe(true);
    });

    it('approved user darf App nutzen', async () => {
      await registerAndApproveUser('allowed@example.com');
      await login('allowed@example.com', 'TestPasswort1');
      const session = await fetchCurrentSession();
      expect(isUserAllowedToUseApp(session?.user)).toBe(true);
    });

    it('blocked user darf App nicht nutzen', async () => {
      const user = await registerAndApproveUser('blocked@example.com');
      await blockUser(user.id);
      const blocked = findUserByEmail('blocked@example.com');
      expect(blocked?.status).toBe('blocked');
      expect(isUserAllowedToUseApp(blocked!)).toBe(false);
      expect(getLicenseBlockReason(blocked!)).toBe('blocked');
    });

    it('expired license zeigt license-expired Zustand', async () => {
      const user = await registerAndApproveUser('expired@example.com');
      await expireLicense(user.id);
      const refreshed = findUserByEmail('expired@example.com');
      expect(getLicenseBlockReason(refreshed!)).toBe('license_expired');
      expect(isUserAllowedToUseApp(refreshed!)).toBe(false);
    });
  });

  describe('Admin', () => {
    it('admin user hat admin-Rolle', async () => {
      const admin = await seedDefaultAdminUser();
      expect(admin.role).toBe('admin');
    });

    it('normaler user ist kein admin', async () => {
      const user = await registerAndApproveUser('normal@example.com');
      expect(user.role).toBe('user');
    });
  });

  describe('First-Run & Beta', () => {
    it('produktiver First-Run hat keine Demo-Daten', () => {
      vi.stubEnv('VITE_BETA_TEST_MODE', '');
      const seed = createSeedState({
        companyName: 'Neue Firma',
        industry: 'Handwerk',
        taxStatus: 'standard_19',
        materialStandard: 'betrieb',
        language: 'de',
        setupComplete: true,
        setupVersion: 1,
        communicationChannel: 'email',
      });
      expect(seed.inboxItems).toEqual([]);
      expect(seed.vorgaenge).toEqual([]);
      expect(seed.tasks).toEqual([]);
      expect(seed.documents).toEqual([]);
      expect(seed.expenses).toEqual([]);
    });

    it('Beta-Modus bleibt getrennt mit Musterbetrieb', () => {
      vi.stubEnv('VITE_BETA_TEST_MODE', 'true');
      expect(isBetaTestMode()).toBe(true);
      const seed = createSeedState({ ...BETA_TEST_SETUP });
      expect(seed.inboxItems).toEqual([]);
      expect(seed.setup.companyName).toBe('Musterbetrieb GmbH');
      expect(seed.companyProfile?.companyName).toBe('Musterbetrieb GmbH');
    });
  });

  describe('Session', () => {
    it('Session wird nach Login gesetzt', async () => {
      await registerAndApproveUser('session@example.com');
      await login('session@example.com', 'TestPasswort1');
      const session = await fetchCurrentSession();
      expect(session?.session.userId).toBeTruthy();
    });

    it('Default-Admin kann sich anmelden', async () => {
      await loginAsDefaultAdmin();
      const session = await fetchCurrentSession();
      expect(session?.user.role).toBe('admin');
    });

    it('Registrierung ohne Zustimmung blockiert', async () => {
      const result = await signUpUser({
        companyName: 'Firma',
        firstName: 'Max',
        lastName: 'Muster',
        email: 'no-consent@example.com',
        password: 'TestPasswort1',
        acceptedTermsVersion: '',
        acceptedPrivacyVersion: PRIVACY_VERSION,
        acceptedLicenseVersion: LICENSE_VERSION,
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toBe('terms_required');
      }
    });
  });
});
