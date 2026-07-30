/**
 * OPERATIONAL-EXECUTION-RUNNER-01A — flag matrix, expense runner safety, parity.
 * FIX-01: allowlist prevalidation, lock release, archive already_archived no-op clarity.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OPERATIONAL_EXECUTION_RUNNER_CUTOVER,
  getOperationalExecutionRunnerEnabled,
  setOperationalExecutionRunnerEnabledForTests,
} from '../config/operationalExecutionConfig';
import { hydrateCompanyProfileStore } from './companyProfileService';
import { getAllDocuments, hydrateDocumentStore } from './documentService';
import * as intakeExecutionAtoms from './intakeExecutionAtoms';
import { wouldLinkVorgangOnSmartIntake } from './intakeExecutionGates';
import { executeSmartIntake } from './intakeExecutionService';
import { processUploadedDocument } from './intakeWorkflowService';
import { getInboxItemById, hydrateInboxStore } from './inboxService';
import * as operationalExecutionRunner from './operationalExecutionRunner';
import {
  EXPENSE_RUNNER_ALLOWED_READY_STEPS,
  findDisallowedExpenseRunnerReadySteps,
  isOperationalExecutionRunnerInFlight,
  runOperationalExecutionPlan,
} from './operationalExecutionRunner';
import { buildOperationalExecutionPlan } from './operationalExecutionPlanService';
import { setTaskStoreForTests } from './taskStore';
import { getVorgangById, hydrateVorgangStore } from './vorgangService';
import { createTestVorgang } from '../test/fixtures';
import { getDocumentCase } from '../test/document-cases/_lib/loadCases';
import { runStablePipeline, testProfile } from '../test/document-cases/_lib/runStablePipeline';
import { confirmFilingDecisionForTests } from '../test/confirmFilingDecisionForTests';
import type {
  OperationalExecutionPlan,
  OperationalExecutionStep,
  OperationalExecutionStepId,
} from './operationalExecutionTypes';
import type { SuggestedVorgangLink, WorkflowResult } from '../types/models';

function seedHotel() {
  const docCase = getDocumentCase('HOTEL-01');
  const observation = runStablePipeline(docCase);
  hydrateInboxStore([observation.item]);
  const workflow = processUploadedDocument(observation.item.id) ?? observation.workflow;
  const item = confirmFilingDecisionForTests(observation.item.id);
  return { observation, workflow, item };
}

function spyAllProductiveAtoms() {
  return {
    archive: vi.spyOn(intakeExecutionAtoms, 'executeArchiveAtom'),
    tasks: vi.spyOn(intakeExecutionAtoms, 'executeAcceptTasksAtom'),
    refresh: vi.spyOn(intakeExecutionAtoms, 'executeRefreshPendingAtom'),
    finalize: vi.spyOn(intakeExecutionAtoms, 'executeFinalizeInboxAtom'),
    vorgang: vi.spyOn(intakeExecutionAtoms, 'executeVorgangAtom'),
  };
}

describe('OPERATIONAL-EXECUTION-RUNNER-01A', () => {
  beforeEach(() => {
    localStorage.clear();
    setTaskStoreForTests([]);
    hydrateDocumentStore([]);
    hydrateVorgangStore([]);
    hydrateCompanyProfileStore(testProfile);
    setOperationalExecutionRunnerEnabledForTests(null);
  });

  afterEach(() => {
    setOperationalExecutionRunnerEnabledForTests(null);
    vi.restoreAllMocks();
  });

  describe('flag matrix', () => {
    it('Feature-Flag-Default ist deaktiviert', () => {
      expect(OPERATIONAL_EXECUTION_RUNNER_CUTOVER.enabled).toBe(false);
      setOperationalExecutionRunnerEnabledForTests(null);
      expect(getOperationalExecutionRunnerEnabled()).toBe(false);
    });

    it('Flag aus + Expense → Legacy (kein Runner)', () => {
      setOperationalExecutionRunnerEnabledForTests(false);
      const { workflow } = seedHotel();
      const runSpy = vi.spyOn(operationalExecutionRunner, 'runOperationalExecutionPlan');

      const result = executeSmartIntake(workflow, { companyName: testProfile.companyName });

      expect(runSpy).not.toHaveBeenCalled();
      expect(result.completed).toBe(true);
      expect(result.successSteps).toContain('archive_document');
      expect(result.successSteps).toContain('finalize_inbox');
      expect(result.successSteps).toContain('refresh_pending');
      expect(result.successSteps).not.toContain('create_vorgang');
    });

    it('Flag an + Expense → Runner, Legacy-Orchestrierung nicht zusätzlich', () => {
      setOperationalExecutionRunnerEnabledForTests(true);
      const { workflow, item } = seedHotel();
      const runSpy = vi.spyOn(operationalExecutionRunner, 'runOperationalExecutionPlan');
      // Legacy always calls vorgang atom; expense runner never does — proves no dual run.
      const vorgangSpy = vi.spyOn(intakeExecutionAtoms, 'executeVorgangAtom');

      const result = executeSmartIntake(workflow, { companyName: testProfile.companyName });

      expect(runSpy).toHaveBeenCalledTimes(1);
      expect(vorgangSpy).not.toHaveBeenCalled();
      expect(result.completed).toBe(true);
      expect(result.successSteps).toContain('archive_document');
      expect(result.successSteps).toContain('finalize_inbox');
      expect(result.successSteps).toContain('refresh_pending');
      expect(result.successSteps).not.toContain('create_vorgang');
      expect(result.successSteps).not.toContain('import_positions');
      expect(getInboxItemById(item.id)?.importedToArchive).toBe(true);
    });

    it('Flag an + Contract → Legacy', () => {
      setOperationalExecutionRunnerEnabledForTests(true);
      const docCase = getDocumentCase('WV-LV-01');
      const observation = runStablePipeline(docCase);
      hydrateInboxStore([observation.item]);
      confirmFilingDecisionForTests(observation.item.id);
      const plan = buildOperationalExecutionPlan(observation.workflow, {
        inboxItem: observation.item,
      });
      expect(plan?.playbookId).toBe('contract');

      const runSpy = vi.spyOn(operationalExecutionRunner, 'runOperationalExecutionPlan');
      executeSmartIntake(observation.workflow, {
        companyName: testProfile.companyName,
        materialStandard: 'betrieb',
      });
      expect(runSpy).not.toHaveBeenCalled();
    });

    it('Flag an + Authority → Legacy', () => {
      setOperationalExecutionRunnerEnabledForTests(true);
      const docCase = getDocumentCase('FA-FRIST-01');
      const observation = runStablePipeline(docCase);
      hydrateInboxStore([observation.item]);
      confirmFilingDecisionForTests(observation.item.id);
      expect(
        buildOperationalExecutionPlan(observation.workflow, { inboxItem: observation.item })
          ?.playbookId,
      ).toBe('authority');

      const runSpy = vi.spyOn(operationalExecutionRunner, 'runOperationalExecutionPlan');
      const result = executeSmartIntake(observation.workflow, {
        companyName: testProfile.companyName,
      });
      expect(runSpy).not.toHaveBeenCalled();
      expect(result.successSteps).toContain('finalize_inbox');
    });

    it('kein BI → Legacy (Plan null)', () => {
      setOperationalExecutionRunnerEnabledForTests(true);
      const { workflow, item } = seedHotel();
      const withoutBi: WorkflowResult = { ...workflow, businessInterpretation: null };
      hydrateInboxStore([item]);
      const runSpy = vi.spyOn(operationalExecutionRunner, 'runOperationalExecutionPlan');
      const result = executeSmartIntake(withoutBi, { companyName: testProfile.companyName });
      expect(runSpy).not.toHaveBeenCalled();
      expect(result.successSteps).toContain('finalize_inbox');
    });
  });

  describe('expense eligibility: suggested Vorgang → Legacy (ELIGIBILITY-01)', () => {
    const linkSuggestion = (vorgangId = 'v-expense-link'): SuggestedVorgangLink => ({
      vorgangId,
      vorgangTitle: 'Baustelle Müller',
      customer: 'Familie Müller',
      confidence: 'high',
      reasonKey: 'classification.vorgang.reason.explicit',
    });

    it('A: Expense ohne Vorgangsvorschlag → Runner', () => {
      setOperationalExecutionRunnerEnabledForTests(true);
      const { workflow, item } = seedHotel();
      expect(workflow.suggestedVorgang).toBeFalsy();
      expect(wouldLinkVorgangOnSmartIntake(workflow, item)).toBe(false);

      const runSpy = vi.spyOn(operationalExecutionRunner, 'runOperationalExecutionPlan');
      const vorgangSpy = vi.spyOn(intakeExecutionAtoms, 'executeVorgangAtom');

      const result = executeSmartIntake(workflow, { companyName: testProfile.companyName });

      expect(runSpy).toHaveBeenCalledTimes(1);
      expect(vorgangSpy).not.toHaveBeenCalled();
      expect(result.completed).toBe(true);
      expect(result.successSteps).toContain('archive_document');
      expect(result.successSteps).toContain('refresh_pending');
      expect(result.successSteps).toContain('finalize_inbox');
      expect(result.successSteps).not.toContain('link_vorgang');
    });

    it('B: Expense mit gültigem Vorgangsvorschlag → Legacy mit Link, kein Runner', () => {
      setOperationalExecutionRunnerEnabledForTests(true);
      const { workflow, item } = seedHotel();
      const vorgang = createTestVorgang({
        id: 'v-expense-link',
        title: 'Baustelle Müller',
        customer: 'Familie Müller',
      });
      hydrateVorgangStore([vorgang]);
      hydrateInboxStore([{ ...item, vorgangId: undefined }]);
      const withSuggestion: WorkflowResult = {
        ...workflow,
        suggestedVorgang: linkSuggestion(vorgang.id),
      };
      expect(wouldLinkVorgangOnSmartIntake(withSuggestion, item)).toBe(true);

      const runSpy = vi.spyOn(operationalExecutionRunner, 'runOperationalExecutionPlan');
      const vorgangSpy = vi.spyOn(intakeExecutionAtoms, 'executeVorgangAtom');
      const archiveSpy = vi.spyOn(intakeExecutionAtoms, 'executeArchiveAtom');

      const result = executeSmartIntake(withSuggestion, {
        companyName: testProfile.companyName,
      });

      expect(runSpy).not.toHaveBeenCalled();
      expect(vorgangSpy).toHaveBeenCalledTimes(1);
      expect(archiveSpy).toHaveBeenCalled();
      expect(result.successSteps).toContain('link_vorgang');
      expect(result.successSteps).toContain('archive_document');
      expect(result.successSteps).toContain('finalize_inbox');
      expect(result.vorgangId).toBe(vorgang.id);
      expect(getInboxItemById(item.id)?.vorgangId).toBe(vorgang.id);
      expect(getVorgangById(vorgang.id)).toBeTruthy();
      expect(result.completed).toBe(true);
    });

    it('C: Flag aus + Expense mit Vorgangsvorschlag → Legacy unverändert', () => {
      setOperationalExecutionRunnerEnabledForTests(false);
      const { workflow, item } = seedHotel();
      const vorgang = createTestVorgang({ id: 'v-expense-link-off' });
      hydrateVorgangStore([vorgang]);
      const withSuggestion: WorkflowResult = {
        ...workflow,
        suggestedVorgang: linkSuggestion(vorgang.id),
      };

      const runSpy = vi.spyOn(operationalExecutionRunner, 'runOperationalExecutionPlan');
      const result = executeSmartIntake(withSuggestion, {
        companyName: testProfile.companyName,
      });

      expect(runSpy).not.toHaveBeenCalled();
      expect(result.successSteps).toContain('link_vorgang');
      expect(getInboxItemById(item.id)?.vorgangId).toBe(vorgang.id);
    });

    it('D: null / undefined Vorgangsvorschlag → Runner (gleiche Semantik wie Legacy-Guard)', () => {
      setOperationalExecutionRunnerEnabledForTests(true);
      const { workflow, item } = seedHotel();

      for (const suggestedVorgang of [null, undefined] as const) {
        localStorage.clear();
        setTaskStoreForTests([]);
        hydrateDocumentStore([]);
        hydrateVorgangStore([]);
        hydrateCompanyProfileStore(testProfile);
        const { workflow: w, item: i } = seedHotel();
        const variant: WorkflowResult = { ...w, suggestedVorgang: suggestedVorgang ?? null };
        expect(wouldLinkVorgangOnSmartIntake(variant, i)).toBe(false);

        const runSpy = vi.spyOn(operationalExecutionRunner, 'runOperationalExecutionPlan');
        const result = executeSmartIntake(variant, { companyName: testProfile.companyName });
        expect(runSpy).toHaveBeenCalledTimes(1);
        expect(result.successSteps).not.toContain('link_vorgang');
        expect(result.completed).toBe(true);
        runSpy.mockRestore();
      }

      // Already linked inbox: Legacy would not re-link via suggestion; Runner stays eligible.
      hydrateInboxStore([{ ...item, vorgangId: 'v-already' }]);
      const withSuggestionButLinked: WorkflowResult = {
        ...workflow,
        suggestedVorgang: linkSuggestion('v-already'),
      };
      expect(
        wouldLinkVorgangOnSmartIntake(withSuggestionButLinked, {
          ...item,
          vorgangId: 'v-already',
        }),
      ).toBe(false);
    });

    it('E/F: Adapter mit Vorgangsvorschlag startet Runner nicht (Dual-Execution-Schutz)', () => {
      setOperationalExecutionRunnerEnabledForTests(true);
      const { workflow, item } = seedHotel();
      const vorgang = createTestVorgang({ id: 'v-expense-dual' });
      hydrateVorgangStore([vorgang]);
      const withSuggestion: WorkflowResult = {
        ...workflow,
        suggestedVorgang: linkSuggestion(vorgang.id),
      };

      const runSpy = vi.spyOn(operationalExecutionRunner, 'runOperationalExecutionPlan');
      const atoms = spyAllProductiveAtoms();

      executeSmartIntake(withSuggestion, { companyName: testProfile.companyName });

      expect(runSpy).not.toHaveBeenCalled();
      expect(atoms.vorgang).toHaveBeenCalledTimes(1);
      // Direct runner call with hostile link_vorgang ready remains blocked (existing safety).
      const plan = buildOperationalExecutionPlan(withSuggestion, { inboxItem: item })!;
      const hostile: OperationalExecutionPlan = {
        ...plan,
        steps: [
          { id: 'archive_document', status: 'ready', source: 'playbook' },
          { id: 'link_vorgang', status: 'ready', source: 'workflow_gate' },
          { id: 'finalize_inbox', status: 'ready', source: 'playbook' },
        ],
      };
      const direct = runOperationalExecutionPlan({
        plan: hostile,
        workflow: withSuggestion,
        inboxItem: item,
        options: { companyName: testProfile.companyName },
      });
      expect(direct.completed).toBe(false);
      expect(direct.failedSteps.some((f) => f.message.includes('nicht freigegebene'))).toBe(true);
    });
  });

  describe('allowlist prevalidation (FIX-01)', () => {
    it('fremde ready-Steps mitten im Plan: Abbruch vor erstem Side Effect', () => {
      const { workflow, item } = seedHotel();
      const plan = buildOperationalExecutionPlan(workflow, { inboxItem: item })!;
      const hostile: OperationalExecutionPlan = {
        ...plan,
        steps: [
          { id: 'archive_document', status: 'ready', source: 'playbook' },
          { id: 'accept_tasks', status: 'ready', source: 'playbook' },
          { id: 'create_vorgang', status: 'ready', source: 'workflow_gate' },
          { id: 'finalize_inbox', status: 'ready', source: 'playbook' },
        ],
      };
      expect(findDisallowedExpenseRunnerReadySteps(hostile)).toContain('create_vorgang');

      const atoms = spyAllProductiveAtoms();
      const docsBefore = getAllDocuments().length;
      const runSpy = vi.spyOn(operationalExecutionRunner, 'runOperationalExecutionPlan');

      const result = runOperationalExecutionPlan({
        plan: hostile,
        workflow,
        inboxItem: item,
        options: { companyName: testProfile.companyName },
      });

      expect(result.completed).toBe(false);
      expect(result.successSteps).toEqual([]);
      expect(result.failedSteps.some((f) => f.message.includes('nicht freigegebene'))).toBe(true);
      expect(atoms.archive).not.toHaveBeenCalled();
      expect(atoms.tasks).not.toHaveBeenCalled();
      expect(atoms.refresh).not.toHaveBeenCalled();
      expect(atoms.finalize).not.toHaveBeenCalled();
      expect(getAllDocuments().length).toBe(docsBefore);
      expect(getInboxItemById(item.id)?.importedToArchive).toBeFalsy();
      // Direct runner call — no executeSmartIntake / no legacy path.
      expect(runSpy).toHaveBeenCalled();
    });

    it('fremder ready-Step an erster Stelle: kein Side Effect', () => {
      const { workflow, item } = seedHotel();
      const plan = buildOperationalExecutionPlan(workflow, { inboxItem: item })!;
      const hostile: OperationalExecutionPlan = {
        ...plan,
        steps: [
          { id: 'create_vorgang', status: 'ready', source: 'workflow_gate' },
          { id: 'archive_document', status: 'ready', source: 'playbook' },
          { id: 'finalize_inbox', status: 'ready', source: 'playbook' },
        ],
      };
      const atoms = spyAllProductiveAtoms();
      const result = runOperationalExecutionPlan({
        plan: hostile,
        workflow,
        inboxItem: item,
        options: { companyName: testProfile.companyName },
      });
      expect(result.completed).toBe(false);
      expect(result.successSteps).toEqual([]);
      expect(atoms.archive).not.toHaveBeenCalled();
      expect(atoms.finalize).not.toHaveBeenCalled();
    });

    it('unbekannter ready-Step: Precheck ohne Side Effect', () => {
      const { workflow, item } = seedHotel();
      const plan = buildOperationalExecutionPlan(workflow, { inboxItem: item })!;
      const unknownId = 'totally_unknown_step' as unknown as OperationalExecutionStepId;
      const hostile: OperationalExecutionPlan = {
        ...plan,
        steps: [
          { id: unknownId, status: 'ready', source: 'playbook' } as OperationalExecutionStep,
          { id: 'finalize_inbox', status: 'ready', source: 'playbook' },
        ],
      };
      const atoms = spyAllProductiveAtoms();
      const result = runOperationalExecutionPlan({
        plan: hostile,
        workflow,
        inboxItem: item,
        options: { companyName: testProfile.companyName },
      });
      expect(result.completed).toBe(false);
      expect(result.successSteps).toEqual([]);
      expect(result.failedSteps[0]?.message).toContain('totally_unknown_step');
      expect(atoms.archive).not.toHaveBeenCalled();
      expect(atoms.finalize).not.toHaveBeenCalled();
    });

    it('Expense + suggestedVorgang-ready im Plan: Runner bricht ab (kein link_vorgang-Scope)', () => {
      const { workflow, item } = seedHotel();
      const plan = buildOperationalExecutionPlan(workflow, { inboxItem: item })!;
      const withLink: OperationalExecutionPlan = {
        ...plan,
        steps: [
          { id: 'archive_document', status: 'ready', source: 'playbook' },
          { id: 'link_vorgang', status: 'ready', source: 'workflow_gate' },
          { id: 'finalize_inbox', status: 'ready', source: 'playbook' },
        ],
      };
      const atoms = spyAllProductiveAtoms();
      const result = runOperationalExecutionPlan({
        plan: withLink,
        workflow: {
          ...workflow,
          suggestedVorgang: {
            vorgangId: 'v-1',
            vorgangTitle: 'X',
            customer: 'Y',
            confidence: 'high',
            reasonKey: 'test',
          },
        },
        inboxItem: item,
        options: { companyName: testProfile.companyName },
      });
      expect(result.completed).toBe(false);
      expect(result.successSteps).toEqual([]);
      expect(atoms.archive).not.toHaveBeenCalled();
      expect(atoms.vorgang).not.toHaveBeenCalled();
      expect(EXPENSE_RUNNER_ALLOWED_READY_STEPS.has('link_vorgang')).toBe(false);
    });

    it('erlaubter Expense-Plan: Archive → Tasks → Pending → Finalize', () => {
      const { workflow, item } = seedHotel();
      const plan = buildOperationalExecutionPlan(workflow, { inboxItem: item })!;
      expect(findDisallowedExpenseRunnerReadySteps(plan)).toEqual([]);
      const result = runOperationalExecutionPlan({
        plan,
        workflow,
        inboxItem: item,
        options: { companyName: testProfile.companyName },
      });
      const archiveIdx = result.successSteps.indexOf('archive_document');
      const pendingIdx = result.successSteps.indexOf('refresh_pending');
      const finalizeIdx = result.successSteps.indexOf('finalize_inbox');
      expect(result.completed).toBe(true);
      expect(archiveIdx).toBeGreaterThanOrEqual(0);
      expect(pendingIdx).toBeGreaterThan(archiveIdx);
      expect(finalizeIdx).toBeGreaterThan(pendingIdx);
    });
  });

  describe('runner safety', () => {
    it('Extra-Confirm und blocked werden nie ausgeführt; Allowlist-Precheck bei hostile ready', () => {
      const { workflow, item } = seedHotel();
      const plan = buildOperationalExecutionPlan(workflow, { inboxItem: item })!;
      expect(plan.playbookId).toBe('expense');

      const hostile: OperationalExecutionPlan = {
        ...plan,
        steps: [
          ...plan.steps,
          { id: 'import_positions', status: 'ready', source: 'confirm_first' },
          { id: 'reply_handoff', status: 'ready', source: 'confirm_first' },
          { id: 'create_vorgang', status: 'ready', source: 'workflow_gate' },
        ],
      };

      const atoms = spyAllProductiveAtoms();
      const result = runOperationalExecutionPlan({
        plan: hostile,
        workflow,
        inboxItem: item,
        options: { companyName: testProfile.companyName },
      });

      expect(result.completed).toBe(false);
      expect(result.successSteps).toEqual([]);
      expect(result.failedSteps.some((f) => f.message.includes('nicht freigegebene'))).toBe(true);
      expect(atoms.archive).not.toHaveBeenCalled();
      expect(EXPENSE_RUNNER_ALLOWED_READY_STEPS.has('import_positions')).toBe(false);
    });

    it('needs_extra_confirm / blocked / sonstiges skip: keine produktiven Side Effects außer Finalize ready', () => {
      const { workflow, item } = seedHotel();
      const plan = buildOperationalExecutionPlan(workflow, { inboxItem: item })!;
      const blockedOnly: OperationalExecutionPlan = {
        ...plan,
        steps: [
          {
            id: 'archive_document',
            status: 'blocked',
            reasonCode: 'company_not_relevant',
          },
          { id: 'accept_tasks', status: 'skip' },
          {
            id: 'import_positions',
            status: 'needs_extra_confirm',
            confirmRequirement: 'positions_selection',
          },
          { id: 'finalize_inbox', status: 'ready' },
        ],
      };
      const result = runOperationalExecutionPlan({
        plan: blockedOnly,
        workflow,
        inboxItem: item,
        options: { companyName: testProfile.companyName },
      });
      expect(result.successSteps).not.toContain('archive_document');
      expect(result.successSteps).not.toContain('import_positions');
      expect(result.successSteps).not.toContain('accept_tasks');
      expect(result.successSteps).toContain('finalize_inbox');
    });

    it('Archive already_archived skip: idempotenter No-op ohne Re-Import; andere skips ignoriert', () => {
      const { workflow, item } = seedHotel();
      const plan = buildOperationalExecutionPlan(workflow, { inboxItem: item })!;
      // First run archives for real.
      const first = runOperationalExecutionPlan({
        plan,
        workflow,
        inboxItem: item,
        options: { companyName: testProfile.companyName },
      });
      expect(first.completed).toBe(true);
      const archived = getInboxItemById(item.id)!;
      expect(archived.importedToArchive).toBe(true);
      const docsAfterFirst = getAllDocuments().length;

      hydrateInboxStore([archived]);
      const skipPlan: OperationalExecutionPlan = {
        ...plan,
        steps: [
          {
            id: 'archive_document',
            status: 'skip',
            reasonCode: 'already_archived',
            source: 'workflow_gate',
          },
          { id: 'accept_tasks', status: 'skip', reasonCode: 'no_suggested_tasks' },
          { id: 'finalize_inbox', status: 'ready', source: 'playbook' },
        ],
      };

      const importSpy = vi.spyOn(
        // archive atom may call documentService; count docs instead of brittle import spy
        intakeExecutionAtoms,
        'executeArchiveAtom',
      );
      const tasksSpy = vi.spyOn(intakeExecutionAtoms, 'executeAcceptTasksAtom');

      const second = runOperationalExecutionPlan({
        plan: skipPlan,
        workflow,
        inboxItem: archived,
        options: { companyName: testProfile.companyName },
      });

      expect(second.successSteps).toContain('archive_document');
      expect(second.successSteps).toContain('finalize_inbox');
      expect(second.successSteps).not.toContain('accept_tasks');
      expect(importSpy).toHaveBeenCalled();
      expect(tasksSpy).not.toHaveBeenCalled();
      expect(getAllDocuments().length).toBe(docsAfterFirst);
    });
  });

  describe('expense parity Flag aus vs an', () => {
    it('HOTEL normal: completed, archive, finalize, keine Vorgangserzeugung', () => {
      const run = (enabled: boolean) => {
        localStorage.clear();
        setTaskStoreForTests([]);
        hydrateDocumentStore([]);
        hydrateVorgangStore([]);
        hydrateCompanyProfileStore(testProfile);
        setOperationalExecutionRunnerEnabledForTests(enabled);
        const { workflow } = seedHotel();
        return executeSmartIntake(workflow, { companyName: testProfile.companyName });
      };

      const legacy = run(false);
      const runner = run(true);

      expect(legacy.completed).toBe(true);
      expect(runner.completed).toBe(true);
      expect(new Set(legacy.successSteps)).toEqual(new Set(runner.successSteps));
      expect(legacy.positionsAdded).toBe(0);
      expect(runner.positionsAdded).toBe(0);
      expect(getAllDocuments().length).toBeGreaterThanOrEqual(1);
    });

    it('bereits archiviert: idempotenter Archive-Success über Plan-Skip already_archived', () => {
      setOperationalExecutionRunnerEnabledForTests(true);
      const { workflow, item } = seedHotel();
      const first = executeSmartIntake(workflow, { companyName: testProfile.companyName });
      expect(first.completed).toBe(true);
      const refreshed = getInboxItemById(item.id)!;
      hydrateInboxStore([refreshed]);
      const second = executeSmartIntake(
        { ...workflow, inboxItemId: refreshed.id },
        { companyName: testProfile.companyName },
      );
      expect(second.successSteps).toContain('archive_document');
      expect(second.completed).toBe(true);
    });

    it('companyRelevant false: Legacy-Frühpfad (kein Runner)', () => {
      setOperationalExecutionRunnerEnabledForTests(true);
      const { workflow, item } = seedHotel();
      const offline: WorkflowResult = { ...workflow, companyRelevant: false };
      hydrateInboxStore([item]);
      const runSpy = vi.spyOn(operationalExecutionRunner, 'runOperationalExecutionPlan');
      const result = executeSmartIntake(offline, { companyName: testProfile.companyName });
      expect(runSpy).not.toHaveBeenCalled();
      expect(result.failedSteps.some((f) => f.step === 'archive_document')).toBe(true);
      expect(result.successSteps).toContain('finalize_inbox');
      expect(result.completed).toBe(false);
    });

    it('Archive-Fehler ohne Firmenname: Finalize weiter, completed false', () => {
      setOperationalExecutionRunnerEnabledForTests(true);
      const { workflow } = seedHotel();
      const result = executeSmartIntake(workflow, { companyName: '' });
      expect(result.failedSteps.some((f) => f.step === 'archive_document')).toBe(true);
      expect(result.successSteps).toContain('finalize_inbox');
      expect(result.completed).toBe(false);
    });

    it('In-Flight-Schutz: verschachtelter Aufruf scheitert kontrolliert', () => {
      const { workflow, item } = seedHotel();
      const plan = buildOperationalExecutionPlan(workflow, { inboxItem: item })!;
      const originalArchive = intakeExecutionAtoms.executeArchiveAtom;

      const archiveSpy = vi
        .spyOn(intakeExecutionAtoms, 'executeArchiveAtom')
        .mockImplementation((...args) => {
          const nested = runOperationalExecutionPlan({
            plan,
            workflow,
            inboxItem: item,
            options: { companyName: testProfile.companyName },
          });
          expect(nested.completed).toBe(false);
          expect(nested.failedSteps.some((f) => f.message.includes('läuft bereits'))).toBe(true);
          return originalArchive(...args);
        });

      const result = runOperationalExecutionPlan({
        plan,
        workflow,
        inboxItem: item,
        options: { companyName: testProfile.companyName },
      });
      expect(result.completed).toBe(true);
      expect(archiveSpy).toHaveBeenCalled();
    });

    it('Lock-Freigabe nach Fehler: erneute Ausführung möglich', () => {
      const { workflow, item } = seedHotel();
      const plan = buildOperationalExecutionPlan(workflow, { inboxItem: item })!;

      vi.spyOn(intakeExecutionAtoms, 'executeArchiveAtom').mockImplementationOnce(() => {
        throw new Error('simulierter Archive-Fehler');
      });

      const failed = runOperationalExecutionPlan({
        plan,
        workflow,
        inboxItem: item,
        options: { companyName: testProfile.companyName },
      });
      expect(failed.completed).toBe(false);
      expect(failed.failedSteps.some((f) => f.message.includes('simulierter Archive-Fehler'))).toBe(
        true,
      );
      expect(isOperationalExecutionRunnerInFlight(item.id)).toBe(false);

      const retry = runOperationalExecutionPlan({
        plan,
        workflow,
        inboxItem: item,
        options: { companyName: testProfile.companyName },
      });
      expect(isOperationalExecutionRunnerInFlight(item.id)).toBe(false);
      expect(retry.completed).toBe(true);
      expect(retry.successSteps).toContain('finalize_inbox');
    });
  });
});
