/**
 * EINRICHTUNG-01 (Eigenprüfung; A-12, N-01.3) — die Weiterleitung auf die Anmeldeseite nimmt den Anker mit.
 *
 * Im echten Browser lief die App beim Kaltstart in 6 von 12 Fällen kurz über `/login?next=…` und zurück; ohne Anker
 * landete `/firmendaten#logo` danach auf den Firmendaten statt auf „Design“ (Beleg `belege/eigenpruefung/
 * altadressen-kaltstart-vorher.json`).
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { LoginRedirect } from './authRedirects';

let host: HTMLDivElement | null = null;
let root: Root | null = null;

function AnmeldeSonde() {
  const { pathname, search } = useLocation();
  return <p data-testid="sonde">{`${pathname}${search}`}</p>;
}

async function weiterleiten(von: string): Promise<string> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <MemoryRouter initialEntries={[von]}>
        <Routes>
          <Route path="/login" element={<AnmeldeSonde />} />
          <Route path="*" element={<LoginRedirect />} />
        </Routes>
      </MemoryRouter>,
    );
  });
  return host.querySelector('[data-testid="sonde"]')?.textContent ?? '';
}

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  host?.remove();
  host = null;
  root = null;
});

describe('EINRICHTUNG-01 — Rücksprung mit Anker (A-12, N-01.3)', () => {
  it('Altadresse mit Anker: next enthält Pfad, Suche und Anker', async () => {
    expect(await weiterleiten('/firmendaten#logo')).toBe(`/login?next=${encodeURIComponent('/firmendaten#logo')}`);
  });

  it('Feldanker einer Einstellungsseite bleibt erhalten', async () => {
    expect(await weiterleiten('/einstellungen/rechnungen?x=1#settings-invoices-defaultPaymentDays')).toBe(
      `/login?next=${encodeURIComponent('/einstellungen/rechnungen?x=1#settings-invoices-defaultPaymentDays')}`,
    );
  });

  it('ohne Anker unverändert', async () => {
    expect(await weiterleiten('/einstellungen/firma')).toBe(`/login?next=${encodeURIComponent('/einstellungen/firma')}`);
  });
});
