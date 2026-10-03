/**
 * EINGANG-01D-2 — die kompakte, sichtbare Einschätzung eines Eingangs.
 *
 * Zeigt nur, was `deriveIntakeAssessment` aus vorhandener Wahrheit ableitet,
 * und nur die Zeilen, die etwas zu sagen haben. Keine eigene Aktion: Der
 * nächste Schritt ist die Hauptaktion der Karte darüber.
 */
import type { TranslationKey } from '../../../i18n';
import {
  formatIntakeAssessmentAssignment,
  formatIntakeAssessmentDeadline,
  formatIntakeAssessmentOpenDeadline,
  type IntakeAssessment,
} from '../../../services/document/intakeAssessmentService';
import { formatDunningAmount } from '../../../services/document/dunningFinanceTruth';

interface IntakeAssessmentPanelProps {
  assessment: IntakeAssessment;
  translate: (key: TranslationKey) => string;
}

function Row({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div className="intake-assessment__row">
      <dt className="intake-assessment__label">{label}</dt>
      <dd className="intake-assessment__value" data-testid={testId}>
        {value}
      </dd>
    </div>
  );
}

/**
 * EINGANG-02B — Mahnung und bekannte Finanzwahrheit nebeneinander: Forderung
 * laut Mahnung, Rechnungsbezug, bezahlt und offen laut OfficeTakt. Nur
 * Darstellung der im Dienst bereits ermittelten Werte.
 */
function DunningRows({
  dunning,
  translate,
}: {
  dunning: NonNullable<IntakeAssessment['dunning']>;
  translate: (key: TranslationKey) => string;
}) {
  const betrag = (wert: number | undefined) => (wert === undefined ? undefined : formatDunningAmount(wert));
  const zeilen: Array<[TranslationKey, string | undefined, string]> = [
    ['intakeAssessment.label.dunningReference', dunning.invoiceNumber ?? translate('intakeAssessment.dunning.referenceUnclear'), 'intake-assessment-dunning-reference'],
    ['intakeAssessment.label.dunningClaim', betrag(dunning.claimAmount), 'intake-assessment-dunning-claim'],
    ['intakeAssessment.label.dunningPrincipal', betrag(dunning.principalAmount), 'intake-assessment-dunning-principal'],
    ['intakeAssessment.label.dunningFees', betrag(dunning.reminderFees), 'intake-assessment-dunning-fees'],
    ['intakeAssessment.label.dunningInterest', betrag(dunning.interestAmount), 'intake-assessment-dunning-interest'],
    ['intakeAssessment.label.dunningPaid', dunning.invoiceNumber ? betrag(dunning.paidAmount) : undefined, 'intake-assessment-dunning-paid'],
    ['intakeAssessment.label.dunningOpen', dunning.invoiceNumber ? betrag(dunning.openAmount) : undefined, 'intake-assessment-dunning-open'],
    [
      'intakeAssessment.label.bankReconciliation',
      dunning.state === 'paid' || dunning.state === 'partially_paid' ? translate('intakeAssessment.bankReconciliation.unavailable') : undefined,
      'intake-assessment-dunning-bank',
    ],
  ];
  return (
    <>
      {zeilen
        .filter(([, wert]) => Boolean(wert))
        .map(([label, wert, testId]) => (
          <Row key={testId} label={translate(label)} value={wert!} testId={testId} />
        ))}
    </>
  );
}

export function IntakeAssessmentPanel({ assessment, translate }: IntakeAssessmentPanelProps) {
  const kind = assessment.kindLabelKey
    ? translate(assessment.kindLabelKey)
    : assessment.classifiedKind
      ? translate(`classifiedKind.${assessment.classifiedKind}` as TranslationKey)
      : undefined;

  return (
    <section
      className="intake-assessment"
      data-testid="intake-assessment"
      data-role={assessment.role}
      data-status={assessment.status}
      aria-label={translate('intakeAssessment.title')}
    >
      <dl className="intake-assessment__list">
        {kind ? <Row label={translate('intakeAssessment.label.kind')} value={kind} testId="intake-assessment-kind" /> : null}
        {assessment.sender ? (
          <Row label={translate('intakeAssessment.label.sender')} value={assessment.sender} testId="intake-assessment-sender" />
        ) : null}
        {assessment.documentNumber ? (
          <Row
            label={translate('intakeAssessment.label.number')}
            value={assessment.documentNumber}
            testId="intake-assessment-number"
          />
        ) : null}
        <Row
          label={translate('intakeAssessment.label.assignment')}
          value={formatIntakeAssessmentAssignment(assessment, translate)}
          testId="intake-assessment-assignment"
        />
        {assessment.deadline ? (
          <Row
            label={translate('intakeAssessment.label.deadline')}
            value={formatIntakeAssessmentDeadline(assessment.deadline, translate)}
            testId="intake-assessment-deadline"
          />
        ) : assessment.openDeadline ? (
          <Row
            label={translate('intakeAssessment.label.deadline')}
            value={formatIntakeAssessmentOpenDeadline(assessment.openDeadline, translate)}
            testId="intake-assessment-open-deadline"
          />
        ) : null}
        {assessment.dunning ? <DunningRows dunning={assessment.dunning} translate={translate} /> : null}
        <Row
          label={translate('intakeAssessment.label.action')}
          value={translate(`intakeAssessment.action.${assessment.actionNeed}` as TranslationKey)}
          testId="intake-assessment-action"
        />
        <Row
          label={translate('intakeAssessment.label.nextStep')}
          value={translate(assessment.nextStep.labelKey)}
          testId="intake-assessment-next-step"
        />
        <Row
          label={translate('intakeAssessment.label.status')}
          value={translate(`intakeAssessment.status.${assessment.status}` as TranslationKey)}
          testId="intake-assessment-status"
        />
      </dl>
    </section>
  );
}
