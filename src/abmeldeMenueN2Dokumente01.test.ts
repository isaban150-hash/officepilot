/**
 * DOKUMENTE-01 N2 — das geöffnete Benutzermenü liegt über der Karte „Weiterarbeiten".
 *
 * WEISS-Befund: Mit sichtbarer Karte traf ein Klick auf „Abmelden" die Karte.
 * Ursache: `.app-shell` ist ein Flex-Container, und als Flex-Element bildete der
 * Kartenträger mit seinem z-index 40 (Rest der früheren Sticky-Fassung) einen
 * Stapelkontext über dem Kopf (z-index 10), in dem das Menü liegt. Bei
 * Flex-Elementen genügt dafür ein z-index ungleich `auto`, auch ohne
 * Positionierung. Geprüft wird die wirksame Regel; dass der Klick im echten
 * Browser trifft, belegt die Browserprüfung (Desktop und 390 px).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const SHELL_CSS = readFileSync(resolve(__dirname, 'styles/shell.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const INDEX_CSS = readFileSync(resolve(__dirname, 'index.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

/** Deklarationen der Regeln auf oberster Ebene für genau diesen Selektor, in Dateireihenfolge. */
function topLevelDeclarations(css: string, selector: string): Array<[string, string]> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rules = [...css.matchAll(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`, 'g'))];
  return rules.flatMap((rule) =>
    rule[1]
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf(':');
        return [part.slice(0, index).trim(), part.slice(index + 1).trim()] as [string, string];
      }),
  );
}

function effective(css: string, selector: string, property: string): string | undefined {
  return topLevelDeclarations(css, selector)
    .filter(([name]) => name === property)
    .map(([, value]) => value)
    .pop();
}

describe('DOKUMENTE-01 N2 — Abmeldemenü über der Karte „Weiterarbeiten"', () => {
  it('N2a der Kartenträger bildet keinen eigenen Stapelkontext', () => {
    expect(effective(SHELL_CSS, '.ui-session-recovery-host', 'position')).toBe('static');
    expect(effective(SHELL_CSS, '.ui-session-recovery-host', 'z-index')).toBe('auto');
  });

  it('N2b keine Medienabfrage gibt dem Träger wieder einen z-index', () => {
    const nested = [...SHELL_CSS.matchAll(/\n[ \t]+\.ui-session-recovery-host\s*\{([^}]*)\}/g)].map((rule) => rule[1]);
    expect(nested.length, 'Gegenprobe: die Regel in der Medienabfrage wird gefunden').toBeGreaterThan(0);
    expect(nested.filter((body) => /z-index\s*:/.test(body) && !/z-index\s*:\s*auto/.test(body))).toEqual([]);
  });

  it('N2c Gegenprobe der Voraussetzungen: Flex-Container und Kopf mit eigener Ebene', () => {
    expect(effective(INDEX_CSS, '.app-shell', 'display')).toBe('flex');
    expect(Number(effective(INDEX_CSS, '.app-shell__top', 'z-index'))).toBeGreaterThan(0);
    expect(effective(SHELL_CSS, '.app-shell__top', 'z-index')).toBeUndefined();
  });
});
