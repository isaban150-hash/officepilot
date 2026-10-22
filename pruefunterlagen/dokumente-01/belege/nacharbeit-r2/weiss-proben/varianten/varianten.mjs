// Leitet aus den unveränderten WEISS-Proben I2 (dok01-n1n2-sdk.mjs) und I4 (variante-nur-token.mjs) je zwei
// Beobachtungsvarianten ab. Jede Ersetzung muss genau einmal greifen; das Protokoll listet sie wörtlich.
import fs from 'node:fs';
import path from 'node:path';

const ordner = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, '')), 'WEISS-DOK01-R1R2-2026-10-20', 'originalproben');

const RENNEN_ALT = "await Promise.race([started,new Promise((_,reject)=>setTimeout(()=>reject(Error('Kein RPC')),15000))])";
const RENNEN_NEU = "const vorDemWechsel=await Promise.race([started.then(()=>'erster_rpc'),run.then(()=>'lauf_beendet_ohne_rpc')])";
const BEWEIS_ALT = "wrongIdentity:calls[1]?.authorization==='Bearer synthetic-account-B'}";
const BEWEIS_BEOBACHTET =
  "wrongIdentity:calls.some(x=>x.authorization==='Bearer synthetic-account-B'),identityChanged:result.identityChanged??false,identityChangeReason:result.identityChangeReason??null,vorDemWechsel}";
const TOKEN_ALT = "accessToken:async()=> 'synthetic-account-'+account";
const TOKEN_NEU = 'accessToken:async()=> jwt(account)';
const KONTO_ALT = "let account='A',start,release";
const KONTO_NEU =
  "let account='A',start,release;const jwt=a=>[{alg:'HS256',typ:'JWT'},{sub:a,role:'authenticated',exp:4102444800}].map(x=>Buffer.from(JSON.stringify(x)).toString('base64url')).join('.')+'.synthetisch'";
const BEWEIS_JWT =
  "wrongIdentity:calls.some(x=>x.authorization==='Bearer '+jwt('B')),zugangNurA:calls.every(x=>x.authorization==='Bearer '+jwt('A')),identityChanged:result.identityChanged??false,identityChangeReason:result.identityChangeReason??null,vorDemWechsel}";

const VARIANTEN = {
  beobachtet: [
    [RENNEN_ALT, RENNEN_NEU],
    [BEWEIS_ALT, BEWEIS_BEOBACHTET],
  ],
  jwt: [
    [KONTO_ALT, KONTO_NEU],
    [TOKEN_ALT, TOKEN_NEU],
    [RENNEN_ALT, RENNEN_NEU],
    [BEWEIS_ALT, BEWEIS_JWT],
  ],
};

const protokoll = [];
for (const quelle of ['dok01-n1n2-sdk.mjs', 'variante-nur-token.mjs']) {
  const original = fs.readFileSync(path.join(ordner, quelle), 'utf8');
  for (const [name, ersetzungen] of Object.entries(VARIANTEN)) {
    let text = original;
    for (const [alt, neu] of ersetzungen) {
      const treffer = text.split(alt).length - 1;
      if (treffer !== 1) throw new Error(`${quelle}/${name}: „${alt.slice(0, 40)}…“ ${treffer}× statt 1×`);
      text = text.replace(alt, () => neu);
    }
    const ziel = quelle.replace('.mjs', `.${name}.mjs`);
    fs.writeFileSync(path.join(ordner, ziel), text);
    protokoll.push({ quelle, variante: ziel, ersetzungen: ersetzungen.map(([alt, neu]) => ({ alt, neu })) });
  }
}
fs.writeFileSync(path.join(ordner, 'varianten-ersetzungen.json'), JSON.stringify(protokoll, null, 2));
console.log(protokoll.map((eintrag) => `${eintrag.variante}: ${eintrag.ersetzungen.length} Ersetzungen`).join('\n'));
