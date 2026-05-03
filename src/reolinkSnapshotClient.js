'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TOKEN_NAME_PATTERN = /"name"\s*:\s*"([^"]+)"/;
const TOKEN_LEASE_PATTERN = /"leaseTime"\s*:\s*(\d+)/;
const MD_STATE_PATTERN = /"state"\s*:\s*(\d+)/;
const PEOPLE_ALARM_PATTERN = /"people"\s*:\s*\{[^}]*"alarm_state"\s*:\s*(\d+)/s;
const VEHICLE_ALARM_PATTERN = /"vehicle"\s*:\s*\{[^}]*"alarm_state"\s*:\s*(\d+)/s;
const DOG_CAT_ALARM_PATTERN = /"dog_cat"\s*:\s*\{[^}]*"alarm_state"\s*:\s*(\d+)/s;

class ReolinkSnapshotClient {
  constructor(input = {}) {
    this.cfg = normalizeConfig(input);
    this.loginToken = null;
    this.loginTokenExpiresAt = 0;
  }

  async fetchSnapshot() {
    const direct = await this.fetchSnapshotResponse(this.buildSnapshotUrl());
    if (direct.isImage) {
      return this.toSnapshotResult(direct.buffer, direct.contentType);
    }

    if (!containsAuthFailure(direct.bodyText)) {
      throw new Error(`Snapshot endpoint returned non-image payload: ${truncate(direct.bodyText, 220)}`);
    }

    const token = await this.ensureLoginToken();
    if (!token) {
      throw new Error('Unable to acquire Reolink login token.');
    }

    const withToken = await this.fetchSnapshotResponse(this.appendToken(this.buildSnapshotUrl(), token));
    if (!withToken.isImage) {
      throw new Error(`Token snapshot endpoint returned non-image payload: ${truncate(withToken.bodyText, 220)}`);
    }

    return this.toSnapshotResult(withToken.buffer, withToken.contentType);
  }

  async fetchCameraSignal() {
    const token = await this.ensureLoginToken();
    if (!token) {
      return emptyCameraSignal();
    }

    const mdBody = await this.executeApiGet('GetMdState', token);
    const aiBody = await this.executeApiGet('GetAiState', token);
    return {
      motionDetected: extractBoolean(MD_STATE_PATTERN, mdBody),
      personDetected: extractBoolean(PEOPLE_ALARM_PATTERN, aiBody),
      vehicleDetected: extractBoolean(VEHICLE_ALARM_PATTERN, aiBody),
      animalDetected: extractBoolean(DOG_CAT_ALARM_PATTERN, aiBody)
    };
  }

  async fetchSnapshotResponse(url) {
    const headers = {};
    if (this.cfg.username || this.cfg.password) {
      headers.Authorization = `Basic ${Buffer.from(`${this.cfg.username}:${this.cfg.password}`, 'utf8').toString('base64')}`;
    }

    const response = await fetch(url, {
      method: 'GET',
      headers
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get('content-type') || '';
    const isImage = response.ok && looksLikeImage(buffer, contentType);
    return {
      ok: response.ok,
      status: response.status,
      buffer,
      contentType,
      isImage,
      bodyText: isImage ? '' : buffer.toString('utf8')
    };
  }

  async requestLoginToken() {
    const response = await fetch(this.buildLoginUrl(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: this.buildLoginPayload()
    });

    const body = await response.text();
    const tokenMatch = TOKEN_NAME_PATTERN.exec(body);
    if (!tokenMatch) {
      return null;
    }

    const leaseMatch = TOKEN_LEASE_PATTERN.exec(body);
    const leaseSeconds = leaseMatch ? Number(leaseMatch[1]) : 300;
    this.loginToken = tokenMatch[1];
    this.loginTokenExpiresAt = Date.now() + (Math.max(60, leaseSeconds - 60) * 1000);
    return this.loginToken;
  }

  async ensureLoginToken() {
    if (this.loginToken && Date.now() < this.loginTokenExpiresAt) {
      return this.loginToken;
    }
    this.loginToken = null;
    this.loginTokenExpiresAt = 0;
    return this.requestLoginToken();
  }

  async executeApiGet(command, token) {
    const url = `${this.buildApiBaseUrl()}?cmd=${encodeURIComponent(command)}&channel=0&token=${encodeURIComponent(token || '')}`;
    const response = await fetch(url, { method: 'GET' });
    const body = await response.text();
    if (response.status === 401 || containsAuthFailure(body) || /invalid user/i.test(body)) {
      this.loginToken = null;
      this.loginTokenExpiresAt = 0;
    }
    return body;
  }

  buildSnapshotUrl() {
    const template = this.cfg.snapshotUrl || `${this.cfg.scheme}://{host}:{port}${normalizePath(this.cfg.snapshotPath)}`;
    return applyTemplate(template, this.cfg);
  }

  buildApiBaseUrl() {
    return `${this.cfg.scheme}://${this.cfg.host}:${this.cfg.port}/cgi-bin/api.cgi`;
  }

  buildLoginUrl() {
    return `${this.buildApiBaseUrl()}?cmd=Login`;
  }

  buildLoginPayload() {
    return `[{"cmd":"Login","action":0,"param":{"User":{"Version":"0","userName":"${escapeJson(this.cfg.username)}","password":"${escapeJson(this.cfg.password)}"}}}]`;
  }

  appendToken(url, token) {
    const clean = url
      .replace(/([?&])(user|password)=[^&]*/g, '$1')
      .replace(/[?&]+$/, '');
    return `${clean}${clean.includes('?') ? '&' : '?'}token=${encodeURIComponent(token || '')}`;
  }

  async toSnapshotResult(buffer, contentType) {
    const cameraSignal = await this.fetchCameraSignal().catch(() => emptyCameraSignal());
    return {
      buffer,
      contentType,
      cameraSignal,
      sha256: crypto.createHash('sha256').update(buffer).digest('hex')
    };
  }
}

function readJavaProperties(filePath) {
  const out = {};
  const resolved = path.resolve(filePath);
  const lines = fs.readFileSync(resolved, 'utf8').split(/\r?\n/);
  for (const rawLine of lines) {
    if (!rawLine || /^\s*#/.test(rawLine)) {
      continue;
    }
    const line = rawLine.trim();
    const separatorIndex = line.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }
    out[line.slice(0, separatorIndex).trim()] = line.slice(separatorIndex + 1).trim();
  }
  return out;
}

function normalizeConfig(input) {
  const verifyTls = boolOr(input.verifyTls, false);
  return {
    host: strOr(input.host || input['reolink.host'], ''),
    port: numOr(input.port || input['reolink.httpPort'], 80),
    username: strOr(input.username || input['reolink.username'], ''),
    password: strOr(input.password || input['reolink.password'], ''),
    snapshotPath: strOr(input.snapshotPath || input['reolink.snapshotPath'], '/cgi-bin/api.cgi?cmd=Snap&channel=0&rs={timestamp}'),
    snapshotUrl: strOr(input.snapshotUrl || input['reolink.snapshotUrl'], ''),
    verifyTls,
    scheme: verifyTls ? 'https' : 'http'
  };
}

function looksLikeImage(buffer, contentType) {
  if (!buffer || buffer.length < 4) {
    return false;
  }

  const normalizedType = String(contentType || '').toLowerCase();
  if (normalizedType.includes('image/jpeg') || normalizedType.includes('image/jpg') || normalizedType.includes('image/png')) {
    return true;
  }

  const isJpeg = buffer[0] === 0xFF && buffer[1] === 0xD8;
  const isPng = buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47;
  return isJpeg || isPng;
}

function containsAuthFailure(bodyText) {
  const normalized = String(bodyText || '').toLowerCase();
  return normalized.includes('please login first')
    || normalized.includes('login failed')
    || normalized.includes('"rspcode" : -6')
    || normalized.includes('"rspcode" : -7');
}

function extractBoolean(pattern, body) {
  if (!body) {
    return false;
  }
  const match = pattern.exec(body);
  return !!(match && match[1] === '1');
}

function emptyCameraSignal() {
  return {
    motionDetected: false,
    personDetected: false,
    vehicleDetected: false,
    animalDetected: false
  };
}

function applyTemplate(template, cfg) {
  const timestamp = String(Date.now());
  return String(template || '')
    .replace('{host}', cfg.host)
    .replace('{port}', String(cfg.port))
    .replace('{username}', cfg.username)
    .replace('{password}', cfg.password)
    .replace('{usernameEncoded}', encodeURIComponent(cfg.username))
    .replace('{passwordEncoded}', encodeURIComponent(cfg.password))
    .replace('{timestamp}', timestamp);
}

function normalizePath(value) {
  const pathValue = strOr(value, '/');
  return pathValue.startsWith('/') ? pathValue : `/${pathValue}`;
}

function escapeJson(value) {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"');
}

function truncate(value, maxLength) {
  const text = String(value || '');
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}...`;
}

function boolOr(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function numOr(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function strOr(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  return String(value);
}

module.exports = {
  ReolinkSnapshotClient,
  readJavaProperties
};
