import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { Button } from '../components/ui/Button';
import { DocumentLanguage } from '../components/system/DocumentLanguage';
import { SkipLink } from '../components/system/SkipLink';
import { useOptionalApp } from '../context/AppContext';
import { t, type TranslationKey } from '../i18n';
import {
  confirmReplyToToken,
  readReplyToTokenFromHash,
  type ReplyToConfirmResult,
} from '../services/delivery/replyToConfirmationService';

/**
 * EINRICHTUNG-01 (AP6; Vertrag 1.22 E-03, K4) — Bestätigungsseite der Antwortadresse (B2-Fläche, Vertrag 1.14).
 *
 * Erreichbar ohne Anmeldung. Das Token steht im Fragment des Links (`#token=…`) und wird nach dem Lesen aus der
 * Adresszeile genommen. Der Seitenaufruf allein bestätigt nichts (auch nicht durch eine Link-Vorschau): Erst
 * „Adresse bestätigen“ sendet ein POST an die Edge Function. Die Seite zeigt höchstens die maskierte Adresse — keinen
 * Betrieb, keine Geschäftsdaten, keine Sitzung.
 */
export const REPLY_TO_CONFIRM_ROUTE = '/antwortadresse-bestaetigen';

type Phase = { kind: 'ready' } | { kind: 'busy' } | { kind: 'done'; result: ReplyToConfirmResult };

/** Ohne App-Rahmen (die Seite steht vor Anmeldung und Gate): Sprache des Browsers, sonst Deutsch. */
function browserLanguage(): 'de' | 'tr' | 'bg' {
  const lang = typeof navigator === 'undefined' ? '' : (navigator.language ?? '').toLowerCase();
  return lang.startsWith('tr') ? 'tr' : lang.startsWith('bg') ? 'bg' : 'de';
}

export function ReplyToConfirmPage() {
  const app = useOptionalApp();
  const language = app?.language ?? browserLanguage();
  const tr = (key: TranslationKey) => t(key, language);
  const location = useLocation();
  const tokenRef = useRef<string | null>(readReplyToTokenFromHash(location.hash));
  const [phase, setPhase] = useState<Phase>({ kind: 'ready' });

  useEffect(() => {
    // Das Token nicht in der Adresszeile stehen lassen (Verlauf, Bildschirmfreigabe, Weitergabe).
    if (typeof window !== 'undefined' && window.location.hash) {
      window.history.replaceState(window.history.state, '', window.location.pathname);
    }
  }, []);

  const token = tokenRef.current;

  const confirm = async () => {
    if (!token || phase.kind === 'busy') return;
    setPhase({ kind: 'busy' });
    const result = await confirmReplyToToken(token);
    setPhase({ kind: 'done', result });
  };

  let message: string | null = null;
  let tone: 'ok' | 'error' = 'error';
  if (!token) {
    message = tr('replyToConfirm.missingToken');
  } else if (phase.kind === 'done') {
    const { result } = phase;
    if (result.ok) {
      tone = 'ok';
      message = tr('replyToConfirm.confirmed').replace('{address}', result.address ?? '—');
    } else {
      message = tr(
        result.reason === 'rate_limited'
          ? 'replyToConfirm.rateLimited'
          : result.reason === 'unavailable'
            ? 'replyToConfirm.unavailable'
            : 'replyToConfirm.invalid',
      );
    }
  }

  const finished = phase.kind === 'done' && phase.result.ok;

  return (
    <div className="system-page" data-testid="reply-to-confirm-page">
      {/* EINRICHTUNG-01 (AP9; 1.31, Q-03) — die Seite steht vor Anmeldung und App-Rahmen. */}
      {app ? null : <DocumentLanguage language={language} />}
      {/* EINRICHTUNG-01 (AP9-Nacharbeit; 1.32) — erstes fokussierbares Element: Sprung zur Überschrift der Karte. */}
      <SkipLink
        href="#reply-to-confirm-title"
        label={tr('a11y.skipToContent')}
        findTarget={() => document.getElementById('reply-to-confirm-title')}
      />
      <div className="system-page__card">
        <h1 className="system-page__title" id="reply-to-confirm-title" tabIndex={-1}>
          {tr('replyToConfirm.title')}
        </h1>
        <p className="system-page__text">{tr('replyToConfirm.intro')}</p>
        {message ? (
          <p
            className={tone === 'ok' ? 'auth-form__success' : 'auth-form__error'}
            role={tone === 'ok' ? 'status' : 'alert'}
            data-testid="reply-to-confirm-result"
            data-outcome={phase.kind === 'done' ? (phase.result.ok ? phase.result.status : phase.result.reason) : 'missing_token'}
          >
            {message}
          </p>
        ) : null}
        {token && !finished ? (
          <Button
            type="button"
            fullWidth
            loading={phase.kind === 'busy'}
            disabled={phase.kind === 'busy'}
            onClick={() => void confirm()}
            data-testid="reply-to-confirm-action"
          >
            {tr('replyToConfirm.action')}
          </Button>
        ) : null}
        <p className="system-page__text">
          {/* Ganzer Seitenwechsel: die Seite steht vor Anmeldung und Gate (RootShell), der App-Rahmen lädt neu. */}
          <a href="/" data-testid="reply-to-confirm-home">
            {tr('replyToConfirm.toApp')}
          </a>
        </p>
      </div>
    </div>
  );
}
