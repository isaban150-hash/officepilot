/**
 * BRIEFE-01C — der zentrale Einstieg in die Geschäftsschreiben.
 *
 * Eine ruhige Liste, kein Kartenraster: Betreff, Empfänger, Datum, Zustand.
 * Die dominante Handlung steht oben, der Rest ist Bestand.
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '../components/ui/Button';
import { PageHeader, StatusBadge } from '../components/ui/Card';
import { BusinessList, BusinessListItem } from '../components/ui/Lists';
import { Page, PageToolbar } from '../components/ui/Page';
import { EmptyStateBlock } from '../components/ui/EmptyStateBlock';

import { useApp } from '../context/AppContext';
import { listBusinessLetters } from '../services/businessLetterService';
import type { BusinessLetter } from '../types/businessLetter';

export function formatLetterRecipient(letter: BusinessLetter): string {
  const { company, name, city } = letter.recipient;
  const wer = company?.trim() || name.trim();
  return city.trim() ? `${wer} · ${city.trim()}` : wer;
}

export function SchreibenPage() {
  const { translate, language } = useApp();
  const navigate = useNavigate();
  const [suche, setSuche] = useState('');
  const briefe = useMemo(() => listBusinessLetters(), []);

  const gefiltert = useMemo(() => {
    const begriff = suche.trim().toLocaleLowerCase(language === 'de' ? 'de-DE' : undefined);
    if (!begriff) return briefe;
    return briefe.filter((brief) => {
      const heuhaufen = [
        brief.subject,
        brief.recipient.name,
        brief.recipient.company ?? '',
        brief.recipient.city,
      ]
        .join(' ')
        .toLocaleLowerCase(language === 'de' ? 'de-DE' : undefined);
      return heuhaufen.includes(begriff);
    });
  }, [briefe, suche, language]);

  const datum = (wert: string) =>
    wert ? new Date(wert).toLocaleDateString(language === 'de' ? 'de-DE' : undefined) : '';

  return (
    <Page className="schreiben-page" testId="schreiben-page">
      <PageHeader
        title={translate('businessLetter.area.title')}
        subtitle={translate('businessLetter.area.subtitle')}
        primaryAction={
          <Button type="button" onClick={() => navigate('/schreiben/neu')} data-testid="letter-new">
            {translate('businessLetter.area.new')}
          </Button>
        }
      />

      {briefe.length === 0 ? (
        <EmptyStateBlock
          title={translate('businessLetter.area.empty')}
          description={translate('businessLetter.area.emptyHint')}
          testId="letter-empty"
        />
      ) : (
        <>
          <PageToolbar
            search={
              <input
                className="input"
                type="search"
                value={suche}
                onChange={(event) => setSuche(event.target.value)}
                placeholder={translate('businessLetter.area.search')}
                aria-label={translate('businessLetter.area.search')}
                data-testid="letter-search"
              />
            }
          />
          {gefiltert.length === 0 ? (
            <EmptyStateBlock
              title={translate('businessLetter.area.searchEmpty')}
              description={translate('businessLetter.area.search')}
              testId="letter-search-empty"
            />
          ) : (
            <BusinessList testId="letter-list">
              {gefiltert.map((brief) => (
                <BusinessListItem
                  key={brief.id}
                  testId={`letter-row-${brief.id}`}
                  linkTestId={`letter-open-${brief.id}`}
                  to={`/schreiben/${brief.id}`}
                  title={brief.subject}
                  subtitle={formatLetterRecipient(brief)}
                  date={datum(brief.letterDate)}
                  status={
                    <StatusBadge
                      tone={brief.status === 'finalized' ? 'success' : 'neutral'}
                      label={translate(
                        brief.status === 'finalized'
                          ? 'businessLetter.status.finalized'
                          : 'businessLetter.status.draft',
                      )}
                    />
                  }
                />
              ))}
            </BusinessList>
          )}
        </>
      )}
    </Page>
  );
}
