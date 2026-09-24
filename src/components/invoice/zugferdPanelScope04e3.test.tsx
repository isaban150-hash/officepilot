/**
 * E-RECHNUNG-04E3 — der ZUGFeRD-Zustand gehört genau einer Rechnung.
 *
 * Dieselben Invarianten wie in 04D-FIX2, und aus demselben Grund: Beide
 * Rechnungen liegen unter demselben Routenmuster, der Router behält dieselbe
 * Komponenteninstanz, und ein `useState` überlebt den Wechsel. Beim ZUGFeRD
 * wiegt das schwerer als bei der XRechnung — das Dokument enthält den
 * maschinenlesbaren Datensatz, nach dem der Empfänger bucht.
 *
 * Geprüft wird ausserdem, was beim blossen Öffnen **nicht** passiert: nichts
 * wird erzeugt, nichts heruntergeladen, nichts versendet.
 *
 * Kein Netzwerk, keine echte Ablage — die beiden Dienste sind eingesetzt.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZugferdPanel } from './ZugferdPanel';
import { EInvoicePanel } from './EInvoicePanel';
import type {
  ZugferdArtifactResult,
  ZugferdStoredArtifact,
} from '../../services/einvoice/zugferd/zugferdArtifactService';
import type { VorgangInvoice } from '../../types/models';

/* ------------------------------------------------------------------ */

function invoice(id: string, number: string): VorgangInvoice {
  return { id, number, type: 'rechnung', status: 'vorbereitet' } as unknown as VorgangInvoice;
}

const A = invoice('inv-a', '2026-0025');
const B = invoice('inv-b', '2026-0023');

function artifact(
  inv: VorgangInvoice,
  sha: string,
  durability: ZugferdStoredArtifact['durability'] = 'local_only',
): ZugferdStoredArtifact {
  return {
    sourceInvoiceId: inv.id,
    sourceInvoiceNumber: inv.number,
    format: 'zugferd',
    standardVersion: '2.5.2',
    facturXVersion: '1.09.2',
    profile: 'EN16931',
    syntax: 'CII',
    pdfConformance: 'PDF/A-3U',
    embeddedFileName: 'factur-x.xml',
    generatorVersion: 'officetakt-zugferd-en16931-1',
    fileName: `ZUGFeRD-${inv.number}.pdf`,
    mimeType: 'application/pdf',
    contentSha256: sha,
    byteSize: 4242,
    createdAt: '2026-09-24T08:00:00.000Z',
    internalValidation: 'passed',
    fileRefId: `fr-${inv.id}`,
    durability,
    bytes: new TextEncoder().encode('%PDF-1.7'),
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
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
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
const knopf = () =>
  container.querySelector('[data-testid="invoice-zugferd-action"]') as HTMLButtonElement;

async function zeige(
  inv: VorgangInvoice,
  dienste: {
    read?: (i: VorgangInvoice) => Promise<ZugferdStoredArtifact | null>;
    ensure?: (i: VorgangInvoice) => Promise<ZugferdArtifactResult>;
  },
): Promise<void> {
  await act(async () => {
    root.render(
      <ZugferdPanel
        invoice={inv}
        readArtifact={(dienste.read ?? (async () => null)) as never}
        ensureArtifact={
          (dienste.ensure ?? (async () => ({ ok: false, reason: 'storage_failed' }))) as never
        }
      />,
    );
  });
}

async function klick(): Promise<void> {
  await act(async () => {
    knopf().click();
  });
}

/* ================================================================== */

describe('A — beim Öffnen passiert nichts', () => {
  // T18/T19 — confirm-first.
  it('T18/T19: ohne Klick wird nichts erzeugt und nichts heruntergeladen', async () => {
    const ensure = vi.fn();
    await zeige(A, { ensure: ensure as never });

    expect(ensure).not.toHaveBeenCalled();
    expect(downloads).toEqual([]);
    expect(knopf().textContent).toContain('ZUGFeRD erzeugen und herunterladen');
    expect(q('invoice-zugferd-result')).toBeNull();
  });

  // T17 — ein vorhandenes Dokument wird erkannt, aber nicht ausgeliefert.
  it('T17: ein vorhandenes Dokument wird angezeigt, aber nicht heruntergeladen', async () => {
    await zeige(A, { read: async () => artifact(A, SHA_A) });

    expect(text('invoice-zugferd-filename')).toBe('ZUGFeRD-2026-0025.pdf');
    expect(text('invoice-zugferd-sha')).toBe(SHA_A);
    expect(knopf().textContent).toContain('ZUGFeRD erneut herunterladen');
    expect(downloads, 'Nachsehen ist kein Download').toEqual([]);
  });
});

describe('B — Rechnungswechsel', () => {
  // T15 — nichts von A erscheint unter B.
  it('T15: beim Wechsel A → B bleibt nichts von A stehen', async () => {
    await zeige(A, { read: async () => artifact(A, SHA_A) });
    expect(text('invoice-zugferd-sha')).toBe(SHA_A);

    await zeige(B, { read: async () => null });

    expect(q('invoice-zugferd-result'), 'kein Ergebnis von A unter B').toBeNull();
    expect(container.textContent).not.toContain(SHA_A);
    expect(container.textContent).not.toContain('2026-0025');
    expect(knopf().textContent).toContain('ZUGFeRD erzeugen und herunterladen');
  });

  it('T15b: jede Rechnung zeigt ihren eigenen Prüfwert', async () => {
    await zeige(A, { read: async () => artifact(A, SHA_A) });
    expect(text('invoice-zugferd-sha')).toBe(SHA_A);

    await zeige(B, { read: async () => artifact(B, SHA_B) });
    expect(text('invoice-zugferd-sha')).toBe(SHA_B);
    expect(text('invoice-zugferd-source')).toBe('2026-0023');
  });

  // T16 — ein spätes Ergebnis von A darf B nicht überschreiben.
  it('T16: ein verspätetes Ergebnis von A erreicht B nicht', async () => {
    let spaetesErgebnis!: (value: ZugferdStoredArtifact | null) => void;
    const haengend = new Promise<ZugferdStoredArtifact | null>((resolve) => {
      spaetesErgebnis = resolve;
    });

    await zeige(A, { read: () => haengend });
    await zeige(B, { read: async () => null });

    // Jetzt erst antwortet der Abruf von A.
    await act(async () => {
      spaetesErgebnis(artifact(A, SHA_A));
      await haengend;
    });

    expect(container.textContent).not.toContain(SHA_A);
    expect(container.textContent).not.toContain('2026-0025');
    expect(q('invoice-zugferd-result')).toBeNull();
  });

  /*
   * Die Sicherheitsinvariante. Selbst wenn der Dienst ein fremdes Dokument
   * zurückgäbe, darf es nicht ausgeliefert werden: Der Empfänger bekäme einen
   * Datensatz über fremde Beträge unter der falschen Nummer.
   */
  it('T14: ein Dokument einer anderen Rechnung wird nie heruntergeladen', async () => {
    await zeige(B, {
      ensure: async () => ({ ok: true, artifact: artifact(A, SHA_A), reused: false }),
    });
    await klick();

    expect(downloads, 'kein Download eines fremden Belegs').toEqual([]);
    expect(text('invoice-zugferd-error')).toContain('gehört zu einer anderen Rechnung');
  });
});

describe('C — Erzeugen auf ausdrückliche Anforderung', () => {
  it('ein Klick erzeugt, lädt herunter und zeigt die Angaben', async () => {
    await zeige(A, {
      ensure: async () => ({ ok: true, artifact: artifact(A, SHA_A), reused: false }),
    });
    await klick();

    expect(downloads).toEqual(['ZUGFeRD-2026-0025.pdf']);
    expect(text('invoice-zugferd-result')).toContain('wurde erzeugt und heruntergeladen');
    expect(text('invoice-zugferd-format')).toContain('ZUGFeRD 2.5.2');
    expect(text('invoice-zugferd-format')).toContain('EN16931');
    expect(text('invoice-zugferd-format')).toContain('PDF/A-3U');
    expect(text('invoice-zugferd-sha')).toBe(SHA_A);
  });

  it('ein zweiter Klick liefert dieselbe Datei erneut aus', async () => {
    await zeige(A, {
      ensure: async () => ({ ok: true, artifact: artifact(A, SHA_A), reused: true }),
    });
    await klick();

    expect(downloads).toEqual(['ZUGFeRD-2026-0025.pdf']);
    expect(text('invoice-zugferd-result')).toContain('liegt bereits eine ZUGFeRD-Rechnung vor');
  });
});

describe('D — Ablagestatus ehrlich', () => {
  // T20/T21 — die Anzeige behauptet keine Cloud-Sicherung, die es nicht gibt.
  it('T20: ohne Cloud steht „Cloud-Sicherung steht noch aus"', async () => {
    await zeige(A, { read: async () => artifact(A, SHA_A, 'local_only') });
    expect(text('invoice-zugferd-durability')).toBe(
      'Lokal gespeichert · Cloud-Sicherung steht noch aus',
    );
  });

  it('T21: mit Cloud steht „Lokal und in der Cloud gesichert"', async () => {
    await zeige(A, { read: async () => artifact(A, SHA_A, 'cloud_backed') });
    expect(text('invoice-zugferd-durability')).toBe('Lokal und in der Cloud gesichert');
  });
});

describe('E — gesperrte Fälle verständlich erklären', () => {
  it('ein nicht unterstützter Steuerfall nennt den Grund', async () => {
    await zeige(A, {
      ensure: async () => ({
        ok: false,
        reason: 'canonical_incomplete',
        issues: [{ code: 'tax_status_unclear', path: 'taxStatus' }] as never,
      }),
    });
    await klick();

    expect(q('invoice-zugferd-blocked')).not.toBeNull();
    expect(text('invoice-zugferd-blocked').length).toBeGreaterThan(20);
    expect(downloads).toEqual([]);
  });

  it('ein Widerspruch zwischen PDF und Datensatz führt zu keiner Datei', async () => {
    await zeige(A, {
      ensure: async () => ({
        ok: false,
        reason: 'pdf_xml_mismatch',
        mismatches: [{ field: 'totals.gross', pdf: '190.40', xml: '999.99' }],
      }),
    });
    await klick();

    expect(text('invoice-zugferd-blocked')).toContain('stimmen nicht überein');
    expect(downloads).toEqual([]);
  });

  it('kein Text behauptet eine amtliche Prüfung', async () => {
    await zeige(A, { read: async () => artifact(A, SHA_A) });
    const alles = container.textContent ?? '';
    expect(alles.toLowerCase()).not.toContain('zertifiziert');
    expect(alles.toLowerCase()).not.toContain('amtlich');
    expect(alles).toContain('Interne Prüfung');
  });
});

describe('F — der gemeinsame E-Rechnungsbereich', () => {
  it('beide Formate stehen in einem Bereich nebeneinander', async () => {
    await act(async () => {
      root.render(<EInvoicePanel invoice={A} />);
    });

    expect(q('invoice-einvoice-panel')).not.toBeNull();
    expect(q('invoice-xrechnung-panel'), 'die XRechnung bleibt erhalten').not.toBeNull();
    expect(q('invoice-zugferd-panel')).not.toBeNull();
    expect(container.textContent).toContain('E-Rechnung');
  });

  it('der Hilfetext erklärt beide Formate in je einem Satz', async () => {
    await act(async () => {
      root.render(<EInvoicePanel invoice={A} />);
    });

    expect(text('invoice-xrechnung-hint')).toContain('Strukturierte XML-Rechnung');
    expect(text('invoice-zugferd-hint')).toContain(
      'PDF/A-3-Rechnung mit eingebetteten strukturierten Rechnungsdaten',
    );
  });
});
