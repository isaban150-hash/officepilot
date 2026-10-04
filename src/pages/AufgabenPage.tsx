import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Badge, PageHeader, StatusBadge } from '../components/ui/Card';
import { BusinessList, BusinessListItem } from '../components/ui/Lists';
import { Page, PageToolbar } from '../components/ui/Page';
import { Button } from '../components/ui/Button';
import { TaskEditorDialog } from '../components/tasks/TaskEditorDialog';
import { FilterChips } from '../components/ui/Toolbar';
import type { StatusTone } from '../services/ui/statusTone';
import { EmptyStateBlock } from '../components/ui/EmptyStateBlock';
import { useApp } from '../context/AppContext';
import {
  getTaskSummary,
  getTasksFiltered,
  toggleTaskCompletion,
} from '../services/taskEngineService';
import { isTaskDone } from '../services/taskNormalize';
import type { Task, TaskFilter } from '../types/models';
import type { TranslationKey } from '../i18n';

const FILTERS: TaskFilter[] = ['offen', 'heute', 'ueberfaellig', 'kritisch', 'erledigt'];

function priorityTone(priority: Task['priority']): StatusTone {
  if (priority === 'kritisch') return 'critical';
  if (priority === 'hoch') return 'warning';
  if (priority === 'mittel') return 'info';
  return 'neutral';
}

export function AufgabenPage() {
  const { translate, showToast } = useApp();
  const location = useLocation();
  const [filter, setFilter] = useState<TaskFilter>('offen');
  const [tasks, setTasks] = useState<Task[]>(() => getTasksFiltered('offen'));
  const [summary, setSummary] = useState(getTaskSummary);
  /*
   * TAGESARBEIT-V1 — ein Dialog fuer Anlegen und Bearbeiten.
   * `null` heisst geschlossen, `'new'` neue Aufgabe, sonst die bearbeitete.
   */
  const [editing, setEditing] = useState<Task | 'new' | null>(null);

  const refresh = () => {
    setTasks(getTasksFiltered(filter));
    setSummary(getTaskSummary());
  };

  /*
   * 02B — nur anzeigen. Überfälligkeitsaufgaben entstehen über
   * `reconcileInvoicePaymentTasks` (Aktion, Sync, täglicher App-Start), nicht
   * durch das Öffnen dieser Seite.
   */
  useEffect(() => {
    refresh();
  }, [location.pathname, location.key]);

  useEffect(() => {
    setTasks(getTasksFiltered(filter));
  }, [filter]);

  const handleToggle = (taskId: string) => {
    toggleTaskCompletion(taskId);
    refresh();
  };

  const filterKey = (value: TaskFilter) => `aufgaben.filter.${value}` as TranslationKey;

  const filterOptions = FILTERS.map((value) => ({ id: value, label: translate(filterKey(value)) }));

  /* UIUX-FOUNDATION-01F — Aufgaben als Business-Liste; Erledigen ist die eine Zeilenaktion. */
  return (
    <Page testId="aufgaben-page">
      <PageHeader
        title={translate('aufgaben.title')}
        subtitle={`${summary.open} ${translate('aufgaben.open')}`}
      />

      <PageToolbar
        filters={<FilterChips options={filterOptions} value={filter} onChange={setFilter} label={translate('list.filter.label')} testIdPrefix="aufgaben-filter" />}
        extra={
          <Button type="button" onClick={() => setEditing('new')} data-testid="aufgaben-new">
            {translate('aufgaben.new')}
          </Button>
        }
      />

      {tasks.length === 0 ? (
        <EmptyStateBlock
          title={translate(filter === 'offen' ? 'aufgaben.allDone.title' : 'aufgaben.emptyFilter.title')}
          description={translate(filter === 'offen' ? 'aufgaben.allDone.desc' : 'aufgaben.emptyFilter.desc')}
          testId="aufgaben-empty-state"
        />
      ) : (
        <BusinessList testId="aufgaben-list" ariaLabel={translate('aufgaben.title')}>
          {tasks.map((task) => {
            const done = isTaskDone(task);
            const categoryKey = `taskCategory.${task.category}` as TranslationKey;
            const sourceKey = `taskSource.${task.sourceType}` as TranslationKey;
            const priorityKey = `priority.${task.priority}` as TranslationKey;
            const links = [
              task.linkedVorgangId && task.linkedVorgangTitle ? (
                <Link key="v" to={`/vorgaenge/${task.linkedVorgangId}`} className="link">
                  {task.linkedVorgangTitle}
                </Link>
              ) : null,
              task.linkedInboxId ? (
                <Link key="i" to={`/ablage/${task.linkedInboxId}`} className="link">
                  {translate('aufgaben.linkInbox')}
                </Link>
              ) : null,
              task.linkedInvoiceId && task.linkedVorgangId ? (
                <Link key="r" to={`/vorgaenge/${task.linkedVorgangId}/rechnungen/${task.linkedInvoiceId}`} className="link">
                  {translate('aufgaben.linkInvoice')}
                </Link>
              ) : null,
              task.linkedDocumentId ? (
                <Link key="d" to={`/dokumente/${task.linkedDocumentId}`} className="link">
                  {translate('aufgaben.linkDocument')}
                </Link>
              ) : null,
            ].filter(Boolean);
            return (
              <BusinessListItem
                key={task.id}
                className={done ? 'business-list__item--done' : ''}
                testId={`aufgaben-row-${task.id}`}
                leading={
                  <label className="task-row__check">
                    <input type="checkbox" checked={done} onChange={() => handleToggle(task.id)} aria-label={task.title} data-testid={`aufgaben-toggle-${task.id}`} />
                  </label>
                }
                title={task.title}
                subtitle={task.description}
                meta={`${translate(categoryKey)} · ${translate(sourceKey)}`}
                status={done ? <StatusBadge tone="success" label={translate('aufgaben.filter.erledigt')} icon={false} /> : <StatusBadge tone={priorityTone(task.priority)} label={translate(priorityKey)} icon={false} />}
                date={task.dueDate ? <Badge tone={done ? 'neutral' : 'warning'}>{task.dueDate}</Badge> : undefined}
                action={
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setEditing(task)}
                    data-testid={`aufgaben-edit-${task.id}`}
                  >
                    {translate('aufgaben.action.edit')}
                  </Button>
                }
                footer={links.length > 0 ? <div className="task-row__links">{links}</div> : undefined}
              />
            );
          })}
        </BusinessList>
      )}

      {editing ? (
        <TaskEditorDialog
          open
          task={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(messageKey) => {
            showToast(translate(messageKey));
            refresh();
          }}
        />
      ) : null}
    </Page>
  );
}
