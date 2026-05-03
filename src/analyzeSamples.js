'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');
const { MotionEventDetector } = require('./motionDetector');

const filteredMotionRoot = resolveVehicleSequenceRoot();

const baseSequences = [
  {
    name: 'dog_day_driveway',
    files: [
      resolveRepoImagePath('20260312_122431.jpg'),
      resolveRepoImagePath('20260312_122435.jpg'),
      resolveRepoImagePath('20260312_122439.jpg'),
      resolveRepoImagePath('20260312_122441.jpg'),
      resolveRepoImagePath('20260312_122447.jpg')
    ],
    expect: {
      minSends: 2,
      firstSendByIndex: 1,
      minMotionFrames: 4
    },
    reverseExpect: {
      minSends: 1,
      firstSendByIndex: 1,
      minMotionFrames: 4
    }
  },
  {
    name: 'dog_whatsapp_compressed',
    files: [
      resolveRepoImagePath('IMG-20260302-WA0133.jpg'),
      resolveRepoImagePath('IMG-20260302-WA0134.jpg'),
      resolveRepoImagePath('IMG-20260302-WA0135.jpg')
    ],
    expect: {
      minSends: 1,
      firstSendByIndex: 1,
      minMotionFrames: 2
    },
    reverseExpect: {
      minSends: 1,
      firstSendByIndex: 1,
      minMotionFrames: 2
    }
  },
  {
    name: 'driveway_vehicle_filtered_motion',
    files: fs.readdirSync(filteredMotionRoot)
      .filter((file) => file.toLowerCase().endsWith('.jpg'))
      .sort()
      .map((file) => absoluteToRelativeModulePath(path.join(filteredMotionRoot, file))),
    expect: {
      minSends: 4,
      firstSendByIndex: 1,
      minMotionFrames: 12
    },
    reverseExpect: {
      minSends: 1,
      firstSendByIndex: 1,
      minMotionFrames: 12
    }
  },
  {
    name: 'quiet_burst_then_scene_rebase',
    includeReverse: false,
    files: [
      resolveRepoImagePath(path.join('live_burst', 'live_00.jpg')),
      resolveRepoImagePath(path.join('live_burst', 'live_01.jpg')),
      resolveRepoImagePath(path.join('live_burst', 'live_02.jpg')),
      resolveRepoImagePath(path.join('live_burst', 'live_03.jpg')),
      resolveRepoImagePath('20260320_094635.jpg')
    ],
    expect: {
      minSends: 0,
      maxSends: 0,
      maxMotionFrames: 0
    }
  }
];

const sequences = baseSequences.flatMap((sequence) => {
  const variants = [{
    name: sequence.name,
    direction: 'forward',
    files: sequence.files,
    expect: sequence.expect
  }];

  if (sequence.includeReverse !== false) {
    variants.push({
      name: `${sequence.name}_reverse`,
      direction: 'reverse',
      files: [...sequence.files].reverse(),
      expect: sequence.reverseExpect || sequence.expect
    });
  }

  return variants;
});

function parseTimestamp(filePath) {
  const file = path.basename(filePath);
  const match = file.match(/(\d{8})_(\d{6})/);
  if (!match) return new Date();

  const date = match[1];
  const time = match[2];
  return new Date(
    `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}Z`
  );
}

function resolveVehicleSequenceRoot() {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const candidates = [
    path.join(repoRoot, 'filtered_motion'),
    path.join(repoRoot, 'dist', 'upcam-node-package_20260320_085443', 'filtered_motion')
  ];

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    const jpgCount = fs.readdirSync(candidate).filter((file) => file.toLowerCase().endsWith('.jpg')).length;
    if (jpgCount > 0) return candidate;
  }

  throw new Error('Unable to locate filtered_motion dataset in workspace.');
}

function absoluteToRelativeModulePath(absPath) {
  const relative = path.relative(__dirname, absPath);
  return relative.startsWith('.') ? relative : `./${relative}`;
}

function resolveRepoImagePath(relativePath) {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const normalized = typeof relativePath === 'string' ? relativePath : String(relativePath);
  const candidates = [
    path.join(repoRoot, normalized),
    path.join(repoRoot, 'dist', 'upcam-node-package_20260320_085443', normalized)
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return absoluteToRelativeModulePath(candidate);
    }
  }

  throw new Error(`Unable to locate sample image: ${normalized}`);
}

async function analyzeSequence(sequence) {
  const detectorConfig = JSON.parse(JSON.stringify(config.imageFilter));
  const detector = new MotionEventDetector(detectorConfig);
  const results = [];

  for (const relativeFile of sequence.files) {
    const fullPath = path.resolve(__dirname, relativeFile);
    const result = await detector.analyzeFrame(fullPath, parseTimestamp(relativeFile));
    results.push({
      file: path.basename(relativeFile),
      send: result.send,
      reason: result.reason,
      phase: result.phase,
      sendType: result.sendType,
      sceneLabel: result.scene && result.scene.classification ? result.scene.classification.label : 'n/a',
      motion: !!(result.signal && result.signal.motion),
      motionScore: result.metrics.motionScore || 0,
      edgeDiffRatio: result.metrics.edgeDiffRatio || 0,
      foregroundArea: result.metrics.foregroundArea || 0,
      largestComponentArea: result.metrics.largestComponentArea || 0
    });
  }

  return results;
}

function validateSequence(sequence, results) {
  const sendIndices = results
    .map((result, index) => ({ result, index }))
    .filter((item) => item.result.send)
    .map((item) => item.index);
  const motionFrameCount = results.filter((result) => result.motion).length;
  const firstSendIndex = sendIndices.length ? sendIndices[0] : Number.POSITIVE_INFINITY;

  const failures = [];
  if (sendIndices.length < sequence.expect.minSends) {
    failures.push(`expected at least ${sequence.expect.minSends} sends, got ${sendIndices.length}`);
  }
  if (typeof sequence.expect.maxSends === 'number' && sendIndices.length > sequence.expect.maxSends) {
    failures.push(`expected at most ${sequence.expect.maxSends} sends, got ${sendIndices.length}`);
  }
  if (typeof sequence.expect.firstSendByIndex === 'number' && firstSendIndex > sequence.expect.firstSendByIndex) {
    failures.push(`expected first send by frame ${sequence.expect.firstSendByIndex}, got ${firstSendIndex}`);
  }
  if (typeof sequence.expect.minMotionFrames === 'number' && motionFrameCount < sequence.expect.minMotionFrames) {
    failures.push(`expected at least ${sequence.expect.minMotionFrames} motion frames, got ${motionFrameCount}`);
  }
  if (typeof sequence.expect.maxMotionFrames === 'number' && motionFrameCount > sequence.expect.maxMotionFrames) {
    failures.push(`expected at most ${sequence.expect.maxMotionFrames} motion frames, got ${motionFrameCount}`);
  }
  return failures;
}

async function main() {
  let failed = false;

  for (const sequence of sequences) {
    const results = await analyzeSequence(sequence);
    const failures = validateSequence(sequence, results);

    console.log(`\n[SEQ] ${sequence.name} direction=${sequence.direction}`);
    for (const result of results) {
      console.log(
        `${result.file}\tsend=${result.send}\tphase=${result.phase}\treason=${result.reason}\t` +
        `scene=${result.sceneLabel}\tscore=${result.motionScore.toFixed(6)}\tedge=${result.edgeDiffRatio.toFixed(6)}\t` +
        `fgArea=${result.foregroundArea}\tlargest=${result.largestComponentArea}`
      );
    }

    if (failures.length) {
      failed = true;
      for (const failure of failures) {
        console.error(`[FAIL] ${sequence.name}: ${failure}`);
      }
    } else {
      console.log(`[PASS] ${sequence.name}`);
    }
  }

  if (failed) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
