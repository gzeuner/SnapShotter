'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fileTools = require('fs-extra');
const { DataCollector } = require('../src/dataCollector');

test('data collector stores capped hourly samples per category and resets next hour', async () => {
  const tempDir = await fileTools.mkdtemp(path.join(os.tmpdir(), 'snapshotter-collector-'));
  try {
    const sourceDir = path.join(tempDir, 'source');
    const datasetDir = path.join(tempDir, 'dataset');
    await fileTools.ensureDir(sourceDir);

    const sourceImage = path.join(sourceDir, '20260325_141233_b2.jpg');
    await fileTools.writeFile(sourceImage, Buffer.from([0x01, 0x02, 0x03]));

    const collector = new DataCollector({
      enabled: true,
      maxPerHour: 2,
      saveRelevant: true,
      saveNonRelevant: true,
      baseDir: datasetDir
    });

    const relevantDecision = {
      send: true,
      phase: 'ACTIVE',
      metrics: {
        motionScore: 0.072,
        edgeDiffRatio: 0.012,
        foregroundArea: 321
      }
    };
    const nonRelevantDecision = {
      send: false,
      phase: 'IDLE',
      reason: 'no_motion',
      metrics: {
        motionScore: 0.012,
        edgeDiffRatio: 0.002,
        foregroundArea: 12
      }
    };

    for (let i = 0; i < 4; i++) {
      collector.collect({
        imagePath: sourceImage,
        decision: relevantDecision,
        observedAt: new Date(2026, 2, 25, 14, 12, i)
      });
      collector.collect({
        imagePath: sourceImage,
        decision: nonRelevantDecision,
        observedAt: new Date(2026, 2, 25, 14, 13, i)
      });
    }

    collector.collect({
      imagePath: sourceImage,
      decision: relevantDecision,
      observedAt: new Date(2026, 2, 25, 15, 0, 1)
    });

    await collector.waitForIdle();

    const relevantHour14 = await countJpegs(path.join(datasetDir, 'relevant', '2026-03-25', '14'));
    const nonRelevantHour14 = await countJpegs(path.join(datasetDir, 'non_relevant', '2026-03-25', '14'));
    const relevantHour15 = await countJpegs(path.join(datasetDir, 'relevant', '2026-03-25', '15'));

    assert.equal(relevantHour14, 2);
    assert.equal(nonRelevantHour14, 2);
    assert.equal(relevantHour15, 1);
  } finally {
    await fileTools.remove(tempDir);
  }
});

test('data collector includes score metadata in filenames and writes sidecar json', async () => {
  const tempDir = await fileTools.mkdtemp(path.join(os.tmpdir(), 'snapshotter-collector-meta-'));
  try {
    const sourceDir = path.join(tempDir, 'source');
    const datasetDir = path.join(tempDir, 'dataset');
    await fileTools.ensureDir(sourceDir);

    const sourceImage = path.join(sourceDir, '20260325_141245_b1.jpg');
    await fileTools.writeFile(sourceImage, Buffer.from([0x04, 0x05, 0x06]));

    const collector = new DataCollector({
      enabled: true,
      maxPerHour: 10,
      baseDir: datasetDir
    });

    collector.collect({
      imagePath: sourceImage,
      decision: {
        send: false,
        phase: 'IDLE',
        reason: 'no_motion',
        metrics: {
          motionScore: 0.012,
          edgeDiffRatio: 0.0034,
          foregroundArea: 8
        },
        signal: {
          nativeSignal: {
            active: false,
            relevantClass: false,
            motionDetected: false,
            personDetected: false,
            vehicleDetected: false,
            animalDetected: false
          }
        }
      },
      observedAt: new Date(2026, 2, 25, 14, 12, 45)
    });

    await collector.waitForIdle();

    const targetDir = path.join(datasetDir, 'non_relevant', '2026-03-25', '14');
    const files = await fileTools.readdir(targetDir);
    const imageName = files.find((file) => /\.jpg$/i.test(file));
    const jsonName = files.find((file) => /\.json$/i.test(file));

    assert.match(imageName, /^20260325_141245_b1_nonrel_score0\.012\.jpg$/);
    assert.equal(jsonName, `${imageName}.json`);

    const metadata = await fileTools.readJson(path.join(targetDir, jsonName));
    assert.equal(metadata.type, 'non_relevant');
    assert.equal(metadata.eventState, 'IDLE');
    assert.equal(metadata.motionScore, 0.012);
    assert.equal(metadata.cameraSignal.active, false);
  } finally {
    await fileTools.remove(tempDir);
  }
});

async function countJpegs(dir) {
  try {
    const files = await fileTools.readdir(dir);
    return files.filter((file) => /\.jpe?g$/i.test(file)).length;
  } catch (_) {
    return 0;
  }
}
