'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ReolinkSnapshotClient } = require('../src/reolinkSnapshotClient');

test('reolink client falls back to token auth when direct snapshot says login first', async () => {
  const calls = [];
  const originalFetch = global.fetch;

  global.fetch = async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET' });

    if (String(url).includes('cmd=Login')) {
      return createResponse(200, '[{"value":{"Token":{"name":"demo-token","leaseTime":300}}}]', 'application/json');
    }
    if (String(url).includes('cmd=GetMdState')) {
      return createResponse(200, '{"state":1}', 'application/json');
    }
    if (String(url).includes('cmd=GetAiState')) {
      return createResponse(200, '{"people":{"alarm_state":1},"vehicle":{"alarm_state":0},"dog_cat":{"alarm_state":0}}', 'application/json');
    }
    if (String(url).includes('token=demo-token')) {
      return createResponse(200, Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]), 'image/jpeg');
    }
    return createResponse(200, '[{"error":{"detail":"please login first","rspCode":-6}}]', 'application/json');
  };

  try {
    const client = new ReolinkSnapshotClient({
      host: 'cam.local',
      port: 80,
      username: 'user',
      password: 'pass',
      snapshotPath: '/cgi-bin/api.cgi?cmd=Snap&channel=0&rs={timestamp}',
      verifyTls: false
    });
    const snapshot = await client.fetchSnapshot();

    assert.equal(snapshot.contentType, 'image/jpeg');
    assert.equal(snapshot.buffer[0], 0xFF);
    assert.equal(snapshot.cameraSignal.motionDetected, true);
    assert.equal(snapshot.cameraSignal.personDetected, true);
    assert.ok(calls.some((call) => String(call.url).includes('cmd=Login')), 'login should have been requested');
    assert.ok(calls.some((call) => String(call.url).includes('token=demo-token')), 'tokenized snapshot should have been requested');
  } finally {
    global.fetch = originalFetch;
  }
});

function createResponse(status, body, contentType) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return String(name).toLowerCase() === 'content-type' ? contentType : null;
      }
    },
    async arrayBuffer() {
      return payload;
    },
    async text() {
      return payload.toString('utf8');
    }
  };
}
