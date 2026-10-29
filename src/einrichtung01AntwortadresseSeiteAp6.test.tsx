/**
 * EINRICHTUNG-01 (AP6; Vertrag 1.22 E-03, K4) — Bestätigungsseite der Antwortadresse.
 *
 *   E-03.12  Seitenaufruf (GET) bestätigt nichts; erst „Adresse bestätigen“ (POST) — ohne Anmeldung, vor Gate und
 *            Anmeldung (RootShell); das Token verschwindet aus der Adresszeile
 *   E-03.3   ungültig/abgelaufen/veraltet → eine Meldung; Versuchslimit; fehlendes Token
 *
 * Der Versand an die Edge Function ist gemockt; kein Netz.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RootShell } from './RootShell';
import * as replyToService from './services/delivery/replyToConfirmationService';

const TOKEN = 'A'.repeat(21) + '_' + 'b'.repeat(20) + '-';
let root: Root | null = null;
let host: HTMLDivElement;

async function settle(): Promise<void> {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
  }
}

async function open(url: string): Promise<void> {
  window.history.pushState({}, '', url);
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <BrowserRouter>
        <RootShell />
      </BrowserRouter>,
    );
  });
  await settle();
}

const q = (id: string) => host.querySelector(`[data-testid="${id}"]`);

async function click(id: string): Promise<void> {
  await act(async () => {
    (q(id) as HTMLButtonElement).dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await settle();
}

describe('EINRICHTUNG-01 (AP6; E-03) — Bestätigungsseite der Antwortadresse', () => {
  beforeEach(() => {
    expect(TOKEN).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    root = null;
    host?.remove();
    vi.restoreAllMocks();
    window.history.pushState({}, '', '/');
  });

  it('E-03.12: der Aufruf bestätigt nichts; erst der Knopf sendet — ohne Anmeldung, vor Gate und Anmeldung', async () => {
    const confirm = vi.spyOn(replyToService, 'confirmReplyToToken').mockResolvedValue({ ok: true, status: 'confirmed', address: 'a***@beispiel.invalid' });
    await open(`/antwortadresse-bestaetigen#token=${TOKEN}`);

    expect(q('reply-to-confirm-page')).not.toBeNull();
    expect(host.querySelector('[data-testid="login-page"], form[data-testid="login-form"]')).toBeNull();
    expect(confirm).not.toHaveBeenCalled();
    // Das Token steht nicht mehr in der Adresszeile.
    expect(window.location.hash).toBe('');
    expect(window.location.pathname).toBe('/antwortadresse-bestaetigen');

    await click('reply-to-confirm-action');
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(TOKEN);
    expect(q('reply-to-confirm-result')?.getAttribute('data-outcome')).toBe('confirmed');
    expect(q('reply-to-confirm-result')?.textContent).toContain('a***@beispiel.invalid');
    expect(q('reply-to-confirm-action')).toBeNull();
    expect(q('reply-to-confirm-home')?.getAttribute('href')).toBe('/');
  });

  it('E-03.3: ungültig, abgelaufen oder veraltet — eine Meldung, nichts bestätigt; erneuter Versuch möglich', async () => {
    vi.spyOn(replyToService, 'confirmReplyToToken').mockResolvedValue({ ok: false, reason: 'invalid' });
    await open(`/antwortadresse-bestaetigen#token=${TOKEN}`);
    await click('reply-to-confirm-action');
    expect(q('reply-to-confirm-result')?.textContent).toContain('Es wurde nichts bestätigt');
    expect(q('reply-to-confirm-action')).not.toBeNull();
  });

  it('Versuchslimit und nicht erreichbarer Dienst haben eigene Hinweise', async () => {
    const confirm = vi.spyOn(replyToService, 'confirmReplyToToken').mockResolvedValueOnce({ ok: false, reason: 'rate_limited' });
    await open(`/antwortadresse-bestaetigen#token=${TOKEN}`);
    await click('reply-to-confirm-action');
    expect(q('reply-to-confirm-result')?.textContent).toContain('Zu viele Versuche');

    confirm.mockResolvedValueOnce({ ok: false, reason: 'unavailable' });
    await click('reply-to-confirm-action');
    expect(q('reply-to-confirm-result')?.textContent).toContain('nicht erreichbar');
  });

  it('ohne Token im Link: Hinweis, kein Knopf, kein Aufruf', async () => {
    const confirm = vi.spyOn(replyToService, 'confirmReplyToToken');
    await open('/antwortadresse-bestaetigen');
    expect(q('reply-to-confirm-result')?.getAttribute('data-outcome')).toBe('missing_token');
    expect(q('reply-to-confirm-action')).toBeNull();
    expect(confirm).not.toHaveBeenCalled();
  });
});
