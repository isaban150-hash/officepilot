import { useEffect, useRef, useState } from 'react';
import { Button } from '../ui/Button';
import { formatDisplayDate } from '../../utils/displayFormat';
import { BUNDESLAENDER, BUNDESLAND_NAMEN, type Bundesland } from '../../services/fristen/feiertage';
import { invoiceFristLage } from '../../services/fristen/fristende';
import {
  abgeschlosseneMonateDerRechnung,
  kalenderFristenden,
  klaereRechnungsfrist,
  naechsterKlaerungsVersuch,
  type FristKlaerungErrorKey,
  type FristKlaerungVersuch,
} from '../../services/invoice/invoiceFristKlaerungService';
import { updateCustomer } from '../../services/customerService';
import type { WorkspaceActor } from '../../services/workspace/workspaceRoleService';
import type { CustomerHolidayLocation, InvoiceFristKlaerung, VorgangInvoice } from '../../types/models';
import type { TranslationKey } from '../../i18n';

/**
 * FINANZ-CORE-01A (Gesamtnacharbeit INV-01/02) — „Fristende klären“ an einer freigegebenen Rechnung.
 *
 * Hängt eine Skontozahlung oder das Zahlungsziel an einem Feiertag, den die App am Sitz des Kunden nicht
 * sicher kennt, entscheidet sie nicht selbst. Hier hält der Inhaber fest, wo der Sitz lag (Bundesland,
 * Gemeindefeiertag) oder — im Ausland — welches wirksame Ende eine bestimmte Frist hatte, und warum. Das
 * gilt für genau diese Rechnung, auch ohne Kundenverknüpfung; der Beleg bleibt unverändert, der Server
 * protokolliert die Klärung. Auf Wunsch wird die Angabe zusätzlich am Kunden für künftige Rechnungen
 * gespeichert (bestehende Rechnungen ändert das nicht).
 */
interface Props {
  vorgangId: string | null;
  invoice: VorgangInvoice;
  open: boolean;
  onClose: () => void;
  onClarified: (invoice: VorgangInvoice) => void;
  translate: (key: TranslationKey) => string;
  actor?: WorkspaceActor;
  /**
   * FINANZ-CORE-01A (END18-R2) — `berichtigen`: eine schon eindeutige (gebundene oder geklärte) Grundlage
   * bewusst korrigieren. Derselbe protokollierte Serverweg; der Beleg bleibt unverändert.
   */
  modus?: 'klaeren' | 'berichtigen';
}

type Ort = Bundesland | 'AUSLAND' | '';
type DreiWege = '' | 'ja' | 'nein';

function dreiWege(value: DreiWege): boolean | undefined {
  return value === 'ja' ? true : value === 'nein' ? false : undefined;
}

export function InvoiceFristKlaerungDialog({ vorgangId, invoice, open, onClose, onClarified, translate, actor, modus = 'klaeren' }: Props) {
  const lage = invoiceFristLage(invoice);
  const enden = kalenderFristenden(invoice);
  const kandidaten: readonly Bundesland[] = lage.art === 'inland' ? lage.laender : [];
  const [ort, setOrt] = useState<Ort>('');
  const [fronleichnam, setFronleichnam] = useState<DreiWege>('');
  const [mariaeHimmelfahrt, setMariaeHimmelfahrt] = useState<DreiWege>('');
  const [friedensfest, setFriedensfest] = useState<DreiWege>('');
  const [kalenderEnde, setKalenderEnde] = useState<string>('');
  const [wirksamesEnde, setWirksamesEnde] = useState('');
  const [begruendung, setBegruendung] = useState('');
  const [amKunden, setAmKunden] = useState(false);
  /* END18-R2 — eine Berichtigung, die abgeschlossene Monate berührt, verlangt eine ausdrückliche Bestätigung. */
  const [abschlussBestaetigt, setAbschlussBestaetigt] = useState(false);
  const [errorKey, setErrorKey] = useState<FristKlaerungErrorKey | null>(null);
  const [busy, setBusy] = useState(false);
  /*
   * FINANZ-CORE-01A (END18-R1) — eine Kennung je bewusstem Versuch: Ein wiederholter Klick mit unverändertem
   * Inhalt (etwa nach einer verlorenen Antwort) trifft dieselbe Klärung; eine inhaltliche Änderung ist ein neuer
   * Versuch mit neuer Kennung (`naechsterKlaerungsVersuch`).
   */
  const klaerungsVersuch = useRef<FristKlaerungVersuch | undefined>(undefined);

  useEffect(() => {
    if (!open) return;
    setOrt(lage.art === 'ausland' ? 'AUSLAND' : kandidaten.length === 1 ? kandidaten[0]! : '');
    setFronleichnam('');
    setMariaeHimmelfahrt('');
    setFriedensfest('');
    setKalenderEnde(enden.skonto ?? enden.zahlungsziel ?? '');
    setWirksamesEnde('');
    setBegruendung('');
    setAmKunden(false);
    setAbschlussBestaetigt(false);
    setErrorKey(null);
    setBusy(false);
    klaerungsVersuch.current = undefined;
    // Nur beim Öffnen neu belegen; die Rechnung ändert sich währenddessen nicht.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, invoice.id]);

  if (!open) return null;

  const fristOptionen = [
    ...(enden.skonto ? [{ wert: enden.skonto, label: translate('invoice.frist.deadlineSkonto') }] : []),
    ...(enden.zahlungsziel && enden.zahlungsziel !== enden.skonto
      ? [{ wert: enden.zahlungsziel, label: translate('invoice.frist.deadlinePaymentDue') }]
      : []),
  ];

  const klaerung: InvoiceFristKlaerung | null =
    ort === 'AUSLAND'
      ? kalenderEnde && wirksamesEnde
        ? { art: 'ausland', kalenderEnde, wirksamesEnde }
        : null
      : ort
        ? {
            art: 'inland',
            region: ort,
            ...(ort === 'SN' || ort === 'TH'
              ? dreiWege(fronleichnam) !== undefined
                ? { fronleichnam: dreiWege(fronleichnam) }
                : {}
              : {}),
            ...(ort === 'BY' && dreiWege(mariaeHimmelfahrt) !== undefined
              ? { mariaeHimmelfahrt: dreiWege(mariaeHimmelfahrt) }
              : {}),
            ...(ort === 'BY' && dreiWege(friedensfest) !== undefined
              ? { augsburgerFriedensfest: dreiWege(friedensfest) }
              : {}),
          }
        : null;

  const abgeschlosseneMonate = abgeschlosseneMonateDerRechnung(invoice);
  const canSubmit =
    Boolean(klaerung) &&
    begruendung.trim().length >= 3 &&
    !busy &&
    (abgeschlosseneMonate.length === 0 || abschlussBestaetigt);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!klaerung || busy) return;
    setBusy(true);
    setErrorKey(null);
    const versuch = naechsterKlaerungsVersuch(klaerungsVersuch.current, klaerung, begruendung);
    klaerungsVersuch.current = versuch;
    const result = await klaereRechnungsfrist({
      vorgangId,
      invoiceId: invoice.id,
      klaerung,
      begruendung,
      actor,
      klaerungId: versuch.id,
    });
    if (!result.ok) {
      setErrorKey(result.errorKey);
      setBusy(false);
      return;
    }
    if (amKunden && invoice.customerId) {
      const angabe: CustomerHolidayLocation =
        klaerung.art === 'ausland'
          ? { region: 'AUSLAND' }
          : {
              region: klaerung.region,
              ...(klaerung.fronleichnam !== undefined ? { fronleichnam: klaerung.fronleichnam } : {}),
              ...(klaerung.mariaeHimmelfahrt !== undefined ? { mariaeHimmelfahrt: klaerung.mariaeHimmelfahrt } : {}),
              ...(klaerung.augsburgerFriedensfest !== undefined
                ? { augsburgerFriedensfest: klaerung.augsburgerFriedensfest }
                : {}),
            };
      // Nur für künftige Rechnungen; ein Fehler hier nimmt die Klärung der Rechnung nicht zurück.
      try {
        updateCustomer(invoice.customerId, { holidayLocation: angabe });
      } catch {
        /* sichtbar bleibt die Klärung der Rechnung */
      }
    }
    onClarified(result.invoice);
    onClose();
  };

  return (
    <div className="vorgang-dialog-backdrop" role="presentation" onClick={onClose}>
      <form
        className="vorgang-dialog invoice-cancel-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="invoice-frist-dialog-title"
        data-testid="invoice-frist-dialog"
        onClick={(event) => event.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <h3 id="invoice-frist-dialog-title" className="vorgang-dialog__title">
          {translate(modus === 'berichtigen' ? 'invoice.frist.correctTitle' : 'invoice.frist.title')}
        </h3>

        <p className="invoice-cancel-dialog__notice" data-testid="invoice-frist-intro">
          {translate(modus === 'berichtigen' ? 'invoice.frist.correctIntro' : 'invoice.frist.intro')}
        </p>

        <div data-testid="invoice-frist-facts">
          <div className="data-row">
            <span className="data-row__label">{translate('invoice.frist.invoice')}</span>
            <span className="data-row__value">{invoice.number}</span>
          </div>
          {enden.skonto ? (
            <div className="data-row">
              <span className="data-row__label">{translate('invoice.frist.deadlineSkonto')}</span>
              <span className="data-row__value">{formatDisplayDate(enden.skonto)}</span>
            </div>
          ) : null}
          {enden.zahlungsziel ? (
            <div className="data-row">
              <span className="data-row__label">{translate('invoice.frist.deadlinePaymentDue')}</span>
              <span className="data-row__value">{formatDisplayDate(enden.zahlungsziel)}</span>
            </div>
          ) : null}
          <div className="data-row" data-testid="invoice-frist-current">
            <span className="data-row__label">{translate('invoice.frist.current')}</span>
            <span className="data-row__value">
              {lage.art === 'ausland'
                ? translate('invoice.frist.currentAbroad')
                : lage.art === 'inland'
                  ? lage.laender.map((land) => BUNDESLAND_NAMEN[land]).join(' / ')
                  : translate('invoice.frist.currentWaived')}
            </span>
          </div>
        </div>

        <label className="invoice-payment-form__field">
          <span>{translate('invoice.frist.seat')}</span>
          <select
            className="input"
            value={ort}
            data-testid="invoice-frist-region"
            onChange={(event) => setOrt(event.target.value as Ort)}
          >
            <option value="">{translate('invoice.frist.seatChoose')}</option>
            {kandidaten.length > 1
              ? kandidaten.map((land) => (
                  <option key={`k-${land}`} value={land}>
                    {BUNDESLAND_NAMEN[land]} {translate('invoice.frist.seatCandidate')}
                  </option>
                ))
              : null}
            {BUNDESLAENDER.filter((land) => kandidaten.length <= 1 || !kandidaten.includes(land)).map((land) => (
              <option key={land} value={land}>
                {BUNDESLAND_NAMEN[land]}
              </option>
            ))}
            <option value="AUSLAND">{translate('invoice.frist.seatAbroad')}</option>
          </select>
        </label>

        {ort === 'SN' || ort === 'TH' ? (
          <label className="invoice-payment-form__field">
            <span>{translate('customer.holiday.fronleichnam')}</span>
            <select
              className="input"
              value={fronleichnam}
              data-testid="invoice-frist-fronleichnam"
              onChange={(event) => setFronleichnam(event.target.value as DreiWege)}
            >
              <option value="">{translate('customer.holiday.unknown')}</option>
              <option value="ja">{translate('customer.holiday.yes')}</option>
              <option value="nein">{translate('customer.holiday.no')}</option>
            </select>
          </label>
        ) : null}
        {ort === 'BY' ? (
          <>
            <label className="invoice-payment-form__field">
              <span>{translate('customer.holiday.mariaeHimmelfahrt')}</span>
              <select
                className="input"
                value={mariaeHimmelfahrt}
                data-testid="invoice-frist-mariaeHimmelfahrt"
                onChange={(event) => setMariaeHimmelfahrt(event.target.value as DreiWege)}
              >
                <option value="">{translate('customer.holiday.unknown')}</option>
                <option value="ja">{translate('customer.holiday.yes')}</option>
                <option value="nein">{translate('customer.holiday.no')}</option>
              </select>
            </label>
            <label className="invoice-payment-form__field">
              <span>{translate('customer.holiday.augsburgerFriedensfest')}</span>
              <select
                className="input"
                value={friedensfest}
                data-testid="invoice-frist-augsburgerFriedensfest"
                onChange={(event) => setFriedensfest(event.target.value as DreiWege)}
              >
                <option value="">{translate('customer.holiday.unknown')}</option>
                <option value="ja">{translate('customer.holiday.yes')}</option>
                <option value="nein">{translate('customer.holiday.no')}</option>
              </select>
            </label>
          </>
        ) : null}

        {ort === 'AUSLAND' ? (
          <>
            <p className="invoice-payment-form__hint" data-testid="invoice-frist-abroad-hint">
              {translate('invoice.frist.abroadHint')}
            </p>
            <label className="invoice-payment-form__field">
              <span>{translate('invoice.frist.whichDeadline')}</span>
              <select
                className="input"
                value={kalenderEnde}
                data-testid="invoice-frist-deadline"
                onChange={(event) => setKalenderEnde(event.target.value)}
              >
                {fristOptionen.map((option) => (
                  <option key={option.wert} value={option.wert}>
                    {option.label} ({formatDisplayDate(option.wert)})
                  </option>
                ))}
              </select>
            </label>
            <label className="invoice-payment-form__field">
              <span>{translate('invoice.frist.effectiveEnd')}</span>
              <input
                className="input"
                type="date"
                value={wirksamesEnde}
                min={kalenderEnde || undefined}
                data-testid="invoice-frist-effective-end"
                onChange={(event) => setWirksamesEnde(event.target.value)}
              />
            </label>
          </>
        ) : null}

        <label className="invoice-payment-form__field">
          <span>{translate('invoice.frist.reason')}</span>
          <textarea
            className="input invoice-payment-form__textarea"
            rows={3}
            value={begruendung}
            placeholder={translate('invoice.frist.reasonPlaceholder')}
            required
            data-testid="invoice-frist-reason"
            onChange={(event) => setBegruendung(event.target.value)}
          />
        </label>

        {invoice.customerId ? (
          <label className="invoice-payment-form__checkbox">
            <input
              type="checkbox"
              checked={amKunden}
              data-testid="invoice-frist-save-customer"
              onChange={(event) => setAmKunden(event.target.checked)}
            />
            <span>{translate('invoice.frist.saveAtCustomer')}</span>
          </label>
        ) : null}

        {abgeschlosseneMonate.length > 0 ? (
          <div className="invoice-payment-form__warning" data-testid="invoice-frist-closed-months" data-months={abgeschlosseneMonate.join(',')}>
            <p>{translate('invoice.frist.closedMonths').replace('{months}', abgeschlosseneMonate.join(', '))}</p>
            <label className="invoice-payment-form__checkbox">
              <input
                type="checkbox"
                checked={abschlussBestaetigt}
                data-testid="invoice-frist-closed-ack"
                onChange={(event) => setAbschlussBestaetigt(event.target.checked)}
              />
              <span>{translate('invoice.frist.closedMonthsAck')}</span>
            </label>
          </div>
        ) : null}

        {errorKey ? (
          <p className="invoice-payment-form__error" data-testid="invoice-frist-error">
            {translate(errorKey as TranslationKey)}
          </p>
        ) : null}

        <div className="vorgang-dialog__actions">
          <Button type="submit" fullWidth disabled={!canSubmit} data-testid="invoice-frist-submit">
            {translate('invoice.frist.submit')}
          </Button>
          <Button type="button" variant="secondary" fullWidth onClick={onClose} data-testid="invoice-frist-cancel">
            {translate('common.cancel')}
          </Button>
        </div>
      </form>
    </div>
  );
}
