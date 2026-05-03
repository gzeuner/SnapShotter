'use strict';

const fs = require('fs');
const path = require('path');
const util = require('util');

const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100
};

const WHATSAPP_PREFIXES = new Set([
  'WA',
  'AUTH',
  'CLIENT',
  'STATE',
  'LOAD',
  'READY',
  'DISC',
  'LOGOUT',
  'QR',
  'RECONNECT',
  'RECOVERY',
  'PROBE',
  'INJECT',
  'CHATS',
  'SEND'
]);

function normalizeLevelName(value, fallback = 'info') {
  const normalized = String(value || '').trim().toLowerCase();
  return Object.prototype.hasOwnProperty.call(LEVELS, normalized) ? normalized : fallback;
}

function levelValue(name) {
  return LEVELS[normalizeLevelName(name)];
}

function detectChannel(message) {
  const match = /^\[([A-Z]+)\]/.exec(String(message || ''));
  if (!match) {
    return 'app';
  }
  return WHATSAPP_PREFIXES.has(match[1]) ? 'whatsapp' : 'app';
}

function timestamp() {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

function formatLine(levelName, channel, message) {
  return `${timestamp()} ${levelName.toUpperCase().padEnd(5)} ${channel.toUpperCase().padEnd(8)} ${message}`;
}

function ensureLogFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (!fs.existsSync(filePath)) {
    fs.closeSync(fs.openSync(filePath, 'a'));
  }
  return filePath;
}

function initializeLogging(input = {}) {
  const config = {
    dir: path.resolve(input.dir || './logs'),
    consoleLevel: normalizeLevelName(input.consoleLevel, 'info'),
    appLevel: normalizeLevelName(input.appLevel, 'info'),
    whatsappLevel: normalizeLevelName(input.whatsappLevel, 'info'),
    appFile: String(input.appFile || 'snapshotter-app.log'),
    whatsappFile: String(input.whatsappFile || 'snapshotter-whatsapp.log')
  };

  const original = {
    log: console.log.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console)
  };

  const writers = {
    app: ensureLogFile(path.join(config.dir, config.appFile)),
    whatsapp: ensureLogFile(path.join(config.dir, config.whatsappFile))
  };

  const route = (method, args) => {
    const levelName = method === 'log' ? 'info' : normalizeLevelName(method, 'info');
    const message = util.format(...args);
    const channel = detectChannel(message);
    const line = formatLine(levelName, channel, message);

    const fileThreshold = channel === 'whatsapp' ? config.whatsappLevel : config.appLevel;
    if (levelValue(levelName) >= levelValue(fileThreshold)) {
      fs.appendFileSync(writers[channel], `${line}\n`, 'utf8');
    }

    if (levelValue(levelName) >= levelValue(config.consoleLevel)) {
      if (levelValue(levelName) >= levelValue('warn')) {
        original.error(line);
      } else {
        original.log(line);
      }
    }
  };

  console.log = (...args) => route('log', args);
  console.info = (...args) => route('info', args);
  console.warn = (...args) => route('warn', args);
  console.error = (...args) => route('error', args);
  console.debug = (...args) => route('debug', args);

  const close = () => {
    return undefined;
  };

  process.once('exit', close);
  process.once('SIGINT', close);
  process.once('SIGTERM', close);

  return {
    close,
    config,
    detectChannel
  };
}

module.exports = {
  LEVELS,
  detectChannel,
  formatLine,
  initializeLogging,
  normalizeLevelName
};
