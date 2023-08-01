/*
* MIT License
* 
* Copyright (c) 2023 gzeuner
* 
* Permission is hereby granted, free of charge, to any person obtaining a copy
* of this software and associated documentation files (the "Software"), to deal
* in the Software without restriction, including without limitation the rights
* to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
* copies of the Software, and to permit persons to whom the Software is
* furnished to do so, subject to the following conditions:

* The above copyright notice and this permission notice shall be included in all
* copies or substantial portions of the Software.

* THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
* IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
* FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
* AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
* LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
* OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
* SOFTWARE.
*/

/*
 * SnapShotter: Automating surveillance image notifications
 * through WhatsApp using Node.js and the whatsapp-web.js library.
*/
// Requiring necessary modules and config file
const fs = require('fs').promises;
const fileTools = require('fs-extra');
const path = require('path');
const qrcode = require('qrcode-terminal');
const { Client, RemoteAuth, MessageMedia } = require('whatsapp-web.js');
const { MongoStore } = require('wwebjs-mongo');
const mongoose = require('mongoose');
const config = require('./config');
const chokidar = require('chokidar');

let chatGroup;
let client;

mongoose.connect(config.MONGODB_URI).then(initializeClient);

async function initializeClient() {
    const store = new MongoStore({ mongoose: mongoose });
    await store.sessionExists({ session: config.sessionName });

    client = new Client({ 
        authStrategy: new RemoteAuth({
            store: store,
            backupSyncIntervalMs: 300000
        })
    });

    client.initialize();
    client.on('remote_session_saved', () => console.log('remote_session_saved'));
    client.on('qr', (qr) => qrcode.generate(qr, { small: true }));
    client.on('ready', processChats);
}

async function processChats() {
    console.log('Client is ready!');
    const chats = await client.getChats(); 
    for (let c of chats) {
        if (c.name === config.chatName) {
            console.log(`Chat ${config.chatName} found.`);
            chatGroup = c;
            console.log("Waiting for new Images ...");
            watchDirectory(config.readDir);
            break;
        }
    }
}

function watchDirectory(directory) {
    const watcher = chokidar.watch(directory, {
        ignored: /(^|[\/\\])\../, // ignore dotfiles
        persistent: true
    });

    watcher.on('add', async (filePath) => {
        const file = path.basename(filePath);
        if (path.extname(file) === config.fileExtension && await isWritable(filePath)) {
            await processFile(filePath);
        }
    });
}

async function processFile(filePath) {
    await sendImage(filePath);
    await moveFile(filePath);
}

async function sendImage(image) {
    console.log('Sending Image > ' + image);
    const media = MessageMedia.fromFilePath(image);
    return chatGroup.sendMessage(media);
}

async function moveFile(filePath) {
    const destination = path.join(config.saveDir, path.basename(filePath));
    await fileTools.move(filePath, destination, { overwrite: true });
    console.log("Moved image > : " + destination);
}

async function isWritable(filePath) {
    let fileHandle;
    try {
        fileHandle = await fs.open(filePath, 'r+');
        return true;
    } catch (err) {
        console.log('Cannot open file!');
        return false;
    } finally {
        if (fileHandle) {
            // Close the file if it was opened
            await fileHandle.close();
        }
    }
}
