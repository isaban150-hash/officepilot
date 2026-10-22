// Ersetzt in den Diffs dieser Runde die Arbeitspfade der Kopfzeilen durch die Repo-Pfade (a/<datei>, b/<datei>).
// Aufruf: node diffkoepfe.cjs <diff-ordner>
const fs = require('fs');
const path = require('path');

const ordner = process.argv[2];
const uebersicht = JSON.parse(fs.readFileSync(path.join(ordner, 'diffs-uebersicht.json'), 'utf8'));
const ergebnis = [];
for (const eintrag of uebersicht) {
  const kurz = eintrag.datei.split('/').pop();
  const datei = path.join(ordner, `${kurz}.diff`);
  const alt = fs.readFileSync(datei, 'utf8');
  const zeilen = alt.split('\n');
  let ersetzt = 0;
  for (let i = 0; i < zeilen.length; i += 1) {
    const z = zeilen[i];
    if (z.startsWith('@@')) break; // nur der Kopf
    if (z.startsWith('diff --git ')) {
      zeilen[i] = `diff --git a/${eintrag.datei} b/${eintrag.datei}`;
      ersetzt += 1;
    } else if (z.startsWith('--- ')) {
      zeilen[i] = `--- a/${eintrag.datei}`;
      ersetzt += 1;
    } else if (z.startsWith('+++ ')) {
      zeilen[i] = `+++ b/${eintrag.datei}`;
      ersetzt += 1;
    }
  }
  const neu = zeilen.join('\n');
  if (/LENOVO~1|scratchpad|\.vorher|\.jetzt/.test(neu.split('\n@@')[0])) throw new Error(`${kurz}: Kopf nicht bereinigt`);
  fs.writeFileSync(datei, neu);
  ergebnis.push({ datei: eintrag.datei, kopfzeilen: ersetzt });
}
console.log(JSON.stringify(ergebnis));
