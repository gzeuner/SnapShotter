# SnapShotter

SnapShotter is a Node.js script that enables automatic notification of surveillance images via WhatsApp. Once new images are detected in a specified directory, the script automatically sends these to a designated WhatsApp group. Upon successful transmission, the script moves the images to a separate archive directory.

The script utilizes [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js), a powerful library that facilitates interaction with WhatsApp Web. For more information on this library, check out the official [documentation page](https://wwebjs.dev/).

## Features

- Real-time monitoring of a directory for new images
- Automatic sending of images to a defined WhatsApp group
- Moving of sent images to a separate directory
- Integration with MongoDB for storing session data, allowing reconnection to WhatsApp without repeated QR code scanning
- Customizable settings for directory paths, MongoDB connection, and other key parameters

Please note: SnapShotter is intended for personal use. Ensure to respect WhatsApp's terms of service and obtain necessary permissions before sending content.

## Getting Started

To get started, clone this repository, install the necessary dependencies with `npm install`, and update the `config.js` file with your specific details. Start the script with `node script.js`.

Happy monitoring!

---

# SnapShotter

SnapShotter ist ein Node.js-Skript, das die automatische Benachrichtigung von Überwachungsbildern über WhatsApp ermöglicht. Sobald neue Bilder in einem bestimmten Verzeichnis erkannt werden, sendet das Skript diese automatisch an eine spezifizierte WhatsApp-Gruppe. Nach erfolgreichem Versand verschiebt das Skript die Bilder in ein separates Archivverzeichnis.

Das Skript verwendet [whatsapp-web.js](https://github.com/pedroslopez/whatsapp-web.js), eine leistungsstarke Bibliothek, die die Interaktion mit WhatsApp Web ermöglicht. Weitere Informationen zu dieser Bibliothek finden Sie auf der offiziellen [Dokumentationsseite](https://wwebjs.dev/).

## Funktionen

- Echtzeit-Überwachung eines Verzeichnisses auf neue Bilder
- Automatischer Versand von Bildern an eine definierte WhatsApp-Gruppe
- Verschieben der gesendeten Bilder in ein separates Verzeichnis
- Integration mit MongoDB zur Speicherung von Sitzungsdaten, ermöglicht erneute Verbindung mit WhatsApp ohne wiederholtes Scannen von QR-Codes
- Anpassbare Einstellungen für Verzeichnispfade, MongoDB-Verbindung und weitere Schlüsselparameter

Bitte beachten Sie: SnapShotter ist für den persönlichen Gebrauch gedacht. Achten Sie darauf, dass Sie die Nutzungsbedingungen von WhatsApp respektieren und die notwendigen Genehmigungen einholen, bevor Sie Inhalte senden.

## Erste Schritte

Um loszulegen, klonen Sie dieses Repository, installieren Sie notwendigen Abhängigkeiten mit `npm install` und aktualisieren Sie die `config.js` Datei mit Ihren spezifischen Angaben. Starten Sie das Skript mit `node script.js`.

Viel Spaß bei der Überwachung!