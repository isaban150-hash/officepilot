/**
 * P1 EINGANGSSCHREIBEN Phase 1 — der sichtbare Antwortblock auf den Detailseiten.
 *
 * Eingangsdetail:
 *  —  „Antwort erforderlich bis …" mit Grund und Empfänger direkt unter der Karte
 *  I  „Antwort vorbereiten" ohne belastbare Adresse → Briefeditor mit Vorbelegung (Quelle)
 *  M  mit bestätigter Kundenadresse → Auswahl Brief/E-Mail; E-Mail mit Quelle in den Editor
 *  Q  „Keine Antwort nötig" schliesst den Block (Ereignis am Eingang)
 *  —  beantwortet: nachvollziehbarer Zustand statt „Antwort offen"
 *  G  die Hauptaktion „Passendem Vorgang zuordnen" öffnet den bestehenden Dialog,
 *     obwohl der Technik-Abschnitt mit der Karte eingeklappt ist; der dafür immer
 *     montierte Dialog übersteht Verknüpfen und Lösen eines Schreibens (Befund der App-Abnahme)
 * Dokumentdetail:
 *  —  der Antwortblock ist die eine Hauptaktion (DOC-WF-02B), testid bleibt
 *     `document-detail-reply-action`; „Keine Antwort nötig" schliesst
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider } from '../context/AppContext';
import { DEFAULT_SETUP } from '../data/mockData';
import { EingangDetailPage } from './EingangDetailPage';
import { DokumentDetailPage } from './DokumentDetailPage';
import { InboxVorgangPanel } from '../components/inbox/InboxVorgangPanel';
import { createAuftragInboxItem } from '../test/fixtures';
import { resetTestStores } from '../test/resetStores';
import { importInboxDocumentForTests } from '../test/confirmFilingDecisionForTests';
import { hydrateInboxStore } from '../services/inboxService';
import { hydrateDocumentWorkResultStore } from '../services/documentWorkResultStoreService';
import { hydrateCustomerStore } from '../services/customerStoreService';
import { hydrateVorgangStore } from '../services/vorgangService';
import { hydrateCompanyProfileStore } from '../services/companyProfileService';
import { setCommunicationHistoryStoreForTests } from '../services/communicationHistoryStore';
import { getCommunicationEvents, recordMarkedAnswered } from '../services/communicationHistoryService';
import { resetDeferredWorkflowAnalysisCacheForTests } from '../services/inboxWorkflowAnalysisKey';
import { DEFAULT_COMPANY_PROFILE } from '../data/companyProfileDefaults';
import type { BusinessInterpretationResult } from '../types/businessInterpretation';
import type { Customer, InboxItem, Vorgang } from '../types/models';

let root: Root | undefined;
let host: HTMLDivElement | undefined;
let lastLocation: { path: string; state: unknown } = { path: '', state: null };

function Probe() {
  const location = useLocation();
  lastLocation = { path: `${location.pathname}${location.search}`, state: location.state };
  return <p data-testid="probe">{location.pathname}</p>;
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

async function mount(path: string): Promise<void> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[path]}>
        <AppProvider initialSetup={{ ...DEFAULT_SETUP, setupComplete: true }}>
          <Routes>
            <Route path="/ablage/:id" element={<EingangDetailPage />} />
            <Route path="/dokumente/:id" element={<DokumentDetailPage />} />
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

function brief(id: string, overrides: Partial<InboxItem> = {}): InboxItem {
  return createAuftragInboxItem({
    id,
    title: 'Anhörung Bauvorhaben',
    documentType: 'brief',
    classifiedKind: 'brief',
    sender: 'Bauamt Musterstadt',
    recognizedData: { Datum: '05.10.2026', Betreff: 'Anhörung zum Bauvorhaben' },
    deadline: '2026-10-20',
    deadlineType: 'response_due',
    ...overrides,
  });
}

beforeEach(() => {
  resetTestStores();
  resetDeferredWorkflowAnalysisCacheForTests();
  setCommunicationHistoryStoreForTests([]);
  hydrateCompanyProfileStore({ ...DEFAULT_COMPANY_PROFILE, companyName: 'Eigene Firma GmbH', legalForm: 'GmbH' });
  hydrateCustomerStore([
    { id: 'c-ui', name: 'Bauherr UI GmbH', street: 'Weg 2', zip: '33602', city: 'Bielefeld', email: 'post@bauherr-ui.invalid', createdAt: '2026-09-01T00:00:00.000Z' } as Customer,
  ]);
  hydrateVorgangStore([
    { id: 'v-ui', title: 'Neubau UI', customer: 'Bauherr UI GmbH', customerId: 'c-ui', baustelle: '', status: 'aktiv', documents: [], tasks: [], photos: [], createdAt: '2026-09-01', updatedAt: '2026-09-01' } as unknown as Vorgang,
  ]);
  lastLocation = { path: '', state: null };
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  root = undefined;
  host = undefined;
  resetTestStores();
});

describe('P1 — Antwortblock im Eingangsdetail', () => {
  it('zeigt „Antwort erforderlich bis …" mit Grund, Empfänger und den beiden Aktionen', async () => {
    hydrateInboxStore([brief('in-ui')]);
    hydrateDocumentWorkResultStore([antwortFrist('in-ui')]);
    await mount('/ablage/in-ui');
    expect(q('document-reply-need-title')?.textContent).toBe('Antwort erforderlich bis 20.10.2026');
    expect(q('document-reply-need-reason')?.textContent).toContain('Antwort');
    expect(q('document-reply-need-recipient')?.textContent).toContain('Bauamt Musterstadt');
    expect(q('document-reply-need-prepare')).not.toBeNull();
    expect(q('document-reply-need-no-reply')?.textContent).toBe('Keine Antwort nötig');
    // keine rohen internen Werte
    expect(q('document-reply-need')?.textContent ?? '').not.toMatch(/response_due|inbox:|in-ui/);
  });

  it('I — ohne belastbare Adresse führt „Antwort vorbereiten" direkt in den Briefeditor (mit Quelle)', async () => {
    hydrateInboxStore([brief('in-brief')]);
    hydrateDocumentWorkResultStore([antwortFrist('in-brief')]);
    await mount('/ablage/in-brief');
    await click(q('document-reply-need-prepare'));
    expect(lastLocation.path).toBe('/schreiben/neu');
    const prefill = (lastLocation.state as { officetaktLetterDraftPrefill: Record<string, unknown> }).officetaktLetterDraftPrefill;
    expect(prefill.replyTo).toEqual({ type: 'inbox', id: 'in-brief' });
    expect(prefill.subject).toBe('Ihr Schreiben vom 05.10.2026 – Anhörung zum Bauvorhaben');
    expect(prefill.customerId).toBeUndefined();
  });

  it('M — mit bestätigter Kundenadresse: Auswahl Brief/E-Mail; die E-Mail nimmt die Quelle mit', async () => {
    hydrateInboxStore([brief('in-mail', { sender: 'Bauherr UI GmbH', vorgangId: 'v-ui', vorgangLinkStatus: 'linked' })]);
    hydrateDocumentWorkResultStore([antwortFrist('in-mail')]);
    await mount('/ablage/in-mail');
    expect(q('document-reply-need-recipient')?.textContent).toContain('Kunde aus dem Vorgang');
    await click(q('document-reply-need-prepare'));
    expect(q('document-reply-need-letter')).not.toBeNull();
    await click(q('document-reply-need-email'));
    expect(lastLocation.path).toBe(`/kommunikation/email/neu?quelle=${encodeURIComponent('inbox:in-mail')}`);
  });

  it('Q — „Keine Antwort nötig" hält die Entscheidung am Eingang fest und schliesst den Block', async () => {
    hydrateInboxStore([brief('in-keine')]);
    hydrateDocumentWorkResultStore([antwortFrist('in-keine')]);
    await mount('/ablage/in-keine');
    await click(q('document-reply-need-no-reply'));
    const [event] = getCommunicationEvents();
    expect(event?.type).toBe('marked_no_reply_needed');
    expect(event?.contextRef).toEqual({ type: 'inbox', id: 'in-keine' });
    expect(q('document-reply-need')).toBeNull();
  });

  it('beantwortet: kein „Antwort erforderlich", sondern ein nachvollziehbarer beantworteter Zustand', async () => {
    hydrateInboxStore([brief('in-done')]);
    hydrateDocumentWorkResultStore([antwortFrist('in-done')]);
    recordMarkedAnswered({ type: 'inbox', id: 'in-done' }, undefined, {
      channel: 'letter',
      answerRef: { kind: 'letter', id: 'letter-done' },
    });
    await mount('/ablage/in-done');
    expect(q('document-reply-need')).toBeNull();
    expect(q('document-reply-need-answered')?.textContent).toContain('Beantwortet');
    expect(q('document-reply-need-answered')?.textContent).toContain('per Brief');
    expect(q('document-reply-need-answer-link')?.getAttribute('href')).toBe('/schreiben/letter-done');
  });

  it('G — „Passendem Vorgang zuordnen" öffnet den bestehenden Dialog, obwohl der Technik-Abschnitt eingeklappt ist', async () => {
    hydrateInboxStore([
      createAuftragInboxItem({
        id: 'in-mahnung',
        title: 'Rechnung Lieferant',
        documentType: 'rechnung',
        classifiedKind: 'eingangsrechnung',
        sender: 'Lieferant GmbH',
        recognizedData: { Rechnungsnummer: 'R-77', Betrag: '119,00 EUR', Betreff: 'Eigene Firma GmbH' },
        deadline: '2026-10-20',
        deadlineType: 'payment_due',
      }),
    ]);
    await mount('/ablage/in-mahnung');
    const action = q('document-experience-secondary-link_vorgang');
    expect(action).not.toBeNull();
    expect(q('review-section-content-technical')).toBeNull();
    expect(host!.querySelector('.vorgang-dialog-backdrop')).toBeNull();
    await click(action);
    expect(host!.querySelector('.vorgang-dialog-backdrop')).not.toBeNull();
    // Der Technik-Abschnitt musste dafür nicht aufgeklappt werden.
    expect(q('review-section-content-technical')).toBeNull();
  });

  it('G — die angebotene Zuordnung wirkt auch, wenn die Live-Prüfung keine Firmenrelevanz findet (Befund der App-Abnahme)', async () => {
    hydrateInboxStore([
      createAuftragInboxItem({
        id: 'in-rechnung-fremd',
        title: 'Rechnung Lieferant',
        documentType: 'rechnung',
        classifiedKind: 'eingangsrechnung',
        sender: 'Lieferant GmbH',
        recognizedData: { Rechnungsnummer: 'R-78', Betrag: '119,00 EUR' },
        deadline: '2026-10-20',
        deadlineType: 'payment_due',
      }),
    ]);
    await mount('/ablage/in-rechnung-fremd');
    const action = q('document-experience-secondary-link_vorgang');
    expect(action).not.toBeNull();
    expect(host!.querySelector('.vorgang-dialog-backdrop')).toBeNull();
    await click(action);
    expect(host!.querySelector('.vorgang-dialog-backdrop')).not.toBeNull();
  });
});

describe('P1 — G: der Zuordnungsdialog auf Seitenebene übersteht den Moduswechsel', () => {
  it('Verknüpfen und Lösen eines Schreibens (Modus „none" ↔ „open") ohne Hook-Fehler; im Modus „none" kein Dialog', async () => {
    const fehler = vi.spyOn(console, 'error').mockImplementation(() => {});
    const offen = brief('in-modus', { recommendedAction: 'abheften' });
    const verknuepft = { ...offen, vorgangId: 'v-ui', vorgangLinkStatus: 'linked' } as InboxItem;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    const zeige = async (item: InboxItem, anforderung: number) => {
      await act(async () => {
        root!.render(
          <MemoryRouter>
            <AppProvider initialSetup={{ ...DEFAULT_SETUP, setupComplete: true }}>
              <InboxVorgangPanel item={item} materialDefault="betrieb" onLinked={() => {}} requestOpenDialog={anforderung} dialogOnly />
            </AppProvider>
          </MemoryRouter>,
        );
      });
      await settle();
    };
    await zeige(offen, 0);
    await zeige(offen, 1);
    expect(host.querySelector('.vorgang-dialog-backdrop')).toBeNull();
    await zeige(verknuepft, 1);
    await zeige(offen, 1);
    const hookFehler = fehler.mock.calls.filter((args) => args.some((a) => /order of Hooks|more hooks|fewer hooks/i.test(String(a))));
    fehler.mockRestore();
    expect(hookFehler).toEqual([]);
  });
});

describe('P1 — U: 390 px', () => {
  it('die Aktionen des Antwortblocks stapeln sich auf schmalen Bildschirmen über die volle Breite', () => {
    const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');
    const mobil = css.slice(css.lastIndexOf('@media (max-width: 480px)'));
    expect(mobil).toContain('.document-reply-need__actions > *');
    expect(mobil).toContain('flex: 1 1 100%;');
    expect(css.slice(css.indexOf('.document-reply-need__actions {'))).toContain('flex-wrap: wrap;');
  });
});

describe('P1 — Antwortblock im Dokumentdetail', () => {
  function archivieren(id: string): string {
    const result = importInboxDocumentForTests(brief(id), 'Eigene Firma GmbH');
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('Import fehlgeschlagen');
    hydrateDocumentWorkResultStore([antwortFrist(id)]);
    return result.document.id;
  }

  it('der Antwortblock ist die eine Hauptaktion; „Keine Antwort nötig" schliesst', async () => {
    const documentId = archivieren('in-doc');
    await mount(`/dokumente/${documentId}`);
    const experience = q('document-detail-experience');
    const primaries = Array.from(experience?.querySelectorAll('button.btn--primary') ?? []);
    expect(primaries).toHaveLength(1);
    expect(primaries[0]?.getAttribute('data-testid')).toBe('document-detail-reply-action');
    expect(primaries[0]?.textContent).toBe('Antwort vorbereiten');
    expect(q('document-reply-need-title')?.textContent).toBe('Antwort erforderlich bis 20.10.2026');

    await click(q('document-reply-need-no-reply'));
    const [event] = getCommunicationEvents();
    expect(event?.contextRef).toEqual({ type: 'document', id: documentId });
    expect(q('document-detail-reply-action')).toBeNull();
  });
});
