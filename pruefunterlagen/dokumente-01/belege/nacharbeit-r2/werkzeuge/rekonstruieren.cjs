// Stellt den Stand vor dieser Runde je Datei her: die Bearbeitungen der Runde rückwärts auf den heutigen Inhalt.
// Belegt wird der Stand doppelt: (1) vorwärts angewendet ergibt er genau den heutigen Inhalt, (2) wo vorhanden,
// stimmt seine Prüfsumme mit der aus der R1/R2-Nacharbeit überein. Danach Diffs vorher → jetzt.
// Aufruf: node rekonstruieren.cjs <repo> <runde.json> <arbeitsordner> <diff-ziel>
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const [repo, rundeDatei, arbeit, ziel] = process.argv.slice(2);
fs.mkdirSync(arbeit, { recursive: true });
fs.mkdirSync(ziel, { recursive: true });

const sha = (text) => crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
const rel = (p) => path.relative(repo, p).split(path.sep).join('/');
const rSummen = new Map(
  fs
    .readFileSync(path.join(repo, 'pruefunterlagen/dokumente-01/belege/nacharbeit-r/pruefsummen.txt'), 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((zeile) => {
      const [hash, datei] = zeile.split(' *');
      return [datei, hash];
    }),
);

const runde = JSON.parse(fs.readFileSync(rundeDatei, 'utf8'));
const jeDatei = new Map();
for (const a of runde) {
  const datei = path.resolve(a.input.file_path);
  if (!datei.toLowerCase().startsWith(path.resolve(repo, 'src').toLowerCase())) continue;
  if (!a.ergebnis || a.ergebnis.fehler) continue;
  if (!jeDatei.has(datei)) jeDatei.set(datei, []);
  jeDatei.get(datei).push(a);
}

function anwenden(text, alt, neu, alle, eol) {
  const a = alt.replace(/\r?\n/g, eol);
  const n = neu.replace(/\r?\n/g, eol);
  const treffer = text.split(a).length - 1;
  if (alle) return { text: text.split(a).join(n), treffer };
  if (treffer !== 1) return { text, treffer };
  return { text: text.replace(a, () => n), treffer };
}

const bericht = [];
for (const [datei, schritte] of jeDatei) {
  const name = rel(datei);
  const jetzt = fs.readFileSync(datei, 'utf8');
  const eol = jetzt.includes('\r\n') ? '\r\n' : '\n';
  const neuAngelegt = schritte[0].werkzeug === 'Write';
  let vorher = jetzt;
  let fehler = null;
  if (neuAngelegt) {
    vorher = '';
  } else {
    for (const s of [...schritte].reverse()) {
      if (s.werkzeug !== 'Edit') {
        fehler = 'Write mitten in der Runde';
        break;
      }
      const r = anwenden(vorher, s.input.new_string, s.input.old_string, Boolean(s.input.replace_all), eol);
      if (!s.input.replace_all && r.treffer !== 1) {
        fehler = `Rückwärtsschritt ${s.id}: ${r.treffer} Treffer`;
        break;
      }
      vorher = r.text;
    }
  }
  // Vorwärts: vom hergestellten Stand mit denselben Schritten zum heutigen Inhalt.
  let vorwaerts = vorher;
  if (!fehler) {
    for (const s of schritte) {
      if (s.werkzeug === 'Write') {
        vorwaerts = s.input.content.replace(/\r?\n/g, eol);
        continue;
      }
      const r = anwenden(vorwaerts, s.input.old_string, s.input.new_string, Boolean(s.input.replace_all), eol);
      if (!s.input.replace_all && r.treffer !== 1) {
        fehler = `Vorwärtsschritt ${s.id}: ${r.treffer} Treffer`;
        break;
      }
      vorwaerts = r.text;
    }
  }
  const vorwaertsGleich = !fehler && vorwaerts === jetzt;
  const rSumme = rSummen.get(name) ?? null;
  const vorherSumme = neuAngelegt ? null : sha(vorher);
  const kurz = name.split('/').pop();
  const vorherDatei = path.join(arbeit, `${kurz}.vorher`);
  const jetztDatei = path.join(arbeit, `${kurz}.jetzt`);
  fs.writeFileSync(vorherDatei, vorher.replace(/\r\n/g, '\n'));
  fs.writeFileSync(jetztDatei, jetzt.replace(/\r\n/g, '\n'));
  let diffZeilen = null;
  if (!fehler) {
    const d = spawnSync(
      'git',
      ['diff', '--no-index', `--src-prefix=a/${path.dirname(name)}/vorher/`, `--dst-prefix=b/${path.dirname(name)}/jetzt/`, '--', vorherDatei, jetztDatei],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    fs.writeFileSync(path.join(ziel, `${kurz}.diff`), d.stdout);
    diffZeilen = d.stdout.split('\n').length;
  }
  bericht.push({
    datei: name,
    art: neuAngelegt ? 'neu in dieser Runde' : 'geändert',
    schritte: schritte.length,
    zeilenende: eol === '\r\n' ? 'CRLF' : 'LF',
    vorwaertsGleich,
    vorherPruefsumme: vorherSumme,
    rPruefsumme: rSumme,
    vorherGleichRStand: rSumme ? rSumme === vorherSumme : null,
    jetztPruefsumme: sha(jetzt),
    diffZeilen,
    fehler,
  });
}
fs.writeFileSync(path.join(ziel, 'diffs-uebersicht.json'), JSON.stringify(bericht, null, 2));
console.log(JSON.stringify(bericht.map(({ jetztPruefsumme, vorherPruefsumme, rPruefsumme, ...rest }) => rest), null, 1));
