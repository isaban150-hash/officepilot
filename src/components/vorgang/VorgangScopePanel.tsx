import { Card, DataRow } from '../ui/Card';
import type { TranslationKey } from '../../i18n';
import { buildVorgangScopeView } from '../../services/vorgangScopeView';
import type { Vorgang } from '../../types/models';

interface VorgangScopePanelProps {
  vorgang: Vorgang;
  translate: (key: TranslationKey) => string;
}

export function VorgangScopePanel({ vorgang, translate }: VorgangScopePanelProps) {
  const scope = buildVorgangScopeView(vorgang);
  const gewerkDisplay = scope.gewerk?.trim() || translate('vorgang.scope.gewerkUnknown');

  return (
    <section className="section vorgang-scope" data-testid="vorgang-scope">
      <h2 className="section__title">{translate('vorgang.scope.title')}</h2>
      <Card>
        <DataRow label={translate('vorgang.scope.gewerk')} value={gewerkDisplay} />
        <div
          className="vorgang-scope__hauptleistungen"
          data-testid="vorgang-scope-hauptleistungen"
        >
          <span className="vorgang-scope__label">
            {translate('vorgang.scope.hauptleistungen')}
          </span>
          {scope.hauptleistungen.length > 0 ? (
            <ul>
              {scope.hauptleistungen.map((label) => (
                <li key={label}>{label}</li>
              ))}
            </ul>
          ) : (
            <p
              className="vorgang-scope__empty-hint"
              data-testid="vorgang-scope-hauptleistungen-empty"
            >
              {translate('vorgang.scope.hauptleistungenEmpty')}
            </p>
          )}
        </div>
      </Card>
    </section>
  );
}
