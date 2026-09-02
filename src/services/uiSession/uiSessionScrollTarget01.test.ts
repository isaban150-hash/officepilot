/**
 * MOBILE-RESUME-STATE-02D — die Scrollposition wird auf der Ebene gemessen und
 * gesetzt, die tatsächlich scrollt.
 *
 * Belegter Realbefund auf iPhone/Safari: Nach einem längeren App-Wechsel baut
 * Safari die Seite neu auf. Der ungespeicherte Firmendaten-Entwurf kommt zurück
 * (MOBILE-RESUME-STATE-02B wirkt), die Seite startet aber wieder ganz oben.
 *
 * Ursache: `.app-shell__main` existiert in der Shell immer, scrollt aber nicht
 * — die Höhenkette deckelt nichts, also wächst die Seite und das **Dokument**
 * scrollt. `readMainScrollTop` las trotzdem `main.scrollTop` und bekam `0`;
 * `applyMainScrollTop` klemmte auf `scrollHeight - clientHeight`, ebenfalls `0`.
 *
 * Diese Datei prüft genau die Zielauswahl. Die Testumgebung besitzt kein echtes
 * Layout — `scrollHeight`/`clientHeight` und die Scrollpositionen werden deshalb
 * ausdrücklich gesetzt. Das ist keine Simulation eines Browsers, sondern die
 * kontrollierte Beschreibung der beiden Lagen, um die es geht.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applyMainScrollTop,
  captureAndPersistUiSession,
  readMainScrollTop,
} from './uiSessionCapture';
import { resetUiSessionLiveState } from './uiSessionLiveState';
import { clearUiSessionSnapshot } from './uiSessionStore';
import { setActiveStorageScope } from '../storage/storageScopeService';

/** Setzt die Layoutmasse, die happy-dom sonst konstant auf 0 hält. */
function defineMetrics(element: HTMLElement, scrollHeight: number, clientHeight: number): void {
  Object.defineProperty(element, 'scrollHeight', { value: scrollHeight, configurable: true });
  Object.defineProperty(element, 'clientHeight', { value: clientHeight, configurable: true });
}

/** Die Dokumentebene, so wie die Produktion sie auflöst. */
function documentScroller(): HTMLElement {
  return (document.scrollingElement ?? document.documentElement) as HTMLElement;
}

function setDocumentScroll(top: number, scrollHeight = 2000, clientHeight = 800): void {
  const scroller = documentScroller();
  defineMetrics(scroller, scrollHeight, clientHeight);
  scroller.scrollTop = top;
}

function addMain(): HTMLElement {
  const main = document.createElement('main');
  main.className = 'app-shell__main';
  document.body.appendChild(main);
  return main;
}

/**
 * `applyMainScrollTop` wartet zwei Bildwiederholungen ab — dieselbe Struktur wie
 * bisher, 02D fasst sie nicht an. Der Test treibt sie deterministisch an,
 * statt auf eine Wartezeit zu setzen.
 */
async function flushFrames(): Promise<void> {
  for (let round = 0; round < 4; round += 1) {
    await new Promise((done) => requestAnimationFrame(() => done(null)));
  }
}

beforeEach(() => {
  document.body.innerHTML = '';
  const scroller = documentScroller();
  defineMetrics(scroller, 0, 0);
  scroller.scrollTop = 0;
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('MOBILE-RESUME-STATE-02D — Auswahl der scrollenden Ebene', () => {
  /*
   * R1 — der zentrale Rot-Beleg.
   *
   * `.app-shell__main` ist da, hat aber keinen scrollbaren Inhalt. Genau die
   * Lage der echten App. Vor 02D lieferte `readMainScrollTop()` hier `0`.
   */
  it('R1: das Dokument scrollt, main nicht — gelesen wird der Dokumentwert', () => {
    const main = addMain();
    defineMetrics(main, 800, 800); // scrollHeight === clientHeight
    setDocumentScroll(320);

    expect(readMainScrollTop()).toBe(320);
  });

  // R2 — und dieselbe Ebene wird auch beschrieben.
  it('R2: angewandt wird auf der Dokumentebene', async () => {
    const main = addMain();
    defineMetrics(main, 800, 800);
    setDocumentScroll(0);

    applyMainScrollTop(320);
    await flushFrames();

    expect(documentScroller().scrollTop).toBe(320);
    expect(main.scrollTop).toBe(0);
  });

  /*
   * R3 — der innere Container bleibt unterstützt.
   *
   * Bekäme das Layout später einen echten inneren Scrollbereich, muss dieser
   * gewinnen. Der Fix ist keine pauschale Umstellung auf das Dokument.
   */
  it('R3: ein echt scrollendes main wird gelesen, nicht das Dokument', () => {
    const main = addMain();
    defineMetrics(main, 2400, 800);
    main.scrollTop = 180;
    setDocumentScroll(999);

    expect(readMainScrollTop()).toBe(180);
  });

  // R4
  it('R4: ein echt scrollendes main wird beschrieben, nicht das Dokument', async () => {
    const main = addMain();
    defineMetrics(main, 2400, 800);
    setDocumentScroll(0);

    applyMainScrollTop(220);
    await flushFrames();

    expect(main.scrollTop).toBe(220);
    expect(documentScroller().scrollTop).toBe(0);
  });

  // R5 — ohne Shell-Element gilt ebenfalls die Dokumentebene.
  it('R5: fehlt main, wird die Dokumentebene gelesen und gesetzt', async () => {
    expect(document.querySelector('.app-shell__main')).toBeNull();
    setDocumentScroll(140);

    expect(readMainScrollTop()).toBe(140);

    applyMainScrollTop(75);
    await flushFrames();
    expect(documentScroller().scrollTop).toBe(75);
  });

  // R6
  it('R6: ein negativer Wert erzeugt niemals eine negative Position', async () => {
    addMain();
    setDocumentScroll(0);

    applyMainScrollTop(-100);
    await flushFrames();

    expect(documentScroller().scrollTop).toBe(0);
    expect(readMainScrollTop()).toBeGreaterThanOrEqual(0);
  });

  /*
   * R7 — Klemmen, aber nicht falsch klemmen.
   *
   * Im inneren Container wird auf den verfügbaren Bereich begrenzt. Auf der
   * Dokumentebene wird ein `max` von 0 **nicht** als Grenze genommen: Genau
   * dieses Klemmen auf eine unbekannte Höhe war der zweite Teil des Fehlers.
   */
  it('R7: der innere Container klemmt auf seinen Bereich', async () => {
    const main = addMain();
    defineMetrics(main, 1000, 800); // maximal 200
    setDocumentScroll(0);

    applyMainScrollTop(5000);
    await flushFrames();

    expect(main.scrollTop).toBe(200);
  });

  it('R7b: unbekannte Dokumenthöhe klemmt nicht auf 0', async () => {
    addMain();
    const scroller = documentScroller();
    defineMetrics(scroller, 0, 0); // keine belastbaren Masse
    scroller.scrollTop = 0;

    applyMainScrollTop(320);
    await flushFrames();

    expect(scroller.scrollTop).toBe(320);
  });
});

describe('MOBILE-RESUME-STATE-02D — die Strecke bis in den Schnappschuss', () => {
  beforeEach(() => {
    setActiveStorageScope({ type: 'guest' });
    resetUiSessionLiveState();
    clearUiSessionSnapshot();
  });

  afterEach(() => {
    clearUiSessionSnapshot();
    resetUiSessionLiveState();
  });

  /*
   * R8 — nicht nur der Helfer, sondern der reale Weg.
   *
   * Der Tracker liest über `readMainScrollTop()` und reicht den Wert an
   * `captureAndPersistUiSession` weiter. Geprüft wird, dass der gemessene Wert
   * unverändert im Schnappschuss landet.
   */
  it('R8: der gemessene Dokumentwert steht im Schnappschuss', () => {
    const main = addMain();
    defineMetrics(main, 800, 800);
    setDocumentScroll(320);

    const snapshot = captureAndPersistUiSession({
      pathname: '/firmendaten',
      search: '',
      hash: '',
      historyKey: 'k1',
      mainScrollTop: readMainScrollTop(),
      userId: null,
      source: 'auto',
    });

    expect(snapshot.scroll.mainTop).toBe(320);
  });
});
