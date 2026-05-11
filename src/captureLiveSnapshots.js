'use strict';

const fs = require('fs');
const path = require('path');
const fileTools = require('fs-extra');
const { ReolinkSnapshotClient, readJavaProperties } = require('./reolinkSnapshotClient');

const DEFAULT_COUNT = 6;
const DEFAULT_DELAY_MS = 450;
const OUTPUT_DIR = path.resolve(__dirname, '..', '.state', 'live-check');
const PROPERTIES_FILE = path.resolve(__dirname, '..', '..', 'src', 'main', 'resources', 'application.properties');

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const props = readJavaProperties(PROPERTIES_FILE);
  const client = new ReolinkSnapshotClient(props);

  await fileTools.ensureDir(OUTPUT_DIR);

  for (let i = 0; i < options.count; i++) {
    const fileName = `live_${formatNow()}.jpg`;
    const outFile = path.join(OUTPUT_DIR, fileName);
    const metadataFile = outFile.replace(/\.jpg$/i, '.json');

    const snapshot = await client.fetchSnapshot();
    await fs.promises.writeFile(outFile, snapshot.buffer);
    await fs.promises.writeFile(metadataFile, JSON.stringify({
      capturedAt: new Date().toISOString(),
      contentType: snapshot.contentType,
      frame: {
        sha256: snapshot.sha256,
        sizeBytes: snapshot.buffer.length
      },
      cameraSignal: Object.assign({
        active: Object.values(snapshot.cameraSignal || {}).some(Boolean)
      }, snapshot.cameraSignal || {})
    }, null, 2));
    console.log(`[LIVE] ${fileName}`);
    if (i < options.count - 1) {
      await delay(options.delayMs);
    }
  }
}

function parseArgs(args) {
  const options = {
    count: DEFAULT_COUNT,
    delayMs: DEFAULT_DELAY_MS
  };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--count' && args[i + 1]) {
      options.count = Math.max(1, Number(args[++i]) || DEFAULT_COUNT);
    } else if (args[i] === '--delayMs' && args[i + 1]) {
      options.delayMs = Math.max(50, Number(args[++i]) || DEFAULT_DELAY_MS);
    }
  }
  return options;
}

function formatNow() {
  const now = new Date();
  const pad = (value, size = 2) => String(value).padStart(size, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}_${pad(now.getMilliseconds(), 3)}`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
