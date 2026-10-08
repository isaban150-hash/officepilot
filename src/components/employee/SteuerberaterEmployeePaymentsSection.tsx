import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import { DetailSection } from '../ui/Section';
import type { TranslationKey } from '../../i18n';
import { collectMonatsmappeInput } from '../../services/steuerberater/monatsmappeInputService';
import {
  MITARBEITER_ZAHLUNG_EINORDNUNG,
  buildMitarbeiterZahlungen,
} from '../../services/steuerberater/monatsmappeModelService';
import { formatEuroAmount } from '../../utils/displayFormat';
import { EMPLOYEE_PAYMENTS_ROUTE } from './PayrollDocumentHint';
import { fillText } from './employeePaymentUi';

/**
 * P1 MITARBEITERZAHLUNGEN — der neutrale Bereich „Mitarbeiterzahlungen" auf der
 * Steuerberater-Seite.
 *
 * Dieselben Zeilen wie \`mitarbeiter_zahlungen.csv\` (eine Ableitung, keine
 * zweite Zählung). Keine Lohnabrechnung, keine Steuer, kein Sachkonto — der
 * Steuerberater bekommt die Auszahlungen und die Einordnung je Art.
 */
export function SteuerberaterEmployeePaymentsSection({
  monthKey,
  translate: t,
}: {
  monthKey: string;
  translate: (key: TranslationKey) => string;
}) {
  const zeilen = useMemo(() => buildMitarbeiterZahlungen(collectMonatsmappeInput(monthKey), monthKey).zeilen, [monthKey]);

  const zahlungen = zeilen.filter((zeile) => zeile.art === 'zahlung' && zeile.status === 'aktiv');
  const ohneNachweis = zahlungen.filter((zeile) => zeile.zahlungsart === 'cash' && zeile.nachweisStatus === 'kein').length;
  const summe = Math.round(zeilen.filter((zeile) => zeile.status !== 'storniert').reduce((acc, zeile) => acc + zeile.betrag, 0) * 100) / 100;
  // Hinweise je Art nur zu gültigen Zahlungen — eine stornierte Zahlung braucht keine Prüfung.
  const arten = Array.from(new Set(zahlungen.map((zeile) => zeile.kind)));

  return (
    <DetailSection
      title={t('steuerberater.employeePayments.title')}
      description={
        zeilen.length === 0
          ? t('steuerberater.employeePayments.none')
          : [
              fillText(
                t(zahlungen.length === 1 ? 'steuerberater.employeePayments.summaryPaymentsOne' : 'steuerberater.employeePayments.summaryPayments'),
                { count: zahlungen.length },
              ),
              fillText(
                t(ohneNachweis === 1 ? 'steuerberater.employeePayments.summaryMissingOne' : 'steuerberater.employeePayments.summaryMissing'),
                { missing: ohneNachweis },
              ),
              formatEuroAmount(summe),
            ].join(' · ')
      }
      testId="steuerberater-employee-payments"
    >
      {arten.length > 0 ? (
        <ul className="steuerberater-employee-payments__kinds" data-testid="steuerberater-employee-payments-kinds">
          {arten.map((kind) => (
            <li key={kind}>{MITARBEITER_ZAHLUNG_EINORDNUNG[kind]}</li>
          ))}
        </ul>
      ) : null}
      <p className="steuerberater-employee-payments__note" data-testid="steuerberater-employee-payments-note">
        {t('steuerberater.employeePayments.note')}
      </p>
      <Link to={EMPLOYEE_PAYMENTS_ROUTE} className="btn btn--outline btn--sm" data-testid="steuerberater-employee-payments-link">
        {t('steuerberater.employeePayments.link')}
      </Link>
    </DetailSection>
  );
}
