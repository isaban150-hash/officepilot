// DOKUMENTE-01 Restkorrektur — unabhängige Probe der Diffs: jeden Diff rückwärts auf die heutige Datei anwenden
// (`patch -R`) und den so erhaltenen Stand vor dieser Runde prüfen:
//   - gegen die Prüfsumme in `diffs/diffs-uebersicht.json` (vorherPruefsumme),
//   - bei den Dateien der R1/R2-Nacharbeit zusätzlich gegen `nacharbeit-r/pruefsummen.txt` (Stand des WEISS-Rechecks),
//   - neue Dateien: rückwärts muss nichts übrig bleiben.
// Aufruf aus dem Repo: node pruefunterlagen/dokumente-01/belege/nacharbeit-r2/werkzeuge/vorher-pruefen.cjs <arbeitsordner>
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const arbeit = process.argv[2];
if (!arbeit) throw new Error('Arbeitsordner fehlt');
fs.mkdirSync(arbeit, { recursive: true });
const BELEGE = 'pruefunterlagen/dokumente-01/belege';
const sha = (text) => crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
const rSummen = new Map(
  fs
    .readFileSync(path.join(BELEGE, 'nacharbeit-r/pruefsummen.txt'), 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((zeile) => {
      const [hash, datei] = zeile.split(' *');
      return [datei, hash];
    }),
);
const uebersicht = JSON.parse(fs.readFileSync(path.join(BELEGE, 'nacharbeit-r2/diffs/diffs-uebersicht.json'), 'utf8'));

const ergebnis = [];
for (const eintrag of uebersicht) {
  const kurz = eintrag.datei.split('/').pop();
  const jetzt = fs.readFileSync(eintrag.datei, 'utf8');
  const crlf = jetzt.includes('\r\n');
  const jetztLf = path.join(arbeit, `${kurz}.jetzt`);
  const vorherLf = path.join(arbeit, `${kurz}.vorher`);
  fs.writeFileSync(jetztLf, jetzt.replace(/\r\n/g, '\n'));
  const p = spawnSync('patch', ['-R', '-s', '-o', vorherLf, jetztLf, path.join(BELEGE, 'nacharbeit-r2/diffs', `${kurz}.diff`)], {
    encoding: 'utf8',
  });
  if (p.status !== 0) {
    ergebnis.push({ datei: eintrag.datei, ok: false, fehler: (p.stderr || p.stdout).slice(0, 300) });
    continue;
  }
  const vorherText = fs.readFileSync(vorherLf, 'utf8');
  const vorher = crlf ? vorherText.replace(/\n/g, '\r\n') : vorherText;
  if (eintrag.art === 'neu in dieser Runde') {
    ergebnis.push({ datei: eintrag.datei, art: eintrag.art, ok: vorher === '', rueckwaertsLeer: vorher === '' });
    continue;
  }
  const summe = sha(vorher);
  const r = rSummen.get(eintrag.datei) ?? null;
  ergebnis.push({
    datei: eintrag.datei,
    art: eintrag.art,
    ok: summe === eintrag.vorherPruefsumme && (r === null || summe === r),
    gleichUebersicht: summe === eintrag.vorherPruefsumme,
    gleichRStand: r === null ? null : summe === r,
    jetztGleichUebersicht: sha(jetzt) === eintrag.jetztPruefsumme,
  });
}
console.log(JSON.stringify({ alleOk: ergebnis.every((e) => e.ok), ergebnis }, null, 1));
