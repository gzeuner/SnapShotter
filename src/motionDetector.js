'use strict';

const path = require('path');
const fileTools = require('fs-extra');
const sharp = require('sharp');

const PHASE_IDLE = 'IDLE';
const PHASE_ACTIVE = 'ACTIVE';
const PHASE_COOLDOWN = 'COOLDOWN';

const activeMaskCache = new Map();
const zoneMaskCache = new Map();

class MotionEventDetector {
  constructor(filterCfg) {
    this.cfg = normalizeConfig(filterCfg || {});
    this.debugDir = path.resolve(this.cfg.debug.debugDir || './.state/debug-motion');
    this.debugJsonFile = path.join(this.debugDir, 'metrics.ndjson');

    this.state = {
      phase: PHASE_IDLE,
      eventId: 0,
      eventStartAt: 0,
      sendCount: 0,
      lastSendAt: 0,
      lastMotionAt: 0,
      lastNativeSignalAt: 0,
      cooldownUntil: 0,
      consecutiveMotionFrames: 0,
      consecutiveQuietFrames: 0,
      lastPrimaryZone: null,
      lastAnalyzedAt: 0,
      lastDecisionReason: null,
      baseline: null
    };
  }

  async analyzeFrame(imagePath, timestamp = new Date(), frameContext = null) {
    const ts = timestamp instanceof Date ? timestamp.getTime() : Date.now();
    const frame = await loadFrame(imagePath, this.cfg);

    if (!this.state.baseline || !sameFrameShape(this.state.baseline, frame)) {
      this.adoptFrameAsBaseline(frame);
      this.state.phase = PHASE_IDLE;
      this.state.lastAnalyzedAt = ts;
      this.state.lastDecisionReason = 'baseline_initialized';

      const nativeSignal = normalizeFrameContext(frameContext, this.cfg.nativeSignal.personVehicleAnimalOnly);
      if (nativeSignal.active) {
        this.state.lastNativeSignalAt = ts;
      }

      const decision = {
        send: false,
        reason: 'baseline_initialized',
        sendType: null,
        phase: this.state.phase,
        eventId: this.state.eventId,
        signal: {
          motion: false,
          highConfidence: false,
          nativeTrusted: false,
          brightnessSuppressed: false,
          sceneDrivenSuppressed: false,
          suppressionReason: null,
          nativeSignal
        },
        scene: defaultScene(),
        metrics: emptyMetrics(frame.activePixelCount)
      };
      await this.writeDebugArtifacts(imagePath, decision, ts);
      return decision;
    }

    const metrics = computeMetrics(this.state.baseline, frame, this.cfg);
    const signal = classifySignal(metrics, frameContext, this.cfg);
    const scene = classifyScene(signal, metrics);
    const transition = this.cfg.event.enabled
      ? this.advanceState(signal, metrics, ts)
      : this.frameModeTransition(signal);

    this.state.baseline = toBaseline(frame);
    this.state.lastAnalyzedAt = ts;
    this.state.lastDecisionReason = transition.reason;
    if (signal.motion) {
      this.state.lastMotionAt = ts;
    }
    if (signal.nativeSignal.active) {
      this.state.lastNativeSignalAt = ts;
    }

    const decision = {
      send: transition.send,
      reason: transition.reason,
      sendType: transition.sendType,
      phase: this.state.phase,
      eventId: this.state.eventId,
      signal,
      scene,
      metrics
    };

    await this.writeDebugArtifacts(imagePath, decision, ts);
    return decision;
  }

  async primeWithFrame(imagePath, timestamp = new Date()) {
    const ts = timestamp instanceof Date ? timestamp.getTime() : Date.now();
    const frame = await loadFrame(imagePath, this.cfg);
    this.resetRuntime();
    this.adoptFrameAsBaseline(frame);
    this.state.lastAnalyzedAt = ts;
    this.state.lastDecisionReason = 'baseline_primed';
  }

  resetRuntime() {
    this.state.phase = PHASE_IDLE;
    this.state.eventStartAt = 0;
    this.state.sendCount = 0;
    this.state.lastSendAt = 0;
    this.state.lastMotionAt = 0;
    this.state.lastNativeSignalAt = 0;
    this.state.cooldownUntil = 0;
    this.state.consecutiveMotionFrames = 0;
    this.state.consecutiveQuietFrames = 0;
    this.state.lastPrimaryZone = null;
    this.state.lastAnalyzedAt = 0;
    this.state.lastDecisionReason = null;
    this.state.baseline = null;
  }

  getStatus() {
    return {
      phase: this.state.phase,
      eventId: this.state.eventId,
      lastAnalyzedAt: this.state.lastAnalyzedAt ? new Date(this.state.lastAnalyzedAt).toISOString() : null,
      lastMotionAt: this.state.lastMotionAt ? new Date(this.state.lastMotionAt).toISOString() : null,
      lastDecisionReason: this.state.lastDecisionReason,
      hasBaseline: !!this.state.baseline,
      learning: null,
      adaptiveThresholds: null
    };
  }

  frameModeTransition(signal) {
    const send = !!signal.motion;
    return {
      send,
      reason: send ? (signal.nativeSignal.active ? 'native_signal_motion' : 'frame_delta_motion') : 'no_motion',
      sendType: send ? 'frame' : null
    };
  }

  advanceState(signal, metrics, ts) {
    this.resetStaleEventWindow(ts);
    const passedZones = countPassedZones(metrics.zoneSummary);
    const primaryZone = primaryPassedZone(metrics.zoneSummary);

    if (signal.motion) {
      this.state.consecutiveMotionFrames += 1;
      this.state.consecutiveQuietFrames = 0;
    } else {
      this.state.consecutiveQuietFrames += 1;
      this.state.consecutiveMotionFrames = 0;
    }

    if (this.state.phase === PHASE_COOLDOWN) {
      const strongOverride = signal.highConfidence || metrics.motionScore >= this.cfg.event.minScoreForActiveSend;
      if (ts >= this.state.cooldownUntil) {
        this.state.phase = PHASE_IDLE;
      } else if (!signal.nativeSignal.active && !strongOverride) {
        return {
          send: false,
          reason: 'cooldown_active',
          sendType: null
        };
      } else {
        this.state.phase = PHASE_IDLE;
      }
    }

    if (this.state.phase === PHASE_IDLE) {
      if (this.shouldStartFromNativeSignal(signal, metrics, passedZones)) {
        this.startEvent(ts, primaryZone);
        const send = this.markSend(ts);
        return {
          send,
          reason: signal.nativeSignal.relevantClass ? 'event_start_native_class' : 'event_start_native',
          sendType: send ? 'first' : null
        };
      }

      if (signal.motion) {
        if (this.isStrongSingleFrameStart(signal, metrics, passedZones, primaryZone)) {
          this.startEvent(ts, primaryZone);
          const send = this.markSend(ts);
          return {
            send,
            reason: 'event_start_strong_single',
            sendType: send ? 'first' : null
          };
        }
        if (this.state.consecutiveMotionFrames >= this.cfg.event.minConfirmFrames) {
          this.startEvent(ts, primaryZone);
          const send = this.markSend(ts);
          return {
            send,
            reason: 'event_start_confirmed',
            sendType: send ? 'first' : null
          };
        }
        return {
          send: false,
          reason: 'candidate_wait',
          sendType: null
        };
      }

      return {
        send: false,
        reason: 'idle_no_motion',
        sendType: null
      };
    }

    if (this.state.phase === PHASE_ACTIVE) {
      if (signal.motion) {
        const zoneChanged = !!(primaryZone && this.state.lastPrimaryZone && primaryZone !== this.state.lastPrimaryZone);
        if (primaryZone) {
          this.state.lastPrimaryZone = primaryZone;
        }
        const shouldSend = this.shouldSendDuringEvent(
          ts,
          metrics.motionScore,
          signal.nativeTrusted,
          zoneChanged,
          metrics.zoneMotion
        );
        if (shouldSend) {
          const send = this.markSend(ts);
          return {
            send,
            reason: signal.nativeTrusted
              ? 'event_native_peak'
              : (zoneChanged ? 'event_zone_transition' : 'event_motion_peak'),
            sendType: send ? 'peak' : null
          };
        }

        return {
          send: false,
          reason: 'event_active',
          sendType: null
        };
      }

      if (this.state.consecutiveQuietFrames >= this.cfg.event.quietFramesToEnd) {
        const canSendLast = this.cfg.event.sendLastFrame && this.canSend(ts);
        let send = false;
        let sendType = null;
        let reason = 'event_end';

        if (canSendLast) {
          send = this.markSend(ts);
          sendType = send ? 'last' : null;
          reason = send ? 'event_end_last_frame' : 'event_end';
        }

        this.finishEvent(ts);
        return { send, reason, sendType };
      }

      return {
        send: false,
        reason: 'event_wait_quiet',
        sendType: null
      };
    }

    return {
      send: false,
      reason: 'no_motion',
      sendType: null
    };
  }

  shouldSendDuringEvent(ts, motionScore, nativeActive, zoneChanged, zoneMotion) {
    if (!this.canSend(ts)) {
      return false;
    }
    if (zoneChanged) {
      return true;
    }
    return false;
  }

  shouldStartFromNativeSignal(signal, metrics, passedZones) {
    if (!signal.nativeTrusted) {
      return false;
    }
    if (passedZones > 0) {
      return true;
    }
    return metrics.motionScore >= this.cfg.nativeSignal.minStartScoreWithoutZone;
  }

  isStrongSingleFrameStart(signal, metrics, passedZones, primaryZone = null) {
    if (!signal.motion) {
      return false;
    }
    if (signal.highConfidence) {
      if (primaryZone === 'street_far'
        && passedZones === 1
        && metrics.motionScore < this.cfg.event.streetFarSingleZoneMinScore) {
        return false;
      }
      if (!this.passesNonNativeStrongSingleStart(metrics)) {
        return false;
      }
      return true;
    }
    return metrics.motionScore >= this.cfg.event.strongSingleFrameScore
      && passedZones >= this.cfg.event.strongSingleFrameMinZones;
  }

  passesNonNativeStrongSingleStart(metrics) {
    const texturedLocalizedMotion = metrics.stdAbsDiff >= this.cfg.event.nonNativeStrongSingleMinStdAbsDiff
      && metrics.connectedComponentShare >= this.cfg.event.nonNativeStrongSingleMinConnectedComponentShare;
    const obviousForegroundFootprint = metrics.fgRatio >= this.cfg.event.nonNativeStrongSingleObviousFgRatio;
    return texturedLocalizedMotion || obviousForegroundFootprint;
  }

  canSend(ts) {
    if (this.state.sendCount >= this.cfg.event.maxSendsPerEvent) {
      return false;
    }
    if (this.state.lastSendAt <= 0) {
      return true;
    }
    return (ts - this.state.lastSendAt) >= (this.cfg.event.minSecondsBetweenSends * 1000);
  }

  markSend(ts) {
    if (!this.canSend(ts)) {
      return false;
    }
    this.state.sendCount += 1;
    this.state.lastSendAt = ts;
    return true;
  }

  startEvent(ts, primaryZone = null) {
    this.state.phase = PHASE_ACTIVE;
    this.state.eventId += 1;
    this.state.eventStartAt = ts;
    this.state.sendCount = 0;
    this.state.lastSendAt = 0;
    this.state.cooldownUntil = 0;
    this.state.consecutiveQuietFrames = 0;
    this.state.lastPrimaryZone = primaryZone || null;
  }

  resetStaleEventWindow(ts) {
    const maxGapSeconds = this.cfg.event.maxConfirmGapSeconds;
    const last = this.state.lastAnalyzedAt;
    if (!last || maxGapSeconds <= 0) {
      return;
    }

    if ((ts - last) <= (maxGapSeconds * 1000)) {
      return;
    }

    this.state.consecutiveMotionFrames = 0;
    this.state.consecutiveQuietFrames = 0;

    if (this.state.phase !== PHASE_IDLE) {
      this.state.phase = PHASE_IDLE;
      this.state.eventStartAt = 0;
      this.state.sendCount = 0;
      this.state.lastSendAt = 0;
      this.state.cooldownUntil = 0;
    }
  }

  finishEvent(ts) {
    this.state.phase = PHASE_COOLDOWN;
    this.state.cooldownUntil = ts + (this.cfg.event.cooldownSeconds * 1000);
    this.state.eventStartAt = 0;
    this.state.sendCount = 0;
    this.state.lastSendAt = 0;
    this.state.consecutiveMotionFrames = 0;
    this.state.consecutiveQuietFrames = 0;
    this.state.lastPrimaryZone = null;
  }

  adoptFrameAsBaseline(frame) {
    this.state.baseline = toBaseline(frame);
  }

  async writeDebugArtifacts(imagePath, decision, ts) {
    if (!this.cfg.debug.writeDebugJson) {
      return;
    }

    await fileTools.ensureDir(this.debugDir);
    const payload = {
      at: new Date(ts).toISOString(),
      file: path.basename(imagePath),
      phase: decision.phase,
      eventId: decision.eventId,
      send: decision.send,
      reason: decision.reason,
      sendType: decision.sendType,
      signal: {
        motion: !!(decision.signal && decision.signal.motion),
        highConfidence: !!(decision.signal && decision.signal.highConfidence),
        nativeTrusted: !!(decision.signal && decision.signal.nativeTrusted),
        brightnessSuppressed: !!(decision.signal && decision.signal.brightnessSuppressed),
        sceneDrivenSuppressed: !!(decision.signal && decision.signal.sceneDrivenSuppressed),
        suppressionReason: decision.signal ? (decision.signal.suppressionReason || null) : null,
        nativeSignal: decision.signal ? decision.signal.nativeSignal : null
      },
      scene: decision.scene,
      metrics: {
        motionScore: round(decision.metrics && decision.metrics.motionScore),
        edgeDiffRatio: round(decision.metrics && decision.metrics.edgeDiffRatio),
        fgRatio: round(decision.metrics && decision.metrics.fgRatio),
        foregroundArea: nonNegativeInt(decision.metrics && decision.metrics.foregroundArea),
        largestComponentArea: nonNegativeInt(decision.metrics && decision.metrics.largestComponentArea),
        zoneActivityCoverage: round(decision.metrics && decision.metrics.zoneActivityCoverage),
        connectedComponentShare: round(decision.metrics && decision.metrics.connectedComponentShare),
        zoneSummary: decision.metrics && Array.isArray(decision.metrics.zoneSummary)
          ? decision.metrics.zoneSummary.map((zone) => ({
            name: zone.name,
            fgRatio: round(zone.fgRatio),
            edgeDiffRatio: round(zone.edgeDiffRatio),
            foregroundArea: nonNegativeInt(zone.foregroundArea),
            largestComponentArea: nonNegativeInt(zone.largestComponentArea),
            pass: !!zone.pass,
            highConfidence: !!zone.highConfidence
          }))
          : [],
        meanAbsDiff: round(decision.metrics && decision.metrics.meanAbsDiff),
        stdAbsDiff: round(decision.metrics && decision.metrics.stdAbsDiff)
      }
    };

    await fileTools.appendFile(this.debugJsonFile, `${JSON.stringify(payload)}\n`, 'utf8');
  }
}

function normalizeConfig(input) {
  const eventInput = input.event || {};
  const nativeInput = input.nativeSignal || {};
  const debugInput = input.debug || {};
  const bgInput = input.backgroundModel || {};
  const deltaInput = input.delta || {};
  const brightnessInput = input.brightnessGuard || {};
  const zoneInput = input.zoneModel || {};

  const fallbackMinFgRatio = numberOr(input.edgeDiffRatioThreshold, 0.0038);
  const delta = {
    pixelDiffThreshold: numberOr(deltaInput.pixelDiffThreshold, numberOr(bgInput.pixelDiffThreshold, 17)),
    edgeDiffPixelThreshold: numberOr(deltaInput.edgeDiffPixelThreshold, numberOr(input.edgeDiffPixelThreshold, 20)),
    minForegroundArea: Math.max(1, Math.floor(numberOr(deltaInput.minForegroundArea, numberOr(bgInput.minForegroundArea, 90)))),
    minForegroundRatio: Math.max(0.0001, numberOr(deltaInput.minForegroundRatio, Math.max(0.0015, fallbackMinFgRatio * 0.80))),
    minLargestComponentArea: Math.max(1, Math.floor(numberOr(deltaInput.minLargestComponentArea, numberOr(bgInput.minForegroundComponentArea, 22)))),
    minEdgeDiffRatio: Math.max(0.0001, numberOr(deltaInput.minEdgeDiffRatio, numberOr(input.edgeDiffRatioThreshold, 0.0038))),
    highForegroundArea: Math.max(1, Math.floor(numberOr(deltaInput.highForegroundArea, numberOr(bgInput.highForegroundArea, 220)))),
    highEdgeDiffRatio: Math.max(0.0001, numberOr(deltaInput.highEdgeDiffRatio, numberOr(input.highEdgeDiffRatio, 0.0105)))
  };

  return {
    enabled: boolOr(input.enabled, true),
    resizeWidth: Math.max(64, Math.floor(numberOr(input.resizeWidth, 384))),
    cropTop: Math.max(0, Math.floor(numberOr(input.cropTop, 24))),
    compareCrop: input.compareCrop && typeof input.compareCrop === 'object' ? input.compareCrop : null,
    roiMask: input.roiMask && typeof input.roiMask === 'object' ? input.roiMask : { polygons: [] },
    failMode: stringOr(input.failMode, 'open'),
    filteredDirName: stringOr(input.filteredDirName, 'filtered'),
    delta,
    zoneModel: {
      exclusionPolygons: extractPolygons(zoneInput.exclusionPolygons),
      focusZones: normalizeFocusZones(zoneInput.focusZones, delta),
      diffuseNoiseMinForegroundArea: Math.max(1, Math.floor(numberOr(zoneInput.diffuseNoiseMinForegroundArea, 180))),
      diffuseNoiseMaxLargestComponentArea: Math.max(1, Math.floor(numberOr(zoneInput.diffuseNoiseMaxLargestComponentArea, 48))),
      diffuseNoiseMinZoneCoverage: clamp(numberOr(zoneInput.diffuseNoiseMinZoneCoverage, 0.42), 0, 1),
      fragmentedNoiseMinForegroundArea: Math.max(1, Math.floor(numberOr(zoneInput.fragmentedNoiseMinForegroundArea, 70))),
      minConnectedComponentShare: clamp(numberOr(zoneInput.minConnectedComponentShare, 0.16), 0, 1),
      sceneSweepMinForegroundRatio: clamp(numberOr(zoneInput.sceneSweepMinForegroundRatio, 0.08), 0, 1),
      sceneSweepMinZoneCount: Math.max(1, Math.floor(numberOr(zoneInput.sceneSweepMinZoneCount, 2))),
      sceneSweepMinZoneCoverage: clamp(numberOr(zoneInput.sceneSweepMinZoneCoverage, 0.82), 0, 1)
    },
    brightnessGuard: {
      enabled: boolOr(brightnessInput.enabled, true),
      maxUniformDelta: numberOr(brightnessInput.maxUniformDelta, 10),
      maxStdDelta: numberOr(brightnessInput.maxStdDelta, 7),
      maxForegroundRatio: numberOr(brightnessInput.maxForegroundRatio, 0.04)
    },
    nativeSignal: {
      enabled: boolOr(nativeInput.enabled, true),
      personVehicleAnimalOnly: boolOr(nativeInput.personVehicleAnimalOnly, false),
      minTrustedMotionScore: Math.max(0, numberOr(nativeInput.minTrustedMotionScore, 0.0055)),
      minTrustedEdgeDiffRatio: Math.max(0, numberOr(nativeInput.minTrustedEdgeDiffRatio, 0.01)),
      minStartScoreWithoutZone: Math.max(0, numberOr(nativeInput.minStartScoreWithoutZone, 0.012))
    },
    event: {
      enabled: boolOr(eventInput.enabled, true),
      minConfirmFrames: Math.max(1, Math.floor(numberOr(eventInput.minConfirmFrames, 2))),
      maxConfirmGapSeconds: Math.max(0, numberOr(eventInput.maxConfirmGapSeconds, 8)),
      strongSingleFrameScore: Math.max(0, numberOr(eventInput.strongSingleFrameScore, 0.028)),
      strongSingleFrameMinZones: Math.max(1, Math.floor(numberOr(eventInput.strongSingleFrameMinZones, 2))),
      streetFarSingleZoneMinScore: Math.max(0, numberOr(eventInput.streetFarSingleZoneMinScore, 0.015)),
      nonNativeStrongSingleMinStdAbsDiff: Math.max(0, numberOr(eventInput.nonNativeStrongSingleMinStdAbsDiff, 7)),
      nonNativeStrongSingleMinConnectedComponentShare: clamp(
        numberOr(eventInput.nonNativeStrongSingleMinConnectedComponentShare, 0.6),
        0,
        1
      ),
      nonNativeStrongSingleObviousFgRatio: clamp(numberOr(eventInput.nonNativeStrongSingleObviousFgRatio, 0.06), 0, 1),
      maxActiveSendGapSeconds: Math.max(0, numberOr(eventInput.maxActiveSendGapSeconds, 10)),
      quietFramesToEnd: Math.max(1, Math.floor(numberOr(eventInput.quietFramesToEnd, 2))),
      cooldownSeconds: Math.max(0, Math.floor(numberOr(eventInput.cooldownSeconds, 8))),
      maxSendsPerEvent: Math.max(1, Math.floor(numberOr(eventInput.maxSendsPerEvent, 3))),
      minSecondsBetweenSends: Math.max(0, numberOr(eventInput.minSecondsBetweenSends, 3)),
      sendLastFrame: boolOr(eventInput.sendLastFrame, false),
      minScoreForActiveSend: Math.max(0, numberOr(eventInput.minScoreForActiveSend, 0.022))
    },
    debug: {
      writeDebugJson: boolOr(debugInput.writeDebugJson, false),
      debugDir: stringOr(debugInput.debugDir, './.state/debug-motion')
    }
  };
}

async function loadFrame(imagePath, cfg) {
  const prepared = await sharp(imagePath)
    .rotate()
    .resize({ width: cfg.resizeWidth })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const data = prepared.data;
  const info = prepared.info;
  const width = info.width;
  const height = info.height;
  const channels = info.channels;

  const cropTop = Math.min(Math.max(0, cfg.cropTop), Math.max(0, height - 2));
  const roiHeight = height - cropTop;
  if (roiHeight <= 1) {
    throw new Error('roi_height_too_small');
  }

  const compareCrop = normalizeCompareCrop(cfg.compareCrop, width, roiHeight) || {
    x: 0,
    y: 0,
    w: width,
    h: roiHeight
  };

  const roiWidth = compareCrop.w;
  const roiCompareHeight = compareCrop.h;
  const gray = new Uint8Array(roiWidth * roiCompareHeight);

  let sum = 0;
  let sq = 0;
  let chromaSum = 0;
  for (let y = 0; y < roiCompareHeight; y++) {
    const srcY = cropTop + compareCrop.y + y;
    const srcRow = srcY * width;
    const dstRow = y * roiWidth;

    for (let x = 0; x < roiWidth; x++) {
      const srcX = compareCrop.x + x;
      const srcIdx = (srcRow + srcX) * channels;
      const r = data[srcIdx];
      const g = data[srcIdx + 1];
      const b = data[srcIdx + 2];
      const lum = luminance(r, g, b);
      const idx = dstRow + x;

      gray[idx] = lum;
      sum += lum;
      sq += (lum * lum);
      const maxRgb = Math.max(r, g, b);
      const minRgb = Math.min(r, g, b);
      chromaSum += (maxRgb - minRgb);
    }
  }

  const includeMask = buildActiveMask(
    roiWidth,
    roiCompareHeight,
    cfg.roiMask,
    compareCrop.x,
    compareCrop.y
  );
  const exclusionMask = buildExclusionMask(
    roiWidth,
    roiCompareHeight,
    cfg.zoneModel.exclusionPolygons,
    compareCrop.x,
    compareCrop.y
  );
  const mask = new Uint8Array(includeMask.length);
  for (let i = 0; i < includeMask.length; i++) {
    if (includeMask[i] && !exclusionMask[i]) {
      mask[i] = 1;
    }
  }

  let activePixelCount = countActivePixels(mask);
  if (activePixelCount <= 0) {
    for (let i = 0; i < mask.length; i++) {
      mask[i] = includeMask[i] || 0;
    }
    activePixelCount = mask.length;
  }
  if (activePixelCount <= 0) {
    mask.fill(1);
    activePixelCount = mask.length;
  }

  const focusZones = buildFocusZones(
    roiWidth,
    roiCompareHeight,
    cfg.zoneModel.focusZones,
    compareCrop.x,
    compareCrop.y,
    mask
  );
  const excludedPixelCount = countActivePixels(exclusionMask);
  const excludedRatio = includeMask.length > 0 ? (excludedPixelCount / includeMask.length) : 0;

  const edge = computeSobelEdges(gray, roiWidth, roiCompareHeight);

  let mean = 0;
  let variance = 0;
  let activeSum = 0;
  let activeSq = 0;
  for (let i = 0; i < gray.length; i++) {
    if (!mask[i]) continue;
    const value = gray[i];
    activeSum += value;
    activeSq += value * value;
  }
  if (activePixelCount > 0) {
    mean = activeSum / activePixelCount;
    variance = Math.max(0, (activeSq / activePixelCount) - (mean * mean));
  }

  return {
    roiGray: gray,
    roiEdge: edge,
    roiActiveMask: mask,
    activePixelCount,
    roiWidth,
    roiHeight: roiCompareHeight,
    mean,
    stddev: Math.sqrt(variance),
    focusZones,
    excludedRatio,
    chromaMean: gray.length > 0 ? (chromaSum / gray.length) : 0,
    fullMean: gray.length > 0 ? (sum / gray.length) : 0,
    fullStddev: gray.length > 0 ? Math.sqrt(Math.max(0, (sq / gray.length) - ((sum / gray.length) ** 2))) : 0
  };
}

function toBaseline(frame) {
  return {
    roiGray: new Uint8Array(frame.roiGray),
    roiEdge: new Uint8Array(frame.roiEdge),
    roiActiveMask: new Uint8Array(frame.roiActiveMask),
    activePixelCount: frame.activePixelCount,
    roiWidth: frame.roiWidth,
    roiHeight: frame.roiHeight,
    mean: frame.mean,
    stddev: frame.stddev
  };
}

function sameFrameShape(previous, current) {
  if (!previous || !current) return false;
  return previous.roiWidth === current.roiWidth
    && previous.roiHeight === current.roiHeight
    && previous.roiGray.length === current.roiGray.length
    && previous.roiEdge.length === current.roiEdge.length
    && previous.roiActiveMask.length === current.roiActiveMask.length;
}

function computeMetrics(previous, current, cfg) {
  const activePixelCount = current.activePixelCount;
  if (activePixelCount <= 0) {
    return emptyMetrics(activePixelCount);
  }

  const zoneStats = (current.focusZones || []).map((zone) => ({
    name: zone.name,
    mask: zone.mask,
    activePixelCount: zone.activePixelCount,
    thresholds: zone.thresholds,
    fgMask: new Uint8Array(current.roiGray.length),
    foregroundArea: 0,
    edgeDiffCount: 0,
    largestComponentArea: 0,
    fgRatio: 0,
    edgeDiffRatio: 0,
    largestAreaRatio: 0,
    pass: false,
    highConfidence: false
  }));

  let signedDiffSum = 0;
  for (let i = 0; i < current.roiGray.length; i++) {
    if (!current.roiActiveMask[i]) continue;
    signedDiffSum += (current.roiGray[i] - previous.roiGray[i]);
  }
  const meanDelta = signedDiffSum / activePixelCount;

  let diffSum = 0;
  let diffSq = 0;
  let foregroundArea = 0;
  let edgeDiffCount = 0;
  const fgMask = new Uint8Array(current.roiGray.length);

  for (let i = 0; i < current.roiGray.length; i++) {
    if (!current.roiActiveMask[i]) continue;

    const normalizedDiff = Math.abs((current.roiGray[i] - previous.roiGray[i]) - meanDelta);
    diffSum += normalizedDiff;
    diffSq += normalizedDiff * normalizedDiff;

    const foregroundChanged = normalizedDiff >= cfg.delta.pixelDiffThreshold;
    if (foregroundChanged) {
      fgMask[i] = 1;
      foregroundArea += 1;
    }

    const edgeChanged = Math.abs(current.roiEdge[i] - previous.roiEdge[i]) >= cfg.delta.edgeDiffPixelThreshold;
    if (edgeChanged) {
      edgeDiffCount += 1;
    }

    for (let z = 0; z < zoneStats.length; z++) {
      const zone = zoneStats[z];
      if (!zone.mask[i]) continue;
      const zoneForegroundChanged = normalizedDiff >= zone.thresholds.pixelDiffThreshold;
      if (zoneForegroundChanged) {
        zone.foregroundArea += 1;
        zone.fgMask[i] = 1;
      }
      if (Math.abs(current.roiEdge[i] - previous.roiEdge[i]) >= zone.thresholds.edgeDiffPixelThreshold) {
        zone.edgeDiffCount += 1;
      }
    }
  }

  const meanAbsDiff = diffSum / activePixelCount;
  const diffVariance = Math.max(0, (diffSq / activePixelCount) - (meanAbsDiff * meanAbsDiff));
  const stdAbsDiff = Math.sqrt(diffVariance);

  const fgRatio = foregroundArea / activePixelCount;
  const edgeDiffRatio = edgeDiffCount / activePixelCount;
  const largestComponentArea = largestConnectedComponent(
    fgMask,
    current.roiActiveMask,
    current.roiWidth,
    current.roiHeight
  );
  const largestAreaRatio = largestComponentArea / activePixelCount;

  const motionScore = (edgeDiffRatio * 0.45) + (fgRatio * 0.35) + (largestAreaRatio * 0.20);

  for (let z = 0; z < zoneStats.length; z++) {
    const zone = zoneStats[z];
    if (zone.activePixelCount <= 0) continue;
    zone.fgRatio = zone.foregroundArea / zone.activePixelCount;
    zone.edgeDiffRatio = zone.edgeDiffCount / zone.activePixelCount;
    zone.largestComponentArea = largestConnectedComponent(
      zone.fgMask,
      zone.mask,
      current.roiWidth,
      current.roiHeight
    );
    zone.largestAreaRatio = zone.largestComponentArea / zone.activePixelCount;

    const t = zone.thresholds;
    const edgePass = zone.edgeDiffRatio >= t.minEdgeDiffRatio;
    const fgPass = zone.foregroundArea >= t.minForegroundArea || zone.fgRatio >= t.minForegroundRatio;
    const componentPass = zone.largestComponentArea >= t.minLargestComponentArea;
    const highArea = zone.foregroundArea >= t.highForegroundArea;
    const highEdge = zone.edgeDiffRatio >= t.highEdgeDiffRatio;
    const highComponent = zone.largestComponentArea >= t.highLargestComponentArea;

    zone.pass = (edgePass && (fgPass || componentPass)) || highArea || highComponent;
    zone.highConfidence = highArea || (highEdge && (fgPass || componentPass)) || highComponent;
  }

  const zoneForegroundArea = zoneStats.reduce((sum, zone) => sum + zone.foregroundArea, 0);
  const zoneActivityCoverage = foregroundArea > 0
    ? Math.min(1, zoneForegroundArea / foregroundArea)
    : 0;
  const connectedComponentShare = foregroundArea > 0
    ? Math.min(1, largestComponentArea / foregroundArea)
    : 0;
  const diffuseNoiseSuppressed = foregroundArea >= cfg.zoneModel.diffuseNoiseMinForegroundArea
    && largestComponentArea < cfg.zoneModel.diffuseNoiseMaxLargestComponentArea
    && zoneActivityCoverage < cfg.zoneModel.diffuseNoiseMinZoneCoverage;
  const fragmentedNoiseSuppressed = foregroundArea >= cfg.zoneModel.fragmentedNoiseMinForegroundArea
    && connectedComponentShare < cfg.zoneModel.minConnectedComponentShare;

  const brightnessSuppressed = cfg.brightnessGuard.enabled
    && meanAbsDiff >= cfg.brightnessGuard.maxUniformDelta
    && stdAbsDiff <= cfg.brightnessGuard.maxStdDelta
    && fgRatio <= cfg.brightnessGuard.maxForegroundRatio
    && foregroundArea < cfg.delta.highForegroundArea
    && edgeDiffRatio < cfg.delta.highEdgeDiffRatio;

  return {
    hasHistory: true,
    activePixelCount,
    mean: current.mean,
    stddev: current.stddev,
    chromaMean: current.chromaMean,
    meanAbsDiff,
    stdAbsDiff,
    prevMeanDelta: meanDelta,
    backgroundMeanDelta: meanDelta,
    edgeDiffRatio,
    fgRatio,
    foregroundArea,
    largestComponentArea,
    largestAreaRatio,
    motionScore,
    brightnessSuppressed,
    diffuseNoiseSuppressed: diffuseNoiseSuppressed || fragmentedNoiseSuppressed,
    zoneMotion: zoneStats.some((zone) => zone.pass),
    zoneHighConfidence: zoneStats.some((zone) => zone.highConfidence),
    zoneActivityCoverage,
    connectedComponentShare,
    zoneSummary: zoneStats.map((zone) => ({
      name: zone.name,
      activePixelCount: zone.activePixelCount,
      foregroundArea: zone.foregroundArea,
      fgRatio: zone.fgRatio,
      edgeDiffRatio: zone.edgeDiffRatio,
      largestComponentArea: zone.largestComponentArea,
      pass: zone.pass,
      highConfidence: zone.highConfidence
    })),
    suppressionZones: null
  };
}

function classifySignal(metrics, frameContext, cfg) {
  const nativeSignal = normalizeFrameContext(frameContext, cfg.nativeSignal.personVehicleAnimalOnly);

  if (!metrics.hasHistory) {
    return {
      motion: !!(cfg.nativeSignal.enabled && nativeSignal.active),
      highConfidence: !!(cfg.nativeSignal.enabled && nativeSignal.relevantClass),
      nativeTrusted: !!(cfg.nativeSignal.enabled && nativeSignal.relevantClass),
      brightnessSuppressed: false,
      sceneDrivenSuppressed: false,
      suppressionReason: null,
      edgePass: false,
      foregroundPass: false,
      componentPass: false,
      nativeSignal
    };
  }

  const edgePass = metrics.edgeDiffRatio >= cfg.delta.minEdgeDiffRatio;
  const foregroundPass = metrics.foregroundArea >= cfg.delta.minForegroundArea
    || metrics.fgRatio >= cfg.delta.minForegroundRatio;
  const componentPass = metrics.largestComponentArea >= cfg.delta.minLargestComponentArea;
  const highArea = metrics.foregroundArea >= cfg.delta.highForegroundArea;
  const highEdge = metrics.edgeDiffRatio >= cfg.delta.highEdgeDiffRatio;
  const zoneDriven = metrics.zoneMotion;
  const hasFocusZones = (metrics.zoneSummary && metrics.zoneSummary.length > 0);
  const passedZoneCount = countPassedZones(metrics.zoneSummary);

  const nativeTrusted = cfg.nativeSignal.enabled
    && nativeSignal.active
    && nativeSignal.relevantClass
    && (
      zoneDriven
      || metrics.motionScore >= cfg.nativeSignal.minTrustedMotionScore
      || metrics.edgeDiffRatio >= cfg.nativeSignal.minTrustedEdgeDiffRatio
    );

  const globalMotion = (edgePass && (foregroundPass || componentPass)) || highArea || highEdge;
  const sceneSweepSuppressed = !nativeTrusted
    && passedZoneCount >= cfg.zoneModel.sceneSweepMinZoneCount
    && metrics.fgRatio >= cfg.zoneModel.sceneSweepMinForegroundRatio
    && metrics.zoneActivityCoverage >= cfg.zoneModel.sceneSweepMinZoneCoverage;
  const deltaMotion = !metrics.brightnessSuppressed
    && !metrics.diffuseNoiseSuppressed
    && !sceneSweepSuppressed
    && (hasFocusZones ? zoneDriven : globalMotion);

  const motion = nativeTrusted || deltaMotion;
  const highConfidence = nativeTrusted
    || (hasFocusZones ? metrics.zoneHighConfidence : (highArea || (highEdge && foregroundPass)));
  const sceneDrivenSuppressed = !nativeTrusted
    && (metrics.diffuseNoiseSuppressed || sceneSweepSuppressed || (hasFocusZones && !zoneDriven && globalMotion));
  const suppressionReason = metrics.diffuseNoiseSuppressed
    ? 'diffuse_noise'
    : sceneSweepSuppressed
      ? 'scene_sweep'
    : (hasFocusZones && !zoneDriven && globalMotion)
      ? 'outside_focus_zone'
      : null;

  return {
    motion,
    highConfidence,
    nativeTrusted,
    brightnessSuppressed: metrics.brightnessSuppressed && !nativeTrusted,
    sceneDrivenSuppressed,
    suppressionReason,
    edgePass,
    foregroundPass,
    componentPass,
    nativeSignal
  };
}

function classifyScene(signal, metrics) {
  if (signal.nativeTrusted) {
    return {
      classification: {
        label: 'strong',
        reason: 'native_signal_class',
        relevanceScore: 0.95
      },
      scene: {
        activeCellRatio: round(metrics.fgRatio),
        pathActivityRatio: round(metrics.fgRatio),
        noiseActivityRatio: 0
      }
    };
  }

  if (signal.motion) {
    const relevanceScore = clamp(metrics.motionScore * 12, 0.25, 0.82);
    return {
      classification: {
        label: signal.highConfidence ? 'strong' : 'weak',
        reason: signal.nativeSignal.active ? 'native_signal_motion' : 'frame_delta_motion',
        relevanceScore: round(relevanceScore)
      },
      scene: {
        activeCellRatio: round(metrics.fgRatio),
        pathActivityRatio: round(metrics.fgRatio),
        noiseActivityRatio: 0
      }
    };
  }

  return defaultScene();
}

function defaultScene() {
  return {
    classification: {
      label: 'ignore',
      reason: 'no_motion',
      relevanceScore: 0
    },
    scene: {
      activeCellRatio: 0,
      pathActivityRatio: 0,
      noiseActivityRatio: 0
    }
  };
}

function emptyMetrics(activePixelCount = 0) {
  return {
    hasHistory: false,
    activePixelCount,
    mean: 0,
    stddev: 0,
    chromaMean: 0,
    meanAbsDiff: 0,
    stdAbsDiff: 0,
    prevMeanDelta: 0,
    backgroundMeanDelta: 0,
    edgeDiffRatio: 0,
    fgRatio: 0,
    foregroundArea: 0,
    largestComponentArea: 0,
    largestAreaRatio: 0,
    motionScore: 0,
    brightnessSuppressed: false,
    diffuseNoiseSuppressed: false,
    zoneMotion: false,
    zoneHighConfidence: false,
    zoneActivityCoverage: 0,
    connectedComponentShare: 0,
    zoneSummary: [],
    suppressionZones: null
  };
}

function normalizeFrameContext(frameContext, personVehicleAnimalOnly) {
  const signal = frameContext && frameContext.cameraSignal && typeof frameContext.cameraSignal === 'object'
    ? frameContext.cameraSignal
    : {};

  const motionDetected = !!signal.motionDetected;
  const personDetected = !!signal.personDetected;
  const vehicleDetected = !!signal.vehicleDetected;
  const animalDetected = !!signal.animalDetected;
  const classDetected = personDetected || vehicleDetected || animalDetected;
  const active = personVehicleAnimalOnly ? classDetected : (motionDetected || classDetected);

  return {
    active,
    relevantClass: classDetected,
    motionDetected,
    personDetected,
    vehicleDetected,
    animalDetected
  };
}

function countPassedZones(zoneSummary) {
  if (!Array.isArray(zoneSummary)) {
    return 0;
  }
  let count = 0;
  for (let i = 0; i < zoneSummary.length; i++) {
    if (zoneSummary[i] && zoneSummary[i].pass) {
      count += 1;
    }
  }
  return count;
}

function primaryPassedZone(zoneSummary) {
  if (!Array.isArray(zoneSummary) || !zoneSummary.length) {
    return null;
  }

  let best = null;
  for (let i = 0; i < zoneSummary.length; i++) {
    const zone = zoneSummary[i];
    if (!zone || !zone.pass) continue;
    if (!best || numberOr(zone.foregroundArea, 0) > numberOr(best.foregroundArea, 0)) {
      best = zone;
    }
  }
  return best ? best.name : null;
}

function largestConnectedComponent(mask, activeMask, width, height) {
  if (!mask || !mask.length) {
    return 0;
  }

  const visited = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  let largest = 0;

  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || visited[i] || !activeMask[i]) {
      continue;
    }

    let head = 0;
    let tail = 0;
    queue[tail++] = i;
    visited[i] = 1;
    let area = 0;

    while (head < tail) {
      const index = queue[head++];
      area += 1;

      const x = index % width;
      const y = Math.floor(index / width);

      for (let ny = y - 1; ny <= y + 1; ny++) {
        if (ny < 0 || ny >= height) continue;
        const row = ny * width;
        for (let nx = x - 1; nx <= x + 1; nx++) {
          if (nx < 0 || nx >= width) continue;
          const neighbor = row + nx;
          if (!visited[neighbor] && activeMask[neighbor] && mask[neighbor]) {
            visited[neighbor] = 1;
            queue[tail++] = neighbor;
          }
        }
      }
    }

    if (area > largest) {
      largest = area;
    }
  }

  return largest;
}

function computeSobelEdges(gray, width, height) {
  const out = new Uint8Array(width * height);
  if (width < 3 || height < 3) {
    return out;
  }

  for (let y = 1; y < height - 1; y++) {
    const y0 = (y - 1) * width;
    const y1 = y * width;
    const y2 = (y + 1) * width;

    for (let x = 1; x < width - 1; x++) {
      const idx = y1 + x;
      const gx =
        -gray[y0 + (x - 1)] + gray[y0 + (x + 1)] +
        (-2 * gray[y1 + (x - 1)]) + (2 * gray[y1 + (x + 1)]) +
        -gray[y2 + (x - 1)] + gray[y2 + (x + 1)];
      const gy =
        gray[y0 + (x - 1)] + (2 * gray[y0 + x]) + gray[y0 + (x + 1)] -
        gray[y2 + (x - 1)] - (2 * gray[y2 + x]) - gray[y2 + (x + 1)];
      out[idx] = Math.min(255, Math.abs(gx) + Math.abs(gy));
    }
  }

  return out;
}

function buildActiveMask(width, height, roiMaskCfg, offsetX, offsetY) {
  const polygons = extractPolygons(roiMaskCfg && roiMaskCfg.polygons);
  if (!polygons.length) {
    const mask = new Uint8Array(width * height);
    mask.fill(1);
    return mask;
  }
  return buildMaskFromPolygons(width, height, polygons, offsetX, offsetY, activeMaskCache, 'active');
}

function buildExclusionMask(width, height, exclusionPolygons, offsetX, offsetY) {
  const polygons = extractPolygons(exclusionPolygons);
  if (!polygons.length) {
    return new Uint8Array(width * height);
  }
  return buildMaskFromPolygons(width, height, polygons, offsetX, offsetY, zoneMaskCache, 'exclude');
}

function buildFocusZones(width, height, zones, offsetX, offsetY, activeMask) {
  if (!Array.isArray(zones) || !zones.length) {
    return [];
  }

  const result = [];
  for (let i = 0; i < zones.length; i++) {
    const zone = zones[i];
    if (!zone || !Array.isArray(zone.polygon) || zone.polygon.length < 3) {
      continue;
    }

    const zoneMask = buildMaskFromPolygons(
      width,
      height,
      [zone.polygon],
      offsetX,
      offsetY,
      zoneMaskCache,
      `focus:${zone.name || i}`
    );

    let activePixelCount = 0;
    for (let p = 0; p < zoneMask.length; p++) {
      if (zoneMask[p] && activeMask[p]) {
        activePixelCount += 1;
      } else if (zoneMask[p] && !activeMask[p]) {
        zoneMask[p] = 0;
      }
    }

    if (activePixelCount <= 0) {
      continue;
    }

    result.push({
      name: zone.name || `zone_${i + 1}`,
      mask: zoneMask,
      activePixelCount,
      thresholds: {
        pixelDiffThreshold: Math.max(1, Math.floor(numberOr(zone.pixelDiffThreshold, 17))),
        edgeDiffPixelThreshold: Math.max(1, Math.floor(numberOr(zone.edgeDiffPixelThreshold, 20))),
        minForegroundArea: Math.max(1, Math.floor(numberOr(zone.minForegroundArea, 1))),
        minForegroundRatio: Math.max(0.0001, numberOr(zone.minForegroundRatio, 0.001)),
        minLargestComponentArea: Math.max(1, Math.floor(numberOr(zone.minLargestComponentArea, 1))),
        minEdgeDiffRatio: Math.max(0.0001, numberOr(zone.minEdgeDiffRatio, 0.001)),
        highForegroundArea: Math.max(1, Math.floor(numberOr(zone.highForegroundArea, numberOr(zone.minForegroundArea, 1) * 2))),
        highEdgeDiffRatio: Math.max(0.0001, numberOr(zone.highEdgeDiffRatio, numberOr(zone.minEdgeDiffRatio, 0.001) * 2)),
        highLargestComponentArea: Math.max(
          1,
          Math.floor(numberOr(zone.highLargestComponentArea, numberOr(zone.minLargestComponentArea, 1) * 2))
        )
      }
    });
  }

  return result;
}

function buildMaskFromPolygons(width, height, polygons, offsetX, offsetY, cacheStore, keyPrefix) {
  const cacheKey = `${keyPrefix}:${width}x${height}@${offsetX},${offsetY}|${JSON.stringify(polygons)}`;
  const cached = cacheStore.get(cacheKey);
  if (cached) {
    return new Uint8Array(cached);
  }

  const mask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pointX = x + offsetX + 0.5;
      const pointY = y + offsetY + 0.5;
      if (isInsideAnyPolygon(pointX, pointY, polygons)) {
        mask[(y * width) + x] = 1;
      }
    }
  }

  cacheStore.set(cacheKey, new Uint8Array(mask));
  return mask;
}

function extractPolygons(polygons) {
  if (!Array.isArray(polygons)) {
    return [];
  }
  return polygons.filter((polygon) => Array.isArray(polygon) && polygon.length >= 3);
}

function normalizeFocusZones(focusZones, delta) {
  if (!Array.isArray(focusZones)) {
    return [];
  }

  const zones = [];
  for (let i = 0; i < focusZones.length; i++) {
    const zone = focusZones[i];
    if (!zone || typeof zone !== 'object') {
      continue;
    }
    const polygon = Array.isArray(zone.polygon) ? zone.polygon : null;
    if (!polygon || polygon.length < 3) {
      continue;
    }

    zones.push({
      name: sanitizeZoneName(zone.name, i),
      polygon,
      pixelDiffThreshold: Math.max(1, Math.floor(numberOr(zone.pixelDiffThreshold, delta.pixelDiffThreshold))),
      edgeDiffPixelThreshold: Math.max(1, Math.floor(numberOr(zone.edgeDiffPixelThreshold, delta.edgeDiffPixelThreshold))),
      minForegroundArea: Math.max(1, Math.floor(numberOr(zone.minForegroundArea, delta.minForegroundArea))),
      minForegroundRatio: Math.max(0.0001, numberOr(zone.minForegroundRatio, delta.minForegroundRatio)),
      minLargestComponentArea: Math.max(1, Math.floor(numberOr(zone.minLargestComponentArea, delta.minLargestComponentArea))),
      minEdgeDiffRatio: Math.max(0.0001, numberOr(zone.minEdgeDiffRatio, delta.minEdgeDiffRatio)),
      highForegroundArea: Math.max(1, Math.floor(numberOr(zone.highForegroundArea, delta.highForegroundArea))),
      highEdgeDiffRatio: Math.max(0.0001, numberOr(zone.highEdgeDiffRatio, delta.highEdgeDiffRatio)),
      highLargestComponentArea: Math.max(
        1,
        Math.floor(numberOr(zone.highLargestComponentArea, Math.max(delta.minLargestComponentArea * 2, 24)))
      )
    });
  }

  return zones;
}

function sanitizeZoneName(value, index) {
  if (value === undefined || value === null) {
    return `zone_${index + 1}`;
  }
  const normalized = String(value).trim();
  if (!normalized) {
    return `zone_${index + 1}`;
  }
  return normalized.replace(/[^a-zA-Z0-9_-]+/g, '_');
}

function isInsideAnyPolygon(x, y, polygons) {
  for (let i = 0; i < polygons.length; i++) {
    if (pointInPolygon(x, y, polygons[i])) {
      return true;
    }
  }
  return false;
}

function pointInPolygon(x, y, polygon) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = Number(polygon[i].x);
    const yi = Number(polygon[i].y);
    const xj = Number(polygon[j].x);
    const yj = Number(polygon[j].y);
    const intersects = ((yi > y) !== (yj > y))
      && (x < (((xj - xi) * (y - yi)) / ((yj - yi) || 1e-9)) + xi);
    if (intersects) {
      inside = !inside;
    }
  }
  return inside;
}

function normalizeCompareCrop(crop, width, height) {
  if (!crop || typeof crop !== 'object') {
    return null;
  }

  const x = Math.max(0, Math.floor(numberOr(crop.x, 0)));
  const y = Math.max(0, Math.floor(numberOr(crop.y, 0)));
  const w = Math.max(0, Math.floor(numberOr(crop.w, 0)));
  const h = Math.max(0, Math.floor(numberOr(crop.h, 0)));

  if (w <= 0 || h <= 0 || x >= width || y >= height) {
    return null;
  }

  const clampedW = Math.min(w, width - x);
  const clampedH = Math.min(h, height - y);
  if (clampedW <= 1 || clampedH <= 1) {
    return null;
  }

  return { x, y, w: clampedW, h: clampedH };
}

function countActivePixels(mask) {
  let count = 0;
  for (let i = 0; i < mask.length; i++) {
    count += mask[i] ? 1 : 0;
  }
  return count;
}

function luminance(r, g, b) {
  return Math.round((r * 299 + g * 587 + b * 114) / 1000);
}

function boolOr(value, fallback) {
  if (value === undefined || value === null) {
    return fallback;
  }
  return !!value;
}

function numberOr(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function stringOr(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  return String(value);
}

function nonNegativeInt(value) {
  const parsed = Math.floor(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function round(value) {
  if (!Number.isFinite(value)) {
    return null;
  }
  return Number(Number(value).toFixed(6));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

module.exports = {
  MotionEventDetector
};
