// DOKUMENTE-01 — Prüf-App für die WEISS-Abnahme starten (NUR durch den Nutzer bzw. SCHWARZ außerhalb der Sandbox).
// Muster: FC01A t8-dienste.mjs, ohne Proxy.
//   Prüf-App  Vite 127.0.0.1:5232 (kein HMR, keine .env-Dateien) + Weiterleitung [::1]:5232 → 127.0.0.1:5232
//   Ziel      ausschließlich die lokale Supabase http://127.0.0.1:54321 (Demo-Schlüssel, nie Produktion),
//             KI aus (VITE_GEMINI_API_KEY leer), Mail im Stub, Kennzeichen VITE_PRUEFUMGEBUNG=DOKUMENTE-01
// Andere Dienste (5203/5204/5213/5220–5229, 54396/54397/54399) bleiben unberührt. Belegter Port → Abbruch ohne Änderung.
//
//   node dok01-pruefapp.mjs [--schluessel <datei mit {url, anon, service}>]
// Ohne --schluessel liest der Starter den lokalen Demo-anon-Schlüssel aus der Konfiguration des lokalen Kong-Containers.
// Beenden: die PID aus laufzeit/dienst.json beenden (Starter beendet Vite mit).
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const HIER = import.meta.dirname;
const REPO = 'C:/Users/Lenovo-ThinkPad-E590/Desktop/officepilot';
const PORT = 5232;
const KENNZEICHEN = 'DOKUMENTE-01';
const LAUFZEIT = path.join(HIER, 'laufzeit');
fs.mkdirSync(LAUFZEIT, { recursive: true });

// Eigenes Protokoll (der Dienst läuft ohne Konsole, über WMI gestartet).
const DIENSTLOG = path.join(LAUFZEIT, 'dienst.log');
const melde = (...teile) => {
  const zeile = `${new Date().toISOString()} ${teile.map((t) => (t instanceof Error ? t.stack : String(t))).join(' ')}`;
  process.stdout.write(`${zeile}\n`);
  try { fs.appendFileSync(DIENSTLOG, `${zeile}\n`); } catch { /* Protokollzeile verloren */ }
};
process.on('uncaughtException', (e) => melde('unbehandelter Fehler (Dienst läuft weiter):', e));
process.on('unhandledRejection', (e) => melde('unbehandelte Zurückweisung (Dienst läuft weiter):', e));

function jwtTeil(token) {
  try {
    return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return {};
  }
}

/** Nur der öffentliche lokale Demo-anon-Schlüssel (iss supabase-demo, role anon, kein Projekt-ref). */
function lokalerAnonSchluessel() {
  const i = process.argv.indexOf('--schluessel');
  let kandidaten = [];
  if (i > 0 && process.argv[i + 1]) {
    const k = JSON.parse(fs.readFileSync(process.argv[i + 1], 'utf8'));
    if (k.url && !/^http:\/\/(127\.0\.0\.1|localhost):54321$/.test(k.url)) throw new Error('Schlüsseldatei zeigt nicht auf die lokale Supabase');
    kandidaten = [k.anon];
  } else {
    const kong = execFileSync('docker', ['exec', 'supabase_kong_officepilot', 'sh', '-c', 'cat /home/kong/kong.yml'], { encoding: 'utf8' });
    kandidaten = kong.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g) ?? [];
  }
  const anon = kandidaten.find((t) => {
    const p = jwtTeil(t);
    return p.iss === 'supabase-demo' && p.role === 'anon' && !p.ref;
  });
  if (!anon) throw new Error('kein lokaler Demo-anon-Schlüssel gefunden');
  return anon;
}

const belegt = (port, host) => new Promise((ok) => {
  const s = net.connect(port, host);
  s.once('connect', () => { s.destroy(); ok(true); });
  s.once('error', () => ok(false));
});

const anon = lokalerAnonSchluessel();
try {
  const r = await fetch('http://127.0.0.1:54321/auth/v1/health', { headers: { apikey: anon } });
  melde(`Lokale Supabase: HTTP ${r.status}`);
} catch {
  melde('Abbruch: lokale Supabase nicht erreichbar.');
  process.exit(1);
}
for (const host of ['127.0.0.1', '::1']) {
  if (await belegt(PORT, host)) {
    melde(`Abbruch: Port ${PORT} ist auf ${host} belegt — läuft die Prüf-App schon? (laufzeit/dienst.json)`);
    process.exit(1);
  }
}

// Geerbte VITE_*-Werte gelten nie — nur die vier gesetzten und das Kennzeichen.
const basisUmgebung = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('VITE_')));
const umgebung = {
  ...basisUmgebung,
  VITE_SUPABASE_URL: 'http://127.0.0.1:54321',
  VITE_SUPABASE_ANON_KEY: anon,
  VITE_GEMINI_API_KEY: '',
  VITE_MAIL_PROVIDER: 'stub',
  VITE_PRUEFUMGEBUNG: KENNZEICHEN,
};

const log = fs.createWriteStream(path.join(LAUFZEIT, 'vite-5232.log'), { flags: 'a' });
let vite = null;
let neustarts = 0;
const schreibeStand = () => {
  fs.writeFileSync(path.join(LAUFZEIT, 'dienst.json'), JSON.stringify({
    start: stand.start,
    pid: process.pid,
    vitePid: vite?.pid ?? null,
    viteStarts: neustarts + 1,
    app: `http://localhost:${PORT}`,
    supabase: 'http://127.0.0.1:54321',
    kennzeichen: KENNZEICHEN,
  }, null, 2));
};
const stand = { start: new Date().toISOString() };

function starteVite() {
  vite = spawn(process.execPath, [path.join(REPO, 'node_modules/vite/bin/vite.js'), '--config', path.join(HIER, 'vite.dok01.config.mjs')], {
    cwd: REPO,
    env: umgebung,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  vite.stdout.pipe(log, { end: false });
  vite.stderr.pipe(log, { end: false });
  vite.on('exit', (code, signal) => {
    melde(`[vite-5232] beendet (Code ${code}, Signal ${signal ?? '-'})`);
    if (neustarts >= 5) { melde('[vite-5232] zu viele Neustarts — Dienst endet'); process.exit(1); }
    neustarts += 1;
    setTimeout(starteVite, 3000);
  });
  melde(`Prüf-App Vite 127.0.0.1:${PORT} gestartet (PID ${vite.pid}, Start ${neustarts + 1}), Protokoll laufzeit/vite-5232.log`);
  schreibeStand();
}
starteVite();

// [::1]:5232 → 127.0.0.1:5232, damit http://localhost:5232 in jeder Auflösung trifft.
net.createServer((client) => {
  const ziel = net.connect(PORT, '127.0.0.1');
  client.pipe(ziel);
  ziel.pipe(client);
  const zu = () => { client.destroy(); ziel.destroy(); };
  client.on('error', zu);
  ziel.on('error', zu);
}).listen(PORT, '::1', () => melde(`Weiterleitung [::1]:${PORT} → 127.0.0.1:${PORT} aktiv`));

const ende = () => { neustarts = 99; try { vite?.kill(); } catch { /* schon beendet */ } process.exit(0); };
process.on('SIGINT', ende);
process.on('SIGTERM', ende);
