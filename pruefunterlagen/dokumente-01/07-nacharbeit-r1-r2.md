# DOKUMENTE-01 — Sicherheitsnacharbeit R1 und R2

Stand 20.10.2026 · SCHWARZ · nur lokal, nichts remote.
Grundlage: Auftrag „Letzte bestätigte Sicherheitsnacharbeit R1 und R2“ nach dem WEISS-Endrecheck vom 20.10.2026.
N2 und der normale Kontowechsel sind von WEISS bestätigt. W1, W2 und die Vorschaukorrektur bleiben geschlossen und
sind nicht berührt. Belege: `belege/nacharbeit-r/` (Abschnitt 12).

## 1. Ergebnis

| Befund | Ergebnis | Art |
|---|---|---|
| R1 (P1) Laufender Versand unter falscher Identität | behoben | nur Client; Server unverändert |
| R2 (P1) Alte Aufträge unbekannter Herkunft | behoben | nur Client; Server unverändert |

Prüfung (Abschnitt 8):

- WEISS-Reproduktionen unverändert (bytegleiche Kopien): R1 mit Ersatzclient und mit echtem SDK, R2 Altwarteschlange
  — alle drei wie erwartet; eine strengere Variante (nur das Token wechselt) ebenso;
- neue Tests 29/29 (R1 16, R2 10, Oberfläche 3);
- angrenzende Regression, 90 Dateien: 1233/1233 grün;
- `tsc` ohne Befund;
- Gegenproben: 16/16 Mutationen erkannt;
- echter Browser (Edge, Prüf-App 5232): zwei Tabs im selben Profil, Wiederanmeldung, Altbestand mit Freigabe —
  30/30 Prüfpunkte.

Beim Prüfen kamen weitere Wege hinzu, alle jetzt geschlossen:

- ein Abruf, der einen Kontowechsel erlebte, hätte dessen Sicht in den Bestand gebracht (Abschnitt 3.5);
- die Nachmeldung von Mitarbeiterdaten im Abruf hätte nach einem Wechsel in die Warteschlange des neuen Kontos
  eingereiht; der Nachtragsabruf lief am Lauf vorbei über den globalen Client (3.5);
- nach dem Laden meldete der Änderungsverfolger bloße Formunterschiede eines übernommenen Altbestands als neue
  Aufträge des Kontos — über den bewussten Weg, der eine endgültige Abweisung ablöst. Das umging die R2-Sperre (5.5);
- die Dateiwartung nach dem Laden schrieb als automatischer Schreiber außerhalb des gesperrten Wegs (5.5);
- ein eigener Token-Lieferant (SDK-Option `accessToken`, Modus der WEISS-SDK-Probe): Dort war die Sitzung nicht
  lesbar, der Lauf prüfte nur den Speicherbereich. Ein reiner Tokenwechsel wäre durchgegangen (3.1).

## 2. R1 — Ursache

1. Ein Lauf liest beim Start Bestand und Warteschlange des aktiven Kontos und sendet die Aufträge nacheinander.
2. Jede Anfrage holte ihren Zugang erst beim Absenden aus der aktuellen Sitzung (Supabase-Client: `fetchWithAuth` →
   `auth.getSession()`). Die Sitzung liegt im gemeinsamen Speicher des Browsers. Meldet sich in einem zweiten Tab ein
   anderes Konto an, liefert sie sofort dessen Token.
3. Der Lauf prüfte seine Identität weder vor noch zwischen den Sendungen. Mehrstufige Aufträge (Datei: Bytes lesen,
   hochladen, registrieren; Dokument: Archivzeile, dann Originalbindung) hatten nach jedem asynchronen Zwischenschritt
   eine weitere Lücke.
4. Der N1-Schutz verwarf nur das Ergebnis eines Laufs nach einem Bereichswechsel. Gesendet war da schon.
5. Folge (WEISS): Die restlichen Aufträge des ersten Kontos gingen mit dem Token des zweiten hinaus.

## 3. R1 — Korrektur

### 3.1 Laufidentität (`src/services/sync/syncRunIdentityService.ts`, neu)

- Beim Start hält jeder Lauf fest, wem er gehört:
  - den Speicherbereich (Betrieb, Konto, Sicht `full`/`member`);
  - die Anmeldung: das Konto der Sitzung; bei eigenem Token-Lieferanten das Konto aus dem Token (`sub`) oder, wenn
    das Token keines nennt, einen Fingerabdruck des Tokens.
- Der Bereich wird vor und nach dem Lesen der Anmeldung verglichen.
- Passen Bereich und Anmeldung schon beim Start nicht zusammen (Kontobereich A, angemeldet B), sendet der Lauf
  nichts (`start_inkonsistent`).
- Der Wächter prüft Bereich, Anmeldung und danach erneut den Bereich. Der erste Unterschied hält den Lauf endgültig
  an (`bereich`, `sitzung`, `sitzung_unlesbar`).
- Die Berechtigungsrolle gehört zum Bereich (`…:full`/`…:member`): Ein Rollenwechsel ist ein Bereichswechsel und hält
  den Lauf an.

### 3.2 Gebundener Client: Prüfung unmittelbar vor jeder Anfrage

- Ein Lauf sendet nur noch über einen an ihn gebundenen Client (`rpc`, Tabellenzugriffe, Dateiablage).
- Eine Anfrage entsteht erst, nachdem der Wächter unmittelbar davor bestanden hat. Das gilt auch nach
  Zwischenschritten wie dem Lesen der Dateibytes oder einem vorangehenden Teilschritt.
- Jede Anfrage trägt den Zugang, den genau diese Prüfung für das Ursprungskonto gelesen hat (`Authorization` gesetzt).
  Das SDK übernimmt einen vorhandenen Kopf, statt die Sitzung neu zu lesen. Ein erneuertes Token desselben Kontos ist
  zulässig.
- Am tatsächlichen Netzaufruf (Supabase-Fetch, auch bei Wiederholungen der Bibliothek) blickt der Lauf ohne weiteres
  Warten ein letztes Mal auf den Bereich. Ist er angehalten, entsteht die Anfrage nicht. Der Fehler folgt der
  Fetch-Konvention für eine nicht ausgeführte Anfrage, deshalb wiederholt die Bibliothek sie nicht.
- Dateiablage: Upload und jede andere Netzmethode laufen über eine gebundene Ableitung des Ablageobjekts.

### 3.3 Sendeschleife (`src/services/sync/supabaseSyncAdapter.ts`)

- Vor jedem Auftrag prüft die Schleife selbst; der gebundene Client prüft zusätzlich vor jeder Anfrage.
- Der Auftrag, der beim Wechsel in Arbeit war, wird vollständig zurückgenommen: Status, Zähler, Bericht und lokaler
  Stand sind wie vorher. Er bleibt offen und unverändert beim Ursprungskonto, auch wenn ein Teilschritt schon
  bestätigt war (Grenze 10.2).
- Nach einem Wechsel übernimmt der Lauf nichts:
  - keine Markierung in der Warteschlange im Arbeitsspeicher (sie gehört womöglich schon dem neuen Konto);
  - kein Status, kein Fehler.

### 3.4 Bestätigungsjournal: nie doppelt (`src/services/sync/syncConfirmationJournal.ts`, neu)

- Jede Serverbestätigung eines Laufs kommt ins Journal **des Ursprungsbereichs** (`<Kontobestand>:sync-confirmed`), nie
  in den gerade aktiven Bereich.
- Geschrieben wird gebündelt: spätestens alle 25 Bestätigungen, sofort nach einem erkannten Wechsel und am Laufende.
- Der nächste Lauf dieses Kontos sendet einen so bestätigten Auftrag nicht erneut. Das Laden des Kontobestands
  wendet das Journal an.
- Zugeordnet wird genau über Auftrag, Vorgang, Version und Einreihungsnummer. Eine spätere Änderung derselben Entität
  ist ein neuer Auftrag und geht normal hinaus.
- Jedes erfolgreiche Speichern des Bestands räumt das Journal auf; es behält nur Bestätigungen noch offener Aufträge.
- Kann eine Bestätigung nicht festgehalten werden (Speicher voll), sendet der Lauf nichts weiter (wie 01G6 beim
  Sendenachweis).

### 3.5 Abruf und Koordinator

- Der Abruf eines Laufs ist an dieselbe Identität gebunden wie dessen Senden; ohne Senden an die beim Start.
- Erlebt der Abruf einen Wechsel, wird er ganz verworfen. Sonst brächte er die Sicht eines anderen Kontos in diesen
  Bestand, in beide Richtungen: Mitglieds- in volle Sicht und volle Sicht in Mitgliedssicht.
- Der Nachtragsabruf nimmt jetzt den gebundenen Client, vorher den globalen
  (`orderAmendmentCloudPullOrchestrator.ts`, nur durchgereicht).
- Die Mitarbeiter-Nachmeldung im Abruf reiht nur ein, solange der Arbeitsspeicher noch diesem Lauf gehört; geprüft
  synchron unmittelbar davor.
- Koordinator (`syncCoordinator.ts`) bei einem Wechsel im Senden oder im Abruf:
  - kein Abruf mehr, nichts gespeichert (`skipPersist`);
  - keine Fehlermeldung im jetzt aktiven Konto;
  - ein Bericht ohne Aufträge des früheren Kontos, nur mit dem Hinweis `sync-identity-changed`.

## 4. R2 — Ursache

1. Sendeaufträge trugen kein Ursprungskonto.
2. N1 übernimmt einen alten gemeinsamen Bestand (ein Bestand je Betrieb für alle Konten des Geräts) einmal in den
   Bestand des ersten Kontos mit voller Sicht, samt Warteschlange.
3. Der nächste Lauf sandte diese Aufträge mit dem Zugang des übernehmenden Kontos, obwohl niemand nachweisen kann, wer
   sie eingereiht hat (WEISS: `pendingAfterAdoption: 2`, beide gesendet).

## 5. R2 — Korrektur

### 5.1 Ursprung jedes neuen Auftrags (`syncOutboxService.ts`, `src/types/sync.ts`)

- Beim Einreihen erhält ein neuer Auftrag sein Ursprungskonto aus dem aktiven Bereich: Konto, Betrieb und Sicht; im
  Nutzerbereich nur das Konto.
- Zusammenführen ändert Ursprung und Sperre nicht.

### 5.2 Sperre bei Übernahme und Laden: unverändert erhalten

- Wird ein Altbestand übernommen, erhalten seine offenen Aufträge (`pending`, `error`, `blocked`) ohne Ursprung die
  Sperre `origin_unknown`, Quelle `legacy_adoption` (`workspaceAccountStorageService.ts`).
- Beim Laden eines Kontobestands geschieht dasselbe mit Quelle `load` (`storageBootstrapService.ts`), etwa für
  Bestände aus der N1-Zeit.
- Erhalten bleiben Inhalt, Status, Version, Versuchszähler und Reihenfolge; dazu kommt nur die Sperre. Nichts wird
  gelöscht.
- Nicht gesperrt und nicht wiederbelebt werden:
  - endgültig abgewiesene Aufträge (`failed`);
  - erledigte Aufträge;
  - nur-lokale Einträge (sie verlassen das Gerät ohnehin nie).
- Die Sperre übersteht Speichern, Laden und Neustart.

### 5.3 Sendeweg, Zählung, Anzeige

- Der Sendeweg sendet nie:
  - gesperrte Aufträge;
  - Aufträge eines anderen Kontos oder eines anderen Betriebs;
  - Aufträge mit breiterer Sicht als der Lauf (`full` in einem `member`-Lauf).
- Ein Auftrag mit Ursprungskonto geht nur in einem Lauf hinaus, der genau dieses Konto nachweist.
- Gesperrte Aufträge starten keinen Lauf. Sie zählen weder als „wartet“ noch als Fehler und erscheinen auch nicht
  als Konflikt.
- Status: „N Aufträge zurückgehalten“; Anzeige: „Aktion erforderlich“.
- Eine neue Änderung an einem gesperrten Auftrag gibt ihn nicht still frei; er bleibt gesperrt.

### 5.4 Bewusste Prüfung, Zuordnung und Freigabe

- Die Synchronisationsseite hat einen Abschnitt „Zurückgehaltene Aufträge“. Je Auftrag zeigt er:
  - Datentyp und erkennbaren Datensatz (Titel, Name oder Dateiname);
  - Vorgang, Einreihungszeit und Herkunft („aus älterem gemeinsamen Bestand übernommen“ bzw. „Herkunft nicht
    nachweisbar“).
- Ablauf:
  1. Aufträge einzeln auswählen; „Ausgewählte freigeben“ ist erst mit Auswahl möglich.
  2. Im Dialog bestätigen: „… Ihrem Konto zugeordnet und beim nächsten Abgleich mit Ihrer Anmeldung übertragen …
     die Zuordnung lässt sich nicht zurücknehmen“.
- Berechtigt ist allein das Konto dieses Bestands, und nur, wenn die Anmeldung es nachweislich meldet: Sitzung
  gelesen, dasselbe Konto, Bestand unverändert. Sonst wird die Freigabe abgelehnt und nichts verändert.
- Freigegeben werden genau die gewählten Aufträge. Sie erhalten das Konto als Ursprung und eine Freigabespur
  (`originAssignment`: wer, wann, vorherige Sperre).
- Erst wird gespeichert, dann gemeldet; scheitert das Speichern, ist nichts freigegeben. Gesendet wird mit dem
  nächsten Abgleich, nichts geschieht heimlich sofort.
- Prüfspur neben dem Bestand (`<Kontobestand>:outbox-origin-log`): jede Zurückhaltung (Übernahme, Laden) und jede
  Freigabe, mit Auftrag, Typ, Kennung, Vorgang, Status, Zeit und Konto.
- Keine pauschale Löschung, keine stille Übernahme, keine automatische Wiederholung endgültig abgewiesener Aufträge.

### 5.5 Kein Umweg über Änderungsverfolger und Wartung

Gefunden mit dem neuen Test A9:

- Nach dem Laden setzte der Speicherweg die Grundlinie des Änderungsverfolgers auf den rohen gespeicherten Stand.
- Fehlten einem Altbestand Felder, die das Laden heute ergänzt (etwa `linkedInvoiceId`), meldete das erste Speichern
  — hier die Dateiwartung — das als Änderung aller betroffenen Datensätze.
- Das geschah über den bewussten Weg. Er löste die endgültige Abweisung eines Altauftrags ab und erzeugte einen neuen,
  sendbaren Auftrag unter dem übernehmenden Konto.

Jetzt:

- Beim Laden eines Kontobestands ist die Grundlinie der aufbereitete Stand: „Öffnen ist keine Änderung“ gilt auch für
  den Verfolger.
- Die Dateiwartung nach dem Laden ist ein automatischer Schreiber und nimmt den gesperrten Weg. Eine endgültige
  Abweisung löst sie nie ab (A10).

## 6. Geänderte Dateien

| Datei | Art | Inhalt |
|---|---|---|
| `src/services/sync/syncRunIdentityService.ts` | neu | Laufidentität, Wächter, gebundener Client |
| `src/services/sync/syncConfirmationJournal.ts` | neu | Bestätigungsjournal je Bereich |
| `src/services/sync/syncOutboxOriginService.ts` | neu | Ursprung, Sperre, Prüfung beim Senden, Prüfspur |
| `src/i18n/locales/de/syncHeldOrders.ts` | neu | Texte „Zurückgehaltene Aufträge“ |
| `src/services/sync/supabaseSyncAdapter.ts` | geändert (FC01A-geteilt) | Bindung, Halt, Zurücknehmen, Journal, Sperre; Abruf gebunden |
| `src/services/sync/syncAdapter.ts` | geändert | Ergebnisfelder `identityChanged`, `heldOutboxIds`, `runIdentity` |
| `src/services/sync/syncCoordinator.ts` | geändert (FC01A-geteilt) | Abbruch ohne Übernahme; Abruf mit derselben Identität; Zählung ohne Gesperrte |
| `src/services/sync/syncOutboxService.ts` | geändert (FC01A-geteilt) | Ursprung beim Einreihen; Freigabe |
| `src/services/sync/syncUiService.ts` | geändert | Übersicht, Status „zurückgehalten“, Freigabe mit Kontoprüfung |
| `src/services/sync/syncIndicatorService.ts` | geändert | Anzeige „Aktion erforderlich“ |
| `src/services/persistenceService.ts` | geändert (FC01A-geteilt) | nach erfolgreichem Speichern: Journal aufräumen |
| `src/services/storage/storageBootstrapService.ts` | geändert (N1) | Laden: Journal, Sperre, Grundlinie; Wartung gesperrt |
| `src/services/storage/workspaceAccountStorageService.ts` | geändert (N1) | Übernahme: Sperre und Prüfspur |
| `src/services/orderAmendment/orderAmendmentCloudPullOrchestrator.ts` | geändert | gebundenen Client durchreichen |
| `src/types/sync.ts` | geändert | `origin`, `hold`, `originAssignment` |
| `src/pages/SyncPage.tsx` | geändert | Abschnitt „Zurückgehaltene Aufträge“, Dialog |
| `src/i18n/locales/de/index.ts` | geändert | Textmodul registriert |
| `src/services/sync/sendekontoR1Dokumente01.test.ts` | neu | R1, 16 Tests |
| `src/services/sync/altwarteschlangeR2Dokumente01.test.ts` | neu | R2, 10 Tests |
| `src/pages/syncHeldOrdersR2Dokumente01.test.tsx` | neu | Oberfläche, 3 Tests |
| `src/companyIdentityRecovery02.test.tsx` | angepasst (C3, K9) | Regeländerung R2, Abschnitt 7 |

`src/services/sync/syncPullPersistService.ts` ist gegenüber dem N1-Stand unverändert. Eine zwischenzeitliche Änderung
dort ist ganz zurückgenommen; das Aufräumen liegt zentral beim Speichern.

## 7. Auswirkung auf vorhandene Bestände (auch WEISS)

- Browserprofile aus früheren Phasen (auch die von WEISS): Beim nächsten Laden werden offene Aufträge ohne
  Ursprungsangabe gesperrt (Quelle „Laden“). Sie bleiben unverändert und lassen sich auf der Synchronisationsseite
  prüfen und freigeben. Endgültige Abweisungen bleiben, wie sie sind.
- Nach einer späteren Veröffentlichung ist jeder vorhandene Bestand ein Altbestand ohne Ursprungsangaben. Was beim
  Update noch nicht gesendet war, wird zurückgehalten (Anzeige „Aktion erforderlich“), bis das Konto es freigibt.
  Das folgt aus der Vorgabe „keine automatische Übernahme ohne nachweisbares Ursprungskonto“.
- Genau das zeigen die zwei angepassten Zusicherungen in `companyIdentityRecovery02.test.tsx`:
  - K9: Die offenen Firmenaufträge eines Altbestands gehen nicht mehr automatisch hinaus, erst nach der Freigabe durch
    den angemeldeten Inhaber — dann genau einmal je Firmenentität.
  - C3: Neben dem übernommenen Kontobestand liegt jetzt dessen Prüfspur. Die Zusicherung „nur der Kontobestand“ zählt
    deshalb nur die Bestände selbst, nicht ihre Anhänge.
  - Alle übrigen Zusicherungen sind unverändert; die Datei läuft mit 36/36.

## 8. Prüfung

### 8.1 WEISS-Reproduktionen (unverändert)

Bytegleiche Kopien (Prüfsummen in `weiss-proben/`) liefen im Scratchpad, damit nichts im WEISS-Ordner entsteht. Sie
nutzen den Produktcode des Arbeitsbaums.

| Probe | WEISS-Befund | Jetzt |
|---|---|---|
| `dok01-n1n2-sendekonto.mjs` | zweiter Aufruf unter B | ein Aufruf, unter A; `completed: [out-0]`, `failed: []`, `wrongIdentity: false` |
| `dok01-n1n2-sdk.mjs` (echtes SDK, eigener Token-Lieferant) | zweiter Aufruf mit `Bearer …-B` | ein Aufruf mit `Bearer synthetic-account-A`; `wrongIdentity: false` |
| `dok01-n1n2-sendekonto-und-altbestand.mjs` | Altwarteschlange gesendet | erster Teil wie oben; danach `adopted_legacy`, `pendingAfterAdoption: 2`, `calls: []`, `completed: []` |
| `r1-variante-nur-token.mjs` (eigene Verschärfung von `…-sdk.mjs`: nur der Token-Lieferant wechselt, eine Zeile anders, Diff beigelegt) | — | ein Aufruf mit `Bearer synthetic-account-A` |

### 8.2 Neue Tests (29/29)

`src/services/sync/sendekontoR1Dokumente01.test.ts` (16):

- S1 Inhaber → Mitglied während der ersten Sendung: genau eine Sendung, unter dem Inhaber. Der Rest bleibt
  unverändert offen. Die Bestätigung steht im Journal des Inhabers, nicht in dem des Mitglieds.
- S2 Gegenrichtung Mitglied → Inhaber.
- S3 Abmeldung während des Laufs.
- S4 Nur die Sitzung wechselt (zweiter Tab), der Bereich bleibt.
- S5 Mehrstufiges Dokument: Archivzeile bestätigt, Wechsel vor der Originalbindung. Keine Bindung unter dem neuen
  Konto; der Auftrag bleibt offen.
- S6 Kein doppelter Versand im nächsten Lauf des Inhabers.
- S6b Neustart: Das Laden wendet das Journal an und räumt es nach dem Speichern auf.
- S7 Echtes SDK: Der Zugang stammt aus genau der Prüfung davor, auch wenn die Sitzung unmittelbar danach wechselt.
  Gegenprobe ohne Bindung: dort trüge die Anfrage den fremden Zugang.
- S8a Datei: Wechsel während des Lesens der Bytes → weder Upload noch Registrierung.
- S8b Datei: Wechsel nach dem Upload → Upload unter dem Inhaber, keine Registrierung unter dem Mitglied.
- S8c Datei ohne Wechsel: beide Schritte mit dem Zugang des Inhabers.
- S12 Eigener Token-Lieferant, je mit JWT und mit undurchsichtigem Token: Nur das Token wechselt, der Lauf hält an,
  gesendet wird das geprüfte Token.
- S9a Wechsel zwischen Senden und Abruf (nur Sitzung): kein Abruf, nichts übernommen, kein Fehler, kein fremder
  Bericht; die Bestätigung bleibt im Journal.
- S9b Wechsel mitten im Abruf: kein weiterer Abruf, nichts übernommen.
- S10 Lauf ohne Wechsel: alles gesendet und gespeichert, Journal danach leer.
- S11 Normaler Kontowechsel Inhaber → Mitglied → Inhaber: Jeder sendet nur Eigenes mit eigenem Zugang.

`src/services/sync/altwarteschlangeR2Dokumente01.test.ts` (10):

- A1 Übernahme: offene Aufträge inhaltlich unverändert und gesperrt; ein Lauf sendet nichts davon. Abgewiesene,
  erledigte und nur-lokale Aufträge bleiben unverändert.
- A2 Neustart: Die Sperre bleibt. Ein Kontobestand ohne Ursprungsangaben wird beim Laden gesperrt.
- A3 Neue Aufträge tragen ihr Konto und gehen hinaus. Fremdes Konto, fremder Betrieb, breitere Sicht oder ein Lauf
  ohne Kontonachweis: nicht gesendet.
- A4 Freigabe durch das angemeldete Konto: nur die geprüften Aufträge, mit Prüfspur, danach genau einmal gesendet.
- A5 Abgelehnt: anderes Konto angemeldet, abgemeldet, nichts Gesperrtes, Speichern scheitert, kein Kontobestand.
  Jeweils nichts verändert.
- A6 Ein Mitglied übernimmt den Altbestand nie; er bleibt bytegleich liegen.
- A7 Eine neue Änderung an einem gesperrten Auftrag gibt ihn nicht frei.
- A8 Zählung, Status „zurückgehalten“, Anzeige „Aktion erforderlich“; der Koordinator startet ihretwegen keinen Lauf.
- A9 Wartung und Speichern nach dem Laden: keine neuen Aufträge aus dem Altbestand, keine Ablösung einer Abweisung.
- A10 Nachgetragener Dateihash in der Wartung: Die endgültige Abweisung bleibt das letzte Wort.

`src/pages/syncHeldOrdersR2Dokumente01.test.tsx` (3):

- U1 Eigener Abschnitt mit erkennbarem Datensatz und Herkunft, nicht zusätzlich „Ausstehend“; Status
  „2 Aufträge zurückgehalten“.
- U2 Freigabe erst nach Auswahl und Bestätigung im Dialog; danach ist nur der geprüfte Auftrag frei.
- U3 Ein anderes angemeldetes Konto kann nicht freigeben; der Dialog nennt den Grund.

### 8.3 Angrenzende Regression und Finanzverträge

- Liste `tests/ziele-angrenzend.txt`, 90 Dateien. Darin alle Tests, die einen Sync-Lauf (Senden, Abruf,
  Koordinator), das Laden oder Übernehmen eines Bestands oder die Sync-Anzeige berühren, dazu die Push-Helfer-Tests.
- Finanzverträge darin: `outboxReihenfolgeB21`, `invoiceFinalizationPreflight01`, `invoicePaymentTaskSync01b`,
  `outboxPreserveOnPull01`, `automatischeSchreiberSperreGls01`, `backfillSperreGls01` (V1: keine neue
  `enqueueSyncOutbox(`-Stelle), `syncSaveDuringRun01a`, `syncPushOnly01afix1`, `financeSyncBlocker01b`,
  `restnacharbeitAusgabenFc01a`, `accountingCloudPull01c`, `employeeCloudSyncP1ma`, `expenseMoneyIntegrity05b`,
  `systemischeNacharbeit21`.
- Endlauf (`tests/lauf3/`): 1233/1233 grün, ohne Wiederholung, keine Zeitüberschreitung. Zwischenlauf vor der
  Token-Lieferanten-Härtung (`tests/lauf2/`): 1231/1231; zwei Tests (S12, A10) kamen danach hinzu.
- Im ersten Lauf waren nur `companyIdentityRecovery02` C3 und K9 rot: die Regeländerung aus Abschnitt 7, keine
  Lastfolge.
- `tsc` ohne Befund (`tests/tsc-ende.log`).

### 8.4 Gegenproben (Mutationen, nur in der isolierten Kopie)

Je Mutation wird eine Schutzmaßnahme entfernt und die drei neuen Testdateien laufen; danach wird die Datei
wiederhergestellt. Das Werkzeug verweigert jeden anderen Pfad als die isolierte Kopie.

| Nr. | Entfernt | Erkannt von |
|---|---|---|
| M1 | Lauf-Bindung des Clients | S5, S7, S8a, S8b, S9b |
| M2 | geprüfter Zugang wird nicht angeheftet | S7 |
| M3 | Zurücknehmen des laufenden Auftrags | S5, S8a, S8b |
| M4 | Journal beim Senden beachtet | S6 |
| M5 | Journal am Laufende geschrieben | S1, S2, S3, S6, S6b, S9a |
| M6 | Abruf gebunden | S9b |
| M7 | Koordinator beachtet Wechsel im Abruf | S9a |
| M8 | Gesperrte zählen nicht als offen | A8 |
| M9 | Sperre bei Übernahme | A1, A4, U1 |
| M10 | Sendeweg beachtet Sperre | A1, A4, A7 |
| M11 | Sperre beim Laden | A2 |
| M12 | Ursprung beim Einreihen | A3 |
| M13 | Kontoprüfung bei der Freigabe | A5, U3 |
| M14 | Verfolger-Grundlinie nach dem Laden | A4, A9 |
| M15 | Wartung nach dem Laden gesperrt | A10 |
| M16 | eigener Token-Lieferant gelesen | S12 |

16/16 erkannt; unmutiert sind alle grün.

Nicht einzeln nachweisbar und deshalb nicht als Mutation geführt sind zwei zweite Sicherungen hinter dem gebundenen
Client:

- die Prüfung zu Beginn jedes Auftrags;
- die Prüfung zu Beginn des Abrufs.

Fehlt eine davon, hält der gebundene Client den Lauf vor der nächsten Anfrage trotzdem an.

### 8.5 Echter Browser (Edge, Prüf-App 5232)

Rahmen: frische Profile. Dokumentsendungen hat das Prüfskript selbst beantwortet; jeder andere schreibende Aufruf
wurde abgebrochen, der Server blieb unverändert. Sitzungen per Magic-Link nur im Speicher, am Ende mit
`scope=local` widerrufen (4× 204); Profile gelöscht. 30/30 Prüfpunkte:

- **R1, zwei Tabs, ein Profil.**
  - Ablauf: Tab 1 = Inhaber legt drei Dokumente an. Die erste Sendung wird angehalten. In Tab 2 meldet sich das
    Mitglied an, dann wird die Sendung freigegeben.
  - Ergebnis: genau eine Sendung, aus Tab 1, mit dem Zugang des Inhabers. Danach sendet Tab 1 nichts mehr.
  - Keine Sendung der Inhaberdokumente unter dem Mitglied. Alle drei Aufträge offen beim Inhaber, die eine
    Bestätigung im Journal; der Mitgliedsbestand ohne Inhaberaufträge.
- **R1b, Inhaber erneut.** Gesendet werden genau die zwei übrigen, mit seinem Zugang. Alle drei sind erledigt, das
  Journal ist leer. Über R1 und R1b ging jedes Dokument genau einmal hinaus.
- **R2, frisches Profil mit altem Betriebsbestand.**
  - Ausgangslage: zwei offene Aufträge ohne Ursprung.
  - Nach Anmeldung und Abgleich nichts davon gesendet; Anzeige „Aktion erforderlich“; Prüfspur `held` mit Quelle
    `legacy_adoption`.
  - Nach Neuladen weiter gesperrt.
  - Die Synchronisationsseite zeigt zwei zurückgehaltene Aufträge; der Status nennt die Zurückhaltung; die Freigabe
    ist ohne Auswahl gesperrt.
  - Ein Auftrag ausgewählt und im Dialog bestätigt: genau dieser geht mit dem Zugang des Inhabers hinaus. Der andere
    bleibt gesperrt; die Prüfspur hält `released` durch den Inhaber fest.
- **Über alle Phasen:** keine Dokumentsendung unter dem Mitglied (4 Sendungen, alle mit dem Zugang des Inhabers).

Abgebrochen hat das Skript 15 Papierregister-Aufträge, alle mit dem Zugang des Inhabers (eigene Einträge der neuen
Dokumente). Konsole:

- 401 beim ersten Laden vor der Anmeldung;
- 400 bei Leseabfragen des Mitglieds ohne Finanzrecht (Rollenregel „Kein Zugriff“).

Bilder: `browser/bilder/`.

## 9. FINANZ-CORE-01A

Geänderte gemeinsame Sync-Module:

- `supabaseSyncAdapter.ts`, `syncCoordinator.ts`, `syncOutboxService.ts`, `persistenceService.ts`;
- dazu `syncUiService.ts` für Übersicht und Freigabe.

Umfang:

- Nur die Sicherheitskorrektur: Bindung, Halt, Zurücknehmen, Journal, Ursprung und Sperre, Zählung, Aufräumen beim
  Speichern.
- Keine fachliche Finanzänderung: keine Finanzregel, kein Betrag, kein Monat, keine Abweisungs- oder Konfliktlogik.
- Die Finanzzweige (Kontierung, Monatsabschluss, Mitarbeiter, Ausgaben, Zahlungen) senden unverändert, nur über den
  gebundenen Client.

Weiteres:

- Abgesichert durch die Verträge in Abschnitt 8.3.
- Keine neue `enqueueSyncOutbox(`-Aufrufstelle.
- `ba778e8` ist unverändert.

## 10. Grenzen

1. **Eigener Token-Lieferant (in der App nicht verwendet).** Nennt das Token kein Konto, zählt sein Fingerabdruck.
   Eine Erneuerung des Tokens hält den Lauf dann an; das ist vorsichtig, nicht fehlerhaft. Ein solches Token lässt
   sich keinem Konto zuordnen; geprüft wird dann nur, dass es während des Laufs gleich bleibt.
2. **Teilweise ausgeführte mehrstufige Aufträge.** Ist ein Teilschritt bestätigt und der Wechsel kommt vor dem
   nächsten, bleibt der Auftrag offen. Das Ursprungskonto wiederholt ihn vollständig, wie nach einem Netzabbruch
   zwischen den Schritten. Der Upload ist idempotent (vorhandenes Objekt gilt als Erfolg); für die Archivzeile gilt
   der bestehende Versions- und Konfliktweg.
3. **Absturz mitten im Lauf.** Das Journal wird gebündelt geschrieben. Bricht der Tab mitten im Lauf ab (Absturz,
   nicht Kontowechsel), können bis zu 24 Bestätigungen fehlen. Für sie gilt der bisherige Weg bei verlorener
   Bestätigung (Sendenachweise 01G4/01G5, serverseitige Idempotenz); das ist kein neuer Fall.
4. **Kein Verwerfen.** Einzelne gesperrte Aufträge lassen sich nicht verwerfen (nicht beauftragt; „keine pauschale
   Löschung“). Sie bleiben bis zur Freigabe unverändert liegen. Ein blockierter, gesperrter Auftrag zeigt seine
   Konfliktentscheidung erst nach der Freigabe.
5. **Freigabe durch Mitglieder.** Freigeben kann das Konto des jeweiligen Bestands, auch ein Mitglied in seinem
   eigenen Mitgliedsbestand. Den Altbestand übernimmt ein Mitglied nie (N1). Was ein Mitglied darf, prüft weiter der
   Server.
6. **Übernommene Altdaten selbst** (nicht ihre Aufträge) gehören nach N1 dem übernehmenden Konto mit voller Sicht.
   Ein späterer Abgleich kann für solche Daten, die die Cloud nicht kennt, neue Aufträge einreihen. Er nimmt dafür
   den gesperrten Weg, der keine endgültige Abweisung ablöst. Ein vorhandener gesperrter Auftrag wird dabei
   zusammengeführt und bleibt gesperrt.
7. **Nachholen fehlender Eingangsanalysen nach dem Laden** erzeugt abgeleitete Arbeitsergebnisse (neu, Ursprung =
   aktuelles Konto), keine Altaufträge.
8. **Direktaktionen außerhalb eines Synchronisationslaufs** laufen weiterhin sofort mit der aktuellen Sitzung (etwa
   Rechnung festschreiben, Auftrag anlegen). Sie haben keine Warteschlange und sind nicht Gegenstand von R1.
9. **Rollenänderung allein auf dem Server.** Ändert sich die Rolle, ohne dass der Client es weiß, weist der Server
   ab (Regeln aus GO-LIVE-SECURITY-01).

## 11. Einhaltung

- Kein Commit, Push, Deployment, keine Remote-Migration, kein Remote-Zugriff, keine produktiven Schreibzugriffe.
- Server und lokale Datenbank unverändert; in den Browserläufen hat kein Schreibaufruf den Server erreicht.
- Gold-Berichte und Snapshot unverändert (Prüfsummen `6e4b1c91…`, `2db37b51…`, `6cf194f4…`). Die sichere
  Vitest-Konfiguration vergleicht sie vor und nach jedem Lauf; zuletzt nach allen Läufen per Hash geprüft.
  `InvoiceDocumentView.test.tsx` lief nicht. Alle Läufe nur mit `vitest.safe.config.ts` und 2 Workern.
- Beide Planer pausiert (pg_cron 1 und 2 `active = false`, nur lesend abgefragt).
- Synthetische Konten nur über lokale Magic-Link-Sitzungen im Speicher; Kennwörter unverändert. Die eigenen
  Sitzungen sind mit `scope=local` widerrufen, die Prüfprofile gelöscht.
- Zugangsdateien (WEISS und eigene) nicht gelesen. WEISS-Dateien nur gelesen und kopiert; nichts in den WEISS-Ordner
  geschrieben. Versiegelte Ordner nicht berührt.
- Mutationen nur in der isolierten Kopie. Der Arbeitsbaum wird von der Prüf-App ausgeliefert und blieb frei davon.
- Andere Dienste (5203/5204/5213/5220/5222–5229, 54396/54397/54399) unberührt. Die Prüf-App 5232 läuft weiter.

## 12. Belegpfade (`belege/nacharbeit-r/`)

- `weiss-proben/`:
  - die drei Proben (bytegleiche Kopien; Prüfsummen von Original und Kopie) und die Variante mit Diff;
  - `ausgaben/`: die von den Proben geschriebenen Ergebnisse.
- `tests/`:
  - Listen `ziele-neu.txt` und `ziele-angrenzend.txt`;
  - Endläufe `neu-ende.json` und `lauf3/`, Zwischenlauf `lauf2/` (je Portion ein JSON-Bericht, dazu
    `zusammenfassung.json`);
  - `tsc-ende.log`.
- `gegenproben/`: `mutationen-m1-m15.json`, `mutation-m16.json`; die Berichte je Mutation in `einzeln/`.
- `browser/`: `abnahme-r.mjs`, `abnahme-r-ergebnis.json`, `abnahme-r.konsole.txt`, Bilder in `bilder/`.
- `diffs/`:
  - je Datei gegen HEAD, wo es vorher keine Änderung gab;
  - neue Dateien vollständig;
  - `*.r-anteil.diff`: nur der R-Anteil gegen den N1-Stand (aus HEAD und dem N1-Diff rekonstruiert, gegen
    `nacharbeit-n/pruefsummen.txt` geprüft);
  - `index.ts.diff` mit der früheren D-017-Zeile und den zwei R-Zeilen;
  - Übersicht `diffs-uebersicht.json`.
- `werkzeuge/`: `portionen.cjs` (Läufer), `mutationen.cjs` (verweigert jeden Pfad außer der isolierten Kopie),
  `r-diffs.cjs`, `pruefsummen.cjs`.
- `pruefsummen.txt`: SHA256 der geänderten und neuen Dateien zum Abgabestand.
