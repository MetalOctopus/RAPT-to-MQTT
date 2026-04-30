# TiltPi Node-RED Flow Upgrade Recommendations

Based on reverse-engineering of the TiltPi v2.9.2 flow (267 stock nodes, 517 with user modifications). Full analysis in [tiltpi-flow-analysis.md](tiltpi-flow-analysis.md).

## Stock Flow Reference

The original stock flow from [baronbrew/TILTpi](https://github.com/baronbrew/TILTpi/blob/master/flow.json) is saved as `tiltpi-stock-flow.json` (169KB, 267 nodes). It has **no MQTT output** — stock TiltPi only does BLE scan → dashboard display → Google Sheets cloud logging.

The current modified flow on the user's TiltPi (192.168.0.94) adds "Ian's Tasty MQTT Scrape" — a function node wired to display slot 1 that publishes to the `TiltPi` MQTT topic.

## Current MQTT Output (Ian's Tasty MQTT Scrape)

```javascript
// Wired to display slot 1 only
msg.topic = "TiltPi";
msg.payload = JSON.stringify({
  major: parseFloat(msg.payload.displayTemp || 0),  // temperature
  minor: Math.round((parseFloat(msg.payload.SG) || 0) * 1000)  // SG × 1000
});
return msg;
```

**Problems:**
1. **Slot 1 only** — only the first detected TILT gets published. If you have multiple TILTs (e.g. BLUE and RED), only whichever landed in slot 1 gets MQTT output.
2. **Minimal data** — only temperature and SG×1000. Missing: colour, RSSI, tx_power, calibration state, beer name, units.
3. **No per-colour topic** — everything goes to a single `TiltPi` topic with no way to distinguish which TILT sent the data.

---

## Upgrade 1: Enriched MQTT Payload (DONE in RAPT2MQTT receiver)

RAPT2MQTT already handles the enriched format on the receiving side. The upgraded TiltPi flow should publish:

```json
{
  "color": "BLUE",
  "mac": "AA:BB:CC:DD:EE:FF",
  "temperature": 20.0,
  "temperatureUnit": "C",
  "gravity": 1.045,
  "gravityUnit": "SG",
  "rssi": -67,
  "txPower": -59,
  "isProModel": false,
  "calibrated": true,
  "beerName": "Black IPA",
  "timestamp": 1714000000000
}
```

**Topic:** `TiltPi/{color}` (e.g. `TiltPi/BLUE`) — enables per-colour subscriptions.
**Backward compat:** Also publish to `TiltPi` (flat topic) for existing subscribers.

**Implementation:** Replace the single slot-1 scrape function with a function wired to the Interpolate output (before the Display switch), so it sees ALL colours.

---

## Upgrade 2: Multi-TILT MQTT Support

**Problem:** The stock MQTT scrape taps display slot 1. Display slots are assigned in detection order — if RED is detected first, it gets slot 1. BLUE gets slot 2. Only slot 1 publishes via MQTT.

**Fix:** Wire the enriched MQTT function to the pipeline BEFORE the display slot assignment (after the `Interpolate` function node). This point in the pipeline has the full data object for every TILT colour, every scan cycle.

**Alternative approach:** Wire MQTT publish to ALL 25 display template outputs (not just slot 1). This is messier but preserves the existing flow structure.

**Recommended approach:** Tap after Interpolate. One function, all colours, clean.

---

## Upgrade 3: tx_power / Battery Forwarding

**Problem:** The TILT broadcasts a `tx_power` byte in the iBeacon advertisement. For standard TILTs this is a fixed value, but for TILT Pro models it may carry battery/firmware information. The stock flow reads it but never publishes it externally.

**Fix:** Include `tx_power` in the enriched MQTT payload. RAPT2MQTT can display it and track trends. Even if the meaning is ambiguous now, having the data recorded means we can interpret it later if TILT documents it.

---

## Upgrade 4: Nuclear Disconnect Fix

**Problem:** When any single TILT goes stale (no BLE broadcast for 2 minutes), the `check` function clears ALL 25 display storage slots. This causes every active TILT to briefly flash as disconnected before being re-detected on the next scan cycle.

**Code (repeated 25 times):**
```javascript
// In each check function (nodes 13-84):
if (msg.payload === undefined) { /* hide this slot */ }
var displayTimeout = flow.get('displayTimeout') || 120000;
// ... if stale, CLEAR ALL SLOTS:
for (var i = 1; i < 26; i++) {
    flow.set("storage-" + i, undefined);
}
```

**Fix:** Only clear the specific slot that went stale:
```javascript
// Instead of clearing all 25:
flow.set("storage-" + slotNumber, undefined);
```

This prevents the cascade where one TILT going out of BLE range causes all others to flicker.

---

## Upgrade 5: Code Deduplication (25 → 1 check function)

**Problem:** The `check` function is copy-pasted 25 times (one per display slot). Each is identical — ~50 lines × 25 = ~1,250 lines of duplicate code. Same for the 25 inject nodes, 25 change nodes, and 25 UI templates that form the display pipeline.

**Fix:** Replace with a single function that iterates over active slots. However, this requires Node-RED subflows (available in v1.0+, not in the stock v0.18.4). For TiltPi v2 on Node-RED v0.18.4, the dedup is limited to reducing the check function body, not eliminating the 25 parallel chains.

**Practical approach:** Focus dedup on the check function body — make it a single reusable function call. The 25 display templates are harder to consolidate without subflows.

**Priority:** Low. This is a maintenance improvement, not a functional one. The other fixes matter more.

---

## Upgrade 6: RSSI Rounding (DONE in RAPT2MQTT receiver)

**Problem:** RSSI values come through as integers from the BLE stack, so no rounding is needed on the TiltPi side. RAPT2MQTT already rounds to 1 decimal on its end.

**Status:** Already handled. No TiltPi flow change needed.

---

## Upgrade 7: Watchdog Improvement

**Problem:** The BLE scanner watchdog (30-second timeout) kills and restarts the entire `aioblescan` Python process when any scan goes silent. This is a blunt instrument — BLE interference or a TILT going out of range triggers a full scanner restart.

**Fix:** Track per-colour staleness separately. Only restart the scanner if ALL known TILTs have gone silent simultaneously (which indicates a BLE adapter issue, not a single TILT moving out of range).

**Priority:** Medium. The current approach works but causes brief gaps in data during restarts.

---

## Upgrade 8: Settings Decoupled from BLE Pipeline

**Problem:** The `Add Parameter` function attaches ~15 settings (logging intervals, RSSI thresholds, smoothing parameters, etc.) to every single BLE scan message. These settings rarely change but are carried through the entire processing pipeline on every message.

**Fix:** Read settings directly from flow context where needed, rather than attaching them to every message. This reduces message size and makes the pipeline cleaner.

**Priority:** Low. Performance impact is minimal on Pi Zero but the code becomes clearer.

---

## Implementation Strategy

### What the Upgraded Flow Changes (vs Stock)

The upgraded flow modifies the stock TiltPi flow.json by adding:

1. **MQTT broker config** — user's broker IP, port, optional credentials
2. **Enriched MQTT function** — wired after Interpolate, publishes to `TiltPi/{color}` and `TiltPi`
3. **Nuclear disconnect fix** — patched check functions to clear only the stale slot
4. **tx_power forwarding** — included in MQTT payload

The upgraded flow does NOT touch:
- BLE scanning pipeline (keep stock `aioblescan` exec)
- Calibration UI (preserve user's existing calibration points)
- Cloud logging (Google Sheets still works if configured)
- Dashboard display (all 8 stock slots preserved, extended slots from v2.9.2 preserved)
- Settings UI (temperature units, smoothing, etc.)

### Deployment via RAPT2MQTT

RAPT2MQTT provides a TiltPi Management page that can:
1. **Discover** TiltPi instances on the local network (mDNS or port scan for 1880)
2. **Backup** the current flow before any changes
3. **Deploy** the upgraded flow via Node-RED HTTP API (`POST /flows`)
4. **Revert** to the stock flow if needed

The Node-RED HTTP API is unauthenticated on stock TiltPi, so no credentials are needed.

---

## Comparison: TiltPi vs TiltPico

| Feature | TiltPi (Pi Zero WH) | TiltPico ($45) |
|---|---|---|
| Hardware cost | ~$17 (Pi Zero WH + SD) | $45 |
| BLE to network | Yes (via Node-RED) | Yes (built-in) |
| MQTT output | Yes (with our upgrade) | No (HTTP only) |
| Extensible | Yes (Node-RED flows) | No (fixed firmware) |
| Dashboard | Yes (Node-RED UI) | Basic HTTP JSON |
| Calibration | Yes (multi-point) | Unknown |
| Multi-TILT | Yes (up to 25 slots) | Yes |
| Home Assistant | Via MQTT → RAPT2MQTT | Requires custom integration |
| Open source | Flow is JSON, fully editable | [GPL-3.0 repo](https://github.com/baronbrew/TiltPico), Arduino/C++ |

**Recommendation:** Pi Zero WH + TiltPi is cheaper, more capable, and fully supported by RAPT2MQTT. TiltPico is a simpler plug-and-play option but lacks MQTT and costs nearly 3× more.
