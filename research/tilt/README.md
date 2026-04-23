# TILT Hydrometer Integration

This document covers how RAPT2MQTT integrates with the TILT hydrometer, a free-floating wireless brewing sensor manufactured by Baron Brew Equipment.

---

## What Is the TILT Hydrometer?

The TILT is a cylindrical digital hydrometer and thermometer that floats inside a fermenter. It contains an accelerometer that measures tilt angle (which correlates with liquid density / specific gravity) and a temperature sensor. The device broadcasts these readings over **Bluetooth Low Energy (BLE)** using Apple's **iBeacon** protocol.

Key specifications:

| | Standard TILT | TILT Pro |
|---|---|---|
| **SG Range** | 0.990 - 1.120 (resolution 0.001) | 0.9900 - 1.1200 (resolution 0.0001) |
| **Temp Range** | 0 - 140 F (resolution 1 F) | 0 - 140 F (resolution 0.1 F) |
| **Battery** | CR123A lithium (12-24 months) | 2x AA lithium |
| **Connectivity** | BLE only | BLE only |

**The TILT has no WiFi.** It only speaks BLE, which means a bridge device within Bluetooth range is always required to relay its data to the network.

---

## The 8 Colors and UUID Mapping

Each TILT is manufactured in one of 8 colors. The color determines the iBeacon UUID, which is the sole mechanism for device identification. You cannot use two TILTs of the same color simultaneously.

The UUID follows the pattern `A495BBn0-C5B1-4B44-B512-1370F02D74DE` where `n` identifies the color:

| Color | UUID | Hex Byte |
|---|---|---|
| **Red** | `A495BB10-C5B1-4B44-B512-1370F02D74DE` | 0x10 |
| **Green** | `A495BB20-C5B1-4B44-B512-1370F02D74DE` | 0x20 |
| **Black** | `A495BB30-C5B1-4B44-B512-1370F02D74DE` | 0x30 |
| **Purple** | `A495BB40-C5B1-4B44-B512-1370F02D74DE` | 0x40 |
| **Orange** | `A495BB50-C5B1-4B44-B512-1370F02D74DE` | 0x50 |
| **Blue** | `A495BB60-C5B1-4B44-B512-1370F02D74DE` | 0x60 |
| **Yellow** | `A495BB70-C5B1-4B44-B512-1370F02D74DE` | 0x70 |
| **Pink** | `A495BB80-C5B1-4B44-B512-1370F02D74DE` | 0x80 |

The iBeacon packet encodes sensor data as:
- **Major** (2 bytes): Temperature in degrees Fahrenheit
- **Minor** (2 bytes): Specific Gravity x 1000 (or x 10000 for TILT Pro)
- **TX Power** (1 byte): Battery/power byte (firmware-dependent)

TILT Pro detection: if minor > 2000, the device is a Pro and the divisor changes from 1000 to 10000 for gravity, and temperature gains a decimal point.

---

## How We Integrate the TILT

RAPT2MQTT does **not** scan BLE directly. Instead, it subscribes to an MQTT topic published by a separate BLE bridge running on a Raspberry Pi (TiltPi).

### Data Flow

```
TILT Hydrometer (BLE iBeacon broadcast)
    |
    v
TiltPi (Raspberry Pi at 192.168.0.94)
    - Runs aioblescan to receive BLE
    - Node-RED processes and enriches the data
    - "Ian's Tasty MQTT Scrape" function publishes to MQTT
    |
    v
MQTT Broker (192.168.0.252:1883)
    - Topic: "TiltPi"
    |
    v
RAPT2MQTT (subscribes to "TiltPi" topic)
    - _handle_tilt_message() in app/rapt_service.py
    - Parses JSON, creates device entry
    - Displays alongside RAPT Temperature Controller data
```

### Subscription

In `app/rapt_service.py`, the `RaptBridge` class subscribes to the `TiltPi` topic on connect:

```python
TILT_TOPIC = "TiltPi"

def _on_connect(self, client, userdata, flags, rc):
    client.subscribe(self.TILT_TOPIC)
```

### Payload Parsing

The `_handle_tilt_message()` method supports **two formats** for backwards compatibility:

1. **New enriched format** (preferred): detected by the presence of an `"sg"` key
2. **Old format**: `{"major": <temp_f>, "minor": <sg_x_1000>}` -- the original minimal format

---

## TiltPi Node-RED Setup

The TiltPi is a Raspberry Pi running Node-RED v0.18.4 with the official TiltPi flows (v2.9.2 from baronbrew/TILTpi).

- **IP Address:** 192.168.0.94
- **Node-RED Editor:** http://192.168.0.94:1880
- **Dashboard UI:** http://192.168.0.94:1880/ui
- **BLE Scanner:** `sudo python3 -u -m aioblescan -T` (runs as exec node)

### The Data Pipeline (Simplified)

```
aioblescan (BLE scan) --> JSON parse --> RSSI filter --> UUID switch
    --> Color mapping --> Add Parameter (enrichment) --> Smooth (EMA)
    --> Interpolate (calibration) --> Display switch (25 slots)
    --> UI Template "1" --> "Ian's Tasty MQTT Scrape" --> RBE --> MQTT Out
```

The flow has 517 nodes total, 105 of which are function nodes. It supports up to 25 simultaneous TILTs (via MAC-based identification), multi-point calibration, EMA smoothing, Google Sheets logging, local CSV logging, and range boosting from other TiltPis on the network.

### Ian's Tasty MQTT Scrape (Custom Function)

This is the custom Node-RED function node that bridges TiltPi data to MQTT. It is wired after UI Template "1" (display slot 1), through an RBE (Report By Exception) filter, to an MQTT output node.

**Enriched version (current):**

```javascript
msg.topic = "TiltPi";
msg.payload = JSON.stringify({
    color: msg.payload.Color,
    beer: msg.payload.Beer[0],
    temperature: parseFloat(msg.payload.displayTemp || 0),
    temperature_raw: msg.payload.Temp,
    sg: msg.payload.SG,
    rssi: Math.round(msg.payload.rssi / 5) * 5,
    mac: msg.payload.mac,
    uuid: msg.payload.uuid
});
return msg;
```

Note: RSSI is rounded to the nearest 5 to reduce jitter in the RBE (Report By Exception) filter. Without this, small RSSI fluctuations would cause messages to pass through RBE even when temperature and gravity have not changed.

**Original version (for reference):**

```javascript
msg.topic = "TiltPi";
msg.payload = JSON.stringify({
    major: parseFloat(msg.payload.displayTemp || 0),
    minor: Math.round((parseFloat(msg.payload.SG) || 0) * 1000)
});
return msg;
```

### MQTT Broker Configuration

```
Name:    HASS
Broker:  192.168.0.252
Port:    1883
TLS:     No
Auth:    No
QoS:     0
```

---

## Enriched Payload Format

The enriched payload sent by "Ian's Tasty MQTT Scrape" to the `TiltPi` topic:

```json
{
    "color": "BLUE",
    "beer": "My Pale Ale",
    "temperature": 20.0,
    "temperature_raw": 68,
    "sg": 1.045,
    "rssi": -65,
    "mac": "e7:57:bd:bf:29:c9",
    "uuid": "a495bb60c5b14b44b5121370f02d74de"
}
```

| Field | Type | Description |
|---|---|---|
| `color` | string | TILT color name (RED, GREEN, BLACK, PURPLE, ORANGE, BLUE, YELLOW, PINK) |
| `beer` | string | User-assigned beer name from TiltPi dashboard (or "Untitled") |
| `temperature` | float | Calibrated display temperature (in user's chosen units, F or C) |
| `temperature_raw` | float | Raw temperature in Fahrenheit before unit conversion |
| `sg` | float | Calibrated specific gravity (e.g. 1.045) |
| `rssi` | int | BLE signal strength in dBm, rounded to nearest 5 |
| `mac` | string | BLE MAC address of the TILT device |
| `uuid` | string | iBeacon UUID (identifies the TILT color) |

This format is backwards-compatible: RAPT2MQTT detects the enriched format by checking for the `"sg"` key. If absent, it falls back to parsing the old `{major, minor}` format.

---

## Setting Up TiltPi MQTT from Scratch

### Prerequisites

- A TiltPi running on a Raspberry Pi (SD card image from tilthydrometer.com, or manual install)
- The TiltPi must be on the same network as your MQTT broker
- Your TILT hydrometer must be within BLE range of the TiltPi (~30 feet typical, further with range boosters)

### Step-by-Step

1. **Verify TiltPi is running.** Open `http://<tiltpi-ip>:1880/ui` in a browser. You should see the TiltPi dashboard with your TILT color displayed.

2. **Open the Node-RED editor.** Navigate to `http://<tiltpi-ip>:1880` (no `/ui`).

3. **Locate the MQTT output chain.** In the "Main" flow tab, find:
   - The UI Template node labeled "1" (display slot 1)
   - "Ian's Tasty MQTT Scrape" function node
   - An RBE (Report By Exception) node
   - An MQTT Out node

   If these nodes do not exist, you need to create them (see step 5).

4. **Configure the MQTT broker.** Double-click the MQTT Out node, then click the pencil icon next to the Server field:
   - **Server:** Your MQTT broker IP (e.g. `192.168.0.252`)
   - **Port:** `1883` (or your broker's port)
   - **Client ID:** Leave blank (auto-generated)
   - **Username/Password:** If your broker requires authentication, enter credentials here
   - Click Update, then Done.

5. **Create the function chain (if it does not exist).**

   a. Drag a **function** node onto the canvas. Name it "Ian's Tasty MQTT Scrape". Paste the enriched function code (see above). Set outputs to 1.

   b. Drag an **rbe** node onto the canvas. Leave default settings (mode: "block unless value changes").

   c. Drag an **mqtt out** node onto the canvas. Set Topic to `TiltPi`. Configure the broker as described in step 4.

   d. Wire them in order: UI Template "1" output --> Function --> RBE --> MQTT Out.

6. **Deploy.** Click the Deploy button in Node-RED. The TiltPi will start publishing TILT data to your MQTT broker on the `TiltPi` topic.

7. **Configure RAPT2MQTT.** In the RAPT2MQTT web UI (port 8099), ensure the MQTT broker host matches the one configured in TiltPi. RAPT2MQTT subscribes to `TiltPi` automatically on startup.

8. **Verify.** Use an MQTT client (e.g. MQTT Explorer, mosquitto_sub) to confirm messages are arriving on the `TiltPi` topic:
   ```
   mosquitto_sub -h 192.168.0.252 -t TiltPi
   ```

### Backing Up TiltPi Flows

Before making any changes, always back up the TiltPi flows:

```
curl -s http://<tiltpi-ip>:1880/flows | python3 -m json.tool > tiltpi-flows-backup.json
```

Backups of the current TiltPi flows are stored in this directory:
- `tiltpi-flows-backup-20260423-225350.json`
- `tiltpi-flows-backup-live-20260423-225358.json`
- `tiltpi-flows-raw.json`

---

## Alternative BLE-to-MQTT Bridges

If you do not have a TiltPi, or prefer a different approach, these alternatives can publish TILT data to MQTT. RAPT2MQTT would need minor modifications to parse their payload formats.

### TiltBridge (ESP32) -- Recommended Alternative

- **Hardware:** ESP32 board (~$10)
- **GitHub:** [thorrak/tiltbridge](https://github.com/thorrak/tiltbridge)
- **MQTT Topic:** `tiltbridge/tilt_<Color>` (e.g. `tiltbridge/tilt_Blue`)
- **Payload:** `{"color", "temp", "tempUnit", "gravity", "weeks_on_battery", "high_resolution", "fwVersion", "rssi"}`
- **Supports Home Assistant MQTT auto-discovery**
- **Pros:** Cheap, dedicated, always-on, no Pi needed, battery tracking
- **Cons:** Requires flashing firmware

### tilt2mqtt (Python)

- **GitHub:** [LinuxChristian/tilt2mqtt](https://github.com/LinuxChristian/tilt2mqtt)
- **MQTT Topic:** `tilt/<Color>` (e.g. `tilt/Blue`)
- **Payload:** `{"temperature_celsius_uncali", "specific_gravity_uncali"}`
- **Pros:** Simplest possible MQTT bridge
- **Cons:** Uncalibrated values only, minimal metadata

### Pitch (Webhooks, Not MQTT)

- **GitHub:** [linjmeyer/tilt-pitch](https://github.com/linjmeyer/tilt-pitch)
- **No native MQTT.** Uses HTTP webhooks that can be forwarded to MQTT via Home Assistant automation.
- **Payload:** `{"name", "color", "temp_fahrenheit", "temp_celsius", "gravity", "alcohol_by_volume", "apparent_attenuation"}`

### OpenMQTTGateway / Theengs (ESP32)

- **GitHub:** [theengs/OpenMQTTGateway](https://github.com/theengs/OpenMQTTGateway)
- **Generic BLE-to-MQTT gateway** supporting 120+ device types including TILT
- **MQTT Topic:** `home/<gateway_name>/BTtoMQTT/<device_mac>`

### Home Assistant tilt_ble (No MQTT)

- **Built-in HA integration** (since HA 2022.10)
- **Uses BLE directly** -- no MQTT involved, creates native HA entities
- **Requires HA server or ESPHome BLE proxy within BLE range**

---

## Known Limitations

1. **Only wired to TILT slot 1.** The MQTT scrape function is connected to display slot 1 only (the first TILT detected by TiltPi). If multiple TILTs are in range, only the first one gets MQTT output. Supporting multiple TILTs requires wiring the function to all 25 display template outputs, or tapping the Interpolate output before the display switch.

2. **No battery percentage calculation.** The `tx_power` byte from the iBeacon packet is available in the pipeline but is not included in the MQTT payload. The meaning of this byte varies by firmware version -- some encode "weeks since battery change", others use it for actual TX power calibration. No reliable battery % formula exists yet.

3. **Single MQTT topic.** All TILT data goes to a single `TiltPi` topic. There is no per-color topic discrimination (e.g. `TiltPi/BLUE`). If multi-TILT support is added, the topic structure should be revised.

4. **RSSI jitter.** RSSI values fluctuate rapidly due to BLE signal characteristics. Rounding to the nearest 5 (in the enriched function) reduces but does not eliminate RBE jitter. A stale RSSI value can prevent RBE from passing messages when only SG or temperature changes are small.

5. **TiltPi architecture issues.** The TiltPi flows have significant optimization opportunities identified in `tiltpi-flow-analysis.md`:
   - 25 duplicate check functions (identical code copied 25 times)
   - 25 inject nodes polling every 1 second (100 node executions/sec for display refresh)
   - Nuclear disconnect handler: when any TILT goes stale, all 25 storage slots are cleared
   - Node-RED v0.18.4 is ancient and no longer maintained

6. **No Home Assistant MQTT discovery.** RAPT2MQTT does not publish HA MQTT discovery payloads for the TILT device. The TILT appears in the RAPT2MQTT web UI but is not auto-discovered by Home Assistant.

---

## Related Files

| File | Description |
|---|---|
| `tilt-ecosystem.md` | Comprehensive research on the TILT hardware, BLE protocol, all bridge solutions, and community integrations |
| `tiltpi-flow-analysis.md` | Complete reverse-engineering of TiltPi v2.9.2 Node-RED flows (517 nodes) |
| `tiltpi-nodered-flows.md` | Connection details, live data snapshots, and Node-RED module inventory |
| `tiltpi-flows-raw.json` | Raw Node-RED flows export (248KB) |
| `tiltpi-flows-backup-*.json` | Timestamped backups of the live TiltPi flows |
| `tiltpi-nodes-raw.json` | Installed Node-RED modules list |
