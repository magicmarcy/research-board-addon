# Research Board (Local)

Lokales Recherche-Board als Firefox-Add-on mit Sidebar-UI.  
Du sammelst Themen, Links, Zitate und Notizen direkt beim Browsen und verwaltest alles lokal im Browserprofil.

Aktuelle Version: **1.5.0**

## Features

- Themen verwalten: anlegen, bearbeiten, sortieren, archivieren, löschen
- Einträge erfassen: Link, Textzitat, Notiz, aktuelle Seite
- Rechtsklick-Menüs in der Sidebar für Themen und Einträge:
  - Einträge bearbeiten, verschieben oder löschen
  - Themen bearbeiten, archivieren/wiederherstellen oder löschen
- Capture per Kontextmenü: Seite, Link oder Auswahl direkt in ein Thema speichern
- Konfigurierbare URL-Umschreibung in den Einstellungen:
  - Eine oder mehrere Quell-URL-Prefixe definieren
  - Wert per Regex aus dem Seitentitel extrahieren
  - Ziel-URL über Vorlage mit Platzhalter `{value}` aufbauen
  - Anwendung bei Kontextmenü-Capture und `+ Aktuelle Seite`
- Notiz-/Textfeld-Vergrößerung per `⤢`:
  - Externes, separates Popup-Fenster zum Bearbeiten langer Inhalte
  - Popup-`Speichern` übernimmt den Text und speichert den Eintrag direkt
  - `Ctrl+S` im Popup speichert ohne das Popup zu schließen
- Drag-and-Drop-Unterstützung für Inhalte und Sortierung
- Globale Suche in Themen und Einträgen:
  - Trefferliste mit Treffer-Kontext (z. B. Titel, Notiz, URL)
  - Klick auf Treffer öffnet direkt den passenden Eintrag im Thema
- Eintragsdetails zeigen `Erstellt` und `Aktualisiert`
- Import/Export als JSON:
  - Gesamte Daten exportieren/importieren, inklusive Einstellungen
  - Einzelnes Thema exportieren, inklusive Einstellungen
  - Import-Modi: zusammenführen oder ersetzen
  - Einstellungen beim Import optional mit übernehmen oder auslassen
- Lokale Auto-Backups mit Intervall, Änderungstrigger, Start-Backup, manuellem Backup und Restore (inkl. Sicherheits-Backup vor Wiederherstellung)
- Vollständig lokal, ohne externe Backend-Abhängigkeit

## Installation

### 1. Entwicklung (temporär laden)

1. `manifest.template.json` nach `manifest.json` kopieren
2. In `manifest.json` unter `browser_specific_settings.gecko.id` eine eigene Add-on-ID eintragen
3. Firefox öffnen: `about:debugging#/runtime/this-firefox`
4. `Temporäres Add-on laden` auswählen
5. Die lokale Datei `manifest.json` wählen

Hinweis: Temporäre Add-ons werden nach einem Firefox-Neustart entfernt.

### 2. Signiertes XPI (dauerhaft installieren)

Für den regulären Firefox-Release-Kanal ist in der Regel ein signiertes Add-on nötig (z. B. unlisted Signierung über addons.mozilla.org).

### 3. Open-Source, aber ohne bereitgestellte Signatur

Dieses Repository stellt den Quellcode offen bereit, liefert jedoch **keine signierten Releases/XPI-Dateien** zur Installation im Firefox-Release-Kanal.

Wenn du das Add-on dauerhaft installieren willst, musst du ein eigenes signiertes Paket erzeugen (z. B. via AMO unlisted Signierung).

### 4. Add-on-ID und eigene Signierung

Die Add-on-ID in der Manifest-Datei identifiziert ein Add-on eindeutig.

- Für Forks und eigene Signierung immer eine eigene `gecko.id` verwenden
- Dieses Repository liefert keine Signatur und kein veröffentlichtes AMO-Listing
- `manifest.json` ist bewusst in `.gitignore`, damit keine private/produktive ID versehentlich committed wird

## Entwicklung

### Voraussetzungen

- Firefox (Developer Edition empfohlen)
- Node.js + `web-ext` (optional, aber empfohlen)

### Lokaler Dev-Loop mit web-ext

```bash
npx web-ext run
```

### Build (XPI)

```bash
npx web-ext build
```

Das Build-Artefakt landet standardmäßig in `web-ext-artifacts/`.

## Nutzung (Kurzfassung)

1. Sidebar über Toolbar-Icon `Research Board` öffnen.
2. Thema anlegen oder `Inbox` verwenden.
3. Inhalte speichern:
   - Rechtsklick auf Seite/Link/Auswahl -> `Zum Research Board hinzufügen`
   - Oder in der Sidebar Eintrag manuell erstellen
   - Oder per Drag-and-Drop in die Dropzone ziehen
4. Daten bei Bedarf exportieren/importieren (JSON).
5. Auto-Backups in den Add-on-Einstellungen konfigurieren.
   - Backups werden zusätzlich bei Datenänderungen zuverlässig (debounced) ausgelöst.
6. Optional in den Einstellungen eine URL-Umschreibung definieren (`{value}` als Platzhalter in der Ziel-URL; mehrere Quellen per Zeilenumbruch, `;`, `,` oder `|`).

## Berechtigungen

Das Add-on nutzt folgende Firefox-Berechtigungen:

- `storage`: Lokale Einstellungen, Pending-Capture-Status und Backup-Metadaten speichern
- `tabs`: Tab-URL/Titel für Einträge nutzen und Links in neuen Tabs öffnen
- `contextMenus`: Kontextmenü-Einträge für schnelles Erfassen bereitstellen
- `alarms`: Zeitgesteuerte Auto-Backups ausführen

## Datenhaltung und Datenschutz

- Einträge, Themen und Backups: `IndexedDB` (lokal im Firefox-Profil)
- Einstellungen und Backup-/Change-Metadaten (u. a. URL-Umschreibung, Theme, `lastSignature`, Change-Token): `storage.local`
- Pending-Capture-Zustand für Kontextmenü-Übergaben: `storage.local`
- Keine Übertragung an externe Server durch dieses Add-on

## Projektstruktur

```text
.
|- manifest.template.json
|- background.js
|- shared/
|  |- db.js
|  |- auto-backup.js
|  |- compat.js
|  |- url-transform.js
|- sidebar/
|  |- note-popup.html
|  |- note-popup.css
|  |- note-popup.js
|- options/
|- icons/
`- web-ext-artifacts/
```

## Mitwirken

Issues und Pull Requests sind willkommen.  
Bitte bei größeren Änderungen kurz Ziel und Ansatz im Issue beschreiben.

## Lizenz

Dieses Projekt steht unter der **MIT-Lizenz**.  
Details siehe [LICENSE](./LICENSE).
