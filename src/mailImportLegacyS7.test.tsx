/**
 * CLOUD-SYNC S7 — der frühere manuelle Mailimport ist aus dem aktiven Produkt genommen.
 *
 * Kanonisch bleiben das verbundene Postfach (Nachrichten, `/kommunikation`) und
 * der normale Eingangs-Upload für Dateien und Mail-Anhänge. Ein vorhandener
 * lokaler Altbestand bleibt lesbar, wird aber nicht mehr als Geschäftswahrheit
 * verwendet, nicht verfolgt und nie gesendet.
 *
 * A  kein Einstieg „E-Mails importieren"
 * B  die alte Adresse /mail-import landet bei den Nachrichten
 * C  der normale Eingang/Upload bleibt erreichbar
 * D  der Nachrichten-/Postfachbereich bleibt erreichbar
 * E  kein Produktweg erzeugt mehr einen Mailimport
 * F  ein lokaler Altbestand wird geladen und mit unverändertem Inhalt wieder gespeichert
 *    (die schon bestehende Lade-Migration ergänzt wie bei jeder Entität nur lokale `sync`-Metadaten)
 * G  ein Backup mit Mailimporten bleibt gültig und lässt sich wiederherstellen
 * H  ein neues Backup bleibt gültig
 * I  mail_import ist nicht freigegeben, bleibt nur-lokal und wird nicht verfolgt
 * M  der Kommunikationskontext liest keinen Altbestand; der URL-Parser kennt keinen Mailkontext
 * N  der Lebenszyklus beachtet keinen Bezug auf den Altbestand (vor S7 hätte ein Ereignis am
 *    Mailbezug „Antwort offen" erzeugt); derselbe Bezug am Eingang wirkt weiterhin
 *
 * J (alte Sendeaufträge ohne Schleife) prüft `sync/localOnlyOutbox01d.test.ts`,
 * K/L (Suche) `officeSearchService.test.ts`.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from './App';
import { AppProvider } from './context/AppContext';
import { AuthProvider } from './context/AuthContext';
import { DEFAULT_SETUP } from './data/mockData';
import { MehrPage } from './pages/MehrPage';
import { PRIMARY_NAV, SECONDARY_NAV_GROUPS } from './components/layout/navConfig';
import { parseContextRefFromSearchParams } from './components/communication/communicationNavigation';
import * as mailImportService from './services/mailImportService';
import { getMailImportSnapshot, hydrateMailImports } from './services/mailImportService';
import { buildCommunicationContext } from './services/communicationContextService';
import { setCommunicationHistoryStoreForTests } from './services/communicationHistoryStore';
import { resolveDocumentLifecycle } from './services/documentLifecycleService';
import { hydrateInboxStore } from './services/inboxService';
import { clearInMemoryBusinessState, persistAll } from './services/persistenceService';
import { bootstrapBusinessState } from './services/storage/storageBootstrapService';
import { buildStorageKey } from './services/storage/storageScopeService';
import { getSyncOutboxSnapshot } from './services/sync/syncOutboxService';
import { TRACKED_SYNC_ENTITY_TYPES } from './services/sync/syncChangeTrackerService';
import { isSupabaseSyncAllowed, LOCAL_ONLY_SYNC_ENTITY_TYPES } from './services/sync/cloudSyncAllowlist';
import { buildLocalBackupBundle } from './services/backupExportService';
import { validateLocalBackupZip } from './services/backupValidateService';
import { restoreLocalBackupBundle } from './services/backupRestoreService';
import { useDocumentBlobDatabaseReset } from './test/documentBlobTestReset';
import { loginAsDefaultAdmin, seedDefaultAdminUser } from './test/authFixtures';
import { createAuftragInboxItem } from './test/fixtures';
import type { CommunicationContextRef } from './types/communication';
import type { CommunicationEvent } from './types/communicationHistory';
import type { MailImport } from './types/mailImport';

useDocumentBlobDatabaseReset();

const NOW = '2026-10-07T12:00:00.000Z';

/** Ein Datensatz, wie ihn der frühere Mailimport geschrieben hat (neutrale Beispieldaten). */
function altbestand(id = 'mail-legacy-s7'): MailImport {
  return {
    id,
    from: 'service@beispiel-lieferant.de',
    to: '',
    subject: 'S7 Altbestand Beitragsbescheid',
    receivedAt: '2026-07-10',
    bodyText: 'Text aus dem früheren manuellen Mailimport.',
    attachments: [{ id: 'mail-att-legacy-s7', fileName: 'bescheid.pdf', mimeType: 'application/pdf', status: 'processed', linkedInboxId: 'inbox-legacy-s7' }],
    status: 'processed',
    source: 'manual',
    linkedInboxIds: ['inbox-legacy-s7'],
    linkedDocumentIds: [],
    createdAt: '2026-07-10T09:00:00.000Z',
    updatedAt: '2026-07-10T09:00:00.000Z',
  };
}

const completeSetup = { ...DEFAULT_SETUP, setupComplete: true, setupVersion: 1 };

let mounted: { container: HTMLDivElement; root: Root } | undefined;

afterEach(() => {
  if (mounted) {
    act(() => mounted!.root.unmount());
    mounted.container.remove();
    mounted = undefined;
  }
  vi.restoreAllMocks();
});

async function renderAppAt(path: string, standort: { pfad: string }): Promise<HTMLDivElement> {
  function Standort() {
    standort.pfad = useLocation().pathname;
    return null;
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  let root!: Root;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <MemoryRouter initialEntries={[path]}>
        <Standort />
        <AuthProvider>
          <AppProvider initialSetup={completeSetup}>
            <App />
          </AppProvider>
        </AuthProvider>
      </MemoryRouter>,
    );
    await Promise.resolve();
  });
  for (let attempt = 0; attempt < 30 && container.querySelector('[data-testid="auth-loading"]'); attempt += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
  mounted = { container, root };
  return container;
}

describe('S7 — Einstieg, Adresse und kanonische Wege', () => {
  it('A/D — „Mehr" führt keinen Mailimport mehr, die Nachrichten bleiben', () => {
    const ziele = [...PRIMARY_NAV, ...SECONDARY_NAV_GROUPS.flatMap((group) => group.items)];
    expect(ziele.some((item) => item.to === '/mail-import')).toBe(false);
    expect(ziele.some((item) => String(item.key).includes('mailImport'))).toBe(false);
    expect(ziele.some((item) => item.to === '/kommunikation')).toBe(true);

    const html = renderToStaticMarkup(
      <MemoryRouter>
        <AuthProvider>
          <AppProvider initialSetup={DEFAULT_SETUP}>
            <MehrPage />
          </AppProvider>
        </AuthProvider>
      </MemoryRouter>,
    );
    expect(html).not.toContain('/mail-import');
    expect(html).not.toContain('E-Mails importieren');
    expect(html).toContain('href="/kommunikation"');
  });

  it('B/D — die alte Adresse /mail-import landet bei den Nachrichten, ohne altes Formular', async () => {
    await seedDefaultAdminUser();
    await loginAsDefaultAdmin();
    const standort = { pfad: '' };
    const container = await renderAppAt('/mail-import', standort);
    expect(standort.pfad).toBe('/kommunikation');
    expect(container.querySelector('[data-testid="kommunikation-page"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="mail-import-page"]')).toBeNull();
    expect(container.querySelector('[data-testid="mail-import-form"]')).toBeNull();
  });

  it('C — der normale Eingang mit dem Upload-Einstieg bleibt erreichbar', async () => {
    expect(PRIMARY_NAV.some((item) => item.to === '/ablage')).toBe(true);
    await seedDefaultAdminUser();
    await loginAsDefaultAdmin();
    const standort = { pfad: '' };
    const container = await renderAppAt('/ablage', standort);
    expect(standort.pfad).toBe('/ablage');
    const upload = container.querySelector('[data-testid="ablage-add-document"]');
    expect(upload?.getAttribute('href')).toBe('/dokumente/hinzufuegen');
  });

  it('E — kein Produktweg erzeugt mehr einen Mailimport: keine Schreibfunktionen, keine Seite', () => {
    expect(Object.keys(mailImportService).sort()).toEqual(['getMailImportSnapshot', 'hydrateMailImports', 'resetMailImports']);
    const seiten = Object.keys(import.meta.glob('./pages/*.tsx'));
    expect(seiten).not.toContain('./pages/MailImportPage.tsx');
  });
});

describe('S7 — Altbestand bleibt lesbar, ist aber keine Geschäftswahrheit mehr', () => {
  it('F/I — ein lokaler Altbestand wird geladen und mit unverändertem Inhalt gespeichert; kein Sendeauftrag entsteht', () => {
    const userId = 'user-s7';
    bootstrapBusinessState({ userId, workspaceId: 'ws-s7' });
    hydrateMailImports([altbestand()]);
    persistAll();
    expect(getSyncOutboxSnapshot().filter((entry) => entry.entityType === 'mail_import')).toHaveLength(0);

    clearInMemoryBusinessState();
    expect(getMailImportSnapshot()).toHaveLength(0);
    bootstrapBusinessState({ userId, workspaceId: 'ws-s7' });
    const geladen = getMailImportSnapshot();
    expect(geladen).toHaveLength(1);
    expect(geladen[0]).toMatchObject(altbestand());
    // Nur die bestehende lokale Lade-Migration ergänzt Metadaten — Version 0, nichts gesendet.
    expect(Object.keys(geladen[0]!).filter((key) => !(key in altbestand()))).toEqual(['sync']);
    expect(geladen[0]!.sync?.version).toBe(0);

    persistAll();
    const gespeichert = JSON.parse(localStorage.getItem(buildStorageKey({ type: 'workspace', workspaceId: 'ws-s7' })) ?? '{}');
    expect(gespeichert.mailImports).toHaveLength(1);
    expect(gespeichert.mailImports[0]).toMatchObject(altbestand());
    expect(getSyncOutboxSnapshot().filter((entry) => entry.entityType === 'mail_import')).toHaveLength(0);
  });

  it('I — mail_import ist nicht freigegeben, bleibt nur-lokal und wird nicht verfolgt', () => {
    expect(isSupabaseSyncAllowed('mail_import')).toBe(false);
    expect(LOCAL_ONLY_SYNC_ENTITY_TYPES.has('mail_import')).toBe(true);
    expect(TRACKED_SYNC_ENTITY_TYPES).not.toContain('mail_import');
  });

  it('G — ein Backup mit Mailimporten bleibt gültig und bringt den Altbestand bei der Wiederherstellung zurück', async () => {
    hydrateMailImports([altbestand()]);
    const built = await buildLocalBackupBundle(new Date(2026, 9, 7, 12, 0));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.artifacts.manifest.recordCounts.mailImports).toBe(1);
    const validated = await validateLocalBackupZip(built.artifacts.zipBlob);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(validated.preview.recordCounts.mailImports).toBe(1);

    hydrateMailImports([]);
    const restored = await restoreLocalBackupBundle({ validated, confirmed: true, reload: false });
    expect(restored.ok).toBe(true);
    expect(getMailImportSnapshot()).toEqual([altbestand()]);
    expect(getSyncOutboxSnapshot().filter((entry) => entry.entityType === 'mail_import')).toHaveLength(0);
  });

  it('H — ein neues Backup ohne Altbestand bleibt gültig und weist 0 Mailimporte aus', async () => {
    hydrateMailImports([]);
    const built = await buildLocalBackupBundle(new Date(2026, 9, 7, 12, 5));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.artifacts.manifest.recordCounts.mailImports).toBe(0);
    const validated = await validateLocalBackupZip(built.artifacts.zipBlob);
    expect(validated.ok).toBe(true);
  });

  it('M — ein (alter) Mailbezug im Kommunikationskontext liest keinen Altbestand; der URL-Parser kennt ihn nicht', () => {
    hydrateMailImports([altbestand()]);
    const kontext = buildCommunicationContext({ type: 'mail', id: 'mail-legacy-s7' } as unknown as CommunicationContextRef);
    expect(kontext.facts.some((fact) => fact.key.startsWith('mail:'))).toBe(false);
    expect(kontext.recognizedText ?? '').not.toContain('früheren manuellen Mailimport');
    expect(kontext.subject).toBeUndefined();
    expect(parseContextRefFromSearchParams(new URLSearchParams('context=mail&id=mail-legacy-s7'))).toEqual({ type: 'none' });
  });

  it('N — ein Ereignis am alten Mailbezug verändert den Lebenszyklus nicht; am Eingang wirkt es weiterhin', () => {
    hydrateMailImports([altbestand()]);
    hydrateInboxStore([
      createAuftragInboxItem({ id: 'inbox-legacy-s7', title: 'S7 Altbestand Beitragsbescheid', mailImportId: 'mail-legacy-s7', importSource: 'email' }),
    ]);
    setCommunicationHistoryStoreForTests([]);
    const ohneEreignis = resolveDocumentLifecycle({ inboxId: 'inbox-legacy-s7' }, '2026-10-07');

    const altesEreignis: CommunicationEvent = {
      id: 'comm-evt-legacy-s7',
      timestamp: NOW,
      type: 'marked_remind_later',
      contextRef: { type: 'mail', id: 'mail-legacy-s7' } as unknown as CommunicationContextRef,
      status: 'complete',
      disclaimerShown: true,
    };
    setCommunicationHistoryStoreForTests([altesEreignis]);
    const mitAltemEreignis = resolveDocumentLifecycle({ inboxId: 'inbox-legacy-s7' }, '2026-10-07');

    expect(ohneEreignis).not.toBeNull();
    expect(ohneEreignis!.openReasons).not.toContain('reply_open');
    expect(mitAltemEreignis).toEqual(ohneEreignis);

    // Gegenprobe: dasselbe Ereignis am kanonischen Eingangsbezug wird weiterhin gelesen.
    setCommunicationHistoryStoreForTests([{ ...altesEreignis, contextRef: { type: 'inbox', id: 'inbox-legacy-s7' } }]);
    const amEingang = resolveDocumentLifecycle({ inboxId: 'inbox-legacy-s7' }, '2026-10-07');
    expect(amEingang!.openReasons).toContain('reply_open');
    expect(amEingang!.openItems).toContain('Antwort offen');
  });
});
