'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  WHATSAPP_STATUS,
  computeRecoveryStep,
  formatWhatsAppCaption,
  isBrowserProfileLockError,
  isHealthyWhatsAppStatus,
  planBrowserSessionCleanup,
  pickMessageTimestamp,
  requiresManualAuth
} = require('../src/whatsappSupport');

test('formatWhatsAppCaption uses dd.mm.yyyy hh:mm in local time', () => {
  const value = new Date(2026, 3, 2, 21, 17, 45);
  assert.equal(formatWhatsAppCaption(value), '02.04.2026 21:17');
});

test('pickMessageTimestamp prefers capturedAt metadata', () => {
  const timestamp = pickMessageTimestamp({
    capturedAt: '2026-04-02T19:17:00.000Z',
    timestamp: '2026-04-02T18:00:00.000Z'
  });
  assert.equal(timestamp.toISOString(), '2026-04-02T19:17:00.000Z');
});

test('computeRecoveryStep escalates within the configured window', () => {
  const now = Date.UTC(2026, 3, 2, 20, 0, 0);
  const history = [
    { step: 'app_reload', at: now - 30_000 },
    { step: 'client_recreate', at: now - 10_000 }
  ];
  assert.equal(computeRecoveryStep({ history, now, escalationWindowMs: 60_000 }), 'browser_restart');
});

test('computeRecoveryStep honors minimum step when no recent history exists', () => {
  const now = Date.UTC(2026, 3, 2, 20, 0, 0);
  const history = [{ step: 'app_reload', at: now - 120_000 }];
  assert.equal(
    computeRecoveryStep({ history, now, escalationWindowMs: 60_000, minimumStep: 'client_recreate' }),
    'client_recreate'
  );
});

test('computeRecoveryStep honors maximum step when escalation would go further', () => {
  const now = Date.UTC(2026, 3, 2, 20, 0, 0);
  const history = [{ step: 'browser_restart', at: now - 10_000 }];
  assert.equal(
    computeRecoveryStep({ history, now, escalationWindowMs: 60_000, maximumStep: 'browser_restart' }),
    'browser_restart'
  );
});

test('healthy whatsapp statuses include READY but not DEGRADED', () => {
  assert.equal(isHealthyWhatsAppStatus(WHATSAPP_STATUS.READY), true);
  assert.equal(isHealthyWhatsAppStatus(WHATSAPP_STATUS.DEGRADED), false);
});

test('requiresManualAuth detects QR and unpaired states', () => {
  assert.equal(
    requiresManualAuth({
      status: WHATSAPP_STATUS.AUTH_INVALID,
      connectionState: 'QR',
      appState: 'UNPAIRED',
      pageAlive: true
    }),
    true
  );
  assert.equal(
    requiresManualAuth({
      status: WHATSAPP_STATUS.DISCONNECTED,
      connectionState: 'DISCONNECTED',
      appState: null,
      pageAlive: false
    }),
    false
  );
});

test('isBrowserProfileLockError detects chromium profile lock messages', () => {
  assert.equal(
    isBrowserProfileLockError("Use a different 'userDataDir' or stop the running browser first."),
    true
  );
  assert.equal(
    isBrowserProfileLockError('The profile appears to be in use by another Google Chrome process (30).'),
    true
  );
  assert.equal(
    isBrowserProfileLockError('processsingleton lock held by another process'),
    true
  );
  assert.equal(isBrowserProfileLockError('some other initialize_failed'), false);
});

test('planBrowserSessionCleanup forces a startup cleanup before first initialize', () => {
  assert.deepEqual(
    planBrowserSessionCleanup({ startup: true }),
    {
      required: true,
      forceTerminate: true,
      reason: 'prelaunch_startup',
      browserProfileLockDetected: false
    }
  );
});

test('planBrowserSessionCleanup prioritizes profile lock recovery reason', () => {
  assert.deepEqual(
    planBrowserSessionCleanup({
      lastInitializeFailureReason: "Use a different 'userDataDir' or stop the running browser first."
    }),
    {
      required: true,
      forceTerminate: true,
      reason: 'prelaunch_profile_lock',
      browserProfileLockDetected: true
    }
  );
});
