/**
 * P1 EINGANGSSCHREIBEN Phase 1 — der Briefweg der Antwort.
 *
 *  I  der bestehende Briefeditor übernimmt Quelle, Empfänger und Betreff; die Herkunft ist sichtbar
 *  J  ein gespeicherter Entwurf lässt die Antwort offen
 *  K  Fertigstellen + ausdrückliche Bestätigung → „beantwortet" am Eingangsschreiben
 *     (Kanal Brief, Nachweis auf den Brief)
 *  L  lehnt der Benutzer die Erfassung ab, bleibt die Antwort offen
 *  S  erneutes Speichern verliert die Herkunft nicht; das Briefdetail zeigt sie
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider } from '../context/AppContext';
import { DEFAULT_SETUP } from '../data/mockData';
import { DEFAULT_COMPANY_PROFILE } from '../data/companyProfileDefaults';
import { BriefEditorPage } from './BriefEditorPage';
import { BriefDetailPage } from './BriefDetailPage';
import { createAuftragInboxItem } from '../test/fixtures';
import { resetTestStores } from '../test/resetStores';
import * as persistence from '../services/persistenceService';
import { hydrateCompanyProfileStore } from '../services/companyProfileService';
import { hydrateInboxStore } from '../services/inboxService';
import { hydrateDocumentWorkResultStore } from '../services/documentWorkResultStoreService';
import { setCommunicationHistoryStoreForTests } from '../services/communicationHistoryStore';
import { getCommunicationEvents } from '../services/communicationHistoryService';
import { listBusinessLetters as getBusinessLetters } from '../services/businessLetterService';
import { resolveDocumentReplyNeed } from '../services/documentReplyNeedService';
import { resolveDocumentReplySource, buildReplyLetterPrefill } from '../services/document/documentReplySourceService';
import type { BusinessInterpretationResult } from '../types/businessInterpretation';

const WS = '00000000-0000-4000-8000-0000000p1b01';

let root: Root | undefined;
let host: HTMLDivElement | undefined;
let lastPath = '';

function Probe() {
  const location = useLocation();
  lastPath = location.pathname;
  return <p data-testid="probe">{location.pathname}</p>;
}

const q = (id: string) => host!.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const anywhere = (id: string) => document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}
async function click(element: Element | null): Promise<void> {
  expect(element).not.toBeNull();
  await act(async () => { (element as HTMLElement).click(); });
  await settle();
}
async function type(id: string, text: string): Promise<void> {
  const el = q(id) as HTMLTextAreaElement | HTMLInputElement;
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await settle();
}

async function mount(entry: string | { pathname: string; state?: unknown }): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[entry]}>
        <AppProvider initialSetup={{ ...DEFAULT_SETUP, setupComplete: true }}>
          <Routes>
            <Route path="/schreiben/neu" element={<BriefEditorPage />} />
            <Route path="/schreiben/:letterId/bearbeiten" element={<BriefEditorPage />} />
            <Route path="/schreiben/:letterId" element={<Probe />} />
            <Route path="/briefdetail/:letterId" element={<BriefDetailPage />} />
            <Route path="*" element={<Probe />} />
          </Routes>
        </AppProvider>
      </MemoryRouter>,
    );
  });
  await settle();
}

function antwortFrist(inboxItemId: string) {
  return {
    schemaVersion: 1 as const,
    inboxItemId,
    analyzedAt: '2026-10-07T09:00:00.000Z',
    analysisVersion: 'p1-test',
    sourceFingerprint: `fp-${inboxItemId}`,
    businessInterpretation: {
      operational: { primaryCase: 'communication_information', meanings: [], nextStep: '', confirmRequirement: '', certainty: 'detected' },
      semantic: {
        deadlines: [{ date: '2026-10-20', type: 'response_due', appliesTo: 'Antwort', actionRequired: true, certainty: 'detected' }],
        subject: { value: 'Anhörung zum Bauvorhaben' },
      },
    } as unknown as BusinessInterpretationResult,
    specialistRefs: { hasContractIntelligence: false, hasContractOrderProposal: false, hasClassification: true, hasDocumentUnderstanding: true, companyRelevant: true },
    overlay: [],
  };
}

function vorbelegung() {
  const quelle = resolveDocumentReplySource({ type: 'inbox', id: 'in-brief' });
  expect(quelle).not.toBeNull();
  return buildReplyLetterPrefill(quelle!);
}

beforeEach(() => {
  resetTestStores();
  setCommunicationHistoryStoreForTests([]);
  hydrateCompanyProfileStore({ ...DEFAULT_COMPANY_PROFILE, companyName: 'Eigene Firma GmbH', legalForm: 'GmbH', street: 'Hof 1', zip: '33602', city: 'Bielefeld' });
  vi.spyOn(persistence, 'buildPersistedStateSnapshot').mockReturnValue({ syncClient: { serverWorkspaceId: WS } } as never);
  hydrateInboxStore([
    createAuftragInboxItem({
      id: 'in-brief',
      title: 'Anhörung Bauvorhaben',
      documentType: 'brief',
      classifiedKind: 'brief',
      sender: 'Bauamt Musterstadt',
      recognizedData: { Datum: '05.10.2026' },
      deadline: '2026-10-20',
      deadlineType: 'response_due',
    }),
  ]);
  hydrateDocumentWorkResultStore([antwortFrist('in-brief')]);
  lastPath = '';
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
  vi.restoreAllMocks();
  resetTestStores();
});

const neuerAntwortbrief = () => ({ pathname: '/schreiben/neu', state: { officetaktLetterDraftPrefill: vorbelegung() } });

describe('P1 — Briefweg der Antwort', () => {
  it('I — Quelle, Empfänger und Betreff sind übernommen; die Herkunft ist sichtbar', async () => {
    await mount(neuerAntwortbrief());
    expect(q('letter-reply-to')?.textContent).toContain('Anhörung Bauvorhaben');
    expect((q('letter-subject') as HTMLInputElement).value).toBe('Ihr Schreiben vom 05.10.2026 – Anhörung zum Bauvorhaben');
    expect((q('letter-kind-free') as HTMLInputElement).checked).toBe(true);
    expect((q('letter-recipient-company') as HTMLInputElement).value).toBe('Bauamt Musterstadt');
  });

  it('J — ein gespeicherter Entwurf lässt die Antwort offen', async () => {
    await mount(neuerAntwortbrief());
    await type('letter-body', 'Sehr geehrte Damen und Herren, wir nehmen wie folgt Stellung.');
    await click(q('letter-save'));
    const [brief] = getBusinessLetters();
    expect(brief?.status).toBe('draft');
    expect(brief?.replyTo).toEqual({ type: 'inbox', id: 'in-brief' });
    expect(lastPath).toBe(`/schreiben/${brief!.id}`);
    expect(getCommunicationEvents()).toHaveLength(0);
    expect(resolveDocumentReplyNeed({ inboxId: 'in-brief' }).state).toBe('open');
  });

  it('K — Fertigstellen und ausdrücklich bestätigen erfasst „beantwortet" mit Nachweis auf den Brief', async () => {
    await mount(neuerAntwortbrief());
    await type('letter-body', 'Sehr geehrte Damen und Herren, wir nehmen wie folgt Stellung.');
    await click(q('letter-finalize'));
    expect(anywhere('letter-reply-answered-dialog')).not.toBeNull();
    // vor der Bestätigung ist nichts erfasst
    expect(getCommunicationEvents()).toHaveLength(0);
    await click(anywhere('letter-reply-answered-confirm'));

    const [brief] = getBusinessLetters();
    expect(brief?.status).toBe('finalized');
    const [event] = getCommunicationEvents();
    expect(event?.type).toBe('marked_answered');
    expect(event?.contextRef).toEqual({ type: 'inbox', id: 'in-brief' });
    expect(event?.channel).toBe('letter');
    expect(event?.answerRef).toEqual({ kind: 'letter', id: brief!.id });
    expect(resolveDocumentReplyNeed({ inboxId: 'in-brief' }).state).toBe('answered');
    expect(lastPath).toBe(`/schreiben/${brief!.id}`);
  });

  it('L — lehnt der Benutzer die Erfassung ab, bleibt die Antwort offen', async () => {
    await mount(neuerAntwortbrief());
    await type('letter-body', 'Sehr geehrte Damen und Herren, wir nehmen wie folgt Stellung.');
    await click(q('letter-finalize'));
    await click(anywhere('letter-reply-answered-cancel'));
    const [brief] = getBusinessLetters();
    expect(brief?.status).toBe('finalized');
    expect(getCommunicationEvents()).toHaveLength(0);
    expect(resolveDocumentReplyNeed({ inboxId: 'in-brief' }).state).toBe('open');
    expect(lastPath).toBe(`/schreiben/${brief!.id}`);
  });

  it('S — erneutes Speichern verliert die Herkunft nicht; das Briefdetail zeigt sie', async () => {
    await mount(neuerAntwortbrief());
    await type('letter-body', 'Erster Stand.');
    await click(q('letter-save'));
    const [brief] = getBusinessLetters();
    await act(async () => root!.unmount());
    host!.remove();

    await mount(`/schreiben/${brief!.id}/bearbeiten`);
    expect(q('letter-reply-to')).not.toBeNull();
    await type('letter-subject', 'Ihr Schreiben vom 05.10.2026 – geänderter Betreff');
    await click(q('letter-save'));
    expect(getBusinessLetters()[0]?.replyTo).toEqual({ type: 'inbox', id: 'in-brief' });
    expect(getBusinessLetters()[0]?.subject).toBe('Ihr Schreiben vom 05.10.2026 – geänderter Betreff');
    await act(async () => root!.unmount());
    host!.remove();

    await mount(`/briefdetail/${brief!.id}`);
    const link = q('letter-detail-reply-to')?.querySelector('a');
    expect(link?.getAttribute('href')).toBe('/ablage/in-brief');
    expect(link?.textContent).toBe('Anhörung Bauvorhaben');
  });
});
