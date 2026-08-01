/**
 * One-shot runtime field trace for WV-LV-01 (CORE diagnostic).
 * Emits TRACE_JSON for Auftraggeber / Auftragnehmer / Baustelle / Positionen / Gesamtbetrag.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { analyzeContractIntelligenceFromText } from '../services/contractIntelligenceService';
import { buildContractOrderProposal } from '../services/contractIntelligenceService';
import { acceptContractOrderFromProposal } from '../services/contractOrderAcceptService';
import { getDocumentCase } from './document-cases/_lib/loadCases';
import { runStablePipeline } from './document-cases/_lib/runStablePipeline';
import { buildSyntheticWerkvertragPages, buildSyntheticWerkvertragText } from './werkvertragMultiSectionFixtures';
import { getReferenceCase } from './reference-tests/_lib/loadReferenceCase';
import { isContractAcceptReference } from './reference-tests/_lib/types';
import { getInboxItemById } from '../services/inboxService';
import { getVorgangById } from '../services/vorgangService';

type FieldSnap = {
  auftraggeber: unknown;
  auftragnehmer: unknown;
  baustelle: unknown;
  positionen: unknown;
  gesamtbetrag: unknown;
};

function snap(partial: FieldSnap): FieldSnap {
  return {
    auftraggeber: partial.auftraggeber ?? null,
    auftragnehmer: partial.auftragnehmer ?? null,
    baustelle: partial.baustelle ?? null,
    positionen: partial.positionen ?? null,
    gesamtbetrag: partial.gesamtbetrag ?? null,
  };
}

function summarizePositions(
  positions: Array<{ description?: string; quantity?: number; unitPrice?: number; totalPrice?: number }>,
) {
  return {
    count: positions.length,
    first3: positions.slice(0, 3).map((p) => ({
      description: p.description,
      quantity: p.quantity,
      unitPrice: p.unitPrice,
      totalPrice: p.totalPrice,
    })),
    sumTotalPrice: positions.reduce((s, p) => s + (Number(p.totalPrice) || 0), 0),
  };
}

describe('PIPELINE-FIELD-TRACE WV-LV-01', () => {
  it('emits per-step field values', () => {
    const pages = buildSyntheticWerkvertragPages();
    const ocrText = buildSyntheticWerkvertragText();
    const docCase = getDocumentCase('WV-LV-01');
    const reference = getReferenceCase('WV-LV-01');
    expect(isContractAcceptReference(reference)).toBe(true);
    if (!isContractAcceptReference(reference)) return;

    const steps: Array<{ step: string; fileHint?: string; values: FieldSnap; notes?: string }> = [];

    // Step 0 — source fixture (ground truth in repo)
    const lvPage = pages.find((p) => p.pageNumber === 8)!;
    steps.push({
      step: '0_source_fixture',
      fileHint: 'src/test/werkvertragMultiSectionFixtures.ts',
      values: snap({
        auftraggeber: 'Isobautec GmbH',
        auftragnehmer: 'Ivan Iliev (as Subunternehmer)',
        baustelle: 'BV Sägewerk Fisch / Möhnetal 55, 59602 Rüthen',
        positionen: {
          count: 11,
          note: 'LV on page 8',
          sample: '1 4.799,00 qm PE-Folie … Gesamtsumme netto 36.029,05 €',
        },
        gesamtbetrag: '36.029,05 € netto (page 8)',
      }),
      notes: 'Literal fixture text before any service call',
    });

    // Step 1 — OCR / loaded case text (same as fixture for WV-LV-01)
    steps.push({
      step: '1_loaded_ocr_text',
      fileHint: 'getDocumentCase(WV-LV-01) → textFixture werkvertragMultiSection',
      values: snap({
        auftraggeber: /Auftraggeber:\s*Isobautec GmbH/.test(docCase.ocrText)
          ? 'Isobautec GmbH (regex hit in ocrText)'
          : 'MISSING in ocrText',
        auftragnehmer: /Subunternehmer:\s*Ivan Iliev/.test(docCase.ocrText)
          ? 'Ivan Iliev (Subunternehmer label)'
          : /Auftragnehmer:\s*/.test(docCase.ocrText)
            ? 'Auftragnehmer label present'
            : 'MISSING',
        baustelle: {
          bezeichnung: /Baustellenbezeichnung:\s*([^\n]+)/.exec(docCase.ocrText)?.[1]?.trim() ?? null,
          adresse: /Baustellenadresse:\s*([^\n]+)/.exec(docCase.ocrText)?.[1]?.trim() ?? null,
        },
        positionen: {
          hasLeistungsverzeichnis: /Leistungsverzeichnis/.test(docCase.ocrText),
          hasPos1: /PE-Folie/.test(docCase.ocrText),
          pageCount: docCase.pages?.length ?? null,
        },
        gesamtbetrag: /Gesamtsumme netto\s*36\.029,05/.test(docCase.ocrText)
          ? '36.029,05 (Gesamtsumme netto hit)'
          : 'MISSING',
      }),
      notes: `ocrText length=${docCase.ocrText.length}; pages=${docCase.pages?.length ?? 0}`,
    });

    // Step 2 — Contract Intelligence direct from text
    const intelligence = analyzeContractIntelligenceFromText(ocrText, pages);
    const fields = intelligence?.contractFields ?? {};
    const parties = intelligence?.parties ?? [];
    steps.push({
      step: '2_contract_intelligence',
      fileHint: 'analyzeContractIntelligenceFromText',
      values: snap({
        auftraggeber: {
          field: fields.auftraggeber?.value ?? null,
          status: fields.auftraggeber?.status ?? null,
          party: parties.find((p) => p.role === 'auftraggeber') ?? null,
        },
        auftragnehmer: {
          field: fields.auftragnehmer?.value ?? null,
          status: fields.auftragnehmer?.status ?? null,
          party: parties.find((p) => p.role === 'auftragnehmer' || p.role === 'subunternehmer') ?? null,
          allPartyRoles: parties.map((p) => ({ role: p.role, name: p.name })),
        },
        baustelle: {
          field: fields.baustelle?.value ?? null,
          status: fields.baustelle?.status ?? null,
          common: intelligence?.commonFields?.baustelle?.value ?? null,
        },
        positionen: summarizePositions(intelligence?.positions ?? []),
        gesamtbetrag: {
          value: intelligence?.contractTotalNet?.value ?? null,
          status: intelligence?.contractTotalNet?.status ?? null,
          sourceText: intelligence?.contractTotalNet?.sourceText ?? null,
        },
      }),
    });

    // Step 3 — Stable pipeline (specialist path for this case)
    const pipeline = runStablePipeline(docCase);
    const wf = pipeline.workflow;
    const ci = wf.contractIntelligence;
    const proposalFromWf = wf.contractOrderProposal;
    steps.push({
      step: '3_stable_pipeline_specialist',
      fileHint: 'runStablePipeline → runContractSpecialistPipeline',
      values: snap({
        auftraggeber: {
          inboxKunde: pipeline.item.recognizedData.Kunde ?? null,
          inboxSender: pipeline.item.sender,
          understandingCustomer: wf.documentUnderstanding?.customer ?? null,
          ciAuftraggeber: ci?.contractFields?.auftraggeber?.value ?? null,
        },
        auftragnehmer: {
          ciAuftragnehmer: ci?.contractFields?.auftragnehmer?.value ?? null,
          parties: ci?.parties?.map((p) => ({ role: p.role, name: p.name })) ?? null,
        },
        baustelle: {
          understanding: wf.documentUnderstanding?.constructionSite ?? null,
          ci: ci?.contractFields?.baustelle?.value ?? null,
        },
        positionen: {
          suggestedOrderPositionsCount: wf.suggestedOrderPositions?.length ?? 0,
          ciPositionsCount: ci?.positions?.length ?? 0,
          proposalPositionsCount: proposalFromWf?.positions?.length ?? 0,
          sample: summarizePositions(ci?.positions ?? []).first3,
        },
        gesamtbetrag: {
          understandingAmount: wf.documentUnderstanding?.amount ?? null,
          ciTotal: ci?.contractTotalNet?.value ?? null,
          proposalTotal: proposalFromWf?.contractTotalNet ?? null,
        },
      }),
      notes: `usedSpecialistPath=${pipeline.usedSpecialistPath}`,
    });

    // Step 4 — BI (facts is BusinessStructuredFacts object, not an array)
    const bi = pipeline.bi;
    steps.push({
      step: '4_business_interpretation',
      fileHint: 'interpretBusinessFromWorkflow',
      values: snap({
        auftraggeber: {
          counterparty: bi?.facts?.parties?.counterparty ?? null,
          ownCompany: bi?.facts?.parties?.ownCompany ?? null,
          partiesList: bi?.parties ?? null,
        },
        auftragnehmer: {
          ownCompany: bi?.facts?.parties?.ownCompany ?? null,
          counterparty: bi?.facts?.parties?.counterparty ?? null,
          others: bi?.facts?.parties?.others ?? null,
        },
        baustelle: {
          site: bi?.facts?.subject?.site ?? null,
          project: bi?.facts?.subject?.project ?? null,
          object: bi?.facts?.subject?.object ?? null,
        },
        positionen: {
          count: bi?.facts?.positions?.length ?? 0,
          sample: (bi?.facts?.positions ?? []).slice(0, 3).map((p) => ({
            description: p.description,
            quantity: p.quantity,
            unitPrice: p.unitPrice,
            lineTotal: p.lineTotal,
          })),
          hasContractOrderProposal: bi?.derivedFrom?.hasContractOrderProposal ?? null,
          meaningSummary: bi?.meaning?.summary ?? null,
        },
        gesamtbetrag: bi?.facts?.money ?? null,
      }),
    });

    // Step 5 — Order proposal
    const item = getInboxItemById(pipeline.item.id) ?? pipeline.item;
    const proposal =
      pipeline.workflow.contractOrderProposal ??
      buildContractOrderProposal(item, pipeline.workflow.contractIntelligence ?? undefined);
    steps.push({
      step: '5_contract_order_proposal',
      fileHint: 'buildContractOrderProposal',
      values: snap({
        auftraggeber: proposal?.customer ?? null,
        auftragnehmer: proposal?.contractor ?? null,
        baustelle: proposal?.constructionSite ?? null,
        positionen: summarizePositions(proposal?.positions ?? []),
        gesamtbetrag: proposal?.contractTotalNet ?? null,
      }),
    });

    // Step 6 — Accept → Vorgang
    const accept = acceptContractOrderFromProposal({
      item: getInboxItemById(item.id) ?? item,
      proposal: proposal!,
      selectedPositions: proposal!.positions,
      companyName: reference.acceptJourney.companyName,
      materialStandard: 'betrieb',
    });
    expect(accept.success).toBe(true);
    if (!accept.success) return;

    const vorgang = getVorgangById(accept.vorgang.id)!;
    const inboxAfter = getInboxItemById(item.id)!;
    steps.push({
      step: '6_accept_vorgang',
      fileHint: 'acceptContractOrderFromProposal',
      values: snap({
        auftraggeber: {
          vorgangCustomer: vorgang.customer,
          billingName: vorgang.customerBilling?.name ?? null,
        },
        auftragnehmer: {
          companyNameArg: reference.acceptJourney.companyName,
          note: 'Own company is accept option, not extracted contractor field on Vorgang',
        },
        baustelle: vorgang.baustelle,
        positionen: summarizePositions(
          vorgang.orderPositions.map((p) => ({
            description: p.description,
            quantity: p.plannedQuantity,
            unitPrice: p.unitPrice,
            totalPrice: p.plannedQuantity * p.unitPrice,
          })),
        ),
        gesamtbetrag: {
          sumPositions: vorgang.orderPositions.reduce(
            (s, p) => s + p.plannedQuantity * p.unitPrice,
            0,
          ),
          inboxRecognized: {
            Kunde: inboxAfter.recognizedData.Kunde ?? null,
            Baustelle: inboxAfter.recognizedData.Baustelle ?? null,
            Angebotssumme: inboxAfter.recognizedData.Angebotssumme ?? null,
          },
        },
      }),
    });

    /** Canonical comparable cores — step shapes differ; compare meaning only. */
    function coreOf(key: keyof FieldSnap, v: unknown): string {
      const s = JSON.stringify(v);
      if (key === 'auftraggeber') {
        if (typeof v === 'string') return v.replace(/\s*\(.*$/, '').trim();
        const o = v as Record<string, unknown> | null;
        if (!o) return 'null';
        if (typeof o.field === 'string' && o.field) return o.field;
        if (typeof o.ciAuftraggeber === 'string' && o.ciAuftraggeber) return o.ciAuftraggeber;
        if (typeof o.counterparty === 'object' && o.counterparty && 'name' in (o.counterparty as object))
          return String((o.counterparty as { name: string }).name);
        if (typeof o.vorgangCustomer === 'string') return o.vorgangCustomer;
        if (typeof o.inboxKunde === 'string' && o.inboxKunde) return o.inboxKunde;
        return s;
      }
      if (key === 'auftragnehmer') {
        if (typeof v === 'string') return v.replace(/\s*\(.*$/, '').trim();
        const o = v as Record<string, unknown> | null;
        if (!o) return 'null';
        if (typeof o.field === 'string' && o.field) return o.field;
        const party = o.party as { name?: string } | null | undefined;
        if (party?.name) return party.name;
        if (typeof o.ciAuftragnehmer === 'string' && o.ciAuftragnehmer) return o.ciAuftragnehmer;
        const parties = (o.parties ?? o.allPartyRoles) as Array<{ role: string; name: string }> | null;
        const sub = parties?.find((p) => p.role === 'subunternehmer' || p.role === 'auftragnehmer');
        if (sub?.name) return sub.name;
        if (typeof o.ownCompany === 'object' && o.ownCompany && 'name' in (o.ownCompany as object))
          return String((o.ownCompany as { name: string }).name);
        if (typeof o.companyNameArg === 'string') return o.companyNameArg;
        return s;
      }
      if (key === 'baustelle') {
        if (typeof v === 'string') return v;
        const o = v as Record<string, unknown> | null;
        if (!o) return 'null';
        if (typeof o.field === 'string' && o.field) return o.field;
        if (typeof o.ci === 'string' && o.ci) return o.ci;
        if (typeof o.bezeichnung === 'string' || typeof o.adresse === 'string')
          return `${String(o.bezeichnung ?? '')} / ${String(o.adresse ?? '')}`.trim();
        const site = o.site as { value?: string } | null | undefined;
        const project = o.project as { value?: string } | null | undefined;
        if (site?.value || project?.value)
          return `${project?.value ?? ''} / ${site?.value ?? ''}`.replace(/^\s*\/\s*|\s*\/\s*$/g, '').trim();
        if (typeof o.understanding === 'string' && o.understanding) return o.understanding;
        return s;
      }
      if (key === 'positionen') {
        const o = v as { count?: number; sumTotalPrice?: number } | null;
        if (o && typeof o.count === 'number') return `count=${o.count};sum=${o.sumTotalPrice ?? '?'}`;
        return s;
      }
      if (key === 'gesamtbetrag') {
        if (typeof v === 'string' || typeof v === 'number') return String(v);
        if (Array.isArray(v)) {
          return (v as Array<{ amount?: number }>).map((m) => m.amount).join(',') || '[]';
        }
        const o = v as Record<string, unknown> | null;
        if (!o) return 'null';
        if (typeof o.value === 'number') return String(o.value);
        if (typeof o.ciTotal === 'number') return String(o.ciTotal);
        if (typeof o.proposalTotal === 'number') return String(o.proposalTotal);
        if (typeof o.sumPositions === 'number') return String(o.sumPositions);
        return s;
      }
      return s;
    }

    // Diff analysis — first semantic change/loss per field (runtime cores)
    const fieldKeys: Array<keyof FieldSnap> = [
      'auftraggeber',
      'auftragnehmer',
      'baustelle',
      'positionen',
      'gesamtbetrag',
    ];
    const firstChange: Record<
      string,
      { step: string; fromStep: string; fromCore: string; toCore: string } | null
    > = {};
    for (const key of fieldKeys) {
      firstChange[key] = null;
      for (let i = 1; i < steps.length; i++) {
        const prevCore = coreOf(key, steps[i - 1]!.values[key]);
        const curCore = coreOf(key, steps[i]!.values[key]);
        if (prevCore !== curCore) {
          firstChange[key] = {
            step: steps[i]!.step,
            fromStep: steps[i - 1]!.step,
            fromCore: prevCore,
            toCore: curCore,
          };
          break;
        }
      }
    }

    const report = {
      caseId: 'WV-LV-01',
      generatedAt: new Date().toISOString(),
      pipelineNote:
        'WV-LV-01 uses specialist path (CI+BI), not full processUploadedDocument — see runStablePipeline.',
      firstChangeOrLoss: firstChange,
      steps,
    };

    const outPath = resolve(process.cwd(), 'tmp-wv-lv-01-field-trace.json');
    writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
    // Also dump a compact marker for the tool log
    console.log('TRACE_WRITTEN', outPath);
    console.log('FIRST_CHANGE', JSON.stringify(firstChange));
    expect(steps.length).toBeGreaterThanOrEqual(6);
  });
});
