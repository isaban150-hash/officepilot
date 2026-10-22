# DOKUMENTE-01 — Gezielte Restkorrektur R1-WEISS-START und DOK-WEISS-DIREKT

Stand 21.10.2026 · SCHWARZ · nur lokal, nichts remote.

**Grundlage**
- Auftrag „Gezielte Restkorrektur nach WEISS-Sicherheitsrecheck vom 21.10.2026“.
- Recheck-Bericht `WEISS-DOKUMENTE-01-R1R2-Sicherheitsrecheck-2026-10-21.md`, Status BLOCKIERT.

**Umfang**
- WEISS hat R2 und die ursprünglichen R1-Gegenproben bestätigt.
- W1, W2, Vorschau, N2 und die normale Kontotrennung bleiben geschlossen. Sie sind nicht berührt.
- Geändert sind nur die beiden Fundstellen und die Stellen, die deren Ergebnis weiterreichen: Adapter, Koordinator,
  Synchronisationsseite, Texte.

Belege: `belege/nacharbeit-r2/` (Abschnitt 12).

## 1. Ergebnis

| Befund | Ergebnis | Art |
|---|---|---|
| R1-WEISS-START (P1): Lauf ohne nachweisbare Startidentität sendete mit dem Zugang eines anderen Kontos | behoben | nur Client; Server unverändert |
| DOK-WEISS-DIREKT (P2): direkte Dokumentlöschung traf nach einem Kontowechsel den neuen Bestand | behoben | nur Client; Server unverändert |

Prüfung (Abschnitt 8):

- **Die beiden WEISS-Reproduktionen** liefen als bytegleiche Kopien.
  - `unlesbare-startsitzung.mjs`: 0 Aufrufe und eine einzige Sitzungslesung, `startProblem: start_unbestaetigt`,
    `wrongIdentity: false`. Bei WEISS ging ein Aufruf mit `Bearer synthetic-B` hinaus.
  - `dok01-r1r2-direktaktion.mjs`: `ok: false` mit `document.delete.identityChanged`. Das Dokument von B ist nicht
    gelöscht, es gibt keinen Löschauftrag. Bei WEISS: `ok: true`, Grabstein bei B, Löschauftrag B/member.
- **I1–I4:**
  - I1 und I3 sind unverändert.
  - I2 und I4 nutzen einen Token-Lieferanten mit undurchsichtigem Token. Sie senden jetzt nichts mehr; das ist
    gewollt (Abschnitt 3.4).
  - Nennt das Token ein Konto, verhalten sie sich wie bisher: genau ein Aufruf unter A, danach Halt.
- **Neue und angepasste Tests:** 44/44 (Start 9, Löschbindung 16, Synchronisationsseite 2, angepasste R1-Datei 17).
- **Angrenzend:** 80 Dateien, 1054/1054.
- **`tsc`:** ohne Befund.
- **Gegenproben:** 15/16 Mutationen erkannt. Die eine nicht erkannte (D3) ist eine zusätzliche Absicherung, die für
  sich allein nicht prüfbar ist; zusammen mit der Prüfung davor ist sie erkannt (D4).
- **Unverändert:** Gold-Artefakte und HEAD `ba778e8`. Beide Planer bleiben pausiert.

## 2. R1-WEISS-START — Ursache

1. Beim Start hält `captureSyncRunIdentity` Bereich und Anmeldung fest. Bisher galt der Start als zusammengehörig,
   wenn der Bereich stabil blieb und
   `!account || !session.readable || session.source === 'opaque_token' || session.userId === account.userId` galt.
2. Damit war ein Lauf auch ohne nachgewiesene Anmeldung „zusammengehörig“, und zwar in zwei Fällen:
   - die Sitzung war beim Start **nicht lesbar** (Lesefehler);
   - ein eigener Token-Lieferant gab ein Token ohne lesbares Konto.
3. Bei nicht lesbarer Startsitzung entfiel die Sitzungsprüfung vor jeder Anfrage (`sessionUserId` undefiniert). Ein
   geprüfter Zugang entstand nie.
4. Ohne geprüften Zugang gab der gebundene Netzaufruf die Anfrage ohne `Authorization` an das SDK weiter.
   `fetchWithAuth` las dann selbst die Sitzung, die gerade galt; in der WEISS-Probe war das die von B.

Beim Token ohne Konto prüfte der Lauf nur, dass dasselbe Token blieb (Fingerabdruck). Ein Konto war damit nie
nachgewiesen.

Eine fehlende Sitzung (lesbar, aber leer) hielt den Lauf schon vorher an (`start_inkonsistent`), allerdings ohne
sichtbaren Fehler.

## 3. R1-WEISS-START — Korrektur

### 3.1 Startregel (`src/services/sync/syncRunIdentityService.ts`)

- Im Kontobereich gilt der Start nur mit **nachweisbarer** Identität als zusammengehörig. Das heißt:
  - die Anmeldung ist lesbar;
  - sie stammt aus der Sitzung oder aus dem Konto (`sub`) eines Tokens;
  - sie nennt ein Konto, und zwar das Konto des Bereichs.
- Sonst hält der Lauf beim Start an, mit Grund (`startProblem`, neu in der Laufidentität):
  - `start_unbestaetigt` (neu): Sitzung nicht lesbar, keine Sitzung, Tokenquelle wirft, Tokenquelle liefert kein
    Token, Token ohne lesbares Konto;
  - `start_inkonsistent` (wie bisher): ein anderes Konto ist angemeldet, oder der Bereich wechselte während des Lesens.
- Außerhalb eines Kontobereichs gilt die bisherige Regel weiter. Das betrifft nur Testgerüste und Altpfade ohne
  Kontozuordnung.

### 3.2 Kein Rückfall auf die Sitzung des SDK

- Der gebundene Netzaufruf (`bindFetch`) sendet in einem Kontolauf nie ohne den geprüften Zugang.
  - Fehlt der Zugang, entsteht die Anfrage nicht. Der Lauf hält mit `sitzung_unlesbar` an.
  - So kann das SDK nie selbst eine Sitzung nachlesen und deren Zugang verwenden. Das gilt auch, wenn eine Prüfung
    zwar das richtige Konto las, aber keinen Zugang.
- Ersatzclients ohne eigenen Netzaufruf sind nicht betroffen (WEISS-Probe I1). Dort prüft die Sitzungsprüfung vor
  jeder Anfrage das Konto.
- `bindClientToSyncRun` reicht die Argumente von `rpc` und `from` jetzt unverändert weiter. Vorher waren es immer
  drei, auch `undefined`.
  - Nötig, weil der direkte Löschweg (Abschnitt 5) denselben gebundenen Client nutzt. Bestehende Tests prüfen dort
    die Aufrufargumente genau.
  - Fachlich ohne Wirkung.

### 3.3 Adapter, Koordinator, Synchronisationsseite

**Adapter** (`supabaseSyncAdapter.ts`):
- Ist der Wächter schon beim Start ausgelöst, kehrt `pushChanges` sofort zurück:
  - keine Anfrage;
  - Warteschlange, Zustand und Bestand unverändert;
  - `success: false`, `identityChanged: true`, Grund in `identityChangeReason` (neu, auch im Abruf-Ergebnis).
- Das gilt auch bei leerer Warteschlange: Es gibt dann keinen Scheinerfolg.

**Koordinator** (`syncCoordinator.ts`):
- Jeder Halt zählt als Fehler (`errorCount: 1`), nie als Erfolg. Der Bericht trägt dazu die Kennung
  `sync-identity-changed`; `isSyncIdentityHaltReport` (neu) erkennt ihn.
- Startproblem: Status `error`, `lastError` = „Synchronisation angehalten: Die Identität dieses Laufs ließ sich beim
  Start nicht bestätigen – nichts gesendet, nichts übernommen.“
- Wechsel mitten im Lauf: wie bisher `idle`, ohne Fehlermeldung beim jetzt aktiven Konto.
- Die Texte vermeiden Wörter, die der Planer als endgültig liest. Er stuft den Lauf als `retryable` ein und versucht
  es später erneut. Ein neuer Lauf mit bestätigter Identität setzt fort.

**Synchronisationsseite** (`SyncPage.tsx`):
- „Jetzt synchronisieren“ und „Erneut versuchen“ zeigen bei einem Halt den Hinweis „Synchronisation angehalten: Das
  Konto dieses Laufs ließ sich nicht bestätigen oder wurde gewechselt. Es wurde nichts gesendet; Ihre offenen
  Änderungen bleiben erhalten.“
- Sie zeigen weder „abgeschlossen“ noch „fehlgeschlagen“.

**Warteschlangen:** Offene Aufträge bleiben unverändert beim Ursprungsbereich. Bestand und Warteschlange anderer
Konten werden nicht berührt (T1: der gespeicherte Bestand von B bleibt Zeichen für Zeichen gleich).

### 3.4 Folge für I2 und I4 (gewollt)

**Was sich ändert**
- I2 und I4 sind die WEISS-Proben `dok01-n1n2-sdk.mjs` und `variante-nur-token.mjs`. Ihr eigener Token-Lieferant gibt
  in einem Kontobereich undurchsichtige Token aus (`synthetic-account-A`).
- Ein solches Token nennt kein Konto. Es weist also nicht nach, dass der Lauf A gehört. Nach der neuen Startregel hält
  der Lauf an, bevor er sendet.
- Die unveränderten Proben brechen deshalb nach 15 s mit „Kein RPC“ ab: Sie warten auf einen ersten Aufruf, der nicht
  mehr kommt.

**Was gleich bleibt**
- Die Sicherheitsaussage von I2 und I4 gilt weiter: nie ein Aufruf mit dem Zugang von B. Jetzt geht sogar der eine
  A-Aufruf nicht mehr hinaus.

**Belegt durch zwei Varianten je Probe.** Jede Ersetzung greift genau einmal und ist wörtlich protokolliert
(`weiss-proben/varianten/varianten-ersetzungen.json`).
- „beobachtet“: Die Probe wartet auf das Ende des Laufs statt auf einen Aufruf. Ergebnis: `calls: []`,
  `identityChangeReason: start_unbestaetigt`.
- „jwt“: Der Lieferant gibt ein Token mit Konto (`sub`). Ergebnis wie früher: genau ein Aufruf mit dem Zugang von A,
  dann Halt (I2 `bereich`, I4 `sitzung`), `wrongIdentity: false`.

**Für die App** ändert sich dadurch nichts: Sie nutzt keinen eigenen Token-Lieferanten, sondern die Sitzung des SDK.
Deren Token nennen das Konto. Damit gilt die WEISS-Vorgabe: keine Ausnahme vom Identitätsschutz für Produktionskonten
zugunsten unvollständiger Testclients. Grenze 1 aus `07` (Fingerabdruck undurchsichtiger Token) gilt nur noch
außerhalb eines Kontobereichs.

### 3.5 Token-Erneuerung desselben Kontos

- Unverändert: Jede Prüfung liest die Sitzung neu. Bleibt das Konto gleich, wird das Token aus genau dieser Prüfung
  angeheftet, also auch ein erneuertes.
- Belegt mit echtem SDK (T7): Die zweite Anfrage trägt das erneuerte Token. Der Lauf hält nicht an.

## 4. DOK-WEISS-DIREKT — Ursache

1. `deleteGeneratedInvoiceDocumentWithCloud` fragt vor dem Löschen den Server, ob das Dokument ein Zahlungsnachweis ist
   (`is_workspace_document_payment_proof`). Bei Rechnungsdokumenten setzt der Dienst zuerst den Cloud-Grabstein.
2. Nach dieser Rückfrage löschte der Dienst im **dann aktiven** Bestand:
   - `deleteDocument` arbeitet auf dem geladenen Bestand;
   - der Auftrag erhält beim Speichern die Herkunft des aktiven Bereichs.
3. Wechselte während der Rückfrage das Konto, traf die Löschung den Bestand von B. Der Dienst meldete Erfolg und reihte
   bei B einen Löschauftrag mit Herkunft B/member ein.

## 5. DOK-WEISS-DIREKT — Korrektur

Betroffene Dateien: `src/services/document/generatedInvoiceDocumentDeleteService.ts` und
`src/services/sync/syncRunIdentityService.ts` (`bindDirectOperation`, neu).

### 5.1 Bindung an den Aufruf

**Festgehalten vor der ersten asynchronen Grenze:**
- der Bereich, also Betrieb, Konto und Sicht als Speicherschlüssel;
- das Konto des Bereichs;
- der Cloud-Betrieb.

**Veraltete Oberfläche:** Handelt der Aufrufer für ein anderes Konto als das des Bereichs, gibt es keinen Vorgang. Der
Dienst antwortet sofort mit `document.delete.identityChanged`, ohne Rückfrage an den Server.

**`bindDirectOperation`** bindet den Vorgang an den festgehaltenen Bereich. Drei Fälle:
- **Anmeldung nachweisbar und passend** (dieselbe Regel wie 3.1):
  - jede Anfrage geht über einen an den Vorgang gebundenen Client;
  - unmittelbar vor jeder Anfrage wird geprüft, und der geprüfte Zugang wird angeheftet;
  - kein Rückfall auf die Sitzung des SDK (wie 3.2).
- **Kontobereich ohne nachweisbare Anmeldung:**
  - nur lesende Rückfragen;
  - lokales Löschen nur im eigenen Bereich;
  - jede neu erscheinende Anmeldung gilt als Wechsel.
- **Anderes Konto angemeldet, oder der Bereich hat schon gewechselt:** kein Vorgang.

Alle Rückfragen gehen an den Cloud-Betrieb des Aufrufs.

### 5.2 Prüfung nach jeder Rückfrage und vor jeder Änderung

- **Nach jeder Rückfrage:** nach der Nachweisrückfrage, nach dem Grabstein und nach dem Nachweis-Abruf.
  - Geprüft wird: Sind Bereich und Anmeldung noch die des Aufrufs?
  - Sonst bricht der Vorgang ab mit `document.delete.identityChanged`: „Löschen abgebrochen: Inzwischen ist ein anderes
    Konto oder ein anderer Betrieb aktiv. Es wurde nichts gelöscht.“
- **Unmittelbar vor dem lokalen Löschen, ohne weiteres Warten:** Ist noch derselbe Bereich aktiv?
- **Cloud-Grabstein im Kontobereich:** nur mit bestätigter Anmeldung. Sonst `document.delete.identityUnconfirmed`:
  „Löschen abgebrochen: Ihre Anmeldung ließ sich nicht bestätigen. Es wurde nichts gelöscht. Bitte melden Sie sich
  erneut an.“

### 5.3 Unverändert

- Diese Prüfungen laufen in derselben Reihenfolge und mit derselben Wirkung wie bisher:
  - Rolle;
  - festgeschriebene Rechnung;
  - Aufbewahrung: Frist und Prüfbestätigung, weiterhin vor jeder Rückfrage;
  - Zahlungsnachweis in der Cloud.
- Andere direkte Finanzaktionen sind nicht angefasst.

## 6. Geänderte Dateien

Diffs gegen den Stand vor dieser Runde: `belege/nacharbeit-r2/diffs/`.

| Datei | Art | Inhalt |
|---|---|---|
| `src/services/sync/syncRunIdentityService.ts` | geändert | Startregel, `startProblem`, `isStartIdentityProblem`, kein Rückfall, Argumente unverändert, `bindDirectOperation` |
| `src/services/sync/supabaseSyncAdapter.ts` | geändert | Frühhalt beim Start, Grund auch im Abruf-Ergebnis |
| `src/services/sync/syncAdapter.ts` | geändert | Feld `identityChangeReason` im Abruf-Ergebnis |
| `src/services/sync/syncCoordinator.ts` | geändert | Halt als Fehler, Grund, Fehlerzustand bei Startproblem, `isSyncIdentityHaltReport` |
| `src/pages/SyncPage.tsx` | geändert | Hinweis „angehalten“ bei Synchronisieren und Wiederholen |
| `src/services/document/generatedInvoiceDocumentDeleteService.ts` | geändert | Bindung an den Aufruf, Prüfungen, zwei neue Fehlerschlüssel |
| `src/i18n/locales/de/vorgangsbindung.ts` | neu | drei Texte |
| `src/i18n/locales/de/index.ts` | geändert | Texte eingebunden |
| `src/services/sync/sendekontoR1Dokumente01.test.ts` | Test geändert | S12 nur noch JWT; S12b neu; S9a/S9b: Halt zählt als Fehler |
| `src/services/sync/startidentitaetR1Dokumente01.test.ts` | Test neu | T1–T8 |
| `src/services/document/loeschvorgangBindungDokumente01.test.ts` | Test neu | L1–L11 |
| `src/pages/syncHaltMeldungR1Dokumente01.test.tsx` | Test neu | U1–U2 |

**Ausgangsstand belegt** (`diffs/diffs-uebersicht.json`):
- Der Stand vor dieser Runde ist aus den Bearbeitungsschritten der Runde rückwärts hergestellt. Vorwärts angewendet
  ergeben dieselben Schritte bei allen zwölf Dateien genau den heutigen Inhalt.
- Bei den sieben Dateien aus der R1/R2-Nacharbeit stimmt der hergestellte Stand bytegenau mit
  `nacharbeit-r/pruefsummen.txt` überein. Das ist der Stand, den WEISS geprüft hat.
- Unabhängig nachprüfbar, ohne das Sitzungsprotokoll: `werkzeuge/vorher-pruefen.cjs` wendet jeden Diff rückwärts auf
  die heutige Datei an (`patch -R`). Ergebnis (`diffs/vorher-probe.json`): bei allen zwölf Dateien `ok`. Bei den
  sieben R-Dateien ist der Stand gleich der R-Prüfsumme; neue Dateien werden rückwärts leer.
- Alle 45 übrigen Dateien aus den R- und N-Prüfsummenlisten sind unverändert.
- Zeilenenden sind erhalten: LF bleibt LF; `syncCoordinator.ts` und `syncAdapter.ts` bleiben CRLF.

## 7. Auswirkung auf vorhandene Bestände

**Läufe ohne nachweisbare Anmeldung**
- Betroffen ist ein Lauf im Kontobereich ohne nachweisbare Anmeldung, zum Beispiel:
  - die Sitzung ist abgelaufen und lässt sich offline nicht erneuern;
  - die Sitzungsablage ist beschädigt.
- Ein solcher Lauf hält jetzt mit sichtbarem Fehler an, statt zu senden. Nach erneuter Anmeldung setzt der nächste
  Lauf fort.
- Bei fehlender Sitzung hielt er schon vorher an, nur ohne Fehlermeldung.

**Löschen ohne bestätigte Anmeldung**
- Fremddokumente löscht der Dienst lokal wie bisher. Der Auftrag trägt die Herkunft des Bereichs und geht nur unter
  dessen bestätigter Identität hinaus.
- Rechnungsdokumente löscht er erst nach erneuter Anmeldung.

**Keine Umstellung:** Bestände und Warteschlangen werden nicht umgestellt, es gibt keine Migration.

## 8. Prüfung

### 8.1 WEISS-Reproduktionen

- Bytegleiche Kopien liefen im Scratchpad, damit im WEISS-Ordner nichts entsteht. Die Prüfsummen von Original und Kopie
  liegen in `weiss-proben/`.
- Die Proben nutzen den Produktcode des Arbeitsbaums.

| Probe | WEISS (21.10.) | Jetzt |
|---|---|---|
| `WEISS-DOK01-R1R2-2026-10-20/unlesbare-startsitzung.mjs` | `sessionReads: 2`, ein Aufruf mit `Bearer synthetic-B`, `completed: [out-weiss-startfehler]`, `consistent: true`, `wrongIdentity: true` | `sessionReads: 1`, `calls: []`, `completed: []`, `failed: []`, `identityChanged: true`, `consistent: false`, `startProblem: start_unbestaetigt`, `wrongIdentity: false` |
| `dok01-r1r2-direktaktion.mjs` | `ok: true`; Dokument von B `deleted: true`; Löschauftrag mit Herkunft B/member | `ok: false`, `document.delete.identityChanged`; nur die lesende Nachweisrückfrage; Dokument von B `deleted: false`; Warteschlange leer; Gegenprobe als B: `document.delete.forbidden` |

### 8.2 Ursprüngliche Gegenproben I1–I4

| Probe | Bisher erwartet | Jetzt |
|---|---|---|
| I1 `dok01-n1n2-sendekonto.mjs` | ein Aufruf unter A, `completed: [out-0]`, `wrongIdentity: false` | unverändert |
| I2 `dok01-n1n2-sdk.mjs` (Token-Lieferant, undurchsichtiges Token) | ein Aufruf mit `Bearer synthetic-account-A` | kein Aufruf; die Probe endet nach 15 s mit „Kein RPC“ (Abschnitt 3.4) |
| I2 „beobachtet“ | — | `calls: []`, `completed: []`, `identityChangeReason: start_unbestaetigt`, `wrongIdentity: false` |
| I2 „jwt“ (Token mit Konto) | — | ein Aufruf mit dem Token von A, `completed: [out-0]`, danach Halt `bereich`, `wrongIdentity: false` |
| I3 `dok01-n1n2-sendekonto-und-altbestand.mjs` | erster Teil wie I1; Altwarteschlange `adopted_legacy`, `pendingAfterAdoption: 2`, `calls: []` | unverändert |
| I3 „beobachtet“ | — | Start des Altbestandslaufs bestätigt (`startProblem: null`, kein Identitätswechsel): `calls: []` kommt weiter von der R2-Sperre, nicht vom neuen Halt |
| I4 `variante-nur-token.mjs` (WEISS-Fassung: nur das Token wechselt) | ein Aufruf mit `Bearer synthetic-account-A` | wie I2: kein Aufruf, „Kein RPC“ |
| I4 „beobachtet“ | — | `calls: []`, `identityChangeReason: start_unbestaetigt` |
| I4 „jwt“ | — | ein Aufruf mit dem Token von A, danach Halt `sitzung`, `wrongIdentity: false` |

### 8.3 Neue und angepasste Tests (44/44)

`src/services/sync/startidentitaetR1Dokumente01.test.ts` (9, echtes SDK, nur Netz und Sitzungsablage ersetzt):

- T1: WEISS-Reproduktion. Die Sitzung ist beim Start nicht lesbar, danach ist B angemeldet.
  - keine Anfrage, eine einzige Sitzungslesung;
  - Grund `start_unbestaetigt`, `consistent: false`;
  - der A-Auftrag bleibt offen, der gespeicherte Bestand von B ist zeichengleich.
- T2: keine Sitzung beim Start. T2b: dasselbe bei leerer Warteschlange; auch dann kein Erfolg.
- T3: die Tokenquelle wirft. T4: die Tokenquelle liefert kein Token. In beiden Fällen keine Anfrage.
- T5: Koordinator.
  - kein Erfolg, Haltbericht, `errorCount: 1`, Status `error` mit Meldung;
  - kein Abruf, nichts gespeichert;
  - `classifySyncRun` stuft den Lauf als `retryable` ein.
- T6: Ist die Anmeldung von A wieder lesbar, sendet erst der neue Lauf, und zwar genau die A-Aufträge mit dem Zugang
  von A.
- T7: Token-Erneuerung desselben Kontos mitten im Lauf. Kein Halt; die zweite Anfrage trägt das erneuerte Token.
- T8: Kein Rückfall. Liest die Prüfung zwar A, aber keinen Zugang, entsteht keine Anfrage.
  - das SDK liest die Sitzung nicht selbst nach (`sitzung_unlesbar`);
  - Gegenprobe direkt am SDK: Es läse nach und sendete mit dem Zugang von B.

`src/services/document/loeschvorgangBindungDokumente01.test.ts` (16; Kontowechsel über den echten Ladeweg der App
`switchToWorkspaceScope`, Abmeldung über `isolateBusinessStateOnLogout`):

- L1: WEISS-Reproduktion mit echtem SDK ohne Sitzung.
  - kein Erfolg; das Dokument von B bleibt, im Speicher wie im gespeicherten Bestand;
  - kein Auftrag bei A oder B;
  - die Gegenprobe als B ergibt `forbidden`.
- L1b: Ohne Sitzung beim Aufruf meldet sich B im zweiten Tab an; der Bereich bleibt A. Ergebnis: Abbruch.
- L2: bestätigte Anmeldung A, echter Kontowechsel zu B während der Rückfrage. Bei B entsteht nichts.
- L3: Nur die Sitzung wechselt, der Bereich bleibt. Abbruch; A behält das Dokument.
- L4: A ohne Wechsel, mit und ohne bestätigte Anmeldung. Gelöscht, Löschauftrag mit Herkunft A; B bleibt unberührt.
- L5: Abmeldung während der Rückfrage. Abbruch; nach erneuter Anmeldung von A ist das Dokument unverändert da, ohne
  Auftrag.
- L6a: Rückkehr zu A nach dem Abbruch. Der Bestand ist unverändert, eine neue Löschung gelingt unter A.
- L6b: A → B → A innerhalb der Rückfrage. Die Löschung trifft nur den Bestand von A (Grenze 2).
- L7: Rechnungsdokument, echtes SDK.
  - Rückfrage und Grabstein tragen den geprüften Zugang von A und gehen an den Betrieb des Aufrufs.
- L7b: B meldet sich genau beim Senden des Grabsteins an.
  - die Anfrage trägt trotzdem den geprüften Zugang von A;
  - danach bricht der Vorgang ab, ohne lokales Löschen (Grenze 1).
- L8: ohne bestätigte Anmeldung im Kontobereich. Kein Grabstein; Hinweis `identityUnconfirmed`; nichts gelöscht.
- L9: Wechsel während des Grabsteins. Bei B kein lokales Löschen und kein Auftrag; kein Erfolg (Grenze 1).
- L10: Der Handelnde ist nicht das Konto des Bereichs. Kein Vorgang, keine Rückfrage.
- L11a: Laufende Aufbewahrung blockiert wie bisher, ohne jede Rückfrage. L11b: Ein Zahlungsnachweis in der Cloud
  blockiert wie bisher.

`src/pages/syncHaltMeldungR1Dokumente01.test.tsx` (2):

- U1: „Jetzt synchronisieren“ mit nicht lesbarer Startsitzung; echter Koordinator, Adapter und SDK.
  - Hinweis „angehalten“, weder „abgeschlossen“ noch „fehlgeschlagen“;
  - keine Anfrage.
- U2: „Erneut versuchen“ mit Haltbericht. Hinweis „angehalten“, nicht „abgeschlossen“.

`src/services/sync/sendekontoR1Dokumente01.test.ts` (17, angepasst):

- S12 prüft den Token-Lieferanten nur noch mit JWT, also mit Konto.
- S12b (neu): undurchsichtiges Token. Halt beim Start, keine Anfrage, Warteschlange unverändert.
- S9a/S9b: Ein Halt zählt jetzt als Fehler (`errorCount: 1`, Haltbericht). Status und Fehlermeldung des jetzt aktiven
  Kontos bleiben wie bisher (`idle`, keine Meldung).
- Alle übrigen Zusicherungen sind unverändert.

### 8.4 Angrenzende Tests (80 Dateien, 1054/1054)

**Auswahl:** jede Testdatei, die mindestens eines davon tut:
- ein geändertes Modul direkt importiert (Laufidentität, Adapter, Koordinator, Synchronisationsseite, Löschdienst);
- `identityChanged` prüft;
- den Löschweg bedient (Dokumentdetailseite, `document.delete.*`).

**Darunter:**
- R2 (`altwarteschlangeR2Dokumente01`, `syncHeldOrdersR2Dokumente01`);
- die Kontotrennung (`kontoTrennungGateDokumente01`);
- die Löschtests (`archivRolleGls01`, `documentRetentionDeleteDokumente01`, `generatedInvoiceDocumentCloudWiring05c1b`,
  `paymentProofDeleteGuard01`, `dokumentDetailRolleGls01`, `dokumentDetailAufbewahrungDokumente01`,
  `documentDeleteGuard01`, `documentFinalDelete01i`);
- der Sync-Kern (`syncCoordinator`, `syncPushOnly01afix1`, `syncSaveDuringRun01a`, `syncMultiTabGuard01a`,
  `syncRetryRecovery01b` …);
- die Finanzverträge, die einen Lauf berühren (`financeSyncBlocker01b`, `invoiceCloudPullStore01`,
  `accountingCloudPull01c`, `restnacharbeitAusgabenFc01a`, `systemischeNacharbeit21` …);
- `backfillSperreGls01` (Vertrag der Einreih-Aufrufstellen).

**Ergebnis:** drei Portionen (269 + 576 + 209), alle grün. Keine Datei musste einzeln wiederholt werden.

Liste: `tests/ziele-angrenzend.txt`. Läufer wie in der R-Nacharbeit (sichere Konfiguration, 2 Worker).

### 8.5 Gegenproben (Mutationen, nur in der isolierten Kopie)

**Ablauf je Mutation:**
1. eine oder mehrere Schutzstellen entfernen;
2. die vier Nachweisdateien laufen lassen;
3. alles wiederherstellen.

**Vorbedingungen:**
- Die Kopie war vorher per Prüfsumme gleich dem Arbeitsbaum (12/12 Dateien).
- Der unmutierte Grundlauf in der Kopie war grün: 44/44.

| Nr. | Entfernte Schutzstelle | Erkannt durch |
|---|---|---|
| S1 | Startregel: nicht nachweisbare Anmeldung gilt als zusammengehörig | T1–T6, T2b, S12b, L8 (9 rot) |
| S2 | Netzaufruf ohne geprüften Zugang fällt auf die SDK-Sitzung zurück | T8 |
| S3 | S1 und S2 zusammen (Stand vor der Korrektur) | 11 rot, darunter T1 (wieder eine Anfrage), T8, U1, L8 |
| S4 | Frühhalt im Adapter | T2b |
| S5 | Halt zählt nicht als Fehler, kein Haltbericht | T5, U1, S9a, S9b |
| S6 | Startproblem ohne Fehlerzustand des Kontos | T5 |
| S7 | Seite: Halt nach „Jetzt synchronisieren“ wie ein gewöhnlicher Ausgang | U1 |
| S8 | Seite: Halt nach „Erneut versuchen“ wie ein gewöhnlicher Ausgang | U2 |
| D1 | veraltete Oberfläche (Handelnder ≠ Konto des Bereichs) nicht erkannt | L10 |
| D2 | keine Prüfung nach der Nachweisrückfrage | L1b, L3, L7b |
| D3 | keine Bereichsprüfung unmittelbar vor dem lokalen Löschen | allein nicht erkannt (unten) |
| D4 | D2 und D3 zusammen (Stand vor der Korrektur im Nachweisweg) | L1, L1b, L2, L3, L5, L6a, L7b |
| D5 | Cloud-Grabstein ohne bestätigte Anmeldung | L8 |
| D6 | keine Prüfung nach dem Grabstein | L7b |
| D7 | direkter Vorgang ungebunden: Das SDK nimmt beim Senden die Sitzung, die gerade gilt | L7b (der Grabstein trüge den Zugang von B) |
| D8 | unbestätigte Bindung übersieht eine neue Anmeldung | L1b |

**Warum D3 allein unentdeckt bleibt:**
- Jeder Weg zum lokalen Löschen führt über die Prüfung nach der vorangehenden Rückfrage. Sie erkennt schon jeden
  Wechsel, der während der Rückfrage geschieht.
- Die Prüfung unmittelbar vor dem Löschen schließt nur die Lücke zwischen dieser Prüfung und dem Löschen, ohne Warten
  dazwischen. Diese Lücke lässt sich in einem Test nicht gezielt treffen.
- Zusammen mit D2 entfernt (D4) ist sie erkannt.

Danach war die Kopie per Prüfsumme wieder gleich dem Arbeitsbaum (12/12).

### 8.6 Weitere Prüfungen

- `tsc` ohne Befund (`tests/tsc-ende.log`).
- Gold-Berichte und Snapshot unverändert (`6e4b1c91…`, `2db37b51…`, `6cf194f4…`). `InvoiceDocumentView.test.tsx` lief
  nicht. `GOLD_WRITE_REPORT` war nicht gesetzt.
- Planer: pg_cron 1 `officetakt-mailbox-auto-sync` und 2 `officetakt-mailbox-oauth-state-purge` sind `active = false`
  (nur lesend abgefragt).
- Die Prüf-App 5232 liefert den neuen Stand aus. Per GET geprüft für die sieben geänderten Produktmodule mit
  Laufzeitcode, auch für den Frühhalt im Adapter; `syncAdapter.ts` ändert nur einen Typ. Die App lief durchgehend
  weiter.

## 9. FINANZ-CORE-01A

- **Fachlich unverändert:** keine Finanzregel, kein Finanzdienst, kein Betrag, keine Abweisungs- oder Konfliktlogik
  geändert.
- **Gemeinsame Sync-Module** (Laufidentität, Adapter, Koordinator) nur sicherheitsbegrenzt:
  - Startregel;
  - kein Rückfall;
  - Halt als Fehler mit Grund;
  - Argumente unverändert weiterreichen.
- **Wirkung auf Finanzzweige:** Sie senden unverändert über den gebundenen Client. Neu ist nur: ohne bestätigte
  Startidentität gar nicht.
- **Belege:** Die Finanzverträge in der angrenzenden Liste sind grün.
- **Unverändert:** keine neue `enqueueSyncOutbox(`-Aufrufstelle; `ba778e8` ist unverändert.

## 10. Grenzen

1. **Grabstein vor dem Abbruch** (L7b, L9).
   - Hat der Server den Cloud-Grabstein von A schon angenommen, bevor der Wechsel erkannt wird, bleibt er bestehen.
   - Es war die geprüfte Aktion von A mit dem Zugang von A.
   - Die lokale Kopie von A verschwindet erst mit dem nächsten Abgleich von A; bis dahin zeigt A das Dokument noch.
   - Erfolg wird nicht gemeldet; im Bestand von B ändert sich nichts.
2. **A → B → A innerhalb einer Rückfrage** (L6b).
   - Gilt beim Weitergehen wieder die Identität des Aufrufs (Bereich A, angemeldet A), läuft der Vorgang weiter.
   - Er trifft nur den Bestand von A.
3. **Außerhalb eines Kontobereichs** (Gastbereich, Testgerüste) bleibt die bisherige, nachsichtige Startregel.
   Betriebsbestände der App sind seit N1 immer Kontobereiche.
4. **Ohne bestätigte Anmeldung im eigenen Kontobereich:**
   - die Nachweisrückfrage geht lesend über den Client des SDK;
   - das lokale Löschen eines Fremddokuments bleibt möglich (Abschnitt 7).
5. **Zusätzliche Absicherungen, für sich allein nicht testbar:**
   - die Bereichsprüfung unmittelbar vor dem lokalen Löschen und der festgehaltene Cloud-Betrieb decken die Lücke
     zwischen zwei Mikroschritten ab;
   - jeder sinnvolle Testfall endet schon an der Prüfung nach der Rückfrage;
   - siehe D3 und D4 in 8.5.
6. **Andere Direktaktionen außerhalb eines Synchronisationslaufs** laufen weiterhin sofort mit der aktuellen Sitzung
   (etwa Rechnung festschreiben, Auftrag anlegen). Nicht beauftragt; „keine breite Umgestaltung“.
7. **Kein neuer Browserdurchlauf.**
   - Die Seite ist mit echtem Koordinator, Adapter und SDK im Test geprüft (U1).
   - Ein Browser kann den Lesefehler beim Start und das Anhalten einer einzelnen Rückfrage nicht zeitgenau erzeugen.
8. **Ursprüngliche Proben I2/I4:** Sie enden unverändert mit „Kein RPC“, weil sie 15 s auf einen Aufruf warten.
   Bewertet über die Varianten in 8.2.

## 11. Einhaltung

- **Nichts nach außen:** kein Commit, Push oder Deployment, keine Remote-Migration, kein Remote-Zugriff, keine
  produktiven Schreibzugriffe.
- **Server und lokale Datenbank** unverändert; Planer nur lesend abgefragt.
- **Gold-Artefakte** unverändert. Alle Läufe nur mit `vitest.safe.config.ts` und 2 Workern.
- **FINANZ-CORE-01A** fachlich unverändert; HEAD `ba778e8` unverändert.
- **WEISS-Dateien** nur gelesen und kopiert:
  - die Proben liefen als bytegleiche Kopien im Scratchpad;
  - in den WEISS-Ordner wurde nichts geschrieben;
  - versiegelte Ordner sind nicht berührt.
- **Zugangsdateien** nicht gelesen. Keine echten Konten, keine Kennwörter; nur synthetische Token in den Tests.
- **Mutationen** nur in der isolierten Kopie. Danach per Prüfsumme wieder gleich dem Arbeitsbaum.
- **Dienste:** die anderen Dienste (5203/5204/5213/5220/5222–5229, 54396/54397/54399) sind unberührt. Die Prüf-App
  5232 läuft weiter.

## 12. Belegpfade (`belege/nacharbeit-r2/`)

- `weiss-proben/`:
  - `proben/`: die sechs Proben als bytegleiche Kopien; Prüfsummen in `pruefsummen-original-weiss.txt` und
    `pruefsummen-kopien.txt`;
  - `varianten/`: Beobachtungs- und JWT-Varianten, Erzeuger `varianten.mjs` und `variante-i3.mjs`, Ersetzungen
    wörtlich;
  - `ausgaben/`: Ergebnisse und Konsolenausgaben aller Proben und Varianten.
- `tests/`:
  - Listen `ziele-neu.txt` (4) und `ziele-angrenzend.txt` (80);
  - Läufe `lauf-neu2/` (Endstand 44/44) und `lauf-angrenzend/`, je Portion ein JSON-Bericht;
  - `lauf-neu/` ist der Zwischenlauf vor T2b, L1b, L7b und U1/U2;
  - `tsc-ende.log`.
- `gegenproben/`: `grundlauf-unmutiert.json`, `mutationen.log`, Berichte je Mutation in `einzeln/`.
- `diffs/`:
  - je Datei der Diff gegen den Stand vor dieser Runde;
  - `diffs-uebersicht.json` mit den Prüfsummen vorher und jetzt;
  - `vorher-probe.json` (Rückwärtsprobe).
- `werkzeuge/`:
  - `portionen.cjs` (Läufer);
  - `mutationen.cjs` (verweigert jeden Pfad außer der isolierten Kopie);
  - `vorher-pruefen.cjs`: unabhängige Rückwärtsprobe der Diffs;
  - `runde-auslesen.cjs`, `rekonstruieren.cjs`, `diffkoepfe.cjs`: Herstellung von Ausgangsstand und Diffs aus den
    Bearbeitungsschritten der Runde. Das Sitzungsprotokoll selbst liegt nicht bei;
  - `pruefsummen.cjs`.
- `pruefsummen.txt`: SHA256 der geänderten und neuen Dateien zum Abgabestand.

STOPP – BEREIT FÜR WEISS.
