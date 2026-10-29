/**
 * EINRICHTUNG-01 Abschluss 21 (E-1, Vertrag 1.32, Q-04.1) — Regressionsschutz für die beiden axe-core-Befunde der B2-Seiten.
 *
 *   K1 Farbkontrast (axe „color-contrast“, serious): `--op-text-subtle` und `--op-warning` erreichen auf ihren
 *      Hintergründen mindestens 4,5:1 (WCAG 2.1 AA, Fließtext). Vorher 4,24:1 / 4,06:1 bzw. 4,27:1.
 *   K2 ARIA (axe „aria-allowed-attr“, critical): Das Zahlenfeld ist ein Textfeld (Rolle textbox) und trägt deshalb kein
 *      `aria-valuemin`/`aria-valuemax`.
 * Der eigentliche Nachweis ist der axe-Lauf im Browser (Bericht 21); diese Tests halten die Ursachen fest.
 *
 * Abschluss 22 (WEISS E-1): Die Nachmessung der von axe als „unvollständig“ gemeldeten Kontraste (Verlauf, Überdeckung)
 * fand zwei echte Unterschreitungen:
 *   K3 „Weitere Bereiche“ in der Seitenleiste (`--pilot-nav-muted`, wirksam ist die letzte Festlegung) auf dem Verlauf
 *      der Navigation #fbfaf7 → #f1eee8: vorher #7b8290 mit 3,5:1, jetzt mindestens 4,5:1 an beiden Enden.
 *   K4 Synchronisationsstand im hellen Kopf: vorher Weiß 85 % auf Weiß (≈ 1,1:1), jetzt `--op-text-muted` (≥ 4,5:1).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { NumericInput } from './components/ui/NumericInput';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CSS = fs.readFileSync(path.join(REPO, 'src/styles/visual-pilot-02b.css'), 'utf8');

function token(name: string): string {
  const treffer = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(CSS);
  if (!treffer) throw new Error(`Token --${name} nicht gefunden`);
  return treffer[1];
}
/** Die wirksame (letzte) Festlegung eines Tokens. */
function letztesToken(name: string): string {
  const treffer = [...CSS.matchAll(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`, 'g'))];
  if (treffer.length === 0) throw new Error(`Token --${name} nicht gefunden`);
  return treffer[treffer.length - 1][1];
}
function luminanz(hex: string): number {
  const kanal = (i: number) => {
    const c = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * kanal(0) + 0.7152 * kanal(1) + 0.0722 * kanal(2);
}
function kontrast(a: string, b: string): number {
  const [hell, dunkel] = [luminanz(a), luminanz(b)].sort((x, y) => y - x);
  return (hell + 0.05) / (dunkel + 0.05);
}

describe('Abschluss 21 — axe-Befunde der B2-Seiten', () => {
  it('K1 --op-text-subtle hat auf Weiß und auf dem Seitengrund (#fbfaf7) mindestens 4,5:1', () => {
    const farbe = token('op-text-subtle');
    expect(kontrast(farbe, '#ffffff')).toBeGreaterThanOrEqual(4.5);
    expect(kontrast(farbe, '#fbfaf7')).toBeGreaterThanOrEqual(4.5);
  });

  it('K1 --op-warning hat auf --op-warning-subtle und auf Weiß mindestens 4,5:1', () => {
    const farbe = token('op-warning');
    expect(kontrast(farbe, token('op-warning-subtle'))).toBeGreaterThanOrEqual(4.5);
    expect(kontrast(farbe, '#ffffff')).toBeGreaterThanOrEqual(4.5);
  });

  it('K3 der Seitenleistentitel (--pilot-nav-muted, letzte Festlegung) hat auf beiden Enden des Navigationsverlaufs mindestens 4,5:1', () => {
    const farbe = letztesToken('pilot-nav-muted');
    expect(kontrast(farbe, '#fbfaf7')).toBeGreaterThanOrEqual(4.5);
    expect(kontrast(farbe, '#f1eee8')).toBeGreaterThanOrEqual(4.5);
  });

  it('K4 der Synchronisationsstand im hellen Kopf trägt gedämpften Text statt der Farbe für dunklen Grund', () => {
    const regel = /\n\.app-shell__sync-indicator\s*\{([^}]*)\}/.exec(CSS)?.[1] ?? '';
    expect(regel).toMatch(/color:\s*var\(--op-text-muted\)/);
    expect(kontrast(token('op-text-muted'), '#ffffff')).toBeGreaterThanOrEqual(4.5);
    const punkt = /\.app-shell__sync-indicator--syncing \.app-shell__sync-indicator-dot\s*\{([^}]*)\}/.exec(CSS)?.[1] ?? '';
    expect(punkt).toMatch(/background:\s*var\(--op-text-subtle\)/);
    // Nicht-Text-Kontrast (WCAG 1.4.11) des Punkts auf Weiß: mindestens 3:1.
    expect(kontrast(token('op-text-subtle'), '#ffffff')).toBeGreaterThanOrEqual(3);
  });

  it('K2 das Zahlenfeld trägt kein aria-valuemin/aria-valuemax (Rolle textbox), auch mit min und max', () => {
    const behaelter = document.createElement('div');
    document.body.appendChild(behaelter);
    const wurzel = createRoot(behaelter);
    act(() => {
      wurzel.render(<NumericInput id="abschluss21-zahl" value={5} onChange={() => undefined} mode="integer" min={0} max={100} data-testid="abschluss21-zahl" />);
    });
    const feld = behaelter.querySelector('[data-testid="abschluss21-zahl"]') as HTMLInputElement;
    expect(feld).not.toBeNull();
    expect(feld.getAttribute('type')).toBe('text');
    expect(feld.hasAttribute('aria-valuemin')).toBe(false);
    expect(feld.hasAttribute('aria-valuemax')).toBe(false);
    act(() => wurzel.unmount());
    behaelter.remove();
  });
});
