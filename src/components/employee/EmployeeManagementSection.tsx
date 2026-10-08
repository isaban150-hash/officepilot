/**
 * P1 MITARBEITERZAHLUNGEN — die kleine Mitarbeiterverwaltung.
 *
 * Nur das, was Zahlungen brauchen: Name, optionale Personalnummer, aktiv oder
 * nicht. Keine Personalakte, kein Benutzerkonto. Umbenennen lässt erfasste
 * Zahlungen unberührt — sie tragen den Namen zum Zeitpunkt der Zahlung.
 * Gelöscht wird nie; ein Mitarbeiter wird deaktiviert.
 */
import { useState } from 'react';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { StatusBadge } from '../ui/Badge';
import type { TranslationKey } from '../../i18n';
import type { Employee } from '../../types/employee';
import { createEmployee, setEmployeeActive, updateEmployee } from '../../services/employee/employeeService';

interface Props {
  employees: Employee[];
  canWrite: boolean;
  userId?: string;
  translate: (key: TranslationKey) => string;
  showToast: (message: string) => void;
  onChanged: () => void;
}

interface EditState {
  id: string | null;
  name: string;
  personnelNumber: string;
}

export function EmployeeManagementSection({ employees, canWrite, userId, translate: t, showToast, onChanged }: Props) {
  const [edit, setEdit] = useState<EditState | null>(null);
  const [error, setError] = useState<TranslationKey | null>(null);

  const startCreate = () => {
    setEdit({ id: null, name: '', personnelNumber: '' });
    setError(null);
  };

  const startEdit = (employee: Employee) => {
    setEdit({ id: employee.id, name: employee.name, personnelNumber: employee.personnelNumber ?? '' });
    setError(null);
  };

  const save = () => {
    if (!edit) return;
    const input = { name: edit.name, personnelNumber: edit.personnelNumber };
    const result = edit.id ? updateEmployee(edit.id, input, { userId }) : createEmployee(input, { userId });
    if (!result.success) {
      setError(result.errorKey as TranslationKey);
      return;
    }
    showToast(t('employees.saved'));
    setEdit(null);
    setError(null);
    onChanged();
  };

  const toggleActive = (employee: Employee) => {
    const result = setEmployeeActive(employee.id, !employee.active, { userId });
    if (!result.success) {
      showToast(t(result.errorKey as TranslationKey));
      return;
    }
    showToast(t('employees.saved'));
    onChanged();
  };

  return (
    <section className="employee-management" data-testid="employee-management">
      <div className="employee-management__head">
        <h2 className="employee-management__title">{t('employees.section.title')}</h2>
        {canWrite && !edit ? (
          <Button size="sm" variant="outline" onClick={startCreate} data-testid="employee-add">
            {t('employees.add')}
          </Button>
        ) : null}
      </div>
      <p className="form-hint">{t('employees.section.hint')}</p>

      {edit ? (
        <div className="employee-management__form" data-testid="employee-form">
          <h3 className="employee-management__form-title">
            {t(edit.id ? 'employees.editTitle' : 'employees.addTitle')}
          </h3>
          <Input
            label={t('employees.name')}
            required
            maxLength={120}
            value={edit.name}
            onChange={(event) => {
              setEdit({ ...edit, name: event.target.value });
              setError(null);
            }}
            error={error && error.startsWith('employee.error.name') ? t(error) : undefined}
            data-testid="employee-form-name"
          />
          <Input
            label={t('employees.personnelNumber')}
            maxLength={40}
            value={edit.personnelNumber}
            onChange={(event) => {
              setEdit({ ...edit, personnelNumber: event.target.value });
              setError(null);
            }}
            error={error && error.startsWith('employee.error.personnelNumber') ? t(error) : undefined}
            data-testid="employee-form-personnel-number"
          />
          {edit.id ? <p className="form-hint">{t('employees.renameHint')}</p> : null}
          {error && !error.startsWith('employee.error.name') && !error.startsWith('employee.error.personnelNumber') ? (
            <p className="form-error" role="alert" data-testid="employee-form-error">
              {t(error)}
            </p>
          ) : null}
          <div className="employee-management__form-actions">
            <Button size="sm" variant="secondary" onClick={() => setEdit(null)} data-testid="employee-form-cancel">
              {t('employees.cancel')}
            </Button>
            <Button size="sm" onClick={save} data-testid="employee-form-save">
              {t(edit.id ? 'employees.save' : 'employees.create')}
            </Button>
          </div>
        </div>
      ) : null}

      {employees.length === 0 ? (
        <p className="form-hint" data-testid="employee-list-empty">
          {t('employees.empty')}
        </p>
      ) : (
        <ul className="employee-management__list" data-testid="employee-list">
          {employees.map((employee) => (
            <li key={employee.id} className="employee-management__row" data-testid={`employee-row-${employee.id}`}>
              <span className="employee-management__identity">
                <span className="employee-management__name">{employee.name}</span>
                {employee.personnelNumber ? (
                  <span className="employee-management__number">{employee.personnelNumber}</span>
                ) : null}
              </span>
              {employee.active ? null : <StatusBadge tone="neutral" label={t('employees.inactive')} icon={false} />}
              {canWrite ? (
                <span className="employee-management__actions">
                  <Button size="sm" variant="ghost" onClick={() => startEdit(employee)} data-testid={`employee-edit-${employee.id}`}>
                    {t('employees.edit')}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => toggleActive(employee)} data-testid={`employee-toggle-${employee.id}`}>
                    {t(employee.active ? 'employees.deactivate' : 'employees.reactivate')}
                  </Button>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
