import { useCallback, useMemo, useRef, useState, type DragEvent } from 'react';
import { Button } from '../components/ui/Button';
import { MoneyDisplay } from '../components/ui/Display';
import { EmptyStateBlock } from '../components/ui/EmptyStateBlock';
import { Page } from '../components/ui/Page';
import { PageHeader } from '../components/ui/PageHeader';
import { useApp } from '../context/AppContext';
import { fromCents } from '../services/invoiceMoney';
import {
  decodeBankStatementBytes,
  parseBankStatementCsv,
} from '../services/bank/bankStatementCsvService';
import {
  commitBankImport,
  listBankTransactions,
  planBankImport,
} from '../services/bank/bankTransactionStore';
import {
  createBankAccount,
  ensureBankAccountForIdentifier,
  getBankAccountById,
  listBankAccounts,
} from '../services/bank/bankAccountStore';
import { buildBankSuggestions } from '../services/bank/bankSuggestionService';
import {
  confirmBankReconciliation,
  planBankConfirmation,
} from '../services/bank/bankReconciliationService';
import { findReconciliationForTransaction } from '../services/bank/bankReconciliationStore';
import type {
  BankReconciliation,
  BankReconciliationRefusal,
} from '../types/bankReconciliation';
import type { BankImportOutcome, BankTransaction } from '../types/bankTransaction';
import type {
  BankSuggestionCandidate,
  BankSuggestionResult,
} from '../types/bankSuggestion';
import type {
  BankStatementFileProblem,
  BankStatementPreview,
  BankStatementRow,
} from '../types/bankStatement';
import type { TranslationKey } from '../i18n';

/**
 * BANKABGLEICH-V1 BLOCK 1 — Kontoauszug prüfen.
 *
 * Eine reine Vorschau: Datei wählen, Bewegungen ansehen, fertig. Es gibt
 * bewusst **keine Schaltfläche zum Übernehmen** — nichts wird gespeichert,
 * nichts gebucht, kein Zahlungsstatus berührt. Wer die Seite verlässt,
 * verlässt auch die Vorschau; das ist in Block 1 kein Mangel, sondern die
 * zugesagte Grenze.
 *
 * Die Seite liegt im Finanzbereich, weil dort Beträge hingehören. Die
 * Startseite hält Beträge über `ohneBetraege` bewusst heraus — hier gilt das
 * Gegenteil, und deshalb wird auch hier nichts nach aussen gespiegelt.
 */

const FEHLER_TEXTE: Record<BankStatementFileProblem, TranslationKey> = {
  file_unreadable: 'bankStatement.error.file_unreadable',
  encoding_unsupported: 'bankStatement.error.encoding_unsupported',
  no_header: 'bankStatement.error.no_header',
  no_delimiter: 'bankStatement.error.no_delimiter',
  missing_required_column: 'bankStatement.error.missing_required_column',
  no_rows: 'bankStatement.error.no_rows',
};

interface Fehler {
  problem: BankStatementFileProblem;
  detail?: string;
}

export function BankStatementPage() {
  const { translate } = useApp();
  const inputRef = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<BankStatementPreview | null>(null);
  const [fehler, setFehler] = useState<Fehler | null>(null);
  const [laeuft, setLaeuft] = useState(false);
  /* BLOCK 2 — der Bestand. `stand` erzwingt das Neulesen nach dem Uebernehmen. */
  const [stand, setStand] = useState(0);
  const [ergebnis, setErgebnis] = useState<BankImportOutcome | null>(null);
  /*
   * BLOCK 2B — das Konto dieses Auszugs. Erkennt die Datei es, steht es
   * sofort fest; sonst waehlt der Nutzer, bevor uebernommen werden darf.
   */
  const [kontoId, setKontoId] = useState<string>('');
  const [kontoAutomatisch, setKontoAutomatisch] = useState(false);
  const [neuerKontoname, setNeuerKontoname] = useState('');

  const gespeichert = useMemo(() => listBankTransactions(), [stand]);
  /*
   * BLOCK 3 — die Vorschläge entstehen in **einem** Durchgang über alle
   * aufbewahrten Bewegungen. Rechnungen und Ausgaben werden dabei nur
   * einmal gelesen; eine Berechnung je Zeile wäre dieselbe Arbeit mal N.
   */
  const vorschlaege = useMemo(() => buildBankSuggestions(gespeichert), [gespeichert]);
  const konten = useMemo(() => listBankAccounts(), [stand]);
  const konto = useMemo(() => (kontoId ? getBankAccountById(kontoId) : null), [kontoId, stand]);
  /*
   * Der Plan entsteht **ohne** zu speichern. Genau das ist der
   * Confirm-first-Vertrag: Die Seite zeigt, was passieren wuerde.
   */
  const plan = useMemo(
    () => (preview && kontoId ? planBankImport(preview, kontoId) : null),
    [preview, kontoId, stand],
  );
  const neuIds = useMemo(() => new Set((plan?.neu ?? []).map((row) => row.id)), [plan]);

  const lies = useCallback(async (file: File) => {
    setLaeuft(true);
    setFehler(null);
    setPreview(null);
    setErgebnis(null);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const text = decodeBankStatementBytes(bytes);
      if (text === null) {
        setFehler({ problem: 'encoding_unsupported' });
        return;
      }
      const ergebnis = parseBankStatementCsv(text, file.name);
      if (!ergebnis.ok) {
        setFehler({ problem: ergebnis.problem, ...(ergebnis.detail ? { detail: ergebnis.detail } : {}) });
        return;
      }
      setPreview(ergebnis.preview);
      /*
       * Nennt die Datei ein Konto, ist die Zuordnung eindeutig und wird
       * automatisch getroffen — der Nutzer sieht trotzdem, welches.
       * Sonst bleibt sie offen und blockiert die Uebernahme.
       */
      if (ergebnis.preview.accountKey) {
        const erkannt = ensureBankAccountForIdentifier(ergebnis.preview.accountKey);
        setKontoId(erkannt.id);
        setKontoAutomatisch(true);
      } else {
        setKontoId('');
        setKontoAutomatisch(false);
      }
      setNeuerKontoname('');
      setStand((v) => v + 1);
    } catch {
      /* Bewusst ohne Konsolenausgabe: In der Datei stehen Bankdaten. */
      setFehler({ problem: 'file_unreadable' });
    } finally {
      setLaeuft(false);
    }
  }, []);

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    const file = event.dataTransfer.files?.[0];
    if (file) void lies(file);
  }

  function fehlerText(wert: Fehler): string {
    const roh = translate(FEHLER_TEXTE[wert.problem]);
    if (wert.problem !== 'missing_required_column') return roh;
    /* Die fehlende Spalte in Nutzersprache, nicht als Feldname. */
    const schluessel =
      wert.detail === 'bookingDate'
        ? 'bankStatement.missing.bookingDate'
        : 'bankStatement.missing.amount';
    return roh.replace('{detail}', translate(schluessel as TranslationKey));
  }

  function zusammenfassung(wert: BankStatementPreview): string[] {
    const teile: string[] = [];
    teile.push(
      wert.rows.length === 1
        ? translate('bankStatement.summaryCountOne')
        : translate('bankStatement.summaryCount').replace('{count}', String(wert.rows.length)),
    );
    if (wert.issues.length > 0) {
      teile.push(
        wert.issues.length === 1
          ? translate('bankStatement.summaryIssuesOne')
          : translate('bankStatement.summaryIssues').replace('{count}', String(wert.issues.length)),
      );
    }
    if (wert.duplicateCount > 0) {
      teile.push(
        translate('bankStatement.summaryDuplicates').replace('{count}', String(wert.duplicateCount)),
      );
    }
    return teile;
  }

  /** Was die Übernahme bewirken würde — in derselben Sprache wie danach. */
  function planText(): string[] {
    if (!plan) return [];
    const teile: string[] = [];
    teile.push(
      plan.neu.length === 0
        ? translate('bankStatement.planNewNone')
        : plan.neu.length === 1
          ? translate('bankStatement.planNewOne')
          : translate('bankStatement.planNew').replace('{count}', String(plan.neu.length)),
    );
    if (plan.vorhanden.length > 0) {
      teile.push(
        plan.vorhanden.length === 1
          ? translate('bankStatement.planExistingOne')
          : translate('bankStatement.planExisting').replace('{count}', String(plan.vorhanden.length)),
      );
    }
    if (plan.problemZeilen > 0) {
      teile.push(
        plan.problemZeilen === 1
          ? translate('bankStatement.planSkippedOne')
          : translate('bankStatement.planSkipped').replace('{count}', String(plan.problemZeilen)),
      );
    }
    return teile;
  }

  function uebernehmen(): void {
    if (!preview || !kontoId) return;
    const wert = commitBankImport(preview, kontoId);
    setErgebnis(wert);
    setStand((v) => v + 1);
  }

  return (
    <Page className="bank-statement-page" testId="bank-statement-page">
      <PageHeader
        title={translate('bankStatement.title')}
        subtitle={translate('bankStatement.subtitle')}
        /* Sichtbare Abnahme — ohne backLabel zeigt PageHeader gar keinen Rueckweg. */
        backLabel={translate('common.back')}
        backHref="/finanzen"
        backTestId="bank-statement-back"
      />

      <input
        ref={inputRef}
        type="file"
        accept=".csv,text/csv,text/plain"
        className="bank-statement__input"
        data-testid="bank-statement-input"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void lies(file);
          /* Dieselbe Datei soll erneut wählbar bleiben. */
          event.target.value = '';
        }}
      />

      <div
        className="bank-statement__dropzone"
        data-testid="bank-statement-dropzone"
        onDragOver={(event) => event.preventDefault()}
        onDrop={onDrop}
      >
        <b>{translate('bankStatement.dropzone')}</b>
        <span>{translate('bankStatement.dropzoneHint')}</span>
        <Button
          type="button"
          variant="primary"
          onClick={() => inputRef.current?.click()}
          disabled={laeuft}
          data-testid="bank-statement-choose"
        >
          {translate('bankStatement.choose')}
        </Button>
      </div>

      <p className="bank-statement__notice" data-testid="bank-statement-notice">
        {translate('bankStatement.notSaved')}
      </p>

      {fehler ? (
        <div className="bank-statement__error" role="alert" data-testid="bank-statement-error">
          {fehlerText(fehler)}
        </div>
      ) : null}

      {!preview && !fehler ? (
        <EmptyStateBlock
          title={translate('bankStatement.emptyTitle')}
          description={translate('bankStatement.emptyText')}
          testId="bank-statement-empty"
        />
      ) : null}

      {preview ? (
        <section className="bank-statement__result" aria-label={translate('bankStatement.title')}>
          <div className="bank-statement__summary" data-testid="bank-statement-summary">
            <b data-testid="bank-statement-filename">{preview.fileName}</b>
            <span>{zusammenfassung(preview).join(' · ')}</span>
            <span data-testid="bank-statement-plan">
              {kontoId ? planText().join(' · ') : translate('bankStatement.accountBlocked')}
            </span>
          </div>

          <section className="bank-statement__account" data-testid="bank-statement-account">
            <h2>{translate('bankStatement.accountSectionTitle')}</h2>
            {konto && kontoAutomatisch ? (
              <>
                <p data-testid="bank-statement-account-detected">
                  {translate('bankStatement.accountDetected').replace('{name}', konto.displayName)}
                </p>
                <p className="bank-statement__notice">{translate('bankStatement.accountDetectedHint')}</p>
              </>
            ) : konto ? (
              <p data-testid="bank-statement-account-chosen">
                {translate('bankStatement.accountOf').replace('{name}', konto.displayName)}
              </p>
            ) : (
              <>
                <p data-testid="bank-statement-account-needed">{translate('bankStatement.accountNeeded')}</p>
                <p className="bank-statement__notice">{translate('bankStatement.accountNeededHint')}</p>
                {konten.length > 0 ? (
                  <label className="bank-statement__account-pick">
                    <span>{translate('bankStatement.accountChoose')}</span>
                    <select
                      className="input"
                      data-testid="bank-statement-account-select"
                      value={kontoId}
                      onChange={(event) => setKontoId(event.target.value)}
                    >
                      <option value="">{translate('bankStatement.accountNone')}</option>
                      {konten.map((eintrag) => (
                        <option key={eintrag.id} value={eintrag.id}>
                          {eintrag.displayName}
                        </option>
                      ))}
                    </select>
                  </label>
                ) : null}
                <label className="bank-statement__account-new">
                  <span>{translate('bankStatement.accountNewLabel')}</span>
                  <input
                    type="text"
                    className="input"
                    data-testid="bank-statement-account-name"
                    placeholder={translate('bankStatement.accountNewPlaceholder')}
                    value={neuerKontoname}
                    onChange={(event) => setNeuerKontoname(event.target.value)}
                  />
                </label>
                <Button
                  type="button"
                  variant="secondary"
                  disabled={!neuerKontoname.trim()}
                  data-testid="bank-statement-account-create"
                  onClick={() => {
                    const neu = createBankAccount(neuerKontoname);
                    setKontoId(neu.id);
                    setNeuerKontoname('');
                    setStand((v) => v + 1);
                  }}
                >
                  {translate('bankStatement.accountNewButton')}
                </Button>
              </>
            )}
          </section>

          {ergebnis ? (
            <p className="bank-statement__committed" role="status" data-testid="bank-statement-committed">
              {ergebnis.added === 0
                ? translate('bankStatement.committedNone')
                : ergebnis.added === 1
                  ? translate('bankStatement.committedOne')
                  : translate('bankStatement.committed').replace('{count}', String(ergebnis.added))}
            </p>
          ) : (
            <Button
              type="button"
              variant="primary"
              onClick={uebernehmen}
              disabled={!kontoId || !plan || plan.neu.length === 0}
              data-testid="bank-statement-commit"
            >
              {!kontoId
                ? translate('bankStatement.commit')
                : plan && plan.neu.length === 0
                  ? translate('bankStatement.commitNothing')
                  : translate('bankStatement.commit')}
            </Button>
          )}

          <ul className="bank-statement__rows" data-testid="bank-statement-rows">
            {preview.rows.map((row) => (
              <BewegungZeile
                key={row.id}
                row={row}
                /*
                 * Sichtbare Abnahme — ohne gewähltes Konto stand an jeder Zeile
                 * „Bereits vorhanden". Das war eine Behauptung über einen
                 * Bestand, den niemand prüfen konnte: Ohne Konto gibt es keinen
                 * Plan. Solange das Konto offen ist, sagt die Zeile deshalb nichts.
                 */
                status={!plan ? null : neuIds.has(row.id) ? 'neu' : 'vorhanden'}
              />
            ))}
          </ul>

          {preview.issues.length > 0 ? (
            <section className="bank-statement__issues" data-testid="bank-statement-issues">
              <h2>{translate('bankStatement.issuesTitle')}</h2>
              <ul>
                {preview.issues.map((issue) => (
                  <li key={issue.rowNumber} data-testid={`bank-statement-issue-${issue.rowNumber}`}>
                    <b>{translate('bankStatement.issueRow').replace('{row}', String(issue.rowNumber))}</b>
                    <span>{translate(`bankStatement.issue.${issue.problem}` as TranslationKey)}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <Button
            type="button"
            variant="secondary"
            onClick={() => {
              setPreview(null);
              setFehler(null);
            }}
            data-testid="bank-statement-reset"
          >
            {translate('bankStatement.reset')}
          </Button>
        </section>
      ) : null}

      <section className="bank-statement__stored" data-testid="bank-statement-stored">
        <h2>{translate('bankStatement.storedTitle')}</h2>
        <p className="bank-statement__notice">{translate('bankStatement.storedNote')}</p>
        {gespeichert.length === 0 ? (
          <p data-testid="bank-statement-stored-empty">{translate('bankStatement.storedEmpty')}</p>
        ) : (
          <>
            <p data-testid="bank-statement-stored-count">
              {gespeichert.length === 1
                ? translate('bankStatement.storedCountOne')
                : translate('bankStatement.storedCount').replace('{count}', String(gespeichert.length))}
            </p>
            <ul className="bank-statement__rows" data-testid="bank-statement-stored-rows">
              {gespeichert.map((eintrag) => (
                <GespeicherteZeile
                  key={eintrag.id}
                  eintrag={eintrag}
                  vorschlag={vorschlaege.get(eintrag.id) ?? null}
                  onGeaendert={() => setStand((v) => v + 1)}
                />
              ))}
            </ul>
          </>
        )}
      </section>
    </Page>
  );
}

function BewegungZeile({
  row,
  status,
}: {
  row: BankStatementRow;
  /** `null`, solange kein Konto gewählt ist — dann ist der Bestand unbekannt. */
  status: 'neu' | 'vorhanden' | null;
}) {
  const { translate, language } = useApp();
  const locale = language === 'tr' ? 'tr-TR' : language === 'bg' ? 'bg-BG' : 'de-DE';
  const eingang = row.amountCents >= 0;
  const datum = new Date(`${row.bookingDate}T12:00:00`).toLocaleDateString(locale, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });

  return (
    <li
      className={`bank-statement__row bank-statement__row--${eingang ? 'in' : 'out'}`}
      data-testid={`bank-statement-row-${row.rowNumber}`}
    >
      <span className="bank-statement__date">{datum}</span>
      {status ? (
        <span className="bank-statement__status" data-testid={`bank-statement-status-${row.rowNumber}`}>
          {translate(status === 'neu' ? 'bankStatement.rowNew' : 'bankStatement.rowExisting')}
        </span>
      ) : (
        <span className="bank-statement__status" aria-hidden="true" />
      )}
      <span className="bank-statement__party">
        {row.counterparty ?? translate('bankStatement.noCounterparty')}
      </span>
      <span className="bank-statement__purpose">{row.purpose ?? ''}</span>
      <span className="bank-statement__amount">
        {/*
          Richtung in Wort **und** Vorzeichen: Ein Minuszeichen allein ist auf
          einem kleinen Bildschirm zu leicht zu übersehen, und hier geht es um
          Geld.
        */}
        <span className="bank-statement__direction">
          {translate(eingang ? 'bankStatement.incoming' : 'bankStatement.outgoing')}
        </span>
        <MoneyDisplay value={fromCents(row.amountCents)} />
      </span>
      {row.possibleDuplicate ? (
        <span className="bank-statement__duplicate" data-testid={`bank-statement-duplicate-${row.rowNumber}`}>
          {translate('bankStatement.duplicateHint')}
        </span>
      ) : null}
    </li>
  );
}

/**
 * Eine aufbewahrte Bewegung.
 *
 * Bewusst dieselbe Darstellung wie in der Vorschau — es ist dieselbe Sache,
 * nur dauerhaft. Eine zweite Optik würde suggerieren, hier sei etwas anderes
 * passiert als „aufbewahrt".
 */
function GespeicherteZeile({
  eintrag,
  vorschlag,
  onGeaendert,
}: {
  eintrag: BankTransaction;
  vorschlag: BankSuggestionResult | null;
  onGeaendert: () => void;
}) {
  const { translate, language } = useApp();
  const locale = language === 'tr' ? 'tr-TR' : language === 'bg' ? 'bg-BG' : 'de-DE';
  const eingang = eintrag.amountCents >= 0;
  const zugeordnet = findReconciliationForTransaction(eintrag.id);
  const datum = new Date(`${eintrag.bookingDate}T12:00:00`).toLocaleDateString(locale, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });

  return (
    <li
      className={`bank-statement__row bank-statement__row--${eingang ? 'in' : 'out'}`}
      data-testid={`bank-statement-stored-${eintrag.id}`}
    >
      <span className="bank-statement__date">{datum}</span>
      <span className="bank-statement__party">
        {eintrag.counterparty ?? translate('bankStatement.noCounterparty')}
      </span>
      <span className="bank-statement__purpose">{eintrag.purpose ?? ''}</span>
      <span className="bank-statement__amount">
        <span className="bank-statement__direction">
          {translate(eingang ? 'bankStatement.incoming' : 'bankStatement.outgoing')}
        </span>
        <MoneyDisplay value={fromCents(eintrag.amountCents)} />
      </span>
      {/*
        BLOCK 4 — eine bereits bestätigte Zuordnung ersetzt jeden Vorschlag.
        Sie ist erledigt, und ein weiterer Vorschlag wäre eine Einladung
        zur zweiten Zuordnung.
      */}
      {zugeordnet ? (
        <Zugeordnet eintrag={zugeordnet} />
      ) : vorschlag ? (
        <Vorschlag ergebnis={vorschlag} transaction={eintrag} onGeaendert={onGeaendert} />
      ) : null}
    </li>
  );
}

/**
 * BLOCK 3 — was zu dieser Bewegung gehören könnte.
 *
 * Drei ehrliche Zustände: ein Vorschlag, mehrere Möglichkeiten, oder keiner.
 * Der mittlere ist der wichtigste — mehrere gleich gute Kandidaten heissen,
 * dass OfficeTakt die Frage **nicht** beantwortet hat, und genau das steht
 * dann da. Ein willkürlich erster Treffer wäre eine Behauptung über Geld.
 */
/** Wie viele Kandidaten auf der besten Stufe stehen — nur die sind gleichwertig. */
function gleichGute(ergebnis: BankSuggestionResult): number {
  const beste = ergebnis.candidates[0]?.grade;
  return ergebnis.candidates.filter((kandidat) => kandidat.grade === beste).length;
}

function Vorschlag({
  ergebnis,
  transaction,
  onGeaendert,
}: {
  ergebnis: BankSuggestionResult;
  transaction: BankTransaction;
  onGeaendert: () => void;
}) {
  const { translate } = useApp();
  const rechnungen = ergebnis.direction === 'incoming';

  if (ergebnis.candidates.length === 0) {
    return (
      <span
        className="bank-statement__match bank-statement__match--none"
        data-testid={`bank-match-none-${ergebnis.bankTransactionId}`}
      >
        {translate(rechnungen ? 'bankMatch.noneInvoice' : 'bankMatch.noneExpense')}
      </span>
    );
  }

  if (ergebnis.ambiguous) {
    return (
      <span
        className="bank-statement__match bank-statement__match--ambiguous"
        data-testid={`bank-match-ambiguous-${ergebnis.bankTransactionId}`}
      >
        {translate(rechnungen ? 'bankMatch.ambiguousInvoices' : 'bankMatch.ambiguousExpenses').replace(
          '{count}',
          /*
           * Sichtbare Abnahme — gezaehlt werden nur die **gleich guten**
           * Kandidaten. Vorher stand hier die Gesamtzahl: Bei zwei gleich
           * passenden und drei schwaecheren meldete die Seite „5 moegliche
           * Rechnungen“ und uebertrieb damit die Unklarheit.
           */
          String(gleichGute(ergebnis)),
        )}
      </span>
    );
  }

  const [bester, ...weitere] = ergebnis.candidates;
  return (
    <span
      className="bank-statement__match"
      data-testid={`bank-match-${ergebnis.bankTransactionId}`}
    >
      <b className={`bank-statement__match-grade bank-statement__match-grade--${bester!.grade}`}>
        {translate(`bankMatch.grade.${bester!.grade}` as TranslationKey)}
      </b>
      <Kandidat kandidat={bester!} />
      <Bestaetigung kandidat={bester!} transaction={transaction} onGeaendert={onGeaendert} />
      {weitere.length > 0 ? (
        <span className="bank-statement__match-more">
          {translate('bankMatch.more')}: {weitere.length}
        </span>
      ) : null}
      {/*
        Dieselbe Klasse wie die übrigen Zusagen der Seite: Der Satz verneint
        eine Geldwirkung ausdrücklich, er behauptet keine.
      */}
      <span className="bank-statement__match-note bank-statement__notice">
        {translate('bankMatch.notAssigned')}
      </span>
    </span>
  );
}

function Kandidat({ kandidat }: { kandidat: BankSuggestionCandidate }) {
  const { translate } = useApp();
  return (
    <span className="bank-statement__candidate">
      <span className="bank-statement__candidate-head">
        {translate(
          kandidat.targetType === 'invoice' ? 'bankMatch.invoiceLabel' : 'bankMatch.expenseLabel',
        )
          .replace('{number}', kandidat.documentNumber)
          /* Ohne Nummer bleibt „Ausgabe" allein stehen statt mit einem rätselhaften Strich. */
          .trim()}
        {kandidat.partyName ? ` · ${kandidat.partyName}` : ''}
      </span>
      <span className="bank-statement__candidate-open">
        {translate('bankMatch.open')}: <MoneyDisplay value={fromCents(kandidat.openCents)} />
      </span>
      <span className="bank-statement__candidate-reasons">
        {translate('bankMatch.reasons')}:{' '}
        {kandidat.reasons
          .map((grund) => translate(`bankMatch.reason.${grund}` as TranslationKey))
          .join(' · ')}
      </span>
    </span>
  );
}

/**
 * BLOCK 4 — die eine finanzwirksame Aktion.
 *
 * Confirm-first in drei Stufen: Die Schaltfläche öffnet nur eine
 * Zusammenfassung, erst der zweite Klick erfasst die Zahlung. Beim Öffnen
 * der Seite passiert nichts von selbst.
 */
function Bestaetigung({
  kandidat,
  transaction,
  onGeaendert,
}: {
  kandidat: BankSuggestionCandidate;
  transaction: BankTransaction;
  onGeaendert: () => void;
}) {
  const { translate, language } = useApp();
  const [offen, setOffen] = useState(false);
  const [laeuft, setLaeuft] = useState(false);
  const [fehler, setFehler] = useState<BankReconciliationRefusal | null>(null);

  const plan = planBankConfirmation(transaction, kandidat);
  const locale = language === 'tr' ? 'tr-TR' : language === 'bg' ? 'bg-BG' : 'de-DE';
  const datum = new Date(`${plan.paidOn}T12:00:00`).toLocaleDateString(locale, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });

  /*
   * Eine Überzahlung oder eine falsche Richtung wird nicht als Aktion
   * angeboten, sondern erklärt. Eine gesperrte Schaltfläche ohne Grund
   * lässt den Nutzer rätseln.
   */
  if (plan.refusal) {
    return (
      <span className="bank-statement__confirm-blocked" data-testid={`bank-confirm-blocked-${transaction.id}`}>
        {translate(`bankConfirm.refusal.${plan.refusal}` as TranslationKey)}
      </span>
    );
  }

  if (!offen) {
    return (
      <Button
        type="button"
        variant="secondary"
        onClick={() => setOffen(true)}
        data-testid={`bank-confirm-open-${transaction.id}`}
      >
        {translate('bankConfirm.action')}
      </Button>
    );
  }

  return (
    <span className="bank-statement__confirm" data-testid={`bank-confirm-dialog-${transaction.id}`}>
      <b>{translate('bankConfirm.title')}</b>
      <span className="bank-statement__notice">{translate('bankConfirm.intro')}</span>
      <span>
        {translate('bankConfirm.movement')}: {transaction.counterparty ?? '—'} ·{' '}
        <MoneyDisplay value={fromCents(transaction.amountCents)} />
      </span>
      <span>
        {translate('bankConfirm.target')}:{' '}
        {translate(
          kandidat.targetType === 'invoice' ? 'bankMatch.invoiceLabel' : 'bankMatch.expenseLabel',
        )
          .replace('{number}', kandidat.documentNumber)
          .trim()}
        {kandidat.partyName ? ` · ${kandidat.partyName}` : ''}
      </span>
      <span>
        {translate('bankConfirm.open')}: <MoneyDisplay value={fromCents(plan.openCents)} />
      </span>
      <span>
        {translate('bankConfirm.amount')}: <MoneyDisplay value={fromCents(plan.amountCents)} /> ·{' '}
        {translate('bankConfirm.paidOn')}: {datum}
      </span>
      {plan.partial ? (
        <span className="bank-statement__confirm-partial" data-testid={`bank-confirm-partial-${transaction.id}`}>
          {translate('bankConfirm.partial')}
        </span>
      ) : null}
      {fehler ? (
        <span className="bank-statement__error" role="alert" data-testid={`bank-confirm-error-${transaction.id}`}>
          {translate(`bankConfirm.refusal.${fehler}` as TranslationKey)}
        </span>
      ) : null}
      <span className="bank-statement__confirm-actions">
        <Button
          type="button"
          variant="primary"
          disabled={laeuft}
          data-testid={`bank-confirm-do-${transaction.id}`}
          onClick={() => {
            setLaeuft(true);
            setFehler(null);
            void confirmBankReconciliation(transaction, kandidat)
              .then((ergebnis) => {
                if (ergebnis.ok) {
                  setOffen(false);
                  onGeaendert();
                } else {
                  /* Kein falscher Erfolg: Der Dialog bleibt offen und nennt den Grund. */
                  setFehler(ergebnis.refusal);
                }
              })
              .finally(() => setLaeuft(false));
          }}
        >
          {laeuft ? translate('bankConfirm.running') : translate('bankConfirm.confirm')}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={laeuft}
          data-testid={`bank-confirm-cancel-${transaction.id}`}
          onClick={() => {
            setOffen(false);
            setFehler(null);
          }}
        >
          {translate('bankConfirm.cancel')}
        </Button>
      </span>
    </span>
  );
}

/** Was nach einer bestätigten Zuordnung an der Bewegung steht. */
function Zugeordnet({ eintrag }: { eintrag: BankReconciliation }) {
  const { translate, language } = useApp();
  const locale = language === 'tr' ? 'tr-TR' : language === 'bg' ? 'bg-BG' : 'de-DE';
  const datum = new Date(`${eintrag.paidOn}T12:00:00`).toLocaleDateString(locale, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
  const betrag = new Intl.NumberFormat(locale, { style: 'currency', currency: 'EUR' }).format(
    fromCents(eintrag.amountCents),
  );

  return (
    <span className="bank-statement__match" data-testid={`bank-reconciled-${eintrag.bankTransactionId}`}>
      <b className="bank-statement__match-grade bank-statement__match-grade--sehr_passend">
        {translate('bankConfirm.done')}
      </b>
      <span className="bank-statement__candidate-open">
        {translate('bankConfirm.doneDetail').replace('{amount}', betrag).replace('{date}', datum)}
      </span>
    </span>
  );
}
