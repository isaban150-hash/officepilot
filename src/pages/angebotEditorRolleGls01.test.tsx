import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider } from '../context/AppContext';
import { DEFAULT_SETUP } from '../data/mockData';
import { t } from '../i18n';
import * as offerFinalize from '../services/offer/offerFinalizeCloudService';
import { alsInhaber, alsMitglied } from '../test/workspaceRoleTestUtils';
import { AngebotEditorPage } from './AngebotEditorPage';

/*
 * GO-LIVE-SECURITY-01 — Produktentscheidung vom 2026-10-09: Mitglieder bereiten
 * Angebote vor und speichern Entwürfe, freigeben (Angebotsnummer vergeben)
 * dürfen nur Inhaber und Admin. Der Editor bietet einem Mitglied deshalb kein
 * „Angebot freigeben" an, sondern einen Hinweis.
 */

let container: HTMLDivElement;
let root: Root | null = null;

function editor(): void {
  root = createRoot(container);
  act(() => {
    root!.render(
      createElement(
        MemoryRouter,
        { initialEntries: ['/angebote/neu'] },
        createElement(
          AppProvider,
          { initialSetup: DEFAULT_SETUP },
          createElement(Routes, null, createElement(Route, { path: '/angebote/neu', element: createElement(AngebotEditorPage) })),
        ),
      ),
    );
  });
}

const el = (id: string) => container.querySelector(`[data-testid="${id}"]`);

beforeEach(() => {
  vi.restoreAllMocks();
  container = document.createElement('div');
  document.body.appendChild(container);
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  container.remove();
});

describe('GO-LIVE-SECURITY-01 — Angebotseditor nach Rolle', () => {
  it('Mitglied: Entwurf speichern ja, „Angebot freigeben" nein, stattdessen der Rollenhinweis', () => {
    alsMitglied();
    const freigabe = vi.spyOn(offerFinalize, 'finalizeOfferWithCloud');
    editor();

    expect(el('offer-save')).not.toBeNull();
    expect(el('offer-finalize')).toBeNull();
    expect(el('offer-finalize-role-hint')?.textContent).toBe(t('offer.finalize.roleHint', 'de'));
    expect(freigabe).not.toHaveBeenCalled();
  });

  it('Inhaber: „Angebot freigeben" wie bisher, kein Rollenhinweis', () => {
    alsInhaber();
    editor();

    expect(el('offer-save')).not.toBeNull();
    expect(el('offer-finalize')).not.toBeNull();
    expect(el('offer-finalize-role-hint')).toBeNull();
  });
});
