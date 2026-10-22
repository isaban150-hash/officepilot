# DOKUMENTE-01 / AP6 — Browserprüfung gegen den lokalen Stack

20.10.2026, 02:27–03:13 UTC · Edge (playwright-core), App `http://localhost:5232` gegen `http://127.0.0.1:54321`.
Externe KI abgefangen (`/functions/v1/ai`, `generativelanguage.googleapis.com`); fremde Hosts im ganzen Lauf nur
`fonts.googleapis.com`, `fonts.gstatic.com`. Synthetische Nutzer und Daten, Kennungen hier nicht aufgeführt.

| Bild | Gerät | Was es zeigt |
|---|---|---|
| 01-upload-vorschau-rechnung | Inhaber | Upload-Vorschau einer Eingangsrechnung: „Dauerhaft speichern sinnvoll", Hinweis auf die Aufbewahrungspflicht, kein Entsorgungsvorschlag |
| 02-firmendokument-art-bleibt | Inhaber | Rechnung ohne erkannten Empfänger: „Erkannt: Eingangsrechnung. Ohne andere Auswahl bleibt diese Dokumentart erhalten." (Fehler D, behoben) |
| 03-rechnung-archiv-aufbewahrung | Inhaber | Archivierte Rechnung: Karte „Aufbewahrung" (Buchungsbeleg, 8 Jahre, mindestens bis 31.12.2034, Grundlage, Papieroriginal), Bedeutung mit genau einem Betrag |
| 04-rechnung-loeschen-gesperrt | Inhaber | „Mehr anzeigen": statt „Löschen" der Hinweis „Gesetzliche Aufbewahrung bis 31.12.2034 – Löschen ist bis dahin gesperrt." |
| 05-schreiben-pruefbestaetigung | Inhaber | Schreiben ohne feste Frist: Prüftext und Knopf „Aufbewahrung geprüft – endgültig löschen" |
| 06-schreiben-geloescht | Inhaber | nach der Bestätigung zurück in der Dokumentliste; Cloud-Zeile `deleted = true` (RPC-Probe) |
| 07-quittung-ohne-gutschrift | Inhaber | archivierte Quittung „Auslagenerstattung": keine „Gutschrift zu Ihren Gunsten", keine Konsolenwarnung (F7) |
| 08-herabstufung-abgewiesen | Inhaber | Formular: Kategorie „Ausgangsrechnung" → „Sonstiges" abgewiesen mit dem Hinweis zur Aufbewahrungsfrist |
| 09-inhaber-hakt-mitgliedsdokument-ab | Inhaber | Inhaber hakt das Papieroriginal eines Mitgliedsdokuments ab |
| 10-geraet-b-sperre | zweites Gerät | gleiche Sperre und Einstufung („Beleg einer Ausgabe") nach frischem Login |
| 11-mitglied-sieht-haken | Mitglied | Mitgliedsgerät zeigt „Papieroriginal abgeheftet (20.10.2026)", Sync „Synchronisiert" (F9) |
| 12-mitglied-rollenhinweis | Mitglied | Löschbereich: „Dokumente löschen nur Inhaber und Verwaltung." |

Serverproben aus der echten Sitzung (Inhaber): `tombstone_workspace_document` und `upsert_workspace_intake_entity`
(archived_document, deleted=true, aktuelle Version) für die archivierte Rechnung → beide HTTP 403 / 42501
„Keine Schreibberechtigung: Aufbewahrungsfrist laeuft bis 31.12.2034 (buchungsbeleg, 8 Jahre)", Zeile danach
unverändert (`deleted = false`, Version 1). Als Mitglied: 403 / 42501 „Keine Schreibberechtigung" (Rolle).

Ablageempfehlungen nach dem Archivieren (Eingangsseite, „Warum diese Empfehlung?"): Rechnung „Original aufbewahren –
wichtig für Steuer und Buchhaltung. (Dauerhaft speichern dringend empfohlen)", Schreiben „Original aufbewahren, bis
geklärt ist, ob eine Aufbewahrungspflicht besteht." Auf keiner geprüften Seite stand „entsorg…" (F10).

Gefunden und behoben während der Prüfung: „Als Firmendokument markieren" überschrieb die erkannte Art mit
„Sonstiges" (Vorauswahl). Die erste Testrechnung liegt deshalb noch als `sonstiges` im Archiv — geschützt nur über
ihre Ausgabe; die zweite (nach der Korrektur) als `eingangsrechnung`.
