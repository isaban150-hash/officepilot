/**
 * OPERATIONAL-EXECUTION-RUNNER-01A — local cutover flag (same override pattern as DI cutovers).
 * Default off. Not a user profile / cloud setting.
 */
export const OPERATIONAL_EXECUTION_RUNNER_CUTOVER = {
  enabled: false,
  /** Playbooks allowed to use the plan runner when the flag is on. */
  allowedPlaybooks: ['expense'] as const,
} as const;

export type OperationalExecutionRunnerPlaybookId =
  (typeof OPERATIONAL_EXECUTION_RUNNER_CUTOVER.allowedPlaybooks)[number];

let operationalExecutionRunnerOverride: boolean | null = null;

export function getOperationalExecutionRunnerEnabled(): boolean {
  if (operationalExecutionRunnerOverride !== null) {
    return operationalExecutionRunnerOverride;
  }
  return OPERATIONAL_EXECUTION_RUNNER_CUTOVER.enabled;
}

/** Test-only override. Pass `null` to restore default. */
export function setOperationalExecutionRunnerEnabledForTests(value: boolean | null): void {
  operationalExecutionRunnerOverride = value;
}

export function isOperationalExecutionRunnerPlaybook(
  playbookId: string,
): playbookId is OperationalExecutionRunnerPlaybookId {
  return (OPERATIONAL_EXECUTION_RUNNER_CUTOVER.allowedPlaybooks as readonly string[]).includes(
    playbookId,
  );
}
