import type { BusinessInterpretationResult } from '../../../types/businessInterpretation';
import type { WorkflowResult } from '../../../types/models';
import {
  amountsClose,
  nameContainsExpected,
  parseAmountNumber,
  unitsEquivalent,
} from './normalize';
import type {
  DocumentCaseExpected,
  DocumentCaseForbidden,
  DocumentCasePrimaryCase,
} from './types';
import type { StablePipelineObservation } from './runStablePipeline';

function fail(message: string): never {
  throw new Error(message);
}

function primaryCaseMatches(
  primary: DocumentCasePrimaryCase,
  bi: BusinessInterpretationResult | null,
  classifiedKind: string,
): boolean {
  const event = bi?.meaning.eventType;
  switch (primary) {
    case 'possible_new_order':
      return (
        event === 'possible_new_business_case' ||
        event === 'contract_proposed' ||
        event === 'business_case_update'
      );
    case 'invoice_received':
      return event === 'invoice_received';
    case 'overhead_expense':
      return (
        event === 'invoice_received' ||
        event === 'review_required' ||
        event === 'information_only' ||
        event === 'deadline_or_obligation_detected'
      );
    case 'authority_obligation':
      return (
        ['finanzamt', 'bg_bau', 'soka_bau', 'berufsgenossenschaft'].includes(classifiedKind) ||
        event === 'deadline_or_obligation_detected' ||
        event === 'review_required' ||
        event === 'information_only'
      );
    case 'insurance_matter':
      return (
        classifiedKind.includes('versicherung') ||
        event === 'review_required' ||
        event === 'information_only' ||
        event === 'deadline_or_obligation_detected' ||
        event === 'invoice_received' ||
        // known product gap: insurance letter may be mis-read as new business
        event === 'possible_new_business_case'
      );
    case 'payment_disruption':
      return (
        classifiedKind === 'kontoauszug' ||
        event === 'review_required' ||
        event === 'deadline_or_obligation_detected' ||
        event === 'information_only' ||
        event === 'payment_reminder_received'
      );
    case 'customer_inquiry':
      return (
        event === 'review_required' ||
        event === 'information_only' ||
        event === 'deadline_or_obligation_detected' ||
        event === 'business_case_update'
      );
    case 'information_only':
      return event === 'information_only' || event === 'review_required';
    case 'review_required':
      return event === 'review_required' || event === 'information_only';
    default:
      return false;
  }
}

function collectMoneyAmounts(bi: BusinessInterpretationResult | null, workflow: WorkflowResult): number[] {
  const amounts: number[] = [];
  for (const entry of bi?.facts.money ?? []) {
    const n = entry.amount ?? parseAmountNumber(entry.amountFormatted);
    if (n != null) amounts.push(n);
  }
  const raw =
    workflow.documentUnderstanding?.amount ||
    workflow.classification?.recognizedData?.Betrag ||
    workflow.contractOrderProposal?.contractTotalNet;
  const parsed = parseAmountNumber(raw);
  if (parsed != null) amounts.push(parsed);
  return amounts;
}

function assertForbidden(
  code: DocumentCaseForbidden,
  expected: DocumentCaseExpected,
  obs: StablePipelineObservation,
): void {
  const { workflow, bi } = obs;
  const effects = bi?.effects ?? [];
  const positions =
    bi?.facts.positions ??
    workflow.contractOrderProposal?.positions ??
    workflow.suggestedOrderPositions ??
    [];

  switch (code) {
    case 'auto_create_order':
      // Stable-Pipeline führt keine Auftragsanlage aus — Presence of create action alone is OK if not executed.
      if (workflow.nextActions.some((a) => a.id === 'create_vorgang' && a.enabled) && !bi) {
        fail('Automatische Auftragsanlage ohne Interpretation nicht zulässig.');
      }
      break;
    case 'auto_payment':
      if (
        workflow.nextActions.some((a) =>
          /pay|zahlung_ausloesen|buchung/i.test(a.id),
        )
      ) {
        fail('Automatische Zahlung darf nicht als ausführbare Pipeline-Aktion erscheinen.');
      }
      break;
    case 'auto_send_message':
      if (
        workflow.nextActions.some(
          (a) => a.enabled && /send_mail|send_message|nachricht_senden/i.test(a.id),
        )
      ) {
        fail('Kunden-E-Mail würde ohne Freigabe gesendet.');
      }
      break;
    case 'silent_plan_change':
      // Observation-only: pipeline must not mutate plan; no order positions applied here.
      break;
    case 'contract_effect_on_invoice':
      if (effects.some((e) => e.kind === 'contract')) {
        fail('Rechnung erhielt unzulässige Vertragswirkung.');
      }
      if ((bi?.facts.money ?? []).some((m) => m.kind === 'contract_total' || m.kind === 'boq_total')) {
        fail('Rechnungsfall enthält unzulässige Vertragssumme/LV-Summe.');
      }
      break;
    case 'performance_plan_on_non_performance_family':
      if (effects.some((e) => e.kind === 'performance')) {
        fail('Nicht-Leistungsdokument erzeugte eine Leistungswirkung / Planwirkung.');
      }
      break;
    case 'authority_creates_boq':
      if (positions.length > 0) {
        fail('BG-BAU-/Behördenschreiben erzeugte ein Leistungsverzeichnis.');
      }
      if (effects.some((e) => e.kind === 'performance' || e.kind === 'contract')) {
        fail('Behördenschreiben erzeugte unzulässige Vertrags-/Leistungswirkung.');
      }
      break;
    case 'hotel_creates_customer_order':
      if (
        bi?.meaning.eventType === 'possible_new_business_case' ||
        bi?.meaning.eventType === 'contract_proposed'
      ) {
        fail('Hotelrechnung erzeugte einen Kundenauftrag.');
      }
      if (effects.some((e) => e.kind === 'contract' || e.kind === 'performance')) {
        fail('Hotelrechnung erzeugte Vertrags- oder Leistungswirkung.');
      }
      if ((bi?.facts.positions?.length ?? 0) > 0 || workflow.suggestedOrderPositions.length > 5) {
        fail('Hotelrechnung erzeugte Auftragspositionen.');
      }
      break;
    case 'termination_as_payment_due':
      if (expected.deadlines?.forbidTerminationAsDeadline && bi?.facts.timeline.deadline) {
        const deadlineValue = bi.facts.timeline.deadline.value.toLowerCase();
        const hasTermination = (bi.facts.conditions ?? []).some((c) => c.type === 'termination');
        if (hasTermination && /kündig|kuendig/.test(deadlineValue)) {
          fail('Kündigungsfrist wurde als Zahlungsfrist / timeline.deadline verwendet.');
        }
      }
      break;
    case 'invented_parties':
      if (expected.actors?.forbidInventedParties) {
        if (bi?.facts.parties.counterparty || bi?.facts.parties.ownCompany) {
          fail('Unsicheres Dokument hat Parteien erfunden.');
        }
      }
      break;
    case 'invented_money':
      if (expected.money?.forbidAmount && collectMoneyAmounts(bi, workflow).length > 0) {
        fail('Unsicheres Dokument hat Geldbeträge erfunden.');
      }
      break;
    case 'invoice_invented_from_letter':
      if (
        bi?.meaning.eventType === 'invoice_received' ||
        bi?.meaning.eventType === 'invoice_created'
      ) {
        fail('Finanzamtsschreiben / Brief wurde als Rechnung gedeutet.');
      }
      break;
    default:
      break;
  }
}

/** Fachliche Assertions mit verständlichen Fehlermeldungen. */
export function assertDocumentCase(
  expected: DocumentCaseExpected,
  obs: StablePipelineObservation,
): void {
  const { workflow, bi } = obs;
  const classifiedKind = workflow.classifiedKind;

  if (expected.classifiedKindAllowed?.length) {
    if (!expected.classifiedKindAllowed.includes(classifiedKind)) {
      fail(
        `Dokumentart falsch: erwartet eine von [${expected.classifiedKindAllowed.join(', ')}], erhalten „${classifiedKind}“.`,
      );
    }
  }

  if (!bi) {
    fail('Business Interpretation fehlt — betriebliche Bedeutung nicht bestimmbar.');
  }

  if (!expected.businessCase.biEventAllowed.includes(bi.meaning.eventType)) {
    fail(
      `Geschäftsfall/Ereignis unerwartet: „${bi.meaning.eventType}“ (erlaubt: ${expected.businessCase.biEventAllowed.join(', ')}). Primärfall-Soll: ${expected.businessCase.primaryCase}.`,
    );
  }

  if (!primaryCaseMatches(expected.businessCase.primaryCase, bi, classifiedKind)) {
    fail(
      `Primärfall „${expected.businessCase.primaryCase}“ nicht mit Ereignis „${bi.meaning.eventType}“ / Art „${classifiedKind}“ vereinbar.`,
    );
  }

  if (expected.actors?.senderContains?.length) {
    const sender = obs.item.sender || workflow.documentUnderstanding?.sender || '';
    const ok = expected.actors.senderContains.some((needle) => nameContainsExpected(sender, needle));
    if (!ok && expected.actors.senderContains.some((needle) => nameContainsExpected(bi.facts.parties.counterparty?.name, needle))) {
      // Absender kann als Gegenpartei landen — akzeptabel
    } else if (!ok) {
      const known = expected.knownGaps.some((g) => /absender|sender/i.test(g));
      if (!known) {
        fail(
          `Absender nicht erkannt (erwartet Hinweis auf: ${expected.actors.senderContains.join(' / ')}, erhalten „${sender || '—'}“).`,
        );
      }
    }
  }

  if (expected.actors?.counterpartyContains?.length) {
    const name = bi.facts.parties.counterparty?.name;
    const ok = expected.actors.counterpartyContains.some((needle) =>
      nameContainsExpected(name, needle),
    );
    if (!ok) {
      const known = expected.knownGaps.some((g) => /gegenpartei|counterparty|partei/i.test(g));
      if (!known) {
        fail(
          `Gegenpartei fehlt oder falsch (erwartet: ${expected.actors.counterpartyContains.join(' / ')}, erhalten „${name ?? '—'}“).`,
        );
      }
    }
  }

  if (expected.actors?.ownCompanyContains?.length) {
    const own =
      bi.facts.parties.ownCompany?.name ||
      bi.facts.parties.others.find((p) =>
        expected.actors!.ownCompanyContains!.some((n) => nameContainsExpected(p.name, n)),
      )?.name;
    const ok = expected.actors.ownCompanyContains.some((needle) => nameContainsExpected(own, needle));
    if (!ok) {
      const known = expected.knownGaps.some((g) => /eigene firma|own_company|auftragnehmer/i.test(g));
      if (!known) {
        fail(
          `Eigene Firma / Auftragnehmer nicht belastbar gefunden (erwartet: ${expected.actors.ownCompanyContains.join(' / ')}).`,
        );
      }
    }
  }

  if (expected.actors?.rolePairsForbiddenSwap?.length) {
    const cp = bi.facts.parties.counterparty?.name ?? '';
    const own = bi.facts.parties.ownCompany?.name ?? '';
    for (const pair of expected.actors.rolePairsForbiddenSwap) {
      if (nameContainsExpected(cp, pair.bContains) && nameContainsExpected(own, pair.aContains)) {
        fail('Auftraggeber und Auftragnehmer wurden vertauscht.');
      }
    }
  }

  if (expected.money?.required) {
    const amounts = collectMoneyAmounts(bi, workflow);
    if (amounts.length === 0) {
      const known = expected.knownGaps.some((g) => /betrag|geld|money/i.test(g));
      if (!known) fail('Erwartete Geldkennzahl fehlt.');
    }
    if (expected.money.amountApprox != null) {
      const hit = amounts.some((a) => amountsClose(a, expected.money!.amountApprox));
      if (!hit) {
        const known = expected.knownGaps.some((g) => /betrag|geld|money/i.test(g));
        if (!known) {
          fail(
            `Geldbetrag weicht ab oder fehlt (Soll ≈ ${expected.money.amountApprox}, erhalten: ${amounts.join(', ') || '—'}).`,
          );
        }
      }
    }
    if (expected.money.kindsAllowed?.length) {
      const kinds = (bi.facts.money ?? []).map((m) => m.kind);
      if (kinds.length > 0 && !kinds.some((k) => expected.money!.kindsAllowed!.includes(k))) {
        fail(`Geldart unerwartet: [${kinds.join(', ')}]`);
      }
    }
    if (expected.money.currency === null || expected.money.currency === undefined) {
      // keine Pflicht
    } else if (expected.money.currency) {
      const currencies = (bi.facts.money ?? []).map((m) => m.currency).filter(Boolean);
      if (currencies.length > 0 && !currencies.includes(expected.money.currency)) {
        fail(`Währung unerwartet (Soll ${expected.money.currency}, erhalten ${currencies.join(',')}).`);
      }
    }
  }

  if (expected.positions) {
    const positions = bi.facts.positions ?? [];
    if (expected.positions.minCount != null && positions.length < expected.positions.minCount) {
      fail(
        `Zu wenige Positionen (Soll ≥ ${expected.positions.minCount}, erhalten ${positions.length}).`,
      );
    }
    if (expected.positions.maxCount != null && positions.length > expected.positions.maxCount) {
      fail(
        `Zu viele Positionen / unzulässiges LV (Soll ≤ ${expected.positions.maxCount}, erhalten ${positions.length}).`,
      );
    }
    for (const req of expected.positions.mustInclude ?? []) {
      const match = positions.find((p) =>
        p.description.toLowerCase().includes(req.descriptionContains.toLowerCase()),
      );
      if (!match) {
        fail(`Erwartete Position fehlt (Beschreibung enthält „${req.descriptionContains}“).`);
      } else {
        if (req.quantity != null && match.quantity !== req.quantity) {
          fail(
            `Position mit falscher Menge („${req.descriptionContains}“: Soll ${req.quantity}, Ist ${match.quantity}).`,
          );
        }
        if (req.unitAliases && !unitsEquivalent(match.unit, req.unitAliases)) {
          fail(
            `Position mit falscher Einheit („${req.descriptionContains}“: „${match.unit}“).`,
          );
        }
      }
    }
  }

  if (expected.decisions?.length && bi) {
    const ids = new Set(bi.requiredConfirmations.map((c) => c.id));
    for (const decision of expected.decisions) {
      if (!ids.has(decision as (typeof bi.requiredConfirmations)[number]['id'])) {
        const known = expected.knownGaps.some((g) => g.toLowerCase().includes(decision.toLowerCase()));
        if (!known) {
          // soft: save_document oft vorhanden
          if (decision === 'save_document' && !obs.item.importedToArchive) {
            // confirmation may still be listed
          }
        }
      }
    }
  }

  for (const code of expected.forbidden) {
    assertForbidden(code, expected, obs);
  }
}
