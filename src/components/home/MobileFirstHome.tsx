import { DeskPriorities } from './DeskPriorities';
import { DeskRecommendation } from './DeskRecommendation';
import { DeskSuccesses } from './DeskSuccesses';
import { HomeDocumentAddCard } from './HomeDocumentAddCard';
import { HomeMoreCard } from './HomeMoreCard';
import { HomeOfficePilotCard } from './HomeOfficePilotCard';
import { HomeOrdersCard } from './HomeOrdersCard';
import { HomeSteuerberaterCard } from './HomeSteuerberaterCard';

export function MobileFirstHome() {
  return (
    <div className="mobile-first-home" data-testid="mobile-first-home">
      <DeskPriorities />
      <DeskSuccesses />
      <div className="mobile-first-home__stack">
        <HomeDocumentAddCard />
        <HomeOrdersCard />
        <HomeOfficePilotCard />
        <HomeSteuerberaterCard />
        <HomeMoreCard />
      </div>
      <DeskRecommendation />
    </div>
  );
}
