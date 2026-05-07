'use strict';

const WHATSAPP_STATUS = {
  READY: 'READY',
  DEGRADED: 'DEGRADED',
  MEDIA_SEND_BROKEN: 'MEDIA_SEND_BROKEN',
  SESSION_STALE: 'SESSION_STALE',
  DISCONNECTED: 'DISCONNECTED',
  AUTH_INVALID: 'AUTH_INVALID',
  RECOVERING: 'RECOVERING'
};

const RECOVERY_STEPS = [
  'app_reload',
  'client_recreate',
  'browser_restart',
  'auth_reset'
];

const HEALTHY_WHATSAPP_STATUSES = new Set([
  WHATSAPP_STATUS.READY,
  'CONNECTED'
]);

function parseTimestampCandidate(value) {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function pickMessageTimestamp(frameContext = {}, fallback = Date.now()) {
  const candidates = [
    frameContext.capturedAt,
    frameContext.timestamp,
    frameContext.createdAt,
    frameContext.observedAt
  ];

  for (const candidate of candidates) {
    const parsed = parseTimestampCandidate(candidate);
    if (parsed) {
      return parsed;
    }
  }

  return fallback instanceof Date
    ? new Date(fallback.getTime())
    : new Date(fallback);
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function formatWhatsAppCaption(input) {
  const date = input instanceof Date ? new Date(input.getTime()) : new Date(input);
  if (!Number.isFinite(date.getTime())) {
    throw new Error('invalid_caption_timestamp');
  }

  return [
    pad(date.getDate()),
    pad(date.getMonth() + 1),
    date.getFullYear()
  ].join('.') + ' ' + [
    pad(date.getHours()),
    pad(date.getMinutes())
  ].join(':');
}

function pruneRecoveryHistory(history = [], now = Date.now(), escalationWindowMs = 10 * 60 * 1000) {
  return history.filter((entry) => {
    if (!entry || !entry.at || !entry.step) {
      return false;
    }
    return (now - entry.at) <= escalationWindowMs;
  });
}

function computeRecoveryStep({
  history = [],
  now = Date.now(),
  escalationWindowMs = 10 * 60 * 1000,
  minimumStep = RECOVERY_STEPS[0],
  maximumStep = RECOVERY_STEPS[RECOVERY_STEPS.length - 1]
} = {}) {
  const minimumIndex = RECOVERY_STEPS.includes(minimumStep)
    ? RECOVERY_STEPS.indexOf(minimumStep)
    : 0;
  const requestedMaximumIndex = RECOVERY_STEPS.includes(maximumStep)
    ? RECOVERY_STEPS.indexOf(maximumStep)
    : (RECOVERY_STEPS.length - 1);
  const maximumIndex = Math.max(minimumIndex, requestedMaximumIndex);
  const recent = pruneRecoveryHistory(history, now, escalationWindowMs);
  if (!recent.length) {
    return RECOVERY_STEPS[minimumIndex];
  }

  const last = recent[recent.length - 1];
  const lastIndex = Math.max(0, RECOVERY_STEPS.indexOf(last.step));
  return RECOVERY_STEPS[Math.min(maximumIndex, Math.max(minimumIndex, lastIndex + 1))];
}

function isHealthyWhatsAppStatus(status) {
  return HEALTHY_WHATSAPP_STATUSES.has(String(status || '').toUpperCase());
}

function isBrowserProfileLockError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return message.includes('browser is already running for')
    || (
      message.includes('userdatadir')
      && message.includes('stop the running browser first')
    )
    || message.includes('profile appears to be in use by another')
    || message.includes('already in use by another google chrome process')
    || message.includes('processsingleton');
}

function planBrowserSessionCleanup({
  startup = false,
  hasClient = false,
  forceBrowserRestart = false,
  lastInitializeFailureReason = null,
  lastFailureReason = null
} = {}) {
  const browserProfileLockDetected = isBrowserProfileLockError(lastInitializeFailureReason)
    || isBrowserProfileLockError(lastFailureReason);

  if (!(startup || hasClient || forceBrowserRestart || browserProfileLockDetected)) {
    return {
      required: false,
      forceTerminate: false,
      reason: null,
      browserProfileLockDetected: false
    };
  }

  return {
    required: true,
    forceTerminate: true,
    reason: browserProfileLockDetected
      ? 'prelaunch_profile_lock'
      : (startup ? 'prelaunch_startup' : 'prelaunch_reconnect'),
    browserProfileLockDetected
  };
}

function requiresManualAuth({
  status = null,
  connectionState = null,
  appState = null,
  pageAlive = false,
  qrVisible = false
} = {}) {
  const normalizedStatus = String(status || '').toUpperCase();
  const normalizedConnectionState = String(connectionState || '').toUpperCase();
  const normalizedAppState = String(appState || '').toUpperCase();
  const sessionAwaitingPairing = normalizedAppState === 'UNPAIRED' || normalizedAppState === 'UNPAIRED_IDLE';
  const qrAwaitingPairing = normalizedConnectionState === 'QR' || qrVisible;
  const authInvalid = normalizedStatus === WHATSAPP_STATUS.AUTH_INVALID || sessionAwaitingPairing || qrAwaitingPairing;

  return authInvalid && (qrAwaitingPairing || (pageAlive && sessionAwaitingPairing));
}

module.exports = {
  WHATSAPP_STATUS,
  RECOVERY_STEPS,
  computeRecoveryStep,
  formatWhatsAppCaption,
  isBrowserProfileLockError,
  isHealthyWhatsAppStatus,
  planBrowserSessionCleanup,
  pickMessageTimestamp,
  pruneRecoveryHistory,
  requiresManualAuth
};
