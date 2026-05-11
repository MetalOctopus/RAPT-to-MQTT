# RAPT2MQTT

Bridge between Kegland RAPT brewing devices and MQTT for Home Assistant.

## Quick Start
```bash
docker compose up        # runs on port 8099
python -m app.main       # or run directly (needs pip install -r requirements.txt)
```

## Project Structure
```
app/
  main.py           # Flask app, all API routes, SSE log streaming, version endpoint
  rapt_service.py   # RaptBridge - RAPT API polling + MQTT pub/sub + device persistence
  ha_discovery.py   # Home Assistant MQTT auto-discovery (config topics, state publishing, LWT)
  brew_session.py   # Brew lifecycle, smart temp feedback loop (P-controller)
  history.py        # SQLite time-series storage + DB migration (SG format), temp_profiles CRUD
  config.py         # JSON config with env var overrides
  log_handler.py    # WebLogHandler for SSE + history buffer
  templates/index.html  # Single-page UI (no framework)
  static/app.js     # All frontend JS (charts, brew, navigation, gravity formatting)
  static/style.css  # Dark theme CSS
  static/icon.svg   # Beer+wifi favicon
  static/icon.png   # 256x256 Docker/Unraid icon (rendered from favicon SVG)
  VERSION           # Auto-generated at Docker build time (commit count × 0.01)
research/           # RAPT API docs, TILT ecosystem research, TiltPi flow analysis
HomeAssistant/
  hacs.json                         # HACS store metadata
  README.md                         # BEER2MQTT user docs
  HOW_WE_BUILT_IT.md                # Verbose design decisions doc
  custom_components/beer2mqtt/      # HACS integration source
    __init__.py                     # Setup, MQTT subs, discovery handler
    config_flow.py                  # Zero-config flow
    const.py                        # Constants, sensor defs, topic strings
    manifest.json                   # HA integration manifest
    sensor.py                       # Sensor entities
    binary_sensor.py                # Binary sensor entities
    number.py                       # Target temp control entity
    strings.json + translations/    # Config flow UI strings
```

## Key Conventions
- Branching: dev for development, merge to main for releases. Push to main triggers Docker build via GitHub Actions.
- Temperatures: Celsius first, e.g. "20.0°C (68°F)"
- Specific gravity: decimal format, e.g. 1.025 not 1025. Use `fmtG()` helper in JS. Supports SG/Plato toggle via config (`gravity_unit`).
- Round all device API values to 1 decimal (RAPT returns e.g. 17.4999904632568)
- MQTT topics: `RAPT/temperatureController`, `RAPT/temperatureController/Command`, `TiltPi`, `RAPT2MQTT/notify`, `rapt2mqtt/{device_id}/state`, `rapt2mqtt/{device_id}/set_target`, `rapt2mqtt/status`
- All frontend is vanilla JS — no React/Vue/etc
- Chart.js 4 with chartjs-adapter-date-fns for time axes, ECharts 5 for gauges
- Chart X-axis: Grafana-style — date on day boundaries (major ticks, bold), time between (minor ticks)
- paho-mqtt 1.6.x (not 2.x) — uses `mqtt.Client()` not `mqtt.Client(mqtt.CallbackAPIVersion.VERSION1)`
- RAPT API POST format: `requests.post(url, data=payload)` (form-encoded, NOT json=)
- Prefer plain-text explanations over tooltips/info icons
- Status displays should include action plans with countdowns, not just current state
- Data retention: forever. No pruning. Don't add cleanup or retention limits.
- Device types: "RAPT Temperature Controller" and "Tilt Hydrometer" — full names, different ecosystems
- Device identity: stable IDs (RAPT UUID, tilt-{color}). Nicknames are display-only, never used as keys.
- Version: total commits × 0.01, baked into Docker image via BUILD_VERSION arg

## Home Assistant Integration
Two integration paths — both work, use either or both:

### Native MQTT Auto-Discovery (built into RAPT2MQTT)
- Toggle `ha_discovery_enabled` in config (or env `HA_DISCOVERY_ENABLED=true`)
- Publishes HA discovery configs to `homeassistant/{component}/{node_id}/{object_id}/config` (retained)
- Sensors appear automatically in HA's MQTT integration — no HACS needed
- Entities: temperature, target, heating/cooling binary sensors, RSSI, set_target number (controllers); temperature, gravity, RSSI (Tilt)
- LWT availability on `rapt2mqtt/status`, state on `rapt2mqtt/{device_id}/state`
- Device removal publishes empty retained payloads to clean up HA entities
- Nickname changes re-publish discovery (entity IDs stay stable, only friendly name updates)
- Module: `app/ha_discovery.py`, integrated via `rapt_service.py`

### BEER2MQTT (HACS Integration)
- Lives in `HomeAssistant/custom_components/beer2mqtt/`
- Design decisions documented in `HomeAssistant/HOW_WE_BUILT_IT.md` — READ THIS FIRST
- Thin MQTT client — subscribes to rapt2mqtt/... topics, creates HA entities. Zero business logic.
- Adds brew session entities (beer name, current SG, estimated ABV, days fermenting) beyond what native discovery provides
- Target temp number entity has feedback-aware routing (see `HomeAssistant/HOW_WE_BUILT_IT.md` Decision 4)
- HACS store registration: needs PR to https://github.com/hacs/default (see HOW_WE_BUILT_IT.md)

## Brew Notifications
- All brew events publish to `RAPT2MQTT/notify` with `{title, message, icon, timestamp}`
- Events: brew start/complete/cancel, dry hop, cold crash, clarifier, yeast, profile step advance, reminders
- `notification_level` config: "all" (every event), "important" (lifecycle + reminders only), "off"
- Lifecycle events (start, complete, cancel, profile step, reminder) are flagged `important=True`

## Temperature Profiles
- Standalone profile library with CRUD: `temp_profiles` table in SQLite
- Chart.js stepped line chart (`stepped: "before"`) — replaced the old broken SVG drag editor
- Profiles are templates: applying to a brew copies steps (not a reference)
- API: `GET/POST /api/profiles`, `GET/PUT/DELETE /api/profiles/<id>`, `POST /api/brews/<id>/apply-profile`

## Smart Temperature Feedback
P-only cascaded servo control. Do NOT add I or D terms — 5-min sample rate + hardware delays make them oscillation-prone. The P-only approach is deliberate. See `brew_session.py:_feedback_loop()`.

## External Systems
- RAPT API: api.rapt.io (OAuth at id.rapt.io/connect/token)
- TiltPi Node-RED: 192.168.0.94:1880 (ALWAYS backup flows before modifying)
- MQTT broker: configured per-install
- Docker registry: ghcr.io/metaloctopus/rapt-to-mqtt
- Unraid server: 192.168.0.250 (reachable from dev machine, can curl/ping)

## Repo Visibility
This is a PUBLIC repo. Anyone can see the code. Keep this in mind when committing.
- Ko-fi donations: ko-fi.com/metaloctopus (configured in .github/FUNDING.yml)
- GHCR images are public (no auth needed to pull)

## FG Auto-Detection
`detect_fg()` in brew_session.py finds stabilized FG from Tilt hydrometer history. Filters to valid SG range (0.990-1.160) to exclude noise from removed hydrometers. Uses median of last 24h if 5+ readings, otherwise median of bottom 10%. API: `GET /api/brews/<id>/suggest-fg`. FG/OG editable on Legendary Brews via the notes endpoint with ABV recalculation.

## Tilt iBeacon Handling
TiltPi publishes two messages per reading: enriched on `TiltPi/{Color}` and backward-compat iBeacon on flat `TiltPi`. Guard in rapt_service.py prevents phantom `tilt-unknown` devices via UUID-based color extraction and startup cleanup.

## Testing
No test suite yet. Verify by running `docker compose up` and checking the web UI at :8099.
The running instance is accessible at http://192.168.0.250:8099/ — use curl for API checks.
Can build locally: `docker build --build-arg BUILD_VERSION=0.XX -t rapt2mqtt:test .` and test on port 8199.
