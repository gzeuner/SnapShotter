'use strict';

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
 * Disclaimer: personal use only; respect WhatsApp Terms of Service.
*/

const fs = require('fs').promises;
const fileTools = require('fs-extra');
const path = require('path');
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const chokidar = require('chokidar');
const config = require('./config');

// -----------------------------------------------------------------------------
// Client setup
// -----------------------------------------------------------------------------

const client = new Client({
  puppeteer: {
    headless: process.env.HEADLESS !== 'false', // set HEADLESS=false to view the browser
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    timeout: 120_000 // increased Puppeteer timeout for launch
  },
  // Use the latest WhatsApp Web version (requires whatsapp-web.js >= 1.24.0)
  webVersionCache: {
    type: 'remote',
    remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/latest.html',
  },

  authStrategy: new LocalAuth({ dataPath: './.wwebjs_auth' }), // local session storage
  takeoverOnConflict: true,
  takeoverTimeoutMs: 60_000
});

let chatId = null; // target chat id for images
let sendQueue = Promise.resolve(); // serial send queue

// -----------------------------------------------------------------------------
// Event logging (register before initialize!)
// -----------------------------------------------------------------------------

client.on('qr', (qr) => {
  qrcode.generate(qr, { small: true });
  console.log('[QR] QR Code generated');
});

client.on('authenticated', () => {
  console.log('[AUTH] Authenticated with WhatsApp Web');
  bootstrapAfterConnect(); // fallback bootstrap if ready is missed
});

client.on('auth_failure', (msg) => {
  console.error('[AUTH] Authentication failure:', msg);
});

client.on('loading_screen', (percent, message) => {
  console.log(`[LOAD] ${percent}% - ${message}`);
});

client.on('change_state', (state) => {
  console.log('[STATE] Client state:', state);
  if (state === 'CONNECTED') bootstrapAfterConnect();
});

client.on('ready', () => {
  console.log('[READY] Client is ready!');
  safeStartWorkers();
});

client.on('disconnected', (reason) => {
  console.log('[DISC] Client was logged out:', reason);
});

// -----------------------------------------------------------------------------
// Start
// -----------------------------------------------------------------------------

client.initialize();

// -----------------------------------------------------------------------------
// Bootstrap & worker start
// -----------------------------------------------------------------------------

let workersStarted = false;

async function bootstrapAfterConnect() {
  if (workersStarted) return;
  const maxTries = 30;
  const waitMs = 1_000;
  for (let i = 1; i <= maxTries; i++) {
    try {
      const state = await client.getState();
      console.log(`[BOOT] Try ${i}/${maxTries} - state: ${state}`);
      if (state === 'CONNECTED') {
        safeStartWorkers();
        return;
      }
    } catch (e) {
      console.warn('[BOOT] getState failed:', e.message);
    }
    await delay(waitMs);
  }
  console.error('[BOOT] Gave up waiting for CONNECTED.');
}

async function safeStartWorkers() {
  if (workersStarted) return;
  workersStarted = true;
  try {
    await ensureDirs();
    await waitForWWebInjection(); // ensure window.Store is injected
    await waitForWWebJS();        // ensure WWebJS.getChat exists
    await patchSendSeen();        // avoid WA Web regression crashing sendMessage
    await processChats();
  } catch (e) {
    console.error('[START] Failed to start workers:', e);
    workersStarted = false; // try again on next CONNECTED
  }
}

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

// -----------------------------------------------------------------------------
// Injection waiters
// -----------------------------------------------------------------------------

async function waitForWWebInjection(timeoutMs = 120_000) {  // extended timeout
  try {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        // Accessing the Puppeteer page (unofficial but pragmatic)
        const ok = await client.pupPage.evaluate(() => {
          const s = window.Store;
          return !!(s && s.Chat && s.Msg && s.Conn);
        });
        if (ok) {
          console.log('[INJECT] Store detected.');
          return;
        }
      } catch (_) {
        // ignore and retry
      }
      await delay(500);
    }
    throw new Error('Store injection timeout');
  } catch (e) {
    console.error('[INJECT] waitForWWebInjection failed:', e.message);
    throw e;
  }
}

// Wait until the wweb.js helper object exists (needed for sendMessage)
async function waitForWWebJS(timeoutMs = 120_000) {  // extended timeout
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const ok = await client.pupPage.evaluate(() => {
        const w = window.WWebJS;
        return !!(w && typeof w.getChat === 'function');
      });
      if (ok) {
        console.log('[INJECT] WWebJS helpers detected.');
        return;
      }
    } catch (_) { /* ignore */ }
    await delay(500);
  }
  console.error('[INJECT] waitForWWebJS timed out - aborting.');
  throw new Error('WWebJS injection timeout');
}

// Work around WA Web regressions in sendSeen
async function patchSendSeen() {
  await client.pupPage.evaluate(() => {
    if (!window.WWebJS || !window.WWebJS.sendSeen) return;
    const current = window.WWebJS.sendSeen;
    if (current._patched) return;
    const wrapped = async (chat) => {
      try {
        if (!chat || !chat.id) return null;
        return await current(chat);
      } catch (_) {
        return null;
      }
    };
    wrapped._patched = true;
    window.WWebJS.sendSeen = wrapped;
  });
}

// -----------------------------------------------------------------------------
// Chats & watcher
// -----------------------------------------------------------------------------

async function processChats() {
  console.log('[CHATS] resolving chat id...');
  const id = await resolveChatIdByName(config.chatName);
  if (id) {
    chatId = id;
    console.log(`[CHATS] Chat "${config.chatName}" -> id: ${chatId}`);
    console.log('[CHATS] Waiting for new Images ...');
    watchDirectory(config.readDir);
  } else {
    const names = await listChatNames(25);
    console.warn(`[CHATS] Chat "${config.chatName}" NOT found.`);
    if (names.length) console.warn(`[CHATS] Available (first ${names.length}): ${names.join(', ')}`);
  }
}

// Helpers that directly access window.Store (avoids getChats)
async function resolveChatIdByName(name) {
  return client.pupPage.evaluate((needle) => {
    const S = window.Store;
    if (!S || !S.Chat) return null;
    const arr = (S.Chat.getModelsArray && S.Chat.getModelsArray()) || S.Chat._models || S.Chat.models || [];
    const list = Array.isArray(arr) ? arr : (arr && arr.toArray ? arr.toArray() : []);
    const norm = (s) => (s || '').normalize('NFC');
    const eq = (a, b) => a === b || a.localeCompare(b, undefined, { sensitivity: 'base' }) === 0;

    for (const c of list) {
      const title = norm(c && (c.formattedTitle || c.name || (c.contact && c.contact.pushname) || (c.id && c.id.user)));
      if (title && eq(title, norm(needle))) {
        const id = c && c.id;
        if (!id) continue;
        return id._serialized || (id.user && id.server ? `${id.user}@${id.server}` : null);
      }
    }
    return null;
  }, name);
}

async function listChatNames(limit = 25) {
  const names = await client.pupPage.evaluate((limit) => {
    const S = window.Store;
    if (!S || !S.Chat) return [];
    const arr = (S.Chat.getModelsArray && S.Chat.getModelsArray()) || S.Chat._models || S.Chat.models || [];
    const list = Array.isArray(arr) ? arr : (arr && arr.toArray ? arr.toArray() : []);
    const out = [];
    for (const c of list) {
      const title = c && (c.formattedTitle || c.name || (c.contact && c.contact.pushname) || (c.id && c.id.user));
      if (title) out.push(String(title));
      if (out.length >= limit) break;
    }
    return out;
  }, limit);
  return names;
}

function watchDirectory(directory) {
  const watcher = chokidar.watch(directory, {
    // ignore dotfiles (works on Windows/Mac/Linux)
    ignored: /(^|[\/\\])\../,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 800, pollInterval: 100 }
  });

  watcher.on('add', async (filePath) => {
    const file = path.basename(filePath);
    const ext = path.extname(file).toLowerCase();
    if (ext === String(config.fileExtension).toLowerCase() && await isWritable(filePath)) {
      try {
        await processFile(filePath);
      } catch (e) {
        console.error('[WATCHER] processFile error:', e);
      }
    }
  });

  watcher.on('error', (err) => console.error('[WATCHER] error:', err));
}


// -----------------------------------------------------------------------------
// File processing
// -----------------------------------------------------------------------------

async function processFile(filePath) {
  // process serially to avoid race conditions with web injection
  await enqueueSend(async () => {
    await sendImage(filePath);
    await moveFile(filePath);
  });
}

function enqueueSend(taskFn) {
  const next = sendQueue.then(taskFn, taskFn);
  // don't let errors kill the chain
  sendQueue = next.catch(() => {});
  return next;
}

async function sendImage(image) {
  if (!chatId) throw new Error('chatId not set');
  console.log('[SEND] Image > ' + image);
  const media = MessageMedia.fromFilePath(image);

  const maxTries = 6;
  for (let i = 1; i <= maxTries; i++) {
    try {
      await patchSendSeen();
      await client.sendMessage(chatId, media);
      return;
    } catch (e) {
      const msg = String((e && e.message) || e);
      console.warn(`[SEND] attempt ${i}/${maxTries} failed: ${msg}`);
      // If WWebJS helper (getChat) is missing, ensure it and retry
      if (/getChat/i.test(msg) || /WWebJS/i.test(msg)) {
        await waitForWWebJS();
      }
      await delay(1000);
      if (i === maxTries) throw e;
    }
  }
}

async function moveFile(filePath) {
  const destination = path.join(config.saveDir, path.basename(filePath));
  await fileTools.move(filePath, destination, { overwrite: true });
  console.log('[MOVE] Image -> ' + destination);
}

async function isWritable(filePath) {
  let fileHandle;
  try {
    fileHandle = await fs.open(filePath, 'r+');
    return true;
  } catch (err) {
    console.log('[IO] Cannot open file:', err.message);
    return false;
  } finally {
    if (fileHandle) await fileHandle.close();
  }
}

async function ensureDirs() {
  const dirs = [config.readDir, config.saveDir];
  for (const d of dirs) {
    await fileTools.ensureDir(d);
  }
}

// -----------------------------------------------------------------------------
// Graceful shutdown
// -----------------------------------------------------------------------------

process.on('SIGINT', async () => {
  console.log('[SYS] Caught SIGINT - closing WhatsApp client...');
  try { await client.destroy(); } catch (_) {}
  process.exit(0);
});
