export type DocumentLifecycleStatus =
  | 'new'
  | 'recognized'
  | 'needs_action'
  | 'waiting'
  | 'answered'
  | 'filed'
  | 'done';

export type DocumentLifecycleReason =
  | 'reply_open'
  | 'file_original'
  | 'deadline_open'
  | 'proof_missing'
  | 'task_open';

export interface DocumentLifecycleRef {
  documentId?: string;
  inboxId?: string;
}

export interface DocumentLifecycleView {
  status: DocumentLifecycleStatus;
  title: string;
  documentId?: string;
  inboxId?: string;
  completedSteps: string[];
  openItems: string[];
  nextStep: string;
  openReasons: DocumentLifecycleReason[];
  route: string;
}
