'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fileTools = require('fs-extra');
const sharp = require('sharp');
const { MotionEventDetector } = require('../src/motionDetector');
const { RuntimeSupervisor } = require('../src/runtimeSupervisor');

const FULL_WIDTH = 384;
const FULL_HEIGHT = 216;
const CROP_TOP = 24;
const ROI_HEIGHT = FULL_HEIGHT - CROP_TOP;

test('detector keeps recall after long quiet soak and brightness nuisance', async () => {
  const tempDir = await fileTools.mkdtemp(path.join(os.tmpdir(), 'snapshotter-soak-'));
  try {
    const detector = new MotionEventDetector(createTestConfig(tempDir));
    const files = [];

    for (let i = 0; i < 45; i++) {
      files.push(await writeFrame(tempDir, `quiet_${String(i).padStart(3, '0')}.png`, createScene()));
    }
    for (let i = 0; i < 8; i++) {
      files.push(await writeFrame(tempDir, `bright_${String(i).padStart(3, '0')}.png`, createScene({ brightnessOffset: i * 5 })));
    }
    for (let i = 0; i < 35; i++) {
      files.push(await writeFrame(tempDir, `quiet2_${String(i).padStart(3, '0')}.png`, createScene()));
    }

    const motionStartIndex = files.length;
    for (let i = 0; i < 5; i++) {
      files.push(await writeFrame(tempDir, `motion_${String(i).padStart(3, '0')}.png`, createScene({
        mover: {
          x: 74 + (i * 22),
          y: 76 + (i * 8),
          w: 26,
          h: 40
        }
      })));
    }

    const decisions = [];
    for (let i = 0; i < files.length; i++) {
      const decision = await detector.analyzeFrame(files[i], new Date(Date.UTC(2026, 2, 22, 12, 0, i)));
      decisions.push(decision);
    }

    const sendIndices = decisions
      .map((decision, index) => ({ decision, index }))
      .filter((item) => item.decision.send)
      .map((item) => item.index);

    assert.equal(sendIndices.filter((index) => index < motionStartIndex).length, 0, 'quiet and brightness frames should not send');
    assert.ok(sendIndices.length >= 1, 'real motion should produce at least one send');
    assert.ok(sendIndices[0] <= motionStartIndex + 2, `first send too late: ${sendIndices[0]}`);
  } finally {
    await fileTools.remove(tempDir);
  }
});

test('detector suppresses pure brightness shifts', async () => {
  const tempDir = await fileTools.mkdtemp(path.join(os.tmpdir(), 'snapshotter-brightness-'));
  try {
    const detector = new MotionEventDetector(createTestConfig(tempDir));
    const decisions = [];

    for (let i = 0; i < 6; i++) {
      const file = await writeFrame(tempDir, `frame_${String(i).padStart(2, '0')}.png`, createScene({
        brightnessOffset: i * 7
      }));
      decisions.push(await detector.analyzeFrame(file, new Date(Date.UTC(2026, 2, 22, 13, 0, i))));
    }

    assert.equal(decisions.filter((decision) => decision.send).length, 0, 'brightness-only sequence should not send');
  } finally {
    await fileTools.remove(tempDir);
  }
});

test('detector requires visual support for native class signal', async () => {
  const tempDir = await fileTools.mkdtemp(path.join(os.tmpdir(), 'snapshotter-native-support-'));
  try {
    const detector = new MotionEventDetector(createTestConfig(tempDir));
    const baseline = await writeFrame(tempDir, 'baseline.png', createScene());
    const staticFollowup = await writeFrame(tempDir, 'static_native.png', createScene());
    const motionFollowup = await writeFrame(tempDir, 'motion_native.png', createScene({
      mover: {
        x: 112,
        y: 102,
        w: 22,
        h: 34
      }
    }));

    await detector.analyzeFrame(baseline, new Date(Date.UTC(2026, 2, 22, 14, 0, 0)));
    const suppressed = await detector.analyzeFrame(staticFollowup, new Date(Date.UTC(2026, 2, 22, 14, 0, 1)), {
      cameraSignal: { personDetected: true }
    });
    const accepted = await detector.analyzeFrame(motionFollowup, new Date(Date.UTC(2026, 2, 22, 14, 0, 2)), {
      cameraSignal: { personDetected: true }
    });

    assert.equal(suppressed.send, false, 'native class alone should not send without matching frame motion');
    assert.equal(accepted.send, true, 'native class with matching frame motion should send');
    assert.ok(
      ['event_start_native_class', 'event_start_strong_single'].includes(accepted.reason),
      `unexpected start reason: ${accepted.reason}`
    );
  } finally {
    await fileTools.remove(tempDir);
  }
});

test('detector does not resend active event without zone transition', async () => {
  const tempDir = await fileTools.mkdtemp(path.join(os.tmpdir(), 'snapshotter-active-peak-'));
  try {
    const detector = new MotionEventDetector(createTestConfig(tempDir));
    const baseline = await writeFrame(tempDir, 'baseline.png', createScene());
    const startFrame = await writeFrame(tempDir, 'start.png', createScene({
      mover: {
        x: 118,
        y: 108,
        w: 18,
        h: 30
      }
    }));
    const followupFrame = await writeFrame(tempDir, 'followup.png', createScene({
      mover: {
        x: 124,
        y: 114,
        w: 18,
        h: 30
      }
    }));

    await detector.analyzeFrame(baseline, new Date(Date.UTC(2026, 2, 22, 15, 0, 0)));
    const first = await detector.analyzeFrame(startFrame, new Date(Date.UTC(2026, 2, 22, 15, 0, 1)), {
      cameraSignal: { personDetected: true }
    });
    const second = await detector.analyzeFrame(followupFrame, new Date(Date.UTC(2026, 2, 22, 15, 0, 2)), {
      cameraSignal: { personDetected: true }
    });

    assert.equal(first.send, true, 'first native-supported motion frame should start the event');
    assert.equal(second.send, false, 'same-zone follow-up motion should stay active without resending');
    assert.equal(second.reason, 'event_active');
  } finally {
    await fileTools.remove(tempDir);
  }
});

test('runtime supervisor recovers from repeated identical frames', async () => {
  const tempDir = await fileTools.mkdtemp(path.join(os.tmpdir(), 'snapshotter-health-'));
  try {
    const supervisor = new RuntimeSupervisor({
      repeatedFrameWarningCount: 2,
      repeatedFrameResetCount: 4,
      queueWarningDepth: 2,
      queueWarningAgeMs: 2_000,
      recoveryMinIntervalMs: 10_000,
      sampleArchiveEnabled: false,
      healthFile: path.join(tempDir, 'health.json'),
      decisionLogFile: path.join(tempDir, 'decisions.ndjson'),
      notificationLogFile: path.join(tempDir, 'notifications.ndjson')
    });
    const identicalFile = await writeFrame(tempDir, 'identical.png', createScene());

    for (let i = 0; i < 4; i++) {
      await supervisor.recordDecision({
        sourcePath: identicalFile,
        archivedPath: identicalFile,
        decision: {
          send: false,
          reason: 'no_motion',
          metrics: { motionScore: 0.0, edgeDiffRatio: 0.0, fgRatio: 0.0 },
          signal: { motion: false, highConfidence: false, nativeSignal: { active: false } }
        },
        at: (i + 1) * 1_000
      });
    }

    const actions = await supervisor.evaluate({}, 15_000);
    assert.ok(actions.some((action) => action.reason === 'repeated_identical_frames'), 'expected repeated-frame recovery action');
  } finally {
    await fileTools.remove(tempDir);
  }
});

test('runtime supervisor escalates when native signal is repeatedly suppressed', async () => {
  const tempDir = await fileTools.mkdtemp(path.join(os.tmpdir(), 'snapshotter-suppressed-'));
  try {
    const supervisor = new RuntimeSupervisor({
      suppressedCandidateWarningCount: 2,
      detectorSuppressedResetCount: 3,
      recoveryMinIntervalMs: 10_000,
      sampleArchiveEnabled: false,
      healthFile: path.join(tempDir, 'health.json'),
      decisionLogFile: path.join(tempDir, 'decisions.ndjson'),
      notificationLogFile: path.join(tempDir, 'notifications.ndjson')
    });
    const file = await writeFrame(tempDir, 'candidate.png', createScene());

    for (let i = 0; i < 3; i++) {
      await supervisor.recordDecision({
        sourcePath: file,
        archivedPath: file,
        decision: {
          send: false,
          reason: 'suppressed_candidate',
          metrics: { motionScore: 0.026, edgeDiffRatio: 0.010, fgRatio: 0.012 },
          scene: { classification: { label: 'ignore', reason: 'candidate', relevanceScore: 0.29 }, scene: { activeCellRatio: 0.12, pathActivityRatio: 0.34, noiseActivityRatio: 0.10 } },
          signal: { motion: false, highConfidence: false, nativeSignal: { active: true, personDetected: true } }
        },
        at: (i + 1) * 1_000
      });
    }

    const firstActions = await supervisor.evaluate({}, 15_000);
    assert.ok(firstActions.some((action) => action.reason === 'suppressed_motion_candidates' && action.mode === 'soft'));

    supervisor.recordRecovery('suppressed_motion_candidates', 'soft', 15_000);
    for (let i = 0; i < 3; i++) {
      await supervisor.recordDecision({
        sourcePath: file,
        archivedPath: file,
        decision: {
          send: false,
          reason: 'suppressed_candidate',
          metrics: { motionScore: 0.027, edgeDiffRatio: 0.011, fgRatio: 0.013 },
          scene: { classification: { label: 'ignore', reason: 'candidate', relevanceScore: 0.30 }, scene: { activeCellRatio: 0.13, pathActivityRatio: 0.35, noiseActivityRatio: 0.11 } },
          signal: { motion: false, highConfidence: false, nativeSignal: { active: true, personDetected: true } }
        },
        at: 16_000 + (i * 1_000)
      });
    }

    const secondActions = await supervisor.evaluate({}, 26_000);
    assert.ok(secondActions.some((action) => action.reason === 'suppressed_motion_candidates' && action.mode === 'hard'));
  } finally {
    await fileTools.remove(tempDir);
  }
});

test('runtime supervisor records verified notification details and whatsapp health warnings', async () => {
  const tempDir = await fileTools.mkdtemp(path.join(os.tmpdir(), 'snapshotter-notify-health-'));
  try {
    const supervisor = new RuntimeSupervisor({
      sampleArchiveEnabled: false,
      healthFile: path.join(tempDir, 'health.json'),
      decisionLogFile: path.join(tempDir, 'decisions.ndjson'),
      notificationLogFile: path.join(tempDir, 'notifications.ndjson')
    });
    const imagePath = path.join(tempDir, 'send.jpg');
    await fileTools.writeFile(imagePath, Buffer.from([0x01, 0x02, 0x03]));

    supervisor.recordNotificationQueued(imagePath, 1_000);
    await supervisor.recordNotificationResult({
      filePath: imagePath,
      success: true,
      at: 2_000,
      details: {
        startedAtMs: 1_200,
        attempts: 2,
        queueRetries: 1,
        verificationStatus: 'verified',
        messageObjectReturned: true,
        messageId: 'abc123',
        ack: 1,
        ackLabel: 'ACK_SERVER',
        verificationMethod: 'ack_poll',
        finalPath: path.join(tempDir, 'sent', 'send.jpg'),
        targetChatId: '123456789@c.us',
        targetChatTitle: 'Upcam',
        targetChatIsGroup: false,
        clientState: 'CONNECTED',
        appState: 'CONNECTED',
        whatsappStatus: 'CONNECTED',
        durationMs: 800,
        deliveryInfo: {
          deliveryCount: 1,
          deliveryRemaining: 0
        }
      }
    });

    await supervisor.evaluate({}, 3_000, {
      whatsapp: {
        status: 'DEGRADED',
        reason: 'health_check_degraded'
      }
    });

    const health = await fileTools.readJson(path.join(tempDir, 'health.json'));
    const notificationLog = await fileTools.readFile(path.join(tempDir, 'notifications.ndjson'), 'utf8');
    const notificationEntry = JSON.parse(notificationLog.trim().split('\n').pop());

    assert.equal(notificationEntry.success, true);
    assert.equal(notificationEntry.verificationStatus, 'verified');
    assert.equal(notificationEntry.messageObjectReturned, true);
    assert.equal(notificationEntry.messageId, 'abc123');
    assert.equal(notificationEntry.ack, 1);
    assert.equal(notificationEntry.ackLabel, 'ACK_SERVER');
    assert.equal(notificationEntry.verification, 'ack_poll');
    assert.equal(notificationEntry.attempts, 2);
    assert.equal(notificationEntry.targetChatTitle, 'Upcam');
    assert.ok(health.warnings.includes('whatsapp_status=degraded'));
    assert.equal(health.health.lastVerifiedNotificationAt, new Date(2_000).toISOString());
    assert.equal(health.lastNotification.messageId, 'abc123');
    assert.equal(health.lastNotification.finalPath, path.join(tempDir, 'sent', 'send.jpg'));
    assert.equal(health.whatsapp.status, 'DEGRADED');
  } finally {
    await fileTools.remove(tempDir);
  }
});

function createTestConfig(tempDir) {
  return {
    resizeWidth: FULL_WIDTH,
    cropTop: CROP_TOP,
    compareCrop: { x: 0, y: 0, w: FULL_WIDTH, h: ROI_HEIGHT },
    roiMask: {
      polygons: [[
        { x: 24, y: 8 },
        { x: FULL_WIDTH - 24, y: 8 },
        { x: FULL_WIDTH - 24, y: ROI_HEIGHT - 1 },
        { x: 24, y: ROI_HEIGHT - 1 }
      ]]
    },
    suppressionZones: {},
    edgeDiffRatioThreshold: 0.003,
    edgeDiffPixelThreshold: 18,
    highEdgeDiffRatio: 0.009,
    failMode: 'open',
    filteredDirName: 'filtered',
    event: {
      enabled: true,
      minConfirmFrames: 2,
      windowSeconds: 5,
      maxSendsPerEvent: 3,
      minSecondsBetweenSends: 1,
      cooldownSeconds: 3,
      quietSeconds: 2,
      fastBypass: true,
      sendLastFrame: false,
      peakMotionScore: 0.022,
      peakScoreDelta: 0.004,
      peakScoreDecayPerSecond: 0.004,
      dropScoreDelta: 0.08,
      dropMotionScoreFloor: 0.01
    },
    brightnessGuard: {
      enabled: true,
      maxUniformDelta: 10,
      maxStdDelta: 6,
      maxForegroundRatio: 0.06
    },
    nativeSignal: {
      enabled: true,
      personVehicleAnimalOnly: true,
      minTrustedMotionScore: 0.0055,
      minTrustedEdgeDiffRatio: 0.01
    },
    nightProfile: {
      enabled: false
    },
    backgroundModel: {
      enabled: true,
      alpha: 0.012,
      pixelDiffThreshold: 14,
      minForegroundArea: 55,
      highForegroundArea: 120,
      highForegroundRatio: 0.008,
      minForegroundComponentArea: 18,
      highForegroundComponentArea: 36
    },
    zoneModel: {
      sceneSweepMinForegroundRatio: 0.08,
      sceneSweepMinZoneCount: 2,
      sceneSweepMinZoneCoverage: 0.82
    },
    debug: {
      writeDebugImages: false,
      writeDebugJson: false,
      debugDir: path.join(tempDir, 'debug')
    }
  };
}

function createScene(options = {}) {
  const brightnessOffset = Number(options.brightnessOffset || 0);
  const mover = options.mover || null;
  const data = new Uint8Array(FULL_WIDTH * FULL_HEIGHT * 3);

  for (let y = 0; y < FULL_HEIGHT; y++) {
    for (let x = 0; x < FULL_WIDTH; x++) {
      const idx = ((y * FULL_WIDTH) + x) * 3;
      const noise = ((x * 11) + (y * 7)) % 6;

      let r;
      let g;
      let b;
      if (y < CROP_TOP + 20) {
        r = 96 + noise;
        g = 122 + noise;
        b = 142 + noise;
      } else if (y < CROP_TOP + 80) {
        r = 74 + noise;
        g = 84 + noise;
        b = 78 + noise;
      } else {
        r = 56 + noise;
        g = 58 + noise;
        b = 60 + noise;
      }

      data[idx] = clampColor(r + brightnessOffset);
      data[idx + 1] = clampColor(g + brightnessOffset);
      data[idx + 2] = clampColor(b + brightnessOffset);
    }
  }

  if (mover) {
    const fullY = CROP_TOP + mover.y;
    for (let y = fullY; y < Math.min(FULL_HEIGHT, fullY + mover.h); y++) {
      for (let x = mover.x; x < Math.min(FULL_WIDTH, mover.x + mover.w); x++) {
        const idx = ((y * FULL_WIDTH) + x) * 3;
        data[idx] = 208;
        data[idx + 1] = 208;
        data[idx + 2] = 212;
      }
    }
  }

  return data;
}

async function writeFrame(tempDir, filename, rgbData) {
  const filePath = path.join(tempDir, filename);
  await sharp(Buffer.from(rgbData), {
    raw: {
      width: FULL_WIDTH,
      height: FULL_HEIGHT,
      channels: 3
    }
  }).png().toFile(filePath);
  return filePath;
}

function clampColor(value) {
  return Math.max(0, Math.min(255, Math.round(value)));
}
