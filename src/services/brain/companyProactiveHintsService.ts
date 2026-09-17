import type { CompanySessionContext, ProactiveHint } from '../../types/companySession';
import { getAllDocuments } from '../documentService';
import { getInboxItemById } from '../inboxService';
import { processUploadedDocument } from '../intakeWorkflowService';
import { isFinalizedInvoice } from '../invoiceArchiveService';
import { getAllInvoiceOverview } from '../invoiceOverviewService';
import { getAllVorgaenge, getVorgangById } from '../vorgangService';
import { buildHandwerkAdviceForSession } from './handwerkContextAdvisor';
import { buildWorkflowProactiveHints, isMaterialInvoiceInbox } from './workflowIntelligenceService';
import { buildFinanceProactiveHints } from './financeIntelligenceService';

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function baustelleMatches(a: string, b: string): boolean {
  const normA = normalize(a);
  const normB = normalize(b);
  return normA === normB || normA.includes(normB) || normB.includes(normA);
}

function countDocumentsForBaustelle(baustelle: string): number {
  let count = 0;
  for (const vorgang of getAllVorgaenge()) {
    if (baustelleMatches(vorgang.baustelle, baustelle)) {
      count += vorgang.documents.length;
    }
  }
  for (const doc of getAllDocuments()) {
    if (!doc.linkedVorgang) continue;
    const vorgang = getVorgangById(doc.linkedVorgang.vorgangId);
    if (vorgang && baustelleMatches(vorgang.baustelle, baustelle)) {
      count += 1;
    }
  }
  return count;
}

function countOpenInvoicesForCustomer(customer: string): number {
  const norm = normalize(customer);
  return getAllInvoiceOverview().filter((item) => {
    if (normalize(item.customer) !== norm) return false;
    const status = item.paymentSummary.status;
    return status === 'offen' || status === 'ueberfaellig' || status === 'teilbezahlt';
  }).length;
}

export function buildProactiveHints(session: CompanySessionContext): ProactiveHint[] {
  const hints: ProactiveHint[] = [];

  if (session.currentVorgangId) {
    const vorgang = getVorgangById(session.currentVorgangId);
    if (vorgang) {
      const hasInvoice = (vorgang.invoices ?? []).some(isFinalizedInvoice);
      if (!hasInvoice) {
        hints.push({ messageKey: 'companyContext.hint.noInvoiceOnVorgang' });
      }
    }
  }

  if (session.currentCustomer) {
    const openCount = countOpenInvoicesForCustomer(session.currentCustomer);
    if (openCount > 0) {
      hints.push({
        messageKey: 'companyContext.hint.customerOpenInvoices',
        params: { count: openCount, customer: session.currentCustomer },
      });
    }
  }

  if (session.currentBaustelle) {
    const docCount = countDocumentsForBaustelle(session.currentBaustelle);
    if (docCount > 0) {
      hints.push({
        messageKey: 'companyContext.hint.baustelleDocuments',
        params: { count: docCount, baustelle: session.currentBaustelle },
      });
    }
  }

  const uploadId = session.lastUploadInboxId ?? session.currentInboxId;
  if (uploadId) {
    const item = getInboxItemById(uploadId);
    if (item) {
      // F-03 — eine Definition für „Materialrechnung" (siehe workflowIntelligenceService).
      if (isMaterialInvoiceInbox(item)) {
        const workflow = processUploadedDocument(uploadId);
        if (workflow && workflow.similarVorgaenge.length === 1) {
          hints.push({
            messageKey: 'companyContext.hint.materialMatchesVorgang',
            params: { vorgang: workflow.similarVorgaenge[0].title },
          });
        }
      }
    }
  }

  for (const handwerkHint of buildHandwerkAdviceForSession(session)) {
    hints.push({
      messageKey: handwerkHint.messageKey,
      params: handwerkHint.params,
    });
  }

  for (const workflowHint of buildWorkflowProactiveHints(session)) {
    hints.push(workflowHint);
  }

  for (const financeHint of buildFinanceProactiveHints(session)) {
    hints.push(financeHint);
  }

  /*
   * PRODUCT-ACCEPTANCE-FIX-01C (F-03) — mehrere Quellen (Ablauf, Finanzen,
   * Handwerk) können denselben Hinweis liefern; jeder Hinweis erscheint nur
   * einmal (gleicher Schlüssel und gleiche Parameter).
   */
  return dedupeHints(hints);
}

function dedupeHints(hints: ProactiveHint[]): ProactiveHint[] {
  const seen = new Set<string>();
  const unique: ProactiveHint[] = [];
  for (const hint of hints) {
    const signature = `${hint.messageKey}|${JSON.stringify(hint.params ?? {})}`;
    if (seen.has(signature)) continue;
    seen.add(signature);
    unique.push(hint);
  }
  return unique;
}
