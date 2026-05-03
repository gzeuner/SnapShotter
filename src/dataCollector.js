'use strict';

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const fileTools = require('fs-extra');
const { SerialTaskQueue } = require('./serialTaskQueue');

const IMAGE_COPY_FLAGS = fsSync.constants.COPYFILE_EXCL;
const IMAGE_FILE_PATTERN = /\.(jpg|jpeg)$/i;

class DataCollector {
  constructor(input = {}) {
    this.cfg = normalizeConfig(input);
    this.queue = new SerialTaskQueue();
    this.hourlyCounts = new Map();
    this.lastCleanupHourKey = null;
  }

  collect(context = {}) {
    if (!this.cfg.enabled) {
      return false;
    }

    const type = resolveType(context.decision);
    if (!type || !this.isTypeEnabled(type)) {
      return false;
    }

    const observedAt = resolveObservedAt(context);
    const task = async () => {
      await this.maybeRunCleanup(observedAt);
      await this.collectInternal({
        imagePath: context.imagePath,
        decision: context.decision || {},
        frameContext: context.frameContext || null,
        observedAt,
        type
      });
    };

    this.queue.enqueue(task).catch(() => {});
    return true;
  }

  async waitForIdle() {
    await this.queue.whenIdle();
  }

  isTypeEnabled(type) {
    if (type === 'relevant') {
      return this.cfg.saveRelevant;
    }
    if (type === 'non_relevant') {
      return this.cfg.saveNonRelevant;
    }
    return false;
  }

  async collectInternal({ imagePath, decision, frameContext, observedAt, type }) {
    if (!imagePath || !await fileTools.pathExists(imagePath)) {
      return;
    }

    const slot = await this.acquireSlot(type, observedAt);
    if (!slot) {
      return;
    }

    const extension = normalizeExtension(path.extname(imagePath));
    const baseName = buildBaseName({
      imagePath,
      decision,
      frameContext,
      observedAt,
      type
    });

    const savedImagePath = await copyImageWithUniqueName(imagePath, slot.dir, baseName, extension);
    if (!savedImagePath) {
      return;
    }

    slot.count += 1;

    const metadata = buildMetadata({
      imagePath,
      savedImagePath,
      decision,
      frameContext,
      observedAt,
      type
    });
    if (!metadata) {
      return;
    }

    try {
      await fs.writeFile(
        `${savedImagePath}.json`,
        JSON.stringify(metadata, null, 2),
        'utf8'
      );
    } catch (_) {}
  }

  async acquireSlot(type, observedAt) {
    const parts = toDateParts(observedAt);
    const key = `${type}:${parts.dateKey}:${parts.hour}`;
    let slot = this.hourlyCounts.get(key);

    if (!slot) {
      const dir = path.join(this.cfg.baseDir, type, parts.dateKey, parts.hour);
      const count = await countExistingImages(dir);
      slot = { dir, count };
      this.hourlyCounts.set(key, slot);
      this.pruneHourlyCounts(parts.dateKey, parts.hour);
    }

    if (slot.count >= this.cfg.maxPerHour) {
      return null;
    }

    await fileTools.ensureDir(slot.dir);
    return slot;
  }

  pruneHourlyCounts(currentDateKey, currentHour) {
    const activeSuffix = `:${currentDateKey}:${currentHour}`;
    for (const key of this.hourlyCounts.keys()) {
      if (!key.endsWith(activeSuffix)) {
        this.hourlyCounts.delete(key);
      }
    }
  }

  async maybeRunCleanup(observedAt) {
    if (!Number.isFinite(this.cfg.maxDays) || this.cfg.maxDays <= 0) {
      return;
    }

    const parts = toDateParts(observedAt);
    const hourKey = `${parts.dateKey}:${parts.hour}`;
    if (this.lastCleanupHourKey === hourKey) {
      return;
    }
    this.lastCleanupHourKey = hourKey;

    const cutoffDate = new Date(observedAt.getTime());
    cutoffDate.setHours(0, 0, 0, 0);
    cutoffDate.setDate(cutoffDate.getDate() - this.cfg.maxDays);
    const cutoffKey = formatDateKey(cutoffDate);

    await Promise.all([
      this.cleanupTypeDir('relevant', cutoffKey),
      this.cleanupTypeDir('non_relevant', cutoffKey)
    ]);
  }

  async cleanupTypeDir(type, cutoffKey) {
    const rootDir = path.join(this.cfg.baseDir, type);
    let entries;
    try {
      entries = await fs.readdir(rootDir, { withFileTypes: true });
    } catch (_) {
      return;
    }

    await Promise.all(entries.map(async (entry) => {
      if (!entry.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(entry.name)) {
        return;
      }
      if (entry.name >= cutoffKey) {
        return;
      }
      try {
        await fileTools.remove(path.join(rootDir, entry.name));
      } catch (_) {}
    }));
  }
}

async function countExistingImages(dir) {
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isFile() && IMAGE_FILE_PATTERN.test(entry.name)).length;
  } catch (_) {
    return 0;
  }
}

async function copyImageWithUniqueName(sourceImagePath, targetDir, baseName, extension) {
  const safeExtension = normalizeExtension(extension);

  for (let attempt = 0; attempt < 100; attempt++) {
    const suffix = attempt === 0 ? '' : `_${String(attempt).padStart(2, '0')}`;
    const outputPath = path.join(targetDir, `${baseName}${suffix}${safeExtension}`);
    try {
      await fs.copyFile(sourceImagePath, outputPath, IMAGE_COPY_FLAGS);
      return outputPath;
    } catch (error) {
      if (error && error.code === 'EEXIST') {
        continue;
      }
      return null;
    }
  }

  return null;
}

function buildBaseName({ imagePath, decision, frameContext, observedAt, type }) {
  const source = parseSourceName(imagePath, frameContext);
  const timestamp = source.timestamp || formatTimestamp(observedAt);
  const typeToken = type === 'relevant' ? 'relevant' : 'nonrel';
  const parts = [timestamp];

  if (source.cameraName) {
    parts.push(source.cameraName);
  }

  parts.push(typeToken);

  const score = formatScore(decision && decision.metrics && decision.metrics.motionScore);
  if (score) {
    parts.push(`score${score}`);
  }

  return parts.join('_');
}

function buildMetadata({ imagePath, savedImagePath, decision, frameContext, observedAt, type }) {
  const metrics = decision && decision.metrics && typeof decision.metrics === 'object'
    ? decision.metrics
    : {};
  const signal = decision && decision.signal && typeof decision.signal === 'object'
    ? decision.signal
    : {};
  const scene = decision && decision.scene && decision.scene.classification
    ? decision.scene.classification
    : null;
  const payload = {
    timestamp: observedAt.toISOString(),
    type,
    sourceImage: path.basename(imagePath),
    savedImage: path.basename(savedImagePath),
    eventState: decision && decision.phase ? decision.phase : undefined,
    reason: decision && decision.reason ? decision.reason : undefined,
    sendType: decision && decision.sendType ? decision.sendType : undefined,
    motionScore: finiteOrUndefined(metrics.motionScore),
    edgeDiffRatio: finiteOrUndefined(metrics.edgeDiffRatio),
    foregroundArea: integerOrUndefined(metrics.foregroundArea),
    fgRatio: finiteOrUndefined(metrics.fgRatio),
    meanAbsDiff: finiteOrUndefined(metrics.meanAbsDiff),
    stdAbsDiff: finiteOrUndefined(metrics.stdAbsDiff),
    largestComponentArea: integerOrUndefined(metrics.largestComponentArea),
    brightnessSuppressed: typeof signal.brightnessSuppressed === 'boolean' ? signal.brightnessSuppressed : undefined,
    sceneDrivenSuppressed: typeof signal.sceneDrivenSuppressed === 'boolean' ? signal.sceneDrivenSuppressed : undefined,
    sceneLabel: scene && scene.label ? scene.label : undefined,
    sceneReason: scene && scene.reason ? scene.reason : undefined,
    sceneRelevanceScore: scene ? finiteOrUndefined(scene.relevanceScore) : undefined
  };

  const nativeSignal = signal.nativeSignal && typeof signal.nativeSignal === 'object'
    ? signal.nativeSignal
    : null;
  if (nativeSignal) {
    payload.cameraSignal = {
      active: !!nativeSignal.active,
      relevantClass: !!nativeSignal.relevantClass,
      motionDetected: !!nativeSignal.motionDetected,
      personDetected: !!nativeSignal.personDetected,
      vehicleDetected: !!nativeSignal.vehicleDetected,
      animalDetected: !!nativeSignal.animalDetected
    };
  }

  if (frameContext && typeof frameContext === 'object') {
    payload.prefilterAction = frameContext.prefilter && frameContext.prefilter.action
      ? frameContext.prefilter.action
      : undefined;
  }

  return pruneUndefined(payload);
}

function parseSourceName(imagePath, frameContext) {
  const name = path.parse(imagePath).name;
  const match = name.match(/^(\d{8}_\d{6})(?:_(.+))?$/);
  if (!match) {
    return {
      timestamp: null,
      cameraName: deriveCameraName(name, frameContext)
    };
  }

  return {
    timestamp: match[1],
    cameraName: deriveCameraName(match[2], frameContext)
  };
}

function resolveObservedAt(context) {
  if (context.observedAt instanceof Date && Number.isFinite(context.observedAt.getTime())) {
    return context.observedAt;
  }

  const capturedAt = context.frameContext
    && typeof context.frameContext === 'object'
    && context.frameContext.capturedAt;
  if (capturedAt) {
    const parsedCapturedAt = new Date(capturedAt);
    if (Number.isFinite(parsedCapturedAt.getTime())) {
      return parsedCapturedAt;
    }
  }

  const source = parseSourceName(context.imagePath || '', context.frameContext);
  if (source.timestamp) {
    const parsedFromName = parseTimestampToken(source.timestamp);
    if (parsedFromName) {
      return parsedFromName;
    }
  }

  return new Date();
}

function deriveCameraName(rawValue, frameContext) {
  const fromContext = frameContext
    && typeof frameContext === 'object'
    && frameContext.camera
    && typeof frameContext.camera.name === 'string'
      ? frameContext.camera.name
      : null;
  return sanitizeToken(fromContext || rawValue);
}

function resolveType(decision) {
  if (!decision || typeof decision !== 'object') {
    return null;
  }
  return decision.send ? 'relevant' : 'non_relevant';
}

function normalizeConfig(input) {
  const maxPerHour = Math.max(1, Math.floor(numberOr(input.maxPerHour, 10)));
  const maxDays = input.maxDays === undefined || input.maxDays === null || input.maxDays === ''
    ? null
    : Math.max(1, Math.floor(numberOr(input.maxDays, 0)));

  return {
    enabled: boolOr(input.enabled, false),
    maxPerHour,
    saveRelevant: boolOr(input.saveRelevant, true),
    saveNonRelevant: boolOr(input.saveNonRelevant, true),
    maxDays,
    baseDir: path.resolve(input.baseDir || './dataset')
  };
}

function boolOr(value, fallback) {
  return typeof value === 'boolean' ? value : fallback;
}

function numberOr(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeExtension(extension) {
  return extension && IMAGE_FILE_PATTERN.test(extension) ? extension.toLowerCase() : '.jpg';
}

function finiteOrUndefined(value) {
  return Number.isFinite(value) ? value : undefined;
}

function integerOrUndefined(value) {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : undefined;
}

function sanitizeToken(value) {
  if (!value) {
    return null;
  }
  const sanitized = String(value)
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
  return sanitized || null;
}

function formatScore(value) {
  if (!Number.isFinite(value)) {
    return null;
  }
  return Number(value.toFixed(6)).toString();
}

function formatTimestamp(date) {
  const parts = toDateParts(date);
  return `${parts.dateCompact}_${parts.timeCompact}`;
}

function parseTimestampToken(value) {
  const match = String(value).match(/^(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})$/);
  if (!match) {
    return null;
  }

  const parsed = new Date(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6])
  );
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function formatDateKey(date) {
  const parts = toDateParts(date);
  return parts.dateKey;
}

function toDateParts(date) {
  const pad = (value, size = 2) => String(value).padStart(size, '0');
  const year = date.getFullYear();
  const month = pad(date.getMonth() + 1);
  const day = pad(date.getDate());
  const hour = pad(date.getHours());
  const minute = pad(date.getMinutes());
  const second = pad(date.getSeconds());

  return {
    dateKey: `${year}-${month}-${day}`,
    hour,
    dateCompact: `${year}${month}${day}`,
    timeCompact: `${hour}${minute}${second}`
  };
}

function pruneUndefined(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }

  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) {
      continue;
    }
    if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const nested = pruneUndefined(entry);
      if (Object.keys(nested).length) {
        result[key] = nested;
      }
      continue;
    }
    result[key] = entry;
  }
  return result;
}

module.exports = {
  DataCollector
};
