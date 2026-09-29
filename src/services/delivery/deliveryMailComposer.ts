/**
 * E-MAIL-07C — Betreff und Nachricht eines neuen Versandentwurfs.
 *
 *   1. Vorlage der Dokumentart: gespeichert im Firmenprofil
 *      (Rechnung: `defaultInvoiceEmail*` aus EMAIL-01B4 — keine zweite
 *      Rechnungsvorlage; Angebot: `defaultOfferEmail*`; Brief:
 *      `defaultLetterEmail*`), sonst eine neutrale Vorgabe ohne Grussformel.
 *      Korrekturbeleg und sonstige Dokumente haben bewusst keine eigene
 *      Einstellung.
 *   2. Platzhalter: nur die, deren Wert es für diese Dokumentart gibt.
 *      Fehlt ein Wert, verschwindet der Platzhalter sauber — nie ein roher
 *      „{{…}}" im Text. Die Altschreibweise `{invoiceNumber}` /
 *      `{companyName}` / `{documentTitle}` gespeicherter Vorlagen gilt weiter.
 *   3. Zentrale Signatur genau einmal: steht sie schon im Text, wird sie
 *      nicht erneut angehängt. Endet eine ältere Vorlage mit einer eigenen
 *      Grussformel, ersetzt die Signatur diese statt sie zu verdoppeln.
 *
 * Nur Vorbelegung: Was der Nutzer im Dialog ändert, bleibt im Dialog; die
 * gespeicherte Vorlage wird hier nie verändert.
 */
import { t, type TranslationKey } from '../../i18n';
import type { AppLanguage, CompanyProfile } from '../../types/models';
import type { DeliveryDocumentKind } from '../../types/documentDelivery';

export type MailTemplateKind = DeliveryDocumentKind;

export const MAIL_TEMPLATE_PLACEHOLDERS = ['companyName', 'customerName', 'documentTitle', 'documentNumber'] as const;
export type MailPlaceholder = (typeof MAIL_TEMPLATE_PLACEHOLDERS)[number];
export type MailPlaceholderValues = Partial<Record<MailPlaceholder, string>>;

/** Welche Platzhalter eine Dokumentart wirklich füllen kann — nur diese werden angeboten. */
export const PLACEHOLDERS_BY_KIND: Record<MailTemplateKind, readonly MailPlaceholder[]> = {
  invoice: ['companyName', 'customerName', 'documentNumber'],
  invoice_correction: ['companyName', 'customerName', 'documentNumber'],
  offer: ['companyName', 'customerName', 'documentTitle', 'documentNumber'],
  letter: ['companyName', 'customerName', 'documentTitle'],
  other: ['companyName', 'customerName', 'documentTitle'],
};

type TemplateProfile = Pick<
  CompanyProfile,
  | 'defaultInvoiceEmailSubject'
  | 'defaultInvoiceEmailBody'
  | 'defaultOfferEmailSubject'
  | 'defaultOfferEmailBody'
  | 'defaultLetterEmailSubject'
  | 'defaultLetterEmailBody'
>;

const PROFILE_FIELDS: Partial<Record<MailTemplateKind, { subject: keyof TemplateProfile; body: keyof TemplateProfile }>> = {
  invoice: { subject: 'defaultInvoiceEmailSubject', body: 'defaultInvoiceEmailBody' },
  offer: { subject: 'defaultOfferEmailSubject', body: 'defaultOfferEmailBody' },
  letter: { subject: 'defaultLetterEmailSubject', body: 'defaultLetterEmailBody' },
};

/** Die gespeicherte bzw. vorgegebene Vorlage einer Dokumentart (ungefüllt). */
export function resolveMailTemplate(
  kind: MailTemplateKind,
  language: AppLanguage,
  profile?: Partial<TemplateProfile>,
): { subject: string; body: string } {
  const fields = PROFILE_FIELDS[kind];
  const stored = (field?: keyof TemplateProfile) => {
    const value = field ? profile?.[field] : undefined;
    return typeof value === 'string' && value.trim() ? value : null;
  };
  return {
    subject: stored(fields?.subject) ?? t(`delivery.template.${kind}.subject` as TranslationKey, language),
    body: stored(fields?.body) ?? t(`delivery.template.${kind}.body` as TranslationKey, language),
  };
}

const LEGACY_PLACEHOLDER_ALIASES: Record<string, MailPlaceholder> = {
  invoiceNumber: 'documentNumber',
  companyName: 'companyName',
  documentTitle: 'documentTitle',
  customerName: 'customerName',
  documentNumber: 'documentNumber',
};

/** Leere Platzhalterreste aufräumen: doppelte Leerzeichen, hängende Trenner, zu viele Leerzeilen. */
function tidy(text: string): string {
  return text
    .split('\n')
    .map((line) =>
      line
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\s+([,.;:!?])/g, '$1')
        .replace(/^\s*[-–—:,]\s+/, '')
        .replace(/\s+[-–—:,]\s*$/, '')
        .replace(/[ \t]+$/g, ''),
    )
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

export function fillMailTemplate(template: string, values: MailPlaceholderValues): string {
  const lookup = (raw: string): string => {
    const key = LEGACY_PLACEHOLDER_ALIASES[raw];
    return key ? (values[key] ?? '').trim() : '';
  };
  const filled = template
    // {{name}} — kanonische Schreibweise; unbekannte oder leere Platzhalter verschwinden.
    .replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, key: string) => lookup(key))
    // {name} — ältere gespeicherte Vorlagen (EMAIL-01B4); nur bekannte Namen.
    .replace(/\{(\w+)\}/g, (match, key: string) => (key in LEGACY_PLACEHOLDER_ALIASES ? lookup(key) : match));
  return tidy(filled).trim();
}

/** Signatur aus den Firmendaten, wenn keine eigene gespeichert ist. */
export function buildDefaultEmailSignature(
  profile: Partial<Pick<CompanyProfile, 'companyName' | 'legalForm' | 'street' | 'zip' | 'city' | 'phone' | 'email'>>,
  language: AppLanguage,
): string {
  const name = [profile.companyName?.trim(), profile.legalForm?.trim()].filter(Boolean).join(' ');
  const place = [profile.zip?.trim(), profile.city?.trim()].filter(Boolean).join(' ');
  const lines = [
    t('delivery.signature.greeting' as TranslationKey, language),
    '',
    name,
    profile.street?.trim(),
    place,
    profile.phone?.trim() ? `${t('delivery.signature.phone' as TranslationKey, language)} ${profile.phone.trim()}` : '',
    profile.email?.trim() ? `${t('delivery.signature.email' as TranslationKey, language)} ${profile.email.trim()}` : '',
  ];
  // Leere Firmenzeilen fallen weg; die Leerzeile nach der Grussformel bleibt.
  return [lines[0], lines[1], ...lines.slice(2).filter((line) => line && line.trim())].join('\n').trim();
}

export function resolveEmailSignature(profile: Partial<CompanyProfile> | undefined, language: AppLanguage): string {
  const stored = profile?.emailSignature;
  if (typeof stored === 'string' && stored.trim()) return stored.trim();
  return profile ? buildDefaultEmailSignature(profile, language) : '';
}

function normalizeForCompare(text: string): string {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .toLowerCase();
}

const GREETING_LINE = /^(mit freundlichen grüßen|mit freundlichen grüssen|freundliche grüße|freundliche grüsse|viele grüße|viele grüsse|beste grüße|beste grüsse|herzliche grüße|saygılarımızla|с уважение)[,.!]?$/i;

/**
 * Signatur genau einmal: bereits enthalten → unverändert. Endet der Text mit
 * einer eigenen Grussformel (ältere Vorlage) und beginnt die Signatur mit
 * einer, ersetzt die Signatur den alten Schlussblock.
 */
export function appendSignatureOnce(body: string, signature: string): string {
  const trimmedSignature = signature.trim();
  const trimmedBody = body.replace(/\s+$/, '');
  if (!trimmedSignature) return trimmedBody;
  if (normalizeForCompare(trimmedBody).includes(normalizeForCompare(trimmedSignature))) return trimmedBody;

  let base = trimmedBody;
  const signatureStartsWithGreeting = GREETING_LINE.test(trimmedSignature.split('\n')[0].trim());
  if (signatureStartsWithGreeting) {
    const lines = base.split('\n');
    // Nur ein Schlussblock am Ende (Grussformel + höchstens zwei Zeilen danach).
    for (let index = lines.length - 1; index >= Math.max(0, lines.length - 3); index -= 1) {
      if (GREETING_LINE.test(lines[index].trim())) {
        base = lines.slice(0, index).join('\n').replace(/\s+$/, '');
        break;
      }
    }
  }
  return base ? `${base}\n\n${trimmedSignature}` : trimmedSignature;
}

export interface ComposedMail {
  subject: string;
  bodyText: string;
}

/** Vorlage auflösen, Platzhalter füllen, Signatur genau einmal anhängen. */
export function composeDeliveryMail(input: {
  kind: MailTemplateKind;
  values: MailPlaceholderValues;
  profile?: Partial<CompanyProfile>;
  language: AppLanguage;
}): ComposedMail {
  const allowed = new Set(PLACEHOLDERS_BY_KIND[input.kind]);
  const values: MailPlaceholderValues = {};
  for (const key of MAIL_TEMPLATE_PLACEHOLDERS) {
    if (allowed.has(key) && input.values[key]?.trim()) values[key] = input.values[key]!.trim();
  }
  const template = resolveMailTemplate(input.kind, input.language, input.profile);
  const subject = fillMailTemplate(template.subject, values).replace(/\n+/g, ' ');
  const body = fillMailTemplate(template.body, values);
  return { subject, bodyText: appendSignatureOnce(body, resolveEmailSignature(input.profile, input.language)) };
}
