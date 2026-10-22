# DOKUMENTE-01 — Abschließende Sicherheitsnacharbeit N1 und N2

Stand 20.10.2026 · SCHWARZ · nur lokal, nichts remote.
Grundlage: Auftrag „Abschließende Sicherheitsnacharbeit N1 und N2“. W1, W2 und die Vorschau-Nacharbeit sind von WEISS
bestätigt und hier nicht erneut aufgerollt. Belege: `belege/nacharbeit-n/` (Abschnitt 10).

## 1. Ergebnis

| Befund | Ergebnis | Art |
|---|---|---|
| N1 (P1) Kontotrennung: fremde Dokumente und Aufträge nach Kontowechsel im selben Browser | behoben | nur Client; Serverrechte und Serverobjekte unverändert |
| N2 (P2) Benutzermenü samt „Abmelden“ unter der Karte „Weiterarbeiten“ | behoben | eine CSS-Zeile |

Prüfung (Abschnitte 5 und 6):

- neue Tests 28/28;
- gezielte und angrenzende Regression ohne neuen Befund;
- `tsc` ohne Befund;
- Gegenproben 18/18 und N2 erkannt;
- echter Browser (Edge, Prüf-App 5232): Kontowechsel, Rollenwechsel und Abmeldemenü 47/47 Prüfpunkte, Vorschau
  über den Kontowechsel 8/8.

Beim Prüfen kamen zwei weitere Wege zu fremden Inhalten hinzu, beide jetzt geschlossen:

- ein Abgleich, der beim Wechsel noch lief (Abschnitt 3.3);
- „Zurück“ in den Browserverlauf bzw. Seiten-Cache (Abschnitt 3.4).

## 2. N1 — Ursache

1. Der lokale Bestand lag je Betrieb unter **einem** Schlüssel (`officepilot-state:workspace:<betrieb>`), für alle
   Konten des Geräts gemeinsam. Die Angabe `officetakt:workspace:<id>` in `05-nacharbeit-weiss.md` war falsch und ist
   dort korrigiert.
2. Die Abmeldung leerte nur den Arbeitsspeicher. Die nächste Anmeldung im selben Betrieb lud den Bestand des
   Vorgängers: Archivdokumente, Dateireferenzen, Vorschau-Bindungen, Warteschlange und Papierregister.
3. Der Cloud-Bootstrap wechselte den Speicherbereich mit der Kennung des **Inhabers**, nicht des angemeldeten Kontos.
   Dessen Rolle spielte für den lokalen Bestand keine Rolle.
4. Folge (WEISS-Befund): Das Mitglied sah die Inhaberdokumente, und der Papierregister-Abgleich verglich die
   Inhaber-Einträge mit dem rollengefilterten Abzug des Mitglieds. Er reihte fünf davon ein; das sind die fünf
   endgültigen Abweisungen aus `05`, Abschnitt 5.

## 3. N1 — Korrektur

### 3.1 Speicherbereich je Konto und Sicht

- **Zustand:** `officepilot-state:workspace:<betrieb>:account:<konto>:<full|member>`.
- **Dateibytes (IndexedDB):** Bereich `workspace:<betrieb>:account:<konto>:<full|member>`.
- **Sicht** laut Server:
  - `full` für aktiven Inhaber oder Admin (entspricht `can_write_workspace`);
  - `member` für aktives Mitglied;
  - sonst kein Zugang: entfernt, eingeladen, fehlende oder doppelte Mitgliedszeile.
- **Woher das Konto kommt:** aus der Mitgliederliste des Abzugs (`pull_workspace_sync_state`) für das angemeldete
  Konto. Nennt der Abzug es nicht, gilt die Antwort der Provisionierung aus demselben Lauf. Nie aus dem lokalen
  Bestand.
- **Sperren statt Raten:** Ist das Konto bekannt, aber ohne aktive Mitgliedschaft, endet der Bootstrap mit `auth`.
  Es gibt dann keinen Bereichswechsel und keinen Versand; die App zeigt die Wiederherstellungssperre.
- **Aufrufer ohne Kontoangabe** (Rechnungsvorprüfung, Entwurfssicherung, vorbereitete Freigabe) erben das aktive
  Konto, wenn derselbe Betrieb aktiv ist. Kein FINANZ-CORE-01A-Code ist geändert.
- **Ohne ermittelbare Sitzung** (nur Testgerüste) bleibt es beim bisherigen Betriebsschlüssel.

### 3.2 Bestehende Bestände: übernehmen, liegen lassen, nie pauschal löschen

| Lage beim Laden | Verhalten |
|---|---|
| Kontobereich vorhanden | wird geladen, sonst nichts |
| gemeinsamer Altbestand, Konto mit voller Sicht | einmal in den Kontobereich verschoben: schreiben, zurücklesen, erst dann Quelle entfernen. Scheitert das Schreiben, bleibt alles, wie es war |
| gemeinsamer Altbestand, Mitgliedssicht | bleibt unberührt liegen. Das Mitglied beginnt mit eigenem Bereich und bekommt seine Daten vom Server |
| globaler Altbestand `officepilot-state` (aus der Zeit vor den Betrieben) | Mitglied: wird nicht angefasst, auch keine Quarantäne. Volle Sicht: wie bisher |
| Nutzerbereich `officepilot-state:user:<konto>` | Inhaber: wie bisher. Admin und Mitglied: nur die Serveridentität aus der Provisionierung. Trägt der Nutzerbereich Geschäftsdaten (z. B. von einem eigenen früheren Betrieb), bleibt er unverändert liegen |
| Aufstieg Mitglied → Admin ohne Admin-Bereich | der eigene Mitgliedsbereich wird übernommen (verschoben) |
| Rollenentzug Admin → Mitglied | eigener, neuer Mitgliedsbereich. Der Admin-Bereich ruht unverändert und kehrt mit der Rolle zurück, samt ungesendeter Aufträge |
| Mitgliedschaft entfernt | kein Zugang mehr. Wie seit 20261124 legt der Server beim nächsten Laden einen eigenen Betrieb an (G6). Melden Provisionierung und Abzug Widersprüchliches, sperrt die App (G4). Alle Bestände ruhen unverändert |

### 3.3 Dateien, Vorschauen, Warteschlange, Papierregister

- **Dateien:** Bytes liegen je Kontobereich. Ein Rückfall ist nur auf zwei Bereiche erlaubt:
  - den Altbereich desselben Betriebs;
  - bei voller Sicht den eigenen Mitgliedsbereich.

  Beides gilt nur für Dateien, die der eigene Bestand referenziert. Fremde Kontobereiche sind nie Quelle.
- **Vorschauen:** Die Vorschau-Bindungen liegen im Kontobestand. Eine Vorschauerzeugung, die beim Wechsel noch
  läuft, prüft nach dem Speichern, ob ihr Dokument noch im Bestand ist. Ist es das nicht, gibt sie die angelegte
  Datei wieder frei und bricht ab. Zwischen dieser Prüfung und dem Speichern liegt kein `await` (bestehender Code,
  unverändert).
- **Warteschlange:** Sie ist Teil des Kontobestands.
  - Fremde Aufträge werden nicht geladen und deshalb auch nicht gesendet.
  - Ungesendete Aufträge eines Kontos ruhen in seinem Bereich. Sie laufen bei seiner nächsten Anmeldung weiter,
    unter seinem eigenen Konto.
- **Papierregister-Abgleich:** Im Bereich des Mitglieds liegen nur Mitgliedsdaten. Es gibt also keine fremden
  Einträge, die er einreihen könnte.
- **Laufende Synchronisation beim Wechsel:** Ein Lauf merkt sich beim Start seinen Bereich (Betrieb, Konto, Sicht;
  `captureSyncRunBase`). Endet er erst nach Abmeldung oder Kontowechsel, verwirft `applySyncPullCandidateSafely`
  sein Ergebnis:
  - kein Anwenden, kein Speichern;
  - im neuen Konto keine Fehlermeldung, nur ein Hinweis im Laufbericht;
  - der gespeicherte Bestand des früheren Kontos bleibt, wie er war.

  Ohne diesen Schutz hätte ein noch laufender Abgleich des Inhabers Bestand und Warteschlange in den Bereich des
  Mitglieds geschrieben (G7). Die Datei gehört nicht zu FINANZ-CORE-01A. Die Finanzvorprüfung prüft den
  Bereichsschlüssel ohnehin selbst (`scope_mismatch`).

### 3.4 Kontowechsel ohne Abmelden, Browserverlauf, Seiten-Cache, Hinweise, Notfall-Inventar

- **Kontowechsel ohne Abmelden:** Wechselt das Konto ohne abgemeldeten Zwischenstand (etwa durch eine Anmeldung in
  einem anderen Tab), verwirft das Gate wie beim Abmelden alles Sitzungsgebundene des Vorgängers:
  - die Firmensitzung des Assistenten mit dem zuletzt geöffneten Dokument;
  - den Arbeitsstand für „Weiterarbeiten“;
  - die Bootstrap-Bindung.
- **Inhalte im Navigationszustand:** Briefvorbelegung aus einer Dokumentantwort und Antwortentwurf für die
  Kommunikation reisen im Navigationszustand. Dieser bleibt im Verlauf des Tabs stehen und übersteht Abmelden und
  Anmelden; mit „Zurück“ öffnete ein anderes Konto den Briefeditor mit dem Text aus einem fremden Dokument.
  - Beide Übergaben tragen jetzt den Speicherbereich, in dem sie entstanden (`stampNavigationStateWithActiveScope`).
  - Briefeditor und Kommunikation übernehmen sie nur dort (`readLetterDraftPrefillFromLocationState`,
    `readDocumentReplyDraftHandoffFromLocationState`).
  - Ein Zustand ohne Stempel (Verlauf aus der Zeit davor) wird nicht übernommen.
  - Erzeugt werden sie an drei Stellen: Dokumentassistent, Antwortbedarf und Eingang.
- **Rückkehr aus dem Seiten-Cache:** Beim Zurücknavigieren kann der Browser eine frühere Seite samt Arbeitsspeicher
  wiederherstellen (Back-Forward-Cache, vor allem Safari), also mit dem Bestand des Kontos, das dort angemeldet war.
  Das Gate prüft bei `pageshow` aus dem Cache die gespeicherte Sitzung (`pageCacheAccountGuard.ts`):
  - Gehört sie inzwischen einem anderen Konto oder keinem, lädt die Seite neu.
  - Bei gleichem Konto geschieht nichts; die bisherige Wiederaufnahme bleibt.
- **Hinweise:** Die Auswahl der Startseiten-Hinweise („erledigt“, „später“) gilt je Konto.
- **Notfall-Inventar:** Es erkennt die Kontobereiche.

### 3.5 Server

Unverändert: keine Migration und kein geändertes Serverobjekt. Alle Prüfungen laufen gegen die bestehenden Rechte.

## 4. N2 — Ursache und Korrektur

`.app-shell` ist ein Flex-Container (`src/index.css:34`). Bei Flex-Elementen bildet ein z-index ungleich `auto` einen
eigenen Stapelkontext, auch ohne Positionierung.

**Ursache.**

- Der Träger der Karte, `.ui-session-recovery-host`, behielt den z-index 40 aus einer älteren Sticky-Regel
  (`src/styles/shell.css:182`). Die spätere statische Regel setzte ihn nicht zurück.
- Damit lag der Träger über dem Kopf `.app-shell__top` (z-index 10, `src/index.css:44`).
- Das Menü-Panel hat zwar z-index 50, aber nur innerhalb des Kopfs.

**Korrektur.** `z-index: auto` in der statischen Regel (`src/styles/shell.css:579`). Sonst ist nichts geändert.

## 5. Sicherheitsnachweise

| Zusage | Nachweis |
|---|---|
| Keine fremden Dokumentinhalte nach Kontowechsel (Liste, Detail) | G1, G2 (Archivkarte und Titel fehlen, Gegenprobe beim Inhaber sichtbar); K2a; Browser C (Server bestimmt „fremd“, Liste, Detail) |
| Keine fremden lokalen Dateien und Vorschauen | K2b (Bytes in keinem Rückfallbereich lesbar, Vorschau-Bindung fehlt); Browser C |
| Keine fremden Schreibaufträge automatisch versenden | K2a, G1 (kein Versuch unter fremdem Konto); Browser C (kein Versand fremder Kennungen) |
| Kein Ergebnis eines noch laufenden Abgleichs im neuen Konto | K8a (verworfen, beide Bestände unverändert), K8b (im selben Bereich wie bisher), G7 (echter Lauf über Abmeldung und Mitgliedsanmeldung) |
| Keine fremden Inhalte über „Zurück“ (Navigationszustand) | K9a (Briefvorbelegung und Antwortentwurf des Inhabers beim Mitglied abgelehnt, ungestempelter Zustand abgelehnt, beim Inhaber wieder übernommen); bestehende P1-Tests der Briefwege; Browser C3 |
| Keine fremden Inhalte nach Rückkehr aus dem Seiten-Cache | G8 (anderes Konto oder keines → Neuladen; gleiches Konto und gewöhnliches `pageshow` → nichts); Browser C3 (je Schritt erfasst, ob die Seite aus dem Cache kam) |
| Kein Papierregister-Backfill fremder Einträge | K5a (Gegenprobe: mit Inhaber-Einträgen plante der Abgleich alle fünf); G1; Browser C |
| Ungesendete berechtigte Änderungen bleiben erhalten | K2a, G1 (Auftrag offen, Haken bleibt); G3 (Admin-Aufträge nach Rollenrückgabe); Browser D |
| Rollenentzug und erneute Anmeldung | G3, K4a/K4b, G4 (widersprüchlich → gesperrt), G6 (entfernt → eigener Betrieb); Browser E1–E4 |
| Keine Serverrechte abgeschwächt | keine Server-, Migrations- oder Policy-Änderung (Diffs in `belege/nacharbeit-n/diffs/`) |
| Keine pauschale Löschung | K3a–K3d, K4a (Bestände verschoben oder liegen gelassen, nie gelöscht); Browser C, E (Bestände per Hash unverändert) |
| N2: „Abmelden“ jederzeit bedienbar | N2a–c; Browser B und D2 (Karte sichtbar, Eintrag oben, echter Klick) |

**Gegenproben in der isolierten Kopie** (Endstand; die Kopie stimmte vor dem Lauf in allen `src`-Dateien mit dem
Arbeitsbaum überein):

- Je Mutation wird eine Schutzstelle entfernt.
- Die zuständigen Tests müssen rot werden, und zwar an der fachlichen Zusicherung.
- Danach wird wiederhergestellt.
- Der unmutierte Stand ist vorher und nachher grün (29/29: Dienst-, Gate- und Erstzugangstests).

| Nr. | Entfernte Schutzstelle | erkannt durch (rote Tests) |
|---|---|---|
| M1 | Zustand ohne Kontotrennung (gemeinsamer Schlüssel wie vor N1) | G1/G2/G3 „fremdes Dokument im Archiv“, G4, G6, G7, K1–K3 (18) |
| M2 | Dateien ohne Kontotrennung | K1a, K2b: Bytes des Inhabers für das Mitglied lesbar (2) |
| M3 | Sicht nicht im Schlüssel (Admin und Mitglied teilen sich einen Bestand) | G3 „Admin-Bestand nach Rollenentzug sichtbar“, K4a u. a. (7) |
| M4 | Cloud-Bootstrap wechselt wie vor N1 mit der Inhaberkennung | G1–G7 (7) |
| M5 | keine Sperre ohne aktive Mitgliedschaft | G4 „App nicht gesperrt“ (1) |
| M6 | kein Aufräumen beim direkten Kontowechsel | G2 (1) |
| M7 | Mitglied übernimmt den Altbestand | K3a „Mitglied sieht Altbestand“ (1) |
| M8 | Mitglied verschiebt den globalen Altbestand in die Quarantäne | K3c „globaler Altbestand angefasst“ (1) |
| M9 | Nutzerbereich eines Nicht-Inhabers wird mit Geschäftsdaten übernommen | K3d, G5 (2) |
| M10 | Hinweis-Auswahl wieder gerätweit | K6a (1) |
| M11 | Rolle `member` ergibt volle Sicht | K7a, G1–G3, G5–G7, E-C1 (9) |
| M12 | inaktive Mitgliedschaft gilt als Zugang | K7a, G4 (2) |
| M13 | doppelte Mitgliedszeile wird akzeptiert | K7b (1) |
| M14 | Notfall-Inventar erkennt Kontobereiche nicht | K1b (1) |
| M15 | Lauf über einen Kontowechsel wird trotzdem angewendet | G7 „Inhaberaufträge in der Mitgliedswarteschlange: `document:…`, `paper_register_entry:…`“, K8a (2) |
| M16 | Navigationszustand ohne Bereichsprüfung | K9a (1) |
| M17 | Rückkehr aus dem Seiten-Cache lädt trotz anderem Konto nicht neu | G8 (1) |
| M18 | Seiten-Cache-Schutz im Gate nicht eingebunden | G8 (1) |
| N2 | `z-index: auto` entfernt | N2a („expected '40' to be 'auto'“); unmutiert und wiederhergestellt 3/3 |

Ergebnis: 18/18 und N2 erkannt (`belege/nacharbeit-n/gegenproben/mutationen-n1.json`, `mutation-n2.json`). M15
zeigt, dass das in Abschnitt 3.3 geschlossene Leck real war: Ohne den Schutz landen Dokument- und
Papierregister-Auftrag des Inhabers in der Warteschlange des Mitglieds.

## 6. Tests

Neu:

- `src/services/storage/kontoTrennungDokumente01.test.ts`, 17 Tests, Dienstebene über die echten Lade- und
  Speicherwege:
  - K1 Schlüssel und Inventar;
  - K2 Wechsel Inhaber → Mitglied → Inhaber mit Dokumenten, Warteschlange, Bytes und Vorschauen;
  - K3 Altbestände;
  - K4 Rollenwechsel;
  - K5 Papierregister-Abgleich;
  - K6 Hinweise;
  - K7 Sicht aus der Mitgliedschaft;
  - K8 Synchronisationslauf über einen Kontowechsel;
  - K9 Inhalte im Navigationszustand.
- `src/kontoTrennungGateDokumente01.test.tsx`, 8 Tests, realer Stapel AuthProvider → BusinessStateGate → App.
  Gestubbt sind nur die Supabase-Antworten; Schreibaufrufe scheitern wie in der Browserprüfung mit Netzfehler:
  - G1 Inhaber → Abmelden → Mitglied → Abmelden → Inhaber;
  - G2 direkter Kontowechsel;
  - G3 Rollenentzug und -rückgabe;
  - G4 entfernte Mitgliedschaft;
  - G5 Nutzerbereich mit Geschäftsdaten;
  - G6 echte Entfernung: Der Server verweigert den Abzug und legt wie seit 20261124 einen eigenen Betrieb an;
  - G7 ein echter Abgleich des Inhabers, der erst nach Abmeldung und Mitgliedsanmeldung endet;
  - G8 Rückkehr aus dem Seiten-Cache.
- `src/abmeldeMenueN2Dokumente01.test.ts`, 3 Tests: wirksame CSS-Regel und Voraussetzungen.

Angepasst, nur Erwartungen an den Speicherort bzw. realistische Mitgliederlisten:

- `businessContextFlash01b.test.tsx`
- `companyIdentityRecovery02.test.tsx`
- `multiOriginSetupRestore01.test.tsx`
- `setupCloudPersist01.test.tsx`
- `memberFirstAccessFc01a.test.tsx` (FINANZ-CORE-01A-Test). Geändert ist dort nur eine Zusicherung: Der Bestand
  liegt jetzt im Mitgliedsbereich statt im gemeinsamen Schlüssel. Sie wird ausdrücklich geprüft.
- `briefReplyToP1.test.tsx`: Die Vorbelegung entsteht jetzt über `createLetterDraftPrefillLocationState` statt
  von Hand; die Erwartungen sind unverändert.

Die Fixtures mit leerer Mitgliederliste und übersprungener Provisionierung trafen die neue Sperre. Der echte Server
liefert in jedem Abzug die vollständige Liste, für Inhaber wie für Mitglied; das ist mit
`belege/nacharbeit-n/sql/abzug-mitglieder.sql` lokal geprüft. Die Sperre wurde deshalb nicht gelockert.

| Lauf | Ergebnis |
|---|---|
| Gezielt + angrenzend, Endstand vor dem Seiten-Cache-Schutz (85 Dateien, `client-ziele-n-ende.txt`) | 82/85 Dateien, 1179 Tests grün, 0 übersprungen. Rot: `documentAssistFillFreeTextBridge01` (8, „useNavigate ohne Router“) und `uxHome01` (1, erwartet `home-card-orders`), beide vorbestehend und auf der Liste der vorbestehend roten Tests; dazu `localScopeEmergencyQuarantineUi03` mit 55 Zeitüberschreitungen (5 s) unter Last, einzeln 66/66 grün (`client/einzeln-localScopeEmergencyQuarantineUi03.json`). Schutzartefakte unverändert (`client/gezielt-n-ende.json`) |
| Nach Einbindung des Seiten-Cache-Schutzes: alle 8 Testdateien, die das Gate rendern, und die neuen Dienst- und CSS-Tests (`client-ziele-gate-ende.txt`) | 10/10 Dateien, 125 Tests grün, 0 übersprungen; Schutzartefakte unverändert (`client/gate-ende.json`) |
| Neue Tests, Endstand (3 Dateien) | 28/28 grün (17 + 8 + 3), 0 übersprungen; Schutzartefakte unverändert (`client/neu-n-ende.json`) |
| Zwischenstand vor Lauf-Schutz und Navigationsstempel (64 Dateien, `client-ziele-n.txt`) | 63/64 Dateien, 966 Tests grün; rot nur `uxHome01` (vorbestehend) (`client/gezielt-n.json`) |
| Erster angrenzender Lauf direkt nach der Umstellung, vor Anpassung der Tests | 20/26 Dateien, 22 rote Tests. Rot waren `businessContextFlash01b` (6), `companyIdentityRecovery02` (9), `setupCloudPersist01` (3), `multiOriginSetupRestore01` (2), `memberFirstAccessFc01a` (1) und vorbestehend `uxHome01` (1). Ursache: Speicherort bzw. Fixtures ohne Mitgliederliste (`client/angrenzend-1.json`) |
| `tsc --noEmit -p tsconfig.json`, Endstand | ohne Befund (`client/tsc.log` leer, Exit 0) |
| Mitgliederliste im echten Abzug (lokal, nur lesend, zurückgerollt) | Inhaber und Mitglied erhalten je 2 Einträge (`owner/active`, `member/active`), das eigene Konto ist enthalten (`sql/abzug-mitglieder.txt`) |

**Browser** (Edge über playwright-core, Prüf-App 5232 mit dem Endstand, je Lauf ein frisches Profil, synthetische
DOK01-Konten):

- Sitzungen nur per lokalem Magic-Link im Speicher, Kennwörter unverändert.
- Jeder schreibende Aufruf an die lokale Supabase wurde im Browser abgefangen, `/auth/v1/logout` lokal mit 204
  beantwortet.
- Rollenwechsel nur durch Umschreiben der Antworten von `ensure_personal_workspace` und `pull_workspace_sync_state`
  im Browser; der Server blieb unverändert.
- Am Ende alle eigenen Sitzungen mit `scope=local` widerrufen (je 204), Profile gelöscht.

`browser/abnahme-n.mjs`, 47/47 Prüfpunkte (`abnahme-n-ergebnis.json`):

| Phase | Geprüft | Ergebnis |
|---|---|---|
| A Inhaber | eigener Kontobereich (volle Sicht), kein gemeinsamer Bestand, 6 Dokumente; „Papieroriginal abgeheftet“ → Haken gesetzt, Auftrag offen (Versand blockiert); Gegenprobe: der Briefeditor übernimmt die eigene Vorbelegung | grün |
| B N2 Desktop | Karte „Weiterarbeiten“ sichtbar und geometrisch über dem Menüeintrag; oberstes Element am Eintrag ist „Abmelden“; echter Klick (ohne `dispatchEvent`) meldet ab | grün |
| C Mitglied, selbes Profil | „fremd“ laut lesendem Server-Abzug mit der Mitgliedssitzung: 5 Inhaberdokumente. Keines davon im Bestand, im Archiv (Karten, Titel) oder im Detail. Dateien nicht lesbar (4 geprüft, 3 Bereiche). Keine fremden Vorschau-Bindungen, Papiereinträge oder Aufträge. 0 Sendeversuche. Inhaberbestand seit seiner Abmeldung per Hash unverändert | grün |
| C3 „Zurück“ | 6 Schritte zurück bis zum Verlaufseintrag des Inhabers; Briefeditor ohne dessen Vorbelegung; in keinem Schritt fremde Titel; 0 Seiten aus dem Seiten-Cache (Edge nutzte ihn hier nicht, der Schutz ist mit G8, M17 und M18 belegt) | grün |
| D Inhaber erneut | 6/6 Dokumente, Haken erhalten, Auftrag weiter offen; Sendeversuche dafür nur in Inhaberphasen (A, B, D), nie unter dem Mitgliedskonto | grün |
| D2 N2 bei 390 px | wie B auf Telefonbreite | grün |
| E1–E4 Rollen (nachgestellt) | Admin → volle Sicht im eigenen Bereich; Entzug → Mitgliedssicht, Admin-Bestand unverändert, nichts Fremdes; „entfernt“ laut Abzug → App gesperrt („Ihre Firmendaten konnten nicht geladen werden“), kein Betriebsbereich, kein Versand, Bestände unverändert; erneute Zulassung → Mitgliedssicht | grün |
| Gesamt | über alle Mitgliedsphasen kein einziger Sendeversuch | grün |

`browser/vorschau-n.mjs`, 8/8 (`vorschau-n-ergebnis.json`):

- Der Inhaber erzeugt mit den echten Orchestratoren Vorschau und Vorschaubild (`persisted`), das Detail zeigt das
  Bild.
- Für das Mitglied sind die Bytes in keinem Bereich lesbar, Bindung und Dateireferenz fehlen, und das Detail zeigt
  nichts.
- Der Inhaber hat danach Bindungen und Bytes wieder, und das Vorschaubild lädt.

**Konsole:**

- `net::ERR_FAILED` stammt nur von den absichtlich blockierten Sendungen.
- Die 400er der Mitgliedssitzung sind laut Antwortprotokoll genau die bekannten Leseabzüge
  `pull_workspace_expenses`, `pull_workspace_employee_data` und `pull_workspace_accounting_assignments` („Kein
  Zugriff auf Workspace“, vorbestehend, `05`, Abschnitt 5).
- Ein 401 auf `profiles` entsteht beim ersten Seitenaufruf, bevor die Sitzung gesetzt ist.

Der erste Browserlauf (`abnahme-n-ergebnis-lauf1.json`, 38/42) zeigte vier Fehler des Prüfwerkzeugs, nicht der App:

- Der Inhaberbestand wurde mit einem Stand verglichen, der während seiner noch laufenden Sitzung entstand.
- Phase B wurde als fremd gewertet.

Beides ist im Werkzeug korrigiert; der Endlauf ist oben aufgeführt.

## 7. Auswirkung auf vorhandene Browserprofile (auch WEISS)

- Ein Profil aus der Zeit vor N1 trägt noch den gemeinsamen Bestand `officepilot-state:workspace:<DOK01>`.
- **Inhaber zuerst:** Die erste Anmeldung mit voller Sicht übernimmt ihn einmal, samt Warteschlange. Im
  WEISS-Profil gehören dazu die fünf endgültig abgewiesenen `paper_register_entry`-Aufträge der früheren
  Mitgliedssitzung. Sie bleiben als Fehler stehen und werden nicht erneut gesendet.
- **Mitglied zuerst:** Es bekommt einen eigenen, leeren Bereich und lädt seine Daten vom Server. Der Altbestand
  bleibt, bis sich ein Konto mit voller Sicht anmeldet.
- **Empfehlung für die Wiederholung:** frische Profile oder ein gemeinsames frisches Profil (Szenario H in
  `03-weiss-szenarien.md`). Gerade der Wechsel im **gemeinsamen** Profil ist jetzt das Prüfziel.

## 8. Grenzen

- **Altbestand ohne Kontozuordnung.** Aufträge tragen kein erzeugendes Konto. Haben sich vor diesem Stand mehrere
  Konten ein Profil geteilt, kann der gemeinsame Bestand ungesendete Aufträge eines anderen Kontos enthalten:
  - Das erste Konto mit **voller** Sicht übernimmt ihn. Offene Aufträge laufen dann unter diesem Konto (Inhaber oder
    Admin, also mit Schreibrecht); `updated_by` ist dann dieses Konto.
  - Endgültig abgewiesene Aufträge werden nicht erneut gesendet.
  - Ein Mitglied übernimmt nie.

  Option zur Entscheidung: offene Aufträge eines übernommenen Altbestands anhalten und erst nach Bestätigung senden.
  Das braucht eine Freigabe auf der Sync-Seite und berührt die Warteschlangenlogik (FINANZ-CORE-01A/GLS01). Deshalb
  ist es hier nicht umgesetzt.
- **Sendungen eines Laufs, der beim Wechsel noch sendet.** Sein *Ergebnis* wird verworfen (Abschnitt 3.3). Für
  die restlichen Sendungen gilt:
  - **Arten mit Sendenachweis** brechen von selbst ab: Papierregister, Briefe, Angebote, Aufgaben, Vorgangsnotizen,
    Wissen, Rechnungs-, Auftrags- und Nachtragsentwürfe, Bankkonten, Bankbuchungen. Der Nachweis lässt sich in der
    Warteschlange des neuen Kontos nicht ablegen; ohne Nachweis wird nicht gesendet (SYNC-DURABILITY-01G6). Der
    Auftrag bleibt wiederholbar.
  - **Arten ohne Nachweis** (u. a. Dokument, Kunde, Vorgang, Einrichtung) gehen mit der Sitzung hinaus, die der
    Browser im jeweiligen Moment hat:
    - Nach normalem Abmelden ist das keine Sitzung; der Server weist mit „Nicht angemeldet“ ab.
    - Meldet sich genau während des Sendens in einem zweiten Tab ein anderes Konto an, können die restlichen
      Sendungen dieses Laufs unter dem neuen Konto ankommen. Der Server prüft sie mit dessen Rechten; `updated_by`
      ist dann dieses Konto.

  Abhilfe wäre eine Sitzungsbindung je Lauf in Sync-Koordinator und -Adapter. Beide Dateien gehören zu
  FINANZ-CORE-01A, deshalb ist das hier nicht umgesetzt (Entscheidung).
- **Rollenentzug während einer laufenden Sitzung.** Lokal wird er beim nächsten Laden oder Anmelden wirksam, der
  Server setzt ihn sofort durch. Bis dahin bleibt sichtbar, was das Konto als Admin schon geladen hatte; neue Rechte
  entstehen dadurch nicht.
- **Ungesendetes aus der Mitgliedszeit beim Wiederaufstieg** in einen schon vorhandenen Admin-Bereich ruht im
  Mitgliedsbereich. Es wird erst nach erneutem Rollenentzug wieder geladen; gelöscht wird nichts.
- **Mitglied mit eigenem Altbestand vor N1** (offline, ungesendet): Dieser liegt im gemeinsamen Bestand und kommt nur
  über ein Konto mit voller Sicht weiter (siehe erster Punkt).
- **Lokale Rechnungsentwürfe aus der Zeit vor N1** tragen den alten Dateibereich und passen nicht mehr zum aktiven
  Konto. Sie werden weder angeboten noch gelöscht; der Cloud-Spiegel (S5) stellt synchronisierte Entwürfe wieder
  her. FINANZ-CORE-01A ist bewusst nicht geändert.
- **Unverändert gerätweit:**
  - `officepilot-service-period-proof:<betrieb>` (Finanz, nicht geändert);
  - der Speicher der Sitzungswiederherstellung für „Weiterarbeiten“. Seine Einträge sind an Bereich und Nutzer
    gebunden und werden beim Abmelden und beim Kontowechsel geleert;
  - die unangemeldeten Notfallseiten der lokalen Wiederherstellung (Geräteebene, wie bisher).
- **Kein Schutz gegen Gerätezugriff:** Wer das Browserprofil selbst öffnet (Entwicklerwerkzeuge, Dateisystem),
  liest lokale Bestände anderer Konten weiterhin. N1 verhindert die Anzeige und den Versand in der App, keine
  Verschlüsselung im Ruhezustand.

## 9. Einhaltung

- Kein Commit, Push, Deployment, keine Remote-Migration, kein Remote-Zugriff, keine produktiven Schreibzugriffe.
- FINANZ-CORE-01A nicht verändert: kein Finanzdienst geändert. Angepasst ist nur die eine Zusicherung im Test
  `memberFirstAccessFc01a.test.tsx` (Abschnitt 6). `ba778e8` ist unverändert.
- Gold-Berichte und Snapshot unverändert, vor und nach jedem Clientlauf gehasht. `InvoiceDocumentView.test.tsx` lief
  nicht.
- Beide Planer pausiert.
- Synthetische Konten nur über lokale Magic-Link-Sitzungen im Speicher; Kennwörter unverändert. Die eigenen
  Sitzungen sind mit `scope=local` widerrufen, die Prüfprofile gelöscht. Zugangsdateien nicht gelesen.
- Mutationen nur in der isolierten Kopie.

## 10. Belegpfade (`belege/nacharbeit-n/`)

- `diffs/`: Änderungen je Datei gegen HEAD. Ausnahme `documentFileStoreService.ts.diff`: nur der N-Anteil gegen
  den von WEISS geprüften W-Stand (Prüfsumme `6a6b6bc4…`, aus HEAD und dem W-Diff rekonstruiert und gegengeprüft).
  Neue Dateien sind vollständig enthalten.
- `pruefsummen.txt`: SHA256 der geänderten und neuen Dateien zum Abgabestand.
- `client/`:
  - Endstand: `gezielt-n-ende.*` (85 Dateien, Liste `client-ziele-n-ende.txt`), `einzeln-*` (Einzellauf unter
    Last roter Dateien), `gate-ende.*` (Gate-Tests nach dem Seiten-Cache-Schutz, Liste `client-ziele-gate-ende.txt`)
    und `neu-n-ende.*` (neue Tests);
  - Zwischenstände: `gezielt-n.*` (64 Dateien, vor Lauf-Schutz und Navigationsstempel), `neu-n.*`,
    `angrenzend-1.*` (erster Lauf vor der Testanpassung);
  - `tsc.log`;
  - Läufer `../nacharbeit-w/werkzeuge/gezielt-lauf.mjs`.
- `gegenproben/`:
  - Endstand: `mutationen-n1.json`/`.log`;
  - Zwischenstände: `-lauf1` (M1–M14, vor dem Lauf-Schutz) und `-lauf2` (M1–M15, vor dem Navigationsstempel);
  - Werkzeuge `mutationen-n1.mjs` und `mutation-n2.mjs` (mit `.json`). Aufruf jeweils mit dem Pfad der isolierten
    Kopie; das Werkzeug verweigert jeden anderen Pfad.
- `browser/`:
  - Werkzeuge `abnahme-n.mjs` und `vorschau-n.mjs`. Vor dem Aufruf die Pfade `HIER` und Schlüsseldatei anpassen;
    angenommen werden nur lokale Demo-Schlüssel.
  - Ergebnisse `*-ergebnis.json` (Endstand) und `abnahme-n-ergebnis-lauf1.json`, dazu die Konsolenprotokolle.
  - Bilder in `bilder/`, unter anderem `b-desktop-menue-offen.png` (Menü über der Karte),
    `c3-mitglied-zurueck-brief.png`, `e3-entfernt.png`.
- `sql/abzug-mitglieder.sql` mit `.txt`: Mitgliederliste im Abzug für Inhaber und Mitglied, nur lesend und
  zurückgerollt.
