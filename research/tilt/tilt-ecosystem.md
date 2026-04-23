# TILT Hydrometer Ecosystem Research

Comprehensive research into the TILT hydrometer brewing sensor ecosystem, covering hardware, protocols, software integrations, MQTT patterns, and community tools.

---

## 1. What Is the TILT Hydrometer?

The TILT hydrometer is a free-floating wireless digital hydrometer and thermometer designed for real-time fermentation monitoring in beer, wine, cider, and mead brewing. Manufactured by Baron Brew Equipment (formerly Brewometer), it is dropped directly into the fermenter and continuously measures:

### Measurements

| Measurement | Standard TILT | TILT Pro |
|---|---|---|
| **Specific Gravity (SG)** | 0.990 - 1.120, resolution 0.001 | 0.9900 - 1.1200, resolution 0.0001 |
| **Temperature** | 0 - 140 degF, resolution 1 degF | 0 - 140 degF (or -17.8 - 60 degC), resolution 0.1 degF |
| **Accuracy (SG)** | +/- 0.002 | +/- 0.002 |
| **Accuracy (Temp)** | +/- 1 degF (+/- 0.5 degC) | +/- 1 degF (+/- 0.5 degC) |
| **Battery Weeks** | Reported by newer firmware | Reported by newer firmware |
| **Firmware Version** | Reported by newer firmware | Reported by newer firmware |
| **RSSI** | Available from BLE advertisement | Available from BLE advertisement |

### How It Works

The TILT contains a digital inclinometer (accelerometer) that measures the angle of tilt when floating in liquid. Since the angle changes with liquid density (specific gravity), the device converts tilt angle into an SG reading. A temperature sensor provides the temperature component. These values are broadcast via Bluetooth Low Energy (BLE).

### Battery

- **Standard TILT**: Single CR123A lithium battery (3.2V max, Li-MnO2). Battery life: 3 months (gen 1, blue-green PCB) or 12-24 months (gen 2+, black PCB). Recommended brands: Streamlight, Energizer, Panasonic (16.1-16.5g weight is critical).
- **TILT Pro**: 2x AA lithium 1.5V batteries (e.g., Energizer AA Ultimate Lithium).
- **Not compatible** with rechargeable batteries (though LiFePO4 will physically work but affects calibration due to weight difference).

### Physical Dimensions

- Standard: Cylindrical tube approximately 43mm diameter x 108mm tall
- Pro: 43mm (1.7") diameter x 140mm (5.4") tall, 153g (5.4 oz)

---

## 2. BLE Communication Protocol

### iBeacon Protocol

The TILT communicates exclusively via Bluetooth Low Energy (BLE) using Apple's iBeacon protocol. It does NOT have WiFi capability. It broadcasts BLE advertisements containing sensor data encoded in the iBeacon manufacturer-specific data fields.

### iBeacon Packet Structure

The TILT embeds data in the standard iBeacon manufacturer-specific data (type 0xFF):

| Bytes | Value | Description |
|---|---|---|
| 1 | 0xFF | Manufacturer Specific Data type |
| 1 | 0x1A | Field length (26 bytes) |
| 2 | 0x004C | Apple manufacturer ID |
| 1 | 0x02 | iBeacon subtype |
| 1 | 0x15 | iBeacon data length (21 bytes) |
| 16 | (varies) | UUID - identifies the TILT color |
| 2 | (varies) | **Major** - Temperature in degrees Fahrenheit |
| 2 | (varies) | **Minor** - Specific Gravity x 1000 |
| 1 | (varies) | TX Power (dBm at 1 meter) |

All multi-byte values are **big-endian** (most significant byte first).

### Data Encoding

- **Temperature (Major field)**: 16-bit unsigned integer. Raw value = temperature in degrees Fahrenheit. Example: Major = 68 means 68 degF.
- **Specific Gravity (Minor field)**: 16-bit unsigned integer. Raw value = SG x 1000. Example: Minor = 1050 means SG 1.050. Divide by 1000 to get actual SG.
- **TILT Pro (High Resolution)**: The Pro uses the same UUID pattern but encodes with higher precision. The gravity minor value is SG x 10000 (e.g., 10500 = 1.0500), and the temperature major value includes a decimal (e.g., 681 = 68.1 degF). Software detects the Pro by checking if minor > 5000 (since normal SG values x1000 are always below ~1200).

### Color-to-UUID Mapping

Each TILT is manufactured in one of 8 colors, each with a unique UUID. The UUID follows the pattern `A495BBn0-C5B1-4B44-B512-1370F02D74DE` where `n` identifies the color:

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

Each color acts as a separate device identity. If monitoring multiple fermenters simultaneously, each must use a different color TILT. The TILT app and all bridge software use the UUID to identify and differentiate devices.

### Advertisement Behavior

The TILT broadcasts two types of BLE advertisements:
1. **Scan response advertisements**: Contain no sensor data (empty responses to scan requests).
2. **Sensor data advertisements**: Contain the iBeacon packet with temperature and gravity readings.

The device advertises continuously at a regular interval (typically every few seconds).

---

## 3. TiltPi (Raspberry Pi + Node-RED)

### Overview

TiltPi is the official Raspberry Pi-based companion software from Baron Brew Equipment. It turns a Raspberry Pi into a dedicated TILT receiver and data logger. TiltPi uses Bluetooth to scan for nearby TILT hydrometers and provides:

- A local web dashboard for real-time monitoring
- Cloud logging (Google Sheets, Brewfather, etc.)
- Calibration tools
- Multi-device support (all 8 colors simultaneously)

### Architecture

TiltPi consists of:

1. **aioblescan** - A Python asyncio BLE scanning library with a custom TILT plugin that reads iBeacon advertisements
2. **Node-RED** - The automation and dashboard framework (v0.18.4 specifically chosen for HTTP POST redirect support needed by Google Sheets)
3. **node-red-dashboard** (v2.15.5) - Provides the web UI widgets

### Access

- Dashboard: `http://tiltpi.local:1880/ui` or `http://<ip>:1880/ui`
- Node-RED editor: `http://tiltpi.local:1880`

### Installation

Available as either:
- A pre-built SD card image (recommended, write to 8GB+ SD card)
- Manual installation on existing Raspbian (involves installing aioblescan, Node-RED, and the flow)

BLE scanning is verified with: `sudo python3 -u -m aioblescan -T`

### Key Limitation

TiltPi does NOT natively support MQTT output. Its primary outputs are:
- Google Sheets (via HTTP POST to Google Apps Script)
- The local web dashboard
- Local CSV file logging

MQTT support requires custom Node-RED nodes or an external bridge.

---

## 4. TiltPi Node-RED Flow Structure

### Node Types Used

| Category | Node Types |
|---|---|
| **Input** | `scanBeacon` (custom BLE scanner), `inject` (triggers) |
| **Processing** | `json`, `change`, `function`, `switch`, `delay` |
| **Storage** | `file` (local CSV logging) |
| **Cloud Output** | `http request` (Google Sheets POST) |
| **Dashboard UI** | `ui_dropdown`, `ui_text_input`, `ui_switch`, `ui_template`, `ui_gauge` |
| **System** | `exec` (shell commands for file operations), `split` |

### Flow Pipeline

```
BLE Scan (aioblescan) --> JSON Parse --> UUID-to-Color Mapping (switch node)
    --> Calibration Interpolation (function node) --> Data Smoothing
    --> Branch per color (8 parallel paths)
        --> Dashboard Display (ui_template, ui_gauge)
        --> Cloud Logging (http request to Google Sheets)
        --> Local File Logging (file node)
```

### Key Function Node Logic

1. **UUID-to-Color Mapping**: Switch node routes data based on the iBeacon UUID to identify which color TILT is broadcasting.

2. **Calibration Engine**: Linear interpolation function transforms raw measurements into calibrated values. Supports user-defined calibration point arrays. Computes SG, Plato, and Brix units.

3. **High-Resolution Detection**: Checks `minor > 2000` to detect TILT Pro ("hd = true") and adjusts divisor accordingly.

4. **Data Smoothing**: Alpha-filtering and sample averaging for measurement stability.

5. **Timezone Handling**: Offset calculations for timestamps in log entries.

6. **RSSI Filtering**: Signal strength filtering with configurable timeout (default 120 seconds).

### Dashboard Tabs

1. **Tilt Pi tab**: Eight color-coded displays showing calibrated/uncalibrated readings, temperature, gravity progress bars
2. **Logging tab**: Cloud settings, beer naming, comment input, logging interval (5-60 minutes)
3. **Calibration tab**: SG and temperature multi-point calibration
4. **System tab**: Time settings, display units (degF/degC), signal filtering, administration

### Data Storage

Node-RED flow context (`flow.set()` / `flow.get()`) stores per-color:
- Beer names
- Gravity calibration points
- Temperature calibration offsets
- Cloud logging URLs and intervals
- Last-seen timestamps

### Cloud Logging Format

Data is sent as URL-encoded POST to Google Sheets Apps Script:
- Timepoint, Temperature, SG, Beer Name, Color, Comments

---

## 5. MQTT Topics and Payloads

There is no single "official" TILT MQTT format. Different bridge tools use different topic structures and payload formats. Here are the main ones:

### 5.1 TiltBridge MQTT Format

TiltBridge is the most widely used bridge for MQTT. Its MQTT output follows this structure:

**Base Topic (configurable):** `tiltbridge`

**State Topics:** `tiltbridge/tilt_<Color>` (e.g., `tiltbridge/tilt_Black`)

**JSON Payload (state topic):**
```json
{
    "color": "Yellow",
    "temp": "100.1",
    "tempUnit": "F",
    "gravity": "1.0123",
    "gsheets_name": "XXXXXXXXXXXXXXXXXXXXXXXXX",
    "weeks_on_battery": 123,
    "sends_battery": false,
    "high_resolution": false,
    "fwVersion": 1001,
    "rssi": -75
}
```

**Home Assistant MQTT Discovery Topics:**

Config topic pattern: `homeassistant/sensor/tiltbridge_tilt_<Color>T/config` (temperature) and `homeassistant/sensor/tiltbridge_tilt_<Color>G/config` (gravity)

Temperature discovery payload example:
```json
{
    "dev_cla": "temperature",
    "unit_of_meas": "\u00b0F",
    "ic": "mdi:thermometer",
    "stat_t": "tiltbridge/tilt_Black",
    "name": "Tilt Temperature - Black",
    "uniq_id": "tiltbridge_tilt_black_temp",
    "val_tpl": "{{value_json.Temp}}"
}
```

Gravity discovery payload example:
```json
{
    "unit_of_meas": "SG",
    "ic": "mdi:cup-water",
    "stat_t": "tiltbridge/tilt_Black",
    "name": "Tilt Gravity - Black",
    "uniq_id": "tiltbridge_tilt_black_gravity",
    "val_tpl": "{{value_json.gravity}}"
}
```

### 5.2 tilt2mqtt Format

The `tilt2mqtt` Python library uses a simpler format:

**Topic:** `tilt/<Color>` (e.g., `tilt/Orange`)

**JSON Payload:**
```json
{
    "temperature_celsius_uncali": 20.5,
    "specific_gravity_uncali": 1.042
}
```

Values are uncalibrated; calibration offsets are applied in Home Assistant or downstream.

### 5.3 Pitch Webhook Format (not MQTT, but reference)

Pitch sends JSON webhooks that many users forward to MQTT:
```json
{
    "name": "Pumpkin Ale",
    "color": "purple",
    "temp_fahrenheit": 69,
    "temp_celsius": 21,
    "gravity": 1.035,
    "alcohol_by_volume": 5.63,
    "apparent_attenuation": 32.32
}
```

### 5.4 Brewblox MQTT Format

Brewblox uses its own MQTT topics:
- `brewcast/state` - Current device state
- `brewcast/history` - Historical measurement data

### 5.5 Custom/Home Assistant Webhook-to-MQTT Pattern

A common community pattern uses Pitch webhooks forwarded via HA automation:

**Topic:** `tilt/<color>` (e.g., `tilt/green`)

**JSON Payload:**
```json
{
    "color": "green",
    "temp_fahrenheit": 69,
    "gravity": 1.035,
    "timestamp": "2024-01-15T10:30:00Z"
}
```

HA sensors extract: `value_json.temp_fahrenheit` and `value_json.gravity`

---

## 6. TILT Colors and Device Identity

### The 8 Colors

The TILT is available in exactly 8 colors. Each color is a unique device identity, differentiated by its iBeacon UUID:

1. **Red** (0x10)
2. **Green** (0x20)
3. **Black** (0x30)
4. **Purple** (0x40)
5. **Orange** (0x50)
6. **Blue** (0x60)
7. **Yellow** (0x70)
8. **Pink** (0x80)

### Why Colors Matter

- Each color broadcasts a unique UUID, which is the sole mechanism for device identification.
- You **cannot** use two TILTs of the same color simultaneously -- the app and all bridge software cannot distinguish between them.
- To monitor multiple fermenters, you must use a different color for each.
- All bridge software (TiltBridge, TiltPi, tilt2mqtt, Pitch, etc.) uses the color as the primary device identifier in topics, filenames, and display labels.

### Product Lines

| Product | Colors Available | Key Difference |
|---|---|---|
| **TILT Standard** | All 8 colors | SG resolution 0.001, Temp resolution 1 degF |
| **TILT Pro** | All 8 colors | SG resolution 0.0001, Temp resolution 0.1 degF, physically larger |
| **TILT Pro Mini** | Select colors | Same resolution as Pro, smaller form factor |

---

## 7. Getting TILT Data into MQTT

Since the TILT only speaks BLE, a bridge device is always required to get data into MQTT. Here are the approaches, ordered by popularity and reliability:

### 7.1 TiltBridge (ESP32) -- Recommended

**GitHub:** [thorrak/tiltbridge](https://github.com/thorrak/tiltbridge)

- **Hardware:** ESP32 board (e.g., LOLIN D32 Pro, as low as $10). Optional TFT/OLED screen.
- **How it works:** ESP32 scans for TILT BLE advertisements, decodes iBeacon data, connects to WiFi, and pushes to configured services including MQTT.
- **MQTT:** Native support. Publishes to `tiltbridge/tilt_<Color>` with full JSON payload. Supports Home Assistant MQTT auto-discovery.
- **Other outputs:** Fermentrack, Brewfather, Brewer's Friend, Google Sheets, Grainfather, Taplist.io, Brewstatus, BrewPi Remix.
- **Pros:** Dedicated hardware, always-on, no phone/Pi needed, cheap, open source (Apache 2.0).
- **Cons:** Requires flashing firmware to ESP32.

### 7.2 tilt2mqtt (Python on Raspberry Pi/Linux)

**GitHub:** [LinuxChristian/tilt2mqtt](https://github.com/LinuxChristian/tilt2mqtt)

- **Hardware:** Any Linux device with Bluetooth (Raspberry Pi, laptop, server).
- **How it works:** Python script using BLE scanning libraries. Listens for iBeacon advertisements, translates UUID to color, publishes to MQTT.
- **MQTT Topic:** `tilt/<Color>`
- **Payload:** JSON with `temperature_celsius_uncali` and `specific_gravity_uncali`
- **Configuration via environment variables:**
  - `MQTT_IP` (default: 127.0.0.1)
  - `MQTT_PORT` (default: 1883)
  - `MQTT_AUTH` (default: none)
  - `MQTT_DEBUG` (default: true)
- **Pros:** Simple, lightweight, dedicated MQTT tool.
- **Cons:** Requires Linux with BLE, no calibration, uncalibrated values only.

### 7.3 Pitch + Webhook-to-MQTT

**GitHub:** [linjmeyer/tilt-pitch](https://github.com/linjmeyer/tilt-pitch) | **PyPI:** `tilt-pitch`

- **Hardware:** Linux with Bluetooth + `libbluetooth-dev`.
- **How it works:** BLE scanner that sends HTTP POST webhooks. Home Assistant automation receives webhook and publishes to MQTT via `mqtt.publish` service.
- **Does NOT have native MQTT.** Uses webhooks, Prometheus, and cloud APIs.
- **Webhook JSON payload:** `name`, `color`, `temp_fahrenheit`, `temp_celsius`, `gravity`, `alcohol_by_volume`, `apparent_attenuation`
- **Other outputs:** Prometheus metrics, Brewfather, Grainfather, Brewer's Friend, Taplist.io, Azure IoT Hub, JSON log files.
- **Pros:** Feature-rich, ABV and attenuation calculations, Prometheus metrics, many cloud integrations.
- **Cons:** No direct MQTT; requires webhook intermediary.

### 7.4 OpenMQTTGateway / Theengs Gateway (ESP32)

**GitHub:** [theengs/OpenMQTTGateway](https://github.com/theengs/OpenMQTTGateway)

- **Hardware:** ESP32 board.
- **How it works:** Generic BLE-to-MQTT gateway using Theengs Decoder library. Supports 120+ BLE devices including TILT (added via Theengs Decoder, confirmed in April 2024).
- **MQTT Topic:** `home/<gateway_name>/BTtoMQTT/<device_mac>` (default format)
- **Pros:** Multi-device gateway (not just TILT), active development, Home Assistant integration.
- **Cons:** Generic tool, may require configuration for optimal TILT support.

### 7.5 Theengs Gateway (Python)

**GitHub:** [theengs/gateway](https://github.com/theengs/gateway)

- Pure Python BLE-to-MQTT gateway using Theengs Decoder.
- Runs on Raspberry Pi, Linux, macOS, Windows.
- Same decoder as OpenMQTTGateway but software-only.

### 7.6 tilt_hydrometer (Ruby)

**GitHub:** [ChaosSteffen/tilt_hydrometer](https://github.com/ChaosSteffen/tilt_hydrometer)

- Ruby-based BLE scanner.
- Publishes to MQTT with configurable topic prefix (`-p` flag).
- Also supports Brewfather webhooks (`-b` flag).
- Uses `hcitool lescan --passive --duplicates` for BLE scanning.

### 7.7 TiltPi + Custom Node-RED MQTT Node

- Install `node-red-contrib-mqtt-broker` or similar in TiltPi's Node-RED.
- Add MQTT output nodes to the existing flow.
- Wire them after the calibration function nodes.
- **Not built-in** -- requires manual flow modification.

### 7.8 Home Assistant Native BLE (No MQTT Needed)

- **HA Integration:** `tilt_ble` (introduced HA 2022.10)
- HA directly reads BLE advertisements using the Bluetooth integration.
- ESPHome BLE Proxy can extend range using ESP32 devices.
- No MQTT involved -- uses native HA entities.
- **Limitation:** Requires HA server or ESPHome proxy within BLE range.

### 7.9 Brewblox (Docker-based)

**Docs:** [brewblox.com/user/services/tilt](https://www.brewblox.com/user/services/tilt.html)

- Docker service that scans BLE and publishes to Brewblox's internal MQTT broker.
- Topics: `brewcast/state` and `brewcast/history`
- Install: `brewblox-ctl add-tilt`
- Supports calibration via `SGCal.csv` and `tempCal.csv` files.

---

## 8. Community Integrations

### Cloud Brewing Services

| Service | Integration Method | Notes |
|---|---|---|
| **Brewfather** | Webhook/Custom Stream URL | 15-minute minimum interval. Via TILT app, TiltPi, TiltBridge, Pitch. |
| **Brewer's Friend** | API/Custom App Stream | Via TILT app, TiltBridge, Pitch. |
| **Fermentrack** | Direct integration | TiltBridge designed by Fermentrack author. Add via "Add Gravity Sensor" workflow. |
| **Google Sheets** | HTTP POST via Apps Script | Built into TiltPi and TILT mobile app. |
| **Grainfather** | Custom Fermentation Devices | Via Pitch, TiltBridge. Grainfather also sells rebranded TILTs. |
| **Taplist.io** | API integration | Via TiltBridge, Pitch. |
| **Brewstatus** | HTTP POST | Via TiltBridge. |

### Home Automation Platforms

| Platform | Integration Method |
|---|---|
| **Home Assistant** | Native `tilt_ble` integration (BLE direct), TiltBridge MQTT discovery, tilt2mqtt MQTT sensors, Pitch webhooks, ESPHome BLE proxy |
| **openHAB** | MQTT binding with TILT bridge tools |
| **Node-RED** | TiltPi native; or MQTT input nodes from any bridge |

### Brewing Control Software

| Software | Integration |
|---|---|
| **BrewPi Remix** | Via TiltBridge direct push |
| **CraftBeerPi** | Tilt plugin (`cbpi_Tilt`) |
| **Brewblox** | Native `brewblox-tilt` Docker service |

### Mobile Apps

- **TILT App (iOS/Android)**: Official app. Direct BLE connection. Logs to Google Sheets, Brewfather, Brewer's Friend.
- **TILT 2 App**: Updated version with additional cloud service support.

---

## 9. Summary: Comparison of Bridge Solutions

| Feature | TiltBridge | tilt2mqtt | Pitch | OpenMQTTGateway | HA tilt_ble | TiltPi |
|---|---|---|---|---|---|---|
| **Hardware** | ESP32 | RPi/Linux | RPi/Linux | ESP32 | HA server/ESPHome | RPi |
| **MQTT Native** | Yes | Yes | No (webhook) | Yes | No (native HA) | No |
| **HA Discovery** | Yes | No | No | Yes | N/A (native) | No |
| **Calibration** | No | No | Offsets | No | No | Yes (multi-point) |
| **Cloud Services** | 10+ | No | 7+ | No | No | Google Sheets |
| **Multi-TILT** | 8 colors | 8 colors | 8 colors | 8 colors | 8 colors | 8 colors |
| **Cost** | ~$10 | Free (SW) | Free (SW) | ~$10 | Free (SW) | ~$35 (Pi) |
| **Always-on** | Yes | Yes (if host on) | Yes (if host on) | Yes | Yes | Yes |
| **Battery Tracking** | Yes | No | No | No | No | No |
| **Display** | Optional TFT/OLED | No | Web UI | Optional | HA Dashboard | Web Dashboard |

---

## 10. Key Takeaways for MQTT Integration

1. **TiltBridge is the de facto standard** for getting TILT data into MQTT. Its topic format (`tiltbridge/tilt_<Color>`) and JSON payload (with `color`, `temp`, `gravity`, `rssi`, `weeks_on_battery`, `high_resolution`, `fwVersion`) is the most complete.

2. **tilt2mqtt is the simplest** dedicated MQTT solution but provides only uncalibrated values.

3. **There is no official TILT MQTT standard.** Each bridge uses its own topic/payload format. Any new bridge should ideally support Home Assistant MQTT discovery for seamless integration.

4. **The color is always the device identifier** in MQTT topics. This is a fundamental design choice inherited from the TILT hardware.

5. **TILT Pro detection** in bridge software typically checks if the iBeacon minor value exceeds a threshold (e.g., > 5000) since standard TILT gravity values x1000 never exceed ~1200. When detected, the divisor changes from 1000 to 10000 for gravity and temperature gains a decimal point.

6. **Calibration is not standardized** across bridges. TiltPi has the most sophisticated calibration (multi-point linear interpolation). Most MQTT bridges publish raw/uncalibrated values and leave calibration to the consuming application.

---

## Sources

- [Tilt Hydrometer Official Site](https://tilthydrometer.com/)
- [Tilt Hydrometer iBeacon Data Format (kvurd.com)](https://kvurd.com/blog/tilt-hydrometer-ibeacon-data-format/)
- [TiltBridge GitHub (thorrak/tiltbridge)](https://github.com/thorrak/tiltbridge)
- [TiltBridge Documentation](https://tiltbridge.readthedocs.io/)
- [TiltPi GitHub (baronbrew/TILTpi)](https://github.com/baronbrew/TILTpi)
- [TiltPi Node-RED Flow (flows.nodered.org)](https://flows.nodered.org/flow/0cc3b1d4f7e159800c01c650c30752ae)
- [tilt2mqtt GitHub (LinuxChristian/tilt2mqtt)](https://github.com/LinuxChristian/tilt2mqtt)
- [Pitch GitHub (linjmeyer/tilt-pitch)](https://github.com/linjmeyer/tilt-pitch)
- [tilt_hydrometer GitHub (ChaosSteffen/tilt_hydrometer)](https://github.com/ChaosSteffen/tilt_hydrometer)
- [Home Assistant Tilt BLE Integration](https://www.home-assistant.io/integrations/tilt_ble/)
- [Home Assistant Community: Tilt MQTT Integration](https://community.home-assistant.io/t/tilt-hydrometer-mqtt-integration/264605)
- [OpenMQTTGateway / Theengs](https://docs.openmqttgateway.com/)
- [Theengs Decoder GitHub](https://github.com/theengs/decoder)
- [Brewblox Tilt Integration](https://www.brewblox.com/user/services/tilt.html)
- [IoT Expert: Tilt Hydrometer Advertising Scanner](https://iotexpert.com/tilt-hydrometer-advertising-scanner-part-3/)
- [IoT Expert: Tilt Simulator & Multi Advertising iBeacons](https://iotexpert.com/tilt-hydrometer-part-5-tilt-simulator-multi-advertising-ibeacons/)
- [Automate Brewing With Tilt (robweber)](https://robweber.github.io/automation/hardware/smarthome/automate_brewing_with_tilt/)
- [Brewfather Tilt Integration Docs](https://docs.brewfather.app/integrations/tilt-hydrometer)
- [TiltBridge GitHub Issue #194 - MQTT Discovery](https://github.com/thorrak/tiltbridge/issues/194)
- [OpenMQTTGateway Community: TILT iBeacon Monitoring](https://community.openmqttgateway.com/t/monitoring-tilt-ble-hydrometer-ibeacon/385)
