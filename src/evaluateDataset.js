'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');
const { MotionEventDetector } = require('./motionDetector');

const DEFAULT_GAP_SECONDS = 60;
const IMAGE_FILE_PATTERN = /\.(jpg|jpeg)$/i;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const datasetRoot = path.resolve(args.dataset || path.join(__dirname, '..', '..', 'dataset'));
  const replayGapSeconds = Number.isFinite(args.gapSeconds) ? args.gapSeconds : DEFAULT_GAP_SECONDS;
  const frames = loadDatasetFrames(datasetRoot);

  const archived = evaluateArchivedBaseline(frames);
  const replay = await evaluateReplay(frames, replayGapSeconds);
  const report = {
    datasetRoot,
    totalFrames: frames.length,
    archivedBaseline: archived,
    replayEvaluation: replay,
    assumptions: [
      'Ground truth is derived from folder + NOK prefix.',
      'Archived baseline uses the original runtime classification implied by the folder name.',
      `Replay resets detector state when the sampled gap exceeds ${replayGapSeconds} seconds.`,
      'Replay evaluates the sampled dataset only; missing unsampled frames can distort event timing and first-frame behavior.'
    ]
  };

  if (args.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  printSummary(report);
}

function parseArgs(argv) {
  const out = {
    json: false,
    gapSeconds: DEFAULT_GAP_SECONDS
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') {
      out.json = true;
      continue;
    }
    if (arg === '--dataset' && i + 1 < argv.length) {
      out.dataset = argv[++i];
      continue;
    }
    if (arg === '--gapSeconds' && i + 1 < argv.length) {
      out.gapSeconds = Number(argv[++i]);
    }
  }

  return out;
}

function loadDatasetFrames(datasetRoot) {
  const frames = [];
  for (const predictedType of ['relevant', 'non_relevant']) {
    const predictedDir = path.join(datasetRoot, predictedType);
    walkImages(predictedDir, (imagePath) => {
      frames.push(loadFrameRecord(imagePath, predictedType));
    });
  }

  frames.sort((left, right) => {
    if (left.timestampMs !== right.timestampMs) {
      return left.timestampMs - right.timestampMs;
    }
    return left.imageName.localeCompare(right.imageName);
  });
  return frames;
}

function walkImages(rootDir, visit) {
  if (!fs.existsSync(rootDir)) {
    return;
  }

  const stack = [rootDir];
  while (stack.length) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && IMAGE_FILE_PATTERN.test(entry.name)) {
        visit(fullPath);
      }
    }
  }
}

function loadFrameRecord(imagePath, predictedType) {
  const imageName = path.basename(imagePath);
  const corrected = isIncorrectlyLabeled(imageName);
  const cleanImageName = imageName.replace(/^NOK[-_]/i, '');
  const metadataPath = `${imagePath.replace(imageName, cleanImageName)}.json`;
  const metadata = readJson(metadataPath) || {};
  const timestampMs = resolveTimestampMs(imagePath, cleanImageName, metadata);
  const truthRelevant = predictedType === 'relevant' ? !corrected : corrected;

  return {
    imagePath,
    imageName,
    cleanImageName,
    metadataPath,
    metadata,
    predictedType,
    truthRelevant,
    timestampMs,
    cameraSignal: metadata.cameraSignal || null
  };
}

function evaluateArchivedBaseline(frames) {
  const confusion = emptyConfusion();
  const reasons = {};

  for (const frame of frames) {
    const predictedRelevant = frame.predictedType === 'relevant';
    updateConfusion(confusion, predictedRelevant, frame.truthRelevant);

    const bucket = predictedRelevant && !frame.truthRelevant ? 'fp'
      : (!predictedRelevant && frame.truthRelevant ? 'fn'
        : (predictedRelevant ? 'tp' : 'tn'));
    const reason = frame.metadata.reason || 'unknown';
    reasons[bucket] = reasons[bucket] || {};
    reasons[bucket][reason] = (reasons[bucket][reason] || 0) + 1;
  }

  return {
    method: 'archived_runtime_labels',
    confusion: finalizeConfusion(confusion),
    topReasons: summarizeCounts(reasons)
  };
}

async function evaluateReplay(frames, gapSeconds) {
  const detector = new MotionEventDetector(clone(config.imageFilter));
  const confusion = emptyConfusion();
  const reasons = {};
  const zonePatterns = {};
  let segmentCount = 0;
  let baselineFrames = 0;
  let previousTimestampMs = null;

  for (const frame of frames) {
    const gapSecondsFromPrevious = previousTimestampMs === null
      ? Number.POSITIVE_INFINITY
      : ((frame.timestampMs - previousTimestampMs) / 1000);
    if (!Number.isFinite(gapSecondsFromPrevious) || gapSecondsFromPrevious > gapSeconds) {
      detector.resetRuntime();
      segmentCount += 1;
    }

    const decision = await detector.analyzeFrame(
      frame.imagePath,
      new Date(frame.timestampMs),
      { cameraSignal: frame.cameraSignal }
    );

    const predictedRelevant = !!decision.send;
    updateConfusion(confusion, predictedRelevant, frame.truthRelevant);
    if (decision.reason === 'baseline_initialized') {
      baselineFrames += 1;
    }

    const bucket = predictedRelevant && !frame.truthRelevant ? 'fp'
      : (!predictedRelevant && frame.truthRelevant ? 'fn'
        : (predictedRelevant ? 'tp' : 'tn'));
    reasons[bucket] = reasons[bucket] || {};
    reasons[bucket][decision.reason] = (reasons[bucket][decision.reason] || 0) + 1;

    const zoneKey = summarizeZonePattern(decision.metrics && decision.metrics.zoneSummary);
    zonePatterns[bucket] = zonePatterns[bucket] || {};
    zonePatterns[bucket][zoneKey] = (zonePatterns[bucket][zoneKey] || 0) + 1;
    previousTimestampMs = frame.timestampMs;
  }

  return {
    method: 'gap_aware_replay',
    gapSeconds,
    segmentCount,
    baselineFrames,
    confusion: finalizeConfusion(confusion),
    topReasons: summarizeCounts(reasons),
    topZonePatterns: summarizeCounts(zonePatterns)
  };
}

function summarizeZonePattern(zoneSummary) {
  if (!Array.isArray(zoneSummary) || !zoneSummary.length) {
    return '(none)';
  }
  const passed = zoneSummary
    .filter((zone) => zone && zone.pass)
    .map((zone) => zone.name)
    .sort();
  return passed.length ? passed.join('+') : '(none)';
}

function emptyConfusion() {
  return {
    tp: 0,
    tn: 0,
    fp: 0,
    fn: 0
  };
}

function updateConfusion(confusion, predictedRelevant, truthRelevant) {
  if (predictedRelevant && truthRelevant) {
    confusion.tp += 1;
    return;
  }
  if (predictedRelevant && !truthRelevant) {
    confusion.fp += 1;
    return;
  }
  if (!predictedRelevant && truthRelevant) {
    confusion.fn += 1;
    return;
  }
  confusion.tn += 1;
}

function finalizeConfusion(confusion) {
  const precision = safeDivide(confusion.tp, confusion.tp + confusion.fp);
  const recall = safeDivide(confusion.tp, confusion.tp + confusion.fn);
  const f1 = (precision > 0 || recall > 0)
    ? ((2 * precision * recall) / (precision + recall))
    : 0;

  return {
    tp: confusion.tp,
    tn: confusion.tn,
    fp: confusion.fp,
    fn: confusion.fn,
    precision: round(precision),
    recall: round(recall),
    f1: round(f1)
  };
}

function summarizeCounts(groups) {
  const out = {};
  for (const [bucket, counts] of Object.entries(groups)) {
    out[bucket] = Object.entries(counts)
      .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
      .slice(0, 10)
      .map(([key, count]) => ({ key, count }));
  }
  return out;
}

function resolveTimestampMs(imagePath, cleanImageName, metadata) {
  if (metadata && metadata.timestamp) {
    const parsed = Date.parse(metadata.timestamp);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  let match = cleanImageName.match(/(\d{8})_(\d{6})/);
  if (match) {
    return toTimestampMs(match[1], match[2]);
  }

  match = cleanImageName.match(/(\d{4})_(\d{6})/);
  if (match) {
    const dateKey = path.basename(path.dirname(path.dirname(imagePath))).replace(/-/g, '');
    const timePart = match[2];
    return toTimestampMs(dateKey, timePart);
  }

  throw new Error(`Unable to resolve timestamp for ${imagePath}`);
}

function toTimestampMs(datePart, timePart) {
  return Date.parse(
    `${datePart.slice(0, 4)}-${datePart.slice(4, 6)}-${datePart.slice(6, 8)}T${timePart.slice(0, 2)}:${timePart.slice(2, 4)}:${timePart.slice(4, 6)}Z`
  );
}

function isIncorrectlyLabeled(imageName) {
  return /^NOK[-_]/i.test(imageName);
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function safeDivide(numerator, denominator) {
  return denominator > 0 ? (numerator / denominator) : 0;
}

function round(value) {
  return Number(value.toFixed(6));
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function printSummary(report) {
  console.log(`Dataset: ${report.datasetRoot}`);
  console.log(`Frames: ${report.totalFrames}`);
  console.log('');
  printConfusion('Archived Baseline', report.archivedBaseline);
  console.log('');
  printConfusion('Replay Evaluation', report.replayEvaluation);
  console.log(`Replay segments: ${report.replayEvaluation.segmentCount}`);
  console.log(`Replay baseline-initialized frames: ${report.replayEvaluation.baselineFrames}`);
}

function printConfusion(title, section) {
  const confusion = section.confusion;
  console.log(title);
  console.log(`  method=${section.method}`);
  console.log(
    `  tp=${confusion.tp} tn=${confusion.tn} fp=${confusion.fp} fn=${confusion.fn}` +
    ` precision=${confusion.precision} recall=${confusion.recall} f1=${confusion.f1}`
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
