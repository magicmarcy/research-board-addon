# Research Board (Local)

Lokales Recherche-Board als Firefox-Add-on mit Sidebar-UI.  
Du sammelst Themen, Links, Zitate und Notizen direkt beim Browsen und verwaltest alles lokal im Browserprofil.

Aktuelle Version: **1.3.0**

## Features

- Themen verwalten: anlegen, bearbeiten, sortieren, archivieren, loeschen
- Eintraege erfassen: Link, Textzitat, Notiz, aktuelle Seite
- Capture per Kontextmenue: Seite, Link oder Auswahl direkt in ein Thema speichern
- Drag-and-Drop-Unterstuetzung fuer Inhalte und Sortierung
- Suche in Themen und Eintraegen
- Import/Export als JSON:
  - Gesamte Daten exportieren/importieren
  - Einzelnes Thema exportieren
  - Import-Modi: zusammenfuehren oder ersetzen
- Lokale Auto-Backups mit Intervall, manuellem Backup und Restore (inkl. Sicherheits-Backup vor Wiederherstellung)
- Vollstaendig lokal, ohne externe Backend-Abhaengigkeit

## Installation

### 1. Entwicklung (temporar laden)

1. `manifest.template.json` nach `manifest.json` kopieren
2. In `manifest.json` unter `browser_specific_settings.gecko.id` eine eigene Add-on-ID eintragen
3. Firefox oeffnen: `about:debugging#/runtime/this-firefox`
4. `Temporäres Add-on laden` auswaehlen
5. Die lokale Datei `manifest.json` waehlen

Hinweis: Temporare Add-ons werden nach einem Firefox-Neustart entfernt.

### 2. Signiertes XPI (dauerhaft installieren)

Fuer den regulären Firefox-Release-Kanal ist in der Regel ein signiertes Add-on noetig (z. B. unlisted Signierung ueber addons.mozilla.org).

### 3. Open-Source, aber ohne bereitgestellte Signatur

Dieses Repository stellt den Quellcode offen bereit, liefert jedoch **keine signierten Releases/XPI-Dateien** zur Installation im Firefox-Release-Kanal.

Wenn du das Add-on dauerhaft installieren willst, musst du ein eigenes signiertes Paket erzeugen (z. B. via AMO unlisted Signierung).

### 4. Add-on-ID und eigene Signierung

Die Add-on-ID in der Manifest-Datei identifiziert ein Add-on eindeutig.

- Fuer Forks und eigene Signierung immer eine eigene `gecko.id` verwenden
- Dieses Repository liefert keine Signatur und kein veroeffentlichtes AMO-Listing
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

Das Build-Artefakt landet standardmaessig in `web-ext-artifacts/`.

## Nutzung (Kurzfassung)

1. Sidebar ueber Toolbar-Icon `Research Board` oeffnen.
2. Thema anlegen oder `Inbox` verwenden.
3. Inhalte speichern:
   - Rechtsklick auf Seite/Link/Auswahl -> `Zum Research Board hinzufügen`
   - Oder in der Sidebar Eintrag manuell erstellen
   - Oder per Drag-and-Drop in die Dropzone ziehen
4. Daten bei Bedarf exportieren/importieren (JSON).
5. Auto-Backups in den Add-on-Einstellungen konfigurieren.

## Berechtigungen

Das Add-on nutzt folgende Firefox-Berechtigungen:

- `storage`: Lokale Einstellungen und Backup-Metadaten speichern
- `tabs`: Tab-URL/Titel fuer Eintraege nutzen und Links in neuen Tabs oeffnen
- `contextMenus`: Kontextmenue-Eintraege fuer schnelles Erfassen bereitstellen
- `alarms`: Zeitgesteuerte Auto-Backups ausfuehren

## Datenhaltung und Datenschutz

- Eintraege und Themen: `IndexedDB` (lokal im Firefox-Profil)
- Einstellungen und Backups: `storage.local`
- Keine Uebertragung an externe Server durch dieses Add-on

## Projektstruktur

```text
.
|- manifest.template.json
|- background.js
|- shared/
|  |- db.js
|  |- auto-backup.js
|  |- compat.js
|- sidebar/
|- options/
|- icons/
`- web-ext-artifacts/
```

## Mitwirken

Issues und Pull Requests sind willkommen.  
Bitte bei groesseren Aenderungen kurz Ziel und Ansatz im Issue beschreiben.

## Lizenz

Dieses Projekt steht unter der **MIT-Lizenz**.  
Details siehe [LICENSE](./LICENSE).
