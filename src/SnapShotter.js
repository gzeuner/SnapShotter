// Requiring necessary modules and config file
const fs = require('fs').promises;
const fileTools = require('fs-extra');
const path = require('path');
const qrcode = require('qrcode-terminal');
const { Client, RemoteAuth, MessageMedia } = require('whatsapp-web.js');
const { MongoStore } = require('wwebjs-mongo');
const mongoose = require('mongoose');
const config = require('./config');

let upcamChat;
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
            upcamChat = c;
            setTimeout(processImageFiles, config.waitInMs);
            break;
        }
    }
}


async function processImageFiles() {
    console.log('Waiting for new Images....');
    const files = await fs.readdir(config.readDir);
    files.sort();

    for (const file of files) {
        try {
            await processFile(file);
        } catch (err) {
            console.error(`Error processing file ${file}:`, err);
        }
    }

    setTimeout(processImageFiles, config.waitInMs);
}

async function processFile(file) {
    const fileDetails = await fs.lstat(path.resolve(config.readDir, file));
    if (fileDetails.isDirectory()) {
        console.log('Directory: ' + file);
    } else if (path.extname(file) === '.jpg' && isWritable(config.readDir + file)) {
        await sendImage(config.readDir + file);
        await moveFile(file);
    }
}

async function sendImage(image) {
    console.log('Sending Image > ' + image);
    const media = MessageMedia.fromFilePath(image);
    return upcamChat.sendMessage(media);
}

async function moveFile(file) {
    await fileTools.move(config.readDir + file, config.saveDir + file, { overwrite: true });
    console.log("Moved image > : " + config.saveDir + file);
}

function isWritable(filePath) {
    try {
        fs.closeSync(fs.openSync(filePath, 'r+'));
        return true;
    } catch (err) {
        console.log('Cannot open file!');
        return false;
    }
}
