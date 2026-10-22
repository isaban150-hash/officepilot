// DOKUMENTE-01 — Vite-Konfiguration der Prüf-App für die WEISS-Abnahme (Muster: FC01A vite.t8.config.mjs).
// Übernimmt die Repository-Konfiguration unverändert; anders sind nur:
//   - envDir: ein leerer Ordner → .env.local (mit Produktionswerten) wird NICHT geladen; alle VITE_*-Werte kommen
//     ausschließlich aus der Umgebung, die dok01-pruefapp.mjs setzt (lokale Supabase, lokaler Demo-Schlüssel,
//     KI aus, Mail-Stub);
//   - kein HMR (keine Code-Einspielung in offene Prüfseiten), eigener Cache, Port 5232 nur auf 127.0.0.1
//     (::1:5232 leitet der Starter auf 127.0.0.1:5232 weiter).
import basis from 'C:/Users/Lenovo-ThinkPad-E590/Desktop/officepilot/vite.config.ts';

const LEER = 'C:/Users/Lenovo-ThinkPad-E590/Desktop/officepilot/pruefunterlagen/dokumente-01/werkzeug/leer-env';
const CACHE = 'C:/Users/Lenovo-ThinkPad-E590/AppData/Local/Temp/officetakt-dok01-vite-cache';

export default (umgebung) => {
  const k = typeof basis === 'function' ? basis(umgebung) : basis;
  return {
    ...k,
    root: 'C:/Users/Lenovo-ThinkPad-E590/Desktop/officepilot',
    envDir: LEER,
    cacheDir: CACHE,
    server: { ...(k.server ?? {}), host: '127.0.0.1', port: 5232, strictPort: true, hmr: false },
  };
};
