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
  brew_session.py   # Brew lifecycle, smart temp feedback loop
  history.py        # SQLite time-series storage
  config.py         # JSON config with env var overrides
  log_handler.py    # WebLogHandler for SSE + history buffer
  templates/index.html  # Single-page UI (no framework)
  static/app.js     # All frontend JS (charts, brew, navigation)
  static/style.css  # Dark theme CSS
  static/icon.svg   # Beer+wifi favicon
research/           # RAPT API docs, TILT ecosystem research, TiltPi flow analysis
```

## Key Conventions
- Push to main directly (no feature branches)
- Temperatures: Celsius first, e.g. "20.0°C (68°F)"
- Specific gravity: whole numbers, e.g. 1025 not 1.0250
- MQTT topics: `RAPT/temperatureController`, `RAPT/temperatureController/Command`, `TiltPi`
- All frontend is vanilla JS — no React/Vue/etc
- Chart.js 4 with chartjs-adapter-date-fns for time axes
- paho-mqtt 1.6.x (not 2.x) — uses `mqtt.Client()` not `mqtt.Client(mqtt.CallbackAPIVersion.VERSION1)`

## External Systems
- RAPT API: api.rapt.io (OAuth at id.rapt.io/connect/token)
- TiltPi Node-RED: 192.168.0.94:1880 (ALWAYS backup flows before modifying)
- MQTT broker: configured per-install
- Docker registry: ghcr.io/metaloctopus/rapt-to-mqtt

## Testing
No test suite yet. Verify by running `docker compose up` and checking the web UI at :8099.
