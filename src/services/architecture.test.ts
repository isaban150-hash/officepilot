import vorgangSource from './vorgangService.ts?raw';
import inboxSource from './inboxService.ts?raw';
import linkSource from './inboxVorgangLinkService.ts?raw';
import { describe, expect, it, beforeEach } from 'vitest';
import { getInboxItemById, hydrateInboxStore } from './inboxService';
import { setInboxVorgangLink } from './inboxVorgangLinkService';
import { hydrateVorgangStore } from './vorgangService';
import { MOCK_INBOX_ITEMS } from '../data/inboxMockData';

describe('service import boundaries', () => {
  it('vorgangService importiert inboxService nicht direkt', () => {
    expect(vorgangSource).not.toMatch(/from '\.\/inboxService'/);
    expect(vorgangSource).toMatch(/from '\.\/inboxVorgangLinkService'/);
  });

  it('inboxService importiert vorgangService nicht', () => {
    expect(inboxSource).not.toMatch(/from '\.\/vorgangService'/);
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
