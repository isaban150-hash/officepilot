# Farbprofil für PDF/A

## Warum überhaupt ein Profil

Ein PDF/A-Dokument muss reproduzierbar aussehen — auch in zehn Jahren, auf einem
Gerät, das es heute nicht gibt. Deshalb verlangt ISO 19005: Wer `DeviceRGB`
benutzt, muss im Dokument hinterlegen, *welches* RGB gemeint ist. Das leistet der
**OutputIntent** mit einem eingebetteten ICC-Profil.

Ohne dieses Profil scheitert die Prüfung an Regel `6.2.4.3-2`:

> DeviceRGB shall only be used if a device independent DefaultRGB colour space
> has been set […], or if the file has a PDF/A OutputIntent that contains an RGB
> destination profile

Das Rechnungs-PDF zeichnet Text und Linien in `rgb(…)` und bettet gegebenenfalls
ein Logo ein — also trifft die Regel zu.

## Verwendetes Profil

**sRGB2014.icc**

- Herkunft: ICC-Registry, <https://registry.color.org/rgb-registry/srgbprofiles>
  (`profiles/sRGB2014.icc`). Unverändert übernommen.
- SHA-256: `384b832de3412066743b52a75ee906b6fb9fb8d9e09e936fc2c43223815c6e0a`
- Grösse: 3.024 Byte
- ICC-Version 2.0.0, Geräteklasse `mntr` (Display), Farbraum `RGB `, PCS `XYZ `

Die Wahl fiel bewusst auf die **v2**-Fassung und nicht auf
`sRGB_v4_ICC_preference.icc`: Letztere trägt die Geräteklasse `spac`
(ColorSpace). Ein OutputIntent-Zielprofil muss eine Ausgabe- oder Anzeigeklasse
haben, sonst ist es an dieser Stelle nicht zulässig. `sRGB2014.icc` ist zugleich
klein genug, dass es jedes erzeugte PDF nur um rund drei Kilobyte vergrössert.

## Lizenz

> Copyright International Color Consortium, 2015. This profile is made available
> by the International Color Consortium, and may be copied, distributed,
> embedded, made, used, and sold without restriction.

Veränderte Fassungen müssten Kennung und Copyright-Vermerk entfernen und dürften
nicht als das Original ausgegeben werden — das betrifft uns nicht, die Datei ist
unverändert. Einbetten, Weitergeben und Mitliefern sind ausdrücklich erlaubt.
