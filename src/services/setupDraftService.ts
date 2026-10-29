/**
 * EINRICHTUNG-01 (AP3; O-01.1 bis O-01.3, L3) — der Entwurf des Einrichtungsassistenten überdauert das Schließen des
 * Tabs und ein Neuladen.
 *
 * Bisher lebte er nur im React-Zustand: Wer den Tab schloss, begann von vorn. Jetzt gehört er genau einem Konto und
 * genau einem Betrieb (im lokalen Betrieb dem Gerät). Ein anderes Konto auf demselben Gerät liest ihn nie (O-01.2).
 * Gespeichert wird erst nach einer Eingabe; gelöscht nur nach einem erfolgreichen Abschluss. Scheitert der Abschluss,
 * bleibt er stehen (O-01.3).
 *
 * Der Schlüssel liegt bewusst außerhalb der Präfixe der Geschäftsbestände: Inventur, Notfallseite und Datensicherung
 * sehen ihn nicht — er ist ein Zwischenstand der Eingabe, kein Bestand.
 */
import { INDUSTRY_OPTIONS } from '../data/mockData';
import {
  SETUP_WIZARD_STEPS,
  createDefaultSetupWizardDraft,
  type SetupWizardDraft,
} from '../types/setup';
import type { AppLanguage, MaterialStandard, TaxStatus } from '../types/models';
import type { CommunicationChannel } from '../types/communication';

export const SETUP_DRAFT_KEY_PREFIX = 'officetakt-setup-draft:';

const DRAFT_VERSION = 1;
/** Ein Entwurf ist ein paar hundert Zeichen groß; alles weit darüber ist kein Entwurf dieses Assistenten. */
const MAX_DRAFT_TEXT_LENGTH = 64_000;

const LANGUAGES: readonly AppLanguage[] = ['de', 'tr', 'bg', 'ro', 'ru'];
const TAX_STATUSES: readonly TaxStatus[] = [
  'standard_19',
  'standard_7',
  'kleinunternehmer_19',
  'reverse_charge_13b',
  'tax_free',
  'unclear',
];
const MATERIAL_STANDARDS: readonly MaterialStandard[] = ['auftraggeber', 'betrieb', 'gemischt', 'unclear'];
/** O-04.2 — WhatsApp wird im Assistenten nicht angeboten. */
const WIZARD_CHANNELS: readonly CommunicationChannel[] = ['email', 'letter'];

const TEXT_FIELDS = [
  'industry',
  'companyName',
  'legalForm',
  'contactPerson',
  'street',
  'zip',
  'city',
  'country',
  'email',
  'phone',
  'taxNumber',
  'vatId',
  'bankName',
  'iban',
  'bic',
  'defaultPaymentTerms',
] as const;

/** Wem der Entwurf gehört: dem Konto (mit Betrieb) oder im lokalen Betrieb dem Gerät. */
export interface SetupDraftBinding {
  owner: string;
  workspaceId: string | null;
}

export interface SetupDraftNumericText {
  lastInvoiceNumber: string;
  defaultPaymentDays: string;
}

export interface StoredSetupDraft {
  stepIndex: number;
  draft: SetupWizardDraft;
  numericText: SetupDraftNumericText;
  savedAt: string;
}

/** Ohne Konto (lokaler Betrieb) gehört der Entwurf dem Gerät. */
export function resolveSetupDraftBinding(
  userId: string | null | undefined,
  workspaceId: string | null | undefined,
): SetupDraftBinding {
  const owner = userId?.trim() || 'local';
  const workspace = workspaceId?.trim() || null;
  return { owner, workspaceId: owner === 'local' ? null : workspace };
}

function storageKey(binding: SetupDraftBinding): string {
  return binding.workspaceId
    ? `${SETUP_DRAFT_KEY_PREFIX}${binding.owner}:${binding.workspaceId}`
    : `${SETUP_DRAFT_KEY_PREFIX}${binding.owner}`;
}

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

function isWholeNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 99_999_999;
}

function digitsOr(value: unknown, fallback: number): string {
  return typeof value === 'string' && /^\d{0,8}$/.test(value) ? value : String(fallback);
}

/**
 * Nur, was dieser Assistent selbst schreibt, wird übernommen: bekannte Felder mit dem richtigen Typ. Ein beschädigter
 * oder fremder Eintrag zählt als „kein Entwurf“ — der Assistent beginnt dann mit der normalen Vorbelegung.
 */
function readDraftFields(raw: unknown): SetupWizardDraft | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const draft = createDefaultSetupWizardDraft();
  for (const field of TEXT_FIELDS) {
    const text = value[field];
    if (text === undefined && field === 'legalForm') continue;
    if (typeof text !== 'string') return null;
    draft[field] = text;
  }
  if (!isOneOf(LANGUAGES, value.language)) return null;
  if (!isOneOf(TAX_STATUSES, value.taxStatus)) return null;
  if (!isOneOf(MATERIAL_STANDARDS, value.materialStandard)) return null;
  if (!isWholeNumber(value.defaultPaymentDays) || !isWholeNumber(value.lastInvoiceNumber)) return null;
  draft.language = value.language;
  draft.taxStatus = value.taxStatus;
  draft.materialStandard = value.materialStandard;
  draft.communicationChannel = isOneOf(WIZARD_CHANNELS, value.communicationChannel) ? value.communicationChannel : 'email';
  draft.defaultPaymentDays = value.defaultPaymentDays;
  draft.lastInvoiceNumber = value.lastInvoiceNumber;
  return draft;
}

export function readSetupDraft(binding: SetupDraftBinding): StoredSetupDraft | null {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(storageKey(binding));
  } catch {
    return null;
  }
  if (!raw || raw.length > MAX_DRAFT_TEXT_LENGTH) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    if (!parsed || parsed.version !== DRAFT_VERSION) return null;
    // Die Bindung steht zusätzlich im Eintrag: Ein umkopierter Schlüssel öffnet keinen fremden Entwurf.
    if (parsed.owner !== binding.owner || (parsed.workspaceId ?? null) !== binding.workspaceId) return null;
    const stepIndex = parsed.stepIndex;
    if (typeof stepIndex !== 'number' || !Number.isInteger(stepIndex)) return null;
    if (stepIndex < 0 || stepIndex >= SETUP_WIZARD_STEPS.length) return null;
    const draft = readDraftFields(parsed.draft);
    if (!draft) return null;
    const numeric = (parsed.numericText ?? {}) as Record<string, unknown>;
    return {
      stepIndex,
      draft,
      numericText: {
        lastInvoiceNumber: digitsOr(numeric.lastInvoiceNumber, draft.lastInvoiceNumber),
        defaultPaymentDays: digitsOr(numeric.defaultPaymentDays, draft.defaultPaymentDays),
      },
      savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : '',
    };
  } catch {
    return null;
  }
}

/** `false`, wenn der Speicher nicht schreibbar ist — der Entwurf gilt dann nur, solange der Tab offen ist. */
export function writeSetupDraft(
  binding: SetupDraftBinding,
  value: { stepIndex: number; draft: SetupWizardDraft; numericText: SetupDraftNumericText },
): boolean {
  try {
    localStorage.setItem(
      storageKey(binding),
      JSON.stringify({
        version: DRAFT_VERSION,
        owner: binding.owner,
        workspaceId: binding.workspaceId,
        stepIndex: value.stepIndex,
        draft: value.draft,
        numericText: value.numericText,
        savedAt: new Date().toISOString(),
      }),
    );
    return true;
  } catch {
    return false;
  }
}

export function clearSetupDraft(binding: SetupDraftBinding): void {
  try {
    localStorage.removeItem(storageKey(binding));
  } catch {
    // nichts zu tun
  }
}

/** Die Angaben aus der Registrierung (O-02.1). */
export interface SetupRegistrationPrefill {
  companyName?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  industry?: string;
}

/**
 * EINRICHTUNG-01 (AP3, O-02.1) — was bei der Registrierung schon angegeben wurde, steht im Assistenten. Nur leere
 * Felder werden belegt: Ein vorhandenes Firmenprofil und eigene Eingaben gehen immer vor.
 */
export function applyRegistrationPrefill(draft: SetupWizardDraft, registration: SetupRegistrationPrefill): SetupWizardDraft {
  const next = { ...draft };
  const text = (value: string | undefined) => (value ?? '').trim();
  if (!next.companyName.trim() && text(registration.companyName)) next.companyName = text(registration.companyName);
  const person = [text(registration.firstName), text(registration.lastName)].filter(Boolean).join(' ');
  if (!next.contactPerson.trim() && person) next.contactPerson = person;
  if (!next.email.trim() && text(registration.email)) next.email = text(registration.email);
  if (!next.phone.trim() && text(registration.phone)) next.phone = text(registration.phone);
  const industry = text(registration.industry);
  if (industry && INDUSTRY_OPTIONS.includes(industry) && !INDUSTRY_OPTIONS.includes(next.industry)) {
    next.industry = industry;
  }
  return next;
}
