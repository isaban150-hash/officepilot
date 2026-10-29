/**
 * EINRICHTUNG-01 (App-Eigenprüfung; Vertrag 1.31, E-9) — die Notfall-Importseite `/local-recovery/import` und ihr
 * Einstieg auf `/local-recovery` erscheinen in der Sprache des jüngsten freigegebenen Bestands (wie die übrige
 * Notfallseite): tr und bg vollständig, `<html lang>` passend; ohne freigegebenen Bestand unverändert Deutsch.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { RootShell } from './RootShell';
import { STORAGE_VERSION } from './services/sync/syncMigrationService';
import { resetStorageScopeForTests } from './services/storage/storageScopeService';
import { resetDocumentBlobDatabaseForTests } from './services/storage/documentBlobIndexedDbService';
import { DEFAULT_SETUP } from './data/mockData';
import { DEFAULT_COMPANY_PROFILE } from './data/companyProfileDefaults';
import { resetTestStores } from './test/resetStores';
import { alsBestaetigtesKonto } from './test/recoveryIdentityTestUtils';
import { de, tr, bg } from './i18n';
import { deLocalRecoveryImport } from './i18n/locales/de/localRecoveryImport';
import type { AppLanguage, CompanySetup } from './types/models';

const WS = 'ws-notfall-sprache';
const KEY = `officepilot-state:workspace:${WS}`;

function zustand(language: AppLanguage): string {
  const setup: CompanySetup = { ...DEFAULT_SETUP, companyName: 'Sprachprobe GmbH', setupComplete: true, setupVersion: 1, language };
  return JSON.stringify({
    version: STORAGE_VERSION,
    invoiceEntries: [],
    setup,
    companyProfile: { ...DEFAULT_COMPANY_PROFILE, companyName: 'Sprachprobe GmbH' },
    workspace: { id: WS, name: 'Sprachprobe GmbH', ownerUserId: 'konto-sprache' },
    syncClient: { deviceId: 'device-sprache', workspaceId: WS, serverWorkspaceId: WS, syncPolicy: 'cloud' },
    inboxItems: [],
    vorgaenge: [],
    tasks: [],
    documents: [],
    expenses: [],
    documentWorkResults: [],
    documentFileRefs: [],
    syncOutbox: [],
    savedAt: '2026-10-25T20:00:00.000Z',
  });
}

let host: HTMLDivElement | null = null;
let root: Root | null = null;

async function settle(rounds = 25): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function zeige(pathname: string): Promise<HTMLDivElement> {
  window.history.pushState({}, '', pathname);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <BrowserRouter>
        <RootShell />
      </BrowserRouter>,
    );
  });
  await settle();
  return host;
}

const textVon = (container: HTMLElement, sel: string) => container.querySelector(sel)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

beforeEach(async () => {
  alsBestaetigtesKonto('konto-sprache');
  localStorage.clear();
  sessionStorage.clear();
  resetStorageScopeForTests();
  resetTestStores();
  await resetDocumentBlobDatabaseForTests();
});

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  host = null;
  root = null;
  document.documentElement.lang = 'de';
});

const KATALOG = { tr, bg } as const;

describe('EINRICHTUNG-01 E-9 — Notfall-Importseite in tr und bg', () => {
  it.each(['tr', 'bg'] as const)('%s: Importseite vollständig in der Sprache des freigegebenen Bestands', async (sprache) => {
    localStorage.setItem(KEY, zustand(sprache));
    const c = await zeige('/local-recovery/import');
    const k = KATALOG[sprache] as Record<string, string>;
    expect(textVon(c, '#local-recovery-import-title')).toBe(k['localRecoveryImport.title']);
    expect(textVon(c, '[data-testid="import-readonly-note"]')).toBe(k['localRecoveryImport.readonlyNote']);
    expect(textVon(c, `[data-testid="import-target-option-${KEY}"] [data-field="storageKey"] .local-recovery-import-target__label`)).toBe(
      k['localRecoveryImport.label.storageKey'],
    );
    expect(document.documentElement.lang).toBe(sprache);
    // kein deutscher Seitentext mehr sichtbar (Kontrolle mit den deutschen Texten dieser Seite)
    const seite = textVon(c, '[data-testid="local-recovery-import-page"]');
    for (const [schluessel, deutsch] of Object.entries(deLocalRecoveryImport)) {
      if (!schluessel.startsWith('localRecoveryImport.') || deutsch.includes('{')) continue;
      if (deutsch === k[schluessel]) continue; // gleich geschriebene Fachbegriffe (SHA-256, Status)
      expect(seite.includes(deutsch), `${sprache}: deutscher Text sichtbar: ${schluessel}`).toBe(false);
    }
  });

  it.each(['tr', 'bg'] as const)('%s: Einstieg auf /local-recovery (Link und Hinweis) übersetzt', async (sprache) => {
    localStorage.setItem(KEY, zustand(sprache));
    const c = await zeige('/local-recovery');
    const k = KATALOG[sprache] as Record<string, string>;
    expect(textVon(c, '[data-testid="local-recovery-import-link"]')).toBe(k['localRecovery.importLink']);
    expect(textVon(c, '[data-testid="local-recovery-import-note"]')).toBe(k['localRecovery.importNote']);
  });

  it('ohne freigegebenen Bestand bleibt die Importseite unverändert deutsch', async () => {
    const c = await zeige('/local-recovery/import');
    const d = de as Record<string, string>;
    expect(textVon(c, '#local-recovery-import-title')).toBe('Zielsicherung und Quarantäne');
    expect(d['localRecoveryImport.title']).toBe('Zielsicherung und Quarantäne');
    expect(textVon(c, '[data-testid="import-readonly-note"]')).toBe(
      'Diese Seite führt keinen Import durch, ersetzt keinen Bestand, entfernt keinen Quarantänevorgang, startet keine Synchronisierung und wechselt nicht in die normale Anwendung.',
    );
    expect(document.documentElement.lang).toBe('de');
  });
});
