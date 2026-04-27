# How We Built the BEER2MQTT Home Assistant Integration

This document explains every design decision, trade-off, and implementation detail for the BEER2MQTT HACS integration. Written so any future developer (or AI) can understand not just what we built, but why.

---

## The Core Question: Do They Even Need This?

RAPT2MQTT is a full-featured brewing bridge with its own web UI. It has dashboards, charts, brew session management, a smart temperature feedback loop, device control, and MQTT notifications. If someone is already running RAPT2MQTT, do they actually need HA entities?

**Answer: Yes, but for visibility — not control.**

People want:
- Beer temp on their HA dashboard next to their other home sensors
- "Hey Google, what's my beer at?" via HA voice assistants
- HA automations triggered by brew state (e.g., turn on ventilation when cooling is active)
- A quick-adjust number entity for target temp without opening the RAPT2MQTT web UI

They DON'T want a second full control surface that duplicates what RAPT2MQTT already does.

---

## Decision 1: HACS Integration vs. MQTT Auto-Discovery vs. Both

### What MQTT Auto-Discovery Is
The RAPT2MQTT Docker container could publish JSON config messages to `homeassistant/sensor/...` topics. HA's built-in MQTT integration would auto-create sensor entities. No custom integration needed.

**Pros:** Zero-install, no code in HA, industry standard.
**Cons:** Limited to basic entity types, no custom services, no device registry control, can't do dynamic brew session entities cleanly, no config flow.

### What a HACS Integration Is
A Python package installed in HA via HACS. It runs inside HA, subscribes to MQTT topics, and creates rich entities with full control over device registry, entity lifecycle, and services.

**Pros:** Full control over entities, device grouping, dynamic lifecycle (brew sessions), config flow, custom services.
**Cons:** Maintenance burden, must track HA API changes, Python code quality matters.

### What We Chose: Both
1. **MQTT Auto-Discovery** — built into RAPT2MQTT for users who just want basic sensors without installing anything extra.
2. **HACS Integration (BEER2MQTT)** — for users who want the full HA experience with device grouping, dynamic brew entities, and the smart target routing.

The HACS integration takes priority. If both are enabled, BEER2MQTT wins because it creates entities with the same unique_ids that MQTT discovery would use, and HA deduplicates by unique_id.

---

## Decision 2: Architecture — Thin Client, Not a Second Brain

We had three options for what the HACS integration does:

**Option A: Talk directly to the RAPT API from HA.**
This would bypass RAPT2MQTT entirely. HA would poll the RAPT cloud, receive TILT data, run the feedback loop — everything.

Rejected because: It duplicates everything RAPT2MQTT does. Two things polling the same cloud API is wasteful and risks rate limiting. The feedback loop would need to be reimplemented in Python inside HA. TILT BLE would need a separate HA integration. This is just building RAPT2MQTT again inside HA.

**Option B: Talk to RAPT2MQTT's REST API.**
The Flask app has REST endpoints. HA could poll them.

Rejected because: Polling is wasteful when we already have MQTT push. REST doesn't give us real-time updates. Would need to discover the RAPT2MQTT host/port somehow.

**Option C: Subscribe to RAPT2MQTT's MQTT topics.**
RAPT2MQTT already publishes device state to MQTT. The HACS integration just subscribes and creates entities.

Chosen because: Zero additional network traffic (MQTT is already flowing). Real-time updates. No host discovery needed (HA already knows the MQTT broker). Matches how every other MQTT-based integration works (Zigbee2MQTT, Tasmota).

### The Thin Client Pattern

BEER2MQTT contains ZERO business logic. It doesn't:
- Talk to the RAPT cloud API
- Calculate ABV or SG trends
- Run any control loops
- Make any decisions about heating or cooling

It ONLY:
- Subscribes to MQTT topics
- Parses JSON payloads
- Creates/updates HA entities
- Publishes target temperature commands back to MQTT

All intelligence lives in the RAPT2MQTT Docker container. BEER2MQTT is a display layer.

---

## Decision 3: The Discovery Handshake

### Problem
HA doesn't know what devices RAPT2MQTT has. Controllers and TILTs are discovered at RAPT2MQTT runtime. Brew sessions come and go. How does BEER2MQTT know what entities to create?

### Solution: Discovery Topic
RAPT2MQTT publishes a JSON manifest to `rapt2mqtt/discovery` every time:
- The bridge starts
- A new device is detected
- A brew session starts or ends
- HA discovery is toggled on

The manifest looks like:
```json
{
  "devices": [
    {
      "id": "a1b2c3d4-e5f6-...",
      "type": "controller",
      "name": "Fermenter",
      "state_topic": "rapt2mqtt/a1b2c3d4-e5f6-.../state"
    },
    {
      "id": "tilt_blue",
      "type": "tilt",
      "name": "TILT BLUE",
      "color": "Blue",
      "state_topic": "rapt2mqtt/tilt_blue/state"
    }
  ]
}
```

When BEER2MQTT receives this, it:
1. Registers each device in HA's device registry
2. Fires a `beer2mqtt_discovery` event
3. Each platform (sensor, binary_sensor, number) listens for this event and creates entities

### Why Not Use HA's Built-in MQTT Discovery?
HA has a mechanism where publishing to `homeassistant/sensor/.../config` auto-creates entities. We use a custom discovery topic instead because:
- We need coordinated creation of multiple entity types per device
- Brew session entities need dynamic lifecycle (create on start, remove on complete)
- The discovery manifest gives us a single source of truth for all devices
- We avoid race conditions where some entities exist before others

---

## Decision 4: The Target Temperature Control Entity

### The Problem
The smart feedback loop in RAPT2MQTT adjusts the fridge target every 5 minutes based on beer temp error. If HA has a number entity that sets the fridge target, it would fight the feedback loop — HA sets 4°C, feedback loop changes it to 3.2°C, HA shows stale value, user gets confused.

### The Solution: Feedback-Aware Routing
The number entity publishes to `rapt2mqtt/{device_id}/set_target`. The RAPT2MQTT bridge receives this and checks:

1. **Is there an active brew session for this controller with feedback enabled?**
   - YES → Update `session["target_beer_temp"]`. The next feedback cycle will recalculate the fridge target.
   - NO → Call `set_target_temperature()` directly to set the fridge target via RAPT API.

From the HA user's perspective:
- Without a brew: "Set the fridge to 4°C" → works as expected.
- With smart feedback: "Hold my beer at 17.5°C" → the loop does the math.

The number entity always means "desired temperature". The context determines what that means.

### Why Only One Control Entity
We considered adding:
- Mode selector (heat/cool/off) → Rejected. The RAPT controller auto-switches based on hysteresis. Manual mode override would fight the firmware.
- PID tuning numbers → Rejected. Dangerous — wrong values can cause compressor short-cycling.
- Brew session controls → Rejected. Starting/stopping brews from HA is too complex for a number entity. Use the RAPT2MQTT web UI.

One target temp number covers the 90% use case: quick adjustment from a phone.

---

## Decision 5: LWT and Availability

### The Problem
When RAPT2MQTT goes offline (Docker restart, crash, network issue), HA entities should show "unavailable" instead of stale values.

### The Solution: MQTT Last Will and Testament
RAPT2MQTT sets a LWT on connect:
```python
self._mqtt_client.will_set("rapt2mqtt/status", "offline", retain=True)
```

And publishes "online" immediately after connecting:
```python
self._mqtt_client.publish("rapt2mqtt/status", "online", retain=True)
```

Every BEER2MQTT entity subscribes to `rapt2mqtt/status` and sets `self._attr_available` based on the payload. When the bridge crashes, the MQTT broker automatically publishes the LWT "offline" message, and all entities go unavailable.

---

## Decision 6: Naming — BEER2MQTT, Not RAPT2MQTT

The HACS integration is called BEER2MQTT, not RAPT2MQTT. Why?

- **RAPT2MQTT** is the Docker bridge that talks to Kegland's RAPT API. It's branded around the specific hardware vendor.
- **BEER2MQTT** is the HA integration that surfaces brewing data. It's branded around what the user cares about: beer.
- If we add support for non-RAPT devices in the future (iSpindel, Plaato, Grainfather), BEER2MQTT still makes sense. RAPT2MQTT would be confusing.
- In HACS, users search for what they want to do ("beer", "brewing", "fermentation"), not the specific protocol bridge.

---

## File Structure

```
HomeAssistant/
  hacs.json                              # HACS store metadata
  README.md                              # User-facing integration docs
  HOW_WE_BUILT_IT.md                     # This file — design decisions
  custom_components/
    beer2mqtt/
      __init__.py                        # Integration setup, MQTT subscriptions, discovery
      config_flow.py                     # Zero-config flow (just confirm and go)
      const.py                           # All constants, sensor definitions, topic strings
      manifest.json                      # HA integration manifest
      strings.json                       # Config flow UI strings
      translations/
        en.json                          # English translations
      sensor.py                          # Sensor entities (temp, SG, mode, RSSI, brew data)
      binary_sensor.py                   # Binary sensors (connection, feedback active)
      number.py                          # Target temperature control entity
```

---

## MQTT Topic Contract

This is the contract between RAPT2MQTT (publisher) and BEER2MQTT (subscriber):

| Topic | Direction | Payload | Retained | Purpose |
|-------|-----------|---------|----------|---------|
| `rapt2mqtt/status` | Bridge → HA | `"online"` or `"offline"` | Yes (LWT) | Availability |
| `rapt2mqtt/discovery` | Bridge → HA | JSON device manifest | Yes | Device/entity creation |
| `rapt2mqtt/{id}/state` | Bridge → HA | JSON controller state | Yes | Sensor updates |
| `rapt2mqtt/tilt_{color}/state` | Bridge → HA | JSON TILT state | Yes | Sensor updates |
| `rapt2mqtt/brew/{sid}/state` | Bridge → HA | JSON brew state | Yes | Brew sensor updates |
| `rapt2mqtt/{id}/set_target` | HA → Bridge | Temperature as string | No | Control command |

Empty payload on a state topic = remove the device (brew completed/cancelled).

---

## What Still Needs Building in RAPT2MQTT

The HACS integration is the consumer side. The producer side (RAPT2MQTT Docker container) needs these changes to publish the topics BEER2MQTT subscribes to:

1. **Discovery topic publishing** — `_publish_ha_discovery()` in rapt_service.py
2. **Per-device state topics** — `_publish_ha_state()` alongside existing MQTT publish
3. **LWT setup** — `will_set()` before MQTT connect
4. **set_target subscription** — Subscribe to `rapt2mqtt/+/set_target` and route commands
5. **Brew state publishing** — Publish brew session state on start/update/complete
6. **TILT per-colour device IDs** — Fix the bug where all TILTs share one device_id

These are tracked in the plan file at `~/.claude/plans/elegant-wishing-harp.md`.

---

## How to Register on HACS Store

To appear in the default HACS store (so users can find BEER2MQTT without adding a custom repository):

1. Ensure the repo has `hacs.json` in the root (we have it in `HomeAssistant/hacs.json` — may need to be at repo root)
2. Submit a PR to https://github.com/hacs/default adding our repo to the `integration` list
3. The PR must pass automated validation:
   - Valid `manifest.json` with all required fields
   - Valid `hacs.json`
   - At least one release/tag on the repo
   - Repository must be public
4. HACS maintainers review and merge

For now, users can add it as a custom repository in HACS by entering the GitHub URL.

---

## Testing Checklist

- [ ] Install BEER2MQTT in HA via HACS custom repository
- [ ] Add the integration (Settings → Integrations → Add → BEER2MQTT)
- [ ] Verify "RAPT2MQTT Bridge" appears in device registry
- [ ] Enable HA discovery in RAPT2MQTT config
- [ ] Verify controller device appears with all sensors (temp, target, mode, RSSI, connection)
- [ ] Verify TILT device appears with sensors (beer temp, SG, RSSI)
- [ ] Start a brew session → verify brew entities appear
- [ ] Complete a brew → verify brew entities disappear
- [ ] Change target via HA number entity (no feedback) → verify controller changes
- [ ] Change target via HA number entity (with feedback) → verify brew target changes
- [ ] Stop RAPT2MQTT Docker → verify all entities show "unavailable"
- [ ] Restart RAPT2MQTT → verify entities recover
- [ ] Disable HA discovery in RAPT2MQTT → verify entities become stale (no updates)
