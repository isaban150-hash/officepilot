// I3-Beobachtung: Woran liegt `calls: []` im Altbestandsteil — an der R2-Sperre oder am neuen Starthalt?
// Eine Ersetzung (genau einmal): Der Beweis nennt zusätzlich Identitätswechsel, Startproblem und Sperrgrund.
import fs from 'node:fs';
import path from 'node:path';

const ordner = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, '')), 'WEISS-DOK01-R1R2-2026-10-20', 'originalproben');
const quelle = 'dok01-n1n2-sendekonto-und-altbestand.mjs';
const alt = 'calls,completed:legacyResult.completedOutboxIds}';
const neu =
  "calls,completed:legacyResult.completedOutboxIds,identityChanged:legacyResult.identityChanged??false,startProblem:legacyResult.runIdentity?.startProblem??null,startKonsistent:legacyResult.runIdentity?.consistent??null,gesperrt:(legacyResult.state.syncOutbox??[]).map(x=>x.originHold?.reason??x.status)}";
const original = fs.readFileSync(path.join(ordner, quelle), 'utf8');
const treffer = original.split(alt).length - 1;
if (treffer !== 1) throw new Error(`${treffer}× statt 1×`);
fs.writeFileSync(path.join(ordner, quelle.replace('.mjs', '.beobachtet.mjs')), original.replace(alt, () => neu));
fs.writeFileSync(path.join(ordner, 'variante-i3-ersetzung.json'), JSON.stringify({ quelle, alt, neu }, null, 2));
console.log('ok');
