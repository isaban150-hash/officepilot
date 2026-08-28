/**
 * OFFICEPILOT-INVOICE-CREATE-ROUTE-TYPE-01 — der Einstieg aus der Ablage.
 *
 * `InboxVorgangPanel` bot „Rechnung vorbereiten" bislang ohne `?type=` an. Der
 * Parser-Fallback machte daraus `rechnung`, was zum Label passte — der Link
 * verliess sich damit aber auf eine Zufälligkeit, statt den Typ auszusprechen.
 * Dieser Einstieg war von keinem Test gedeckt.
 *
 * Ohne JSX geschrieben, damit der Fall in der vom Auftrag vorgesehenen
 * `.ts`-Datei liegen kann.
 *
 * Neutrale Beispieldaten.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppProvider } from '../context/AppContext';
import { InboxVorgangPanel } from '../components/inbox/InboxVorgangPanel';
import { DEFAULT_SETUP } from '../data/mockData';
import { getInboxItemById, hydrateInboxStore } from './inboxService';
import { hydrateVorgangStore } from './vorgangService';
import { createAuftragInboxItem, createOrderPosition, createTestVorgang } from '../test/fixtures';
import { resetTestStores } from '../test/resetStores';

const VORGANG_ID = 'v-inbox-create';

describe('OFFICEPILOT-INVOICE-CREATE-ROUTE-TYPE-01 — InboxVorgangPanel', () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    resetTestStores();
    container = document.createElement('div');
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (root) {
      act(() => root!.unmount());
      root = null;
    }
    container.remove();
    resetTestStores();
  });

  it('„Rechnung vorbereiten" verlinkt ausdrücklich auf den Rechnungstyp', () => {
    hydrateVorgangStore([
      createTestVorgang({
        id: VORGANG_ID,
        title: 'Beispielauftrag',
        orderPositions: [createOrderPosition({ id: 'op-inbox-1' })],
      }),
    ]);
    const seeded = createAuftragInboxItem({ id: 'inbox-create-01' });
    seeded.vorgangId = VORGANG_ID;
    seeded.vorgangTitle = 'Beispielauftrag';
    // Erst der Verknüpfungsstatus bringt das Panel in den `open`-Modus.
    seeded.vorgangLinkStatus = 'linked';
    hydrateInboxStore([seeded]);
    const item = getInboxItemById(seeded.id)!;

    root = createRoot(container);
    act(() => {
      root!.render(
        createElement(
          MemoryRouter,
          null,
          createElement(
            AppProvider,
            { initialSetup: { ...DEFAULT_SETUP, setupComplete: true } },
            createElement(InboxVorgangPanel, {
              item,
              materialDefault: 'betrieb' as const,
              onLinked: () => {},
            }),
          ),
        ),
      );
    });

    const hrefs = Array.from(container.querySelectorAll('a')).map((a) => a.getAttribute('href'));
    expect(hrefs).toContain(`/vorgaenge/${VORGANG_ID}/rechnung?type=rechnung`);
  });
});
