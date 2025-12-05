# SnapShotter

SnapShotter is a Node.js script that enables automatic notification of surveillance images via WhatsApp. Once new images are detected in a specified directory, the script automatically sends these to a designated WhatsApp group. Upon successful transmission, the script moves the images to a separate archive directory.

The script utilizes [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js), a powerful library that facilitates interaction with WhatsApp Web. For more information on this library, check out the official [documentation page](https://wwebjs.dev/).

## Features

- Real-time monitoring of a directory for new images
- Automatic sending of images to a defined WhatsApp group
- Moving of sent images to a separate directory
- Local session storage via whatsapp-web.js `LocalAuth` (no MongoDB required)
- Customizable settings for directory paths, chat name, and file type

Please note: SnapShotter is intended for personal use. Ensure to respect WhatsApp's terms of service and obtain necessary permissions before sending content.

## Getting Started

1. Install dependencies: `npm install`
2. Configure `src/config.js`:
   - `chatName`: WhatsApp chat/group name to send images to
   - `readDir` / `saveDir`: folders to watch and to move sent images to
   - `fileExtension`: file type to process (default `.jpg`)
3. Start the script: `node src/SnapShotter.js`
   - The WhatsApp session is stored locally (folder `.wwebjs_auth`)

Supplementary: [upcam-client](https://github.com/gzeuner/upcam-client) to download images from upcam and compatible devices.

# Visit  

[tiny-tool.de](https://tiny-tool.de/).

Happy monitoring!

---

# SnapShotter

SnapShotter ist ein Node.js-Skript, das die automatische Benachrichtigung von Überwachungsbildern über WhatsApp ermöglicht. Sobald neue Bilder in einem bestimmten Verzeichnis erkannt werden, sendet das Skript diese automatisch an eine spezifizierte WhatsApp-Gruppe. Nach erfolgreichem Versand verschiebt das Skript die Bilder in ein separates Archivverzeichnis.

Das Skript verwendet [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js), eine leistungsstarke Bibliothek, die die Interaktion mit WhatsApp Web ermöglicht. Weitere Informationen zu dieser Bibliothek finden Sie auf der offiziellen [Dokumentationsseite](https://wwebjs.dev/).

## Funktionen

- Echtzeit-Überwachung eines Verzeichnisses auf neue Bilder
- Automatischer Versand von Bildern an eine definierte WhatsApp-Gruppe
- Verschieben der gesendeten Bilder in ein separates Verzeichnis
- Lokale Sitzungspeicherung per whatsapp-web.js `LocalAuth` (kein MongoDB erforderlich)
- Anpassbare Einstellungen für Verzeichnispfade, Chat-Namen und Dateityp

Bitte beachten Sie: SnapShotter ist für den persönlichen Gebrauch gedacht. Achten Sie darauf, dass Sie die Nutzungsbedingungen von WhatsApp respektieren und die notwendigen Genehmigungen einholen, bevor Sie Inhalte senden.

## Erste Schritte

1. Abhängigkeiten installieren: `npm install`
2. `src/config.js` anpassen:
   - `chatName`: Name des WhatsApp-Chats bzw. der Gruppe, an den/die gesendet wird
   - `readDir` / `saveDir`: Verzeichnisse zum Überwachen bzw. Verschieben gesendeter Dateien
   - `fileExtension`: zu verarbeitender Dateityp (Standard `.jpg`)
3. Skript starten: `node src/SnapShotter.js`
   - Die WhatsApp-Sitzung wird lokal gespeichert (Ordner `.wwebjs_auth`)

Ergänzend: [upcam-client](https://github.com/gzeuner/upcam-client) zum Herunterladen von Bildern von upcam Tornado Pro und kompatiblen Geräten.

# Besuchen Sie

[tiny-tool.de](https://tiny-tool.de/).

Viel Spaß!
