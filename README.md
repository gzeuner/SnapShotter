# SnapShotter

`SnapShotter` watches `./images/received/`, applies deterministic motion filtering, and sends accepted images to WhatsApp.

## Runtime flow

1. Java ingestor writes image + sidecar JSON metadata (`cameraSignal`, prefilter diagnostics).
2. Node detector evaluates each frame:
   - primary: REOLINK native signal from metadata
   - fallback: frame-to-frame grayscale delta in ROI
3. Accepted frames move to `./images/sent/`; skipped frames move to `./images/filtered/`.
4. WhatsApp delivery runs in a separate queue.

## Start

```bash
node src/SnapShotter.js
```

## Tests

```bash
node --test test/*.test.js
```

## Important config (`src/config.js`)

- `imageFilter.nativeSignal.enabled`
- `imageFilter.delta.*`
- `imageFilter.brightnessGuard.*`
- `imageFilter.event.*`
- `runtime.*`

## Operational files

- Health: `./.state/runtime-health.json`
- Decisions: `./.state/decisions.ndjson`
- Notifications: `./.state/notifications.ndjson`
