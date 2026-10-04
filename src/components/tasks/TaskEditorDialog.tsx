import { useEffect, useMemo, useState } from 'react';
import { Button } from '../ui/Button';
import { useApp } from '../../context/AppContext';
import {
  createManualTask,
  deleteManualTask,
  updateTask,
  TASK_TITLE_MAX_LENGTH,
} from '../../services/taskEngineService';
import { getAllVorgaenge } from '../../services/vorgangService';
import type { Task } from '../../types/models';
import type { TranslationKey } from '../../i18n';

/**
 * TAGESARBEIT-V1 — Aufgabe anlegen und bearbeiten.
 *
 * Ein Dialog für beides, im vorhandenen Muster (`vorgang-dialog-backdrop`) wie
 * der Zuordnungs- und der Weiterberechnungsdialog. Keine neue Seite, keine
 * zweite Dialoginfrastruktur.
 *
 * Der Ton ist Tagesarbeit, nicht Datensatzpflege: „Was ist zu tun?" statt
 * „Titel", keine technischen Kennungen, und die Frist lässt sich mit einer
 * sichtbaren Handlung entfernen statt durch ein stilles Leeren des Feldes.
 *
 * Alle fachlichen Regeln liegen im Dienst — auch der Löschschutz für
 * automatisch entstandene Aufgaben. Hier wird der Knopf nur zusätzlich nicht
 * angeboten.
 */
interface Props {
  open: boolean;
  /** Fehlt sie, wird eine neue manuelle Aufgabe angelegt. */
  task?: Task | null;
  onClose: () => void;
  onSaved: (messageKey: TranslationKey) => void;
}

export function TaskEditorDialog({ open, task, onClose, onSaved }: Props) {
  const { translate } = useApp();
  const isEdit = Boolean(task);
  const isManual = task ? task.autoCreated === false : true;

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [vorgangId, setVorgangId] = useState('');
  const [errorKey, setErrorKey] = useState<TranslationKey | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const orders = useMemo(() => getAllVorgaenge(), [open]);

  useEffect(() => {
    if (!open) return;
    setTitle(task?.title ?? '');
    /*
     * `normalizeTask` belegt die Beschreibung mit dem Titel, wenn keine
     * erfasst wurde. Diese Wiederholung gehört nicht ins Eingabefeld.
     */
    setDescription(task && task.description !== task.title ? task.description : '');
    setDueDate(task?.dueDate?.slice(0, 10) ?? '');
    setVorgangId(task?.linkedVorgangId ?? '');
    setErrorKey(null);
    setConfirmDelete(false);
  }, [open, task]);

  if (!open) return null;

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    setErrorKey(null);

    const result = task
      ? updateTask(task.id, {
          title,
          description,
          // `null` entfernt, ein Wert setzt — der Dienst unterscheidet beides.
          dueDate: dueDate.trim() ? dueDate : null,
          linkedVorgangId: vorgangId.trim() ? vorgangId : null,
        })
      : createManualTask({
          title,
          description,
          dueDate: dueDate.trim() ? dueDate : null,
          linkedVorgangId: vorgangId.trim() ? vorgangId : null,
        });

    if (!result.success) {
      setErrorKey(result.errorKey as TranslationKey);
      return;
    }
    onSaved(isEdit ? 'aufgaben.saved' : 'aufgaben.created');
    onClose();
  };

  const handleDelete = () => {
    if (!task) return;
    setErrorKey(null);
    const result = deleteManualTask(task.id);
    if (!result.success) {
      setErrorKey(result.errorKey as TranslationKey);
      setConfirmDelete(false);
      return;
    }
    onSaved('aufgaben.deleted');
    onClose();
  };

  return (
    <div className="vorgang-dialog-backdrop" role="presentation" onClick={onClose}>
      <form
        className="vorgang-dialog task-editor-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-editor-dialog-title"
        data-testid="task-editor-dialog"
        onClick={(event) => event.stopPropagation()}
        onSubmit={handleSubmit}
      >
        <h3 id="task-editor-dialog-title" className="vorgang-dialog__title">
          {translate(isEdit ? 'aufgaben.dialog.editTitle' : 'aufgaben.dialog.createTitle')}
        </h3>

        {isEdit && !isManual ? (
          <p className="hint-text" data-testid="task-editor-auto-hint">
            {translate('aufgaben.auto.hint')}
          </p>
        ) : null}

        <label className="form-group">
          <span>{translate('aufgaben.field.title')}</span>
          <input
            className="input"
            value={title}
            maxLength={TASK_TITLE_MAX_LENGTH}
            placeholder={translate('aufgaben.field.titlePlaceholder')}
            onChange={(event) => setTitle(event.target.value)}
            data-testid="task-editor-title"
          />
        </label>

        <label className="form-group">
          <span>{translate('aufgaben.field.description')}</span>
          <textarea
            className="input"
            rows={3}
            value={description}
            placeholder={translate('aufgaben.field.descriptionPlaceholder')}
            onChange={(event) => setDescription(event.target.value)}
            data-testid="task-editor-description"
          />
        </label>

        <div className="form-group">
          <label htmlFor="task-editor-duedate">{translate('aufgaben.field.dueDate')}</label>
          <div className="task-editor-dialog__due">
            <input
              id="task-editor-duedate"
              className="input"
              type="date"
              value={dueDate}
              onChange={(event) => setDueDate(event.target.value)}
              data-testid="task-editor-duedate"
            />
            {dueDate ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => setDueDate('')}
                data-testid="task-editor-duedate-clear"
              >
                {translate('aufgaben.action.clearDueDate')}
              </Button>
            ) : null}
          </div>
          <span className="form-hint">{translate('aufgaben.field.dueDateHint')}</span>
        </div>

        <label className="form-group">
          <span>{translate('aufgaben.field.vorgang')}</span>
          <select
            className="input"
            value={vorgangId}
            onChange={(event) => setVorgangId(event.target.value)}
            data-testid="task-editor-vorgang"
          >
            <option value="">{translate('aufgaben.field.vorgangNone')}</option>
            {orders.map((order) => (
              <option key={order.id} value={order.id}>
                {order.customer ? `${order.title} · ${order.customer}` : order.title}
              </option>
            ))}
          </select>
        </label>

        {errorKey ? (
          <p className="form-error" role="alert" data-testid="task-editor-error">
            {translate(errorKey)}
          </p>
        ) : null}

        <div className="vorgang-dialog__actions">
          <Button type="submit" fullWidth data-testid="task-editor-save">
            {translate('common.save')}
          </Button>
          <Button type="button" variant="outline" fullWidth onClick={onClose} data-testid="task-editor-cancel">
            {translate('common.cancel')}
          </Button>
        </div>

        {isEdit && isManual ? (
          <div className="task-editor-dialog__danger">
            {confirmDelete ? (
              <>
                <p className="hint-text" role="alert" data-testid="task-editor-delete-confirm">
                  {translate('aufgaben.action.deleteConfirm')}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  fullWidth
                  onClick={handleDelete}
                  data-testid="task-editor-delete-yes"
                >
                  {translate('aufgaben.action.delete')}
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  fullWidth
                  onClick={() => setConfirmDelete(false)}
                  data-testid="task-editor-delete-no"
                >
                  {translate('common.cancel')}
                </Button>
              </>
            ) : (
              <Button
                type="button"
                variant="outline"
                fullWidth
                onClick={() => setConfirmDelete(true)}
                data-testid="task-editor-delete"
              >
                {translate('aufgaben.action.delete')}
              </Button>
            )}
          </div>
        ) : null}
      </form>
    </div>
  );
}
