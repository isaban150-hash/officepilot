/**
 * P1 EINGANGSSCHREIBEN Phase 1 — Fragefeld „Schreib denen, dass …".
 *
 *  —  E-Mail-Variante: der Kontext des Eingangsschreibens reist in der Adresse mit
 *     (\`/kommunikation?context=inbox&id=…\`). Vorher landete „Als erledigt markieren"
 *     im Kontext „none" und erledigte das Schreiben nie.
 *  —  Brief-Variante: dieselbe Herkunft (replyTo) wie aus dem Antwortblock — keine
 *     zweite Sonderlösung.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppProvider } from '../../context/AppContext';
import { AuthProvider } from '../../context/AuthContext';
import { DEFAULT_SETUP } from '../../data/mockData';
import { DEFAULT_COMPANY_PROFILE } from '../../data/companyProfileDefaults';
import { DocumentFreeQuestionPanel } from './DocumentFreeQuestionPanel';
import { KommunikationPage } from '../../pages/KommunikationPage';
import { createAuftragInboxItem } from '../../test/fixtures';
import { resetTestStores } from '../../test/resetStores';
import { hydrateInboxStore } from '../../services/inboxService';
import { hydrateCompanyProfileStore } from '../../services/companyProfileService';
import { setCommunicationHistoryStoreForTests } from '../../services/communicationHistoryStore';
import { getCommunicationEvents } from '../../services/communicationHistoryService';
import type { InboxItem } from '../../types/models';

let root: Root | undefined;
let host: HTMLDivElement | undefined;
let lastLocation: { path: string; state: unknown } = { path: '', state: null };

function Probe() {
  const location = useLocation();
  lastLocation = { path: `${location.pathname}${location.search}`, state: location.state };
  return <p data-testid="probe">{location.pathname}</p>;
}
function KommunikationMitProbe() {
  const location = useLocation();
  lastLocation = { path: `${location.pathname}${location.search}`, state: location.state };
  return <KommunikationPage />;
}

const q = (id: string) => host!.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
async function click(element: Element | null): Promise<void> {
  expect(element).not.toBeNull();
  await act(async () => { (element as HTMLElement).click(); });
  await settle();
}

const ITEM: InboxItem = createAuftragInboxItem({
  id: 'in-frage',
  title: 'Anfrage Termin',
  documentType: 'brief',
  classifiedKind: 'brief',
  sender: 'Bauherr Frage GmbH',
  recognizedData: { Datum: '05.10.2026', Betreff: 'Terminabstimmung' },
  deadline: null,
});

async function mountAndAsk(text: string): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={['/ablage/in-frage']}>
        <AuthProvider>
          <AppProvider initialSetup={{ ...DEFAULT_SETUP, setupComplete: true }}>
            <Routes>
              <Route
                path="/ablage/:id"
                element={<DocumentFreeQuestionPanel source={{ type: 'inbox', item: ITEM }} testIdPrefix="p1-frage" />}
              />
              <Route path="/kommunikation" element={<KommunikationMitProbe />} />
              <Route path="*" element={<Probe />} />
            </Routes>
          </AppProvider>
        </AuthProvider>
      </MemoryRouter>,
    );
  });
  await settle();
  const input = q('p1-frage-input') as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  await settle();
  expect(q('p1-frage-reply-draft')).not.toBeNull();
}

beforeEach(() => {
  resetTestStores();
  setCommunicationHistoryStoreForTests([]);
  hydrateCompanyProfileStore({ ...DEFAULT_COMPANY_PROFILE, companyName: 'Eigene Firma GmbH', legalForm: 'GmbH' });
  hydrateInboxStore([ITEM]);
  lastLocation = { path: '', state: null };
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
  resetTestStores();
});

describe('P1 — Fragefeld behält den Kontext des Eingangsschreibens', () => {
  it('E-Mail-Variante: Kontext in der Adresse; „Als erledigt markieren" erledigt das Eingangsschreiben', async () => {
    await mountAndAsk('Schreib denen per E-Mail, dass wir am 25.10. kommen');
    await click(q('p1-frage-reply-email'));
    expect(lastLocation.path).toBe('/kommunikation?context=inbox&id=in-frage');

    await click(q('communication-mark-answered'));
    const answered = getCommunicationEvents().filter((event) => event.type === 'marked_answered');
    expect(answered).toHaveLength(1);
    expect(answered[0]?.contextRef).toEqual({ type: 'inbox', id: 'in-frage' });
  });

  it('Brief-Variante: dieselbe Herkunft wie aus dem Antwortblock', async () => {
    await mountAndAsk('Schreib denen einen Brief, dass wir am 25.10. kommen');
    await click(q('p1-frage-reply-letter'));
    expect(lastLocation.path).toBe('/schreiben/neu');
    const prefill = (lastLocation.state as { officetaktLetterDraftPrefill: Record<string, unknown> }).officetaktLetterDraftPrefill;
    expect(prefill.replyTo).toEqual({ type: 'inbox', id: 'in-frage' });
    expect(String(prefill.body)).toContain('25.10.');
  });
});
