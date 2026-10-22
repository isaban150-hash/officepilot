// DOKUMENTE-01 R1/R2 — gezielte Browserprüfung auf der Prüf-App 5232 (frische Edge-Profile, Edge-Kanal).
//   R1  Zwei Tabs, ein Profil (gemeinsamer Speicher): Tab 1 = Inhaber mit drei neuen, ungesendeten Dokumenten. Die
//       erste Sendung wird angehalten; in Tab 2 meldet sich das Mitglied an; danach läuft Tab 1 weiter.
//       Erwartet: genau eine Sendung aus Tab 1, mit dem Zugang des Inhabers; keine Sendung dieser Dokumente unter
//       dem Mitglied; zwei Aufträge offen beim Inhaber; die eine Bestätigung im Journal des Inhabers.
//   R1b Inhaber erneut in Tab 1: Laden wendet das Journal an; gesendet werden genau die zwei übrigen, mit seinem
//       Zugang; nichts doppelt; Journal danach leer.
//   R2  Frisches Profil mit altem gemeinsamem Bestand (vor der Kontotrennung) und zwei offenen Aufträgen ohne
//       Ursprung. Inhaber meldet sich an: nichts davon gesendet, Anzeige „Aktion erforderlich", Sync-Seite mit
//       „Zurückgehaltene Aufträge"; Neuladen: weiter gesperrt; Freigabe eines Auftrags in der Oberfläche (Auswahl,
//       Bestätigung): genau dieser geht mit dem Zugang des Inhabers hinaus, der andere bleibt gesperrt; Prüfspur.
// Server bleibt unverändert: Dokumentsendungen (`upsert_workspace_intake_entity`) beantwortet das Skript selbst,
// jeder andere schreibende Aufruf an 127.0.0.1:54321 wird abgebrochen; /auth/v1/logout lokal 204. Sitzungen per
// GoTrue-Admin-Magic-Link nur im Speicher, am Ende mit scope=local widerrufen; Profile werden gelöscht. Ausgabe nur
// mit Zählwerten — ohne Token, Kennungen, E-Mails und Titel.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire('C:/Users/Lenovo-ThinkPad-E590/Desktop/officepilot/package.json');
const { chromium } = require('playwright-core');

const HIER = 'C:/Users/LENOVO~1/AppData/Local/Temp/claude/c--Users-Lenovo-ThinkPad-E590-Desktop-officepilot/70985f23-7ee9-4472-b575-58bf41c8864b/scratchpad/dok01/r';
const KEYS = JSON.parse(fs.readFileSync(path.join(HIER, '../ab/keys.json'), 'utf8'));
const API = 'http://127.0.0.1:54321';
const APP = 'http://localhost:5232';
const SITZUNGSSCHLUESSEL = 'sb-127-auth-token';
const BILDER = path.join(HIER, 'bilder');
const AUSGABE = process.argv[2] ?? path.join(HIER, 'abnahme-r-ergebnis.json');
fs.mkdirSync(BILDER, { recursive: true });

const jwtTeil = (t) => {
  try {
    return JSON.parse(Buffer.from(String(t).split('.')[1], 'base64url').toString('utf8'));
  } catch {
    return {};
  }
};
for (const [name, rolle] of [['anon', 'anon'], ['service', 'service_role']]) {
  const p = jwtTeil(KEYS[name]);
  if (p.iss !== 'supabase-demo' || p.role !== rolle || p.ref) throw new Error(`kein lokaler Demo-Schlüssel: ${name}`);
}
const admin = { apikey: KEYS.service, Authorization: `Bearer ${KEYS.service}`, 'Content-Type': 'application/json' };
const maske = (s) =>
  String(s ?? '')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, (u) => `${u.slice(0, 8)}…`)
    .replace(/[a-z0-9.+-]+@example\.invalid/gi, '…@example.invalid');

async function konto(muster) {
  const treffer = [];
  for (let seite = 1; seite <= 50; seite += 1) {
    const r = await fetch(`${API}/auth/v1/admin/users?page=${seite}&per_page=200`, { headers: admin });
    if (!r.ok) throw new Error(`Nutzerliste HTTP ${r.status}`);
    const nutzer = (await r.json()).users ?? [];
    treffer.push(...nutzer.filter((u) => muster.test(u.email ?? '')));
    if (nutzer.length < 200) break;
  }
  if (treffer.length !== 1) throw new Error(`${treffer.length} passende Konten für ${muster}`);
  return treffer[0];
}

async function sitzung(email) {
  const g = await fetch(`${API}/auth/v1/admin/generate_link`, { method: 'POST', headers: admin, body: JSON.stringify({ type: 'magiclink', email }) });
  if (!g.ok) throw new Error(`generate_link HTTP ${g.status}`);
  const gj = await g.json();
  const tokenHash = gj.hashed_token ?? gj.properties?.hashed_token;
  if (!tokenHash) throw new Error('generate_link ohne hashed_token');
  const v = await fetch(`${API}/auth/v1/verify`, {
    method: 'POST',
    headers: { apikey: KEYS.anon, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'magiclink', token_hash: tokenHash }),
  });
  if (!v.ok) throw new Error(`verify HTTP ${v.status}`);
  const s = await v.json();
  if (!s.access_token || !s.refresh_token) throw new Error('verify ohne Sitzung');
  if (!s.expires_at) s.expires_at = Math.floor(Date.now() / 1000) + Number(s.expires_in ?? 3600);
  return s;
}

async function widerrufen(s) {
  if (!s) return null;
  const r = await fetch(`${API}/auth/v1/logout?scope=local`, {
    method: 'POST',
    headers: { apikey: KEYS.anon, Authorization: `Bearer ${s.access_token}` },
  });
  return r.status;
}

const ergebnis = { start: new Date().toISOString(), phasen: {}, pruefungen: [], blockiert: [], konsole: [] };
let phase = 'start';
let letzterAbzug = 0;
let abzuege = 0;
/** Jede Dokumentsendung, die die Seite versucht: Tab, Konto laut Zugang, Kennung (bleibt im Speicher). */
const sendungen = [];
let halt = null;

function pruef(name, ok, detail = undefined) {
  ergebnis.pruefungen.push({ phase, name, ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) });
  console.log(`${ok ? 'OK  ' : 'FEHL'} [${phase}] ${name}${detail === undefined ? '' : ` — ${maske(JSON.stringify(detail)).slice(0, 220)}`}`);
}

const inhaber = await konto(/^dok01-inhaber-[0-9a-z]+@example\.invalid$/);
const mitglied = await konto(/^dok01-mitglied-[0-9a-z]+@example\.invalid$/);
const sitzungen = [];
async function neueSitzung(email) {
  const s = await sitzung(email);
  sitzungen.push(s);
  return s;
}
const wer = (zugang) => {
  const sub = jwtTeil(String(zugang ?? '').replace(/^Bearer\s+/i, '')).sub;
  return sub === inhaber.id ? 'inhaber' : sub === mitglied.id ? 'mitglied' : sub ? 'anderes' : 'ohne';
};

const LESE_RPC = /^(pull_|get_|list_|is_|can_|has_|check_|count_|search_|resolve_)/;
const tabs = new Map();

async function schutz(ctx) {
  await ctx.route('**/*', async (route) => {
    const req = route.request();
    const u = new URL(req.url());
    if (u.host !== '127.0.0.1:54321') return route.continue();
    const m = req.method();
    const p = u.pathname;
    if (p === '/auth/v1/logout') {
      ergebnis.blockiert.push({ phase, art: 'auth-logout', scope: u.searchParams.get('scope') ?? '(standard)' });
      return route.fulfill({ status: 204, body: '' });
    }
    if (p.startsWith('/auth/v1/')) return route.continue();
    if (p.startsWith('/rest/v1/rpc/')) {
      const name = p.slice('/rest/v1/rpc/'.length);
      if (LESE_RPC.test(name) || name === 'ensure_personal_workspace') {
        if (name.startsWith('pull_')) {
          letzterAbzug = Date.now();
          abzuege += 1;
        }
        return route.continue();
      }
      let body = {};
      try {
        body = JSON.parse(req.postData() ?? '{}');
      } catch {
        body = {};
      }
      const tab = tabs.get(req.frame()?.page()) ?? '?';
      const zugang = (await req.allHeaders())['authorization'] ?? null;
      if (name === 'upsert_workspace_intake_entity') {
        const pl = body.p_payload ?? {};
        sendungen.push({ phase, tab, konto: wer(zugang), typ: body.p_entity_type ?? null, kennung: pl.client_document_id ?? pl.document_id ?? null });
        if (halt) {
          const h = halt;
          halt = null;
          h.erreicht();
          await h.freigabe;
        }
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ row_version: 1, deleted: false, payload: pl }),
        });
      }
      ergebnis.blockiert.push({ phase, art: 'rpc', tab, rpc: name, typ: body.p_entity_type ?? null, konto: wer(zugang) });
      return route.abort('failed');
    }
    if (m === 'GET' || m === 'HEAD') return route.continue();
    ergebnis.blockiert.push({ phase, art: 'http', methode: m, pfad: maske(p).slice(0, 80) });
    return route.abort('failed');
  });
}

function halteNaechsteSendung() {
  let erreicht;
  let frei;
  const erreichtP = new Promise((r) => (erreicht = r));
  const freigabe = new Promise((r) => (frei = r));
  halt = { erreicht, freigabe };
  return { erreicht: erreichtP, frei };
}

const warte = (ms) => new Promise((r) => setTimeout(r, ms));
async function abzugRuhig(maxMs = 90000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    if (abzuege > 0 && Date.now() - letzterAbzug > 6000) return true;
    await warte(500);
  }
  return false;
}
async function anmelden(page, s, warteAuf = 'user-menu') {
  await page.goto(`${APP}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(([k, v]) => localStorage.setItem(k, v), [SITZUNGSSCHLUESSEL, JSON.stringify(s)]);
  abzuege = 0;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByTestId(warteAuf).waitFor({ timeout: 90000 });
  return abzugRuhig();
}
/**
 * Sitzung setzen, ohne dass die App vorher mit der bisherigen Sitzung startet: Die Seite öffnet zuerst eine
 * Moduldatei derselben Herkunft (wird als Text ausgeliefert, kein App-Start), setzt dort den Speicher und öffnet
 * erst dann die App.
 */
async function anmeldenOhneVorstart(page, s, warteAuf = 'user-menu') {
  await page.goto(`${APP}/src/i18n/locales/de/syncHeldOrders.ts`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(([k, v]) => localStorage.setItem(k, v), [SITZUNGSSCHLUESSEL, JSON.stringify(s)]);
  abzuege = 0;
  await page.goto(`${APP}/`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId(warteAuf).waitFor({ timeout: 90000 });
  return abzugRuhig();
}
async function bild(page, name) {
  await page.screenshot({ path: path.join(BILDER, `${name}.png`) }).catch(() => {});
}
async function geheZu(page, pfad, ms = 2500) {
  await page.evaluate((p) => {
    window.history.pushState({}, '', p);
    window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
  }, pfad);
  await warte(ms);
}

/** Gespeicherter Kontobestand (gemeinsamer Speicher): Aufträge zu den genannten Dokumenten, Journal, Prüfspur. */
async function bestand(page, ws, uid, access, docIds) {
  return page.evaluate(
    ([schluessel, ids]) => {
      const raw = localStorage.getItem(schluessel);
      const zustand = raw ? JSON.parse(raw) : null;
      const auftraege = (zustand?.syncOutbox ?? []).filter((e) => e.entityType === 'document' && ids.includes(e.entityId));
      const journal = localStorage.getItem(`${schluessel}:sync-confirmed`);
      const spur = localStorage.getItem(`${schluessel}:outbox-origin-log`);
      return {
        vorhanden: raw !== null,
        auftraege: auftraege.map((e) => ({ entityId: e.entityId, status: e.status, gesperrt: Boolean(e.hold), quelle: e.hold?.source ?? null, ursprung: e.origin?.userId ?? null })),
        journal: journal ? JSON.parse(journal).length : 0,
        spur: spur ? JSON.parse(spur).map((ev) => ({ aktion: ev.action, quelle: ev.source ?? null, von: ev.by ?? null, anzahl: ev.entries.length })) : [],
      };
    },
    [`officepilot-state:workspace:${ws}:account:${uid}:${access}`, docIds],
  );
}

async function aktiverBereich(page) {
  return page.evaluate(async ([inhaberUid, mitgliedUid]) => {
    const scope = await import('/src/services/storage/storageScopeService.ts');
    const ws = await import('/src/services/workspace/workspaceStore.ts');
    const konto = scope.getActiveStorageAccount();
    return {
      workspaceId: ws.getWorkspaceStoreSnapshot()?.id ?? null,
      konto: konto ? { wer: konto.userId === inhaberUid ? 'inhaber' : konto.userId === mitgliedUid ? 'mitglied' : 'anderes', access: konto.access } : null,
    };
  }, [inhaber.id, mitglied.id]);
}

const zaehle = (liste, f) => liste.reduce((acc, x) => ({ ...acc, [f(x)]: (acc[f(x)] ?? 0) + 1 }), {});

const profil1 = path.join(HIER, 'profil-r1');
const profil2 = path.join(HIER, 'profil-r2');
fs.rmSync(profil1, { recursive: true, force: true });
fs.rmSync(profil2, { recursive: true, force: true });
let ctx1 = null;
let ctx2 = null;

function protokolliere(page, tab) {
  page.on('console', (msg) => {
    const text = msg.text();
    if (msg.type() === 'error' || /\[OfficePilot:/.test(text)) {
      ergebnis.konsole.push({ t: new Date().toISOString(), phase, tab, typ: msg.type(), text: maske(text).slice(0, 240) });
    }
  });
  page.on('pageerror', (e) => ergebnis.konsole.push({ t: new Date().toISOString(), phase, tab, typ: 'pageerror', text: maske(String(e)).slice(0, 240) }));
}

try {
  // ------------------------------------------------------------------ R1: zwei Tabs
  ctx1 = await chromium.launchPersistentContext(profil1, { channel: 'msedge', headless: false, viewport: { width: 1280, height: 860 } });
  await schutz(ctx1);
  const tab1 = ctx1.pages()[0] ?? (await ctx1.newPage());
  tabs.set(tab1, 1);
  protokolliere(tab1, 1);
  tab1.setDefaultNavigationTimeout(120000);
  tab1.setDefaultTimeout(60000);

  phase = 'R1-vorbereitung';
  const sInhaber = await neueSitzung(inhaber.email);
  ergebnis.phasen.R1vorbereitung = { abzugRuhig: await anmelden(tab1, sInhaber) };
  const b0 = await aktiverBereich(tab1);
  pruef('Inhaber im eigenen Kontobereich', b0.konto?.wer === 'inhaber' && b0.konto?.access === 'full', b0.konto);
  const ws = b0.workspaceId;
  if (!ws) throw new Error('kein Betrieb');

  phase = 'R1-zwei-tabs';
  const erster = halteNaechsteSendung();
  const docIds = await tab1.evaluate(async () => {
    const ds = await import('/src/services/documentService.ts');
    const ids = [];
    for (const n of [1, 2, 3]) {
      const r = ds.addDocument({ title: `R1 Prüfdokument ${n}`, category: 'sonstiges', issuer: 'R1 Prüfung' });
      if (r.success) ids.push(r.document.id);
    }
    return ids;
  });
  pruef('drei Dokumente lokal angelegt', docIds.length === 3, { anzahl: docIds.length });
  const vorher = await bestand(tab1, ws, inhaber.id, 'full', docIds);
  pruef('drei offene Aufträge mit Ursprung Inhaber', vorher.auftraege.length === 3 && vorher.auftraege.every((a) => a.status === 'pending' && a.ursprung === inhaber.id), { status: zaehle(vorher.auftraege, (a) => a.status) });
  // Senden anstoßen (der Planer täte es nach seiner Entprellung ebenso); nicht abwarten — die erste Sendung hängt.
  void tab1.evaluate(async () => {
    const ui = await import('/src/services/sync/syncUiService.ts');
    await ui.pushPendingChangesFromUi();
  }).catch(() => {});
  await Promise.race([erster.erreicht, warte(90000).then(() => { throw new Error('keine erste Sendung'); })]);
  pruef('erste Sendung angehalten (Tab 1, Zugang Inhaber)', sendungen.length === 1 && sendungen[0].tab === 1 && sendungen[0].konto === 'inhaber', { sendungen: sendungen.length });

  // Tab 2 im selben Profil: das Mitglied meldet sich an.
  const tab2 = await ctx1.newPage();
  tabs.set(tab2, 2);
  protokolliere(tab2, 2);
  tab2.setDefaultNavigationTimeout(120000);
  tab2.setDefaultTimeout(60000);
  const sMitglied = await neueSitzung(mitglied.email);
  ergebnis.phasen.R1tab2 = { abzugRuhig: await anmeldenOhneVorstart(tab2, sMitglied) };
  const b2 = await aktiverBereich(tab2);
  pruef('Tab 2: Mitglied angemeldet (eigene Sicht)', b2.konto?.wer === 'mitglied' && b2.konto?.access === 'member', b2.konto);
  erster.frei();
  await warte(10000);
  await bild(tab1, 'r1-tab1-nach-wechsel');

  const r1 = sendungen.filter((s) => s.phase === 'R1-zwei-tabs');
  const r1Docs = r1.filter((s) => docIds.includes(s.kennung));
  pruef('genau eine Sendung der drei Dokumente', r1Docs.length === 1, { proTabKonto: zaehle(r1Docs, (s) => `${s.tab}:${s.konto}`) });
  pruef('keine Sendung der Inhaberdokumente unter dem Mitglied', r1Docs.every((s) => s.konto === 'inhaber'));
  pruef('Tab 1 sendet nach dem Wechsel nichts mehr', r1.filter((s) => s.tab === 1).length === 1, { tab1: r1.filter((s) => s.tab === 1).length });
  const gesendetId = r1Docs[0]?.kennung ?? null;
  const nachR1 = await bestand(tab2, ws, inhaber.id, 'full', docIds);
  const offenR1 = nachR1.auftraege.filter((a) => a.status !== 'completed');
  pruef('Aufträge beim Inhaber erhalten (keiner verloren, keiner fehlgeschlagen)', nachR1.auftraege.length === 3 && nachR1.auftraege.every((a) => a.status === 'pending'), { status: zaehle(nachR1.auftraege, (a) => a.status) });
  pruef('Bestätigung im Journal des Inhabers', nachR1.journal === 1, { journal: nachR1.journal });
  const mitgliedBestand = await bestand(tab2, ws, mitglied.id, 'member', docIds);
  pruef('Mitgliedsbestand ohne Inhaberaufträge', mitgliedBestand.auftraege.length === 0, { auftraege: mitgliedBestand.auftraege.length });
  ergebnis.phasen.R1 = { sendungen: r1.length, offen: offenR1.length };
  await tab2.close();

  // ------------------------------------------------------------------ R1b: Inhaber erneut
  phase = 'R1b-inhaber-erneut';
  const sInhaber2 = await neueSitzung(inhaber.email);
  ergebnis.phasen.R1b = { abzugRuhig: await anmeldenOhneVorstart(tab1, sInhaber2) };
  await warte(6000);
  void tab1.evaluate(async () => {
    const ui = await import('/src/services/sync/syncUiService.ts');
    await ui.pushPendingChangesFromUi();
  }).catch(() => {});
  await warte(8000);
  const r1b = sendungen.filter((s) => s.phase === 'R1b-inhaber-erneut' && docIds.includes(s.kennung));
  pruef('genau die zwei übrigen gesendet', r1b.length === 2 && !r1b.some((s) => s.kennung === gesendetId), { anzahl: r1b.length, bereitsGesendetErneut: r1b.filter((s) => s.kennung === gesendetId).length });
  pruef('mit dem Zugang des Inhabers', r1b.every((s) => s.konto === 'inhaber' && s.tab === 1));
  const nachR1b = await bestand(tab1, ws, inhaber.id, 'full', docIds);
  pruef('alle drei erledigt, Journal leer', nachR1b.auftraege.every((a) => a.status === 'completed') && nachR1b.journal === 0, { status: zaehle(nachR1b.auftraege, (a) => a.status), journal: nachR1b.journal });
  pruef('über R1/R1b jedes Dokument genau einmal gesendet', docIds.every((id) => sendungen.filter((s) => s.kennung === id).length === 1));

  // Vorlage für den Altbestand: der gespeicherte Inhaberbestand (gleiche Firmendaten wie die Cloud).
  const vorlage = await tab1.evaluate((k) => localStorage.getItem(k), `officepilot-state:workspace:${ws}:account:${inhaber.id}:full`);
  await ctx1.close();
  ctx1 = null;

  // ------------------------------------------------------------------ R2: alter gemeinsamer Bestand
  phase = 'R2-uebernahme';
  const basis = JSON.parse(vorlage);
  const jetzt = new Date().toISOString();
  const altDoc = (n) => ({
    id: `r2-altdokument-${n}`,
    title: `R2 Altbestand ${n}`,
    category: 'sonstiges',
    issuer: 'R2 Prüfung',
    recognizedText: '',
    issueDate: null,
    validUntil: null,
    digitalFolder: { id: 'sonstiges', name: 'Sonstiges', path: '/sonstiges' },
    paperFolder: { folderId: 'sonstiges', register: 'S', label: 'Sonstiges' },
    tags: [],
    linkedCompany: null,
    linkedVorgang: null,
    archived: false,
    createdAt: jetzt,
    sync: { version: 0, updatedAt: jetzt, deleted: false, deviceId: basis.syncClient?.deviceId ?? 'geraet-r2', workspaceId: ws },
  });
  const altIds = ['r2-altdokument-1', 'r2-altdokument-2'];
  const altbestand = {
    ...basis,
    documents: [...(basis.documents ?? []).filter((d) => !docIds.includes(d.id)), altDoc(1), altDoc(2)],
    syncOutbox: altIds.map((id, i) => ({ id: `r2-altauftrag-${i + 1}`, entityType: 'document', entityId: id, operation: 'create', version: 0, queuedAt: jetzt, retryCount: 0, status: 'pending' })),
  };
  ctx2 = await chromium.launchPersistentContext(profil2, { channel: 'msedge', headless: false, viewport: { width: 1280, height: 860 } });
  await schutz(ctx2);
  const seite = ctx2.pages()[0] ?? (await ctx2.newPage());
  tabs.set(seite, 3);
  protokolliere(seite, 3);
  seite.setDefaultNavigationTimeout(120000);
  seite.setDefaultTimeout(60000);
  await seite.goto(`${APP}/`, { waitUntil: 'domcontentloaded' });
  await seite.evaluate(([k, v]) => localStorage.setItem(k, v), [`officepilot-state:workspace:${ws}`, JSON.stringify(altbestand)]);
  const sInhaber3 = await neueSitzung(inhaber.email);
  ergebnis.phasen.R2 = { abzugRuhig: await anmelden(seite, sInhaber3) };
  await warte(8000);
  const nachUebernahme = await bestand(seite, ws, inhaber.id, 'full', altIds);
  pruef('Altbestand übernommen, Aufträge erhalten und gesperrt', nachUebernahme.auftraege.length === 2 && nachUebernahme.auftraege.every((a) => a.status === 'pending' && a.gesperrt && a.quelle === 'legacy_adoption' && a.ursprung === null), nachUebernahme.auftraege.map((a) => ({ status: a.status, gesperrt: a.gesperrt, quelle: a.quelle })));
  const altGesendet = () => sendungen.filter((s) => altIds.includes(s.kennung));
  pruef('nach Anmeldung und Abgleich nichts davon gesendet', altGesendet().length === 0, { versuche: altGesendet().length });
  const anzeige = await seite.getByTestId('sync-status-indicator').getAttribute('data-state').catch(() => null);
  pruef('Anzeige „Aktion erforderlich"', anzeige === 'action', { anzeige });
  pruef('Prüfspur: Zurückhaltung bei Übernahme', nachUebernahme.spur.some((e) => e.aktion === 'held' && e.quelle === 'legacy_adoption' && e.anzahl === 2), nachUebernahme.spur);

  phase = 'R2-neustart';
  abzuege = 0;
  await seite.reload({ waitUntil: 'domcontentloaded' });
  await seite.getByTestId('user-menu').waitFor({ timeout: 90000 });
  await abzugRuhig();
  await warte(5000);
  const nachNeustart = await bestand(seite, ws, inhaber.id, 'full', altIds);
  pruef('nach Neustart weiter gesperrt', nachNeustart.auftraege.length === 2 && nachNeustart.auftraege.every((a) => a.gesperrt));
  pruef('nach Neustart nichts gesendet', altGesendet().length === 0);

  phase = 'R2-freigabe';
  await geheZu(seite, '/synchronisation', 3500);
  const abschnitt = seite.getByTestId('sync-held');
  await abschnitt.waitFor({ timeout: 30000 });
  const zeilen = await seite.getByTestId('sync-held-select').count();
  pruef('Sync-Seite: Abschnitt mit zwei zurückgehaltenen Aufträgen', zeilen === 2, { zeilen });
  const status = await seite.getByTestId('sync-status-badge').innerText().catch(() => '');
  pruef('Status nennt die Zurückhaltung', /2 Aufträge zurückgehalten/.test(status));
  await bild(seite, 'r2-sync-zurueckgehalten');
  const freigabeKnopf = seite.getByTestId('sync-held-release');
  pruef('Freigabe ohne Auswahl gesperrt', await freigabeKnopf.isDisabled());
  // Erste Zeile prüfen und auswählen; welcher Auftrag das ist, steht in der Zeile (Titel bleibt im Speicher).
  const ersteZeile = seite.getByTestId('sync-held-list').locator('li, [data-testid^="sync-held-entry"]').first();
  const ersteZeileText = await ersteZeile.innerText().catch(() => '');
  const freigegebenId = /Altbestand 1/.test(ersteZeileText) ? altIds[0] : /Altbestand 2/.test(ersteZeileText) ? altIds[1] : null;
  await seite.getByTestId('sync-held-select').first().check();
  await freigabeKnopf.click();
  await seite.getByTestId('sync-held-dialog').waitFor({ timeout: 15000 });
  await bild(seite, 'r2-freigabe-dialog');
  await seite.getByTestId('sync-held-confirm').click();
  await warte(2500);
  const nachFreigabe = await bestand(seite, ws, inhaber.id, 'full', altIds);
  pruef('genau ein Auftrag freigegeben, mit Inhaber als Ursprung', nachFreigabe.auftraege.filter((a) => !a.gesperrt).length === 1 && nachFreigabe.auftraege.filter((a) => !a.gesperrt).every((a) => a.ursprung === inhaber.id), nachFreigabe.auftraege.map((a) => ({ gesperrt: a.gesperrt, ursprungInhaber: a.ursprung === inhaber.id })));
  await seite.getByTestId('sync-run-button').click();
  await warte(10000);
  const r2Sendungen = altGesendet();
  pruef('genau der freigegebene Auftrag gesendet', r2Sendungen.length === 1 && (freigegebenId === null || r2Sendungen[0].kennung === freigegebenId), { anzahl: r2Sendungen.length, erkannt: freigegebenId !== null });
  pruef('mit dem Zugang des Inhabers', r2Sendungen.every((s) => s.konto === 'inhaber'));
  const ende = await bestand(seite, ws, inhaber.id, 'full', altIds);
  pruef('der andere bleibt gesperrt', ende.auftraege.filter((a) => a.gesperrt).length === 1);
  pruef('Prüfspur: Freigabe durch den Inhaber', ende.spur.some((e) => e.aktion === 'released' && e.von === inhaber.id && e.anzahl === 1), ende.spur.map((e) => ({ aktion: e.aktion, quelle: e.quelle, vonInhaber: e.von === inhaber.id, anzahl: e.anzahl })));
  await bild(seite, 'r2-nach-freigabe');

  phase = 'Z-gesamt';
  pruef('über alle Phasen: keine Dokumentsendung unter dem Mitglied', sendungen.every((s) => s.konto !== 'mitglied'), zaehle(sendungen, (s) => `${s.phase}:${s.konto}`));
} catch (e) {
  ergebnis.abbruch = maske(String(e?.stack ?? e)).slice(0, 900);
  console.log(`ABBRUCH in ${phase}: ${ergebnis.abbruch.slice(0, 400)}`);
} finally {
  halt?.erreicht?.();
  await ctx1?.close().catch(() => {});
  await ctx2?.close().catch(() => {});
  ergebnis.widerruf = [];
  for (const s of sitzungen) ergebnis.widerruf.push(await widerrufen(s));
  fs.rmSync(profil1, { recursive: true, force: true });
  fs.rmSync(profil2, { recursive: true, force: true });
  ergebnis.profileGeloescht = !fs.existsSync(profil1) && !fs.existsSync(profil2);
  ergebnis.sendungen = sendungen.map((s) => ({ phase: s.phase, tab: s.tab, konto: s.konto, typ: s.typ }));
  ergebnis.ende = new Date().toISOString();
  const rot = ergebnis.pruefungen.filter((p) => !p.ok);
  ergebnis.summe = { pruefungen: ergebnis.pruefungen.length, ok: ergebnis.pruefungen.length - rot.length, rot: rot.length, blockiert: ergebnis.blockiert.length, sendungen: sendungen.length };
  fs.writeFileSync(AUSGABE, maske(JSON.stringify(ergebnis, null, 2)));
  console.log(JSON.stringify({ abbruch: Boolean(ergebnis.abbruch), ...ergebnis.summe, widerruf: ergebnis.widerruf, profileGeloescht: ergebnis.profileGeloescht }));
}
