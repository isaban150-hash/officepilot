import { Fragment, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { KpiRow, KpiTile } from '../ui/Kpi';
import { BusinessList, BusinessListItem } from '../ui/Lists';
import { StatusBadge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { DateDisplay, MoneyDisplay } from '../ui/Display';
import { getOrderCostSummary, type OrderCostEntry } from '../../services/order/orderCostService';
import {
  getRebillStateById,
  undoRebill,
  type RebillState,
} from '../../services/order/orderCostRebillingService';
import { formatPaymentCurrency } from '../../services/expensePaymentService';
import { RebillCostDialog } from './RebillCostDialog';
import type { TranslationKey } from '../../i18n';

/**
 * ORDER-COST-ALLOCATION-01B — „Was hat der Auftrag gekostet?"
 *
 * Drei Zahlen, eine Liste, ein ehrlicher Satz. „Verbleibt" ist bewusst **kein**
 * Deckungsbeitrag: Arbeitszeit und Löhne erfasst OfficeTakt (noch) nicht, und
 * die Oberfläche behauptet keine Kennzahl, die die Daten nicht tragen.
 * Stornierte Belege bleiben als Historie sichtbar, zählen aber nie mit.
 *
 * BEREICH-7-V1 — hier entsteht auch die Weiterberechnung. Der Nutzer steht an
 * dieser Stelle bereits vor „zugeordnete Kosten / verbleibt"; genau da stellt
 * sich die Frage, ob die Kosten an den Kunden weitergehen. Deshalb eine
 * Aktion in der vorhandenen Zeile statt einer neuen Seite. Je Zeile sind
 * genau drei Zustände unterscheidbar: weiterberechenbar, bereits übernommen,
 * gesperrt — mehr Statusarchitektur braucht es nicht.
 */
interface Props {
  vorgangId: string;
  translate: (key: TranslationKey) => string;
  /** Anzeige-Revision: erneutes Lesen nach Änderungen an Ausgaben. */
  revision?: number;
}

interface RebillTarget {
  expenseId: string;
  allocatedNet: number;
  supplierName: string;
  invoiceNumber: string;
}

function entryRow(
  entry: OrderCostEntry,
  translate: (key: TranslationKey) => string,
  cancelled: boolean,
  rebill?: {
    state: RebillState | undefined;
    onRebill: (target: RebillTarget) => void;
    onUndo: (expenseId: string) => void;
  },
) {
  /*
   * Die Zeile selbst bleibt unveraendert anklickbar (sie fuehrt zur Ausgabe);
   * `BusinessListItem` zeigt Aktionen nur bei nicht klickbaren Zeilen. Die
   * Weiterberechnung steht deshalb als eigene Zeile direkt darunter — im
   * selben `ul`, ohne die vorhandene Komponente umzubauen.
   */
  const item = (
    <BusinessListItem
      testId={cancelled ? 'vorgang-cost-entry-cancelled' : 'vorgang-cost-entry'}
      title={entry.title}
      subtitle={
        <>
          {entry.supplierName}
          {' · '}
          {translate(`expense.category.${entry.category}` as TranslationKey)}
          {rebill?.state?.kind === 'already_rebilled' ? (
            <>
              {' · '}
              <span data-testid="vorgang-cost-rebilled-badge">
                {translate('expense.rebill.badge')}
              </span>
            </>
          ) : null}
        </>
      }
      status={
        cancelled ? (
          <StatusBadge tone="neutral" label={translate('expense.status.storniert')} icon={false} />
        ) : undefined
      }
      date={<DateDisplay value={entry.issueDate} />}
      amount={<MoneyDisplay value={entry.allocatedNet} emphasis={!cancelled} />}
      to={`/ausgaben/${entry.expenseId}`}
      linkTestId="vorgang-cost-entry-link"
    />
  );

  const section = rebill ? rebillSection(entry, translate, rebill) : null;
  if (!section) return <Fragment key={entry.expenseId}>{item}</Fragment>;

  return (
    <Fragment key={entry.expenseId}>
      {item}
      <li className="business-list__row vorgang-cost-rebill-row" data-testid="vorgang-cost-rebill-row">
        {section}
      </li>
    </Fragment>
  );
}

function rebillSection(
  entry: OrderCostEntry,
  translate: (key: TranslationKey) => string,
  rebill: {
    state: RebillState | undefined;
    onRebill: (target: RebillTarget) => void;
    onUndo: (expenseId: string) => void;
  },
) {
  const state = rebill.state;
  if (!state) return null;

  if (state.kind === 'rebillable') {
    return (
      <Button
        type="button"
        variant="outline"
        onClick={() =>
          rebill.onRebill({
            expenseId: entry.expenseId,
            allocatedNet: entry.allocatedNet,
            supplierName: entry.supplierName,
            invoiceNumber: entry.invoiceNumber,
          })
        }
        data-testid="vorgang-cost-rebill"
      >
        {translate('expense.rebill.action')}
      </Button>
    );
  }

  if (state.kind === 'already_rebilled') {
    /*
     * Der Bezug muss nachvollziehbar sein — nicht nur ein Abzeichen, sondern
     * welche Position daraus wurde und zu welchem Preis. Fehlt die Position,
     * sagt die Ansicht das ebenfalls, statt den Marker stumm zu zeigen.
     */
    if (!state.position) {
      return (
        <p className="hint-text" data-testid="vorgang-cost-rebill-missing">
          {translate('expense.rebill.linkedMissing')}
        </p>
      );
    }
    return (
      <>
        <p className="hint-text" data-testid="vorgang-cost-rebill-link">
          {translate('expense.rebill.linkedHint')
            .replace('{description}', state.position.description)
            .replace('{amount}', formatPaymentCurrency(state.position.unitPrice))}
        </p>
        {state.billed ? (
          <p className="hint-text" data-testid="vorgang-cost-rebill-billed">
            {translate('expense.rebill.billedHint')}
          </p>
        ) : (
          <Button
            type="button"
            variant="outline"
            onClick={() => rebill.onUndo(entry.expenseId)}
            data-testid="vorgang-cost-rebill-undo"
          >
            {translate('expense.rebill.undo')}
          </Button>
        )}
      </>
    );
  }

  return (
    <p className="hint-text" data-testid="vorgang-cost-rebill-blocked">
      {translate(
        state.reason === 'amendment_required'
          ? 'order_plan_amendment_required'
          : state.reason === 'schluss_locked'
            ? 'position.schlussLocked'
            : 'expense.rebill.expenseInactive',
      )}
    </p>
  );
}

export function VorgangCostPanel({ vorgangId, translate, revision = 0 }: Props) {
  const [localRevision, setLocalRevision] = useState(0);
  const [target, setTarget] = useState<RebillTarget | null>(null);
  const [noticeKey, setNoticeKey] = useState<TranslationKey | null>(null);
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);

  const summary = useMemo(
    () => getOrderCostSummary(vorgangId),
    [vorgangId, revision, localRevision],
  );
  const rebillStates = useMemo(() => {
    const map = new Map<string, RebillState | undefined>();
    for (const entry of summary?.entries ?? []) {
      map.set(entry.expenseId, getRebillStateById(entry.expenseId, vorgangId));
    }
    return map;
  }, [summary, vorgangId, revision, localRevision]);

  if (!summary) return null;

  const handleUndo = (expenseId: string) => {
    setNoticeKey(null);
    setErrorKey(null);
    const result = undoRebill(expenseId, vorgangId);
    if (!result.success) {
      setErrorKey(result.errorKey as TranslationKey);
      return;
    }
    setNoticeKey('expense.rebill.undone');
    setLocalRevision((value) => value + 1);
  };

  return (
    <section className="section vorgang-cost-section" data-testid="vorgang-cost-section">
      <h2 className="section__title">{translate('vorgang.cost.title')}</h2>

      <KpiRow testId="vorgang-cost-kpis" ariaLabel={translate('vorgang.cost.title')} className="work-kpis">
        <KpiTile
          label={translate('vorgang.cost.billed')}
          value={<MoneyDisplay value={summary.billedNet} />}
          testId="vorgang-cost-billed"
        />
        <KpiTile
          label={translate('vorgang.cost.allocated')}
          value={<MoneyDisplay value={summary.allocatedCostNet} />}
          testId="vorgang-cost-allocated"
        />
        <KpiTile
          label={translate('vorgang.cost.remaining')}
          value={<MoneyDisplay value={summary.remainingNet} />}
          tone={summary.remainingNet < 0 ? 'critical' : 'positive'}
          testId="vorgang-cost-remaining"
        />
      </KpiRow>

      <p className="hint-text" data-testid="vorgang-cost-hint">
        {translate('vorgang.cost.hint')}
      </p>

      {noticeKey ? (
        <p className="hint-text" role="status" data-testid="vorgang-cost-rebill-notice">
          {translate(noticeKey)}
        </p>
      ) : null}
      {errorKey ? (
        <p className="form-error" role="alert" data-testid="vorgang-cost-rebill-error">
          {translate(errorKey)}
        </p>
      ) : null}

      {summary.entries.length === 0 ? (
        <p className="hint-text" data-testid="vorgang-cost-empty">
          {translate('vorgang.cost.empty')}
        </p>
      ) : (
        <BusinessList testId="vorgang-cost-list" ariaLabel={translate('vorgang.cost.listTitle')}>
          {summary.entries.map((entry) =>
            entryRow(entry, translate, false, {
              state: rebillStates.get(entry.expenseId),
              onRebill: (next) => {
                setNoticeKey(null);
                setErrorKey(null);
                setTarget(next);
              },
              onUndo: handleUndo,
            }),
          )}
        </BusinessList>
      )}

      {summary.cancelledEntries.length > 0 ? (
        <>
          <h3 className="section__title" data-testid="vorgang-cost-cancelled-title">
            {translate('vorgang.cost.cancelledTitle')}
          </h3>
          <BusinessList testId="vorgang-cost-cancelled-list" ariaLabel={translate('vorgang.cost.cancelledTitle')}>
            {summary.cancelledEntries.map((entry) => entryRow(entry, translate, true))}
          </BusinessList>
        </>
      ) : null}

      <p className="hint-text">
        <Link to="/ausgaben" data-testid="vorgang-cost-open-expenses">
          {translate('expense.title')}
        </Link>
      </p>

      {target ? (
        <RebillCostDialog
          open
          expenseId={target.expenseId}
          vorgangId={vorgangId}
          allocatedNet={target.allocatedNet}
          supplierName={target.supplierName}
          invoiceNumber={target.invoiceNumber}
          onClose={() => setTarget(null)}
          onDone={() => {
            setNoticeKey('expense.rebill.saved');
            setLocalRevision((value) => value + 1);
          }}
        />
      ) : null}
    </section>
  );
}
