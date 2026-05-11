<p align="center">
  <img src="app/static/icon.png" alt="RAPT2MQTT" width="128">
</p>

<h1 align="center">RAPT2MQTT</h1>

<p align="center">
  Bridge between Kegland RAPT brewing devices and MQTT for Home Assistant.
  <br>
  Monitor and control your fermentation from anywhere.
</p>

<p align="center">
  <a href="https://ko-fi.com/metaloctopus"><img src="https://ko-fi.com/img/githubbutton_sm.svg" alt="Support on Ko-fi"></a>
</p>

---

## What it does

- Polls the [RAPT API](https://api.rapt.io) for your temperature controllers and publishes readings to MQTT
- Subscribes to MQTT commands so you can set target temperatures from Home Assistant
- **Home Assistant auto-discovery** — toggle one switch, sensors appear in HA automatically (no HACS needed)
- Integrates [Tilt Hydrometers](https://tilthydrometer.com/) via TiltPi for gravity tracking
- Tracks brew sessions with fermentation charts, brew logs, and smart temperature feedback
- **Temperature profiles** — create, save, and apply multi-step fermentation schedules
- **Brew notifications** — all brew events published to MQTT for phone push via HA automations
- Stores completed brews as "Legendary Brews" with stats, ratings, and tasting notes
- Single-page web UI on port 8099 — no app install needed

## Quick start

### Docker (recommended)

```bash
docker run -d \
  --name rapt2mqtt \
  -p 8099:8099 \
  -v /path/to/config:/config \
  --restart unless-stopped \
  ghcr.io/metaloctopus/rapt-to-mqtt:latest
```

Or with Docker Compose:

```yaml
services:
  rapt2mqtt:
    image: ghcr.io/metaloctopus/rapt-to-mqtt:latest
    container_name: rapt2mqtt
    ports:
      - "8099:8099"
    volumes:
      - ./config:/config
    restart: unless-stopped
```

### Unraid

Install from Community Applications or add the container manually:
- **Repository:** `ghcr.io/metaloctopus/rapt-to-mqtt:latest`
- **Port:** 8099
- **Config path:** `/mnt/user/appdata/rapt2mqtt` mapped to `/config`

### Manual

```bash
pip install -r requirements.txt
python -m app.main
```

## Configuration

On first launch, open `http://your-server:8099` and enter:

| Setting | Description |
|---------|-------------|
| **RAPT Email** | Your Kegland RAPT account email |
| **RAPT API Secret** | API secret from your RAPT account |
| **MQTT Host** | Your MQTT broker address |
| **MQTT Port** | Broker port (default: 1883) |
| **MQTT Username/Password** | Broker credentials (if required) |

All settings can also be passed as environment variables: `RAPT_EMAIL`, `RAPT_SECRET`, `MQTT_HOST`, `MQTT_PORT`, `MQTT_USERNAME`, `MQTT_PASSWORD`, `POLL_INTERVAL`, `HA_DISCOVERY_ENABLED`, `HA_DISCOVERY_PREFIX`, `NOTIFICATION_LEVEL`.

## MQTT Topics

| Topic | Direction | Description |
|-------|-----------|-------------|
| `RAPT/temperatureController` | Published | Temperature readings and device state |
| `RAPT/temperatureController/Command` | Subscribed | Set target temperature |
| `TiltPi` | Published | Tilt Hydrometer gravity and temperature |
| `RAPT2MQTT/notify` | Published | Brew event notifications |
| `rapt2mqtt/{device_id}/state` | Published | HA discovery state (retained) |
| `rapt2mqtt/{device_id}/set_target` | Subscribed | HA target temperature command |
| `rapt2mqtt/status` | Published | Bridge availability LWT (online/offline) |

## Home Assistant Integration

### Auto-Discovery (built in)

Enable "Home Assistant Discovery" in RAPT2MQTT's config page (or set `HA_DISCOVERY_ENABLED=true`). Your devices will appear automatically in Home Assistant's MQTT integration — no HACS installation needed.

Entities created per RAPT controller: temperature, target, heating/cooling status, RSSI, and a target temperature slider. Per Tilt hydrometer: temperature, gravity, RSSI.

See the **Home Assistant** page in the RAPT2MQTT web UI for setup instructions, automation YAML for phone notifications, and example template sensors.

### BEER2MQTT (HACS — optional)

A companion HACS integration that adds brew session entities (beer name, current SG, ABV, days fermenting) beyond what native discovery provides. See the [HomeAssistant](HomeAssistant/) directory for details.

## Features

- **Home Assistant Auto-Discovery** — Toggle one switch, all your devices appear as HA entities with availability tracking
- **Brew Sessions** — Track active fermentations with OG, target temp, and real-time charts
- **Temperature Profiles** — Create and save multi-step fermentation schedules, apply to any brew
- **Smart Temperature Feedback** — P-controller that adjusts your RAPT controller based on actual vs target fermentation temperature
- **Brew Notifications** — Every brew event (start, dry hop, cold crash, completion) published to MQTT for phone push
- **Legendary Brews** — Completed brews are archived with stats (OG, FG, ABV, brew time), fermentation charts, ratings, and tasting notes
- **Tilt Hydrometer Support** — Gravity readings via TiltPi integration
- **Gravity Units** — Toggle between Specific Gravity and Plato
- **Authentication** — Optional Brewmaster/Guest roles
- **Live Logs** — SSE-based log streaming in the web UI

## Support

RAPT2MQTT is free and open source. Donations help me buy brewing gear and devices to build and test new integrations — more devices supported means a better tool for everyone. If you'd like to help fund the next integration, buy me a beer:

[![Ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/metaloctopus)

## License

MIT
