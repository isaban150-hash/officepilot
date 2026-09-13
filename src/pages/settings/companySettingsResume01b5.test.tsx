/**
 * MOBILE-RESUME-STATE-02B → SETTINGS-01B5 — die Wiederaufnahme-Zusicherungen
 * der abgelösten Firmendaten-Seite, jetzt an der kanonischen Firmenprofil-Seite
 * (derselbe Namensraum `companyProfile`). Dirty/Resume/Save-leert-Resume und
 * der Basisabgleich sind bereits in `companySettingsPage01b2.test.tsx` (F6–F8)
 * belegt; hier stehen die übrigen Zusicherungen: kein Dirty-Entwurf ohne
 * Änderung, Formzustand **vor** der Scrollanwendung, keine Fehlerzustände und
 * keine verschachtelten Verträge (branding/logoDataUrl) im Schnappschuss,
 * fremder Scope wird nicht angeboten, nur Primitive. Synthetische Daten.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppProvider } from '../../context/AppContext';
import { AuthProvider } from '../../context/AuthContext';
import { DEFAULT_SETUP } from '../../data/mockData';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import { CompanySettingsPage } from './CompanySettingsPage';
import * as supabaseLib from '../../lib/supabase';
import { hydrateCompanyProfileStore } from '../../services/companyProfileService';
import { setActiveStorageScope } from '../../services/storage/storageScopeService';
import * as uiSessionCapture from '../../services/uiSession/uiSessionCapture';
import { captureAndPersistUiSession } from '../../services/uiSession/uiSessionCapture';
import { resetUiSessionLiveState, setPendingUiSessionApply } from '../../services/uiSession/uiSessionLiveState';
import { clearUiSessionSnapshot, loadUiSessionSnapshot } from '../../services/uiSession/uiSessionStore';
import { decideUiSessionRestore } from '../../services/uiSession/uiSessionRestore';
import type { CompanyProfile } from '../../types/models';

const ROUTE = '/einstellungen/firma';

const savedProfile: CompanyProfile = {
  ...DEFAULT_COMPANY_PROFILE,
  companyName: 'Bestand GmbH',
  street: 'Werk 1',
  zip: '80331',
  city: 'München',
  iban: 'DE89370400440532013000',
  bankName: 'Sparkasse',
  phone: '089 111',
  email: 'a@b.invalid',
  taxNumber: '143/123/45678',
  contactPerson: 'A. Beispiel',
  country: 'Deutschland',
  branding: { logo: { assetId: 'asset-1', mimeType: 'image/png' } },
  logoDataUrl: 'data:image/png;base64,QUJD',
};

let root: Root;
let host: HTMLDivElement;

function mountShell(): void {
  host = document.createElement('div');
  host.className = 'app-shell__main';
  document.body.appendChild(host);
  root = createRoot(host);
}

beforeEach(() => {
  vi.spyOn(supabaseLib, 'isSupabaseConfigured').mockReturnValue(false);
  setActiveStorageScope({ type: 'guest' });
  resetUiSessionLiveState();
  clearUiSessionSnapshot();
  hydrateCompanyProfileStore(savedProfile);
  mountShell();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = '';
  clearUiSessionSnapshot();
  resetUiSessionLiveState();
  vi.restoreAllMocks();
});

async function renderPage(): Promise<void> {
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={[ROUTE]}>
        <AuthProvider>
          <AppProvider initialSetup={{ ...DEFAULT_SETUP, setupComplete: true }}>
            <Routes>
              <Route path={ROUTE} element={<CompanySettingsPage />} />
            </Routes>
          </AppProvider>
        </AuthProvider>
      </MemoryRouter>,
    );
  });
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
  }
}

function captureNow(scrollTop = 0): void {
  captureAndPersistUiSession({ pathname: ROUTE, search: '', hash: '', historyKey: 'k1', mainScrollTop: scrollTop, userId: null, source: 'auto' });
}

function field(id: string): HTMLInputElement {
  const el = host.querySelector<HTMLInputElement>(`#settings-company-${id}`);
  if (!el) throw new Error(`Feld fehlt: ${id}`);
  return el;
}

async function setValue(element: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('SETTINGS-01B5 — Wiederaufnahme der Firmenprofil-Seite', () => {
  it('R1/R15: ohne Entwurf stehen die gespeicherten Werte im Formular; ohne Änderung entsteht kein Dirty-Entwurf', async () => {
    await renderPage();
    expect(field('companyName').value).toBe('Bestand GmbH');
    expect(loadUiSessionSnapshot()).toBeNull();
    captureNow();
    expect(loadUiSessionSnapshot()?.drafts.dirty).toBe(false);
    expect(loadUiSessionSnapshot()?.drafts.values ?? {}).toEqual({});
  });

  it('R4: der Formzustand steht, bevor die Scrollposition angewandt wird', async () => {
    await renderPage();
    await setValue(field('registrationNumber'), 'HRB 4711');
    captureNow(320);

    await act(async () => root.unmount());
    host.remove();
    mountShell();

    let stateAtScrollTime: boolean | null = null;
    vi.spyOn(uiSessionCapture, 'applyMainScrollTop').mockImplementation(() => {
      stateAtScrollTime = (document.querySelector('#settings-company-registrationNumber') as HTMLInputElement | null)?.value === 'HRB 4711';
    });
    const decision = decideUiSessionRestore({ userId: null, currentPathname: ROUTE, currentSearch: '' });
    if (decision.intent === 'silent' && decision.snapshot) setPendingUiSessionApply(decision.snapshot);
    await renderPage();

    expect(stateAtScrollTime, 'applyMainScrollTop wurde nicht aufgerufen').not.toBeNull();
    expect(stateAtScrollTime).toBe(true);
  });

  it('R14/R11/R11b: keine Fehlerzustände, keine Datei-/Object-URLs, kein branding/logoDataUrl im Entwurf — nur Allowlist-Felder', async () => {
    await renderPage();
    await setValue(field('companyName'), '');
    await setValue(field('email'), 'keine-mail');
    const form = host.querySelector('form') as HTMLFormElement;
    await act(async () => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    expect(host.querySelector('[data-testid="settings-company-email-error"]')).not.toBeNull();
    captureNow();

    const values = loadUiSessionSnapshot()?.drafts.values ?? {};
    expect(Object.keys(values).length).toBeGreaterThan(0);
    expect(Object.keys(values).some((key) => key.toLowerCase().includes('error'))).toBe(false);
    const serialized = JSON.stringify(values);
    expect(serialized).not.toContain('blob:');
    expect(serialized).not.toContain('data:image');
    expect(serialized).not.toContain('asset-1');
    expect(Object.keys(values)).not.toContain('companyProfile.branding');
    expect(Object.keys(values)).not.toContain('companyProfile.logoDataUrl');
    expect(Object.keys(values).every((key) => key.startsWith('companyProfile.'))).toBe(true);
    for (const value of Object.values(values)) {
      expect(['string', 'number', 'boolean']).toContain(typeof value);
    }
  });

  it('R7–R9: ein Entwurf aus fremdem Scope wird nicht angeboten', async () => {
    await renderPage();
    await setValue(field('companyName'), 'Fremder Entwurf GmbH');
    captureNow();
    expect(loadUiSessionSnapshot()?.drafts.dirty).toBe(true);

    setActiveStorageScope({ type: 'workspace', workspaceId: 'ws-fremd' });
    const decision = decideUiSessionRestore({ userId: null, currentPathname: ROUTE, currentSearch: '' });
    expect(decision.intent).toBe('ignore');
    setActiveStorageScope({ type: 'guest' });
  });
});
