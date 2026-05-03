# SnapShotter

`SnapShotter` is the Node runtime for motion evaluation and WhatsApp delivery.
It consumes images produced by the Java ingest service.

## Runtime Flow

1. Java writes frame files into `./images/received/` and optional sidecar JSON metadata.
2. SnapShotter evaluates motion for each frame.
3. Accepted frames are delivered to WhatsApp and moved to `./images/sent/`.
4. Rejected frames are moved to `./images/filtered/`.
5. Runtime health and decision telemetry are written to `./.state/`.

## Requirements

- Node.js 20+
- npm

Install dependencies:

```bash
npm ci
```

## Start

```bash
node src/SnapShotter.js
```

## Tests

```bash
npm test
```

## Configuration

Main config file:

- `src/config.js`

Most relevant sections:

- `imageFilter.nativeSignal.*`
- `imageFilter.delta.*`
- `imageFilter.brightnessGuard.*`
- `imageFilter.event.*`
- `runtime.*`
- `whatsapp.*`
- `logging.*`

## Operational Files

- Health: `./.state/runtime-health.json`
- Decisions: `./.state/decisions.ndjson`
- Notifications: `./.state/notifications.ndjson`
- Logs: `./logs/`

## Security Notes

Do not commit runtime/auth artifacts:

- `.wwebjs_auth/`
- `.state/`
- `images/`
- `logs/`
