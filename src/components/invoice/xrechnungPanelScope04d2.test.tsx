/**
 * E-RECHNUNG-04D-FIX2 — der XRechnung-Zustand gehört genau einer Rechnung.
 *
 * Realbefund der unabhängigen Abnahme: Nach dem Erzeugen der XRechnung zu
 * 2026-0025 zeigten 2026-0023 und 2026-0024 beim Wechsel innerhalb der App
 * weiterhin deren Dateinamen und Prüfwert. Über „Liste → Öffnen" war die
 * Anzeige wieder richtig.
 *
 * Geprüft wird beides: dass keine Anzeige mehr wandert — und, wichtiger, dass
 * unter keinen Umständen die XRechnung einer **anderen** Rechnung ausgeliefert
 * werden kann. Ein Empfänger bekäme sonst einen Beleg über fremde Beträge
 * unter der falschen Nummer.
 *
 * Kein Netzwerk, keine echte Ablage — die beiden Dienste sind eingesetzt.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { XRechnungPanel } from './XRechnungPanel';
import type { XRechnungArtifact, XRechnungArtifactResult } from '../../services/einvoice/xrechnungArtifactService';
import type { VorgangInvoice } from '../../types/models';

/* ------------------------------------------------------------------ */

function invoice(id: string, number: string): VorgangInvoice {
  return { id, number, type: 'rechnung', status: 'vorbereitet' } as unknown as VorgangInvoice;
}

const A = invoice('inv-a', '2026-0025');
const B = invoice('inv-b', '2026-0023');
const C = invoice('inv-c', '2026-0024');

function artifact(inv: VorgangInvoice, sha: string): XRechnungArtifact {
  return {
    sourceInvoiceId: inv.id,
    sourceInvoiceNumber: inv.number,
    format: 'xrechnung',
    syntax: 'cii',
    standardVersion: '3.0.2',
    bundleVersion: '2026-08-31',
    generatorVersion: 'officetakt-cii-1',
    fileName: `XRechnung-${inv.number}.xml`,
    contentSha256: sha,
    byteSize: 42,
    createdAt: '2026-09-24T08:00:00.000Z',
    internalValidation: 'passed',
    bytes: new TextEncoder().encode('<xml/>'),
  };
}

const SHA_A = 'd1caa802b59b352a7db6927e9b14db2e468110fedee7b2b448959f1ce7166f82';
const SHA_B = 'aaaa1111bbbb2222cccc3333dddd4444eeee5555ffff6666aaaa7777bbbb8888';

/* ------------------------------------------------------------------ */

let container: HTMLDivElement;
let root: Root;
let downloads: string[];

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  downloads = [];
  // Jeder tatsächlich ausgelöste Download wird mitgeschrieben.
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    downloads.push(this.download);
  });
  Object.defineProperty(URL, 'createObjectURL', { value: () => 'blob:test', writable: true });
  Object.defineProperty(URL, 'revokeObjectURL', { value: () => {}, writable: true });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

const q = (id: string) => container.querySelector(`[data-testid="${id}"]`);
const text = (id: string) => q(id)?.textContent ?? '';
const knopf = () => container.querySelector('[data-testid="invoice-xrechnung-action"]') as HTMLButtonElement;

/** Einen Panel-Stand rendern und alle offenen Mikrotasks abarbeiten. */
async function zeige(
  inv: VorgangInvoice,
  dienste: {
    read?: (i: VorgangInvoice) => Promise<XRechnungArtifact | null>;
    ensure?: (i: VorgangInvoice) => Promise<XRechnungArtifactResult>;
  },
): Promise<void> {
  await act(async () => {
    root.render(
      <XRechnungPanel
        invoice={inv}
        readArtifact={(dienste.read ?? (async () => null)) as never}
        ensureArtifact={(dienste.ensure ?? (async () => ({ ok: false, reason: 'storage_failed' }))) as never}
      />,
    );
  });
}

async function klick(): Promise<void> {
  await act(async () => {
    knopf().click();
  });
}

/* ------------------------------------------------------------------ */

describe('A — der Zustand bleibt bei seiner Rechnung', () => {
  /** Ablage, die nur für A ein Artefakt kennt. */
  const nurA = async (i: VorgangInvoice) => (i.id === A.id ? artifact(A, SHA_A) : null);

  it('T1/T10: eine Rechnung mit Artefakt bietet den erneuten Download an', async () => {
    await zeige(A, { read: nurA });
    expect(knopf().textContent).toContain('erneut herunterladen');
    expect(text('invoice-xrechnung-filename')).toBe('XRechnung-2026-0025.xml');
    expect(text('invoice-xrechnung-sha')).toBe(SHA_A);
    expect(text('invoice-xrechnung-source')).toBe('2026-0025');
  });

  it('T2/T3/T9: der Wechsel auf eine Rechnung ohne Artefakt zeigt nichts von der ersten', async () => {
    await zeige(A, { read: nurA });
    expect(text('invoice-xrechnung-sha')).toBe(SHA_A);

    // Derselbe Routenpfad, dieselbe Komponenteninstanz — nur eine andere Rechnung.
    await zeige(B, { read: nurA });
    expect(q('invoice-xrechnung-result'), 'kein Ergebnisblock der Vorgängerin').toBeNull();
    expect(knopf().textContent).toContain('erzeugen und herunterladen');
    expect(container.textContent).not.toContain(SHA_A);
    expect(container.textContent).not.toContain('XRechnung-2026-0025.xml');

    await zeige(C, { read: nurA });
    expect(q('invoice-xrechnung-result')).toBeNull();
    expect(container.textContent).not.toContain(SHA_A);
  });

  it('T5: zurück zur ersten Rechnung zeigt wieder deren Artefakt', async () => {
    await zeige(A, { read: nurA });
    await zeige(B, { read: nurA });
    await zeige(A, { read: nurA });
    expect(text('invoice-xrechnung-sha')).toBe(SHA_A);
    expect(text('invoice-xrechnung-filename')).toBe('XRechnung-2026-0025.xml');
  });

  it('T6: Vor und Zurück verhalten sich wie jeder andere Wechsel', async () => {
    /*
     * Ein Browserschritt ist für diese Komponente nichts Besonderes: Der
     * Router tauscht die Kennung aus, mehr passiert nicht. Genau diese Folge
     * wird hier nachgestellt.
     */
    for (const [inv, erwartet] of [
      [A, SHA_A],
      [B, null],
      [A, SHA_A],
      [C, null],
      [A, SHA_A],
    ] as Array<[VorgangInvoice, string | null]>) {
      await zeige(inv, { read: nurA });
      if (erwartet) expect(text('invoice-xrechnung-sha')).toBe(erwartet);
      else expect(q('invoice-xrechnung-result')).toBeNull();
    }
  });
});

describe('B — der Download kann nie zur falschen Rechnung gehören', () => {
  it('T4: ein Artefakt mit fremder Herkunft wird nicht ausgeliefert', async () => {
    /*
     * Die Sicherheitsinvariante, bewusst gegen einen Dienst geprüft, der sich
     * falsch verhält: Er liefert zu B das Artefakt von A. Selbst dann darf
     * keine Datei entstehen.
     */
    await zeige(B, {
      ensure: async () => ({ ok: true, artifact: artifact(A, SHA_A), reused: false }),
    });
    await klick();

    expect(downloads, 'keine Datei ausgeliefert').toEqual([]);
    expect(text('invoice-xrechnung-error')).toContain('gehört zu einer anderen Rechnung');
    expect(container.textContent).not.toContain(SHA_A);
  });

  it('das richtige Artefakt wird ausgeliefert', async () => {
    await zeige(B, {
      ensure: async (i) => ({ ok: true, artifact: artifact(i, SHA_B), reused: false }),
    });
    await klick();

    expect(downloads).toEqual(['XRechnung-2026-0023.xml']);
    expect(text('invoice-xrechnung-sha')).toBe(SHA_B);
  });
});

describe('C — späte Ergebnisse alter Abrufe', () => {
  it('T7: ein verzögerter Lookup der ersten Rechnung überschreibt die zweite nicht', async () => {
    let freigeben: ((value: XRechnungArtifact | null) => void) | null = null;
    const langsam = (i: VorgangInvoice): Promise<XRechnungArtifact | null> =>
      i.id === A.id
        ? new Promise((resolve) => {
            freigeben = resolve;
          })
        : Promise.resolve(null);

    await zeige(A, { read: langsam });
    // Der Abruf für A hängt noch — jetzt wechselt der Nutzer weiter.
    await zeige(B, { read: langsam });

    await act(async () => {
      freigeben?.(artifact(A, SHA_A));
    });

    expect(q('invoice-xrechnung-result'), 'das späte Ergebnis wurde verworfen').toBeNull();
    expect(container.textContent).not.toContain(SHA_A);
  });

  it('eine verzögerte Erzeugung wirkt nicht auf die nächste Rechnung', async () => {
    let freigeben: ((value: XRechnungArtifactResult) => void) | null = null;
    await zeige(A, {
      ensure: () =>
        new Promise((resolve) => {
          freigeben = resolve;
        }),
    });
    await klick();
    expect(knopf().textContent).toContain('wird erzeugt');

    await zeige(B, {});
    await act(async () => {
      freigeben?.({ ok: true, artifact: artifact(A, SHA_A), reused: false });
    });

    expect(q('invoice-xrechnung-result')).toBeNull();
    expect(container.textContent).not.toContain(SHA_A);
    expect(knopf().textContent, 'B ist nicht in einem Ladezustand gefangen').toContain(
      'erzeugen und herunterladen',
    );
  });
});

describe('D — auch Fehlermeldungen bleiben bei ihrer Rechnung', () => {
  it('T11: ein Befund wandert nicht zur nächsten Rechnung', async () => {
    await zeige(A, {
      ensure: async () => ({
        ok: false,
        reason: 'canonical_incomplete',
        issues: [{ code: 'buyer_reference_missing', path: 'customerSnapshot.buyerReference', severity: 'error' }],
      }),
    });
    await klick();
    expect(text('invoice-xrechnung-blocked')).toContain('Käuferreferenz');

    await zeige(B, {});
    expect(q('invoice-xrechnung-blocked')).toBeNull();
  });

  it('T12: auch ein technischer Fehler bleibt bei seiner Rechnung', async () => {
    await zeige(A, { ensure: async () => ({ ok: false, reason: 'storage_failed' }) });
    await klick();
    expect(q('invoice-xrechnung-error')).not.toBeNull();

    await zeige(B, {});
    expect(q('invoice-xrechnung-error')).toBeNull();
  });
});

describe('E — T8: ein vorhandenes Artefakt wird beim Öffnen erkannt', () => {
  it('ohne es neu zu erzeugen', async () => {
    const ensure = vi.fn();
    await zeige(A, { read: async () => artifact(A, SHA_A), ensure: ensure as never });

    expect(knopf().textContent).toContain('erneut herunterladen');
    expect(text('invoice-xrechnung-result')).toContain('liegt bereits eine XRechnung vor');
    // Confirm-first: Lesen ist keine Handlung des Nutzers, Erzeugen schon.
    expect(ensure).not.toHaveBeenCalled();
    expect(downloads, 'und es wird nichts ungefragt heruntergeladen').toEqual([]);
  });

  it('T14: der Prüfwert bekommt die Umbruchklasse für schmale Bildschirme', async () => {
    await zeige(A, { read: async () => artifact(A, SHA_A) });
    expect(q('invoice-xrechnung-sha')?.className).toContain('invoice-einvoice__hash');
  });
});
