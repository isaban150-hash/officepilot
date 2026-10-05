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
  /**
   * HEUTE-V2 — das Datum der offenen Frist, falls eine gilt.
   *
   * `hasOpenDeadline` ermittelt es ohnehin; bisher blieb nur das Ja/Nein
   * uebrig. Die Startseite braucht den Tag, um „ueberfaellig" von „in drei
   * Tagen" zu unterscheiden — ohne die Frist ein zweites Mal herzuleiten.
   */
  deadline?: string;
  /**
   * HEUTE-V2 — die erkannte Dokumentart, damit die Startseite eine
   * Zahlungsfrist von einer echten Dokumentfrist unterscheiden kann, ohne
   * die Einstufung ein zweites Mal herzuleiten.
   */
  kind?: string;
}
