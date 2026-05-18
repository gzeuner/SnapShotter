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
const fsSync = require('fs');
const { execFile } = require('child_process');
const fileTools = require('fs-extra');
const path = require('path');
const qrcode = require('qrcode-terminal');
const { promisify } = require('util');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const { LoadUtils } = require('whatsapp-web.js/src/util/Injected/Utils');
const { version: whatsappWebJsVersion } = require('whatsapp-web.js/package.json');
const chokidar = require('chokidar');
const config = require('./config');
const { DataCollector } = require('./dataCollector');
const { initializeLogging } = require('./logger');
const { MotionEventDetector } = require('./motionDetector');
const { RuntimeSupervisor } = require('./runtimeSupervisor');
const { SerialTaskQueue } = require('./serialTaskQueue');
const {
  WHATSAPP_STATUS,
  RECOVERY_STEPS,
  computeRecoveryStep,
  formatWhatsAppCaption,
  planBrowserSessionCleanup,
  pickMessageTimestamp,
  pruneRecoveryHistory,
  requiresManualAuth
} = require('./whatsappSupport');

process.setMaxListeners(25);
const execFileAsync = promisify(execFile);

const isDryRun = process.argv.includes('--dry-run');
const loggingConfig = buildLoggingConfig(config);
initializeLogging(loggingConfig);

// ---------------------------------------------------------------------------
// Single instance lock
// ---------------------------------------------------------------------------

const LOCK_DIR = path.resolve('.lock');
const LOCK_FILE = path.join(LOCK_DIR, 'snapshotter.lock');
let lockFd = null;

function isPidRunning(pid) {
  if (!pid || !Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

function acquireProcessLock() {
  try {
    fsSync.mkdirSync(LOCK_DIR, { recursive: true });
    lockFd = fsSync.openSync(LOCK_FILE, 'wx');
    fsSync.writeFileSync(lockFd, String(process.pid));
    return true;
  } catch (e) {
    if (e && e.code === 'EEXIST') {
      try {
        const pidStr = fsSync.readFileSync(LOCK_FILE, 'utf8').trim();
        const pid = Number(pidStr);
        if (pid && !isPidRunning(pid)) {
          fsSync.unlinkSync(LOCK_FILE);
          return acquireProcessLock();
        }
      } catch (_) {}
      console.error('[LOCK] Already running (lockfile exists).');
      return false;
    }
    console.error('[LOCK] Failed to acquire lock:', e.message || e);
    return false;
  }
}

function releaseProcessLock() {
  try {
    if (lockFd) fsSync.closeSync(lockFd);
  } catch (_) {}
  lockFd = null;
  try {
    if (fsSync.existsSync(LOCK_FILE)) fsSync.unlinkSync(LOCK_FILE);
  } catch (_) {}
}

if (!acquireProcessLock()) {
  process.exit(0);
}

console.log(
  `[SYS] logging initialized dir=${path.resolve(loggingConfig.dir)} ` +
  `appLevel=${loggingConfig.appLevel} whatsappLevel=${loggingConfig.whatsappLevel} consoleLevel=${loggingConfig.consoleLevel}`
);

// -----------------------------------------------------------------------------
// Variablen
// -----------------------------------------------------------------------------

let client = null;
let chatId = null;
const processingQueue = new SerialTaskQueue();
const notificationQueue = new SerialTaskQueue();
let runtimeHeartbeat = null;
let workersStarted = false;
let watcherStarted = false;
let messagingBootstrapped = false;
let messagingBootstrapping = false;
let authEstablished = false;
let isShuttingDown = false;
let reconnectAttempts = 0;
let isInitializing = false;
let initializingPromise = null;
let isReadyFired = false;
let reconnectTimer = null;
let reconnectTimerOptions = null;
let readyWatchdogTimer = null;
let chatResolvePromise = null;
let recoveryPromise = null;
let lastHealthCheckAt = 0;
let forceAuthResetOnNextConnect = false;
let shutdownPromise = null;
const filterStateOperation = new SerialTaskQueue();
const pendingNotificationRetryTimers = new Map();
const pendingNotificationRetryState = new Map();
const outboundMessageState = new Map();
const MAX_RECONNECT_ATTEMPTS = 8;

const imageFilterConfig = buildImageFilterConfig(config);
const runtimeConfig = buildRuntimeConfig(config);
const whatsappConfig = buildWhatsAppConfig(config, runtimeConfig);
const dataCollector = new DataCollector(config.dataCollection || {});
const motionDetector = new MotionEventDetector(imageFilterConfig);
const runtimeSupervisor = new RuntimeSupervisor(runtimeConfig);
const FILTER_STATE_DIR = path.resolve('.state');
const FILTER_STATE_FILE = path.join(FILTER_STATE_DIR, 'image_filter_state.json');
const WHATSAPP_AUTH_DIR = path.resolve('.wwebjs_auth');
const WHATSAPP_CLIENT_ID = 'upcam';
const DEFAULT_WWEB_REMOTE_CACHE_PATH = 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/latest.html';
const CHROMIUM_SINGLETON_ARTIFACTS = ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'DevToolsActivePort'];
let filterStateCache = null;
let dryRunStateOverride = null;
let motionDetectorBootstrapped = false;
const whatsappHealth = createWhatsAppHealthState();

// -----------------------------------------------------------------------------
// Client mit stabiler Reconnect-Logik
// -----------------------------------------------------------------------------

function envBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function getWhatsAppSessionDir() {
  return path.join(WHATSAPP_AUTH_DIR, `session-${WHATSAPP_CLIENT_ID}`);
}

async function execFileQuiet(file, args, options = {}) {
  try {
    return await execFileAsync(file, args, {
      windowsHide: true,
      timeout: options.timeoutMs || 15_000,
      maxBuffer: options.maxBuffer || (1024 * 1024),
      env: options.env ? Object.assign({}, process.env, options.env) : process.env
    });
  } catch (error) {
    return {
      stdout: error.stdout || '',
      stderr: error.stderr || '',
      error
    };
  }
}

async function terminateProcessTree(pid, reason = 'unknown') {
  if (!pid || !Number.isFinite(pid) || !isPidRunning(pid)) {
    return false;
  }

  try {
    if (process.platform === 'win32') {
      await execFileQuiet('taskkill', ['/PID', String(pid), '/T', '/F'], { timeoutMs: 15_000 });
    } else {
      process.kill(pid, 'SIGKILL');
    }
  } catch (_) {}

  for (let attempt = 0; attempt < 20; attempt++) {
    if (!isPidRunning(pid)) {
      console.warn(`[CLIENT] Browser-Prozess beendet pid=${pid} reason=${reason}`);
      return true;
    }
    await delay(250);
  }

  console.warn(`[CLIENT] Browser-Prozess lässt sich nicht beenden pid=${pid} reason=${reason}`);
  return !isPidRunning(pid);
}

async function findBrowserProcessesForSessionDir(sessionDir) {
  if (!sessionDir || process.platform !== 'win32') {
    return [];
  }

  const script = [
    "$target = $env:SNAPSHOTTER_SESSION_DIR",
    "Get-CimInstance Win32_Process |",
    "Where-Object {",
    "  $_.CommandLine -and",
    "  ($_.Name -match '^(chrome|chromium|msedge)(\\.exe)?$') -and",
    "  $_.CommandLine.IndexOf($target, [System.StringComparison]::OrdinalIgnoreCase) -ge 0",
    "} |",
    "Select-Object -ExpandProperty ProcessId"
  ].join(' ');

  const result = await execFileQuiet(
    'powershell',
    ['-NoProfile', '-Command', script],
    {
      timeoutMs: 20_000,
      env: { SNAPSHOTTER_SESSION_DIR: sessionDir }
    }
  );

  return String(result.stdout || '')
    .split(/\r?\n/)
    .map((line) => Number(String(line).trim()))
    .filter((pid) => Number.isFinite(pid) && pid > 0);
}

async function removeChromiumSingletonArtifacts(sessionDir) {
  let removed = 0;
  for (const name of CHROMIUM_SINGLETON_ARTIFACTS) {
    const target = path.join(sessionDir, name);
    if (!await fileTools.pathExists(target)) {
      continue;
    }
    await fileTools.remove(target);
    removed += 1;
    console.warn(`[CLIENT] Entferne Chromium-Lockartefakt ${target}`);
  }
  return removed;
}

async function terminateGlobalBrowserProcesses(reason = 'unknown') {
  if (process.platform !== 'win32') {
    return;
  }

  for (const imageName of ['chrome.exe', 'chromium.exe', 'msedge.exe']) {
    await execFileQuiet('taskkill', ['/F', '/IM', imageName, '/T'], { timeoutMs: 12_000 });
  }

  console.warn(`[CLIENT] Globaler Browser-Kill ausgeführt reason=${reason}`);
}

async function cleanupWhatsAppBrowserSession(options = {}) {
  const sessionDir = getWhatsAppSessionDir();
  if (!await fileTools.pathExists(sessionDir)) {
    return;
  }

  const reason = options.reason || 'cleanup';
  console.warn(`[CLIENT] Session-Cleanup gestartet reason=${reason} sessionDir=${sessionDir}`);
  const pids = new Set();
  if (Number.isFinite(options.browserPid) && options.browserPid > 0) {
    pids.add(options.browserPid);
  }
  for (const pid of await findBrowserProcessesForSessionDir(sessionDir)) {
    pids.add(pid);
  }

  if (options.forceTerminate) {
    for (const pid of pids) {
      await terminateProcessTree(pid, reason);
    }
    await delay(800);
  }

  let remainingPids = await findBrowserProcessesForSessionDir(sessionDir);
  if (remainingPids.length > 0 && options.forceTerminate && process.platform === 'win32') {
    console.warn(
      `[CLIENT] Browser-Profillock bleibt aktiv, starte globalen Fallback reason=${reason} pids=${remainingPids.join(',')}`
    );
    await terminateGlobalBrowserProcesses(reason);
    await delay(1_200);
    remainingPids = await findBrowserProcessesForSessionDir(sessionDir);
  }

  if (remainingPids.length > 0) {
    console.warn(
      `[CLIENT] Browser-Profillock weiterhin aktiv reason=${reason} sessionDir=${sessionDir} pids=${remainingPids.join(',')}`
    );
    return;
  }

  const removedArtifacts = await removeChromiumSingletonArtifacts(sessionDir);
  console.log(`[CLIENT] Session-Cleanup abgeschlossen reason=${reason} removedArtifacts=${removedArtifacts}`);
}

function createClient() {
  const takeoverOnConflict = envBool(process.env.WHATSAPP_TAKEOVER_ON_CONFLICT, true);
  const webCacheType = String(process.env.WHATSAPP_WEB_CACHE_TYPE || 'remote').trim().toLowerCase() || 'remote';
  const webCacheRemotePath = String(
    process.env.WHATSAPP_WEB_CACHE_REMOTE_PATH || DEFAULT_WWEB_REMOTE_CACHE_PATH
  ).trim() || DEFAULT_WWEB_REMOTE_CACHE_PATH;
  const webVersionCache = webCacheType === 'remote'
    ? {
      type: 'remote',
      remotePath: webCacheRemotePath
    }
    : { type: webCacheType };

  return new Client({
    puppeteer: {
      headless: process.env.HEADLESS !== 'false',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-gpu',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-zygote',
        '--no-first-run',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows'
      ],
      timeout: 0,
      protocolTimeout: Math.max(30_000, whatsappConfig.protocolTimeoutMs || 120_000),
      handleSIGINT: false,
      handleSIGTERM: false
    },
    authStrategy: new LocalAuth({
      clientId: WHATSAPP_CLIENT_ID,
      dataPath: WHATSAPP_AUTH_DIR
    }),
    webVersionCache,
    takeoverOnConflict,
    takeoverTimeoutMs: takeoverOnConflict ? 60_000 : 0
  });
}

function createWhatsAppHealthState() {
  return {
    status: WHATSAPP_STATUS.DISCONNECTED,
    reason: 'startup',
    connectionState: 'NOT_INITIALIZED',
    appState: null,
    hasSynced: null,
    browserAlive: false,
    browserConnected: false,
    browserPid: null,
    pageAlive: false,
    qrVisible: false,
    ready: false,
    authEstablished: false,
    messagingReady: false,
    sessionInvalid: false,
    lastQrAt: 0,
    authInterventionRequiredAt: 0,
    authInterventionReason: null,
    chatResolved: false,
    lastChatResolveAt: 0,
    lastChatResolveFailureAt: 0,
    lastChatResolveError: null,
    lastUpdateAt: 0,
    lastReadyAt: 0,
    lastHealthCheckAt: 0,
    lastHealthCheckOkAt: 0,
    lastSendAttemptAt: 0,
    lastVerifiedSendAt: 0,
    lastMediaSendAttemptAt: 0,
    lastTextSendAttemptAt: 0,
    lastVerifiedMediaSendAt: 0,
    lastVerifiedTextSendAt: 0,
    lastAckAt: 0,
    lastMediaAckAt: 0,
    lastTextAckAt: 0,
    lastFailureAt: 0,
    lastFailureReason: null,
    lastRecoveryAt: 0,
    lastRecoveryMode: null,
    lastRecoveryStep: null,
    lastRecoveryReason: null,
    recoveryHistory: [],
    reconnectAttempts: 0,
    clientRecreationAttempts: 0,
    browserRestartAttempts: 0,
    authResetAttempts: 0,
    clientStartedAt: 0,
    lastInitializeStartAt: 0,
    lastInitializeSuccessAt: 0,
    lastInitializeFailureAt: 0,
    lastInitializeFailureReason: null,
    consecutiveInitializeFailures: 0,
    lastMessageId: null,
    lastVerificationMethod: null,
    lastAckValue: null,
    lastUnverifiedSendAt: 0,
    lastUnverifiedReason: null,
    lastUnverifiedMessageId: null,
    consecutiveUnverifiedSends: 0,
    lastMediaMessageId: null,
    lastTextMessageId: null,
    lastVerifiedMediaMessageId: null,
    lastVerifiedTextMessageId: null,
    lastMediaVerificationMethod: null,
    lastTextVerificationMethod: null,
    lastMediaSendStatus: 'unknown',
    lastTextSendStatus: 'unknown',
    lastMediaUploadAt: 0,
    lastProbeAt: 0,
    lastProbeReason: null,
    consecutiveUnverifiedMediaSends: 0,
    consecutiveFailedMediaSends: 0,
    consecutiveUnverifiedTextSends: 0,
    consecutiveFailedTextSends: 0
  };
}

function getBrowserProcessId(clientInstance = client) {
  try {
    return clientInstance && clientInstance.pupBrowser && typeof clientInstance.pupBrowser.process === 'function'
      ? clientInstance.pupBrowser.process()?.pid || null
      : null;
  } catch (_) {
    return null;
  }
}

function isBrowserConnected(clientInstance = client) {
  try {
    return !!(clientInstance && clientInstance.pupBrowser && clientInstance.pupBrowser.isConnected());
  } catch (_) {
    return false;
  }
}

function isPageAlive(clientInstance = client) {
  try {
    const page = clientInstance && clientInstance.pupPage;
    return !!(page && (typeof page.isClosed !== 'function' || !page.isClosed()));
  } catch (_) {
    return false;
  }
}

function deriveWhatsAppStatus(snapshot = null) {
  if (whatsappHealth.sessionInvalid || isSessionInvalidState(snapshot && snapshot.appState ? snapshot.appState : whatsappHealth.appState)) {
    return WHATSAPP_STATUS.AUTH_INVALID;
  }
  if (whatsappHealth.lastRecoveryStep) {
    return WHATSAPP_STATUS.RECOVERING;
  }
  if (!whatsappHealth.browserAlive || !whatsappHealth.pageAlive) {
    return WHATSAPP_STATUS.DISCONNECTED;
  }
  if (
    whatsappHealth.lastTextSendStatus === 'verified'
    && (
      whatsappHealth.lastMediaSendStatus === 'failed'
      || whatsappHealth.lastMediaSendStatus === 'unverified'
      || whatsappHealth.consecutiveUnverifiedMediaSends >= Math.max(1, runtimeConfig.maxConsecutiveUnverifiedSends || 2)
    )
  ) {
    return WHATSAPP_STATUS.MEDIA_SEND_BROKEN;
  }
  if (
    whatsappHealth.consecutiveUnverifiedMediaSends >= Math.max(1, runtimeConfig.maxConsecutiveUnverifiedSends || 2)
    || whatsappHealth.consecutiveFailedMediaSends >= Math.max(1, whatsappConfig.maxRetries || runtimeConfig.notificationMaxRetries || 3)
  ) {
    return WHATSAPP_STATUS.SESSION_STALE;
  }
  if (
    whatsappHealth.ready
    && whatsappHealth.authEstablished
    && whatsappHealth.messagingReady
    && whatsappHealth.browserAlive
    && whatsappHealth.pageAlive
    && whatsappHealth.chatResolved
    && snapshot
    && !snapshot.error
    && snapshot.hasStore
    && snapshot.hasWWebJS
    && snapshot.hasSendMessage
    && snapshot.hasSendSeen
  ) {
    return WHATSAPP_STATUS.READY;
  }
  return WHATSAPP_STATUS.DEGRADED;
}

function updateWhatsAppHealth(status, reason, extra = {}) {
  const now = Date.now();
  const previousStatus = whatsappHealth.status;
  const previousConnectionState = whatsappHealth.connectionState;

  whatsappHealth.browserConnected = isBrowserConnected();
  whatsappHealth.pageAlive = isPageAlive();
  whatsappHealth.browserAlive = whatsappHealth.browserConnected && whatsappHealth.pageAlive;
  whatsappHealth.browserPid = getBrowserProcessId();
  whatsappHealth.reconnectAttempts = reconnectAttempts;
  Object.assign(whatsappHealth, extra);
  whatsappHealth.lastUpdateAt = now;
  if (reason) {
    whatsappHealth.reason = reason;
  }
  if (status === WHATSAPP_STATUS.READY) {
    whatsappHealth.lastReadyAt = now;
  }
  whatsappHealth.status = status || deriveWhatsAppStatus();

  if (
    previousStatus !== whatsappHealth.status
    || previousConnectionState !== whatsappHealth.connectionState
    || reason
  ) {
    console.log(
      `[WA] health=${whatsappHealth.status} conn=${whatsappHealth.connectionState} app=${whatsappHealth.appState || '-'} ` +
      `page=${whatsappHealth.pageAlive} auth=${whatsappHealth.authEstablished} msg=${whatsappHealth.messagingReady} ` +
      `manualAuth=${isAwaitingManualAuth() ? 'true' : 'false'} ` +
      `media=${whatsappHealth.lastMediaSendStatus} text=${whatsappHealth.lastTextSendStatus} initFails=${whatsappHealth.consecutiveInitializeFailures} ` +
      `reason=${reason || whatsappHealth.reason || '-'}`
    );
  }
}

function markWhatsAppConnected(reason, extra = {}) {
  updateWhatsAppHealth(WHATSAPP_STATUS.READY, reason, extra);
}

function markWhatsAppDegraded(reason, extra = {}) {
  updateWhatsAppHealth(WHATSAPP_STATUS.DEGRADED, reason, extra);
}

function markWhatsAppDisconnected(reason, extra = {}) {
  updateWhatsAppHealth(WHATSAPP_STATUS.DISCONNECTED, reason, extra);
}

function markWhatsAppRecovering(reason, extra = {}) {
  updateWhatsAppHealth(WHATSAPP_STATUS.RECOVERING, reason, extra);
}

function markWhatsAppAuthInvalid(reason, extra = {}) {
  updateWhatsAppHealth(WHATSAPP_STATUS.AUTH_INVALID, reason, extra);
}

function markWhatsAppMediaBroken(reason, extra = {}) {
  updateWhatsAppHealth(WHATSAPP_STATUS.MEDIA_SEND_BROKEN, reason, extra);
}

function markWhatsAppSessionStale(reason, extra = {}) {
  updateWhatsAppHealth(WHATSAPP_STATUS.SESSION_STALE, reason, extra);
}

function isAwaitingManualAuth(extra = {}) {
  return requiresManualAuth({
    status: extra.status === undefined ? whatsappHealth.status : extra.status,
    connectionState: extra.connectionState === undefined ? whatsappHealth.connectionState : extra.connectionState,
    appState: extra.appState === undefined ? whatsappHealth.appState : extra.appState,
    pageAlive: extra.pageAlive === undefined ? whatsappHealth.pageAlive : extra.pageAlive,
    qrVisible: extra.qrVisible === undefined ? whatsappHealth.qrVisible : extra.qrVisible
  });
}

function buildAuthInterventionExtra(reason, extra = {}) {
  const now = Date.now();
  const normalizedConnectionState = String(extra.connectionState || whatsappHealth.connectionState || '').toUpperCase();
  const normalizedAppState = String(extra.appState || whatsappHealth.appState || '').toUpperCase();
  const qrVisible = extra.qrVisible === undefined
    ? (
      whatsappHealth.qrVisible
      || normalizedConnectionState === 'QR'
      || (
        !!(extra.pageAlive === undefined ? whatsappHealth.pageAlive : extra.pageAlive)
        && (normalizedAppState === 'UNPAIRED' || normalizedAppState === 'UNPAIRED_IDLE')
      )
    )
    : !!extra.qrVisible;
  const authInterventionRequiredAt = whatsappHealth.authInterventionRequiredAt || now;

  return Object.assign({
    qrVisible,
    lastQrAt: qrVisible ? (whatsappHealth.lastQrAt || now) : whatsappHealth.lastQrAt,
    authInterventionRequiredAt,
    authInterventionReason: reason,
    sessionInvalid: true
  }, extra);
}

function clearAuthInterventionExtra(extra = {}) {
  return Object.assign({
    qrVisible: false,
    lastQrAt: whatsappHealth.lastQrAt,
    authInterventionRequiredAt: 0,
    authInterventionReason: null,
    sessionInvalid: false
  }, extra);
}

function getWhatsAppHealthSnapshot() {
  return {
    status: whatsappHealth.status,
    reason: whatsappHealth.reason,
    connectionState: whatsappHealth.connectionState,
    appState: whatsappHealth.appState,
    hasSynced: whatsappHealth.hasSynced,
    browserAlive: !!whatsappHealth.browserAlive,
    browserConnected: !!whatsappHealth.browserConnected,
    browserPid: whatsappHealth.browserPid,
    pageAlive: !!whatsappHealth.pageAlive,
    qrVisible: !!whatsappHealth.qrVisible,
    ready: !!whatsappHealth.ready,
    authEstablished: !!whatsappHealth.authEstablished,
    messagingReady: !!whatsappHealth.messagingReady,
    sessionInvalid: !!whatsappHealth.sessionInvalid,
    manualAuthRequired: isAwaitingManualAuth(),
    lastQrAt: toIso(whatsappHealth.lastQrAt),
    authInterventionRequiredAt: toIso(whatsappHealth.authInterventionRequiredAt),
    authInterventionReason: whatsappHealth.authInterventionReason,
    chatResolved: !!whatsappHealth.chatResolved,
    lastChatResolveAt: toIso(whatsappHealth.lastChatResolveAt),
    lastChatResolveFailureAt: toIso(whatsappHealth.lastChatResolveFailureAt),
    lastChatResolveError: whatsappHealth.lastChatResolveError,
    lastUpdateAt: toIso(whatsappHealth.lastUpdateAt),
    lastReadyAt: toIso(whatsappHealth.lastReadyAt),
    lastHealthCheckAt: toIso(whatsappHealth.lastHealthCheckAt),
    lastHealthCheckOkAt: toIso(whatsappHealth.lastHealthCheckOkAt),
    lastSendAttemptAt: toIso(whatsappHealth.lastSendAttemptAt),
    lastVerifiedSendAt: toIso(whatsappHealth.lastVerifiedSendAt),
    lastMediaSendAttemptAt: toIso(whatsappHealth.lastMediaSendAttemptAt),
    lastTextSendAttemptAt: toIso(whatsappHealth.lastTextSendAttemptAt),
    lastVerifiedMediaSendAt: toIso(whatsappHealth.lastVerifiedMediaSendAt),
    lastVerifiedTextSendAt: toIso(whatsappHealth.lastVerifiedTextSendAt),
    lastAckAt: toIso(whatsappHealth.lastAckAt),
    lastMediaAckAt: toIso(whatsappHealth.lastMediaAckAt),
    lastTextAckAt: toIso(whatsappHealth.lastTextAckAt),
    lastFailureAt: toIso(whatsappHealth.lastFailureAt),
    lastFailureReason: whatsappHealth.lastFailureReason,
    lastUnverifiedSendAt: toIso(whatsappHealth.lastUnverifiedSendAt),
    lastUnverifiedReason: whatsappHealth.lastUnverifiedReason,
    lastUnverifiedMessageId: whatsappHealth.lastUnverifiedMessageId,
    consecutiveUnverifiedSends: whatsappHealth.consecutiveUnverifiedSends,
    consecutiveUnverifiedMediaSends: whatsappHealth.consecutiveUnverifiedMediaSends,
    consecutiveFailedMediaSends: whatsappHealth.consecutiveFailedMediaSends,
    consecutiveUnverifiedTextSends: whatsappHealth.consecutiveUnverifiedTextSends,
    consecutiveFailedTextSends: whatsappHealth.consecutiveFailedTextSends,
    lastRecoveryAt: toIso(whatsappHealth.lastRecoveryAt),
    lastRecoveryMode: whatsappHealth.lastRecoveryMode,
    lastRecoveryStep: whatsappHealth.lastRecoveryStep,
    lastRecoveryReason: whatsappHealth.lastRecoveryReason,
    reconnectAttempts: whatsappHealth.reconnectAttempts,
    clientRecreationAttempts: whatsappHealth.clientRecreationAttempts,
    browserRestartAttempts: whatsappHealth.browserRestartAttempts,
    authResetAttempts: whatsappHealth.authResetAttempts,
    clientStartedAt: toIso(whatsappHealth.clientStartedAt),
    lastInitializeStartAt: toIso(whatsappHealth.lastInitializeStartAt),
    lastInitializeSuccessAt: toIso(whatsappHealth.lastInitializeSuccessAt),
    lastInitializeFailureAt: toIso(whatsappHealth.lastInitializeFailureAt),
    lastInitializeFailureReason: whatsappHealth.lastInitializeFailureReason,
    consecutiveInitializeFailures: whatsappHealth.consecutiveInitializeFailures,
    lastMessageId: whatsappHealth.lastMessageId,
    lastVerificationMethod: whatsappHealth.lastVerificationMethod,
    lastAckValue: normalizeAck(whatsappHealth.lastAckValue),
    lastMediaMessageId: whatsappHealth.lastMediaMessageId,
    lastTextMessageId: whatsappHealth.lastTextMessageId,
    lastVerifiedMediaMessageId: whatsappHealth.lastVerifiedMediaMessageId,
    lastVerifiedTextMessageId: whatsappHealth.lastVerifiedTextMessageId,
    lastMediaVerificationMethod: whatsappHealth.lastMediaVerificationMethod,
    lastTextVerificationMethod: whatsappHealth.lastTextVerificationMethod,
    lastMediaSendStatus: whatsappHealth.lastMediaSendStatus,
    lastTextSendStatus: whatsappHealth.lastTextSendStatus,
    lastMediaUploadAt: toIso(whatsappHealth.lastMediaUploadAt),
    lastProbeAt: toIso(whatsappHealth.lastProbeAt),
    lastProbeReason: whatsappHealth.lastProbeReason
  };
}

function clearRecoveryState() {
  whatsappHealth.lastRecoveryStep = null;
}

function recordRecoveryAttempt(step, reason) {
  const now = Date.now();
  whatsappHealth.lastRecoveryAt = now;
  whatsappHealth.lastRecoveryStep = step;
  whatsappHealth.lastRecoveryReason = reason;
  whatsappHealth.recoveryHistory = pruneRecoveryHistory(
    (whatsappHealth.recoveryHistory || []).concat([{ step, reason, at: now }]),
    now,
    runtimeConfig.recoveryEscalationWindowMs || (10 * 60 * 1000)
  );
}

function pruneOutboundMessageState(now = Date.now()) {
  for (const [messageId, detail] of outboundMessageState.entries()) {
    if (!detail || !detail.at || (now - detail.at) > (2 * 60 * 60 * 1000)) {
      outboundMessageState.delete(messageId);
    }
  }
}

function registerOutboundMessage(messageId, detail = {}) {
  if (!messageId) {
    return;
  }
  pruneOutboundMessageState();
  outboundMessageState.set(messageId, Object.assign({
    at: Date.now(),
    kind: 'media'
  }, detail));
}

function getOutboundMessageDetail(messageOrId) {
  const messageId = typeof messageOrId === 'string'
    ? messageOrId
    : extractMessageId(messageOrId);
  if (!messageId) {
    return null;
  }
  return outboundMessageState.get(messageId) || null;
}

function markChatResolutionSuccess(chatIdValue) {
  whatsappHealth.chatResolved = true;
  whatsappHealth.lastChatResolveAt = Date.now();
  whatsappHealth.lastChatResolveError = null;
  void chatIdValue;
}

function markChatResolutionFailure(error) {
  whatsappHealth.chatResolved = false;
  whatsappHealth.lastChatResolveFailureAt = Date.now();
  whatsappHealth.lastChatResolveError = error ? (error.message || String(error)) : 'chat_resolve_failed';
}

function recordVerifiedSend(kind, detail = {}) {
  const now = Date.now();
  whatsappHealth.lastVerifiedSendAt = now;
  whatsappHealth.lastMessageId = detail.messageId || whatsappHealth.lastMessageId;
  whatsappHealth.lastVerificationMethod = detail.verificationMethod || whatsappHealth.lastVerificationMethod;
  whatsappHealth.lastAckValue = normalizeAck(detail.ack);
  whatsappHealth.lastUnverifiedSendAt = 0;
  whatsappHealth.lastUnverifiedReason = null;
  whatsappHealth.lastUnverifiedMessageId = null;
  whatsappHealth.consecutiveUnverifiedSends = 0;

  if (kind === 'text') {
    whatsappHealth.lastVerifiedTextSendAt = now;
    whatsappHealth.lastTextMessageId = detail.messageId || whatsappHealth.lastTextMessageId;
    whatsappHealth.lastVerifiedTextMessageId = detail.messageId || whatsappHealth.lastVerifiedTextMessageId;
    whatsappHealth.lastTextVerificationMethod = detail.verificationMethod || whatsappHealth.lastTextVerificationMethod;
    whatsappHealth.lastTextSendStatus = 'verified';
    whatsappHealth.consecutiveUnverifiedTextSends = 0;
    whatsappHealth.consecutiveFailedTextSends = 0;
  } else {
    whatsappHealth.lastVerifiedMediaSendAt = now;
    whatsappHealth.lastMediaMessageId = detail.messageId || whatsappHealth.lastMediaMessageId;
    whatsappHealth.lastVerifiedMediaMessageId = detail.messageId || whatsappHealth.lastVerifiedMediaMessageId;
    whatsappHealth.lastMediaVerificationMethod = detail.verificationMethod || whatsappHealth.lastMediaVerificationMethod;
    whatsappHealth.lastMediaSendStatus = 'verified';
    whatsappHealth.consecutiveUnverifiedMediaSends = 0;
    whatsappHealth.consecutiveFailedMediaSends = 0;
  }
}

function recordUnverifiedSend(kind, detail = {}) {
  const now = Date.now();
  whatsappHealth.lastFailureAt = now;
  whatsappHealth.lastFailureReason = detail.failureReason || whatsappHealth.lastFailureReason;
  whatsappHealth.lastAckValue = normalizeAck(detail.ack);
  whatsappHealth.lastVerificationMethod = detail.verificationMethod || whatsappHealth.lastVerificationMethod;
  whatsappHealth.lastUnverifiedSendAt = now;
  whatsappHealth.lastUnverifiedReason = detail.failureReason || 'send_unverified';
  whatsappHealth.lastUnverifiedMessageId = detail.messageId || whatsappHealth.lastUnverifiedMessageId;
  whatsappHealth.consecutiveUnverifiedSends += 1;

  if (kind === 'text') {
    whatsappHealth.lastTextSendStatus = 'unverified';
    whatsappHealth.lastTextMessageId = detail.messageId || whatsappHealth.lastTextMessageId;
    whatsappHealth.consecutiveUnverifiedTextSends += 1;
  } else {
    whatsappHealth.lastMediaSendStatus = 'unverified';
    whatsappHealth.lastMediaMessageId = detail.messageId || whatsappHealth.lastMediaMessageId;
    whatsappHealth.consecutiveUnverifiedMediaSends += 1;
  }
}

function recordFailedSend(kind, detail = {}) {
  const now = Date.now();
  whatsappHealth.lastFailureAt = now;
  whatsappHealth.lastFailureReason = detail.failureReason || whatsappHealth.lastFailureReason;
  whatsappHealth.lastAckValue = normalizeAck(detail.ack);
  whatsappHealth.lastVerificationMethod = detail.verificationMethod || whatsappHealth.lastVerificationMethod;

  if (kind === 'text') {
    whatsappHealth.lastTextSendStatus = 'failed';
    whatsappHealth.lastTextMessageId = detail.messageId || whatsappHealth.lastTextMessageId;
    whatsappHealth.consecutiveFailedTextSends += 1;
  } else {
    whatsappHealth.lastMediaSendStatus = 'failed';
    whatsappHealth.lastMediaMessageId = detail.messageId || whatsappHealth.lastMediaMessageId;
    whatsappHealth.consecutiveFailedMediaSends += 1;
  }
}

async function removeAuthSessionDir() {
  const sessionDir = getWhatsAppSessionDir();
  await fileTools.remove(sessionDir);
}

async function destroyClientInstance(clientInstance, options = {}) {
  if (!clientInstance) {
    return;
  }

  const browserPid = getBrowserProcessId(clientInstance);
  let destroyFailed = false;
  try {
    await withTimeout(Promise.resolve(clientInstance.destroy()), 10_000, 'client.destroy');
    await delay(2_000);
  } catch (_) {
    destroyFailed = true;
  }

  if (browserPid && isPidRunning(browserPid)) {
    await terminateProcessTree(
      browserPid,
      options.forceBrowserRestart || destroyFailed ? 'destroy_force_restart' : 'destroy_browser_still_running'
    );
  }
}

function normalizeReconnectOptions(options = {}) {
  return {
    forceBrowserRestart: !!options.forceBrowserRestart,
    resetAuth: !!options.resetAuth
  };
}

function formatReconnectOptions(options = {}) {
  const normalized = normalizeReconnectOptions(options);
  return `forceBrowserRestart=${normalized.forceBrowserRestart} resetAuth=${normalized.resetAuth}`;
}

function mergeReconnectOptions(currentOptions = {}, nextOptions = {}) {
  const current = normalizeReconnectOptions(currentOptions);
  const next = normalizeReconnectOptions(nextOptions);
  return {
    forceBrowserRestart: current.forceBrowserRestart || next.forceBrowserRestart || next.resetAuth,
    resetAuth: current.resetAuth || next.resetAuth
  };
}

function recordInitializeStart() {
  whatsappHealth.lastInitializeStartAt = Date.now();
  whatsappHealth.lastInitializeFailureReason = null;
}

function recordInitializeSuccess() {
  whatsappHealth.lastInitializeSuccessAt = Date.now();
  whatsappHealth.lastInitializeFailureReason = null;
  whatsappHealth.consecutiveInitializeFailures = 0;
}

function recordInitializeFailure(error) {
  whatsappHealth.lastInitializeFailureAt = Date.now();
  whatsappHealth.lastInitializeFailureReason = error ? (error.message || String(error)) : 'initialize_failed';
  whatsappHealth.consecutiveInitializeFailures += 1;
}

function computeInitializeRecoveryOptions(baseOptions = {}, error = null) {
  const normalized = normalizeReconnectOptions(baseOptions);
  const message = String(error?.message || error || '').toLowerCase();
  const timeoutLike = message.includes('timeout');
  const browserRestart = normalized.forceBrowserRestart
    || normalized.resetAuth
    || timeoutLike
    || isTransientBrowserError(error)
    || whatsappHealth.consecutiveInitializeFailures >= 2;
  const resetAuth = !!whatsappConfig.allowSessionDataReset && (
    normalized.resetAuth
    || whatsappHealth.sessionInvalid
  );

  return {
    forceBrowserRestart: browserRestart || resetAuth,
    resetAuth
  };
}

function shouldRemoveAuthSession(reconnectOptions = {}) {
  const resetRequested = !!(reconnectOptions.resetAuth || forceAuthResetOnNextConnect);
  if (!resetRequested) {
    return false;
  }

  if (!whatsappConfig.allowSessionDataReset) {
    console.warn(
      `[AUTH] blocked automatic LocalAuth session removal ` +
      `requestedReset=${!!reconnectOptions.resetAuth} pendingReset=${forceAuthResetOnNextConnect}`
    );
    forceAuthResetOnNextConnect = false;
    return false;
  }

  return true;
}

async function startOrReconnectClient(options = {}) {
  if (isShuttingDown || isInitializing) return;

  if (initializingPromise) {
    console.log('[CLIENT] Warte auf laufenden Initialisierungs-Vorgang...');
    return initializingPromise;
  }

  isInitializing = true;
  initializingPromise = (async () => {
    const reconnectOptions = normalizeReconnectOptions(options);
    const previousClient = client;
    const previousBrowserPid = getBrowserProcessId(previousClient);
    clearReadyWatchdog();
    client = null;
    chatId = null;
    messagingBootstrapped = false;
    messagingBootstrapping = false;
    authEstablished = false;
    isReadyFired = false;
    markWhatsAppRecovering('reinitializing_client', {
      browserAlive: false,
      browserConnected: false,
      pageAlive: false,
      ready: false,
      authEstablished: false,
      messagingReady: false,
      connectionState: 'RECONNECTING'
    });

    if (previousClient) {
      console.log('[CLIENT] Alten Client sauber beenden...');
      await destroyClientInstance(previousClient, reconnectOptions);
    }

    const cleanupPlan = planBrowserSessionCleanup({
      startup: reconnectAttempts === 0 && !previousClient,
      hasClient: !!previousClient,
      forceBrowserRestart: reconnectOptions.forceBrowserRestart,
      lastInitializeFailureReason: whatsappHealth.lastInitializeFailureReason,
      lastFailureReason: whatsappHealth.lastFailureReason
    });
    if (cleanupPlan.required) {
      await cleanupWhatsAppBrowserSession({
        reason: cleanupPlan.reason,
        browserPid: previousBrowserPid,
        forceTerminate: cleanupPlan.forceTerminate
      });
    }

    if (shouldRemoveAuthSession(reconnectOptions)) {
      console.warn('[CLIENT] Entferne gespeicherte LocalAuth-Session vor Neuaufbau.');
      await removeAuthSessionDir();
      forceAuthResetOnNextConnect = false;
      whatsappHealth.authResetAttempts += 1;
    }

    console.log(
      `[CLIENT] cwd=${process.cwd()} authDir=${WHATSAPP_AUTH_DIR} clientId=${WHATSAPP_CLIENT_ID} ` +
      `wwebjs=${whatsappWebJsVersion} webCache=${String(process.env.WHATSAPP_WEB_CACHE_TYPE || 'remote').trim().toLowerCase() || 'remote'} ` +
      `takeoverOnConflict=${envBool(process.env.WHATSAPP_TAKEOVER_ON_CONFLICT, true)} ` +
      `autoSessionReset=${whatsappConfig.allowSessionDataReset} forceReconnectAfterMinutes=${whatsappConfig.forceReconnectAfterMinutes}`
    );
    console.log(`[CLIENT] ${reconnectAttempts > 0 ? `Reconnect Versuch ${reconnectAttempts}` : 'Starte WhatsApp Client'}...`);

    reconnectTimer = null;
    reconnectTimerOptions = null;
    const nextClient = createClient();
    client = nextClient;
    if (reconnectOptions.forceBrowserRestart) {
      whatsappHealth.browserRestartAttempts += 1;
    }
    if (previousClient || reconnectOptions.forceBrowserRestart) {
      whatsappHealth.clientRecreationAttempts += 1;
    }
    recordInitializeStart();
    markWhatsAppRecovering('client_initialize', {
      browserAlive: false,
      browserConnected: false,
      pageAlive: false,
      ready: false,
      authEstablished: false,
      messagingReady: false,
      connectionState: 'INITIALIZING',
      appState: null,
      hasSynced: null,
      sessionInvalid: false,
      clientStartedAt: Date.now()
    });
    registerClientEvents(nextClient);
    console.log('[CLIENT] Event-Listener f�r neue Client-Instanz registriert');

    console.log(
      `[CLIENT] initialize_start timeout=${whatsappConfig.initializeTimeoutMs || 180_000}ms ` +
      `${formatReconnectOptions(reconnectOptions)}`
    );
    try {
      await withTimeout(
        Promise.resolve(nextClient.initialize()),
        Math.max(30_000, whatsappConfig.initializeTimeoutMs || 180_000),
        'client.initialize'
      );
      if (client !== nextClient) return;
      recordInitializeSuccess();
      console.log('[CLIENT] initialize_returned awaiting_ready_event=true');
    } catch (err) {
      if (client !== nextClient) return;
      const error = err instanceof Error ? err : new Error(String(err));
      recordInitializeFailure(error);
      const nextReconnectOptions = computeInitializeRecoveryOptions(reconnectOptions, error);
      console.error('[CLIENT] Initialize fehlgeschlagen:', error.message);
      console.warn(
        `[CLIENT] initialize_recovery consecutiveFailures=${whatsappHealth.consecutiveInitializeFailures} ` +
        `${formatReconnectOptions(nextReconnectOptions)}`
      );
      await destroyClientInstance(nextClient, { forceBrowserRestart: nextReconnectOptions.forceBrowserRestart });
      if (client === nextClient) {
        client = null;
      }
      markWhatsAppDisconnected('initialize_failed', {
        browserAlive: false,
        browserConnected: false,
        pageAlive: false,
        ready: false,
        authEstablished: false,
        messagingReady: false,
        lastFailureAt: whatsappHealth.lastInitializeFailureAt,
        lastFailureReason: whatsappHealth.lastInitializeFailureReason
      });
      scheduleReconnect(
        nextReconnectOptions.forceBrowserRestart ? 3_000 : 8_000,
        'initialize_failed',
        nextReconnectOptions
      );
    }
  })();

  try {
    await initializingPromise;
  } finally {
    isInitializing = false;
    initializingPromise = null;
  }
}

function scheduleReconnectLegacy(delayMs = 8000) {
  if (isShuttingDown || reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    console.error('[CLIENT] Maximale Reconnect-Versuche erreicht.');
    process.exit(1);
  }

  if (reconnectTimer) {
    console.log('[RECONNECT] Bereits geplant, kein weiterer Timer gesetzt.');
    return;
  }

  reconnectAttempts++;
  console.log(`[RECONNECT] N�chster Versuch in ${delayMs/1000}s (Versuch ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
  
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    startOrReconnectClient().catch(console.error);
  }, delayMs);
}

function scheduleReconnect(delayMs = 8000, reason = 'scheduled_reconnect', options = {}) {
  if (isShuttingDown) {
    return;
  }
  if (!whatsappConfig.enableAutoReconnect) {
    console.error(`[RECONNECT] Auto reconnect disabled; skipped (${reason}).`);
    return;
  }

  if (reconnectTimer) {
    reconnectTimerOptions = mergeReconnectOptions(reconnectTimerOptions, options);
    console.log(
      `[RECONNECT] Bereits geplant, kein weiterer Timer gesetzt. ` +
      `${formatReconnectOptions(reconnectTimerOptions)}`
    );
    return;
  }

  reconnectAttempts++;
  const exhausted = reconnectAttempts > MAX_RECONNECT_ATTEMPTS;
  const effectiveDelayMs = exhausted ? Math.max(delayMs, 60_000) : delayMs;
  reconnectTimerOptions = normalizeReconnectOptions(options);
  if (exhausted) {
    console.error('[CLIENT] Maximale Reconnect-Versuche �berschritten, bleibe aktiv und nutze Backoff statt Prozessende.');
  }
  markWhatsAppDisconnected(reason, {
    browserAlive: false,
    browserConnected: false,
    pageAlive: false,
    ready: false,
    authEstablished: false,
    messagingReady: false,
    connectionState: 'RECONNECT_SCHEDULED'
  });
  console.log(
    `[RECONNECT] Nächster Versuch in ${effectiveDelayMs / 1000}s ` +
    `(Versuch ${reconnectAttempts}/${Math.max(MAX_RECONNECT_ATTEMPTS, reconnectAttempts)}) ` +
    `${formatReconnectOptions(reconnectTimerOptions)}`
  );

  reconnectTimer = setTimeout(() => {
    const scheduledOptions = reconnectTimerOptions || {};
    reconnectTimer = null;
    reconnectTimerOptions = null;
    startOrReconnectClient(scheduledOptions).catch(console.error);
  }, effectiveDelayMs);
}

function isTransientBrowserError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  const stack = String(error?.stack || '').toLowerCase();

  return (
    message.includes('execution context was destroyed') ||
    message.includes('target closed') ||
    message.includes('session closed') ||
    message.includes('navigat') ||
    message.includes('protocol error') ||
    stack.includes('puppeteer') ||
    stack.includes('whatsapp-web.js')
  );
}

function handleTransientBrowserError(source, error) {
  if (isShuttingDown || !isTransientBrowserError(error)) {
    return false;
  }

  const message = error?.message || String(error);
  console.warn(`[CLIENT] ${source}: transient browser error: ${message}`);
  chatId = null;
  messagingBootstrapped = false;
  messagingBootstrapping = false;
  authEstablished = false;
  isReadyFired = false;
  markWhatsAppDegraded(`transient_browser_error:${source}`, {
    browserAlive: false,
    browserConnected: false,
    pageAlive: false,
    ready: false,
    authEstablished: false,
    messagingReady: false
  });
  scheduleReconnect(3000, `transient_browser_error:${source}`, { forceBrowserRestart: true });
  return true;
}

function clearReadyWatchdog() {
  if (readyWatchdogTimer) clearTimeout(readyWatchdogTimer);
  readyWatchdogTimer = null;
}

async function snapshotClientState(clientInstance) {
  try {
    const page = ensureActiveClient(clientInstance, 'snapshotClientState');
    return await withTimeout(page.evaluate(() => ({
      href: window.location.href,
      hasStore: !!window.Store,
      hasWWebJS: !!window.WWebJS,
      hasGetChat: !!window.WWebJS?.getChat,
      hasSendMessage: !!window.WWebJS?.sendMessage,
      hasSendSeen: !!window.WWebJS?.sendSeen,
      appState: window.AuthStore?.AppState?.state || null,
      hasSynced: window.AuthStore?.AppState?.hasSynced ?? null,
      online: navigator.onLine
    })), 5_000, 'snapshotClientState');
  } catch (error) {
    return { error: error?.message || String(error) };
  }
}

function hasMessagingHelpers(snapshot = {}) {
  return !!(
    snapshot.hasStore
    && snapshot.hasWWebJS
    && snapshot.hasGetChat
    && snapshot.hasSendMessage
    && snapshot.hasSendSeen
  );
}

function isBootstrapRepairCandidate(snapshot = {}) {
  if (!snapshot || snapshot.error || !snapshot.hasStore || isSessionInvalidState(snapshot.appState)) {
    return false;
  }

  const appState = String(snapshot.appState || '').toUpperCase();
  const connectedOrSynced = appState === 'CONNECTED' || snapshot.hasSynced === true;
  return connectedOrSynced && (!hasMessagingHelpers(snapshot) || !messagingBootstrapped || !authEstablished);
}

async function tryRepairMessagingBootstrap(reason, clientInstance = client, snapshot = null) {
  const activeClient = clientInstance || client;
  if (!activeClient || isDryRun || isShuttingDown) {
    return false;
  }

  const initialSnapshot = snapshot && !snapshot.error ? snapshot : await snapshotClientState(activeClient);
  if (!isBootstrapRepairCandidate(initialSnapshot)) {
    return false;
  }

  console.warn(
    `[INJECT] bootstrap_repair_start reason=${reason} ` +
    `app=${initialSnapshot.appState || '-'} synced=${initialSnapshot.hasSynced} ` +
    `hasStore=${!!initialSnapshot.hasStore} hasWWebJS=${!!initialSnapshot.hasWWebJS}`
  );

  try {
    await bootstrapMessaging(activeClient);
    const repairedSnapshot = await snapshotClientState(activeClient);
    if (repairedSnapshot.error || !hasMessagingHelpers(repairedSnapshot)) {
      console.warn(
        `[INJECT] bootstrap_repair_incomplete reason=${reason} ` +
        `${JSON.stringify(repairedSnapshot)}`
      );
      return false;
    }

    authEstablished = true;
    messagingBootstrapped = true;
    isReadyFired = true;
    reconnectAttempts = 0;
    clearRecoveryState();
    markWhatsAppConnected(`bootstrap_repair_ok:${reason}`, clearAuthInterventionExtra({
      browserAlive: true,
      browserConnected: isBrowserConnected(activeClient),
      pageAlive: isPageAlive(activeClient),
      connectionState: 'CONNECTED',
      authEstablished: true,
      messagingReady: true,
      appState: repairedSnapshot.appState || 'CONNECTED',
      hasSynced: repairedSnapshot.hasSynced ?? null
    }));
    return true;
  } catch (error) {
    console.warn(`[INJECT] bootstrap_repair_failed reason=${reason}: ${error.message || error}`);
    return false;
  }
}

function isSessionInvalidState(state) {
  const value = String(state || '').toUpperCase();
  return value === 'LOGOUT' || value.startsWith('UNPAIRED');
}

function deriveHealthStatusFromSnapshot(snapshot) {
  if (!snapshot || snapshot.error) {
    return WHATSAPP_STATUS.DISCONNECTED;
  }
  if (isSessionInvalidState(snapshot.appState)) {
    return WHATSAPP_STATUS.AUTH_INVALID;
  }
  if (hasMessagingHelpers(snapshot) && authEstablished && messagingBootstrapped) {
    return WHATSAPP_STATUS.READY;
  }
  return WHATSAPP_STATUS.DEGRADED;
}

async function refreshWhatsAppHealth(reason = 'health_check') {
  if (isDryRun || isShuttingDown) {
    return null;
  }
  if (!client) {
    markWhatsAppDisconnected(reason, {
      browserAlive: false,
      browserConnected: false,
      pageAlive: false,
      ready: false,
      authEstablished: false,
      messagingReady: false
    });
    return null;
  }

  const snapshot = await snapshotClientState(client);
  whatsappHealth.lastHealthCheckAt = Date.now();
  if (snapshot && !snapshot.error) {
    const status = deriveWhatsAppStatus(snapshot);
    const base = {
      browserAlive: true,
      browserConnected: isBrowserConnected(client),
      pageAlive: isPageAlive(client),
      ready: isReadyFired,
      authEstablished,
      messagingReady: messagingBootstrapped,
      appState: snapshot.appState || null,
      hasSynced: snapshot.hasSynced ?? null
    };
    if (status === WHATSAPP_STATUS.READY) {
      whatsappHealth.lastHealthCheckOkAt = Date.now();
      markWhatsAppConnected(reason, clearAuthInterventionExtra(Object.assign({ connectionState: 'CONNECTED' }, base)));
    } else if (status === WHATSAPP_STATUS.MEDIA_SEND_BROKEN) {
      markWhatsAppMediaBroken(reason, Object.assign({
        connectionState: whatsappHealth.connectionState || 'CONNECTED'
      }, base));
    } else if (status === WHATSAPP_STATUS.SESSION_STALE) {
      markWhatsAppSessionStale(reason, Object.assign({
        connectionState: whatsappHealth.connectionState || 'CONNECTED'
      }, base));
    } else if (status === WHATSAPP_STATUS.DEGRADED) {
      markWhatsAppDegraded(reason, Object.assign({
        connectionState: whatsappHealth.connectionState || 'DEGRADED'
      }, base));
    } else if (status === WHATSAPP_STATUS.AUTH_INVALID) {
      markWhatsAppAuthInvalid(reason, Object.assign({
        connectionState: whatsappHealth.connectionState || 'AUTH_INVALID',
        sessionInvalid: true
      }, base));
    } else {
      markWhatsAppDisconnected(reason, Object.assign({
        connectionState: whatsappHealth.connectionState || 'DISCONNECTED',
        sessionInvalid: isSessionInvalidState(snapshot.appState)
      }, base));
    }
  } else {
    markWhatsAppDisconnected(reason, {
      browserAlive: false,
      browserConnected: false,
      pageAlive: false,
      ready: false,
      authEstablished: false,
      messagingReady: false
    });
  }

  return snapshot;
}

async function attemptAppReloadRecovery(reason) {
  const activeClient = client;
  if (!activeClient) {
    return false;
  }

  console.warn(`[RECOVERY] step=app_reload reason=${reason}`);
  chatId = null;
  messagingBootstrapped = false;
  messagingBootstrapping = false;
  authEstablished = false;
  isReadyFired = false;
  recordRecoveryAttempt('app_reload', reason);
  markWhatsAppRecovering(`app_reload:${reason}`, {
    browserAlive: true,
    browserConnected: isBrowserConnected(activeClient),
    pageAlive: isPageAlive(activeClient),
    ready: false,
    authEstablished: false,
    messagingReady: false
  });

  try {
    if (typeof activeClient.resetState === 'function') {
      await withTimeout(activeClient.resetState(), 10_000, 'resetState');
    }
    const page = ensureActiveClient(activeClient, 'attemptSoftRecovery');
    await withTimeout(page.reload({ waitUntil: 'load' }), Math.max(15_000, runtimeConfig.sendTimeoutMs || 45_000), 'softRecoveryReload');
    if (client !== activeClient) {
      return false;
    }
    await bootstrapMessaging(activeClient);
    const snapshot = await snapshotClientState(activeClient);
    if (snapshot.error || deriveHealthStatusFromSnapshot(snapshot) === WHATSAPP_STATUS.DISCONNECTED) {
      throw new Error(snapshot.error || `soft_recovery_not_ready:${snapshot.appState || 'unknown'}`);
    }

    authEstablished = true;
    messagingBootstrapped = true;
    isReadyFired = true;
    reconnectAttempts = 0;
    whatsappHealth.lastRecoveryMode = 'app_reload';
    clearRecoveryState();
    markWhatsAppConnected(`soft_recovery_ok:${reason}`, clearAuthInterventionExtra({
      connectionState: 'CONNECTED',
      appState: snapshot.appState || 'CONNECTED',
      hasSynced: snapshot.hasSynced ?? null
    }));
    return true;
  } catch (error) {
    console.warn(`[RECOVERY] app_reload failed (${reason}): ${error.message || error}`);
    markWhatsAppDegraded(`soft_recovery_failed:${reason}`, {
      browserAlive: isBrowserConnected(activeClient) && isPageAlive(activeClient),
      browserConnected: isBrowserConnected(activeClient),
      pageAlive: isPageAlive(activeClient),
      ready: false,
      authEstablished: false,
      messagingReady: false
    });
    return false;
  }
}

async function attemptClientRecreateRecovery(reason, options = {}) {
  console.warn(`[RECOVERY] step=client_recreate reason=${reason}`);
  recordRecoveryAttempt('client_recreate', reason);
  whatsappHealth.lastRecoveryMode = 'client_recreate';
  markWhatsAppRecovering(`client_recreate:${reason}`, {
    browserAlive: false,
    browserConnected: false,
    pageAlive: false,
    ready: false,
    authEstablished: false,
    messagingReady: false
  });
  await startOrReconnectClient({ forceBrowserRestart: !!options.forceBrowserRestart, resetAuth: !!options.resetAuth });
  await waitForMessagingReady(runtimeConfig.sendTimeoutMs || 45_000);
  clearRecoveryState();
  return true;
}

async function attemptBrowserRestartRecovery(reason) {
  console.warn(`[RECOVERY] step=browser_restart reason=${reason}`);
  recordRecoveryAttempt('browser_restart', reason);
  whatsappHealth.lastRecoveryMode = 'browser_restart';
  return attemptClientRecreateRecovery(reason, { forceBrowserRestart: true });
}

function isAuthRecoveryReason(reason = '') {
  const normalized = String(reason || '').toLowerCase();
  return normalized === 'session_invalid'
    || normalized === 'auth_failure'
    || normalized === 'logout'
    || normalized === 'qr_required'
    || normalized.startsWith('auth_wait:')
    || normalized.startsWith('send_blocked_auth_required:')
    || normalized.startsWith('session_invalid:')
    || normalized.startsWith('qr_required:')
    || normalized.startsWith('auth_failure:')
    || normalized.startsWith('logout:');
}

async function attemptAuthResetRecovery(reason) {
  console.warn(`[RECOVERY] step=auth_reset reason=${reason}`);
  recordRecoveryAttempt('auth_reset', reason);
  whatsappHealth.lastRecoveryMode = 'auth_reset';
  if (!whatsappConfig.allowSessionDataReset) {
    forceAuthResetOnNextConnect = false;
    if (!isAuthRecoveryReason(reason)) {
      console.warn(
        `[AUTH] skipping auth_reset for non-auth reason=${reason}; keeping LocalAuth session state unchanged`
      );
      return false;
    }
    console.warn(
      `[AUTH] preserving LocalAuth session; automatic session reset disabled reason=${reason}`
    );
    markWhatsAppAuthInvalid(`auth_reset_skipped:${reason}`, buildAuthInterventionExtra(
      `auth_reset_skipped:${reason}`,
      {
        browserAlive: isBrowserConnected(client) && isPageAlive(client),
        browserConnected: isBrowserConnected(client),
        pageAlive: isPageAlive(client),
        ready: false,
        authEstablished: false,
        messagingReady: false,
        connectionState: whatsappHealth.connectionState || 'AUTH_INVALID',
        appState: whatsappHealth.appState || null
      }
    ));
    return false;
  }
  forceAuthResetOnNextConnect = true;
  return attemptClientRecreateRecovery(reason, { forceBrowserRestart: true, resetAuth: true });
}

async function recoverWhatsAppClient(reason, options = {}) {
  if (isDryRun || isShuttingDown || !whatsappConfig.enableAutoReconnect) {
    return false;
  }
  if (isAwaitingManualAuth()) {
    console.warn(
      `[AUTH] recovery_blocked waiting_for_login reason=${reason} ` +
      `conn=${whatsappHealth.connectionState || '-'} app=${whatsappHealth.appState || '-'}`
    );
    markWhatsAppAuthInvalid(`auth_wait:${reason}`, buildAuthInterventionExtra(`auth_wait:${reason}`, {
      browserAlive: isBrowserConnected(client) && isPageAlive(client),
      browserConnected: isBrowserConnected(client),
      pageAlive: isPageAlive(client),
      ready: false,
      authEstablished: false,
      messagingReady: false,
      connectionState: whatsappHealth.connectionState || 'QR',
      appState: whatsappHealth.appState || null
    }));
    return false;
  }
  if (recoveryPromise) {
    return recoveryPromise;
  }

  recoveryPromise = (async () => {
    const now = Date.now();
    const minimumStep = options.minimumStep
      || (whatsappHealth.sessionInvalid ? 'auth_reset' : 'app_reload');
    const maximumStep = options.maximumStep
      || ((whatsappHealth.sessionInvalid || isAuthRecoveryReason(reason))
        ? RECOVERY_STEPS[RECOVERY_STEPS.length - 1]
        : 'browser_restart');
    let step = computeRecoveryStep({
      history: whatsappHealth.recoveryHistory,
      now,
      escalationWindowMs: runtimeConfig.recoveryEscalationWindowMs || (10 * 60 * 1000),
      minimumStep,
      maximumStep
    });
    const startIndex = Math.max(0, RECOVERY_STEPS.indexOf(step));
    const maximumIndex = Math.max(startIndex, RECOVERY_STEPS.indexOf(maximumStep));

    for (let index = startIndex; index <= maximumIndex; index++) {
      step = RECOVERY_STEPS[index];
      try {
        if (step === 'app_reload') {
          if (await attemptAppReloadRecovery(reason)) {
            return true;
          }
        } else if (step === 'client_recreate') {
          if (await attemptClientRecreateRecovery(reason)) {
            return true;
          }
        } else if (step === 'browser_restart') {
          if (await attemptBrowserRestartRecovery(reason)) {
            return true;
          }
        } else if (step === 'auth_reset') {
          if (await attemptAuthResetRecovery(reason)) {
            return true;
          }
        }
      } catch (error) {
        if (error && error.authInterventionRequired) {
          console.warn(
            `[AUTH] recovery_waiting_for_login step=${step} reason=${reason} ` +
            `conn=${whatsappHealth.connectionState || '-'} app=${whatsappHealth.appState || '-'}`
          );
          markWhatsAppAuthInvalid(`auth_wait:${reason}`, buildAuthInterventionExtra(`auth_wait:${reason}`, {
            browserAlive: isBrowserConnected(client) && isPageAlive(client),
            browserConnected: isBrowserConnected(client),
            pageAlive: isPageAlive(client),
            ready: false,
            authEstablished: false,
            messagingReady: false,
            connectionState: whatsappHealth.connectionState || 'QR',
            appState: whatsappHealth.appState || null
          }));
          return false;
        }
        console.warn(`[RECOVERY] step=${step} failed (${reason}): ${error.message || error}`);
      }
    }

    if (isAwaitingManualAuth()) {
      return false;
    }
    const preserveStatusOnExhausted = !!options.preserveStatusOnExhausted || maximumIndex < (RECOVERY_STEPS.length - 1);
    if (preserveStatusOnExhausted) {
      const snapshot = await refreshWhatsAppHealth(`recovery_exhausted:${reason}`);
      if (snapshot) {
        return false;
      }
      markWhatsAppDegraded(`recovery_exhausted:${reason}`, {
        browserAlive: isBrowserConnected(client) && isPageAlive(client),
        browserConnected: isBrowserConnected(client),
        pageAlive: isPageAlive(client),
        ready: isReadyFired,
        authEstablished,
        messagingReady: messagingBootstrapped,
        connectionState: whatsappHealth.connectionState || 'DEGRADED',
        appState: whatsappHealth.appState || null
      });
      return false;
    }
    markWhatsAppDisconnected(`recovery_exhausted:${reason}`, {
      browserAlive: false,
      browserConnected: false,
      pageAlive: false,
      ready: false,
      authEstablished: false,
      messagingReady: false
    });
    return false;
  })().finally(() => {
    clearRecoveryState();
    recoveryPromise = null;
  });

  return recoveryPromise;
}

async function maybeRunWhatsAppHealthCheck(now = Date.now()) {
  if (isDryRun || isShuttingDown || isInitializing || initializingPromise) {
    return;
  }

  const intervalMs = Math.max(10_000, (whatsappConfig.healthCheckIntervalSec || 60) * 1000);
  if ((now - lastHealthCheckAt) < intervalMs) {
    return;
  }
  lastHealthCheckAt = now;

  const snapshot = await refreshWhatsAppHealth('health_check');
  if (!snapshot) {
    return;
  }

  if (snapshot.error) {
    await recoverWhatsAppClient('health_check_error', { minimumStep: 'app_reload' });
    return;
  }

  if (isSessionInvalidState(snapshot.appState)) {
    const authInvalidExtra = buildAuthInterventionExtra('session_invalid', {
      browserAlive: true,
      browserConnected: isBrowserConnected(client),
      pageAlive: isPageAlive(client),
      ready: false,
      authEstablished: false,
      messagingReady: false,
      connectionState: whatsappHealth.connectionState || 'AUTH_INVALID',
      appState: snapshot.appState || null,
      sessionInvalid: true
    });
    markWhatsAppAuthInvalid('session_invalid', authInvalidExtra);
    if (isAwaitingManualAuth({
      status: WHATSAPP_STATUS.AUTH_INVALID,
      connectionState: authInvalidExtra.connectionState,
      appState: authInvalidExtra.appState,
      pageAlive: authInvalidExtra.pageAlive,
      qrVisible: authInvalidExtra.qrVisible
    })) {
      console.warn(
        `[AUTH] waiting_for_login reason=session_invalid conn=${authInvalidExtra.connectionState || '-'} ` +
        `app=${authInvalidExtra.appState || '-'}`
      );
      return;
    }
    await recoverWhatsAppClient('session_invalid', { minimumStep: 'auth_reset' });
    return;
  }

  const shouldRecycle = whatsappConfig.forceReconnectAfterMinutes > 0
    && whatsappHealth.clientStartedAt > 0
    && (now - whatsappHealth.clientStartedAt) >= (whatsappConfig.forceReconnectAfterMinutes * 60 * 1000);
  if (shouldRecycle) {
    console.warn('[WATCHDOG] forcing proactive WhatsApp reconnect due to session age');
    await recoverWhatsAppClient('watchdog_session_age', { minimumStep: 'client_recreate' });
    return;
  }

  if (await tryRepairMessagingBootstrap('health_check', client, snapshot)) {
    return;
  }

  if (deriveHealthStatusFromSnapshot(snapshot) !== WHATSAPP_STATUS.READY) {
    await recoverWhatsAppClient('health_check_degraded', { minimumStep: 'app_reload' });
    return;
  }

  const pendingFiles = await listPendingNotificationFiles();
  const hasPendingNotifications = pendingFiles.length > 0;
  const lastVerificationAnchorAt = Math.max(
    whatsappHealth.lastVerifiedMediaSendAt || 0,
    whatsappHealth.lastMediaSendAttemptAt || 0
  );
  const recoveryWindowMs = Math.max(
    runtimeConfig.sendAckTimeoutMs || 20_000,
    runtimeConfig.verifiedSendRecoveryMs || (3 * 60 * 1000)
  );
  const pendingWithoutVerification = hasPendingNotifications
    && whatsappHealth.lastMediaSendAttemptAt > 0
    && whatsappHealth.lastMediaSendAttemptAt >= whatsappHealth.lastVerifiedMediaSendAt
    && lastVerificationAnchorAt > 0
    && (now - lastVerificationAnchorAt) >= recoveryWindowMs;

  if (
    pendingWithoutVerification
    || whatsappHealth.consecutiveUnverifiedMediaSends >= Math.max(1, runtimeConfig.maxConsecutiveUnverifiedSends || 2)
  ) {
    const reason = pendingWithoutVerification
      ? `verified_send_stalled:${pendingFiles.length}`
      : `consecutive_unverified_media_sends:${whatsappHealth.consecutiveUnverifiedMediaSends}`;
    console.warn(
      `[WATCHDOG] ${reason} pending=${pendingFiles.length} ` +
      `lastVerifiedMedia=${toIso(whatsappHealth.lastVerifiedMediaSendAt)} lastAttempt=${toIso(whatsappHealth.lastMediaSendAttemptAt)}`
    );
    const extra = {
      browserAlive: true,
      browserConnected: isBrowserConnected(client),
      pageAlive: isPageAlive(client),
      ready: isReadyFired,
      authEstablished,
      messagingReady: messagingBootstrapped
    };
    if (pendingWithoutVerification) {
      markWhatsAppSessionStale(reason, extra);
    } else {
      markWhatsAppMediaBroken(reason, extra);
    }
    await maybeRunDiagnosticTextProbe(reason);
    await recoverWhatsAppClient(reason, {
      minimumStep: hasPendingNotifications ? 'client_recreate' : 'app_reload',
      maximumStep: 'client_recreate',
      preserveStatusOnExhausted: true
    });
  }
}

async function maybeRunDiagnosticTextProbe(reason) {
  if (isDryRun || isShuttingDown || !whatsappConfig.textProbeEnabled) {
    return null;
  }

  const now = Date.now();
  const cooldownMs = Math.max(30_000, whatsappConfig.textProbeCooldownMs || (15 * 60 * 1000));
  if (whatsappHealth.lastProbeAt > 0 && (now - whatsappHealth.lastProbeAt) < cooldownMs) {
    return null;
  }

  whatsappHealth.lastProbeAt = now;
  whatsappHealth.lastProbeReason = reason;
  const probeText = `${whatsappConfig.textProbePrefix || '[diag]'} ${formatWhatsAppCaption(now)}`;
  console.warn(`[PROBE] text_probe_start reason=${reason} text="${probeText}"`);
  try {
    const activeClient = await waitForMessagingReady(runtimeConfig.sendTimeoutMs || 45_000);
    const targetChatId = await ensureChatId({ clientInstance: activeClient });
    if (!targetChatId) {
      throw new Error('text_probe_chat_unresolved');
    }
    const result = await sendVerifiedWhatsAppMessage({
      activeClient,
      targetChatId,
      kind: 'text',
      content: probeText,
      sendOptions: { waitUntilMsgSent: true },
      label: 'text_probe'
    });
    recordVerifiedSend('text', {
      messageId: result.verification.messageId,
      ack: result.verification.ack,
      verificationMethod: result.verification.verificationMethod
    });
    updateWhatsAppHealth(null, 'text_probe_verified', clearAuthInterventionExtra({
      browserAlive: true,
      browserConnected: isBrowserConnected(activeClient),
      pageAlive: isPageAlive(activeClient),
      connectionState: 'CONNECTED',
      authEstablished: true,
      messagingReady: true
    }));
    console.warn(`[PROBE] text_probe_verified messageId=${result.verification.messageId} ack=${ackLabel(result.verification.ack)}`);
    return result;
  } catch (error) {
    const detail = error && error.notificationDetail ? error.notificationDetail : {
      failureReason: error.message || String(error)
    };
    if (detail.verificationStatus === 'unverified') {
      recordUnverifiedSend('text', detail);
    } else {
      recordFailedSend('text', detail);
    }
    console.warn(`[PROBE] text_probe_failed reason=${error.message || error}`);
    return null;
  }
}

function armReadyWatchdog(clientInstance, timeoutMs = 60_000) {
  clearReadyWatchdog();
  readyWatchdogTimer = setTimeout(async () => {
    if (isShuttingDown || client !== clientInstance || isReadyFired) return;
    const state = await snapshotClientState(clientInstance);
    console.warn(`[CLIENT] READY watchdog timeout after ${timeoutMs}ms: ${JSON.stringify(state)}`);
    if (await tryRepairMessagingBootstrap('ready_watchdog_timeout', clientInstance, state)) {
      console.warn('[CLIENT] READY watchdog recovered by bootstrap repair');
      return;
    }
    chatId = null;
    messagingBootstrapped = false;
    messagingBootstrapping = false;
    authEstablished = false;
    markWhatsAppDegraded('ready_watchdog_timeout', {
      browserAlive: false,
      browserConnected: false,
      pageAlive: false,
      ready: false,
      authEstablished: false,
      messagingReady: false,
      appState: state.appState || whatsappHealth.appState,
      hasSynced: state.hasSynced ?? whatsappHealth.hasSynced
    });
    scheduleReconnect(3000, 'ready_watchdog_timeout');
  }, timeoutMs);

  if (readyWatchdogTimer.unref) readyWatchdogTimer.unref();
}

function registerClientEvents(clientInstance) {
  if (!clientInstance) return;
  const isCurrentClient = () => client === clientInstance;

  clientInstance.on('qr', (qr) => {
    if (!isCurrentClient()) return;
    if (messagingBootstrapped) return;
    qrcode.generate(qr, { small: true });
    console.log('[QR] QR Code generiert');
    markWhatsAppAuthInvalid('qr_required', buildAuthInterventionExtra('qr_required', {
      browserAlive: true,
      browserConnected: isBrowserConnected(clientInstance),
      pageAlive: isPageAlive(clientInstance),
      ready: false,
      authEstablished: false,
      messagingReady: false,
      connectionState: 'QR',
      sessionInvalid: true
    }));
  });

  clientInstance.once('authenticated', () => {
    if (!isCurrentClient()) return;
    console.log('[AUTH] Authenticated with WhatsApp Web');
    reconnectAttempts = 0;
    authEstablished = true;
    markWhatsAppDegraded('authenticated', clearAuthInterventionExtra({
      browserAlive: true,
      browserConnected: isBrowserConnected(clientInstance),
      pageAlive: isPageAlive(clientInstance),
      ready: false,
      authEstablished: true,
      messagingReady: false,
      connectionState: 'AUTHENTICATED',
      sessionInvalid: false
    }));
    armReadyWatchdog(clientInstance);
  });

  clientInstance.on('auth_failure', (msg) => {
    if (!isCurrentClient()) return;
    clearReadyWatchdog();
    authEstablished = false;
    messagingBootstrapped = false;
    console.error('[AUTH] Authentication failure:', msg);
    markWhatsAppAuthInvalid('auth_failure', buildAuthInterventionExtra('auth_failure', {
      browserAlive: true,
      browserConnected: isBrowserConnected(clientInstance),
      pageAlive: isPageAlive(clientInstance),
      ready: false,
      authEstablished: false,
      messagingReady: false,
      connectionState: 'AUTH_FAILURE',
      sessionInvalid: true
    }));
    recoverWhatsAppClient('auth_failure', { minimumStep: 'auth_reset' }).catch(console.error);
  });

  clientInstance.on('loading_screen', (percent, message) => {
    if (!isCurrentClient()) return;
    console.log(`[LOAD] ${percent}% - ${message}`);
  });

  clientInstance.on('change_state', (state) => {
    if (!isCurrentClient()) return;
    console.log('[STATE] Client state:', state);
    const normalizedState = String(state || '').toUpperCase();
    if (normalizedState === 'CONNECTED') {
      markWhatsAppDegraded('change_state_connected', {
        browserAlive: true,
        browserConnected: isBrowserConnected(clientInstance),
        pageAlive: isPageAlive(clientInstance),
        connectionState: 'CONNECTED',
        authEstablished,
        messagingReady: messagingBootstrapped
      });
    } else if (['OPENING', 'PAIRING', 'TIMEOUT'].includes(normalizedState)) {
      markWhatsAppDegraded(`change_state_${normalizedState.toLowerCase()}`, {
        browserAlive: true,
        browserConnected: isBrowserConnected(clientInstance),
        pageAlive: isPageAlive(clientInstance),
        connectionState: normalizedState,
        authEstablished,
        messagingReady: messagingBootstrapped
      });
    } else {
      const disconnectedState = isSessionInvalidState(normalizedState) ? markWhatsAppAuthInvalid : markWhatsAppDisconnected;
      disconnectedState(
        `change_state_${normalizedState.toLowerCase()}`,
        isSessionInvalidState(normalizedState)
          ? buildAuthInterventionExtra(`change_state_${normalizedState.toLowerCase()}`, {
            browserAlive: false,
            browserConnected: false,
            pageAlive: false,
            ready: false,
            authEstablished: false,
            messagingReady: false,
            connectionState: normalizedState,
            sessionInvalid: true
          })
          : {
            browserAlive: false,
            browserConnected: false,
            pageAlive: false,
            ready: false,
            authEstablished: false,
            messagingReady: false,
            connectionState: normalizedState,
            sessionInvalid: false
          }
      );
    }
    if (state === 'CONNECTED' && !messagingBootstrapped) {
      bootstrapMessaging(clientInstance).catch(console.error);
    }
  });

  clientInstance.on('ready', () => {
    if (!isCurrentClient()) return;
    clearReadyWatchdog();
    if (isReadyFired) {
      console.log('[READY] Ignoriere doppelten READY-Event');
      return;
    }
    isReadyFired = true;
    console.log('[READY] Client ist bereit!');
    reconnectAttempts = 0;
    authEstablished = true;
    clearRecoveryState();
    markWhatsAppConnected('ready', clearAuthInterventionExtra({
      browserAlive: true,
      browserConnected: isBrowserConnected(clientInstance),
      pageAlive: isPageAlive(clientInstance),
      connectionState: 'CONNECTED',
      authEstablished: true,
      messagingReady: true,
      sessionInvalid: false
    }));
    bootstrapMessaging(clientInstance).catch(console.error);
    safeStartWorkers().catch(console.error);
  });

  clientInstance.on('disconnected', (reason) => {
    if (!isCurrentClient()) return;
    clearReadyWatchdog();
    isReadyFired = false;
    authEstablished = false;
    messagingBootstrapped = false;
    console.log(`[DISC] WhatsApp disconnected: ${reason}`);
    const quickReasons = ['TIMEOUT', 'CONNECTION_FAILURE', 'PING_TIMEOUT', 'CONFLICT', 'PAGE_CRASH', 'LOGOUT'];
    markWhatsAppDisconnected(`disconnected:${reason}`, clearAuthInterventionExtra({
      browserAlive: false,
      browserConnected: false,
      pageAlive: false,
      ready: false,
      authEstablished: false,
      messagingReady: false,
      connectionState: String(reason || 'DISCONNECTED'),
      sessionInvalid: isSessionInvalidState(reason)
    }));
    scheduleReconnect(quickReasons.includes(reason) ? 4000 : 15000, `disconnected:${reason}`);
  });

  clientInstance.on('logout', () => {
    if (!isCurrentClient()) return;
    clearReadyWatchdog();
    console.log('[LOGOUT] WhatsApp hat uns abgemeldet ? sofortiger Reconnect');
    isReadyFired = false;
    authEstablished = false;
    messagingBootstrapped = false;
    markWhatsAppAuthInvalid('logout', buildAuthInterventionExtra('logout', {
      browserAlive: false,
      browserConnected: false,
      pageAlive: false,
      ready: false,
      authEstablished: false,
      messagingReady: false,
      connectionState: 'LOGOUT',
      sessionInvalid: true
    }));
    recoverWhatsAppClient('logout', { minimumStep: 'auth_reset' }).catch(console.error);
  });

  clientInstance.on('message_ack', (message, ack) => {
    if (!isCurrentClient()) return;
    if (!message || !message.fromMe) return;
    const now = Date.now();
    const messageId = extractMessageId(message);
    const normalizedAck = normalizeAck(ack);
    const outbound = getOutboundMessageDetail(messageId);
    whatsappHealth.lastAckAt = now;
    whatsappHealth.lastMessageId = messageId;
    whatsappHealth.lastAckValue = normalizedAck;
    if (outbound && outbound.kind === 'text') {
      whatsappHealth.lastTextAckAt = now;
    } else {
      whatsappHealth.lastMediaAckAt = now;
    }
    console.log(
      `[SEND] ack_update kind=${outbound && outbound.kind ? outbound.kind : 'unknown'} ` +
      `file=${outbound && outbound.fileName ? outbound.fileName : '-'} messageId=${messageId || '-'} ack=${formatAck(normalizedAck)}`
    );
    if (normalizedAck !== null && normalizedAck >= 1) {
      updateWhatsAppHealth(null, 'message_ack', {
        browserAlive: true,
        browserConnected: isBrowserConnected(clientInstance),
        pageAlive: isPageAlive(clientInstance),
        connectionState: 'CONNECTED',
        authEstablished: true,
        messagingReady: true
      });
    }
  });

  clientInstance.on('media_uploaded', (message) => {
    if (!isCurrentClient()) return;
    if (!message || !message.fromMe) return;
    const messageId = extractMessageId(message) || 'unknown';
    const outbound = getOutboundMessageDetail(messageId);
    whatsappHealth.lastMediaUploadAt = Date.now();
    console.log(
      `[SEND] media_uploaded file=${outbound && outbound.fileName ? outbound.fileName : '-'} ` +
      `caption=${outbound && outbound.captionText ? JSON.stringify(outbound.captionText) : '-'} messageId=${messageId}`
    );
  });
}

// -----------------------------------------------------------------------------
// Start
// -----------------------------------------------------------------------------

if (!isDryRun) {
  startOrReconnectClient().catch((e) => {
    console.error('[START] Client konnte nicht gestartet werden:', e);
  });
} else {
  console.log('[DRY] Dry-run enabled. No WhatsApp connection will be used.');
  runDryRun().catch((e) => {
    console.error('[DRY] Failed:', e);
    process.exit(1);
  });
}

// -----------------------------------------------------------------------------
// Bootstrap & worker start
// -----------------------------------------------------------------------------

async function safeStartWorkers() {
  if (workersStarted) return;
  workersStarted = true;
  try {
    await ensureDirs();
    await bootstrapMotionDetector();
    startRuntimeHeartbeat();
    await recoverPendingNotifications();
    startWatcher();
  } catch (e) {
    console.error('[START] Failed to start workers:', e);
    workersStarted = false;
  }
}

async function bootstrapMessaging(clientInstance = client) {
  if (isDryRun || !clientInstance || messagingBootstrapped || messagingBootstrapping) {
    return;
  }

  messagingBootstrapping = true;
  try {
    await waitForWWebInjection(clientInstance);
    await waitForWWebJS(clientInstance);
    await patchSendSeen(clientInstance);
    await processChats(clientInstance);
    if (client !== clientInstance) return;
    messagingBootstrapped = true;
    markWhatsAppConnected('bootstrap_messaging', clearAuthInterventionExtra({
      browserAlive: true,
      browserConnected: isBrowserConnected(clientInstance),
      pageAlive: isPageAlive(clientInstance),
      connectionState: 'CONNECTED',
      authEstablished,
      messagingReady: true
    }));
  } finally {
    messagingBootstrapping = false;
  }
}

function startWatcher() {
  if (watcherStarted) return;
  watcherStarted = true;
  console.log('[CHATS] Waiting for new Images ...');
  watchDirectory(config.readDir);
}

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function listPendingNotificationFiles() {
  try {
    if (!await fileTools.pathExists(getPendingDir())) {
      return [];
    }

    const entries = await fileTools.readdir(getPendingDir());
    const candidates = entries
      .filter((file) => path.extname(file).toLowerCase() === String(config.fileExtension).toLowerCase())
      .map((file) => path.join(getPendingDir(), file));

    const withStats = [];
    for (const candidate of candidates) {
      try {
        const stats = await fileTools.stat(candidate);
        if (stats.isFile()) {
          withStats.push({ candidate, mtimeMs: stats.mtimeMs });
        }
      } catch (_) {}
    }

    withStats.sort((a, b) => a.mtimeMs - b.mtimeMs || a.candidate.localeCompare(b.candidate));
    return withStats.map((entry) => entry.candidate);
  } catch (error) {
    console.warn(`[SEND] Failed to list pending images: ${error.message || error}`);
    return [];
  }
}

async function recoverPendingNotifications() {
  const pendingFiles = await listPendingNotificationFiles();
  if (!pendingFiles.length) {
    return;
  }

  console.warn(`[SEND] recovered_pending count=${pendingFiles.length} dir=${getPendingDir()}`);
  for (const pendingFile of pendingFiles) {
    enqueueNotification(pendingFile, () => sendImage(pendingFile));
  }
}

function buildRuntimeConfig(base) {
  const defaults = {
    heartbeatMs: 15_000,
    sendTimeoutMs: 45_000,
    sendAckTimeoutMs: 20_000,
    messageInfoTimeoutMs: 5_000,
    notificationMaxRetries: 6,
    notificationRetryDelayMs: 1_000,
    pendingRetryDelayMs: 30_000,
    pendingRetryMaxDelayMs: 15 * 60 * 1000,
    verifiedSendRecoveryMs: 3 * 60 * 1000,
    maxConsecutiveUnverifiedSends: 2,
    healthFile: './.state/runtime-health.json',
    decisionLogFile: './.state/decisions.ndjson',
    notificationLogFile: './.state/notifications.ndjson',
    sampleArchiveDir: './.state/samples',
    sampleArchiveEnabled: true,
    sampleArchiveMaxFilesPerCategory: 200,
    queueWarningDepth: 8,
    queueWarningAgeMs: 60_000,
    notificationQueueWarningDepth: 12,
    notificationQueueWarningAgeMs: 120_000,
    frameSilenceWarningMs: 45_000,
    detectorSilenceWarningMs: 10 * 60 * 1000,
    repeatedFrameWarningCount: 8,
    repeatedFrameResetCount: 20,
    suppressedCandidateMotionScore: 0.018,
    suppressedCandidateSceneScore: 0.26,
    suppressedCandidateWarningCount: 4,
    detectorSuppressedResetCount: 8,
    recoveryMinIntervalMs: 120_000,
    recoveryEscalationWindowMs: 10 * 60 * 1000
  };

  const source = Object.assign({}, defaults, base.runtime || {});
  const envNum = (value, fallback) => {
    if (value === undefined || value === null || value === '') return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  source.heartbeatMs = envNum(process.env.SNAPSHOTTER_HEARTBEAT_MS, source.heartbeatMs);
  source.sendTimeoutMs = envNum(process.env.SNAPSHOTTER_SEND_TIMEOUT_MS, source.sendTimeoutMs);
  source.sendAckTimeoutMs = envNum(process.env.SNAPSHOTTER_SEND_ACK_TIMEOUT_MS, source.sendAckTimeoutMs);
  source.messageInfoTimeoutMs = envNum(process.env.SNAPSHOTTER_MESSAGE_INFO_TIMEOUT_MS, source.messageInfoTimeoutMs);
  source.notificationMaxRetries = envNum(process.env.SNAPSHOTTER_NOTIFICATION_MAX_RETRIES, source.notificationMaxRetries);
  source.notificationRetryDelayMs = envNum(process.env.SNAPSHOTTER_NOTIFICATION_RETRY_DELAY_MS, source.notificationRetryDelayMs);
  source.pendingRetryDelayMs = envNum(process.env.SNAPSHOTTER_PENDING_RETRY_DELAY_MS, source.pendingRetryDelayMs);
  source.pendingRetryMaxDelayMs = envNum(process.env.SNAPSHOTTER_PENDING_RETRY_MAX_DELAY_MS, source.pendingRetryMaxDelayMs);
  source.verifiedSendRecoveryMs = envNum(process.env.SNAPSHOTTER_VERIFIED_SEND_RECOVERY_MS, source.verifiedSendRecoveryMs);
  source.maxConsecutiveUnverifiedSends = envNum(process.env.SNAPSHOTTER_MAX_CONSECUTIVE_UNVERIFIED_SENDS, source.maxConsecutiveUnverifiedSends);
  source.queueWarningDepth = envNum(process.env.SNAPSHOTTER_QUEUE_WARNING_DEPTH, source.queueWarningDepth);
  source.queueWarningAgeMs = envNum(process.env.SNAPSHOTTER_QUEUE_WARNING_AGE_MS, source.queueWarningAgeMs);
  source.detectorSilenceWarningMs = envNum(process.env.SNAPSHOTTER_DETECTOR_SILENCE_WARNING_MS, source.detectorSilenceWarningMs);
  source.repeatedFrameResetCount = envNum(process.env.SNAPSHOTTER_REPEATED_FRAME_RESET_COUNT, source.repeatedFrameResetCount);
  source.detectorSuppressedResetCount = envNum(process.env.SNAPSHOTTER_SUPPRESSED_RESET_COUNT, source.detectorSuppressedResetCount);
  return source;
}

function buildLoggingConfig(base) {
  const defaults = {
    dir: './logs',
    consoleLevel: 'info',
    appLevel: 'info',
    whatsappLevel: 'info',
    appFile: 'snapshotter-app.log',
    whatsappFile: 'snapshotter-whatsapp.log'
  };
  const source = Object.assign({}, defaults, base.logging || {});
  const envStr = (value, fallback) => {
    if (value === undefined || value === null || value === '') return fallback;
    return String(value);
  };

  source.dir = envStr(process.env.SNAPSHOTTER_LOG_DIR, source.dir);
  source.consoleLevel = envStr(process.env.SNAPSHOTTER_LOG_CONSOLE_LEVEL, source.consoleLevel);
  source.appLevel = envStr(process.env.SNAPSHOTTER_LOG_APP_LEVEL, source.appLevel);
  source.whatsappLevel = envStr(process.env.SNAPSHOTTER_LOG_WHATSAPP_LEVEL, source.whatsappLevel);
  source.appFile = envStr(process.env.SNAPSHOTTER_LOG_APP_FILE, source.appFile);
  source.whatsappFile = envStr(process.env.SNAPSHOTTER_LOG_WHATSAPP_FILE, source.whatsappFile);
  return source;
}

function buildWhatsAppConfig(base, runtime) {
  const defaults = {
    enableAutoReconnect: true,
    maxRetries: 3,
    retryDelayMs: 2_000,
    healthCheckIntervalSec: 60,
    forceReconnectAfterMinutes: 0,
    initializeTimeoutMs: 180_000,
    initializeAuthResetFailures: 4,
    protocolTimeoutMs: 120_000,
    authInterventionRetryDelayMs: 5 * 60 * 1000,
    allowSessionDataReset: false,
    textProbeEnabled: false,
    textProbeCooldownMs: 15 * 60 * 1000,
    textProbePrefix: '[diag]'
  };
  const source = Object.assign({}, defaults, base.whatsapp || {});
  const envBool = (value, fallback) => {
    if (value === undefined || value === null || value === '') return fallback;
    return /^(1|true|yes|on)$/i.test(String(value).trim());
  };
  const envNum = (value, fallback) => {
    if (value === undefined || value === null || value === '') return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  source.enableAutoReconnect = envBool(process.env.WHATSAPP_ENABLE_AUTO_RECONNECT, source.enableAutoReconnect);
  source.maxRetries = Math.max(
    1,
    Math.floor(envNum(process.env.WHATSAPP_MAX_RETRIES, source.maxRetries ?? runtime.notificationMaxRetries ?? 3))
  );
  source.retryDelayMs = Math.max(
    250,
    Math.floor(envNum(process.env.WHATSAPP_RETRY_DELAY_MS, source.retryDelayMs ?? runtime.notificationRetryDelayMs ?? 2_000))
  );
  source.healthCheckIntervalSec = Math.max(
    10,
    Math.floor(envNum(process.env.WHATSAPP_HEALTH_CHECK_INTERVAL_SEC, source.healthCheckIntervalSec))
  );
  source.forceReconnectAfterMinutes = Math.max(
    0,
    Math.floor(envNum(process.env.WHATSAPP_FORCE_RECONNECT_AFTER_MINUTES, source.forceReconnectAfterMinutes))
  );
  source.initializeTimeoutMs = Math.max(
    60_000,
    Math.floor(envNum(process.env.WHATSAPP_INITIALIZE_TIMEOUT_MS, source.initializeTimeoutMs))
  );
  source.initializeAuthResetFailures = Math.max(
    2,
    Math.floor(envNum(process.env.WHATSAPP_INITIALIZE_AUTH_RESET_FAILURES, source.initializeAuthResetFailures))
  );
  source.protocolTimeoutMs = Math.max(
    30_000,
    Math.floor(envNum(process.env.WHATSAPP_PROTOCOL_TIMEOUT_MS, source.protocolTimeoutMs))
  );
  source.authInterventionRetryDelayMs = Math.max(
    30_000,
    Math.floor(envNum(process.env.WHATSAPP_AUTH_INTERVENTION_RETRY_DELAY_MS, source.authInterventionRetryDelayMs))
  );
  source.allowSessionDataReset = envBool(
    process.env.WHATSAPP_ALLOW_SESSION_DATA_RESET,
    source.allowSessionDataReset
  );
  source.textProbeEnabled = envBool(process.env.WHATSAPP_TEXT_PROBE_ENABLED, source.textProbeEnabled);
  source.textProbeCooldownMs = Math.max(
    30_000,
    Math.floor(envNum(process.env.WHATSAPP_TEXT_PROBE_COOLDOWN_MS, source.textProbeCooldownMs))
  );
  source.textProbePrefix = String(process.env.WHATSAPP_TEXT_PROBE_PREFIX || source.textProbePrefix || '[diag]');
  return source;
}

// -----------------------------------------------------------------------------
// Image filter config/state
// -----------------------------------------------------------------------------

function buildImageFilterConfig(base) {
  const defaults = {
    enabled: true,
    resizeWidth: 384,
    cropTop: 24,
    failMode: 'open',
    filteredDirName: 'filtered',
    compareCrop: null,
    roiMask: { polygons: [] },
    zoneModel: {
      exclusionPolygons: [],
      focusZones: []
    },
    delta: {
      pixelDiffThreshold: 17,
      edgeDiffPixelThreshold: 20,
      minForegroundArea: 130,
      minForegroundRatio: 0.0045,
      minLargestComponentArea: 34,
      minEdgeDiffRatio: 0.0048,
      highForegroundArea: 300,
      highEdgeDiffRatio: 0.0135
    },
    event: {
      enabled: true,
      minConfirmFrames: 2,
      maxConfirmGapSeconds: 8,
      strongSingleFrameScore: 0.028,
      strongSingleFrameMinZones: 2,
      maxActiveSendGapSeconds: 6,
      quietFramesToEnd: 2,
      maxSendsPerEvent: 4,
      minSecondsBetweenSends: 3,
      cooldownSeconds: 9,
      sendLastFrame: true,
      minScoreForActiveSend: 0.027
    },
    brightnessGuard: {
      enabled: true,
      maxUniformDelta: 10,
      maxStdDelta: 7,
      maxForegroundRatio: 0.04
    },
    nativeSignal: {
      enabled: true,
      personVehicleAnimalOnly: true
    },
    debug: {
      writeDebugJson: false,
      debugDir: './.state/debug-motion'
    }
  };

  const source = base.imageFilter || {};
  const legacyBackground = source.backgroundModel || {};
  const cfg = Object.assign({}, defaults, source);
  cfg.delta = Object.assign({}, defaults.delta, source.delta || {});
  cfg.event = Object.assign({}, defaults.event, source.event || {});
  cfg.brightnessGuard = Object.assign({}, defaults.brightnessGuard, source.brightnessGuard || {});
  cfg.nativeSignal = Object.assign({}, defaults.nativeSignal, source.nativeSignal || {});
  cfg.zoneModel = Object.assign({}, defaults.zoneModel, source.zoneModel || {});
  cfg.zoneModel.exclusionPolygons = Array.isArray(source.zoneModel && source.zoneModel.exclusionPolygons)
    ? source.zoneModel.exclusionPolygons
    : defaults.zoneModel.exclusionPolygons;
  cfg.zoneModel.focusZones = Array.isArray(source.zoneModel && source.zoneModel.focusZones)
    ? source.zoneModel.focusZones
    : defaults.zoneModel.focusZones;
  cfg.debug = Object.assign({}, defaults.debug, source.debug || {});

  const envBool = (value, fallback) => {
    if (value === undefined || value === null || value === '') return fallback;
    return /^(1|true|yes|on)$/i.test(String(value).trim());
  };
  const envNum = (value, fallback) => {
    if (value === undefined || value === null || value === '') return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };
  const envStr = (value, fallback) => {
    if (value === undefined || value === null || value === '') return fallback;
    return String(value);
  };

  cfg.enabled = envBool(process.env.IMAGE_FILTER_ENABLED, cfg.enabled);
  cfg.resizeWidth = envNum(process.env.IMAGE_FILTER_RESIZE_WIDTH, cfg.resizeWidth);
  cfg.cropTop = envNum(process.env.IMAGE_FILTER_CROP_TOP, cfg.cropTop);
  cfg.failMode = envStr(process.env.IMAGE_FILTER_FAIL_MODE, cfg.failMode);
  cfg.filteredDirName = envStr(process.env.IMAGE_FILTER_FILTERED_DIR_NAME, cfg.filteredDirName);

  cfg.delta.pixelDiffThreshold = envNum(
    process.env.IMAGE_FILTER_PIXEL_DIFF_THRESHOLD,
    envNum(legacyBackground.pixelDiffThreshold, cfg.delta.pixelDiffThreshold)
  );
  cfg.delta.edgeDiffPixelThreshold = envNum(
    process.env.IMAGE_FILTER_EDGE_DIFF_PIXEL_THRESHOLD,
    envNum(source.edgeDiffPixelThreshold, cfg.delta.edgeDiffPixelThreshold)
  );
  cfg.delta.minForegroundArea = envNum(
    process.env.IMAGE_FILTER_MIN_FOREGROUND_AREA,
    envNum(legacyBackground.minForegroundArea, cfg.delta.minForegroundArea)
  );
  cfg.delta.minForegroundRatio = envNum(
    process.env.IMAGE_FILTER_MIN_FOREGROUND_RATIO,
    cfg.delta.minForegroundRatio
  );
  cfg.delta.minLargestComponentArea = envNum(
    process.env.IMAGE_FILTER_MIN_FOREGROUND_COMPONENT_AREA,
    envNum(legacyBackground.minForegroundComponentArea, cfg.delta.minLargestComponentArea)
  );
  cfg.delta.minEdgeDiffRatio = envNum(
    process.env.IMAGE_FILTER_EDGE_DIFF_RATIO_THRESHOLD,
    envNum(source.edgeDiffRatioThreshold, cfg.delta.minEdgeDiffRatio)
  );
  cfg.delta.highForegroundArea = envNum(
    process.env.IMAGE_FILTER_HIGH_FOREGROUND_AREA,
    envNum(legacyBackground.highForegroundArea, cfg.delta.highForegroundArea)
  );
  cfg.delta.highEdgeDiffRatio = envNum(
    process.env.IMAGE_FILTER_HIGH_EDGE_DIFF_RATIO,
    envNum(source.highEdgeDiffRatio, cfg.delta.highEdgeDiffRatio)
  );

  cfg.event.enabled = envBool(process.env.IMAGE_FILTER_EVENT_ENABLED, cfg.event.enabled);
  cfg.event.minConfirmFrames = envNum(process.env.IMAGE_FILTER_EVENT_MIN_CONFIRM_FRAMES, cfg.event.minConfirmFrames);
  cfg.event.maxConfirmGapSeconds = envNum(
    process.env.IMAGE_FILTER_EVENT_MAX_CONFIRM_GAP_SECONDS,
    cfg.event.maxConfirmGapSeconds
  );
  cfg.event.strongSingleFrameScore = envNum(
    process.env.IMAGE_FILTER_EVENT_STRONG_SINGLE_FRAME_SCORE,
    cfg.event.strongSingleFrameScore
  );
  cfg.event.strongSingleFrameMinZones = envNum(
    process.env.IMAGE_FILTER_EVENT_STRONG_SINGLE_FRAME_MIN_ZONES,
    cfg.event.strongSingleFrameMinZones
  );
  cfg.event.maxActiveSendGapSeconds = envNum(
    process.env.IMAGE_FILTER_EVENT_MAX_ACTIVE_SEND_GAP_SECONDS,
    cfg.event.maxActiveSendGapSeconds
  );
  cfg.event.quietFramesToEnd = envNum(
    process.env.IMAGE_FILTER_EVENT_QUIET_FRAMES_TO_END,
    cfg.event.quietFramesToEnd
  );
  if (process.env.IMAGE_FILTER_EVENT_QUIET_FRAMES_TO_END === undefined
    && process.env.IMAGE_FILTER_EVENT_QUIET_SECONDS !== undefined) {
    cfg.event.quietFramesToEnd = Math.max(1, Math.round(envNum(process.env.IMAGE_FILTER_EVENT_QUIET_SECONDS, 2)));
  }
  cfg.event.maxSendsPerEvent = envNum(process.env.IMAGE_FILTER_EVENT_MAX_SENDS_PER_EVENT, cfg.event.maxSendsPerEvent);
  cfg.event.minSecondsBetweenSends = envNum(process.env.IMAGE_FILTER_EVENT_MIN_SECONDS_BETWEEN_SENDS, cfg.event.minSecondsBetweenSends);
  cfg.event.cooldownSeconds = envNum(process.env.IMAGE_FILTER_EVENT_COOLDOWN_SECONDS, cfg.event.cooldownSeconds);
  cfg.event.sendLastFrame = envBool(process.env.IMAGE_FILTER_EVENT_SEND_LAST_FRAME, cfg.event.sendLastFrame);
  cfg.event.minScoreForActiveSend = envNum(
    process.env.IMAGE_FILTER_EVENT_MIN_SCORE_FOR_ACTIVE_SEND,
    envNum(process.env.IMAGE_FILTER_EVENT_PEAK_MOTION_SCORE, cfg.event.minScoreForActiveSend)
  );

  cfg.brightnessGuard.enabled = envBool(process.env.IMAGE_FILTER_BRIGHTNESS_GUARD_ENABLED, cfg.brightnessGuard.enabled);
  cfg.brightnessGuard.maxUniformDelta = envNum(process.env.IMAGE_FILTER_BRIGHTNESS_MAX_UNIFORM_DELTA, cfg.brightnessGuard.maxUniformDelta);
  cfg.brightnessGuard.maxStdDelta = envNum(process.env.IMAGE_FILTER_BRIGHTNESS_MAX_STD_DELTA, cfg.brightnessGuard.maxStdDelta);
  cfg.brightnessGuard.maxForegroundRatio = envNum(process.env.IMAGE_FILTER_BRIGHTNESS_MAX_FOREGROUND_RATIO, cfg.brightnessGuard.maxForegroundRatio);
  cfg.nativeSignal.enabled = envBool(process.env.IMAGE_FILTER_NATIVE_SIGNAL_ENABLED, cfg.nativeSignal.enabled);
  cfg.nativeSignal.personVehicleAnimalOnly = envBool(
    process.env.IMAGE_FILTER_NATIVE_PERSON_VEHICLE_ANIMAL_ONLY,
    cfg.nativeSignal.personVehicleAnimalOnly
  );
  cfg.debug.writeDebugJson = envBool(process.env.IMAGE_FILTER_WRITE_DEBUG_JSON, cfg.debug.writeDebugJson);
  cfg.debug.debugDir = envStr(process.env.IMAGE_FILTER_DEBUG_DIR, cfg.debug.debugDir);

  const compareCropRaw = process.env.IMAGE_FILTER_COMPARE_CROP;
  if (compareCropRaw) {
    try {
      const parsed = JSON.parse(compareCropRaw);
      if (parsed && typeof parsed === 'object') cfg.compareCrop = parsed;
    } catch (e) {
      console.warn('[FILTER] Invalid IMAGE_FILTER_COMPARE_CROP JSON, ignoring.');
    }
  }

  const roiMaskRaw = process.env.IMAGE_FILTER_ROI_MASK;
  if (roiMaskRaw) {
    try {
      const parsed = JSON.parse(roiMaskRaw);
      if (parsed && typeof parsed === 'object') cfg.roiMask = parsed;
    } catch (e) {
      console.warn('[FILTER] Invalid IMAGE_FILTER_ROI_MASK JSON, ignoring.');
    }
  }

  const exclusionZonesRaw = process.env.IMAGE_FILTER_EXCLUSION_ZONES;
  if (exclusionZonesRaw) {
    try {
      const parsed = JSON.parse(exclusionZonesRaw);
      if (Array.isArray(parsed)) {
        cfg.zoneModel.exclusionPolygons = parsed;
      }
    } catch (e) {
      console.warn('[FILTER] Invalid IMAGE_FILTER_EXCLUSION_ZONES JSON, ignoring.');
    }
  }

  const focusZonesRaw = process.env.IMAGE_FILTER_FOCUS_ZONES;
  if (focusZonesRaw) {
    try {
      const parsed = JSON.parse(focusZonesRaw);
      if (Array.isArray(parsed)) {
        cfg.zoneModel.focusZones = parsed;
      }
    } catch (e) {
      console.warn('[FILTER] Invalid IMAGE_FILTER_FOCUS_ZONES JSON, ignoring.');
    }
  }

  return cfg;
}

async function updateFilterState(patch) {
  return withFilterStateLock(async () => {
    const current = await readFilterStateUnlocked();
    const next = Object.assign({}, current || {}, patch || {});
    if (isDryRun) {
      dryRunStateOverride = next;
      return next;
    }

    await retryFilterStateOperation('ensure_dir', () => fileTools.ensureDir(FILTER_STATE_DIR));
    await retryFilterStateOperation('write_state', () => fileTools.writeJson(FILTER_STATE_FILE, next, { spaces: 2 }));
    filterStateCache = next;
    return next;
  });
}

async function readFilterState() {
  return withFilterStateLock(async () => readFilterStateUnlocked());
}

function withFilterStateLock(taskFn) {
  return filterStateOperation.enqueue(taskFn);
}

function isTransientFilterStateError(error) {
  const code = String(error && error.code ? error.code : '').toUpperCase();
  const message = String(error?.message || error || '').toLowerCase();
  return (
    code === 'UNKNOWN'
    || code === 'EBUSY'
    || code === 'EPERM'
    || code === 'EACCES'
    || message.includes('unknown error, open')
    || message.includes('resource busy')
    || message.includes('busy')
    || message.includes('permission denied')
  );
}

async function retryFilterStateOperation(label, taskFn, attempts = 5) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await taskFn();
    } catch (error) {
      lastError = error;
      if (!isTransientFilterStateError(error) || attempt >= attempts) {
        throw error;
      }
      console.warn(
        `[FILTER] state_${label} retry=${attempt}/${attempts} reason=${error.message || error}`
      );
      await delay(75 * attempt);
    }
  }
  throw lastError || new Error(`filter_state_${label}_failed`);
}

async function readFilterStateUnlocked() {
  if (isDryRun && dryRunStateOverride) return dryRunStateOverride;
  if (filterStateCache) return filterStateCache;

  try {
    if (!await retryFilterStateOperation('path_exists', () => fileTools.pathExists(FILTER_STATE_FILE))) return null;
    filterStateCache = await retryFilterStateOperation('read', () => fileTools.readJson(FILTER_STATE_FILE));
    return filterStateCache;
  } catch (e) {
    console.warn(`[FILTER] Failed to read state file: ${e.message}`);
    return null;
  }
}

async function bootstrapMotionDetector(options = {}) {
  if (motionDetectorBootstrapped && !options.force) return;

  const state = await readFilterState();
  const candidates = [];
  if (state && state.lastObservedPath) candidates.push(state.lastObservedPath);
  if (state && state.lastSentPath) candidates.push(state.lastSentPath);

  const fallbackDirs = [
    getPendingDir(),
    config.saveDir,
    path.join(path.dirname(config.saveDir), imageFilterConfig.filteredDirName)
  ];

  for (const dir of fallbackDirs) {
    const latest = await latestImageInDir(dir);
    if (latest) candidates.push(latest);
  }

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      if (!await fileTools.pathExists(candidate)) continue;
      await motionDetector.primeWithFrame(candidate);
      motionDetectorBootstrapped = true;
      console.log(`[FILTER] Bootstrapped baseline from ${candidate}`);
      return;
    } catch (e) {
      console.warn(`[FILTER] Bootstrap frame ignored (${candidate}): ${e.message}`);
    }
  }

  motionDetectorBootstrapped = true;
}

function startRuntimeHeartbeat() {
  if (runtimeHeartbeat || isDryRun) return;

  runtimeHeartbeat = setInterval(async () => {
    try {
      const now = Date.now();
      await maybeRunWhatsAppHealthCheck(now);
      const actions = await runtimeSupervisor.evaluate(
        motionDetector.getStatus(),
        now,
        { whatsapp: getWhatsAppHealthSnapshot() }
      );
      for (const action of actions) {
        await handleRecoveryAction(action);
      }
    } catch (e) {
      console.error('[HEALTH] heartbeat failed:', e.message || e);
    }
  }, Math.max(5_000, runtimeConfig.heartbeatMs));

  if (runtimeHeartbeat.unref) runtimeHeartbeat.unref();
}

async function handleRecoveryAction(action) {
  if (!action || action.type !== 'reset_detector') return;

  console.warn(`[HEALTH] recovery=${action.reason} mode=${action.mode}`);
  motionDetector.resetRuntime({
    clearLearning: !!action.clearLearning,
    clearSceneModel: !!action.clearSceneModel
  });
  await bootstrapMotionDetector({ force: true });
  runtimeSupervisor.recordRecovery(action.reason, action.mode || 'soft');
}

// -----------------------------------------------------------------------------
// Injection waiters
// -----------------------------------------------------------------------------

function ensureActiveClient(clientInstance, label) {
  if (!clientInstance || client !== clientInstance) {
    throw new Error(`${label}: stale client instance`);
  }

  const page = clientInstance.pupPage;
  if (!page) {
    throw new Error(`${label}: missing puppeteer page`);
  }

  if (typeof page.isClosed === 'function' && page.isClosed()) {
    throw new Error(`${label}: puppeteer page already closed`);
  }

  return page;
}

function isReconnectableSendError(message) {
  const msg = String(message || '').toLowerCase();
  return (
    msg.includes('target closed') ||
    msg.includes('session closed') ||
    msg.includes('execution context was destroyed') ||
    msg.includes('protocol error') ||
    msg.includes('disconnected') ||
    msg.includes('getchat') ||
    msg.includes('wwebjs') ||
    msg.includes('navigation')
  );
}

async function getWWebJSStatus(clientInstance = client) {
  const page = ensureActiveClient(clientInstance, 'getWWebJSStatus');
  return page.evaluate(() => ({
    hasStore: !!window.Store,
    hasWWebJS: !!window.WWebJS,
    hasGetChat: !!window.WWebJS?.getChat,
    hasSendMessage: !!window.WWebJS?.sendMessage,
    hasSendSeen: !!window.WWebJS?.sendSeen
  }));
}

async function ensureWWebJSHelpers(clientInstance = client, timeoutMs = 15_000) {
  const start = Date.now();
  let reinjected = false;

  while (Date.now() - start < timeoutMs) {
    let status = null;
    try {
      status = await getWWebJSStatus(clientInstance);
      if (status.hasStore && status.hasGetChat && status.hasSendMessage && status.hasSendSeen) {
        return status;
      }

      if (status.hasStore && !reinjected) {
        console.warn('[INJECT] WWebJS helpers fehlen, lade Utils neu.');
        const page = ensureActiveClient(clientInstance, 'ensureWWebJSHelpers');
        await page.evaluate(LoadUtils);
        reinjected = true;
      }
    } catch (_) {}

    await delay(500);
  }

  throw new Error('WWebJS helpers unavailable');
}

function createAuthInterventionRequiredError(reason = 'auth_intervention_required') {
  const message =
    `${reason} conn=${whatsappHealth.connectionState || '-'} ` +
    `app=${whatsappHealth.appState || '-'} qrVisible=${whatsappHealth.qrVisible ? 'true' : 'false'}`;
  const error = new Error(message);
  error.code = 'AUTH_INTERVENTION_REQUIRED';
  error.authInterventionRequired = true;
  error.notificationDetail = {
    verificationStatus: 'failed',
    authInterventionRequired: true,
    failureReason: message
  };
  return error;
}

async function waitForMessagingReady(timeoutMs = 45_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (isAwaitingManualAuth()) {
      throw createAuthInterventionRequiredError('manual_login_required');
    }
    if (client && authEstablished && messagingBootstrapped) {
      try {
        ensureActiveClient(client, 'waitForMessagingReady');
        return client;
      } catch (_) {}
    }
    await delay(500);
  }

  throw new Error(
    `messaging not ready after ${timeoutMs}ms ` +
    `status=${whatsappHealth.status} conn=${whatsappHealth.connectionState} ` +
    `initFails=${whatsappHealth.consecutiveInitializeFailures} ` +
    `lastInitFailure=${whatsappHealth.lastInitializeFailureReason || '-'}`
  );
}

async function waitForWWebInjection(clientInstance = client, timeoutMs = 120_000) {
  try {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const page = ensureActiveClient(clientInstance, 'waitForWWebInjection');
        const ok = await page.evaluate(() => {
          const s = window.Store;
          return !!(s && s.Chat && s.Msg && s.Conn);
        });
        if (ok) {
          console.log('[INJECT] Store detected.');
          return;
        }
      } catch (_) {}
      await delay(500);
    }
    throw new Error('Store injection timeout');
  } catch (e) {
    console.error('[INJECT] waitForWWebInjection failed:', e.message);
    throw e;
  }
}

async function waitForWWebJS(clientInstance = client, timeoutMs = 120_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const status = await ensureWWebJSHelpers(clientInstance, Math.min(5_000, timeoutMs));
      if (status.hasGetChat && status.hasSendMessage && status.hasSendSeen) {
        console.log('[INJECT] WWebJS helpers detected.');
        return;
      }
    } catch (_) {}
    await delay(500);
  }
  console.error('[INJECT] waitForWWebJS timed out - aborting.');
  throw new Error('WWebJS injection timeout');
}

async function patchSendSeen(clientInstance = client) {
  const page = ensureActiveClient(clientInstance, 'patchSendSeen');
  await page.evaluate(() => {
    if (!window.WWebJS || !window.WWebJS.sendSeen) return;
    const current = window.WWebJS.sendSeen;
    if (current._patched) return;
    const wrapped = async (chat) => {
      try {
        if (!chat || !chat.id) return null;
        return await current(chat);
      } catch (_) { return null; }
    };
    wrapped._patched = true;
    window.WWebJS.sendSeen = wrapped;
  });
}

// -----------------------------------------------------------------------------
// Chats & watcher
// -----------------------------------------------------------------------------

async function processChats(clientInstance = client) {
  await ensureChatId({ clientInstance, force: true });
}

async function resolveChatIdByName(name, clientInstance = client) {
  const page = ensureActiveClient(clientInstance, 'resolveChatIdByName');
  return page.evaluate((needle) => {
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

async function listChatNames(limit = 25, clientInstance = client) {
  const page = ensureActiveClient(clientInstance, 'listChatNames');
  const names = await page.evaluate((limit) => {
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

async function ensureChatId(options = {}) {
  const force = !!options.force;
  const clientInstance = options.clientInstance || client;

  if (!force && chatId) {
    return chatId;
  }
  if (!force && chatResolvePromise) {
    return chatResolvePromise;
  }

  chatResolvePromise = (async () => {
    try {
      const activeClient = clientInstance || await waitForMessagingReady(20_000);
      await waitForWWebJS(activeClient, 8_000);

      const id = await resolveChatIdByName(config.chatName, activeClient);
      if (id) {
        if (chatId !== id) {
          console.log(`[CHATS] Chat "${config.chatName}" -> id: ${id}`);
        }
        chatId = id;
        markChatResolutionSuccess(id);
        return chatId;
      }

      const names = await listChatNames(25, activeClient);
      console.warn(`[CHATS] Chat "${config.chatName}" NOT found.`);
      if (names.length) {
        console.warn(`[CHATS] Available (first ${names.length}): ${names.join(', ')}`);
      }
      chatId = null;
      markChatResolutionFailure(new Error(`chat_not_found:${config.chatName}`));
      return null;
    } catch (error) {
      chatId = null;
      markChatResolutionFailure(error);
      throw error;
    } finally {
      chatResolvePromise = null;
    }
  })();

  return chatResolvePromise;
}

function watchDirectory(directory) {
  const watcher = chokidar.watch(directory, {
    ignored: /(^|[\/\\])\../,
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 800, pollInterval: 100 }
  });

  watcher.on('add', async (filePath) => {
    const file = path.basename(filePath);
    const lower = file.toLowerCase();
    if (lower.includes('_tmp') || lower.endsWith('.tmp')) return;
    const ext = path.extname(file).toLowerCase();
    if (ext === String(config.fileExtension).toLowerCase() && await isWritable(filePath)) {
      runtimeSupervisor.recordFrameQueued(filePath);
      try {
        await enqueueProcessing(filePath, () => processFile(filePath));
      } catch (e) {
        console.error('[WATCHER] processFile error:', e);
      }
    }
  });

  watcher.on('error', (err) => console.error('[WATCHER] error:', err));
}

// -----------------------------------------------------------------------------
// Image filter
// -----------------------------------------------------------------------------

async function shouldSendImage(currentPath, appConfig) {
  const filterCfg = imageFilterConfig;
  const metrics = {};
  const frameContext = await readFrameContext(currentPath);

  if (!filterCfg || filterCfg.enabled === false) {
    return { send: true, metrics, reason: 'filter_disabled', frameContext };
  }

  try {
    return Object.assign({ frameContext }, await motionDetector.analyzeFrame(currentPath, new Date(), frameContext));
  } catch (e) {
    const failMode = String(filterCfg.failMode || 'open').toLowerCase();
    const send = failMode !== 'closed';
    return {
      send,
      metrics: Object.assign({}, metrics, { error: e.message }),
      reason: send ? 'filter_error_open' : 'filter_error_closed',
      frameContext
    };
  }
}

function logFilterDecision(filePath, decision) {
  const ts = new Date().toISOString();
  const file = path.basename(filePath);
  const ratio = Number.isFinite(decision.metrics.edgeDiffRatio) ? decision.metrics.edgeDiffRatio.toFixed(6) : 'n/a';
  const fgRatio = Number.isFinite(decision.metrics.fgRatio) ? decision.metrics.fgRatio.toFixed(6) : 'n/a';
  const motionScore = Number.isFinite(decision.metrics.motionScore) ? decision.metrics.motionScore.toFixed(6) : 'n/a';
  const phase = decision.phase || 'n/a';
  const eventId = Number.isFinite(decision.eventId) ? decision.eventId : 'n/a';
  const sendType = decision.sendType || '-';
  const sceneLabel = decision.scene && decision.scene.classification ? decision.scene.classification.label : 'n/a';
  const verdict = decision.send ? 'SEND' : 'SKIP';
  const acceptedByJava = deriveAcceptedByJava(decision.frameContext);
  const seenBySnapshotter = true;
  const whyNotSent = decision.send ? '-' : (decision.reason || 'unknown');
  console.log(
    `[FILTER] ${ts} ${file} accepted_by_java=${acceptedByJava} seen_by_snapshotter=${seenBySnapshotter}` +
    ` motion_score=${motionScore} event_state=${phase} event=${eventId} scene=${sceneLabel}` +
    ` edgeRatio=${ratio} fgRatio=${fgRatio} sendType=${sendType} decision=${verdict} why_not_sent=${whyNotSent}`
  );
}

// -----------------------------------------------------------------------------
// File processing
// -----------------------------------------------------------------------------

async function processFile(filePath) {
  await bootstrapMotionDetector();
  const decision = await shouldSendImage(filePath, config);
  logFilterDecision(filePath, decision);

  const destination = decision.send
    ? getPendingDestination(filePath)
    : getFilteredDestination(filePath);
  await moveFile(filePath, destination);
  await moveRelatedMetadata(filePath, destination);

  const archivedFrameContext = await readFrameContext(destination);
  const nowIso = new Date().toISOString();
  const statePatch = {
    lastObservedPath: destination,
    lastObservedAt: nowIso
  };
  if (decision.send) {
    statePatch.lastQueuedPath = destination;
    statePatch.lastQueuedAt = nowIso;
  }
  await updateFilterState(statePatch);

  await runtimeSupervisor.recordDecision({
    sourcePath: filePath,
    archivedPath: destination,
    decision,
    frameContext: archivedFrameContext || decision.frameContext
  });

  dataCollector.collect({
    imagePath: destination,
    decision,
    frameContext: archivedFrameContext || decision.frameContext
  });

  if (decision.send && !isDryRun) {
    enqueueNotification(destination, () => sendImage(destination));
  }
}

function enqueueProcessing(filePath, taskFn) {
  const wrapped = async () => {
    runtimeSupervisor.recordProcessingStarted(filePath);
    try {
      return await taskFn();
    } catch (error) {
      await runtimeSupervisor.recordProcessingError(filePath, error);
      throw error;
    }
  };
  return processingQueue.enqueue(wrapped);
}

function enqueueNotification(filePath, taskFn) {
  cancelPendingNotificationRetryTimer(filePath);
  console.log(
    `[SEND] queue_add file=${path.basename(filePath)} path=${filePath} queueRetries=${getPendingNotificationRetryCount(filePath)}`
  );
  runtimeSupervisor.recordNotificationQueued(filePath);
  const wrapped = async () => {
    try {
      const result = await taskFn();
      clearPendingNotificationRetry(filePath);
      await runtimeSupervisor.recordNotificationResult({ filePath, success: true, details: result });
      return result;
    } catch (error) {
      const notificationDetails = error && error.notificationDetail ? error.notificationDetail : null;
      const willRetry = !(notificationDetails && notificationDetails.doNotRetry);
      if (notificationDetails && !notificationDetails.finalDisposition) {
        notificationDetails.finalDisposition = willRetry ? 'retry' : 'failed';
      }
      await runtimeSupervisor.recordNotificationResult({
        filePath,
        success: false,
        error,
        details: notificationDetails
      });
      if (willRetry) {
        schedulePendingNotificationRetry(filePath, notificationDetails);
      }
      throw error;
    }
  };
  const next = notificationQueue.enqueue(wrapped);
  return next.catch((error) => {
    console.error('[SEND] Notification failed:', error.message || error);
  });
}

function getPendingNotificationRetryCount(filePath) {
  const state = pendingNotificationRetryState.get(path.resolve(filePath));
  return state ? state.count : 0;
}

function cancelPendingNotificationRetryTimer(filePath) {
  const timer = pendingNotificationRetryTimers.get(path.resolve(filePath));
  if (timer) {
    clearTimeout(timer);
    pendingNotificationRetryTimers.delete(path.resolve(filePath));
  }
}

function clearPendingNotificationRetry(filePath) {
  cancelPendingNotificationRetryTimer(filePath);
  pendingNotificationRetryState.delete(path.resolve(filePath));
}

function computePendingNotificationRetryDelay(state) {
  const baseDelayMs = Math.max(5_000, runtimeConfig.pendingRetryDelayMs || 30_000);
  const maxDelayMs = Math.max(baseDelayMs, runtimeConfig.pendingRetryMaxDelayMs || (15 * 60 * 1000));
  if (state && state.authInterventionRequired) {
    return Math.min(
      maxDelayMs,
      Math.max(baseDelayMs, whatsappConfig.authInterventionRetryDelayMs || (5 * 60 * 1000))
    );
  }
  const backoffFactor = Math.max(0, (state?.count || 1) - 1);
  return Math.min(maxDelayMs, baseDelayMs * Math.pow(2, Math.min(backoffFactor, 6)));
}

function schedulePendingNotificationRetry(filePath, detail = null) {
  if (isDryRun || isShuttingDown) {
    return;
  }

  const pendingPath = path.resolve(filePath);
  if (path.resolve(path.dirname(pendingPath)) !== path.resolve(getPendingDir())) {
    return;
  }
  if (pendingNotificationRetryTimers.has(pendingPath)) {
    return;
  }

  const nextState = Object.assign({}, pendingNotificationRetryState.get(pendingPath) || {}, {
    count: getPendingNotificationRetryCount(pendingPath) + 1,
    lastFailureAt: Date.now(),
    lastFailureReason: detail && detail.failureReason ? detail.failureReason : null,
    authInterventionRequired: !!(detail && detail.authInterventionRequired)
  });
  pendingNotificationRetryState.set(pendingPath, nextState);

  const delayMs = computePendingNotificationRetryDelay(nextState);
  console.warn(
    `[SEND] retry_pending file=${path.basename(pendingPath)} queueRetry=${nextState.count} ` +
    `delayMs=${delayMs} authRequired=${nextState.authInterventionRequired ? 'true' : 'false'} ` +
    `reason=${nextState.lastFailureReason || '-'}`
  );

  const timer = setTimeout(async () => {
    pendingNotificationRetryTimers.delete(pendingPath);
    if (isShuttingDown) {
      return;
    }

    try {
      if (!await fileTools.pathExists(pendingPath)) {
        pendingNotificationRetryState.delete(pendingPath);
        return;
      }
      enqueueNotification(pendingPath, () => sendImage(pendingPath));
    } catch (error) {
      console.error('[SEND] pending retry enqueue failed:', error.message || error);
    }
  }, delayMs);

  if (timer.unref) timer.unref();
  pendingNotificationRetryTimers.set(pendingPath, timer);
}

async function finalizeVerifiedSend(imagePath) {
  const finalPath = getSentDestination(imagePath);
  if (path.resolve(imagePath) !== path.resolve(finalPath)) {
    await moveFile(imagePath, finalPath);
    await moveRelatedMetadata(imagePath, finalPath);
  }

  const nowIso = new Date().toISOString();
  await updateFilterState({
    lastObservedPath: finalPath,
    lastObservedAt: nowIso,
    lastSentPath: finalPath,
    lastSentAt: nowIso
  });
  clearPendingNotificationRetry(imagePath);
  return finalPath;
}

async function buildImageCaption(imagePath) {
  const frameContext = await readFrameContext(imagePath) || {};
  const timestamp = pickMessageTimestamp(frameContext, Date.now());
  return {
    frameContext,
    captionText: formatWhatsAppCaption(timestamp)
  };
}

async function sendVerifiedWhatsAppMessage({
  activeClient,
  targetChatId,
  kind,
  content,
  sendOptions,
  timeoutMs = runtimeConfig.sendTimeoutMs || 45_000,
  fileName = null,
  sourcePath = null,
  captionText = null,
  label = 'sendMessage'
}) {
  // whatsapp-web.js can block indefinitely on sendMsgResultPromise when
  // waitUntilMsgSent is enabled, even though the message object is already
  // available in the local store. We verify delivery ourselves afterwards.
  const normalizedSendOptions = Object.assign({}, sendOptions || {}, {
    waitUntilMsgSent: false
  });
  const sentMessage = await withTimeout(
    activeClient.sendMessage(targetChatId, content, normalizedSendOptions),
    timeoutMs,
    label
  );
  const messageId = extractMessageId(sentMessage);
  const returnedAck = normalizeAck(sentMessage && sentMessage.ack);

  registerOutboundMessage(messageId, {
    kind,
    fileName,
    sourcePath,
    captionText,
    targetChatId
  });

  console.log(
    `[SEND] library_result kind=${kind} file=${fileName || '-'} messageObject=${!!sentMessage} ` +
    `messageId=${messageId || '-'} ack=${formatAck(returnedAck)}`
  );
  if (!sentMessage) {
    throw new Error('send_message_returned_empty');
  }

  const verification = await verifySentMessage(
    activeClient,
    targetChatId,
    sentMessage,
    runtimeConfig.sendAckTimeoutMs || timeoutMs
  );

  return { sentMessage, verification };
}

async function sendImage(imagePath) {
  const fileName = path.basename(imagePath);
  const startedAtMs = Date.now();
  const maxTries = Math.max(1, whatsappConfig.maxRetries || runtimeConfig.notificationMaxRetries || 3);
  const queueRetries = getPendingNotificationRetryCount(imagePath);
  console.log(`[SEND] queued file=${fileName} attempts=${maxTries} queueRetries=${queueRetries}`);

  if (!await fileTools.pathExists(imagePath)) {
    throw new Error(`pending_image_missing:${fileName}`);
  }

  for (let i = 1; i <= maxTries; i++) {
    whatsappHealth.lastSendAttemptAt = Date.now();
    whatsappHealth.lastMediaSendAttemptAt = whatsappHealth.lastSendAttemptAt;
    let targetChatId = null;
    let targetChat = null;
    let sentMessage = null;
    let captionText = null;
    try {
      const caption = await buildImageCaption(imagePath);
      captionText = caption.captionText;
      console.log(
        `[SEND] attempt_start file=${fileName} attempt=${i}/${maxTries} queueRetries=${queueRetries} ` +
        `health=${whatsappHealth.status} conn=${whatsappHealth.connectionState} app=${whatsappHealth.appState || '-'} ` +
        `captionAttached=true caption=${JSON.stringify(captionText)}`
      );
      const activeClient = await waitForMessagingReady(runtimeConfig.sendTimeoutMs || 45_000);
      targetChatId = await ensureChatId({ clientInstance: activeClient });
      if (!targetChatId) throw new Error('chatId not set');

      await Promise.all([waitForWWebJS(activeClient, 8_000), patchSendSeen(activeClient)]);
      targetChat = await resolveTargetChat(activeClient, targetChatId);
      console.log(
        `[SEND] target_resolved file=${fileName} chat=${targetChatId} ` +
        `title="${targetChat.title}" isGroup=${targetChat.isGroup}`
      );

      const media = MessageMedia.fromFilePath(imagePath);
      const sendResult = await sendVerifiedWhatsAppMessage({
        activeClient,
        targetChatId,
        kind: 'media',
        content: media,
        sendOptions: { waitUntilMsgSent: true, caption: captionText },
        fileName,
        sourcePath: imagePath,
        captionText
      });
      sentMessage = sendResult.sentMessage;
      const verification = sendResult.verification;
      const finalPath = await finalizeVerifiedSend(imagePath);
      const result = {
        startedAtMs,
        durationMs: Date.now() - startedAtMs,
        attempts: i,
        queueRetries,
        kind: 'media',
        file: fileName,
        sourcePath: imagePath,
        finalPath,
        captionAttached: true,
        captionText,
        targetChatId,
        targetChatTitle: targetChat.title,
        targetChatIsGroup: targetChat.isGroup,
        messageObjectReturned: !!sentMessage,
        messageId: verification.messageId,
        ack: verification.ack,
        ackLabel: ackLabel(verification.ack),
        verificationStatus: verification.verificationStatus,
        verificationMethod: verification.verificationMethod,
        messageExists: !!verification.messageExists,
        chatContainsMessage: !!verification.chatContainsMessage,
        deliveryInfo: verification.deliveryInfo || null,
        clientState: whatsappHealth.connectionState,
        appState: whatsappHealth.appState,
        whatsappStatus: whatsappHealth.status,
        recoveryMode: whatsappHealth.lastRecoveryMode,
        healthState: whatsappHealth.status,
        finalDisposition: 'sent'
      };

      console.log(
        `[SEND] verified file=${fileName} messageId=${result.messageId} ack=${result.ackLabel} ` +
        `via=${result.verificationMethod} caption=${JSON.stringify(result.captionText)} finalPath=${result.finalPath}`
      );
      reconnectAttempts = 0;
      recordVerifiedSend('media', result);
      markWhatsAppConnected('send_verified', clearAuthInterventionExtra({
        browserAlive: true,
        browserConnected: isBrowserConnected(activeClient),
        pageAlive: isPageAlive(activeClient),
        connectionState: 'CONNECTED',
        authEstablished: true,
        messagingReady: true
      }));
      return result;
    } catch (err) {
      const msg = err?.message || String(err);
      const authInterventionRequired = !!(err && err.authInterventionRequired) || isAwaitingManualAuth();
      const detail = Object.assign({}, err && err.notificationDetail ? err.notificationDetail : {}, {
        startedAtMs,
        durationMs: Date.now() - startedAtMs,
        attempts: i,
        queueRetries,
        kind: 'media',
        file: fileName,
        sourcePath: imagePath,
        captionAttached: !!captionText,
        captionText,
        targetChatId,
        targetChatTitle: targetChat && targetChat.title ? targetChat.title : null,
        targetChatIsGroup: targetChat ? !!targetChat.isGroup : null,
        messageObjectReturned: !!sentMessage,
        appState: whatsappHealth.appState,
        clientState: whatsappHealth.connectionState,
        whatsappStatus: whatsappHealth.status,
        verificationStatus: (err && err.verificationStatus) || (err && err.deliveryState ? 'unverified' : 'failed'),
        failureReason: msg,
        finalDisposition: authInterventionRequired ? 'pending' : (i < maxTries ? 'retry' : 'pending'),
        authInterventionRequired
      });
      if (err && typeof err === 'object') {
        err.notificationDetail = detail;
      }

      if (detail.verificationStatus === 'unverified') {
        recordUnverifiedSend('media', detail);
      } else {
        recordFailedSend('media', detail);
      }
      if (authInterventionRequired) {
        markWhatsAppAuthInvalid(`send_blocked_auth_required:${fileName}`, buildAuthInterventionExtra(
          `send_blocked_auth_required:${fileName}`,
          {
            browserAlive: isBrowserConnected(client) && isPageAlive(client),
            browserConnected: isBrowserConnected(client),
            pageAlive: isPageAlive(client),
            ready: isReadyFired,
            authEstablished,
            messagingReady: messagingBootstrapped,
            connectionState: whatsappHealth.connectionState || 'QR',
            appState: whatsappHealth.appState || null,
            lastFailureAt: whatsappHealth.lastFailureAt,
            lastFailureReason: msg
          }
        ));
      } else {
        markWhatsAppDegraded(detail.verificationStatus === 'unverified' ? 'send_unverified' : 'send_failed', {
          browserAlive: isBrowserConnected(client) && isPageAlive(client),
          browserConnected: isBrowserConnected(client),
          pageAlive: isPageAlive(client),
          ready: isReadyFired,
          authEstablished,
          messagingReady: messagingBootstrapped,
          lastFailureAt: whatsappHealth.lastFailureAt,
          lastFailureReason: msg
        });
      }

      console.warn(
        `[SEND] attempt_failed file=${fileName} attempt=${i}/${maxTries} reason=${msg} ` +
        `verificationStatus=${detail.verificationStatus} messageId=${detail.messageId || '-'} ` +
        `ack=${formatAck(detail.ack)} authRequired=${authInterventionRequired ? 'true' : 'false'} ` +
        `caption=${captionText ? JSON.stringify(captionText) : '-'} finalDisposition=${detail.finalDisposition}`
      );
      if (isChatResolveError(msg)) {
        chatId = null;
      }

      if (authInterventionRequired) {
        detail.recoveryMode = 'auth_intervention_required';
        console.warn(
          `[AUTH] send_blocked_until_login file=${fileName} conn=${whatsappHealth.connectionState || '-'} ` +
          `app=${whatsappHealth.appState || '-'}`
        );
        throw err;
      }

      if (i < maxTries) {
        const unverifiedRecovery = detail.verificationStatus === 'unverified';
        detail.recoveryMode = unverifiedRecovery
          ? 'client_recreate'
          : (i >= 2 ? 'client_recreate' : 'app_reload');
        await recoverWhatsAppClient(`send_retry_${i}`, {
          minimumStep: (i >= 2 || unverifiedRecovery) ? 'client_recreate' : 'app_reload',
          maximumStep: unverifiedRecovery ? 'client_recreate' : undefined,
          preserveStatusOnExhausted: unverifiedRecovery
        });
        await delay(Math.max(500, whatsappConfig.retryDelayMs || runtimeConfig.notificationRetryDelayMs || 1_500));
      } else {
        await maybeRunDiagnosticTextProbe(`final_media_failure:${fileName}`);
        const unverifiedRecovery = detail.verificationStatus === 'unverified';
        detail.recoveryMode = 'client_recreate';
        await recoverWhatsAppClient(`final_media_failure:${fileName}`, {
          minimumStep: 'client_recreate',
          maximumStep: unverifiedRecovery ? 'client_recreate' : undefined,
          preserveStatusOnExhausted: unverifiedRecovery
        });
        if (whatsappConfig.enableAutoReconnect && isReconnectableSendError(msg)) {
          scheduleReconnect(3_000, 'send_failed');
        }
        throw err;
      }
    }
  }
}

async function resolveTargetChat(clientInstance, targetChatId) {
  const chat = await clientInstance.getChatById(targetChatId);
  const title = chat && (chat.name || chat.formattedTitle || chat.id?.user || 'unknown');
  return {
    title: String(title || 'unknown'),
    isGroup: !!(chat && chat.isGroup)
  };
}

async function verifySentMessage(clientInstance, targetChatId, sentMessage, timeoutMs) {
  const messageId = extractMessageId(sentMessage);
  const initialAck = normalizeAck(sentMessage && sentMessage.ack);
  if (!messageId) {
    throw createSendVerificationError('send_verification_missing_message_id', {
      verificationStatus: 'failed'
    });
  }
  if (initialAck !== null && initialAck >= 1) {
    return {
      messageId,
      ack: initialAck,
      messageExists: true,
      chatContainsMessage: true,
      verificationStatus: 'verified',
      verificationMethod: 'ack_immediate',
      deliveryInfo: await loadMessageDeliveryInfo(sentMessage)
    };
  }

  let lastState = {
    messageId,
    ack: initialAck,
    messageExists: !!sentMessage,
    chatContainsMessage: false,
    fromMe: sentMessage ? sentMessage.fromMe !== false : true,
    verificationStatus: 'pending',
    verificationMethod: 'pending'
  };
  const start = Date.now();
  while ((Date.now() - start) < timeoutMs) {
    await delay(400);
    lastState = await inspectSentMessage(clientInstance, targetChatId, messageId, lastState);
    if (lastState.ack !== null && lastState.ack >= 1) {
      return Object.assign({}, lastState, {
        verificationStatus: 'verified',
        verificationMethod: 'ack_poll',
        deliveryInfo: await loadMessageDeliveryInfo(sentMessage)
      });
    }
  }

  const localState = lastState.messageExists || lastState.chatContainsMessage;
  throw createSendVerificationError(
    `send_verification_timeout:${lastState.ack === null ? 'none' : lastState.ack}`,
    Object.assign({}, lastState, {
      verificationStatus: 'unverified',
      verificationMethod: localState ? 'local_store_only' : 'not_observed_in_store'
    })
  );
}

async function loadMessageDeliveryInfo(sentMessage) {
  if (!sentMessage || typeof sentMessage.getInfo !== 'function') {
    return null;
  }

  try {
    const info = await withTimeout(
      sentMessage.getInfo(),
      Math.max(1_000, runtimeConfig.messageInfoTimeoutMs || 5_000),
      'message.getInfo'
    );
    if (!info || typeof info !== 'object') {
      return null;
    }

    return {
      deliveryCount: Array.isArray(info.delivery) ? info.delivery.length : null,
      deliveryRemaining: Number.isFinite(Number(info.deliveryRemaining)) ? Number(info.deliveryRemaining) : null,
      readCount: Array.isArray(info.read) ? info.read.length : null,
      readRemaining: Number.isFinite(Number(info.readRemaining)) ? Number(info.readRemaining) : null,
      playedCount: Array.isArray(info.played) ? info.played.length : null,
      playedRemaining: Number.isFinite(Number(info.playedRemaining)) ? Number(info.playedRemaining) : null
    };
  } catch (_) {
    return null;
  }
}

async function inspectSentMessage(clientInstance, targetChatId, messageId, previousState = {}) {
  let ack = normalizeAck(previousState.ack);
  let messageExists = !!previousState.messageExists;
  let chatContainsMessage = !!previousState.chatContainsMessage;
  let fromMe = previousState.fromMe !== false;

  try {
    const current = await clientInstance.getMessageById(messageId);
    if (current) {
      ack = normalizeAck(current.ack);
      messageExists = true;
      fromMe = !!current.fromMe;
    }
  } catch (_) {}

  try {
    const storeState = await inspectSentMessageInStore(clientInstance, targetChatId, messageId);
    if (storeState) {
      ack = ack !== null ? ack : normalizeAck(storeState.ack);
      messageExists = messageExists || !!storeState.messageExists;
      chatContainsMessage = chatContainsMessage || !!storeState.chatContainsMessage;
      if (storeState.fromMe !== null) {
        fromMe = !!storeState.fromMe;
      }
    }
  } catch (_) {}

  return {
    messageId,
    ack,
    messageExists,
    chatContainsMessage,
    fromMe,
    verificationMethod: 'pending'
  };
}

async function inspectSentMessageInStore(clientInstance, targetChatId, messageId) {
  const page = ensureActiveClient(clientInstance, 'inspectSentMessageInStore');
  return withTimeout(page.evaluate((chatId, targetMessageId) => {
    const normalizeId = (value) => {
      if (!value) return null;
      if (typeof value === 'string') return value;
      return value._serialized || value.id || null;
    };
    const getModels = (collection) => {
      if (!collection) return [];
      if (typeof collection.getModelsArray === 'function') return collection.getModelsArray();
      if (Array.isArray(collection._models)) return collection._models;
      if (Array.isArray(collection.models)) return collection.models;
      return [];
    };

    const msgStore = window.Store && window.Store.Msg;
    const chatStore = window.Store && window.Store.Chat;
    const widFactory = window.Store && window.Store.WidFactory;
    const direct = msgStore && typeof msgStore.get === 'function' ? msgStore.get(targetMessageId) : null;

    let chat = null;
    if (chatStore && typeof chatStore.get === 'function') {
      chat = chatStore.get(chatId);
      if (!chat && widFactory && typeof widFactory.createWid === 'function') {
        chat = chatStore.get(widFactory.createWid(chatId));
      }
    }

    const chatModels = getModels(chat && chat.msgs);
    const fromChat = chatModels.find((entry) => normalizeId(entry && entry.id) === targetMessageId) || null;
    const source = direct || fromChat;
    const ack = source && Number.isFinite(Number(source.ack)) ? Number(source.ack) : null;

    return {
      messageExists: !!source,
      chatContainsMessage: !!fromChat,
      ack,
      fromMe: source && source.id ? !!source.id.fromMe : null
    };
  }, targetChatId, messageId), 5_000, 'inspectSentMessageInStore');
}

function createSendVerificationError(message, state = {}) {
  const error = new Error(message);
  error.notificationDetail = {
    messageId: state.messageId || null,
    ack: normalizeAck(state.ack),
    ackLabel: ackLabel(state.ack),
    verificationStatus: state.verificationStatus || 'unverified',
    verificationMethod: state.verificationMethod || null,
    messageExists: !!state.messageExists,
    chatContainsMessage: !!state.chatContainsMessage,
    fromMe: state.fromMe !== false,
    deliveryInfo: state.deliveryInfo || null,
    failureReason: message
  };
  error.deliveryState = state;
  error.verificationStatus = state.verificationStatus || 'unverified';
  return error;
}

function extractMessageId(message) {
  if (!message || typeof message !== 'object') {
    return null;
  }
  const id = message.id;
  if (!id) {
    return null;
  }
  if (typeof id === 'string') {
    return id;
  }
  if (typeof id._serialized === 'string' && id._serialized) {
    return id._serialized;
  }
  if (typeof id.id === 'string' && id.id) {
    return id.id;
  }
  return null;
}

function normalizeAck(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function ackLabel(value) {
  const ack = normalizeAck(value);
  if (ack === null) return 'UNKNOWN';
  if (ack === -1) return 'ACK_ERROR';
  if (ack === 0) return 'ACK_PENDING';
  if (ack === 1) return 'ACK_SERVER';
  if (ack === 2) return 'ACK_DEVICE';
  if (ack === 3) return 'ACK_READ';
  if (ack === 4) return 'ACK_PLAYED';
  return `ACK_${ack}`;
}

function formatAck(value) {
  const ack = normalizeAck(value);
  if (ack === null) return 'unknown';
  return `${ack}(${ackLabel(ack)})`;
}

function isChatResolveError(message) {
  const msg = String(message || '').toLowerCase();
  return msg.includes('chatid not set')
    || msg.includes('chat not found')
    || msg.includes('getchat')
    || msg.includes('wid error');
}

function getSentDestination(filePath) {
  return path.join(config.saveDir, path.basename(filePath));
}

function getPendingDir() {
  return path.join(path.dirname(config.saveDir), 'pending');
}

function getPendingDestination(filePath) {
  return path.join(getPendingDir(), path.basename(filePath));
}

function getFilteredDestination(filePath) {
  const filteredDir = path.join(path.dirname(config.saveDir), imageFilterConfig.filteredDirName);
  return path.join(filteredDir, path.basename(filePath));
}

async function moveFile(filePath, destination) {
  await fileTools.move(filePath, destination, { overwrite: true });
  console.log('[MOVE] Image -> ' + destination);
}

function getMetadataPathForImage(filePath) {
  const parsed = path.parse(filePath);
  return path.join(parsed.dir, `${parsed.name}.json`);
}

async function readFrameContext(filePath) {
  const metadataPath = getMetadataPathForImage(filePath);
  try {
    if (!await fileTools.pathExists(metadataPath)) return null;
    const payload = await fileTools.readJson(metadataPath);
    return payload && typeof payload === 'object' ? payload : null;
  } catch (e) {
    console.warn(`[FILTER] Failed to read metadata for ${path.basename(filePath)}: ${e.message}`);
    return null;
  }
}

function deriveAcceptedByJava(frameContext) {
  const prefilter = frameContext && frameContext.prefilter && typeof frameContext.prefilter === 'object'
    ? frameContext.prefilter
    : null;
  if (!prefilter) return null;
  return String(prefilter.action || '').toUpperCase() === 'ACCEPT';
}

async function moveRelatedMetadata(sourceImagePath, destinationImagePath) {
  const sourceMetadata = getMetadataPathForImage(sourceImagePath);
  const destinationMetadata = getMetadataPathForImage(destinationImagePath);
  if (!await fileTools.pathExists(sourceMetadata)) return;
  await fileTools.ensureDir(path.dirname(destinationMetadata));
  await fileTools.move(sourceMetadata, destinationMetadata, { overwrite: true });
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
  const filteredDir = path.join(path.dirname(config.saveDir), imageFilterConfig.filteredDirName);
  const dirs = [config.readDir, config.saveDir, getPendingDir(), filteredDir, FILTER_STATE_DIR];
  for (const d of dirs) {
    await fileTools.ensureDir(d);
  }
}

async function latestImageInDir(dir) {
  try {
    if (!await fileTools.pathExists(dir)) return null;
    const entries = await fileTools.readdir(dir);
    const candidates = entries
      .filter((file) => /\.(jpg|jpeg)$/i.test(file))
      .map((file) => path.join(dir, file));
    if (!candidates.length) return null;

    let latest = null;
    let latestMtime = -1;
    for (const candidate of candidates) {
      const stats = await fileTools.stat(candidate);
      if (stats.mtimeMs > latestMtime) {
        latestMtime = stats.mtimeMs;
        latest = candidate;
      }
    }
    return latest;
  } catch (_) {
    return null;
  }
}

// -----------------------------------------------------------------------------
// Dry run
// -----------------------------------------------------------------------------

async function runDryRun() {
  await ensureDirs();
  await bootstrapMotionDetector();
  const dir = config.readDir;
  const entries = await fileTools.readdir(dir);
  const files = entries
    .filter((f) => path.extname(f).toLowerCase() === String(config.fileExtension).toLowerCase())
    .sort();

  console.log(`[DRY] Scanning ${files.length} file(s) in ${dir}`);
  for (const file of files) {
    const filePath = path.join(dir, file);
    const decision = await shouldSendImage(filePath, config);
    logFilterDecision(filePath, decision);
    await runtimeSupervisor.recordDecision({
      sourcePath: filePath,
      archivedPath: filePath,
      decision,
      frameContext: decision.frameContext
    });
    const state = await readFilterState();
    const nowIso = new Date().toISOString();
    await updateFilterState({
      lastObservedPath: filePath,
      lastObservedAt: nowIso,
      lastSentPath: decision.send ? filePath : (state && state.lastSentPath),
      lastSentAt: decision.send ? nowIso : (state && state.lastSentAt)
    });
  }
  console.log('[DRY] Done.');
  process.exit(0);
}

function withTimeout(promise, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timeout after ${timeoutMs}ms`));
    }, Math.max(1_000, timeoutMs));

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

function toIso(timestamp) {
  return timestamp ? new Date(timestamp).toISOString() : null;
}

async function gracefulShutdown(signal = 'shutdown', exitCode = 0) {
  if (shutdownPromise) {
    return shutdownPromise;
  }

  shutdownPromise = (async () => {
    console.log(`[SYS] Caught ${signal} - closing WhatsApp client...`);
    isShuttingDown = true;
    releaseProcessLock();

    if (runtimeHeartbeat) clearInterval(runtimeHeartbeat);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    clearReadyWatchdog();

    const currentClient = client;
    client = null;
    if (currentClient) {
      const browserPid = getBrowserProcessId(currentClient);
      await destroyClientInstance(currentClient, { forceBrowserRestart: true });
      await cleanupWhatsAppBrowserSession({
        reason: `${String(signal).toLowerCase()}_shutdown`,
        browserPid,
        forceTerminate: true
      });
    }
  })();

  try {
    await shutdownPromise;
  } finally {
    shutdownPromise = null;
  }

  process.exit(exitCode);
}

// -----------------------------------------------------------------------------
// Graceful shutdown
// -----------------------------------------------------------------------------

process.on('SIGINT', async () => {
  await gracefulShutdown('SIGINT', 0);
});

process.on('SIGTERM', async () => {
  await gracefulShutdown('SIGTERM', 0);
});

process.on('unhandledRejection', (reason) => {
  if (handleTransientBrowserError('unhandledRejection', reason)) return;
  console.error('[SYS] Unhandled rejection:', reason);
});

process.on('uncaughtException', (error) => {
  if (handleTransientBrowserError('uncaughtException', error)) return;
  console.error('[SYS] Uncaught exception:', error);
  gracefulShutdown('uncaughtException', 1).catch(() => {
    process.exit(1);
  });
});

process.on('exit', () => {
  isShuttingDown = true;
  if (runtimeHeartbeat) clearInterval(runtimeHeartbeat);
  clearReadyWatchdog();
  if (reconnectTimer) clearTimeout(reconnectTimer);
  releaseProcessLock();
});
