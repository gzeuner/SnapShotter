'use strict';

const crypto = require('crypto');
const path = require('path');
const fileTools = require('fs-extra');
const { isHealthyWhatsAppStatus } = require('./whatsappSupport');

class RuntimeSupervisor {
  constructor(input = {}) {
    this.cfg = normalizeConfig(input);
    this.healthFile = path.resolve(this.cfg.healthFile);
    this.decisionLogFile = path.resolve(this.cfg.decisionLogFile);
    this.notificationLogFile = path.resolve(this.cfg.notificationLogFile);
    this.sampleArchiveDir = path.resolve(this.cfg.sampleArchiveDir);
    this.pendingFrames = new Map();
    this.pendingNotifications = new Map();
    this.state = {
      startedAt: Date.now(),
      lastEnqueuedAt: 0,
      lastProcessingStartedAt: 0,
      lastProcessedAt: 0,
      lastDecisionAt: 0,
      lastSendAt: 0,
      lastMotionAt: 0,
      lastNotificationAttemptAt: 0,
      lastVerifiedNotificationAt: 0,
      lastNotificationErrorAt: 0,
      lastFingerprint: null,
      sameFrameCount: 0,
      suppressedCandidates: 0,
      suppressedNativeCandidates: 0,
      consecutiveProcessingErrors: 0,
      consecutiveNotificationErrors: 0,
      detectorResets: 0,
      lastRecoveryAt: 0,
      lastRecoveryReason: null,
      lastRecoveryMode: null,
      maxPendingFrames: 0,
      maxPendingNotifications: 0,
      maxQueueLagMs: 0,
      processingQueueDepth: 0,
      notificationQueueDepth: 0,
      lastDecisionSummary: null,
      lastNotificationSummary: null
    };
  }

  recordFrameQueued(filePath, at = Date.now()) {
    this.pendingFrames.set(filePath, at);
    this.state.lastEnqueuedAt = at;
    this.state.processingQueueDepth = this.pendingFrames.size;
    this.state.maxPendingFrames = Math.max(this.state.maxPendingFrames, this.pendingFrames.size);
  }

  recordProcessingStarted(filePath, at = Date.now()) {
    const queuedAt = this.pendingFrames.get(filePath);
    this.pendingFrames.delete(filePath);
    this.state.lastProcessingStartedAt = at;
    this.state.processingQueueDepth = this.pendingFrames.size;
    if (queuedAt) {
      this.state.maxQueueLagMs = Math.max(this.state.maxQueueLagMs, Math.max(0, at - queuedAt));
    }
  }

  recordNotificationQueued(filePath, at = Date.now()) {
    this.pendingNotifications.set(filePath, at);
    this.state.notificationQueueDepth = this.pendingNotifications.size;
    this.state.maxPendingNotifications = Math.max(this.state.maxPendingNotifications, this.pendingNotifications.size);
  }

  async recordDecision(input = {}) {
    const at = input.at || Date.now();
    const decision = input.decision || {};
    const frameContext = input.frameContext || {};
    const archivedPath = input.archivedPath || input.sourcePath || null;
    const fingerprint = await resolveFingerprint(archivedPath, frameContext);

    this.state.lastProcessedAt = at;
    this.state.lastDecisionAt = at;
    this.state.consecutiveProcessingErrors = 0;
    if (decision.send) {
      this.state.lastSendAt = at;
    }
    if (decision.send || (decision.signal && (decision.signal.motion || decision.signal.highConfidence))) {
      this.state.lastMotionAt = at;
      this.state.suppressedCandidates = 0;
      this.state.suppressedNativeCandidates = 0;
    }

    if (fingerprint && fingerprint === this.state.lastFingerprint) {
      this.state.sameFrameCount += 1;
    } else {
      this.state.lastFingerprint = fingerprint;
      this.state.sameFrameCount = fingerprint ? 1 : 0;
    }

    const suppressedCandidate = isSuppressedCandidate(decision, this.cfg);
    if (suppressedCandidate) {
      this.state.suppressedCandidates += 1;
      if (decision.signal && decision.signal.nativeSignal && decision.signal.nativeSignal.active) {
        this.state.suppressedNativeCandidates += 1;
      }
    } else if (decision.send || (decision.signal && decision.signal.motion)) {
      this.state.suppressedCandidates = 0;
      this.state.suppressedNativeCandidates = 0;
    }

    const summary = {
      at: new Date(at).toISOString(),
      sourcePath: input.sourcePath || null,
      archivedPath,
      file: archivedPath ? path.basename(archivedPath) : null,
      accepted_by_java: deriveAcceptedByJava(frameContext),
      seen_by_snapshotter: true,
      send: !!decision.send,
      reason: decision.reason || 'unknown',
      why_not_sent: decision.send ? null : (decision.reason || 'unknown'),
      sendType: decision.sendType || null,
      phase: decision.phase || null,
      event_state: decision.phase || null,
      eventId: Number.isFinite(decision.eventId) ? decision.eventId : null,
      fingerprint,
      javaPrefilter: summarizeJavaPrefilter(frameContext),
      metrics: summarizeMetrics(decision.metrics),
      motion_score: round(decision.metrics && decision.metrics.motionScore),
      scene: summarizeScene(decision.scene),
      signal: summarizeSignal(decision.signal),
      tags: buildDecisionTags(decision, suppressedCandidate)
    };

    this.state.lastDecisionSummary = summary;
    await this.appendJsonLine(this.decisionLogFile, summary);

    if (archivedPath) {
      await this.archiveSample(archivedPath, summary.tags.sampleCategory);
    }
  }

  async recordProcessingError(filePath, error, at = Date.now()) {
    this.pendingFrames.delete(filePath);
    this.state.processingQueueDepth = this.pendingFrames.size;
    this.state.consecutiveProcessingErrors += 1;
    this.state.lastDecisionSummary = {
      at: new Date(at).toISOString(),
      file: filePath ? path.basename(filePath) : null,
      error: String(error && error.message ? error.message : error),
      category: 'processing_error'
    };
    await this.appendJsonLine(this.decisionLogFile, this.state.lastDecisionSummary);
  }

  async recordNotificationResult(input = {}) {
    const at = input.at || Date.now();
    const filePath = input.filePath || null;
    const details = input.details && typeof input.details === 'object' ? input.details : {};
    this.pendingNotifications.delete(filePath);
    this.state.notificationQueueDepth = this.pendingNotifications.size;
    this.state.lastNotificationAttemptAt = positiveIntOrNull(details.startedAtMs) || at;

    const summary = {
      at: new Date(at).toISOString(),
      file: filePath ? path.basename(filePath) : null,
      path: filePath,
      success: !!input.success,
      error: input.error ? String(input.error.message || input.error) : null,
      kind: strOr(details.kind, null),
      attempts: positiveIntOrNull(details.attempts),
      queueRetries: positiveIntOrNull(details.queueRetries),
      verificationStatus: strOr(details.verificationStatus, input.success ? 'verified' : null),
      messageId: strOr(details.messageId, null),
      ack: ackOrNull(details.ack),
      ackLabel: strOr(details.ackLabel, null),
      verification: strOr(details.verificationMethod, null),
      messageObjectReturned: boolOr(details.messageObjectReturned, null),
      messageExists: boolOr(details.messageExists, null),
      chatContainsMessage: boolOr(details.chatContainsMessage, null),
      finalPath: strOr(details.finalPath, null),
      targetChatId: strOr(details.targetChatId, null),
      targetChatTitle: strOr(details.targetChatTitle, null),
      targetChatIsGroup: boolOr(details.targetChatIsGroup, null),
      clientState: strOr(details.clientState, null),
      appState: strOr(details.appState, null),
      whatsappStatus: strOr(details.whatsappStatus, null),
      recoveryMode: strOr(details.recoveryMode, null),
      durationMs: positiveIntOrNull(details.durationMs),
      deliveryInfo: details.deliveryInfo && typeof details.deliveryInfo === 'object' ? details.deliveryInfo : null,
      captionAttached: boolOr(details.captionAttached, null),
      captionText: strOr(details.captionText, null),
      healthState: strOr(details.healthState, null),
      finalDisposition: strOr(details.finalDisposition, null),
      failureReason: strOr(details.failureReason, null)
    };

    this.state.lastNotificationSummary = summary;
    if (summary.success) {
      this.state.consecutiveNotificationErrors = 0;
      this.state.lastVerifiedNotificationAt = at;
    } else {
      this.state.consecutiveNotificationErrors += 1;
      this.state.lastNotificationErrorAt = at;
    }
    await this.appendJsonLine(this.notificationLogFile, summary);
  }

  recordRecovery(reason, mode, at = Date.now()) {
    this.state.detectorResets += 1;
    this.state.lastRecoveryAt = at;
    this.state.lastRecoveryReason = reason;
    this.state.lastRecoveryMode = mode;
    this.state.sameFrameCount = 0;
    this.state.suppressedCandidates = 0;
    this.state.suppressedNativeCandidates = 0;
  }

  async evaluate(detectorStatus = {}, at = Date.now(), runtimeStatus = {}) {
    const warnings = [];
    const actions = [];
    const oldestPendingFrameAt = this.oldestPendingTimestamp(this.pendingFrames);
    const oldestPendingNotificationAt = this.oldestPendingTimestamp(this.pendingNotifications);
    const frameQueueAgeMs = oldestPendingFrameAt ? Math.max(0, at - oldestPendingFrameAt) : 0;
    const notificationQueueAgeMs = oldestPendingNotificationAt ? Math.max(0, at - oldestPendingNotificationAt) : 0;
    const whatsappStatus = runtimeStatus && runtimeStatus.whatsapp && typeof runtimeStatus.whatsapp === 'object'
      ? runtimeStatus.whatsapp
      : null;

    if (this.pendingFrames.size >= this.cfg.queueWarningDepth) {
      warnings.push(`processing_queue_depth=${this.pendingFrames.size}`);
    }
    if (frameQueueAgeMs >= this.cfg.queueWarningAgeMs) {
      warnings.push(`processing_queue_age_ms=${frameQueueAgeMs}`);
    }
    if (this.pendingNotifications.size >= this.cfg.notificationQueueWarningDepth) {
      warnings.push(`notification_queue_depth=${this.pendingNotifications.size}`);
    }
    if (notificationQueueAgeMs >= this.cfg.notificationQueueWarningAgeMs) {
      warnings.push(`notification_queue_age_ms=${notificationQueueAgeMs}`);
    }
    if (this.state.sameFrameCount >= this.cfg.repeatedFrameWarningCount) {
      warnings.push(`repeated_identical_frames=${this.state.sameFrameCount}`);
    }
    if (this.state.suppressedCandidates >= this.cfg.suppressedCandidateWarningCount) {
      warnings.push(`suppressed_motion_candidates=${this.state.suppressedCandidates}`);
    }
    if (this.state.consecutiveProcessingErrors >= this.cfg.processingErrorWarningCount) {
      warnings.push(`processing_errors=${this.state.consecutiveProcessingErrors}`);
    }
    if (this.state.consecutiveNotificationErrors >= this.cfg.notificationErrorWarningCount) {
      warnings.push(`notification_errors=${this.state.consecutiveNotificationErrors}`);
    }
    if (whatsappStatus && whatsappStatus.status && !isHealthyWhatsAppStatus(whatsappStatus.status)) {
      warnings.push(`whatsapp_status=${String(whatsappStatus.status).toLowerCase()}`);
    }

    if (this.state.lastProcessedAt > 0 && (at - this.state.lastProcessedAt) >= this.cfg.frameSilenceWarningMs) {
      warnings.push(`frame_silence_ms=${at - this.state.lastProcessedAt}`);
    }

    const sinceLastMotion = this.state.lastMotionAt > 0 ? (at - this.state.lastMotionAt) : null;
    if (sinceLastMotion !== null && sinceLastMotion >= this.cfg.detectorSilenceWarningMs) {
      warnings.push(`detector_silence_ms=${sinceLastMotion}`);
    }

    const canRecover = (at - this.state.lastRecoveryAt) >= this.cfg.recoveryMinIntervalMs;
    if (canRecover && this.state.sameFrameCount >= this.cfg.repeatedFrameResetCount) {
      actions.push({
        type: 'reset_detector',
        reason: 'repeated_identical_frames',
        mode: 'soft',
        clearLearning: false,
        clearSceneModel: false
      });
    } else if (canRecover && this.state.suppressedCandidates >= this.cfg.detectorSuppressedResetCount) {
      const escalate = this.state.lastRecoveryReason === 'suppressed_motion_candidates'
        && (at - this.state.lastRecoveryAt) <= this.cfg.recoveryEscalationWindowMs;
      actions.push({
        type: 'reset_detector',
        reason: 'suppressed_motion_candidates',
        mode: escalate ? 'hard' : 'soft',
        clearLearning: escalate,
        clearSceneModel: escalate
      });
    }

    const snapshot = {
      generatedAt: new Date(at).toISOString(),
      uptimeSeconds: Math.round((at - this.state.startedAt) / 1000),
      rssBytes: process.memoryUsage().rss,
      warnings,
      actions,
      health: {
        processingQueueDepth: this.pendingFrames.size,
        notificationQueueDepth: this.pendingNotifications.size,
        maxPendingFrames: this.state.maxPendingFrames,
        maxPendingNotifications: this.state.maxPendingNotifications,
        maxQueueLagMs: this.state.maxQueueLagMs,
        lastProcessedAt: toIso(this.state.lastProcessedAt),
        lastDecisionAt: toIso(this.state.lastDecisionAt),
        lastSendAt: toIso(this.state.lastSendAt),
        lastMotionAt: toIso(this.state.lastMotionAt),
        lastNotificationAttemptAt: toIso(this.state.lastNotificationAttemptAt),
        lastVerifiedNotificationAt: toIso(this.state.lastVerifiedNotificationAt),
        lastRecoveryAt: toIso(this.state.lastRecoveryAt),
        lastRecoveryReason: this.state.lastRecoveryReason,
        lastRecoveryMode: this.state.lastRecoveryMode,
        sameFrameCount: this.state.sameFrameCount,
        suppressedCandidates: this.state.suppressedCandidates,
        suppressedNativeCandidates: this.state.suppressedNativeCandidates,
        consecutiveProcessingErrors: this.state.consecutiveProcessingErrors,
        consecutiveNotificationErrors: this.state.consecutiveNotificationErrors,
        detectorResets: this.state.detectorResets
      },
      detector: detectorStatus || {},
      whatsapp: whatsappStatus,
      lastDecision: this.state.lastDecisionSummary,
      lastNotification: this.state.lastNotificationSummary
    };

    await this.ensureParentDir(this.healthFile);
    await fileTools.writeJson(this.healthFile, snapshot, { spaces: 2 });
    return actions;
  }

  oldestPendingTimestamp(map) {
    let oldest = 0;
    for (const timestamp of map.values()) {
      if (!oldest || timestamp < oldest) {
        oldest = timestamp;
      }
    }
    return oldest;
  }

  async archiveSample(imagePath, category) {
    if (!this.cfg.sampleArchiveEnabled || !category) {
      return;
    }

    const categoryDir = path.join(this.sampleArchiveDir, category);
    await fileTools.ensureDir(categoryDir);
    const destination = path.join(categoryDir, path.basename(imagePath));
    await fileTools.copy(imagePath, destination, { overwrite: true });

    const sourceMetadata = metadataPathForImage(imagePath);
    const destinationMetadata = metadataPathForImage(destination);
    if (await fileTools.pathExists(sourceMetadata)) {
      await fileTools.copy(sourceMetadata, destinationMetadata, { overwrite: true });
    }

    await trimCategory(categoryDir, this.cfg.sampleArchiveMaxFilesPerCategory);
  }

  async appendJsonLine(filePath, payload) {
    await this.ensureParentDir(filePath);
    await fileTools.appendFile(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
  }

  async ensureParentDir(filePath) {
    await fileTools.ensureDir(path.dirname(filePath));
  }
}

function normalizeConfig(input) {
  return {
    healthFile: strOr(input.healthFile, './.state/runtime-health.json'),
    decisionLogFile: strOr(input.decisionLogFile, './.state/decisions.ndjson'),
    notificationLogFile: strOr(input.notificationLogFile, './.state/notifications.ndjson'),
    sampleArchiveDir: strOr(input.sampleArchiveDir, './.state/samples'),
    sampleArchiveEnabled: boolOr(input.sampleArchiveEnabled, true),
    sampleArchiveMaxFilesPerCategory: Math.max(10, Math.floor(numOr(input.sampleArchiveMaxFilesPerCategory, 200))),
    queueWarningDepth: Math.max(1, Math.floor(numOr(input.queueWarningDepth, 8))),
    queueWarningAgeMs: Math.max(5_000, Math.floor(numOr(input.queueWarningAgeMs, 60_000))),
    notificationQueueWarningDepth: Math.max(1, Math.floor(numOr(input.notificationQueueWarningDepth, 12))),
    notificationQueueWarningAgeMs: Math.max(5_000, Math.floor(numOr(input.notificationQueueWarningAgeMs, 120_000))),
    frameSilenceWarningMs: Math.max(10_000, Math.floor(numOr(input.frameSilenceWarningMs, 45_000))),
    detectorSilenceWarningMs: Math.max(30_000, Math.floor(numOr(input.detectorSilenceWarningMs, 10 * 60 * 1000))),
    repeatedFrameWarningCount: Math.max(2, Math.floor(numOr(input.repeatedFrameWarningCount, 8))),
    repeatedFrameResetCount: Math.max(4, Math.floor(numOr(input.repeatedFrameResetCount, 20))),
    suppressedCandidateMotionScore: numOr(input.suppressedCandidateMotionScore, 0.018),
    suppressedCandidateSceneScore: numOr(input.suppressedCandidateSceneScore, 0.26),
    suppressedCandidateWarningCount: Math.max(1, Math.floor(numOr(input.suppressedCandidateWarningCount, 4))),
    detectorSuppressedResetCount: Math.max(2, Math.floor(numOr(input.detectorSuppressedResetCount, 8))),
    recoveryMinIntervalMs: Math.max(10_000, Math.floor(numOr(input.recoveryMinIntervalMs, 120_000))),
    recoveryEscalationWindowMs: Math.max(30_000, Math.floor(numOr(input.recoveryEscalationWindowMs, 10 * 60 * 1000))),
    processingErrorWarningCount: Math.max(1, Math.floor(numOr(input.processingErrorWarningCount, 3))),
    notificationErrorWarningCount: Math.max(1, Math.floor(numOr(input.notificationErrorWarningCount, 3)))
  };
}

async function resolveFingerprint(imagePath, frameContext) {
  const fromMetadata = frameContext && frameContext.frame && frameContext.frame.sha256;
  if (fromMetadata) {
    return fromMetadata;
  }
  if (!imagePath || !await fileTools.pathExists(imagePath)) {
    return null;
  }
  const buffer = await fileTools.readFile(imagePath);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function deriveAcceptedByJava(frameContext) {
  const prefilter = frameContext && frameContext.prefilter && typeof frameContext.prefilter === 'object'
    ? frameContext.prefilter
    : null;
  if (!prefilter) {
    return null;
  }
  return String(prefilter.action || '').toUpperCase() === 'ACCEPT';
}

function summarizeJavaPrefilter(frameContext) {
  const prefilter = frameContext && frameContext.prefilter && typeof frameContext.prefilter === 'object'
    ? frameContext.prefilter
    : null;
  if (!prefilter) {
    return null;
  }
  return {
    action: prefilter.action || null,
    reason: prefilter.reason || null,
    motionScore: round(prefilter.motionScore),
    edgeDiffRatio: round(prefilter.edgeDiffRatio),
    foregroundRatio: round(prefilter.foregroundRatio),
    foregroundArea: nonNegativeInt(prefilter.foregroundArea),
    largestComponentArea: nonNegativeInt(prefilter.largestComponentArea)
  };
}

function isSuppressedCandidate(decision, cfg) {
  const metrics = decision && decision.metrics ? decision.metrics : {};
  const scene = decision && decision.scene && decision.scene.classification
    ? decision.scene.classification
    : null;
  const signal = decision && decision.signal ? decision.signal : {};
  const nativeSignal = signal.nativeSignal || {};

  return !decision.send
    && !signal.motion
    && (
      !!nativeSignal.active
      || numOr(metrics.motionScore, 0) >= cfg.suppressedCandidateMotionScore
      || numOr(scene && scene.relevanceScore, 0) >= cfg.suppressedCandidateSceneScore
    );
}

function summarizeMetrics(metrics = {}) {
  return {
    motionScore: round(metrics.motionScore),
    edgeDiffRatio: round(metrics.edgeDiffRatio),
    fgRatio: round(metrics.fgRatio),
    foregroundArea: nonNegativeInt(metrics.foregroundArea),
    largestComponentArea: nonNegativeInt(metrics.largestComponentArea),
    backgroundMeanDelta: round(metrics.backgroundMeanDelta)
  };
}

function summarizeScene(scene) {
  if (!scene || !scene.classification) {
    return null;
  }
  return {
    label: scene.classification.label,
    reason: scene.classification.reason,
    relevanceScore: round(scene.classification.relevanceScore),
    activeCellRatio: round(scene.scene && scene.scene.activeCellRatio),
    pathActivityRatio: round(scene.scene && scene.scene.pathActivityRatio),
    noiseActivityRatio: round(scene.scene && scene.scene.noiseActivityRatio)
  };
}

function summarizeSignal(signal) {
  if (!signal) {
    return null;
  }
  return {
    motion: !!signal.motion,
    highConfidence: !!signal.highConfidence,
    brightnessSuppressed: !!signal.brightnessSuppressed,
    sceneDrivenSuppressed: !!signal.sceneDrivenSuppressed,
    suppressionReason: signal.suppressionReason || null,
    nativeSignal: signal.nativeSignal || null
  };
}

function buildDecisionTags(decision, suppressedCandidate) {
  if (decision.send) {
    return { sampleCategory: 'accepted' };
  }
  if (suppressedCandidate) {
    return { sampleCategory: 'near-miss' };
  }
  if (decision.signal && (decision.signal.sceneDrivenSuppressed || decision.signal.brightnessSuppressed)) {
    return { sampleCategory: 'suppressed' };
  }
  return { sampleCategory: null };
}

async function trimCategory(dirPath, maxFiles) {
  const entries = (await fileTools.readdir(dirPath))
    .map((file) => path.join(dirPath, file));
  const files = [];
  for (const entry of entries) {
    const stat = await fileTools.stat(entry);
    if (stat.isFile()) {
      files.push({ path: entry, mtimeMs: stat.mtimeMs });
    }
  }

  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  for (let i = maxFiles; i < files.length; i++) {
    await fileTools.remove(files[i].path);
  }
}

function metadataPathForImage(imagePath) {
  const parsed = path.parse(imagePath);
  return path.join(parsed.dir, `${parsed.name}.json`);
}

function toIso(timestamp) {
  return timestamp ? new Date(timestamp).toISOString() : null;
}

function round(value) {
  return Number.isFinite(value) ? Number(Number(value).toFixed(6)) : null;
}

function nonNegativeInt(value) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function positiveIntOrNull(value) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function ackOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function boolOr(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  return !!value;
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
  RuntimeSupervisor
};
