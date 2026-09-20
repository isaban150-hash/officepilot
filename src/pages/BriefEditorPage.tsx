/**
 * BRIEFE-01C — Geschäftsschreiben erstellen und bearbeiten.
 *
 * Ein zusammenhängender Arbeitsbereich, kein Assistent mit Schritten: oben der
 * Empfänger, darunter das Schreiben. Wer aus einem Kunden oder Auftrag kommt,
 * findet alles vorbelegt und kann es trotzdem ändern — die übernommene
 * Anschrift gehört ab hier zum Brief, nicht mehr zum Kundenstamm.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { isLetterDraftPrefill } from '../services/document/documentReplyBridgeService';
import { Button } from '../components/ui/Button';
import { PageHeader } from '../components/ui/Card';
import { Page } from '../components/ui/Page';
import { DetailSection } from '../components/ui/Section';
import { useApp } from '../context/AppContext';
import {
  addBusinessLetter,
  finalizeBusinessLetter,
  getBusinessLetterById,
  updateBusinessLetter,
} from '../services/businessLetterService';
import { getCustomerById, getCustomerStoreSnapshot } from '../services/customerStoreService';
import { getVorgangById, getAllVorgaenge } from '../services/vorgangService';
import { buildPersistedStateSnapshot } from '../services/persistenceService';
import { resolveCloudWorkspaceId } from '../services/workspace/workspaceSyncPayloadService';
import type { BusinessLetterRecipient } from '../types/businessLetter';
import type { TranslationKey } from '../i18n';

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="invoice-edit__field">
      <span className="invoice-edit__label">{label}</span>
      {children}
    </label>
  );
}

const LEERER_EMPFAENGER: BusinessLetterRecipient = {
  name: '',
  company: '',
  street: '',
  zip: '',
  city: '',
  country: '',
};

export function BriefEditorPage() {
  const { translate, showToast } = useApp();
  const navigate = useNavigate();
  const { letterId } = useParams<{ letterId: string }>();
  const [params] = useSearchParams();
  const location = useLocation();

  /*
   * DOKUMENT-ASSISTENT-01G — eine Vorbelegung aus dem Dokument-Assistenten.
   *
   * Sie kommt als Zustand der Navigation, nicht als Adresszeile: Betreff und
   * Text sind zu lang fuer eine URL, und sie gehoeren nicht in den Verlauf
   * des Browsers. Es wird nichts gespeichert und nichts fertiggestellt — der
   * Editor zeigt nur, was vorbereitet wurde.
   */
  const vorbelegung = isLetterDraftPrefill(
    (location.state as { officetaktLetterDraftPrefill?: unknown } | null)?.officetaktLetterDraftPrefill,
  )
    ? ((location.state as { officetaktLetterDraftPrefill: import('../services/document/documentReplyBridgeService').LetterDraftPrefill })
        .officetaktLetterDraftPrefill)
    : null;

  const vorhandener = letterId ? getBusinessLetterById(letterId) : null;
  const kunden = useMemo(() => getCustomerStoreSnapshot(), []);
  const vorgaenge = useMemo(() => getAllVorgaenge(), []);

  /* Vorbelegung aus dem Einstieg: Kunde oder Auftrag. */
  const startKundeId = params.get('customerId') ?? '';
  const startVorgangId = params.get('vorgangId') ?? '';
  const startKundeAusVorgang = useMemo(() => {
    if (!startVorgangId || startKundeId) return '';
    const vorgang = getVorgangById(startVorgangId);
    return vorgang?.customerId ?? '';
  }, [startVorgangId, startKundeId]);

  const [kundeId, setKundeId] = useState(
    vorhandener?.customerId || startKundeId || vorbelegung?.customerId || startKundeAusVorgang,
  );
  const [vorgangId, setVorgangId] = useState(
    vorhandener?.vorgangId ?? (startVorgangId || vorbelegung?.vorgangId || ''),
  );
  /*
   * Der Regelfall ist ein Schreiben an einen bestehenden Kunden; deshalb steht
   * die Kundenauswahl auch bei einem leeren neuen Schreiben von Anfang an da.
   * Nur ein gespeichertes Schreiben ohne Kunden startet als freier Brief.
   */
  const [freierEmpfaenger, setFreierEmpfaenger] = useState(
    vorhandener ? !vorhandener.customerId : false,
  );
  const [empfaenger, setEmpfaenger] = useState<BusinessLetterRecipient>(() => {
    if (vorhandener?.recipient) return vorhandener.recipient;
    if (vorbelegung) {
      return {
        ...LEERER_EMPFAENGER,
        name: vorbelegung.recipient.name,
        company: vorbelegung.recipient.company ?? '',
        street: vorbelegung.recipient.street ?? '',
        zip: vorbelegung.recipient.zip ?? '',
        city: vorbelegung.recipient.city ?? '',
      };
    }
    return LEERER_EMPFAENGER;
  });
  const [betreff, setBetreff] = useState(vorhandener?.subject ?? vorbelegung?.subject ?? '');
  const [text, setText] = useState(vorhandener?.body ?? vorbelegung?.body ?? '');
  const [briefdatum, setBriefdatum] = useState(
    vorhandener?.letterDate ?? new Date().toISOString().slice(0, 10),
  );
  const [fehler, setFehler] = useState<string | null>(null);
  const [gespeicherteId, setGespeicherteId] = useState(vorhandener?.id ?? '');

  const effektiveKundeId = kundeId || startKundeAusVorgang;

  /* Anschrift aus dem Kundenstamm übernehmen — nur beim Wechsel, nie beim Tippen. */
  useEffect(() => {
    if (freierEmpfaenger || !effektiveKundeId) return;
    const kunde = getCustomerById(effektiveKundeId);
    if (!kunde) return;
    setEmpfaenger((bisher) => {
      const istLeer = !bisher.name && !bisher.company && !bisher.street && !bisher.city;
      if (!istLeer) return bisher;
      return {
        name: kunde.contactPerson?.trim() || kunde.name,
        company: kunde.name,
        street: kunde.street ?? '',
        zip: kunde.zip ?? '',
        city: kunde.city ?? '',
        country: '',
      };
    });
  }, [freierEmpfaenger, effektiveKundeId]);

  /*
   * Ältere Aufträge tragen keinen verknüpften Kundenstamm, wohl aber den
   * Kundennamen im Klartext. Aus dem Auftrag heraus soll der Empfänger trotzdem
   * nicht leer bleiben — der Name wird vorgeschlagen, die Anschrift ergänzt der
   * Anwender. Bereits getippte Angaben bleiben unangetastet.
   */
  useEffect(() => {
    if (!startVorgangId || effektiveKundeId) return;
    const vorgang = getVorgangById(startVorgangId);
    const name = vorgang?.customer?.trim();
    if (!name) return;
    setEmpfaenger((bisher) => {
      const istLeer = !bisher.name && !bisher.company && !bisher.street && !bisher.city;
      return istLeer ? { ...bisher, company: name } : bisher;
    });
  }, [startVorgangId, effektiveKundeId]);

  const istFertig = vorhandener?.status === 'finalized';
  useEffect(() => {
    if (istFertig && vorhandener) navigate(`/schreiben/${vorhandener.id}`, { replace: true });
  }, [istFertig, vorhandener, navigate]);

  const wechsleKunde = (naechsterId: string) => {
    setKundeId(naechsterId);
    const kunde = naechsterId ? getCustomerById(naechsterId) : null;
    if (kunde) {
      setEmpfaenger({
        name: kunde.contactPerson?.trim() || kunde.name,
        company: kunde.name,
        street: kunde.street ?? '',
        zip: kunde.zip ?? '',
        city: kunde.city ?? '',
        country: '',
      });
    }
  };

  const eingaben = () => ({
    subject: betreff,
    body: text,
    letterDate: briefdatum,
    recipient: empfaenger,
    customerId: freierEmpfaenger ? undefined : effektiveKundeId || undefined,
    vorgangId: vorgangId || undefined,
  });

  const melde = (errorKey: string) => {
    setFehler(translate(errorKey as TranslationKey));
  };

  /** Legt beim ersten Speichern an und aktualisiert danach. */
  const sichere = (): string | null => {
    setFehler(null);
    if (gespeicherteId) {
      const ergebnis = updateBusinessLetter(gespeicherteId, eingaben());
      if (!ergebnis.success) {
        melde(ergebnis.errorKey);
        return null;
      }
      return ergebnis.letter.id;
    }
    const workspaceId = resolveCloudWorkspaceId(buildPersistedStateSnapshot()).trim();
    const ergebnis = addBusinessLetter(workspaceId, eingaben());
    if (!ergebnis.success) {
      melde(ergebnis.errorKey);
      return null;
    }
    setGespeicherteId(ergebnis.letter.id);
    return ergebnis.letter.id;
  };

  const handleSpeichern = () => {
    const id = sichere();
    if (!id) return;
    showToast(translate('businessLetter.toast.saved'));
    navigate(`/schreiben/${id}`);
  };

  const handleFertigstellen = () => {
    const id = sichere();
    if (!id) return;
    const ergebnis = finalizeBusinessLetter(id);
    if (!ergebnis.success) {
      melde(ergebnis.errorKey);
      return;
    }
    showToast(translate('businessLetter.toast.finalized'));
    navigate(`/schreiben/${id}`);
  };

  return (
    <Page className="brief-editor" testId="letter-editor-page">
      <PageHeader
        title={translate(
          vorhandener ? 'businessLetter.editor.editTitle' : 'businessLetter.editor.newTitle',
        )}
        backLabel={translate('businessLetter.detail.back')}
        backHref="/schreiben"
        backTestId="letter-editor-back"
      />

      {fehler ? (
        <p className="form-error" role="alert" data-testid="letter-editor-error">
          {fehler}
        </p>
      ) : null}

      <DetailSection title={translate('businessLetter.editor.recipientSection')}>
        <fieldset className="form-group">
          <legend className="invoice-edit__label">
            {translate('businessLetter.editor.recipientKind')}
          </legend>
          <label className="choice">
            <input
              type="radio"
              name="letter-recipient-kind"
              checked={!freierEmpfaenger}
              onChange={() => setFreierEmpfaenger(false)}
              data-testid="letter-kind-customer"
            />
            <span>{translate('businessLetter.editor.recipientCustomer')}</span>
          </label>
          <label className="choice">
            <input
              type="radio"
              name="letter-recipient-kind"
              checked={freierEmpfaenger}
              onChange={() => setFreierEmpfaenger(true)}
              data-testid="letter-kind-free"
            />
            <span>{translate('businessLetter.editor.recipientFree')}</span>
          </label>
        </fieldset>

        {!freierEmpfaenger ? (
          <Field label={translate('businessLetter.editor.customer')}>
            <select
              className="input"
              value={effektiveKundeId}
              onChange={(event) => wechsleKunde(event.target.value)}
              data-testid="letter-customer"
            >
              <option value="">{translate('businessLetter.editor.customerPlaceholder')}</option>
              {kunden.map((kunde) => (
                <option key={kunde.id} value={kunde.id}>
                  {kunde.name}
                </option>
              ))}
            </select>
          </Field>
        ) : null}

        <Field label={translate('businessLetter.editor.vorgang')}>
          <select
            className="input"
            value={vorgangId}
            onChange={(event) => setVorgangId(event.target.value)}
            data-testid="letter-vorgang"
          >
            <option value="">{translate('businessLetter.editor.vorgangNone')}</option>
            {vorgaenge.map((vorgang) => (
              <option key={vorgang.id} value={vorgang.id}>
                {vorgang.title}
              </option>
            ))}
          </select>
        </Field>

        <Field label={translate('businessLetter.editor.name')}>
          <input
            className="input"
            value={empfaenger.name}
            onChange={(event) => setEmpfaenger({ ...empfaenger, name: event.target.value })}
            data-testid="letter-recipient-name"
          />
        </Field>
        <Field label={translate('businessLetter.editor.company')}>
          <input
            className="input"
            value={empfaenger.company ?? ''}
            onChange={(event) => setEmpfaenger({ ...empfaenger, company: event.target.value })}
            data-testid="letter-recipient-company"
          />
        </Field>
        <Field label={translate('businessLetter.editor.street')}>
          <input
            className="input"
            value={empfaenger.street}
            onChange={(event) => setEmpfaenger({ ...empfaenger, street: event.target.value })}
            data-testid="letter-recipient-street"
          />
        </Field>
        <Field label={translate('businessLetter.editor.zip')}>
          <input
            className="input"
            value={empfaenger.zip}
            onChange={(event) => setEmpfaenger({ ...empfaenger, zip: event.target.value })}
            data-testid="letter-recipient-zip"
          />
        </Field>
        <Field label={translate('businessLetter.editor.city')}>
          <input
            className="input"
            value={empfaenger.city}
            onChange={(event) => setEmpfaenger({ ...empfaenger, city: event.target.value })}
            data-testid="letter-recipient-city"
          />
        </Field>
        <Field label={translate('businessLetter.editor.country')}>
          <input
            className="input"
            value={empfaenger.country ?? ''}
            onChange={(event) => setEmpfaenger({ ...empfaenger, country: event.target.value })}
            data-testid="letter-recipient-country"
          />
        </Field>
      </DetailSection>

      <DetailSection title={translate('businessLetter.editor.contentSection')}>
        <Field label={translate('businessLetter.editor.letterDate')}>
          <input
            className="input"
            type="date"
            value={briefdatum}
            onChange={(event) => setBriefdatum(event.target.value)}
            data-testid="letter-date"
          />
        </Field>
        <Field label={translate('businessLetter.editor.subject')}>
          <input
            className="input"
            value={betreff}
            onChange={(event) => setBetreff(event.target.value)}
            placeholder={translate('businessLetter.editor.subjectPlaceholder')}
            data-testid="letter-subject"
          />
        </Field>
        <Field label={translate('businessLetter.editor.body')}>
          <textarea
            className="input"
            rows={12}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={translate('businessLetter.editor.bodyPlaceholder')}
            data-testid="letter-body"
          />
        </Field>
      </DetailSection>

      <div className="form-actions">
        <Button type="button" onClick={handleSpeichern} data-testid="letter-save">
          {translate('businessLetter.editor.save')}
        </Button>
        <Button
          type="button"
          variant="secondary"
          onClick={handleFertigstellen}
          data-testid="letter-finalize"
        >
          {translate('businessLetter.editor.finalize')}
        </Button>
      </div>
      <p className="form-hint">{translate('businessLetter.editor.finalizeHint')}</p>
    </Page>
  );
}
