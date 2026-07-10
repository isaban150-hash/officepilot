import { useEffect, useState } from 'react';

export function NetworkStatusBanner() {
  const [offline, setOffline] = useState(() =>
    typeof navigator !== 'undefined' ? !navigator.onLine : false,
  );

  useEffect(() => {
    const handleOffline = () => setOffline(true);
    const handleOnline = () => setOffline(false);
    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);
    return () => {
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
    };
  }, []);

  if (!offline) return null;

  return (
    <div className="network-status-banner" role="alert" data-testid="network-error-banner">
      Keine Internetverbindung. Bitte prüfen Sie Ihre Verbindung und versuchen Sie es erneut.
    </div>
  );
}
