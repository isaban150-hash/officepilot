/**
 * BARZAHLUNG-V1 BLOCK 1 — die Auswahl des Zahlungsnachweises.
 *
 * Bewusst eine schlichte Auswahlliste aus dem **vorhandenen** Archiv: Es wird
 * hier nichts hochgeladen und nichts abgelegt. Der Beleg ist längst ein
 * Dokument; die Zahlung merkt sich nur, welches.
 *
 * Optional ist Absicht. Nicht jede Barzahlung hat sofort eine fotografierte
 * Quittung, und ein Formular, das deshalb blockiert, treibt den Nutzer dazu,
 * die Zahlung gar nicht erst zu erfassen — dann fehlt am Ende beides.
 */
import { useMemo } from 'react';
import { getDocumentStoreSnapshot } from '../../services/documentService';
import type { ClassifiedDocumentKind, CompanyDocument } from '../../types/models';
import type { TranslationKey } from '../../i18n';

/**
 * Welche Dokumentarten belegen eine Zahlung?
 *
 * Die vier Barwelt-Arten plus der Kontoauszug — er ist für eine Überweisung
 * genau das, was die Quittung für die Barzahlung ist. Alle fünf gibt es
 * bereits als `ClassifiedDocumentKind`; es wird keine Art erfunden.
 *
 * Eine Eingangsrechnung steht ausdrücklich **nicht** hier: Sie ist die
 * Forderung, nicht ihr Beweis. Beides zu vermischen wäre genau der Fehler,
 * den dieser Block behebt.
 */
export const PAYMENT_PROOF_DOCUMENT_KINDS: readonly ClassifiedDocumentKind[] = [
  'quittung',
  'kassenbeleg',
  'ec_beleg',
  'kreditkartenbeleg',
  'kontoauszug',
];

export function isPaymentProofDocument(document: CompanyDocument): boolean {
  return Boolean(
    document.classifiedKind &&
      PAYMENT_PROOF_DOCUMENT_KINDS.includes(document.classifiedKind),
  );
}

function neuesteZuerst(a: CompanyDocument, b: CompanyDocument): number {
  const links = b.documentDate ?? b.issueDate ?? b.createdAt ?? '';
  const rechts = a.documentDate ?? a.issueDate ?? a.createdAt ?? '';
  return links.localeCompare(rechts);
}

/** Die typischen Zahlungsbelege, neueste zuerst. */
export function listPaymentProofDocuments(): CompanyDocument[] {
  return getDocumentStoreSnapshot().filter(isPaymentProofDocument).sort(neuesteZuerst);
}

/**
 * Alle übrigen Archivdokumente, neueste zuerst.
 *
 * Warum sie überhaupt wählbar sind: `classifiedKind` setzt allein die
 * Erkennung beim Einlesen — das Dokumentformular bietet das Feld gar nicht
 * an. Eine von Hand abgelegte Quittung trüge also **nie** eine der fünf
 * Arten und wäre für immer unwählbar. Lieber nach unten sortieren als
 * aussperren: Der Mensch weiß, was seine Quittung ist; die Erkennung hilft
 * ihm nur beim Suchen.
 */
export function listOtherArchiveDocuments(): CompanyDocument[] {
  return getDocumentStoreSnapshot()
    .filter((document) => !isPaymentProofDocument(document))
    .sort(neuesteZuerst);
}

/**
 * Was der Nutzer liest — nie die technische Kennung.
 *
 * Das Datum wird nur angehängt, wenn es sich wirklich lesen lässt. In der
 * Abnahme standen sonst Einträge wie „… · Invalid Date" in der Liste: Nicht
 * jedes Archivdokument trägt ein Datum im ISO-Format, und ein unlesbares
 * Datum ist schlechter als gar keins.
 */
export function paymentProofLabel(document: CompanyDocument): string {
  const datum = document.documentDate ?? document.issueDate ?? '';
  const gelesen = datum ? new Date(datum) : null;
  const tag =
    gelesen && !Number.isNaN(gelesen.getTime())
      ? gelesen.toLocaleDateString('de-DE')
      : '';
  return [document.title, tag].filter(Boolean).join(' · ');
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  translate: (key: TranslationKey) => string;
  testId: string;
}

export function PaymentProofField({ value, onChange, disabled, translate, testId }: Props) {
  const typische = useMemo(() => listPaymentProofDocuments(), []);
  const weitere = useMemo(() => listOtherArchiveDocuments(), []);
  const dokumente = [...typische, ...weitere];

  return (
    <label className="invoice-payment-form__field">
      <span>{translate('payment.proof')}</span>
      <select
        className="input"
        value={value}
        disabled={disabled}
        data-testid={testId}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">{translate('payment.proof.none')}</option>
        {typische.length > 0 ? (
          <optgroup label={translate('payment.proof.groupTypical')}>
            {typische.map((dokument) => (
              <option key={dokument.id} value={dokument.id}>
                {paymentProofLabel(dokument)}
              </option>
            ))}
          </optgroup>
        ) : null}
        {weitere.length > 0 ? (
          <optgroup label={translate('payment.proof.groupOther')}>
            {weitere.map((dokument) => (
              <option key={dokument.id} value={dokument.id}>
                {paymentProofLabel(dokument)}
              </option>
            ))}
          </optgroup>
        ) : null}
      </select>
      {dokumente.length === 0 ? (
        <small className="detail-hint" data-testid={`${testId}-empty`}>
          {translate('payment.proof.empty')}
        </small>
      ) : (
        <small className="detail-hint" data-testid={`${testId}-hint`}>
          {translate('payment.proof.hint')}
        </small>
      )}
    </label>
  );
}
