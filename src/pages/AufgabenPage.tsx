import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Badge, Card, CardMeta, CardTitle, PageHeader } from '../components/ui/Card';
import { useApp } from '../context/AppContext';
import {
  getTaskSummary,
  getTasksFiltered,
  syncOverdueInvoiceTasks,
  toggleTaskCompletion,
} from '../services/taskEngineService';
import { isTaskDone } from '../services/taskNormalize';
import type { Task, TaskFilter } from '../types/models';
import type { TranslationKey } from '../i18n';

const FILTERS: TaskFilter[] = ['offen', 'heute', 'ueberfaellig', 'kritisch', 'erledigt'];

function priorityTone(priority: Task['priority']): 'default' | 'info' | 'warning' | 'success' {
  if (priority === 'kritisch') return 'warning';
  if (priority === 'hoch') return 'warning';
  if (priority === 'mittel') return 'info';
  return 'default';
}

export function AufgabenPage() {
  const { translate } = useApp();
  const location = useLocation();
  const [filter, setFilter] = useState<TaskFilter>('offen');
  const [tasks, setTasks] = useState<Task[]>(() => getTasksFiltered('offen'));
  const [summary, setSummary] = useState(getTaskSummary);

  const refresh = () => {
    setTasks(getTasksFiltered(filter));
    setSummary(getTaskSummary());
  };

  useEffect(() => {
    syncOverdueInvoiceTasks();
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

  return (
    <div className="page">
      <PageHeader
        title={translate('aufgaben.title')}
        subtitle={`${summary.open} ${translate('aufgaben.open')}`}
      />

      <div className="chip-group aufgaben-filters">
        {FILTERS.map((value) => (
          <button
            key={value}
            type="button"
            className={`chip ${filter === value ? 'chip--active' : ''}`}
            onClick={() => setFilter(value)}
          >
            {translate(filterKey(value))}
          </button>
        ))}
      </div>

      {tasks.length === 0 ? (
        <p className="empty-state">{translate('aufgaben.emptyFilter')}</p>
      ) : (
        <div className="card-list">
          {tasks.map((task) => {
            const done = isTaskDone(task);
            const categoryKey = `taskCategory.${task.category}` as TranslationKey;
            const sourceKey = `taskSource.${task.sourceType}` as TranslationKey;
            const priorityKey = `priority.${task.priority}` as TranslationKey;

            return (
              <Card key={task.id} className={done ? 'card--done' : ''}>
                <label className="task-row">
                  <input
                    type="checkbox"
                    checked={done}
                    onChange={() => handleToggle(task.id)}
                  />
                  <div className="task-row__content">
                    <CardTitle>{task.title}</CardTitle>
                    <CardMeta>{task.description}</CardMeta>
                    <div className="badge-row task-row__badges">
                      <Badge tone={priorityTone(task.priority)}>{translate(priorityKey)}</Badge>
                      <Badge>{translate(categoryKey)}</Badge>
                      <Badge tone="info">{translate(sourceKey)}</Badge>
                      {task.dueDate && (
                        <Badge tone={done ? 'default' : 'warning'}>{task.dueDate}</Badge>
                      )}
                    </div>
                    <div className="task-row__links">
                      {task.linkedVorgangId && task.linkedVorgangTitle && (
                        <Link to={`/vorgaenge/${task.linkedVorgangId}`} className="link">
                          {task.linkedVorgangTitle}
                        </Link>
                      )}
                      {task.linkedInboxId && (
                        <Link to={`/eingang/${task.linkedInboxId}`} className="link">
                          {translate('aufgaben.linkInbox')}
                        </Link>
                      )}
                      {task.linkedInvoiceId && task.linkedVorgangId && (
                        <Link
                          to={`/vorgaenge/${task.linkedVorgangId}/rechnungen/${task.linkedInvoiceId}`}
                          className="link"
                        >
                          {translate('aufgaben.linkInvoice')}
                        </Link>
                      )}
                      {task.linkedDocumentId && (
                        <Link to={`/dokumente/${task.linkedDocumentId}`} className="link">
                          {translate('aufgaben.linkDocument')}
                        </Link>
                      )}
                    </div>
                  </div>
                </label>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
