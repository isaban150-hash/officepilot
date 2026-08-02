/**
 * OPERATIONAL-EXECUTION-PLAN-01 + FIX-01 — plan builder, legacy-parity preview, confirm-first.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppProvider } from './context/AppContext';
import { DEFAULT_SETUP } from './data/mockData';
import { hydrateCompanyProfileStore } from './services/companyProfileService';
import { hydrateInboxStore } from './services/inboxService';
import { EingangDetailPage } from './pages/EingangDetailPage';
import { getDocumentCase } from './test/document-cases/_lib/loadCases';
import { runStablePipeline, testProfile } from './test/document-cases/_lib/runStablePipeline';
import { buildOperationalExecutionContext } from './services/operationalExecutionContext';
import {
  buildOperationalExecutionPlan,
  buildOperationalExecutionPlanFromContext,
  buildOperationalExecutionPreview,
  selectOperationalPlaybook,
} from './services/operationalExecutionPlanService';
import type { OperationalExecutionContext } from './services/operationalExecutionTypes';
import { OPERATIONAL_PLAYBOOKS } from './services/operationalExecutionPlaybooks';
import { buildOperationalOverviewView } from './services/operationalOverviewView';
import { OperationalOverview } from './components/inbox/review/OperationalOverview';
import { t, type TranslationKey } from './i18n';
import { resetDeferredWorkflowAnalysisCacheForTests } from './services/inboxWorkflowAnalysisKey';
import { canCreateVorgangFromSmartIntakeGates } from './services/intakeExecutionGates';

const FORBIDDEN = [
  'auto_send',
  'auto_payment',
  'auto_customer_create',
  'auto_invoice_finalize',
  'auto_position_import',
] as const;

function baseContext(
  overrides: Partial<OperationalExecutionContext>,
): OperationalExecutionContext {
  return {
    primaryCase: 'review_required',
    meanings: ['review'],
    companyRelevant: true,
    alreadyArchived: false,
    hasVorgangLink: false,
    hasSuggestedVorgang: false,
    hasSuggestedTasks: false,
    hasContractAnalysis: false,
    hasApplyableContractFields: false,
    hasContractOrderProposal: false,
    hasSuggestedPositions: false,
    hasPositionsConfirmUi: false,
    canCreateVorgang: false,
    wouldApplyContractFields: false,
    hasMoney: false,
    recognitionUncertain: false,
    missingInformationCount: 0,
    conflictCount: 0,
    requiredConfirmationIds: [],
    classifiedKind: 'sonstiges',
    ...overrides,
  };
}

function statusMap(plan: ReturnType<typeof buildOperationalExecutionPlanFromContext>) {
  return Object.fromEntries(plan.steps.map((step) => [step.id, step.status]));
}

function seedCase(caseId: string) {
  const docCase = getDocumentCase(caseId);
  const observation = runStablePipeline(docCase);
  const item = {
    ...observation.item,
    id: `inbox-plan-${caseId}`,
    markedAsCompanyDocument: true,
  };
  hydrateInboxStore([item]);
  return { docCase, observation, item };
}

function renderDetail(itemId: string): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[`/ablage/${itemId}`]}>
      <AppProvider initialSetup={DEFAULT_SETUP}>
        <Routes>
          <Route path="/ablage/:id" element={<EingangDetailPage />} />
        </Routes>
      </AppProvider>
    </MemoryRouter>,
  );
}

describe('OPERATIONAL-EXECUTION-PLAN-01 — playbooks are data only', () => {
  it('defines six playbooks without functions', () => {
    expect(Object.keys(OPERATIONAL_PLAYBOOKS).sort()).toEqual(
      [
        'authority',
        'communication',
        'contract',
        'expense',
        'general_document',
        'invoice',
      ].sort(),
    );
    for (const playbook of Object.values(OPERATIONAL_PLAYBOOKS)) {
      expect(playbook.stepOrder.length).toBeGreaterThan(0);
      expect(playbook.allowedSteps).toEqual(expect.arrayContaining(playbook.stepOrder));
      for (const id of FORBIDDEN) {
        expect(playbook.forbiddenActions).toContain(id);
      }
    }
  });
});

describe('OPERATIONAL-EXECUTION-PLAN-01 — reference cases (unit)', () => {
  it('1 Werkvertrag / LV → contract; create via kundenauftrag, apply only with analysis', () => {
    const context = baseContext({
      primaryCase: 'possible_new_order',
      meanings: ['obligation', 'money', 'action_required'],
      companyRelevant: true,
      hasContractOrderProposal: true,
      hasSuggestedPositions: true,
      hasPositionsConfirmUi: true,
      hasSuggestedTasks: true,
      documentType: 'kundenauftrag',
      canCreateVorgang: true,
      hasContractAnalysis: true,
      hasApplyableContractFields: true,
      wouldApplyContractFields: true,
      classifiedKind: 'werkvertrag',
    });
    expect(selectOperationalPlaybook(context)).toBe('contract');
    const plan = buildOperationalExecutionPlanFromContext(context);
    const statuses = statusMap(plan);
    expect(statuses.archive_document).toBe('ready');
    expect(statuses.create_vorgang).toBe('ready');
    expect(statuses.apply_contract_fields).toBe('ready');
    expect(statuses.accept_tasks).toBe('ready');
    expect(statuses.finalize_inbox).toBe('ready');
    expect(statuses.import_positions).toBe('needs_extra_confirm');
  });

  it('2 Finanzamt → authority, reply in internal plan as extra confirm', () => {
    const context = baseContext({
      primaryCase: 'authority_documents_required',
      companyRelevant: true,
      hasSuggestedTasks: true,
      classifiedKind: 'finanzamt',
    });
    const plan = buildOperationalExecutionPlanFromContext(context);
    expect(plan.playbookId).toBe('authority');
    const statuses = statusMap(plan);
    expect(statuses.archive_document).toBe('ready');
    expect(statuses.accept_tasks).toBe('ready');
    expect(statuses.reply_handoff).toBe('needs_extra_confirm');
  });

  it('3 Hotel → expense, no vorgang / invoice steps', () => {
    const context = baseContext({
      primaryCase: 'expense_hotel',
      companyRelevant: true,
      hasSuggestedTasks: true,
      classifiedKind: 'rechnung',
    });
    const plan = buildOperationalExecutionPlanFromContext(context);
    expect(plan.playbookId).toBe('expense');
    expect(plan.steps.some((s) => s.id === 'create_vorgang')).toBe(false);
    expect(plan.steps.some((s) => s.id === 'open_invoice_workflow')).toBe(false);
  });

  it('4 Kunden-E-Mail → communication, reply never ready', () => {
    const context = baseContext({
      primaryCase: 'communication_schedule_change',
      companyRelevant: true,
      hasSuggestedVorgang: true,
      classifiedKind: 'brief',
    });
    const plan = buildOperationalExecutionPlanFromContext(context);
    expect(statusMap(plan).reply_handoff).toBe('needs_extra_confirm');
    expect(plan.forbiddenActions).toContain('auto_send');
  });

  it('5 Eingangsrechnung → invoice; open_invoice stays internal only', () => {
    const context = baseContext({
      primaryCase: 'invoice_received',
      companyRelevant: true,
      hasSuggestedTasks: true,
      hasSuggestedVorgang: true,
    });
    const plan = buildOperationalExecutionPlanFromContext(context);
    expect(statusMap(plan).open_invoice_workflow).toBe('needs_extra_confirm');
  });

  it('6 unsicher → general_document; review internal ready, archive blocked', () => {
    const context = baseContext({
      primaryCase: 'review_required',
      companyRelevant: false,
      recognitionUncertain: true,
    });
    const plan = buildOperationalExecutionPlanFromContext(context);
    const statuses = statusMap(plan);
    expect(statuses.review_document).toBe('ready');
    expect(statuses.archive_document).toBe('blocked');
    expect(statuses.finalize_inbox).toBe('skip');
    expect(plan.warnings).toContain('recognition_uncertain');
  });
});

describe('OPERATIONAL-EXECUTION-PLAN-01-FIX-01 — legacy parity for visible ready', () => {
  it('create_vorgang is not ready from proposal alone', () => {
    const context = baseContext({
      primaryCase: 'possible_new_order',
      companyRelevant: true,
      hasContractOrderProposal: true,
      hasSuggestedPositions: true,
      canCreateVorgang: false,
      wouldApplyContractFields: false,
    });
    const plan = buildOperationalExecutionPlanFromContext(context);
    expect(statusMap(plan).create_vorgang).toBe('blocked');
    expect(statusMap(plan).apply_contract_fields).toBe('skip');
  });

  it('apply_contract_fields requires contractAnalysis path (wouldApplyContractFields)', () => {
    const without = baseContext({
      primaryCase: 'possible_new_order',
      companyRelevant: true,
      hasContractOrderProposal: true,
      canCreateVorgang: true,
      documentType: 'kundenauftrag',
      wouldApplyContractFields: false,
      hasContractAnalysis: false,
    });
    expect(statusMap(buildOperationalExecutionPlanFromContext(without)).apply_contract_fields).toBe(
      'skip',
    );

    const withAnalysis = baseContext({
      primaryCase: 'possible_new_order',
      companyRelevant: true,
      canCreateVorgang: true,
      documentType: 'kundenauftrag',
      hasContractAnalysis: true,
      hasApplyableContractFields: true,
      wouldApplyContractFields: true,
    });
    expect(
      statusMap(buildOperationalExecutionPlanFromContext(withAnalysis)).apply_contract_fields,
    ).toBe('ready');
  });

  it('shared canCreate gate ignores proposal alone', () => {
    expect(
      canCreateVorgangFromSmartIntakeGates(
        {
          companyRelevant: true,
          contractAnalysis: null,
          classification: null,
        },
        { vorgangId: undefined, documentType: undefined },
      ),
    ).toBe(false);
    expect(
      canCreateVorgangFromSmartIntakeGates(
        {
          companyRelevant: true,
          contractAnalysis: null,
          classification: null,
        },
        { vorgangId: undefined, documentType: 'kundenauftrag' },
      ),
    ).toBe(true);
  });

  it('preview hides review_document and open_invoice_workflow', () => {
    const unsure = baseContext({
      primaryCase: 'review_required',
      companyRelevant: true,
    });
    const unsurePlan = buildOperationalExecutionPlanFromContext(unsure);
    const unsurePreview = buildOperationalExecutionPreview(unsurePlan, unsure, {
      replyAssistAvailable: false,
      positionsConfirmAvailable: false,
    });
    expect(unsurePreview.rows.some((r) => r.stepId === 'review_document')).toBe(false);

    const invoice = baseContext({
      primaryCase: 'invoice_received',
      companyRelevant: true,
      hasSuggestedTasks: true,
    });
    const invoicePlan = buildOperationalExecutionPlanFromContext(invoice);
    const invoicePreview = buildOperationalExecutionPreview(invoicePlan, invoice, {
      replyAssistAvailable: false,
      positionsConfirmAvailable: false,
    });
    expect(invoicePreview.rows.some((r) => r.stepId === 'open_invoice_workflow')).toBe(false);
    expect(invoicePreview.rows.map((r) => r.stepId)).toEqual([
      'archive_document',
      'accept_tasks',
      'finalize_inbox',
    ]);
  });

  it('reply_handoff visible only with real reply assist surface', () => {
    const context = baseContext({
      primaryCase: 'authority_documents_required',
      companyRelevant: true,
      hasSuggestedTasks: true,
      classifiedKind: 'finanzamt',
    });
    const plan = buildOperationalExecutionPlanFromContext(context);
    const without = buildOperationalExecutionPreview(plan, context, {
      replyAssistAvailable: false,
      positionsConfirmAvailable: false,
    });
    expect(without.rows.some((r) => r.stepId === 'reply_handoff')).toBe(false);

    const withAssist = buildOperationalExecutionPreview(plan, context, {
      replyAssistAvailable: true,
      positionsConfirmAvailable: false,
    });
    expect(withAssist.rows.some((r) => r.stepId === 'reply_handoff')).toBe(true);
    expect(withAssist.hintKey).toBe('operationalExecution.preview.hintWithExtra');
  });

  it('import_positions visible only with positions confirm UI', () => {
    const context = baseContext({
      primaryCase: 'possible_new_order',
      companyRelevant: true,
      hasSuggestedPositions: true,
      hasPositionsConfirmUi: true,
      canCreateVorgang: true,
      documentType: 'kundenauftrag',
    });
    const plan = buildOperationalExecutionPlanFromContext(context);
    const hidden = buildOperationalExecutionPreview(plan, context, {
      replyAssistAvailable: false,
      positionsConfirmAvailable: false,
    });
    expect(hidden.rows.some((r) => r.stepId === 'import_positions')).toBe(false);

    const shown = buildOperationalExecutionPreview(
      plan,
      { ...context, hasPositionsConfirmUi: true },
      { replyAssistAvailable: false, positionsConfirmAvailable: true },
    );
    expect(shown.rows.some((r) => r.stepId === 'import_positions')).toBe(true);
  });

  it('accept_tasks / link_vorgang / archive require real gates', () => {
    const noTasks = baseContext({
      primaryCase: 'invoice_received',
      companyRelevant: true,
      hasSuggestedTasks: false,
    });
    expect(statusMap(buildOperationalExecutionPlanFromContext(noTasks)).accept_tasks).toBe('skip');

    const noLink = baseContext({
      primaryCase: 'invoice_received',
      companyRelevant: true,
      hasSuggestedVorgang: false,
    });
    expect(statusMap(buildOperationalExecutionPlanFromContext(noLink)).link_vorgang).toBe('skip');

    const archived = baseContext({
      primaryCase: 'expense_hotel',
      companyRelevant: true,
      alreadyArchived: true,
    });
    expect(statusMap(buildOperationalExecutionPlanFromContext(archived)).archive_document).toBe(
      'skip',
    );
  });
});

describe('OPERATIONAL-EXECUTION-PLAN-01 — safety', () => {
  it('never marks forbidden actions as ready steps; positions/reply confirm-first', () => {
    const plans = [
      buildOperationalExecutionPlanFromContext(
        baseContext({
          primaryCase: 'possible_new_order',
          hasContractOrderProposal: true,
          hasSuggestedPositions: true,
          canCreateVorgang: true,
          documentType: 'kundenauftrag',
        }),
      ),
      buildOperationalExecutionPlanFromContext(
        baseContext({ primaryCase: 'authority_documents_required' }),
      ),
      buildOperationalExecutionPlanFromContext(
        baseContext({ primaryCase: 'communication_request' }),
      ),
      buildOperationalExecutionPlanFromContext(
        baseContext({ primaryCase: 'invoice_received' }),
      ),
    ];
    for (const plan of plans) {
      for (const id of FORBIDDEN) expect(plan.forbiddenActions).toContain(id);
      expect(plan.steps.some((s) => s.id === 'import_positions' && s.status === 'ready')).toBe(
        false,
      );
      expect(plan.steps.some((s) => s.id === 'reply_handoff' && s.status === 'ready')).toBe(false);
      expect(
        plan.steps.some((s) => s.id === 'open_invoice_workflow' && s.status === 'ready'),
      ).toBe(false);
    }
  });
});

describe('OPERATIONAL-EXECUTION-PLAN-01 — document-case shadow plans', () => {
  beforeEach(() => {
    localStorage.clear();
    hydrateCompanyProfileStore(testProfile);
    hydrateInboxStore([]);
  });

  it.each([
    ['WV-LV-01', 'contract'],
    ['FA-FRIST-01', 'authority'],
    ['HOTEL-01', 'expense'],
    ['MAIL-TERMIN-01', 'communication'],
    ['ER-01', 'invoice'],
    ['UNSURE-01', 'general_document'],
  ] as const)('%s selects playbook %s', (caseId, playbookId) => {
    const { observation, item } = seedCase(caseId);
    expect(observation.bi).not.toBeNull();
    const plan = buildOperationalExecutionPlan(observation.workflow, { inboxItem: item });
    expect(plan).not.toBeNull();
    expect(plan!.playbookId).toBe(playbookId);
    for (const id of FORBIDDEN) expect(plan!.forbiddenActions).toContain(id);
  });

  it('WV-LV: internal positions confirm-first; preview omits apply without contractAnalysis', () => {
    const { observation, item } = seedCase('WV-LV-01');
    const context = buildOperationalExecutionContext(observation.workflow, { inboxItem: item })!;
    const plan = buildOperationalExecutionPlanFromContext(context);
    expect(plan.steps.find((s) => s.id === 'import_positions')?.status).toBe(
      'needs_extra_confirm',
    );
    // Specialist path has proposal, not contractAnalysis — apply must not be ready.
    expect(context.hasContractAnalysis).toBe(false);
    expect(statusMap(plan).apply_contract_fields).toBe('skip');

    const preview = buildOperationalExecutionPreview(plan, context, {
      replyAssistAvailable: false,
      positionsConfirmAvailable: Boolean(observation.workflow.contractOrderProposal),
    });
    expect(preview.rows.some((r) => r.stepId === 'apply_contract_fields')).toBe(false);
    expect(preview.rows.some((r) => r.stepId === 'import_positions')).toBe(true);
    expect(preview.rows.some((r) => r.stepId === 'review_document')).toBe(false);
  });

  it('MAIL: reply not in preview without reply assist', () => {
    const { observation, item } = seedCase('MAIL-TERMIN-01');
    const view = buildOperationalOverviewView(observation.workflow, { inboxItem: item });
    expect(view.planPreviewRows.some((r) => r.stepId === 'reply_handoff')).toBe(false);
    expect(view.planPreviewRows.some((r) => r.stepId === 'open_invoice_workflow')).toBe(false);
  });

  it('FA: reply appears when classified as finanzamt', () => {
    const { observation, item } = seedCase('FA-FRIST-01');
    const view = buildOperationalOverviewView(observation.workflow, {
      inboxItem: { ...item, classifiedKind: item.classifiedKind ?? 'finanzamt' },
    });
    // Internal plan keeps reply; visible only if support check passes.
    const plan = buildOperationalExecutionPlan(observation.workflow, { inboxItem: item })!;
    expect(plan.steps.find((s) => s.id === 'reply_handoff')?.status).toBe('needs_extra_confirm');
    expect(view.planPreviewTitleKey).toBe('operationalExecution.preview.title');
  });

  it('context merges existing workflow flags only', () => {
    const { observation, item } = seedCase('ER-01');
    const context = buildOperationalExecutionContext(observation.workflow, { inboxItem: item });
    expect(context!.primaryCase).toBe(observation.bi!.operational.primaryCase);
    expect(context!.companyRelevant).toBe(observation.workflow.companyRelevant);
  });
});

describe('OPERATIONAL-EXECUTION-PLAN-01 — UI preview', () => {
  beforeEach(() => {
    localStorage.clear();
    hydrateCompanyProfileStore(testProfile);
    hydrateInboxStore([]);
    resetDeferredWorkflowAnalysisCacheForTests();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('shows defensive title, no technical ids, single primary; hides unbound steps', () => {
    const { item, observation } = seedCase('WV-LV-01');
    const view = buildOperationalOverviewView(observation.workflow, { inboxItem: item });
    expect(view.planPreviewRows.some((r) => r.stepId === 'review_document')).toBe(false);
    expect(view.planPreviewRows.some((r) => r.stepId === 'open_invoice_workflow')).toBe(false);

    const html = renderToStaticMarkup(
      <OperationalOverview
        view={view}
        translate={(key: TranslationKey) => t(key, 'de')}
        primaryAction={{
          label: t('reviewWorkflow.action.applySuggestion', 'de'),
          disabled: false,
          loading: false,
          onClick: () => undefined,
        }}
      />,
    );

    expect(html).toContain('data-testid="operational-execution-plan-preview"');
    expect(html).toContain(t('operationalExecution.preview.title', 'de'));
    expect(html).toContain(t('operationalExecution.preview.hintWithExtra', 'de'));
    expect(html).not.toContain('Was passiert nach Bestätigung');
    expect(html).not.toContain('archive_document');
    expect(html).not.toContain('import_positions');
    expect(html).not.toContain('needs_extra_confirm');
    expect(html).not.toContain(t('operationalExecution.step.review_document', 'de'));
    expect(html.match(/data-testid="document-review-primary-action"/g)?.length ?? 0).toBe(1);
  });

  it('preview rows omit skip; Turkish labels resolve', () => {
    const context = baseContext({
      primaryCase: 'invoice_received',
      hasSuggestedTasks: true,
    });
    const plan = buildOperationalExecutionPlanFromContext(context);
    const rows = buildOperationalExecutionPreview(plan, context, {
      replyAssistAvailable: false,
      positionsConfirmAvailable: false,
    }).rows;
    expect(rows.every((r) => r.status !== ('skip' as typeof r.status))).toBe(true);
    for (const row of rows) {
      expect(t(row.labelKey, 'de')).not.toBe(row.labelKey);
      expect(t(row.labelKey, 'tr')).not.toBe(row.labelKey);
    }
  });

  it('UNSURE does not show review_document as executable preview step', () => {
    const { item, observation } = seedCase('UNSURE-01');
    // Shadow plan still excludes review_document from executable preview rows.
    const view = buildOperationalOverviewView(observation.workflow, { inboxItem: item });
    expect(view.planPreviewRows.some((r) => r.stepId === 'review_document')).toBe(false);

    const html = renderDetail(item.id);
    // DOCUMENT-EXPERIENCE-02B: Experience Card first paint (not OperationalOverview).
    expect(html).toContain('data-testid="document-experience-card"');
    expect(html).not.toContain('data-testid="operational-overview"');
    expect(html).not.toContain(t('operationalExecution.step.review_document', 'de'));
    expect(html).not.toContain('archive_document');
    expect(html.match(/data-testid="document-review-apply-button"/g)?.length ?? 0).toBeLessThanOrEqual(
      1,
    );
  });

  it('preview sits before primary; details stay closed', () => {
    const { item, observation } = seedCase('FA-FRIST-01');
    // Plan preview remains a view-model concern; not mounted as overview first paint.
    const view = buildOperationalOverviewView(observation.workflow, { inboxItem: item });
    expect(view.planPreviewRows.length).toBeGreaterThan(0);

    const html = renderDetail(item.id);
    expect(html).toContain('data-testid="document-experience-card"');
    expect(html).not.toContain('data-testid="operational-overview"');
    expect(html).not.toContain('data-testid="operational-execution-plan-preview"');

    // Lead surface before primary CTA; Experience Details (E) stay collapsed.
    const experience = html.indexOf('data-testid="document-experience-card"');
    const primary = html.indexOf('document-review-apply-button');
    expect(experience).toBeGreaterThanOrEqual(0);
    expect(primary).toBeGreaterThan(experience);
    expect(html).not.toMatch(/data-testid="document-experience-details"[^>]*\sopen[\s>]/);
  });
});
