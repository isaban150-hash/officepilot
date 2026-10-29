# RELEASE-01 — Liste für EINRICHTUNG-01

Stand: 25.10.2026 (EINRICHTUNG-01 AP9, Vertrag 1.34). Nur lokale Doku: Nichts davon ist veröffentlicht. Diese Liste wird
erst in RELEASE-01 abgearbeitet — nach der unabhängigen Gesamtprüfung der App und mit eigener Freigabe für jeden
schreibenden Schritt. Keine Geheimnisse in dieser Datei; Werte setzt der Betreiber direkt im jeweiligen System.

## 1. Reihenfolge

1. **Vorher, nur lesend (E12):** die offenen Produktionsprüfungen a) bis e) entscheiden und durchführen
   (Abschnitt 6).
2. **Sicherung** des Produktionsstands (Datenbank und Storage) und Notfall-Rücknahme bereitlegen.
3. **Migrationen vor Functions und Frontend**, genau in dieser Reihenfolge. Jede Datei läuft als eigene Transaktion;
   bricht eine ab, steht der Stand bis zur vorherigen Datei — nicht weitermachen, sondern prüfen.

   | Nr. | Datei | Inhalt |
   |---|---|---|
   | 1 | `20261127120000_einrichtung01_e17_firmenblock.sql` | Prüfung des Firmenblocks bei der Rechnungsfreigabe (E17) |
   | 2 | `20261127130000_einrichtung01_profil_schema3.sql` | Firmenprofil-Schema 3 (Patch statt Ersatz) |
   | 3 | `20261128120000_einrichtung01_ap1_zugriff.sql` | Betriebslizenz, Nur-Lesen, Zugriffsregel (E3–E5) |
   | 4 | `20261129120000_einrichtung01_ap2_zustimmung.sql` | Zustimmung zu den Rechtstexten (Zeitpunkt vom Server) |
   | 5 | `20261130120000_einrichtung01_ap3_konto.sql` | Konto-Bereich, Oberflächensprache je Person, Betriebsname |
   | 6 | `20261201120000_einrichtung01_ap4_team.sql` | Team, Einladung, Übergabe, Plattform-Verwaltung |
   | 7 | `20261202120000_einrichtung01_ap6_profil_kommunikation.sql` | Firmenprofil-Prüfungen, Antwortadresse |
   | 8 | `20261203120000_einrichtung01_ap7_daten_loeschung.sql` | Konto- und Betriebslöschung, Planer (inaktiv) |

   Die Dateien bauen aufeinander auf: strikt in Zeitstempelreihenfolge, keine auslassen. Sie folgen auf die ebenfalls
   noch unveröffentlichten Migrationen von FINANZ-CORE-01A (Lauf 2) und DOKUMENTE-01 nach deren eigenen Listen.
   Supabase-CLI nur in der festen Fassung `npx supabase@2.117.0`, nie parallel.
4. **Edge Functions** veröffentlichen (Abschnitt 2), danach die Secrets prüfen (Abschnitt 3).
5. **Frontend** mit gesetzter `VITE_APP_BUILD_ID` bauen und veröffentlichen.
6. **Planer** erst nach einem erfolgreichen Probelauf aktivieren (Abschnitt 4).
7. **Nach dem Release:** Hinweise an die Betriebe (Abschnitt 5) und Rauchtest (Abschnitt 7).

## 2. Neue und geänderte Edge Functions

| Function | neu/geändert | `verify_jwt` | Zweck |
|---|---|---|---|
| `send-team-invitation` | neu | true | Einladungsmail (AP4) |
| `confirm-reply-to` | neu | true | Bestätigung der Antwortadresse; „confirm“ ohne Anmeldung (AP6) |
| `mail-status` | neu | true | Testmodus-Hinweis, keine Adressen (AP6) |
| `confirm-destructive-action` | neu | true | Bestätigungsnachweis für Löschungen (AP7) |
| `delete-account` | neu | true | Kontolöschung (AP7) |
| `account-deletion-resume` | neu | **false** | Wiederanlauf der Kontolöschung; nur Planer oder Dienstrolle (AP7) |
| `workspace-deletion-run` | neu | **false** | Ausführung fälliger Betriebslöschungen; nur Planer oder Dienstrolle (AP7) |
| `ai` | geändert | wie bisher | Betriebslizenz statt eigener Lizenz (E3) |
| `send-document`, `send-email`, `sync-mailbox`, `mailbox-oauth-start` | geändert | wie bisher | Betriebslizenz; Antwortadresse serverseitig je Versand |

Die Einträge stehen in `supabase/config.toml`. Lokal brauchen geänderte Function-Einträge einen Neustart des
Function-Dienstes; in Produktion wirkt die Veröffentlichung je Function.

## 3. Secrets und Variablen

| Name | Ort | Hinweis |
|---|---|---|
| `APP_ALLOWED_ORIGINS` | Function-Secret | kommagetrennt, z. B. die öffentliche App-Adresse; Linkbasis für Einladungs- und Bestätigungslinks. Ohne Angabe nur lokale Adressen |
| `MAIL_PROVIDER` | Function-Secret | Versandanbieter; wie bei `send-email`. Mit `MAIL_SENDER_EMAIL`, Anbieter-Schlüssel und ggf. `MAIL_TEST_RECIPIENT_ALLOWLIST` |
| `AI_RATE_LIMIT_SHORT_WINDOW_SECONDS`, `AI_RATE_LIMIT_SHORT`, `AI_RATE_LIMIT_DAILY` | Function-Secret | Pflicht; fehlt einer, antwortet `ai` mit `server_misconfigured` |
| `officetakt_workspace_deletion_url`, `officetakt_workspace_deletion_secret` | Vault | Adresse von `workspace-deletion-run` und Planer-Geheimnis (32–256 Zeichen) |
| `officetakt_account_deletion_url`, `officetakt_account_deletion_secret` | Vault | dasselbe für `account-deletion-resume` |
| `VITE_APP_BUILD_ID` | Vercel (Build) | Build-Kennung, z. B. Commit; erscheint auf der Versionsseite |
| `VITE_ALLOW_DEFAULT_ADMIN` | Vercel | **nicht setzen** (ohne Funktion, siehe [FIRST_ADMIN.md](./FIRST_ADMIN.md)) |

## 4. Planer

Die Migration legt zwei pg_cron-Jobs **inaktiv** an:

| Job | Zeitplan | Ruft |
|---|---|---|
| `officetakt-workspace-deletion` | täglich 03:23 UTC | `workspace_deletion_dispatch()` → `workspace-deletion-run` |
| `officetakt-account-deletion-resume` | stündlich zur 41. Minute | `account_deletion_resume_dispatch()` → `account-deletion-resume` |

Aktivieren erst, wenn die Vault-Einträge gesetzt sind und je ein Probelauf mit Dienstrolle ohne fälligen Auftrag ohne
Fehler endet. Danach `cron.alter_job(<id>, active := true)` und den ersten echten Lauf im Protokoll prüfen.

## 5. Hinweise an die Betriebe

- **Antwortadresse:** Bestehende Antwortadressen gelten nach der Migration als unbestätigt. Bis Inhaber oder Admin sie
  über den Bestätigungslink freigibt, gehen Antworten von Kunden an die bestätigte Anmelde-E-Mail des Inhabers.
- **Lizenz:** Die Lizenz des Inhabers gilt für den ganzen Betrieb; Mitglieder brauchen keine eigene. Bei Ablauf
  Nur-Lesen statt Sperre.
- **Rechtstexte:** Bei einer neuen Fassung ist eine erneute Zustimmung nötig; die Inhalte bleiben Entwurf, bis sie
  rechtlich geprüft sind (A2).
- **Sprachen:** Türkisch und Bulgarisch sind vollständig, aber noch nicht muttersprachlich geprüft (E7).

## 6. Offene Produktionsprüfungen (E12, nur lesend)

- a) Firmenprofile mit Signatur oder Angebots-/Briefvorlage und blockierte Freigaben (EIN-01).
- b) Konten mit mehr als einem eigenen Betrieb (EIN-03).
- c) Auth-Einstellungen: offene Registrierung, E-Mail-Bestätigung, Passwortregel, Redirect-URLs, Mailvorlagen
  (EIN-02, L2).
- d) Kein produktives Konto nutzt die früher in `docs/DEPLOYMENT.md` genannten Zugangsdaten (EIN-33).
- e) Tabellenrechte für `workspace_mailbox_connections` (EIN-18).

## 7. Rauchtest nach dem Release

Anmeldung, Registrierung mit neutraler Antwort, Warteseite, Einladung annehmen (Link), Betriebswahl, Nur-Lesen bei
abgelaufener Lizenz, Antwortadresse bestätigen, Sicherung und Export herunterladen, Löschantrag stellen und widerrufen
(Testbetrieb), Plattform-Verwaltung: freigeben, sperren, Lizenz. Jeweils in de und einer zweiten Sprache.
