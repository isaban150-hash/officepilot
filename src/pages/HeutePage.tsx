import { DeskGreetingHeader } from '../components/home/DeskGreetingHeader';
import { MobileFirstHome } from '../components/home/MobileFirstHome';

export function HeutePage() {
  return (
    <div className="page heute-page mobile-first-page" data-testid="heute-page">
      <DeskGreetingHeader />
      <MobileFirstHome />
    </div>
  );
}
