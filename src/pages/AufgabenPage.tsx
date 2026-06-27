import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Badge, Card, CardMeta, CardTitle, PageHeader } from '../components/ui/Card';
import { useApp } from '../context/AppContext';
import { getAllTasks } from '../services/taskService';
import type { TranslationKey } from '../i18n';

export function AufgabenPage() {
  const { translate } = useApp();
  const location = useLocation();
  const [tasks, setTasks] = useState(getAllTasks);

  useEffect(() => {
    setTasks(getAllTasks());
  }, [location.pathname, location.key]);

  const openCount = tasks.filter((t) => !t.done).length;

  const toggleTask = (taskId: string) => {
    setTasks((prev) =>
      prev.map((t) => (t.id === taskId ? { ...t, done: !t.done } : t)),
    );
  };

  return (
    <div className="page">
      <PageHeader
        title={translate('aufgaben.title')}
        subtitle={`${openCount} ${translate('aufgaben.open')}`}
      />

      {tasks.length === 0 ? (
        <p className="empty-state">{translate('aufgaben.allDone')}</p>
      ) : (
        <div className="card-list">
          {tasks.map((task) => {
            const typeKey = `task.${task.type}` as TranslationKey;
            return (
              <Card key={task.id} className={task.done ? 'card--done' : ''}>
                <label className="task-row">
                  <input
                    type="checkbox"
                    checked={task.done}
                    onChange={() => toggleTask(task.id)}
                  />
                  <div className="task-row__content">
                    <CardTitle>{translate(typeKey)}</CardTitle>
                    <CardMeta>{task.description}</CardMeta>
                    {task.vorgangTitle && (
                      <Link to={`/vorgaenge/${task.vorgangId}`} className="link">
                        {task.vorgangTitle}
                      </Link>
                    )}
                    {task.dueDate && (
                      <Badge tone={task.done ? 'default' : 'warning'}>
                        {task.dueDate}
                      </Badge>
                    )}
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
