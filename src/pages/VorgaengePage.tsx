import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Button } from '../components/ui/Button';
import { StatusBadge } from '../components/ui/Badge';
import { PageHeader } from '../components/ui/PageHeader';
import { EmptyStateBlock } from '../components/ui/EmptyStateBlock';
import { BusinessList, BusinessListItem } from '../components/ui/Lists';
import { Page, PageToolbar } from '../components/ui/Page';
import { FilterChips, SearchField } from '../components/ui/Toolbar';
import { useApp } from '../context/AppContext';
import { getAllVorgaenge } from '../services/vorgangService';
import { listOrderDrafts } from '../services/order/orderDraftService';
import { vorgangStatusTone } from '../services/ui/statusTone';
import type { TranslationKey } from '../i18n';
import type { Vorgang } from '../types/models';

type VorgangFilter = 'active' | 'done' | 'all';

/**
 * UIUX-FOUNDATION-01E — Aufträge als Business-Liste.
 *
 * Vorher: Kartenwand mit zwei Badges und zwei Meta-Zeilen je Auftrag.
 * Jetzt: eine Zeile = Auftrag · Kunde/Baustelle · Status · Dokumente/Aufgaben.
 * Suche und Filter arbeiten nur auf dem geladenen Bestand (kein neuer Service).
 */
function matchesQuery(vorgang: Vorgang, query: string): boolean {
  if (!query) return true;
  const haystack = `${vorgang.title} ${vorgang.customer} ${vorgang.baustelle}`.toLowerCase();
  return haystack.includes(query);
}

export function VorgaengePage() {
  const { translate } = useApp();
  const location = useLocation();
  const navigate = useNavigate();
  const [vorgaenge, setVorgaenge] = useState(getAllVorgaenge);
  /* AUFTRAG-02C — begonnene, noch nicht verbindliche Auftraege dieses Geraets. */
  const [entwuerfe, setEntwuerfe] = useState(listOrderDrafts);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<VorgangFilter>('active');

  useEffect(() => {
    setVorgaenge(getAllVorgaenge());
    setEntwuerfe(listOrderDrafts());
  }, [location.pathname, location.key]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return vorgaenge.filter((v) => {
      if (filter === 'active' && v.status === 'abgeschlossen') return false;
      if (filter === 'done' && v.status !== 'abgeschlossen') return false;
      return matchesQuery(v, q);
    });
  }, [vorgaenge, query, filter]);

  const filterOptions = useMemo(
    () => [
      { id: 'active' as const, label: translate('list.filter.active'), count: vorgaenge.filter((v) => v.status !== 'abgeschlossen').length },
      { id: 'done' as const, label: translate('list.filter.done'), count: vorgaenge.filter((v) => v.status === 'abgeschlossen').length },
      { id: 'all' as const, label: translate('list.filter.all'), count: vorgaenge.length },
    ],
    [translate, vorgaenge],
  );

  return (
    <Page testId="vorgaenge-page">
      <PageHeader
        title={translate('vorgaenge.title')}
        subtitle={translate('vorgaenge.subtitle')}
        /* 01D — Hauptzweck der Seite: Aufträge. Ein neuer Auftrag entsteht in OfficePilot aus dem
           Auftragsdokument (Scan/PDF → Eingang → „Vorgang anlegen"); genau dieser Weg ist die Hauptaktion.
           „Offene Rechnungen anzeigen" bleibt als Nebenweg erhalten. */
        primaryAction={
          <Link to="/dokumente/hinzufuegen" data-testid="vorgaenge-new-from-document">
            <Button>{translate('vorgaenge.newFromDocument')}</Button>
          </Link>
        }
        secondaryAction={
          <>
            {/* ANGEBOT-01B — die Vorstufe des Auftrags lebt hier, ohne eigenen Hauptmenüpunkt. */}
            {/* AUFTRAG-02C — Auftrag ohne Angebot, ohne eigenen Hauptmenuepunkt. */}
            <Link to="/auftraege/neu" data-testid="vorgaenge-new-order">
              <Button variant="secondary">{translate('order.new.action')}</Button>
            </Link>
            <Link to="/angebote" data-testid="vorgaenge-offers">
              <Button variant="secondary">{translate('offer.area.tabOffers')}</Button>
            </Link>
            <Link to="/rechnungen/offen" data-testid="vorgaenge-open-invoices">
              <Button variant="ghost">{translate('vorgaenge.openInvoices')}</Button>
            </Link>
          </>
        }
      />

      {entwuerfe.length > 0 ? (
        <section className="section" data-testid="vorgaenge-order-drafts">
          <h2 className="section__title">{translate('order.draft.listTitle')}</h2>
          <p className="form-hint">{translate('order.draft.listHint')}</p>
          <BusinessList>
            {entwuerfe.map((entwurf) => (
              <BusinessListItem
                key={entwurf.id}
                to={`/auftraege/entwurf/${entwurf.id}`}
                linkTestId={`order-draft-${entwurf.id}`}
                title={entwurf.title.trim() || translate('order.draft.untitled')}
                subtitle={entwurf.customerBilling.name}
                status={<StatusBadge tone="neutral" label={translate('order.draft.badge')} />}
              />
            ))}
          </BusinessList>
        </section>
      ) : null}

      {vorgaenge.length === 0 ? (
        <EmptyStateBlock
          title={translate('vorgaenge.empty.title')}
          description={translate('vorgaenge.empty.desc')}
          testId="vorgaenge-empty-state"
          actions={
            <Button fullWidth onClick={() => navigate('/scan')}>
              {translate('vorgaenge.empty.action')}
            </Button>
          }
        />
      ) : (
        <>
          <PageToolbar
            search={
              <SearchField
                label={translate('list.search')}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                testId="vorgaenge-search"
              />
            }
            filters={
              <FilterChips options={filterOptions} value={filter} onChange={setFilter} label={translate('list.filter.label')} testIdPrefix="vorgaenge-filter" />
            }
          />
          {filtered.length === 0 ? (
            <EmptyStateBlock title={translate('list.noMatches.title')} description={translate('list.noMatches.desc')} testId="vorgaenge-no-matches" />
          ) : (
            <BusinessList testId="vorgaenge-list" ariaLabel={translate('vorgaenge.title')}>
              {filtered.map((v) => {
                const statusKey = `status.${v.status}` as TranslationKey;
                const openTasks = v.tasks.filter((t) => !t.done).length;
                return (
                  <BusinessListItem
                    key={v.id}
                    to={`/vorgaenge/${v.id}`}
                    title={v.title}
                    subtitle={[v.customer, v.baustelle].filter(Boolean).join(' · ')}
                    meta={`${translate('vorgaenge.meta.documents').replace('{count}', String(v.documents.length))} · ${translate('vorgaenge.meta.tasks').replace('{count}', String(openTasks))}`}
                    status={<StatusBadge tone={vorgangStatusTone(v.status)} label={translate(statusKey)} icon={false} />}
                    testId={`vorgaenge-row-${v.id}`}
                  />
                );
              })}
            </BusinessList>
          )}
        </>
      )}
    </Page>
  );
}
