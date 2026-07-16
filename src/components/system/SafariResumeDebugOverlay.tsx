import { useEffect, useState, type CSSProperties } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';

export const SAFARI_RESUME_DEBUG_PARAM = 'debugSafariResume';

export function isSafariResumeDebugEnabled(search: string): boolean {
  return new URLSearchParams(search).get(SAFARI_RESUME_DEBUG_PARAM) === '1';
}

type SafariResumeSnapshot = {
  path: string;
  visibilityState: DocumentVisibilityState;
  lastEvent: string;
  lastEventAt: string;
  pageshowPersisted: string;
  pagehidePersisted: string;
  innerHeight: number;
  visualViewportHeight: string;
  shellHeight: number | null;
  bodyHeight: number | null;
  mainHeight: number | null;
  mainScrollHeight: number | null;
  mainDisplay: string;
  mainVisibility: string;
  mainOverflowX: string;
  mainOverflowY: string;
  heuteInDom: boolean;
  ablageInDom: boolean;
  ablageDetailInDom: boolean;
};

function nowStamp(): string {
  return new Date().toISOString().slice(11, 23);
}

function readElementHeight(el: Element | null): number | null {
  return el instanceof HTMLElement ? el.clientHeight : null;
}

function captureSnapshot(
  path: string,
  lastEvent: string,
  pageshowPersisted: string,
  pagehidePersisted: string,
): SafariResumeSnapshot {
  const shell = document.querySelector('.app-shell');
  const body = document.querySelector('.app-shell__body');
  const main = document.querySelector('.app-shell__main');
  const mainStyle = main instanceof HTMLElement ? getComputedStyle(main) : null;
  const vv = window.visualViewport;

  return {
    path,
    visibilityState: document.visibilityState,
    lastEvent,
    lastEventAt: nowStamp(),
    pageshowPersisted,
    pagehidePersisted,
    innerHeight: window.innerHeight,
    visualViewportHeight: vv ? String(Math.round(vv.height)) : 'n/a',
    shellHeight: readElementHeight(shell),
    bodyHeight: readElementHeight(body),
    mainHeight: readElementHeight(main),
    mainScrollHeight: main instanceof HTMLElement ? main.scrollHeight : null,
    mainDisplay: mainStyle?.display ?? 'n/a',
    mainVisibility: mainStyle?.visibility ?? 'n/a',
    mainOverflowX: mainStyle?.overflowX ?? 'n/a',
    mainOverflowY: mainStyle?.overflowY ?? 'n/a',
    heuteInDom: Boolean(document.querySelector('[data-testid="heute-page"]')),
    ablageInDom: Boolean(document.querySelector('[data-testid="ablage-page"]')),
    ablageDetailInDom: Boolean(document.querySelector('[data-testid="ablage-detail-page"]')),
  };
}

const overlayStyle: CSSProperties = {
  position: 'fixed',
  left: 0,
  right: 0,
  bottom: 0,
  zIndex: 99999,
  maxHeight: '42vh',
  overflow: 'auto',
  margin: 0,
  padding: '6px 8px',
  background: 'rgba(15, 23, 42, 0.92)',
  color: '#f8fafc',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: '11px',
  lineHeight: 1.35,
  pointerEvents: 'none',
  borderTop: '1px solid rgba(148, 163, 184, 0.5)',
};

const rowStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  gap: '8px',
  whiteSpace: 'nowrap',
};

function Row({ label, value }: { label: string; value: string | number | boolean | null }) {
  return (
    <div style={rowStyle}>
      <span>{label}</span>
      <strong data-testid={`safari-resume-debug-${label}`}>{String(value)}</strong>
    </div>
  );
}

export function SafariResumeDebugOverlay() {
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const enabled = isSafariResumeDebugEnabled(searchParams.toString());
  const [snapshot, setSnapshot] = useState<SafariResumeSnapshot | null>(null);

  useEffect(() => {
    if (!enabled) {
      setSnapshot(null);
      return;
    }

    let showPersisted = 'n/a';
    let hidePersisted = 'n/a';

    const refresh = (eventName: string) => {
      setSnapshot(captureSnapshot(location.pathname, eventName, showPersisted, hidePersisted));
    };

    refresh('mount');

    const onVisibility = () => refresh(`visibilitychange:${document.visibilityState}`);
    const onPageShow = (event: PageTransitionEvent) => {
      showPersisted = String(Boolean(event.persisted));
      refresh(`pageshow persisted=${showPersisted}`);
    };
    const onPageHide = (event: PageTransitionEvent) => {
      hidePersisted = String(Boolean(event.persisted));
      refresh(`pagehide persisted=${hidePersisted}`);
    };
    const onFocus = () => refresh('focus');
    const onBlur = () => refresh('blur');
    const onResize = () => refresh('resize');
    const onVisualViewportResize = () => refresh('visualViewport.resize');

    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    window.addEventListener('resize', onResize);
    window.visualViewport?.addEventListener('resize', onVisualViewportResize);

    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('resize', onResize);
      window.visualViewport?.removeEventListener('resize', onVisualViewportResize);
    };
  }, [enabled, location.pathname]);

  if (!enabled || !snapshot) return null;

  return (
    <aside
      data-testid="safari-resume-debug-overlay"
      aria-label="Safari resume diagnostics"
      style={overlayStyle}
    >
      <div style={{ fontWeight: 700, marginBottom: 4 }}>Safari Resume Debug</div>
      <Row label="path" value={snapshot.path} />
      <Row label="visibility" value={snapshot.visibilityState} />
      <Row label="lastEvent" value={snapshot.lastEvent} />
      <Row label="lastEventAt" value={snapshot.lastEventAt} />
      <Row label="pageshow.persisted" value={snapshot.pageshowPersisted} />
      <Row label="pagehide.persisted" value={snapshot.pagehidePersisted} />
      <Row label="innerHeight" value={snapshot.innerHeight} />
      <Row label="visualViewport.height" value={snapshot.visualViewportHeight} />
      <Row label="shell.clientHeight" value={snapshot.shellHeight} />
      <Row label="body.clientHeight" value={snapshot.bodyHeight} />
      <Row label="main.clientHeight" value={snapshot.mainHeight} />
      <Row label="main.scrollHeight" value={snapshot.mainScrollHeight} />
      <Row label="main.display" value={snapshot.mainDisplay} />
      <Row label="main.visibility" value={snapshot.mainVisibility} />
      <Row label="main.overflowX" value={snapshot.mainOverflowX} />
      <Row label="main.overflowY" value={snapshot.mainOverflowY} />
      <Row label="heute-page" value={snapshot.heuteInDom} />
      <Row label="ablage-page" value={snapshot.ablageInDom} />
      <Row label="ablage-detail-page" value={snapshot.ablageDetailInDom} />
    </aside>
  );
}
