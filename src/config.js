module.exports = {
  readDir: './images/received/',
  saveDir: './images/sent/',
  chatName: 'Upcam',
  fileExtension: '.jpg',

  imageFilter: {
    enabled: true,
    resizeWidth: 384,
    cropTop: 24,
    compareCrop: { x: 0, y: 0, w: 384, h: 192 },
    roiMask: {
      polygons: [
        [
          { x: 60, y: 42 },
          { x: 122, y: 40 },
          { x: 186, y: 170 },
          { x: 96, y: 191 },
          { x: 56, y: 191 },
          { x: 60, y: 92 }
        ],
        [
          { x: 176, y: 126 },
          { x: 300, y: 132 },
          { x: 336, y: 191 },
          { x: 212, y: 191 }
        ]
      ]
    },
    zoneModel: {
      diffuseNoiseMinForegroundArea: 180,
      diffuseNoiseMaxLargestComponentArea: 48,
      diffuseNoiseMinZoneCoverage: 0.42,
      fragmentedNoiseMinForegroundArea: 70,
      minConnectedComponentShare: 0.16,
      sceneSweepMinForegroundRatio: 0.08,
      sceneSweepMinZoneCount: 2,
      sceneSweepMinZoneCoverage: 0.82,
      exclusionPolygons: [
        [
          { x: 124, y: 78 },
          { x: 272, y: 78 },
          { x: 284, y: 146 },
          { x: 112, y: 146 }
        ],
        [
          { x: 208, y: 48 },
          { x: 306, y: 52 },
          { x: 314, y: 112 },
          { x: 196, y: 114 }
        ],
        [
          { x: 304, y: 52 },
          { x: 383, y: 64 },
          { x: 383, y: 191 },
          { x: 296, y: 191 }
        ]
      ],
      focusZones: [
        {
          name: 'street_far',
          polygon: [
            { x: 74, y: 56 },
            { x: 206, y: 54 },
            { x: 200, y: 110 },
            { x: 82, y: 114 }
          ],
          pixelDiffThreshold: 10,
          edgeDiffPixelThreshold: 13,
          minForegroundArea: 60,
          minForegroundRatio: 0.002,
          minLargestComponentArea: 30,
          minEdgeDiffRatio: 0.0022,
          highForegroundArea: 130,
          highEdgeDiffRatio: 0.25,
          highLargestComponentArea: 120
        },
        {
          name: 'path_main',
          polygon: [
            { x: 76, y: 96 },
            { x: 176, y: 90 },
            { x: 196, y: 191 },
            { x: 98, y: 191 }
          ],
          pixelDiffThreshold: 14,
          edgeDiffPixelThreshold: 18,
          minForegroundArea: 24,
          minForegroundRatio: 0.0014,
          minLargestComponentArea: 10,
          minEdgeDiffRatio: 0.0025
        },
        {
          name: 'path_right_branch',
          polygon: [
            { x: 176, y: 126 },
            { x: 300, y: 132 },
            { x: 336, y: 191 },
            { x: 212, y: 191 }
          ],
          pixelDiffThreshold: 14,
          edgeDiffPixelThreshold: 18,
          minForegroundArea: 20,
          minForegroundRatio: 0.0013,
          minLargestComponentArea: 10,
          minEdgeDiffRatio: 0.0028
        }
      ]
    },

    failMode: 'open',
    filteredDirName: 'filtered',

    nativeSignal: {
      enabled: true,
      personVehicleAnimalOnly: true,
      minTrustedMotionScore: 0.0055,
      minTrustedEdgeDiffRatio: 0.01,
      minStartScoreWithoutZone: 0.016
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

    brightnessGuard: {
      enabled: true,
      maxUniformDelta: 10,
      maxStdDelta: 7,
      maxForegroundRatio: 0.04
    },

    event: {
      enabled: true,
      minConfirmFrames: 3,
      maxConfirmGapSeconds: 8,
      strongSingleFrameScore: 0.028,
      strongSingleFrameMinZones: 2,
      streetFarSingleZoneMinScore: 0.015,
      nonNativeStrongSingleMinStdAbsDiff: 7,
      nonNativeStrongSingleMinConnectedComponentShare: 0.6,
      nonNativeStrongSingleObviousFgRatio: 0.06,
      maxActiveSendGapSeconds: 6,
      quietFramesToEnd: 2,
      cooldownSeconds: 9,
      maxSendsPerEvent: 4,
      minSecondsBetweenSends: 3,
      sendLastFrame: false,
      minScoreForActiveSend: 0.027
    },

    debug: {
      writeDebugJson: false,
      debugDir: './.state/debug-motion'
    }
  },

  runtime: {
    heartbeatMs: 15000,
    sendTimeoutMs: 45000,
    messageInfoTimeoutMs: 5000,
    notificationMaxRetries: 6,
    notificationRetryDelayMs: 1000,
    pendingRetryDelayMs: 30000,
    pendingRetryMaxDelayMs: 900000,
    verifiedSendRecoveryMs: 180000,
    maxConsecutiveUnverifiedSends: 2,
    healthFile: './.state/runtime-health.json',
    decisionLogFile: './.state/decisions.ndjson',
    notificationLogFile: './.state/notifications.ndjson',
    sampleArchiveDir: './.state/samples',
    sampleArchiveEnabled: true,
    sampleArchiveMaxFilesPerCategory: 200,
    queueWarningDepth: 8,
    queueWarningAgeMs: 60000,
    notificationQueueWarningDepth: 12,
    notificationQueueWarningAgeMs: 120000,
    frameSilenceWarningMs: 45000,
    detectorSilenceWarningMs: 600000,
    repeatedFrameWarningCount: 8,
    repeatedFrameResetCount: 20,
    suppressedCandidateMotionScore: 0.018,
    suppressedCandidateSceneScore: 0.26,
    suppressedCandidateWarningCount: 4,
    detectorSuppressedResetCount: 8,
    recoveryMinIntervalMs: 120000,
    recoveryEscalationWindowMs: 600000
  },

  whatsapp: {
    enableAutoReconnect: true,
    maxRetries: 3,
    retryDelayMs: 2000,
    healthCheckIntervalSec: 60,
    forceReconnectAfterMinutes: 0,
    initializeTimeoutMs: 180000,
    initializeAuthResetFailures: 4,
    protocolTimeoutMs: 120000,
    authInterventionRetryDelayMs: 300000,
    allowSessionDataReset: false,
    textProbeEnabled: false,
    textProbeCooldownMs: 900000,
    textProbePrefix: '[diag]'
  },

  logging: {
    dir: './logs',
    consoleLevel: 'info',
    appLevel: 'info',
    whatsappLevel: 'info',
    appFile: 'snapshotter-app.log',
    whatsappFile: 'snapshotter-whatsapp.log'
  },

  dataCollection: {
    enabled: true,
    maxPerHour: 10,
    saveRelevant: true,
    saveNonRelevant: true,
    baseDir: './dataset',
    maxDays: 7
  }
};
