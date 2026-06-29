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

describe('service import boundaries', () => {
  it('vorgangService importiert inboxService nicht direkt', () => {
    expect(vorgangSource).not.toMatch(/from '\.\/inboxService'/);
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
