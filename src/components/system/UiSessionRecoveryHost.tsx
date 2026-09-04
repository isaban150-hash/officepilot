import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { useApp } from '../../context/AppContext';
import type { UiSessionSnapshot } from '../../types/uiSessionSnapshot';
import {
  acceptContinueWorking,
  applyUiSessionChrome,
  decideUiSessionRestore,
  discardUiSessionRestore,
} from '../../services/uiSession/uiSessionRestore';
import { setPendingUiSessionApply } from '../../services/uiSession/uiSessionLiveState';
import { buildUiSessionRouteKey } from '../../services/uiSession/uiSessionRoute';
import {
  clearUiSessionSnapshot,
  loadUiSessionSnapshot,
} from '../../services/uiSession/uiSessionStore';
import {
  discardUploadDraftForRecovery,
  loadPendingDocumentIntakeDraft,
} from '../../services/upload/uploadDraftService';
import { useUiSessionTracker } from '../../hooks/useUiSessionTracker';
import { ContinueWorkingCard } from './ContinueWorkingCard';

type BootDecision = {
  intent: 'silent' | 'offer' | 'ignore';
  snapshot: UiSessionSnapshot | null;
};

/** UPLOAD-DRAFT-RESUME-01C2 — opaque resume pointer written by DocumentUploadPage. */
const UPLOAD_DRAFT_DRAFT_KEY = 'pendingUploadDraftId';
const UPLOAD_DRAFT_QUERY_PARAM = 'draft';

function readUploadDraftId(snapshot: UiSessionSnapshot | null): string | null {
  const raw = snapshot?.drafts.values[UPLOAD_DRAFT_DRAFT_KEY];
  return typeof raw === 'string' && raw.trim() ? raw : null;
}

/**
 * After Auth → Workspace → Domain (AppShell mount):
 * evaluate UiSessionSnapshot → silent | Continue Working | ignore.
 * Also runs capture tracker.
 */
export function UiSessionRecoveryHost() {
  const { user } = useAuth();
  const { translate, showToast } = useApp();
  const location = useLocation();
  const navigate = useNavigate();
  const bootRef = useRef<BootDecision | null>(null);
  /** Der zuletzt entschiedene Arbeitsplatz — verhindert doppelte Entscheidungen. */
  const decidedRouteKeyRef = useRef<string | null>(null);
  /** Erst nach dem Commit angewandt, siehe Begründung an der Entscheidung. */
  const chromeToApplyRef = useRef<UiSessionSnapshot | null>(null);
  /**
   * The host is not remounted on navigation, so a candidate must be captured
   * during render — the tracker effect runs afterwards and may overwrite the
   * single slot with the new route. No setState here: only refs are filled.
   */
  const uploadCandidateRef = useRef<UiSessionSnapshot | null>(null);
  const candidateGenerationRef = useRef(0);
  const lastPathnameRef = useRef<string | null>(location.pathname);

  /** An upload draft is only offered after the full async check has passed. */
  const takeUploadCandidate = (snapshot: UiSessionSnapshot | null): boolean => {
    const draftId = readUploadDraftId(snapshot);
    if (!snapshot || !draftId) return false;
    // Already showing exactly this draft → nothing to offer.
    if (new URLSearchParams(location.search).get(UPLOAD_DRAFT_QUERY_PARAM) === draftId) {
      return false;
    }
    // Same page as the snapshot: the upload route restores itself, no card.
    if (snapshot.route.pathname === location.pathname) return false;
    uploadCandidateRef.current = snapshot;
    candidateGenerationRef.current += 1;
    return true;
  };

  /*
   * GLOBAL-WORKSPACE-CONTINUITY-01B — entschieden wird jetzt je Arbeitsplatz,
   * nicht mehr nur einmal beim Start.
   *
   * Vorher fiel die Entscheidung genau beim App-Boot. Wer innerhalb der App von
   * Vorgang A nach B und zurück ging, bekam deshalb **nie** eine Wiederaufnahme
   * — es gab keinen zweiten Entscheidungspunkt. Der Wächter hängt am
   * Arbeitsplatzschlüssel und nicht am Renderlauf: Dieselbe Route entscheidet
   * kein zweites Mal, eine Schleife kann also nicht entstehen.
   */
  const decisionRouteKey = buildUiSessionRouteKey(location.pathname, location.search);
  if (decidedRouteKeyRef.current !== decisionRouteKey) {
    decidedRouteKeyRef.current = decisionRouteKey;
    const decision = decideUiSessionRestore({
      userId: user?.id ?? null,
      currentPathname: location.pathname,
      currentSearch: location.search,
    });
    const isBoot = bootRef.current === null;
    bootRef.current = {
      intent: decision.intent,
      snapshot: decision.snapshot,
    };
    /*
     * Still: den Zeiger noch im Render setzen, damit Kindseiten ihn beim ersten
     * Rendern synchron abholen können.
     *
     * Das **Anwenden** des Chromes passiert dagegen erst im Effekt: Es
     * benachrichtigt die Abonnenten sofort, und der Tracker würde dann mitten
     * im Render mit seiner noch alten Adresse speichern — der Arbeitsstand der
     * einen Seite landete unter dem Schlüssel der anderen. Genau das trat beim
     * Wechsel zwischen zwei Vorgängen auf.
     */
    if (decision.intent === 'silent' && decision.snapshot) {
      setPendingUiSessionApply(decision.snapshot);
      chromeToApplyRef.current = decision.snapshot;
    }
    /*
     * Die „Weiterarbeiten"-Karte bleibt eine Startentscheidung. Sie mitten in
     * der Navigation einzublenden wäre eine neue, ungefragte Unterbrechung —
     * dieser Block erweitert die stille Wiederaufnahme, nicht das Angebot.
     */
    if (isBoot && decision.intent === 'offer') {
      takeUploadCandidate(decision.snapshot);
    }
  }

  const [offer, setOffer] = useState<UiSessionSnapshot | null>(() => {
    const boot = bootRef.current;
    if (boot?.intent !== 'offer' || !boot.snapshot) return null;
    // Draft offers wait for validation; every other snapshot keeps the old path.
    return readUploadDraftId(boot.snapshot) ? null : boot.snapshot;
  });

  const [candidateGeneration, setCandidateGeneration] = useState(0);

  if (lastPathnameRef.current !== location.pathname) {
    lastPathnameRef.current = location.pathname;
    // Reuse the existing decision — it owns scope, user, workspace, TTL and
    // route rules. A pure query change on the upload route yields no offer.
    const decision = decideUiSessionRestore({
      userId: user?.id ?? null,
      currentPathname: location.pathname,
      currentSearch: location.search,
    });
    if (decision.intent !== 'offer' || !takeUploadCandidate(decision.snapshot)) {
      uploadCandidateRef.current = null;
    }
  }

  useUiSessionTracker();

  /*
   * GLOBAL-WORKSPACE-CONTINUITY-01B — Chrome und Scrollposition nach dem
   * Commit anwenden, wenn Tracker und Adresse wieder übereinstimmen.
   */
  useEffect(() => {
    const snapshot = chromeToApplyRef.current;
    if (!snapshot) return;
    chromeToApplyRef.current = null;
    applyUiSessionChrome(snapshot);
  });

  // Publish the render-time candidate into state without setState-in-render.
  useEffect(() => {
    if (candidateGenerationRef.current !== candidateGeneration) {
      setCandidateGeneration(candidateGenerationRef.current);
    }
  });

  /** Async validation: only a fully loadable draft may be offered. */
  useEffect(() => {
    const candidate = uploadCandidateRef.current;
    if (!candidate) return;
    const draftId = readUploadDraftId(candidate);
    if (!draftId) return;

    let cancelled = false;
    const pathnameAtStart = location.pathname;
    void loadPendingDocumentIntakeDraft(draftId)
      .then((result) => {
        // A late result must not open a card on another route.
        if (cancelled || lastPathnameRef.current !== pathnameAtStart) return;
        if (!result.success) {
          /**
           * Missing, expired, schema, lifecycle, file_missing or mismatch: no card,
           * no navigation, no draft deletion, no foreign scope touched.
           *
           * Technical invalidity is not a user decision — clearing must not go
           * through discardUiSessionRestore(), which would latch
           * continueWorkingDismissed and suppress later valid cards.
           */
          const current = loadUiSessionSnapshot();
          if (current?.id === candidate.id) {
            clearUiSessionSnapshot();
            setPendingUiSessionApply(null);
          }
          uploadCandidateRef.current = null;
          return;
        }
        setOffer(candidate);
      })
      .catch(() => {
        // Unexpected IndexedDB failure: no card, but keep the snapshot as a retry
        // pointer and never latch the dismiss flag.
        uploadCandidateRef.current = null;
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by candidate generation
  }, [candidateGeneration]);

  /** Landing on the offered draft itself makes the card obsolete. */
  useEffect(() => {
    if (!offer) return;
    const offeredDraftId = readUploadDraftId(offer);
    if (!offeredDraftId) return;
    if (new URLSearchParams(location.search).get(UPLOAD_DRAFT_QUERY_PARAM) === offeredDraftId) {
      uploadCandidateRef.current = null;
      setOffer(null);
    }
  }, [offer, location.search]);

  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) {
        setOffer(null);
      }
    };
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, []);

  const discardInFlightRef = useRef(false);

  const handleDiscard = async (snapshot: UiSessionSnapshot) => {
    if (discardInFlightRef.current) return;
    discardInFlightRef.current = true;
    try {
      const draftId = readUploadDraftId(snapshot);
      if (!draftId) {
        discardUiSessionRestore();
        uploadCandidateRef.current = null;
        setOffer(null);
        return;
      }

      const outcome = await discardUploadDraftForRecovery(draftId);
      if (outcome === 'retry') {
        // File or persistence failed — keep the card and the retry pointer.
        showToast(translate('persist.failed.userAction'));
        return;
      }

      // discarded | not_found → the marker is obsolete either way.
      const current = loadUiSessionSnapshot();
      if (!current || current.id === snapshot.id) discardUiSessionRestore();
      uploadCandidateRef.current = null;
      setOffer(null);
    } finally {
      discardInFlightRef.current = false;
    }
  };

  if (!offer) return null;

  return (
    <div className="ui-session-recovery-host" data-testid="ui-session-recovery-host">
      <ContinueWorkingCard
        snapshot={offer}
        translate={translate}
        onContinue={() => {
          const target = `${offer.route.pathname}${offer.route.search}${offer.route.hash}`;
          acceptContinueWorking(offer);
          uploadCandidateRef.current = null;
          setOffer(null);
          navigate(target);
        }}
        onDiscard={() => {
          void handleDiscard(offer);
        }}
      />
    </div>
  );
}
