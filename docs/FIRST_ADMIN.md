# Erster Plattform-Administrator

Stand: EINRICHTUNG-01 (AP9, Vertrag 1.34; EIN-33). Ersetzt die frühere Fassung aus SUPABASE-AUTH-03.

Es gibt **kein Standardkonto und kein Standardpasswort**. Der erste Plattform-Administrator entsteht aus einem normal
registrierten Konto, dem der Betreiber die Rolle einmalig per SQL gibt. Die Rolle steht ausschließlich serverseitig in
`public.profiles.role` — nie in `user_metadata`, nie im Anwendungscode, nie über eine Umgebungsvariable.

## Ablauf

1. **Registrieren.** Die künftige Administratorin bzw. der künftige Administrator registriert sich in der App mit der
   eigenen E-Mail-Adresse und einem eigenen Passwort und bestätigt die E-Mail-Adresse. Das Passwort kennt nur diese
   Person; es wird weder weitergegeben noch dokumentiert.
2. **Rolle vergeben (Betreiber).** In der Supabase-SQL-Konsole des Projekts, einmalig:

   ```sql
   update public.profiles
   set role = 'admin',
       status = 'approved'
   where email = '<ADMIN_EMAIL>';
   ```

   `<ADMIN_EMAIL>` durch die bestätigte E-Mail-Adresse ersetzen. Die Anweisung muss genau eine Zeile ändern; sonst
   abbrechen und die Adresse prüfen.
3. **Neu anmelden.** Erst nach der nächsten Anmeldung lädt die App das geänderte Profil. Die Plattform-Verwaltung
   (`/admin/users`) ist dann über das Benutzermenü erreichbar — und nur dort, nicht in den Betriebseinstellungen.

## Lizenz (optional)

Die Plattformrolle braucht keine Lizenz. Eine Lizenz braucht das Konto erst, wenn es selbst einen Betrieb führen soll:
Nach E3 gilt die Lizenz des Inhabers für seinen Betrieb. Weil ein Admin sein eigenes Konto in der Plattform-Verwaltung
nicht ändern kann („Das eigene Konto ändert nur ein anderer Admin.“), vergibt diese erste Lizenz ebenfalls der Betreiber,
immer mit Ablaufdatum:

```sql
update public.profiles
set license_status = 'active',
    license_expires_at = '<JJJJ-MM-TT>T23:59:59Z'
where email = '<ADMIN_EMAIL>';
```

Alle weiteren Lizenzen vergeben Admins in der Plattform-Verwaltung.

## Weitere Administratoren

Die App vergibt die Plattformrolle nicht; weitere Administratoren entstehen auf demselben Weg (Schritt 1 bis 3). Es muss
immer mindestens ein Plattform-Admin bleiben — der Server weist das Sperren des letzten Admins ab.

## Hinweise

- Kein Service-Role-Key im Frontend und in keiner Dokumentation.
- Keine Admin-E-Mail im Anwendungscode.
- `VITE_ALLOW_DEFAULT_ADMIN` nicht setzen: Die Variable hat keine Funktion mehr und löst in Production nur den Hinweis
  „Production-Konfiguration prüfen“ aus.
- Frühere Dokumentationsstände nannten ein Standardkonto aus der Zeit der lokalen Anmeldung. Ein solches Konto gibt es im
  Code nicht. Vor dem Go-live prüft der Betreiber nur lesend, dass kein produktives Konto diese früheren Angaben nutzt
  (E12 d, RELEASE-01).
