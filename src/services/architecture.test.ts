import taskEngineSource from './taskEngineService.ts?raw';
import documentClassificationSource from './documentClassificationService.ts?raw';
import vorgangSource from './vorgangService.ts?raw';
import invoiceSource from './invoiceService.ts?raw';
import inboxSource from './inboxService.ts?raw';
import inboxTaskSource from './inboxTaskService.ts?raw';
import linkSource from './inboxVorgangLinkService.ts?raw';
import { describe, expect, it, beforeEach } from 'vitest';
import { getInboxItemById, hydrateInboxStore } from './inboxService';
import { setInboxVorgangLink } from './inboxVorgangLinkService';
import { hydrateVorgangStore } from './vorgangService';
import { getAllTasks, getTodayTasks } from './taskService';
import { MOCK_INBOX_ITEMS } from '../data/inboxMockData';

/**
 * Die Namen eines Named-Import-Blocks — `type`-Importe und Aliasse aufgelöst.
 *
 * Mehrere Blöcke aus demselben Modul werden zusammengefasst. Ein Default- oder
 * Namespace-Import (`import * as x`) trägt keine Klammern und taucht hier
 * deshalb nicht auf; darauf prüft die Regel unten gesondert.
 */
function namedImportsFrom(source: string, moduleSpecifier: string): string[] {
  const escaped = moduleSpecifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const blocks = source.matchAll(new RegExp(String.raw`import\s*\{([^}]*)\}\s*from\s*'${escaped}'`, 'g'));
  return [...blocks]
    .flatMap((match) => (match[1] ?? '').split(','))
    .map((entry) => entry.replace(/\btype\b/, '').split(/\bas\b/)[0]!.trim())
    .filter(Boolean);
}

/**
 * SERVICE-BOUNDARY-RULE-NARROW-01B — Transaktionsprimitive ja, Fachlogik nein.
 *
 * Hier stand ein pauschales Verbot jedes Imports aus `inboxService`. Es traf
 * damit auch die vier Primitive, mit denen `vorgangService` den atomaren
 * Handoff über Kunde, Vorgang, Inbox und Dokument fährt: lesen, Snapshot,
 * Restore und ein **nicht persistierender** Staged-Patch. Der persistierende
 * Weg (`patchInboxItem`) schreibt sofort und kann an dieser Transaktion nicht
 * teilnehmen — genau deshalb entstand der direkte Import.
 *
 * Die Regel zählt jetzt auf, was erlaubt ist, statt einen Dateinamen zu
 * verbieten. Dadurch ist sie enger als zuvor: Jeder weitere Import aus
 * `inboxService` fällt auf, auch ein heute noch unbekannter.
 */
const VORGANG_INBOX_TRANSACTION_PRIMITIVES = [
  'getInboxItemById',
  'getInboxStoreSnapshot',
  'hydrateInboxStore',
  'stageInboxItemPatch',
];

describe('service import boundaries', () => {
  it('vorgangService importiert aus inboxService nur Transaktionsprimitive', () => {
    const imported = namedImportsFrom(vorgangSource, './inboxService');
    expect(imported.length, 'Kein Named-Import-Block aus inboxService gefunden').toBeGreaterThan(0);

    for (const symbol of imported) {
      expect(
        VORGANG_INBOX_TRANSACTION_PRIMITIVES,
        `Unerlaubter direkter Inbox-Import in vorgangService: ${symbol}`,
      ).toContain(symbol);
    }

    // Der persistierende Weg bleibt ausdrücklich draussen.
    expect(imported).not.toContain('patchInboxItem');

    /*
     * Kein Default- oder Namespace-Import: `import * as inbox` würde die
     * Allowlist umgehen, weil er jedes Symbol mitbringt.
     */
    const allInboxImports = vorgangSource.match(/import[^;]*from '\.\/inboxService'/g) ?? [];
    expect(allInboxImports).toHaveLength(1);
    expect(allInboxImports[0]).toContain('{');

    // Die Vermittlung über den Link-Service bleibt bestehen.
    expect(vorgangSource).toMatch(/from '\.\/inboxVorgangLinkService'/);
  });

  it('inboxService importiert vorgangService und taskEngineService nicht', () => {
    expect(inboxSource).not.toMatch(/from '\.\/vorgangService'/);
    expect(inboxSource).not.toMatch(/from '\.\/taskEngineService'/);
  });

  it('inboxTaskService übernimmt Inbox-Aufgaben ohne Zyklus zu inboxService', () => {
    expect(inboxTaskSource).toMatch(/from '\.\/inboxService'/);
    expect(inboxTaskSource).toMatch(/from '\.\/taskEngineService'/);
    expect(inboxSource).not.toMatch(/from '\.\/inboxTaskService'/);
  });

  it('vorgangService und invoiceService importieren sich nicht gegenseitig', () => {
    expect(vorgangSource).not.toMatch(/from '\.\/invoiceService'/);
    expect(vorgangSource).toMatch(/from '\.\/orderBillingRules'/);
    expect(invoiceSource).toMatch(/from '\.\/vorgangService'/);
    expect(invoiceSource).toMatch(/from '\.\/orderBillingRules'/);
  });

  it('invoiceService nutzt Billing-Regeln aus neutralem Modul', () => {
    expect(invoiceSource).toMatch(/from '\.\/orderBillingRules'/);
  });

  it('taskEngine und documentClassification bilden keinen geschlossenen Zyklus über inbox', () => {
    expect(taskEngineSource).toMatch(/from '\.\/documentClassificationService'/);
    expect(documentClassificationSource).not.toMatch(/from '\.\/taskEngineService'/);
    expect(documentClassificationSource).not.toMatch(/from '\.\/inboxService'/);
    expect(documentClassificationSource).toMatch(/from '\.\/vorgangMatchingService'/);
  });

  it('paperFolderService ersetzt analysisService', async () => {
    const paperFolder = await import('./paperFolderService');
    expect(paperFolder.formatPaperFilingInstruction).toBeTypeOf('function');
    expect(paperFolder.getAllPaperFolders).toBeTypeOf('function');
  });

  it('inboxVorgangLinkService vermittelt die Vorgang-Verknüpfung', () => {
    expect(linkSource).toMatch(/from '\.\/inboxService'/);
    expect(linkSource).toMatch(/setInboxVorgangLink/);
  });
});

describe('inboxVorgangLinkService', () => {
  beforeEach(() => {
    hydrateInboxStore(
      MOCK_INBOX_ITEMS.map((item) => ({
        ...item,
        vorgangId: undefined,
        vorgangTitle: undefined,
        vorgangLinkStatus: undefined,
      })),
    );
    hydrateVorgangStore([]);
  });

  it('verknüpft Inbox-Einträge mit Vorgängen', () => {
    const item = getInboxItemById('inbox-001');
    expect(item).toBeTruthy();

    const linked = setInboxVorgangLink(item!.id, 'v-test', 'Test-Vorgang', 'linked');
    expect(linked?.vorgangId).toBe('v-test');
    expect(linked?.vorgangLinkStatus).toBe('linked');
  });
});

describe('taskService legacy compatibility', () => {
  it('bleibt als Wrapper nutzbar', () => {
    expect(Array.isArray(getAllTasks())).toBe(true);
    expect(Array.isArray(getTodayTasks('2026-06-27'))).toBe(true);
  });
});
