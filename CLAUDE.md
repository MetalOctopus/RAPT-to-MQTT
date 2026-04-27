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
  main.py           # Flask app, all API routes, SSE log streaming
  rapt_service.py   # RaptBridge - RAPT API polling + MQTT pub/sub
  brew_session.py   # Brew lifecycle, smart temp feedback loop (P-controller)
  history.py        # SQLite time-series storage
  config.py         # JSON config with env var overrides
  log_handler.py    # WebLogHandler for SSE + history buffer
  templates/index.html  # Single-page UI (no framework)
  static/app.js     # All frontend JS (charts, brew, navigation)
  static/style.css  # Dark theme CSS
  static/icon.svg   # Beer+wifi favicon
  static/icon.png   # 256x256 Docker/Unraid icon
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
- Push to main directly (no feature branches)
- Temperatures: Celsius first, e.g. "20.0°C (68°F)"
- Specific gravity: whole numbers, e.g. 1025 not 1.0250
- Round all device API values to 1 decimal (RAPT returns e.g. 17.4999904632568)
- MQTT topics: `RAPT/temperatureController`, `RAPT/temperatureController/Command`, `TiltPi`, `RAPT2MQTT/notify`
- All frontend is vanilla JS — no React/Vue/etc
- Chart.js 4 with chartjs-adapter-date-fns for time axes, ECharts 5 for gauges
- paho-mqtt 1.6.x (not 2.x) — uses `mqtt.Client()` not `mqtt.Client(mqtt.CallbackAPIVersion.VERSION1)`
- RAPT API POST format: `requests.post(url, data=payload)` (form-encoded, NOT json=)
- Prefer plain-text explanations over tooltips/info icons
- Status displays should include action plans with countdowns, not just current state

## BEER2MQTT (HACS Integration)
- Lives in `HomeAssistant/custom_components/beer2mqtt/`
- Design decisions documented in `HomeAssistant/HOW_WE_BUILT_IT.md` — READ THIS FIRST
- Thin MQTT client — subscribes to rapt2mqtt/... topics, creates HA entities. Zero business logic.
- Discovery handshake: RAPT2MQTT publishes device manifest to `rapt2mqtt/discovery`, BEER2MQTT creates entities
- Target temp number entity has feedback-aware routing (see `HomeAssistant/HOW_WE_BUILT_IT.md` Decision 4)
- HACS store registration: needs PR to https://github.com/hacs/default (see HOW_WE_BUILT_IT.md)
- The RAPT2MQTT bridge side (publishing discovery/state topics) is NOT YET IMPLEMENTED — see plan file

## Smart Temperature Feedback
P-only cascaded servo control. Do NOT add I or D terms — 5-min sample rate + hardware delays make them oscillation-prone. The P-only approach is deliberate. See `brew_session.py:_feedback_loop()`.

## External Systems
- RAPT API: api.rapt.io (OAuth at id.rapt.io/connect/token)
- TiltPi Node-RED: 192.168.0.94:1880 (ALWAYS backup flows before modifying)
- MQTT broker: configured per-install
- Docker registry: ghcr.io/metaloctopus/rapt-to-mqtt

## Testing
No test suite yet. Verify by running `docker compose up` and checking the web UI at :8099.
