/**
 * UIUX-FOUNDATION-01G — Härtung: Confirm-Dialoge, Restflächen, Eingang-Header.
 *
 *  A  Kein window.confirm mehr im Produktivcode; Entfernen einer Zahlung öffnet den kanonischen Dialog
 *     (aria-labelledby/-describedby, Fokus auf Abbrechen, Escape schließt ohne Aktion, Betrag im Text)
 *  B  Position löschen (Vorgang) und Notiz löschen laufen über denselben Dialog; Abbrechen führt nichts aus
 *  C  Assistent/Wissen/Sync: Page + Sections, kein Hero-Verlauf, Notices statt Legacy-Hinweise
 *  D  Eingang-Detail: genau ein h1 mit Dokumentidentität, Status im Kopf, Back-Link
 *  E  Button-Größe sm >= 44px (CSS)
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TestProviders } from '../test/testProviders';
import { DEFAULT_SETUP } from '../data/mockData';
import { processUpload } from '../services/inboxService';
import { hydrateVorgangStore } from '../services/vorgangService';
import { addVorgangNote, getNotesForVorgang } from '../services/vorgangNoteService';
import { createTestVorgang } from '../test/fixtures';
import { InvoicePaymentHistory } from '../components/invoice/InvoicePaymentHistory';
import { AssistentPage } from './AssistentPage';
import { WissenPage } from './WissenPage';
import { SyncPage } from './SyncPage';
import { EingangDetailPage } from './EingangDetailPage';
import { VorgangDetailPage } from './VorgangDetailPage';
import type { VorgangInvoice } from '../types/models';

let root: Root | null = null;
let container: HTMLDivElement | null = null;
function mount(node: React.ReactElement) {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(node));
  return container;
}
async function flush() {
  await act(async () => {
    await new Promise<void>((resolve) => queueMicrotask(() => window.requestAnimationFrame(() => resolve())));
  });
}
afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
});

function wrap(node: React.ReactNode, entries: string[] = ['/']) {
  return (
    <MemoryRouter initialEntries={entries}>
      <TestProviders initialSetup={DEFAULT_SETUP}>{node}</TestProviders>
    </MemoryRouter>
  );
}

describe('UIUX-FOUNDATION-01G — Confirm-Dialoge (A/B)', () => {
  it('Produktivcode enthält kein window.confirm', () => {
    const src = path.resolve(__dirname, '..');
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (fs.statSync(full).isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry) && !/\.test\./.test(entry) && /window\.confirm\(/.test(fs.readFileSync(full, 'utf8'))) offenders.push(full);
      }
    };
    walk(src);
    expect(offenders).toEqual([]);
  });

  it('Zahlung entfernen: Dialog mit Betrag, Fokus auf Abbrechen, Escape bricht ab, Bestätigen ruft genau einmal', async () => {
    const onRemove = vi.fn();
    const invoice = {
      id: 'inv-g', number: '2026-0009', type: 'schluss', status: 'freigegeben', date: '2026-01-01', issueDate: '2026-01-01',
      totals: { gross: 100, net: 84.03, vat: 15.97 },
      payments: [{ id: 'p-g', date: '2026-02-01', amount: 42.5, reference: 'Ü1' }],
      positions: [],
    } as unknown as VorgangInvoice;
    const t = (k: string) => k;
    const c = mount(wrap(<InvoicePaymentHistory invoice={invoice} translate={t as never} onRemovePayment={onRemove} />));
    act(() => c.querySelector<HTMLButtonElement>('[data-testid="payment-remove-p-g"]')!.click());
    await flush();
    const dialog = c.querySelector('[data-testid="payment-remove-dialog"]')!;
    expect(dialog.getAttribute('role')).toBe('dialog');
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.getElementById(dialog.getAttribute('aria-describedby')!)?.textContent).toContain('42,50 €');
    expect(document.activeElement).toBe(c.querySelector('[data-testid="payment-remove-cancel"]'));
    expect(onRemove).not.toHaveBeenCalled();
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await flush();
    expect(c.querySelector('[data-testid="payment-remove-dialog"]')).toBeNull();
    expect(onRemove).not.toHaveBeenCalled();
    act(() => c.querySelector<HTMLButtonElement>('[data-testid="payment-remove-p-g"]')!.click());
    await flush();
    await act(async () => c.querySelector<HTMLButtonElement>('[data-testid="payment-remove-confirm"]')!.click());
    await flush();
    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledWith('p-g');
  });

  it('Notiz löschen im Vorgang: Abbrechen löscht nichts, Bestätigen löscht', async () => {
    hydrateVorgangStore([createTestVorgang({ id: 'v-g', title: 'Bad G', customer: 'K' })]);
    const note = addVorgangNote('v-g', { body: 'Testnotiz 01G' });
    expect(note.success).toBe(true);
    const c = mount(
      wrap(
        <Routes>
          <Route path="/vorgaenge/:id" element={<VorgangDetailPage />} />
        </Routes>,
        ['/vorgaenge/v-g'],
      ),
    );
    const noteId = note.success ? note.note.id : '';
    const more = c.querySelector<HTMLButtonElement>('[data-testid="vorgang-detail-show-more"] button');
    if (more) act(() => more.click());
    await flush();
    const trigger = c.querySelector<HTMLButtonElement>(`[data-testid="vorgang-note-delete-${noteId}"]`);
    expect(trigger).not.toBeNull();
    act(() => trigger!.click());
    await flush();
    expect(c.querySelector('[data-testid="vorgang-delete-dialog"]')).not.toBeNull();
    act(() => c.querySelector<HTMLButtonElement>('[data-testid="vorgang-delete-cancel"]')!.click());
    await flush();
    expect(getNotesForVorgang('v-g')).toHaveLength(1);
    act(() => trigger!.click());
    await flush();
    await act(async () => c.querySelector<HTMLButtonElement>('[data-testid="vorgang-delete-confirm"]')!.click());
    await flush();
    expect(getNotesForVorgang('v-g')).toHaveLength(0);
  });
});

describe('UIUX-FOUNDATION-01G — Restflächen (C)', () => {
  it('Assistent/Wissen/Sync auf Page-Patterns ohne Hero/Legacy-Hinweise', () => {
    const a = renderToStaticMarkup(wrap(<AssistentPage />));
    expect(a).toContain('data-testid="assistant-page"');
    expect(a).toContain('data-testid="assistant-employee-hero"');
    expect(a).toContain('inline-notice');
    expect(a).not.toContain('assistant-employee-hero__title');
    expect(a).toContain('ui-section-header__title');
    const w = renderToStaticMarkup(wrap(<WissenPage />));
    expect(w).toContain('inline-notice');
    expect(w).not.toContain('hint-text');
    const s = renderToStaticMarkup(wrap(<SyncPage />));
    expect(s).toContain('data-testid="sync-mode-notice"');
    expect(s).toContain('data-testid="sync-status-badge"');
    expect(s).toContain('ui-section');
    expect(s).not.toContain('class="card');
  });
});

describe('UIUX-FOUNDATION-01G — Eingang-Detail (D)', () => {
  it('genau ein h1 mit Dokumentidentität, Status im Kopf, Back-Link nach /ablage', () => {
    const uploaded = processUpload({ kind: 'auftrag' });
    const html = renderToStaticMarkup(
      wrap(
        <Routes>
          <Route path="/ablage/:id" element={<EingangDetailPage />} />
        </Routes>,
        [`/ablage/${uploaded.id}`],
      ),
    );
    expect((html.match(/<h1/g) ?? []).length).toBe(1);
    expect(html).toContain('data-testid="eingang-detail-header"');
    expect(html).toContain('data-testid="eingang-detail-status"');
    expect(html).toMatch(/<a class="page-header__back" data-testid="eingang-detail-back" href="\/ablage"/);
    expect(html).toContain('data-testid="document-review-experience"');
  });
});

describe('UIUX-FOUNDATION-01G — Touchziele (E)', () => {
  it('kleine Buttons sind mindestens 44px hoch', () => {
    const css = fs.readFileSync(path.resolve(__dirname, '../styles/components.css'), 'utf8');
    expect(css).toMatch(/\.btn--sm \{[^}]*min-height: 44px/);
  });
});
