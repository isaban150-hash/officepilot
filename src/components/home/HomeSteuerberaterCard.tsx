import { Link } from 'react-router-dom';
import { useMemo } from 'react';
import { useApp } from '../../context/AppContext';
import { getSteuerberaterMonthOverview } from '../../services/steuerberaterOverviewService';
import { NavIcon } from '../layout/NavIcon';

export function HomeSteuerberaterCard() {
  const { translate, language } = useApp();
  const locale = language === 'tr' ? 'tr-TR' : 'de-DE';
  const overview = useMemo(() => getSteuerberaterMonthOverview(new Date(), locale), [locale]);

  const monthShort = overview.monthLabel.split(' ')[0] ?? overview.monthLabel;
  const statusText =
    overview.missingCount > 0
      ? translate('mobile.home.taxMissing').replace('{count}', String(overview.missingCount))
      : translate('mobile.home.taxComplete');

  return (
    <section className="mobile-home-card" data-testid="home-card-steuerberater">
      <div className="mobile-home-card__body">
        <NavIcon id="tax" className="mobile-home-card__icon" />
        <div className="mobile-home-card__content">
          <span className="mobile-home-card__title">{translate('mobile.home.taxTitle')}</span>
          <span className="mobile-home-card__meta">
            {monthShort} · {overview.completenessPercent} % {translate('mobile.home.taxPercentLabel')}
          </span>
          <span className="mobile-home-card__desc">{statusText}</span>
        </div>
      </div>
      <Link
        to="/steuerberater"
        className="mobile-home-card__cta"
        data-testid="home-card-steuerberater-action"
      >
        {translate('steuerberater.prepareFolderButton')}
      </Link>
    </section>
  );
}
