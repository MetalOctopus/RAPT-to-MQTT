# BEER2MQTT — Home Assistant Integration for RAPT2MQTT

## What This Is

BEER2MQTT is a HACS custom integration that connects Home Assistant to the [RAPT2MQTT](https://github.com/MetalOctopus/RAPT-to-MQTT) brewing bridge. It auto-discovers your brewing devices (RAPT controllers, TILT hydrometers, active brew sessions) and creates native HA entities from them.

## Architecture

```
┌──────────────────────┐     ┌──────────────────────┐
│   RAPT Controller    │     │   TILT Hydrometer     │
│   (WiFi → Cloud)     │     │   (BLE → TiltPi)      │
└──────────┬───────────┘     └──────────┬────────────┘
           │                            │
           │   RAPT Cloud API           │   MQTT (TiltPi topic)
           │                            │
     ┌─────▼────────────────────────────▼─────┐
     │          RAPT2MQTT (Docker)             │
     │                                         │
     │  • Polls RAPT API every 5 min           │
     │  • Receives TILT data via MQTT          │
     │  • Runs smart temperature feedback      │
     │  • Manages brew sessions & history      │
     │  • Publishes state to MQTT topics       │
     └────────────────┬────────────────────────┘
                      │
                MQTT Broker
                      │
     ┌────────────────▼────────────────────────┐
     │         BEER2MQTT (this integration)     │
     │                                          │
     │  • Subscribes to rapt2mqtt/... topics    │
     │  • Creates HA sensor entities            │
     │  • Creates number entity for control     │
     │  • Device grouping in HA registry        │
     │  • Availability via LWT                  │
     └────────────────┬────────────────────────┘
                      │
              Home Assistant
```

**Key point:** RAPT2MQTT is the brain. BEER2MQTT is the HA face. All device communication, brew logic, and the smart feedback loop live in the Docker container. This integration is a thin MQTT client that surfaces that data as native HA entities.

## Installation

### Via HACS (Recommended)

1. Open HACS in Home Assistant
2. Click "Integrations"
3. Click the three dots → "Custom repositories"
4. Add `https://github.com/MetalOctopus/RAPT-to-MQTT` as an Integration
5. Search for "BEER2MQTT" and install
6. Restart Home Assistant
7. Go to Settings → Integrations → Add Integration → BEER2MQTT

### Manual

1. Copy the `custom_components/beer2mqtt/` folder to your HA's `custom_components/` directory
2. Restart Home Assistant
3. Go to Settings → Integrations → Add Integration → BEER2MQTT

## Prerequisites

- **RAPT2MQTT** Docker container running and connected to your MQTT broker
- **MQTT integration** enabled in Home Assistant (Settings → Integrations → MQTT)
- **"Enable Home Assistant Discovery"** toggled on in RAPT2MQTT's config page

## What You Get

### Per RAPT Temperature Controller
| Entity | Type | Description |
|--------|------|-------------|
| Fridge Temperature | sensor | Current air temperature in fridge (°C) |
| Fridge Target | sensor | Current controller setpoint (°C) |
| Mode | sensor | "Heating", "Cooling", or "Idle" |
| Signal Strength | sensor | WiFi RSSI (dBm) |
| Connection | binary_sensor | Controller online/offline |
| **Target Temperature** | **number** | **Set the target — see Smart Routing below** |

### Per TILT Hydrometer
| Entity | Type | Description |
|--------|------|-------------|
| Beer Temperature | sensor | In-liquid temperature (°C) |
| Specific Gravity | sensor | Current SG (e.g., 1.045) |
| Signal Strength | sensor | BLE RSSI (dBm) |

### Per Active Brew Session
| Entity | Type | Description |
|--------|------|-------------|
| Beer Name | sensor | Name of the brew |
| Beer Target | sensor | Desired beer temperature (°C) |
| Current SG | sensor | Latest specific gravity reading |
| Estimated ABV | sensor | Calculated from OG and current SG |
| Days Fermenting | sensor | Days since brew started |
| Smart Feedback | binary_sensor | Whether the feedback loop is active |

Brew session entities are **dynamic** — they appear when a brew starts and disappear when it completes or is cancelled.

## Smart Target Routing

The Target Temperature number entity is the one control entity in the integration. When you change it:

- **No active brew or feedback off:** The value goes straight to the RAPT controller as the fridge target. "Set fridge to 4°C."
- **Smart feedback enabled:** The value updates the brew's **beer target temperature**. The feedback loop then calculates and sets the appropriate fridge target. "Hold my beer at 17.5°C."

You don't need to know which mode is active. The RAPT2MQTT bridge handles the routing. From HA, this number always means "desired temperature."

## MQTT Topics

These are the MQTT topics this integration subscribes to. They are all published by the RAPT2MQTT Docker container.

| Topic | Purpose |
|-------|---------|
| `rapt2mqtt/status` | Bridge availability (LWT: "online"/"offline") |
| `rapt2mqtt/discovery` | Device manifest (JSON array of all devices) |
| `rapt2mqtt/{device_id}/state` | Controller state updates (JSON) |
| `rapt2mqtt/tilt_{color}/state` | TILT state updates (JSON) |
| `rapt2mqtt/brew/{session_id}/state` | Brew session state updates (JSON) |
| `rapt2mqtt/{device_id}/set_target` | Command: target temperature (published by HA) |

## Troubleshooting

**No devices appearing:**
- Check that RAPT2MQTT is running (`docker ps`)
- Check that "Enable Home Assistant Discovery" is on in RAPT2MQTT config
- Check that HA's MQTT integration is connected to the same broker

**Entities showing "unavailable":**
- The RAPT2MQTT bridge is offline (check Docker logs)
- The LWT message has set all entities to unavailable

**Target temperature not changing:**
- Check RAPT2MQTT logs for RAPT API errors
- The RAPT controller may have a fermentation profile overriding manual changes
- The feedback loop may be overriding HA changes (this is expected when feedback is active)
