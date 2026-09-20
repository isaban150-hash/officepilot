/**
 * DOKUMENTVERSTAENDNIS-01C — der Verstehen-Bereich.
 *
 * Ein einziger ruhiger Block, bewusst **keine Kartenwand**: Der Betrieb soll
 * mit einem Blick sehen, worum es geht, ob er etwas tun muss und bis wann.
 * Alles Weitere steht darunter, in derselben Reihenfolge, in der man es fragt.
 *
 * Der Block zeigt ausschliesslich, was der semantische Kern aus 01B belegen
 * kann. Ist nichts belegbar, erscheint er gar nicht — eine leere Überschrift
 * wäre ein Versprechen ohne Inhalt.
 *
 * Er führt **nichts aus**. Kunde und Auftrag sind Vorschläge; bestätigt wird
 * über die vorhandenen Wege, nicht hier.
 */
import { useMemo } from 'react';
import { useApp } from '../../context/AppContext';
import {
  buildDocumentMeaningView,
  buildDocumentMeaningViewFromCore,
} from '../../services/document/documentMeaningPresentationService';
import type { DocumentSemanticCore } from '../../types/documentSemanticCore';
import type { MeaningCandidateRow } from '../../services/document/documentMeaningPresentationService';

interface DocumentMeaningPanelProps {
  /** Der Volltext des Schreibens, falls er vorliegt. */
  text?: string;
  /**
   * Ein bereits berechneter semantischer Kern.
   *
   * Ein gespeicherter Eingangsposten traegt seinen Volltext nicht mehr; sein
   * Kern liegt aber im Arbeitsstand der Analyse. Dann kommt er von dort, und
   * es wird nichts neu gelesen.
   */
  core?: DocumentSemanticCore | null;
  /** Der erkannte Absender, falls bekannt. */
  sender?: string;
  testId?: string;
}

export function DocumentMeaningPanel({ text, core, sender, testId }: DocumentMeaningPanelProps) {
  const { translate } = useApp();
  const view = useMemo(() => {
    /* Der Volltext ist die bessere Quelle: Er folgt den heutigen Leseregeln. */
    if (text && text.trim()) return buildDocumentMeaningView({ text, sender });
    if (core) return buildDocumentMeaningViewFromCore(core);
    return null;
  }, [text, core, sender]);

  if (!view) return null;

  if (view.isEmpty) return null;

  const kandidatenBlock = (
    titel: string,
    zeilen: MeaningCandidateRow[],
    art: 'customer' | 'vorgang',
  ) => {
    if (zeilen.length === 0) return null;
    return (
      <section className="document-meaning__section">
        <h3 className="document-meaning__label">{titel}</h3>
        <ul className="document-meaning__list" data-testid={`document-meaning-${art}-candidates`}>
          {zeilen.map((zeile) => (
            <li key={zeile.id} className="document-meaning__candidate">
              <span className="document-meaning__candidate-name">{zeile.name}</span>
              {zeile.reason ? (
                <span className="document-meaning__candidate-reason">{zeile.reason}</span>
              ) : null}
              {zeile.uncertain ? (
                <span className="document-meaning__hint">
                  {translate('documentMeaning.candidate.uncertain')}
                </span>
              ) : null}
            </li>
          ))}
          {zeilen.length > 1 ? (
            <li className="document-meaning__hint">{translate('documentMeaning.candidate.choose')}</li>
          ) : null}
        </ul>
      </section>
    );
  };

  return (
    <div className="document-meaning" data-testid={testId ?? 'document-meaning-panel'}>
      <h2 className="document-meaning__title">{translate('documentMeaning.title')}</h2>

      {view.certificateLabelKey ? (
        /*
         * DOKUMENT-FACHWISSEN-01I1 — die Art der Bescheinigung, ganz oben.
         *
         * Sie steht vor dem Betreff, weil sie die Frage beantwortet, die der
         * Betrieb vor einem Behördenschreiben zuerst hat: Was ist das
         * überhaupt? Nur bei belastbarer Erkennung; sonst steht hier nichts.
         */
        <section className="document-meaning__section">
          <h3 className="document-meaning__label">
            {translate('documentMeaning.certificate')}
          </h3>
          <p className="document-meaning__value" data-testid="document-meaning-certificate">
            {translate(view.certificateLabelKey)}
          </p>
        </section>
      ) : null}

      {view.subject ? (
        <section className="document-meaning__section">
          <h3 className="document-meaning__label">{translate('documentMeaning.subject')}</h3>
          <p className="document-meaning__value" data-testid="document-meaning-subject">
            {view.subject}
          </p>
        </section>
      ) : null}

      {view.purpose ? (
        <section className="document-meaning__section">
          <h3 className="document-meaning__label">{translate('documentMeaning.purpose')}</h3>
          <p className="document-meaning__value" data-testid="document-meaning-purpose">
            {view.purpose}
          </p>
        </section>
      ) : null}

      <section className="document-meaning__section">
        <h3 className="document-meaning__label">{translate('documentMeaning.action.question')}</h3>
        <p
          className={`document-meaning__value document-meaning__answer document-meaning__answer--${view.actionNeed}`}
          data-testid="document-meaning-action"
        >
          {translate(view.actionNeedLabelKey)}
        </p>
      </section>

      {view.obligations.length > 0 ? (
        <section className="document-meaning__section">
          <h3 className="document-meaning__label">{translate('documentMeaning.obligations')}</h3>
          <ul className="document-meaning__list" data-testid="document-meaning-obligations">
            {view.obligations.map((pflicht) => (
              <li key={pflicht.text} className="document-meaning__item">
                {pflicht.text}
                {pflicht.byWhen ? (
                  <span className="document-meaning__item-due">
                    {' '}
                    {translate('documentMeaning.obligations.by')} {pflicht.byWhen}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {view.deadlines.length > 0 ? (
        <section className="document-meaning__section">
          <h3 className="document-meaning__label">{translate('documentMeaning.deadlines')}</h3>
          <ul className="document-meaning__list" data-testid="document-meaning-deadlines">
            {view.deadlines.map((frist) => (
              <li
                key={frist.text}
                className={`document-meaning__item document-meaning__item--${frist.isAction ? 'action' : 'info'}`}
              >
                {frist.text}
                <span className="document-meaning__hint">
                  {translate(
                    frist.isAction ? 'documentMeaning.deadlines.action' : 'documentMeaning.deadlines.info',
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {view.amounts.length > 0 ? (
        <section className="document-meaning__section">
          <h3 className="document-meaning__label">{translate('documentMeaning.amounts')}</h3>
          <ul className="document-meaning__list" data-testid="document-meaning-amounts">
            {view.amounts.map((betrag) => (
              <li key={`${betrag.amount}-${betrag.explanation}`} className="document-meaning__item">
                <span className="document-meaning__amount">{betrag.amount}</span>
                <span className="document-meaning__candidate-reason">{betrag.explanation}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="document-meaning__section">
        <h3 className="document-meaning__label">{translate('documentMeaning.accounting')}</h3>
        <p className="document-meaning__value" data-testid="document-meaning-accounting">
          {translate(view.accountingLabelKey)}
        </p>
        <p className="document-meaning__hint">{translate(view.accountingHintKey)}</p>
      </section>

      {kandidatenBlock(translate('documentMeaning.customer'), view.customerCandidates, 'customer')}
      {kandidatenBlock(translate('documentMeaning.vorgang'), view.vorgangCandidates, 'vorgang')}

      <section className="document-meaning__section">
        <h3 className="document-meaning__label">{translate('documentMeaning.nextStep')}</h3>
        <p className="document-meaning__value" data-testid="document-meaning-next-step">
          {translate(view.nextStepKey)}
        </p>
      </section>

      {view.uncertainties.length > 0 ? (
        <section className="document-meaning__section document-meaning__section--muted">
          <h3 className="document-meaning__label">{translate('documentMeaning.uncertain')}</h3>
          <ul className="document-meaning__list" data-testid="document-meaning-uncertain">
            {view.uncertainties.map((schluessel) => (
              <li key={schluessel} className="document-meaning__hint">
                {translate(schluessel)}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <p className="document-meaning__disclaimer">{translate('documentMeaning.disclaimer')}</p>
    </div>
  );
}
