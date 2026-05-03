'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { detectChannel, normalizeLevelName } = require('../src/logger');

test('detectChannel routes whatsapp-prefixed lines to whatsapp log', () => {
  assert.equal(detectChannel('[WA] health=READY'), 'whatsapp');
  assert.equal(detectChannel('[SEND] verified file=test.jpg'), 'whatsapp');
  assert.equal(detectChannel('[FILTER] motion_score=0.1'), 'app');
});

test('normalizeLevelName falls back to info for invalid values', () => {
  assert.equal(normalizeLevelName('warn'), 'warn');
  assert.equal(normalizeLevelName('bogus'), 'info');
});
