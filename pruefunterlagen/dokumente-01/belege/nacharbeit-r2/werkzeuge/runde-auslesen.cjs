// Alle Edit/Write-Aufrufe ab einer Protokollzeile (Beginn dieser Runde), für alle Dateien, samt Ergebnis des Aufrufs
// (erfolgreich oder abgelehnt). Ausgabe nur in eine Datei. Aufruf: node runde-auslesen.cjs <jsonl> <abZeile> <ausgabe.json>
const fs = require('fs');
const readline = require('readline');

const [protokoll, abZeile, ausgabe] = process.argv.slice(2);
const ab = Number(abZeile);
const aufrufe = [];
const ergebnisse = new Map();
let zeilen = 0;
const rl = readline.createInterface({ input: fs.createReadStream(protokoll, { encoding: 'utf8' }), crlfDelay: Infinity });
rl.on('line', (zeile) => {
  zeilen += 1;
  if (zeilen < ab) return;
  if (!zeile.includes('"tool_use"') && !zeile.includes('"tool_result"')) return;
  let eintrag;
  try {
    eintrag = JSON.parse(zeile);
  } catch {
    return;
  }
  const inhalt = eintrag?.message?.content;
  if (!Array.isArray(inhalt)) return;
  for (const teil of inhalt) {
    if (teil?.type === 'tool_use' && ['Edit', 'Write'].includes(teil.name)) {
      aufrufe.push({ zeile: zeilen, zeit: eintrag.timestamp ?? null, werkzeug: teil.name, id: teil.id, input: teil.input });
    }
    if (teil?.type === 'tool_result' && teil.tool_use_id) {
      const text = Array.isArray(teil.content) ? teil.content.map((c) => c?.text ?? '').join('') : String(teil.content ?? '');
      ergebnisse.set(teil.tool_use_id, { fehler: Boolean(teil.is_error), text: text.slice(0, 300) });
    }
  }
});
rl.on('close', () => {
  const mit = aufrufe.map((a) => ({ ...a, ergebnis: ergebnisse.get(a.id) ?? null }));
  fs.writeFileSync(ausgabe, JSON.stringify(mit, null, 1));
  const je = {};
  for (const a of mit) {
    const k = a.input.file_path;
    je[k] = je[k] || { ok: 0, fehler: 0, ohneErgebnis: 0 };
    if (!a.ergebnis) je[k].ohneErgebnis += 1;
    else if (a.ergebnis.fehler) je[k].fehler += 1;
    else je[k].ok += 1;
  }
  console.log(JSON.stringify({ zeilen, aufrufe: mit.length, je }, null, 1));
});
