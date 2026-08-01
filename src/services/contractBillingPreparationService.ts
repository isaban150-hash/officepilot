/**
 * REFERENZVERTRAG V1 – SPRINT D
 * Prepare progress-billing / final-invoice / payment-term facts for the Vorgang.
 * CI first, inbox recognizedData fallback — no invoice creation, no new billing engine.
 */
import type { ContractIntelligenceResult, ContractOrderProposal } from '../types/documentIntelligence';
import type { DetectedPaymentTerm, InboxItem, Vorgang } from '../types/models';
import { analyzeContractIntelligenceFromInbox } from './contractIntelligenceService';
import { getInboxItemById } from './inboxService';

export type VorgangBillingPreparationView = {
  progressBillingAllowed: boolean;
  progressBillingRule?: string;
  paymentDue?: string;
  skonto?: string;
  finalInvoicePlanned: boolean;
  paymentTermsSummary?: string;
  otherTerms: string[];
};

export type ContractBillingPreparationPatch = Record<string, string>;

function trimOrUndefined(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function yesNo(value: boolean): string {
  return value ? 'ja' : 'nein';
}

function parseYesNo(value: string | undefined): boolean | undefined {
  if (!value?.trim()) return undefined;
  const normalized = value.trim().toLowerCase();
  if (['ja', 'yes', 'true', '1'].includes(normalized)) return true;
  if (['nein', 'no', 'false', '0'].includes(normalized)) return false;
  return undefined;
}

function pickTerm(
  terms: DetectedPaymentTerm[],
  ...types: DetectedPaymentTerm['type'][]
): DetectedPaymentTerm | undefined {
  return terms.find((term) => types.includes(term.type));
}

/**
 * Build a recognizedData patch from CI payment terms (leading) + inbox fallback.
 * Only non-empty values — never invent empty placeholders.
 */
export function buildBillingPreparationPatch(input: {
  intelligence?: ContractIntelligenceResult | null;
  proposal?: ContractOrderProposal | null;
  item?: InboxItem | null;
}): ContractBillingPreparationPatch {
  const terms = input.intelligence?.paymentTerms ?? [];
  const inbox = input.item?.recognizedData ?? {};

  const net = pickTerm(terms, 'net_days', 'payment_due');
  const skonto = pickTerm(terms, 'skonto');
  const abschlag = pickTerm(terms, 'weekly_abschlag', 'abschlag');
  const schluss = pickTerm(terms, 'schlussrechnung');

  const progressBillingAllowed =
    input.intelligence != null
      ? input.intelligence.progressBillingAllowed
      : parseYesNo(inbox.AbschlaegeMoeglich) ?? Boolean(abschlag);

  const finalInvoicePlanned =
    input.intelligence != null
      ? input.intelligence.finalInvoiceMentioned
      : parseYesNo(inbox.SchlussrechnungVorgesehen) ?? Boolean(schluss);

  const paymentDue =
    trimOrUndefined(net?.label) ||
    trimOrUndefined(inbox.Zahlungsziel);

  const skontoLabel =
    trimOrUndefined(skonto?.label) ||
    trimOrUndefined(inbox.Skonto);

  const abschlagRule =
    trimOrUndefined(abschlag?.label) ||
    trimOrUndefined(inbox.Abschlagsregel);

  const summary =
    trimOrUndefined(input.proposal?.paymentTermsSummary) ||
    (terms.length > 0 ? terms.map((term) => term.label).join(' · ') : undefined) ||
    trimOrUndefined(inbox.Zahlungsbedingungen);

  const knownTypes = new Set(
    [net, skonto, abschlag, schluss].filter(Boolean).map((term) => term!.type),
  );
  const otherLabels = terms
    .filter((term) => !knownTypes.has(term.type))
    .map((term) => term.label.trim())
    .filter(Boolean);

  const patch: ContractBillingPreparationPatch = {};
  if (paymentDue) patch.Zahlungsziel = paymentDue;
  if (skontoLabel) patch.Skonto = skontoLabel;
  if (abschlagRule) patch.Abschlagsregel = abschlagRule;
  if (summary) patch.Zahlungsbedingungen = summary;
  if (otherLabels.length > 0) patch.WeitereZahlungsbedingungen = otherLabels.join(' · ');

  if (progressBillingAllowed !== undefined && progressBillingAllowed !== null) {
    patch.AbschlaegeMoeglich = yesNo(Boolean(progressBillingAllowed));
  }
  if (finalInvoicePlanned !== undefined && finalInvoicePlanned !== null) {
    patch.SchlussrechnungVorgesehen = yesNo(Boolean(finalInvoicePlanned));
  }

  return patch;
}

export function buildVorgangBillingPreparationView(
  vorgang: Vorgang,
): VorgangBillingPreparationView | null {
  const inbox = vorgang.createdFromInboxId
    ? getInboxItemById(vorgang.createdFromInboxId)
    : undefined;

  const data = inbox?.recognizedData ?? {};
  const intelligence = inbox ? analyzeContractIntelligenceFromInbox(inbox) : null;

  const fromPatch = buildBillingPreparationViewFromSources({
    recognizedData: data,
    intelligence,
    paymentTermsSummary: intelligence
      ? intelligence.paymentTerms.map((term) => term.label).join(' · ')
      : undefined,
  });

  if (
    !fromPatch.paymentDue &&
    !fromPatch.skonto &&
    !fromPatch.progressBillingRule &&
    !fromPatch.paymentTermsSummary &&
    !fromPatch.progressBillingAllowed &&
    !fromPatch.finalInvoicePlanned &&
    fromPatch.otherTerms.length === 0
  ) {
    // Still show when we explicitly know "no" for both flags from prepared data.
    if (
      parseYesNo(data.AbschlaegeMoeglich) === false &&
      parseYesNo(data.SchlussrechnungVorgesehen) === false
    ) {
      return fromPatch;
    }
    return null;
  }

  return fromPatch;
}

export function buildBillingPreparationViewFromSources(input: {
  recognizedData?: Record<string, string>;
  intelligence?: ContractIntelligenceResult | null;
  paymentTermsSummary?: string;
}): VorgangBillingPreparationView {
  const data = input.recognizedData ?? {};
  const terms = input.intelligence?.paymentTerms ?? [];

  const net = pickTerm(terms, 'net_days', 'payment_due');
  const skontoTerm = pickTerm(terms, 'skonto');
  const abschlag = pickTerm(terms, 'weekly_abschlag', 'abschlag');

  const progressBillingAllowed =
    parseYesNo(data.AbschlaegeMoeglich) ??
    input.intelligence?.progressBillingAllowed ??
    Boolean(abschlag);

  const finalInvoicePlanned =
    parseYesNo(data.SchlussrechnungVorgesehen) ??
    input.intelligence?.finalInvoiceMentioned ??
    Boolean(pickTerm(terms, 'schlussrechnung'));

  const paymentDue =
    trimOrUndefined(data.Zahlungsziel) ||
    trimOrUndefined(net?.label) ||
    undefined;

  const skonto =
    trimOrUndefined(data.Skonto) ||
    trimOrUndefined(skontoTerm?.label) ||
    undefined;

  const progressBillingRule =
    trimOrUndefined(data.Abschlagsregel) ||
    trimOrUndefined(abschlag?.label) ||
    undefined;

  const paymentTermsSummary =
    trimOrUndefined(data.Zahlungsbedingungen) ||
    trimOrUndefined(input.paymentTermsSummary) ||
    (terms.length > 0 ? terms.map((term) => term.label).join(' · ') : undefined);

  const otherFromData = trimOrUndefined(data.WeitereZahlungsbedingungen);
  const known = new Set(
    [paymentDue, skonto, progressBillingRule].filter(Boolean).map((value) => value!.toLowerCase()),
  );
  const otherTerms = (
    otherFromData
      ? otherFromData.split('·').map((part) => part.trim())
      : terms
          .filter((term) => !['net_days', 'payment_due', 'skonto', 'abschlag', 'weekly_abschlag', 'schlussrechnung'].includes(term.type))
          .map((term) => term.label.trim())
  ).filter((label) => label && !known.has(label.toLowerCase()));

  return {
    progressBillingAllowed: Boolean(progressBillingAllowed),
    progressBillingRule,
    paymentDue,
    skonto,
    finalInvoicePlanned: Boolean(finalInvoicePlanned),
    paymentTermsSummary,
    otherTerms,
  };
}
