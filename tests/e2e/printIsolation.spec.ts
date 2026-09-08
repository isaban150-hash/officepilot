import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * INVOICE-MOBILE-PRINT-RENDERING-01B — die Print-Isolation, im echten Browser.
 *
 * Der Realbefund auf dem iPhone war, dass „Drucken" die OfficePilot-Oberfläche
 * ausgab statt der Rechnung. Die Ursachenanalyse und der Fix liegen in
 * `d9f68dc`; abgesichert waren sie bis hierher nur über die **Struktur** des
 * Quelltextes — DOM-Reihenfolge und Regeltext in `index.css`.
 *
 * Das reicht für die entscheidende Frage nicht aus: Ob eine Kaskade aus
 * „alles ausblenden" plus „den Weg zurück wieder öffnen" tatsächlich trägt,
 * beantwortet nur eine echte CSS-Engine. JSDOM/happy-dom rechnet keine
 * Kaskade, und eine nachgebaute Engine wäre wertlos.
 *
 * Dieser Test lädt deshalb **die echte `index.css`** in Microsoft Edge, baut
 * die **echte DOM-Verschachtelung** aus `AppShell` und `InvoiceDetailPage`
 * nach, schaltet auf `@media print` und liest `getComputedStyle`. Nichts wird
 * simuliert — nur die Anwendung selbst wird nicht gebootet, weil der
 * Rechnungsbereich eine Anmeldung verlangt.
 */
const css = readFileSync(resolve(process.cwd(), 'src/index.css'), 'utf8');

/**
 * Die Verschachtelung entspricht `AppShell.tsx` (Kopf, Banner, Suche, Körper
 * mit Seitennavigation und Hauptbereich, Fussnavigation, Overlays) und
 * `InvoiceDetailPage.tsx` (Werkzeugleiste mit `no-print`, danach das
 * Rechnungsdokument als Geschwister, danach das Zahlungsformular).
 *
 * `--screen-hidden` ist gesetzt: der Normalfall, in dem „Mehr anzeigen"
 * geschlossen ist. Genau dieser Fall war auf dem Gerät kaputt.
 */
const APP_MARKUP = `
<div class="app-shell">
  <div class="app-shell__top"><span class="app-shell__brand">OfficePilot</span></div>
  <div class="persistence-failure-banner">Cloud-Sicherung steht aus <a>Jetzt sichern</a></div>
  <div class="beta-mode-banner">Beta</div>
  <div class="ui-session-recovery-host">Recovery</div>
  <div class="app-shell__search" data-testid="app-shell-search">Suche</div>
  <div class="app-shell__body">
    <nav class="sidebar-nav" data-testid="sidebar-nav">Navigation</nav>
    <main class="app-shell__main">
      <div class="page page--invoice-detail" data-testid="invoice-detail-page">
        <div class="invoice-detail__toolbar no-print">
          <button class="back-link">Zurück</button>
          <div class="invoice-print-actions"><button data-testid="invoice-print">Drucken</button></div>
          <div class="show-more-section"><button data-testid="show-more-toggle">Mehr anzeigen</button></div>
        </div>
        <div
          class="invoice-detail__document invoice-print-document invoice-print-document--screen-hidden"
          data-testid="invoice-print-document"
        >
          <article class="invoice-document">
            <div class="invoice-document__sheet" data-testid="invoice-sheet">
              <span data-testid="invoice-number">2026-0011</span>
            </div>
          </article>
        </div>
        <div class="invoice-detail__payment">Zahlung erfassen</div>
      </div>
    </main>
  </div>
  <nav class="bottom-nav" data-testid="bottom-nav">Untere Navigation</nav>
  <div class="toast">Hinweis</div>
</div>
`;

/** Sichtbar im Sinne des Druckbilds: kein Vorfahre und kein Knoten auf `none`. */
async function isRendered(page: import('@playwright/test').Page, testId: string) {
  return page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`);
    if (!el) return { found: false, visible: false, hiddenBy: 'nicht im DOM' };
    let node: Element | null = el;
    while (node && node !== document.documentElement) {
      if (getComputedStyle(node).display === 'none') {
        return {
          found: true,
          visible: false,
          hiddenBy: node === el ? 'sich selbst' : (node.className || node.tagName),
        };
      }
      node = node.parentElement;
    }
    return { found: true, visible: true, hiddenBy: '' };
  }, testId);
}

test.describe('PRINT-ISOLATION — echte Kaskade unter @media print', () => {
  test.beforeEach(async ({ page }) => {
    await page.setContent(`<!doctype html><html><head></head><body>${APP_MARKUP}</body></html>`);
    await page.addStyleTag({ content: css });
  });

  /**
   * INVOICE-MOBILE-PRINT-RENDERING-01C — Gegenprobe gegen einen Scheinnachweis.
   *
   * Wäre die Geräteemulation wirkungslos, liefen die Zusicherungen unten
   * einfach ein zweites Mal auf dem Desktop und die grüne Zeile bewiese nichts.
   * Dieser Test läuft nur im Android-Projekt und belegt, dass Viewport,
   * Kennung und mobile Media-Queries tatsächlich aktiv sind.
   */
  test('P-M: die Mobile-Emulation ist wirklich aktiv', async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'android', 'Nur im Android-Projekt aussagekräftig.');

    const viewport = page.viewportSize();
    expect(viewport?.width, 'Kein mobiler Viewport').toBe(360);

    const agent = await page.evaluate(() => navigator.userAgent);
    expect(agent).toContain('Android');
    expect(agent).toContain('Mobile');

    await page.emulateMedia({ media: 'screen' });
    /*
     * Der eigentliche Beweis: `index.css:609` blendet die Fussnavigation ab
     * Desktop-Breite aus. Ist sie hier sichtbar, greifen die mobilen
     * Media-Queries — und die Print-Zusicherungen prüfen wirklich den mobilen
     * Kaskadenzustand.
     */
    expect(
      (await isRendered(page, 'bottom-nav')).visible,
      'Die Fussnavigation fehlt — der Lauf ist nicht mobil',
    ).toBe(true);
  });

  test('P-A: am Bildschirm bleibt das Rechnungsdokument verborgen', async ({ page }) => {
    await page.emulateMedia({ media: 'screen' });

    /*
     * Die Bildschirm-UX darf sich nicht verändert haben: Solange „Mehr
     * anzeigen" zu ist, sieht der Nutzer das Dokument nicht — es liegt nur im
     * DOM, damit der Druck es findet.
     */
    const doc = await isRendered(page, 'invoice-print-document');
    expect(doc.found, 'Das Dokument fehlt im DOM').toBe(true);
    expect(doc.visible, 'Das Dokument ist am Bildschirm sichtbar geworden').toBe(false);

    /*
     * Gegenprobe: Am Bildschirm ist das App-Chrome da. Bewusst nur die Suche —
     * die Fussnavigation ist ab Desktop-Breite ohnehin ausgeblendet
     * (`index.css:609`), das ist Layout und sagt über den Druck nichts aus.
     */
    expect((await isRendered(page, 'app-shell-search')).visible).toBe(true);
  });

  test('P-B: im Rechnungsdruck ist das Dokument sichtbar — kein Vorfahre verschluckt es', async ({
    page,
  }) => {
    await page.emulateMedia({ media: 'print' });
    await page.evaluate(() => document.body.classList.add('invoice-print-active'));

    /*
     * Der Kern des Einwands aus dem Auftrag: Eine Kaskade, die einen Vorfahren
     * auf `display:none` setzt und den Nachfahren wieder einblenden will,
     * funktioniert nicht. Hier wird deshalb die **ganze Kette** geprüft — die
     * Hilfsfunktion läuft bis zum `<html>` hinauf und meldet den ersten
     * ausgeblendeten Knoten namentlich.
     */
    const doc = await isRendered(page, 'invoice-print-document');
    expect(doc.found).toBe(true);
    expect(
      doc.visible,
      `Das Rechnungsdokument wird ausgeblendet durch: ${doc.hiddenBy}`,
    ).toBe(true);

    // Auch der eigentliche Beleginhalt, nicht nur der Container.
    expect((await isRendered(page, 'invoice-sheet')).visible).toBe(true);
    expect((await isRendered(page, 'invoice-number')).visible).toBe(true);
  });

  test('P-C: im Rechnungsdruck verschwindet das gesamte App-Chrome', async ({ page }) => {
    await page.emulateMedia({ media: 'print' });
    await page.evaluate(() => document.body.classList.add('invoice-print-active'));

    for (const id of [
      'app-shell-search',
      'sidebar-nav',
      'bottom-nav',
      'invoice-print',
      'show-more-toggle',
    ]) {
      const state = await isRendered(page, id);
      expect(state.visible, `${id} wird mitgedruckt`).toBe(false);
    }
  });

  test('P-D: auch namenlose neue Chrome-Bereiche fallen heraus', async ({ page }) => {
    /*
     * Die eigentliche Zusicherung gegen ein Wiederauftreten: Eine Komponente,
     * die es heute noch nicht gibt und in keiner Ausschlussliste steht, darf
     * nicht im Druck erscheinen. Sie wird hier als unbekanntes Kind der
     * App-Shell eingehängt.
     */
    await page.evaluate(() => {
      const shell = document.querySelector('.app-shell')!;
      const future = document.createElement('div');
      future.className = 'some-future-banner';
      future.setAttribute('data-testid', 'future-chrome');
      future.textContent = 'Neue Komponente von morgen';
      shell.insertBefore(future, shell.firstChild);
    });

    await page.emulateMedia({ media: 'print' });
    await page.evaluate(() => document.body.classList.add('invoice-print-active'));

    const future = await isRendered(page, 'future-chrome');
    expect(future.found).toBe(true);
    expect(future.visible, 'Eine unbekannte Chrome-Komponente wird mitgedruckt').toBe(false);

    // Und das Dokument bleibt davon unberührt sichtbar.
    expect((await isRendered(page, 'invoice-print-document')).visible).toBe(true);
  });

  test('P-E: ohne die Body-Klasse greift weiterhin die benannte Liste', async ({ page }) => {
    /*
     * Ein Druck über Strg+P setzt `invoice-print-active` nicht. Dann trägt die
     * ältere Positivliste — sie wurde bewusst nicht entfernt.
     */
    await page.emulateMedia({ media: 'print' });

    for (const id of ['app-shell-search', 'sidebar-nav', 'bottom-nav', 'invoice-print']) {
      expect((await isRendered(page, id)).visible, `${id} ohne Body-Klasse sichtbar`).toBe(false);
    }

    /*
     * 01C — die zweite Hälfte, die bisher fehlte: Der Rückfallpfad muss nicht
     * nur das Chrome ausblenden, sondern die Rechnung auch **zeigen**. Ein
     * leeres Blatt wäre genauso unbrauchbar wie ein Blatt voller App.
     */
    const doc = await isRendered(page, 'invoice-print-document');
    expect(doc.visible, `Ohne Body-Klasse verdeckt: ${doc.hiddenBy}`).toBe(true);
    expect((await isRendered(page, 'invoice-number')).visible).toBe(true);
  });
});
