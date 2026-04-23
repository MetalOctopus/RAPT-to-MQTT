# TiltPi Node-RED Flow Analysis

Complete reverse-engineering of TiltPi v2.9.2 Node-RED flows (Node-RED v0.18.4).
Source: `tiltpi-flows-raw.json` (248KB, 517 nodes).

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Data Pipeline: BLE Scan to All Outputs](#2-data-pipeline-ble-scan-to-all-outputs)
3. [BLE Scanning & Data Ingestion](#3-ble-scanning--data-ingestion)
4. [Data Enrichment: Add Parameter](#4-data-enrichment-add-parameter)
5. [Smoothing System](#5-smoothing-system)
6. [Calibration System](#6-calibration-system)
7. [Display Pipeline (25-Slot Architecture)](#7-display-pipeline-25-slot-architecture)
8. [Cloud Logging Pipeline](#8-cloud-logging-pipeline)
9. [Local Logging Pipeline](#9-local-logging-pipeline)
10. [MQTT Chain (Ian's Tasty MQTT Scrape)](#10-mqtt-chain-ians-tasty-mqtt-scrape)
11. [HTTP API Endpoints](#11-http-api-endpoints)
12. [Settings Persistence & Restore](#12-settings-persistence--restore)
13. [Dashboard UI Structure](#13-dashboard-ui-structure)
14. [System Management Nodes](#14-system-management-nodes)
15. [Range Booster System](#15-range-booster-system)
16. [Battery / tx_power Analysis](#16-battery--tx_power-analysis)
17. [Additional Data Available for MQTT Scraping](#17-additional-data-available-for-mqtt-scraping)
18. [Optimization Opportunities](#18-optimization-opportunities)
19. [Issues & Concerns](#19-issues--concerns)

---

## 1. Architecture Overview

The entire TiltPi system lives on a single Node-RED flow tab ("Main") with 469 nodes. It uses 4 dashboard UI tabs:

| UI Tab | Order | Purpose |
|--------|-------|---------|
| Tilt Pi | 1 | Main display - 25 Tilt display slots |
| Logging | 3 | Cloud and local logging configuration |
| Calibration | 4 | SG and temperature calibration points |
| System | 5 | Units, smoothing, RSSI filter, updates, hostname, reboot |

**Node count by type (top 10):**
- function: 105
- change: 77
- inject: 50
- ui_group: 40
- ui_template: 29
- exec: 29
- ui_text: 15
- ui_button: 14
- ui_switch: 13
- delay: 12

**Key design decisions:**
- Supports up to 25 simultaneous Tilts (8 colors x multiple MAC IDs via "IDbyMAC" mode)
- All state stored in `flow` context (not persistent by default in Node-RED v0.18.4)
- Settings backed up to JSON files on `/home/pi/` and `/boot/firmware/`
- 25 identical display slots, each with its own inject->clock->check->template chain (massive duplication)

---

## 2. Data Pipeline: BLE Scan to All Outputs

```
aioblescan (Python BLE scanner via exec)
    |
    v
[JSON parse] --> [RSSI filter] --> [Tilts UUID regex switch]
    |                                      |
    v                                      v
[Range Booster input]              [Colors: UUID -> color name]
                                           |
                                           v
                                   [Add Parameter: enrich with all metadata]
                                     |           |
                                     v           v
                               [Changed?]   [Smooth: EMA smoothing]
                               (backup)           |
                                                  v
                                          [Interpolate: calibration + unit conversion]
                                                  |
                                                  v
                                          [Display switch: route to slot 1-25]
                                            |         |         |
                                            v         v         v
                                      [change: store in flow.storage-N]
                                                  |
                            +---------+-----------+----------+
                            |         |           |          |
                            v         v           v          v
                      [check+template] [Cloud Log] [Local Log] [MQTT Scrape]
                       (dashboard)
```

---

## 3. BLE Scanning & Data Ingestion

### Scanner Exec Node: `scan control`

**Command:** `sudo python3 -u -m aioblescan -T`

The `-T` flag tells aioblescan to output TILT-format JSON. The exec node runs with `sudo` permissions. Output is streamed line-by-line (stdout).

**Start sequence:**
1. `Start` inject node fires on deploy
2. Sends `pkill -f aioblescan` first (kill any existing scanner)
3. Starts the exec node for BLE scanning
4. Loads saved settings from JSON files on disk
5. Triggers watchdog timer

**aioblescan output format (JSON per line):**
```json
{
  "uuid": "a495bb10c5b14b44b5121370f02d74de",
  "major": 72,
  "minor": 1045,
  "tx_power": -59,
  "rssi": -67,
  "mac": "AA:BB:CC:DD:EE:FF"
}
```

### JSON Parse Node
Parses stdout lines from aioblescan into JavaScript objects.

### RSSI Filter Function

```javascript
var minRSSI = flow.get('minRSSI');
if (msg.payload.rssi >= minRSSI){
 return msg;
}
```

Drops packets with signal strength below the configured threshold (default: -105 dBm). Configurable via dashboard slider.

### Tilts UUID Switch

Regex filter: `a495bb..c5b14b44b5121370f02d74de`

This matches the TILT hydrometer iBeacon UUID pattern. The `..` wildcard matches the color byte:

| UUID Byte | Color |
|-----------|-------|
| `10` | RED |
| `20` | GREEN |
| `30` | BLACK |
| `40` | PURPLE |
| `50` | ORANGE |
| `60` | BLUE |
| `70` | YELLOW |
| `80` | PINK |

### Colors Change Node

Performs string replacement on `msg.payload.Color` (initially set to full UUID) to map UUID to human-readable color name.

### Watchdog Timer

- **Type:** Trigger node, 30-second timeout
- **Mechanism:** Reset on every scan output from the exec node. If no data received for 30 seconds, fires a reset trigger.
- **Reset action:** Sends `pkill -f aioblescan`, waits 5 seconds, then restarts with `python3 -u -m aioblescan -T`

### BLE Scan Error Handling

- **Type:** Trigger node, 5-second timeout
- **Fires on:** stderr output from the scan exec node
- **Action:** Same reset cycle as watchdog

---

## 4. Data Enrichment: Add Parameter

**Function Node: "Add Parameter"** -- This is the central enrichment hub. Every BLE scan passes through here.

```javascript
// MAC-based identification (optional)
var IDbyMAC = flow.get('IDbyMAC')||false;
if (IDbyMAC) {
    msg.payload.Color = msg.payload.Color + ":" + msg.payload.mac;
    msg.payload.displayColor = msg.payload.Color.split(":");
    msg.payload.IDbyMAC = true;
} else {
    msg.payload.displayColor = [msg.payload.Color];
    msg.payload.IDbyMAC = false;
}

// Beer name from flow storage
var beerArray = flow.get(msg.payload.Color + "-Beer")||["Untitled",true];
msg.payload.Beer = beerArray;

// Discovered Tilt tracking (for dropdown options)
var options = flow.get('options')||[];
var color = msg.payload.Color;
if (options.indexOf(color) === -1){
    options.push(color);
    options.sort();
    flow.set('options',options);
    node.send([null, {'payload': options}]);
}

// Calibration points (SG)
msg.payload.actualSGPoints = flow.get('actualSGpoints-' + color)||[];
msg.payload.unCalSGPoints = flow.get('uncalSGpoints-' + color)||[];

// Calibration points (Temp)
msg.payload.actualTempPoints = flow.get('actualTemppoints-' + color)||[];
msg.payload.unCalTempPoints = flow.get('uncalTemppoints-' + color)||[];

// Timestamps
msg.payload.timeStamp = Date.now();
msg.payload.formatteddate = new Date().toLocaleString();
msg.payload.Timepoint = timestamp_as_excel_serial_date;

// SG conversion (handles TILT Pro high-resolution)
if (msg.payload.minor > 2000){
    msg.payload.SG = msg.payload.minor / 10000;  // TILT Pro: 4 decimal places
    msg.payload.major /= 10;                      // TILT Pro: temp divided by 10
    msg.payload.hd = true;
} else {
    msg.payload.SG = msg.payload.minor / 1000;    // Standard: 3 decimal places
    msg.payload.hd = false;
}

// Temperature
msg.payload.Temp = msg.payload.major;
msg.payload.tempunits = flow.get('displayUnits')||"°F";

// Cloud/logging settings attached
msg.payload.customcloudURL = flow.get('cloudURL-' + color);
msg.payload.defaultcloudURL = flow.get('cloudURL')||[default_google_sheets_url, true];
msg.payload.logCloudDataCheck = flow.get('logCloudDataCheck')||true;
msg.payload.logLocalDataCheck = flow.get('logLocalDataCheck');
msg.payload.localloggingInterval = flow.get('localloggingInterval')||15;
msg.payload.loggingInterval = flow.get('loggingInterval')||15;
msg.payload.minRSSI = flow.get('minRSSI');

// Smoothing settings
msg.payload.alphaSG = flow.get('alphaSG');
msg.payload.alphaTemp = flow.get('alphaTemp');
msg.payload.numberSamples = flow.get('numberSamples');
msg.payload.smoothSwitch = flow.get('smoothSwitch');

// Range booster settings
msg.payload.enableRangeBoost = flow.get('enableRangeBoost');
msg.payload.rangerHostnames = flow.get('rangerHostnames');

msg.filename = "/home/pi/" + msg.payload.Color + ".json";
```

**Output 1:** Full enriched message to `Changed?` and `Smooth`
**Output 2:** Updated options array to dropdown (only when new Tilt discovered)

**Key insight:** The `Add Parameter` node attaches ALL settings to every message. This makes the data self-contained downstream but means every BLE packet carries ~30 extra properties through the pipeline.

---

## 5. Smoothing System

**Function Node: "Smooth"** -- Exponential Moving Average (EMA) with configurable parameters.

```javascript
var smoothSwitch = flow.get('smoothSwitch')||false;
if (smoothSwitch && msg.payload.SG > 0.5){
    var alphaSG = flow.get('alphaSG') / 100 || 0.5;
    var alphaTemp = flow.get('alphaTemp') / 100 || 0.5;
    var numberSamples = flow.get('numberSamples') * 12 || 36;
    var sampleRate = 5000; // 5 seconds

    // Collect samples into arrays per color
    // Push new sample, shift oldest if over numberSamples
    // Calculate mean of array
    // Blend: smoothed = (current * (1-alpha)) + (mean * alpha)
    msg.payload.SG = ((SG * (1 - alphaSG)) + (meanSG * alphaSG));
    msg.payload.Temp = ((Temp * (1 - alphaTemp)) + (meanTemp * alphaTemp));
}
```

**Parameters (all stored in flow context):**
- `smoothSwitch`: boolean on/off (default: false)
- `alphaSG`: 0-100, weight given to historical mean (default: 50 = 0.5 blend)
- `alphaTemp`: same for temperature
- `numberSamples`: multiplied by 12 to get window size (default: 0.5 => 6 samples)

**Behavior:**
- Samples are taken at 5-second intervals (Tilt broadcast rate)
- Uses a sliding window array stored in `context` per color
- Higher alpha = more smoothing (more weight to historical average)
- SG must be > 0.5 for smoothing to activate (sanity check)

**Dashboard controls:**
- Toggle switch for on/off
- Numeric input for SG alpha
- Numeric input for Temp alpha
- Numeric input for number of samples

---

## 6. Calibration System

### How It Works

The calibration uses **piecewise linear interpolation** between user-defined calibration points. Users add pairs of (uncalibrated reading, actual known value). At runtime, the system finds the two nearest calibration points bracketing the current reading and linearly interpolates.

### Interpolate Function Node

```javascript
function linearInterpolation(x, x0, y0, x1, y1) {
    var a = (y1 - y0) / (x1 - x0);
    var b = -a * x0 + y0;
    return a * x + b;
}
```

**SG Calibration:**
1. Takes `msg.payload.actualSGPoints` and `msg.payload.unCalSGPoints` (comma-separated strings from Add Parameter)
2. Adds sentinel values (-0.001, Number.MAX_VALUE) to bracket any input
3. Finds index of current SG in sorted uncalibrated array
4. Interpolates between surrounding points
5. Computes derived units:
   - **Plato:** `1111.14 * SG - 630.272 * SG^2 + 135.997 * SG^3 - 616.868`
   - **Brix:** `((182.4601 * SG - 775.6821) * SG + 1262.7794) * SG - 669.5622`

**Temperature Calibration:**
- Same interpolation approach
- If display units are Celsius, converts to Celsius before calibration, then back to Fahrenheit for storage
- Handles NaN with fallback to 0

**Output fields after calibration:**
```
msg.payload.uncalSG      // raw SG
msg.payload.SG           // calibrated SG
msg.payload.uncalPlato   // Plato from raw SG
msg.payload.Plato        // Plato from calibrated SG
msg.payload.uncalBrix    // Brix from raw SG
msg.payload.Brix         // Brix from calibrated SG
msg.payload.ferm         // formatted display value (SG, Plato, or Brix based on user preference)
msg.payload.uncalferm    // formatted pre-cal display value
msg.payload.uncalTemp    // raw temp (F or C depending on conversion)
msg.payload.displayTemp  // calibrated temp for display
msg.payload.Temp         // calibrated temp (always stored as F internally)
```

### Where Calibration Data Is Stored

**Flow context variables (per color):**
- `uncalSGpoints-{COLOR}` -- array of raw SG calibration points
- `actualSGpoints-{COLOR}` -- array of known SG calibration points
- `uncalTemppoints-{COLOR}` -- array of raw temp calibration points
- `actualTemppoints-{COLOR}` -- array of known temp calibration points

**Persisted to:** `/home/pi/{COLOR}.json` (per-Tilt settings backup)

### Calibration UI (Calibration Tab)

**SG Calibration workflow:**
1. Select Tilt color from dropdown
2. Current uncalibrated SG auto-populated from live reading
3. Enter known actual SG value (or use "Calibrate in Water" button for 1.0000)
4. Click "Add SG Cal Point"
5. Up to 5 calibration points shown in a table
6. Points can be removed individually

**Temp Calibration workflow:**
- Same approach but with "Calibrate in Ice Water" (32.0F / 0.0C)

### Add/Remove Calibration Point Functions

**Add SG Cal Points:**
```javascript
var color = msg.payload;
if (msg.topic == "clear calibration"){
    flow.set('uncalSGpoints-' + color,[]);
    flow.set('actualSGpoints-' + color,[]);
} else {
    var uncalSGcalPoint = flow.get('uncalSGpoint')||0;
    var actualSGcalPoint = flow.get('actualSGpoint')||0;
    if (msg.topic == "calibrate in water"){
        actualSGcalPoint = "1.0000";
    }
    // Push and sort both arrays
    uncalpointsArray.push(uncalSGcalPoint);
    uncalpointsArray.sort(function(a, b){return a-b});
    actualpointsArray.push(actualSGcalPoint);
    actualpointsArray.sort(function(a, b){return a-b});
    // Store back to flow
}
```

**Remove SG Cal Point:**
```javascript
var calpointIndex = Number(msg.payload);
uncalpointsArray.splice(calpointIndex,1);
actualpointsArray.splice(calpointIndex,1);
```

**Calibration Table Display:** Uses a function node to set `msg.row0` through `msg.row4` to `'visible'` or `'hidden'` based on whether each calibration point index exists. Feeds a `ui_template` that renders an HTML table.

---

## 7. Display Pipeline (25-Slot Architecture)

This is the most architecturally significant (and problematic) part of the system.

### How It Works

1. **Display Switch Node:** Routes calibrated data to 1 of 25 output slots based on `msg.payload.Color` matching `flow.options[N]`
2. **Change Node (per slot):** `move msg.payload -> flow.storage-N` -- stores the full data object and clears msg
3. **Inject Node (per slot):** Fires every 1 second, reads `flow.storage-N`
4. **Clock Change Node (per slot):** Adds `msg.payload.clock = Date.now()` for staleness detection
5. **Check Function (per slot):** Determines if Tilt data is stale (older than `displayTimeout`, default 120s)
6. **UI Template (per slot):** Renders HTML with color bar, SG, temp, timestamp, RSSI

### The Check Function (DUPLICATED 25 TIMES -- identical code)

```javascript
if(msg.payload === undefined){
    msg.payload = {};
    msg.show = "hidden";
    return msg;
}
var displayTimeout = flow.get('displayTimeout')||120000;
msg.topic = msg.payload.Color;

if (msg.payload.clock - msg.payload.timeStamp > displayTimeout){
    // Tilt disconnected -- CLEAR ALL 25 STORAGE SLOTS
    flow.set('storage-1', undefined);
    flow.set('storage-2', undefined);
    // ... all the way to storage-25
    flow.set('options', []);
    msg.show = "hidden";
    return msg;
} else {
    msg.show = "visible";
    return msg;
}
```

**CRITICAL ISSUE:** When ANY Tilt disconnects, ALL 25 storage slots are cleared. This means if you have 3 Tilts and one goes out of range, all 3 disappear temporarily until the remaining two re-populate their slots on the next scan cycle. This is a known architectural flaw.

### UI Template HTML (identical across all 25)

```html
<div id="{{msg.topic}}-div">
    <h1>{{msg.payload.Beer[0]}}</h1>
    <h1><strong>TILT | {{msg.payload.displayColor[0]}}</strong>
        <span ng-bind-html="msg.payload.doclongurl"></span></h1>
    <div style="background: {{color}};height:40px;width:100%;"></div>
    <h1>SG/Concentration: {{msg.payload.uncalferm}} (pre-calibrated)</h1>
    <h2>{{msg.payload.ferm}}{{msg.payload.fermunits}}</h2>
    <!-- SG progress bar -->
    <div style="background: {{color}};height:10px;
         width:{{(msg.payload.SG - 0.990)/0.00130}}%;"></div>
    <h1>Temperature: {{msg.payload.displayuncalTemp}} (pre-calibrated)</h1>
    <h2>{{msg.payload.displayTemp}}{{msg.payload.tempunits}}</h2>
    <!-- Temp progress bar -->
    <div style="background: {{color}};height:10px;
         width:{{(msg.payload.Temp - 30) / 1.85}}%;"></div>
    <h5>{{msg.payload.formatteddate}}</h5>
    <h5>Received {{staleness}} seconds ago {{msg.payload.rssi}} dBm</h5>
</div>
```

**Data displayed:**
- Beer name
- Tilt color (and MAC suffix if IDbyMAC enabled)
- Color bar
- SG/Concentration (pre-calibrated and calibrated, in chosen units)
- Temperature (pre-calibrated and calibrated)
- Timestamp
- Staleness ("Received X seconds ago")
- RSSI signal strength

### Panels 9-25 Visibility

Panels 9-25 are hidden by default. They are shown only when `IDbyMAC` mode is enabled (which allows >8 simultaneous Tilts by differentiating by MAC address). A `ui_ui_control` node shows/hides these panel groups.

---

## 8. Cloud Logging Pipeline

### Setup Cloud Post Function

```javascript
var postEnabled = flow.get('logCloudDataCheck') || false;
var interval = flow.get('loggingInterval') || 15;
interval *= 60000; // convert minutes to ms

if (postEnabled && msg.payload.Color !== undefined){
    var lastPost = flow.get('lastpost-' + msg.payload.Color) || 0;
    if (msg.payload.timeStamp - lastPost > interval){
        flow.set('lastpost-' + msg.payload.Color, msg.payload.timeStamp);
        msg.payload.Comment = flow.get(msg.payload.Color + "-Comment") || "";
        msg.payload.Beer = flow.get(msg.payload.Color + "-Beer") || ["Untitled", true];

        var payloadEncoded = encodeURI(
            "Timepoint=" + msg.payload.Timepoint +
            "&Temp=" + msg.payload.Temp +
            "&SG=" + msg.payload.SG +
            "&Beer=" + msg.payload.Beer +
            "&Color=" + msg.payload.Color +
            "&Comment=" + msg.payload.Comment
        );

        // If using default cloud URL (Google Sheets)
        if (flow.get('cloudURL')[1] === true){
            node.send({ url: defaultCloudURL, payload: payloadEncoded, ... });
        } else {
            // Custom per-color URLs (comma-separated, multiple endpoints)
            var cloudURLsArray = cloudURLs.split(',');
            for (var i = 0; i < cloudURLsArray.length; i++){
                node.send({ url: cloudURLsArray[i], payload: payloadEncoded, ... });
            }
        }
    }
}
```

**Flow:**
1. All 25 display template outputs feed into `Setup Cloud Post`
2. Rate-limited by `loggingInterval` (default: 15 minutes) per color
3. Data URL-encoded and sent via HTTP POST
4. Delay node rate-limits to 1 request per 5 seconds
5. Response handled by `Cloud Service` http request node
6. Response processed by `filter cloud response` and `update name, clear comment`

**Default Cloud URL:** `https://script.google.com/macros/s/AKfycbwNXh6rEWoULd0vxWxDylG_PJwQwe0dn5hdtSkuC4k3D9AXBSA/exec` (Google Apps Script)

**Custom URLs:** Per-color custom URLs supported, comma-separated for multiple endpoints.

**Cloud response handling:**
- `update name, clear comment`: If cloud returns a beer name, updates local storage
- `filter cloud response`: Clears "waiting" message on dashboard
- `Reset Result` trigger: After 30 seconds, shows "Waiting for next time point..."

### Quick Start (Setup Wizard)

Files in `/boot/firmware/cloud_log_{color}.json` can pre-configure logging:
```javascript
flow.set('cloudURL', [google_sheets_url, true]);
flow.set(color + "-Comment", msg.payload.Comment);
flow.set('logCloudDataCheck', true);
flow.set('loggingInterval', 15);
flow.set(color + "-Beer", msg.payload.Beer);
flow.set('logLocalDataCheck', true);
flow.set('localloggingInterval', 15);
```

---

## 9. Local Logging Pipeline

### Setup Local Log Function

```javascript
var postEnabled = flow.get('logLocalDataCheck');
var interval = flow.get('localloggingInterval') || 15;
interval *= 60000;

if (postEnabled && msg.payload.Color !== undefined){
    var lastPost = flow.get('lastlocalpost-' + msg.payload.Color) || 0;
    if (msg.payload.timeStamp - lastPost > interval){
        // Convert tx_power to unsigned byte
        var uint8 = new Uint8Array(1);
        uint8[0] = msg.payload.tx_power;
        msg.payload.tx_power = uint8[0];

        flow.set('lastlocalpost-' + msg.payload.Color, msg.payload.timeStamp);
        msg.payload = date + "," + msg.payload.Timepoint + "," +
            msg.payload.Temp + "," + msg.payload.SG + "," +
            msg.payload.Beer[0] + "," + msg.payload.Color + "," +
            msg.payload.Comment + "," + msg.payload.rssi + "," +
            msg.payload.tx_power;
        return msg;
    }
}
```

**CSV format:** `Time,Timepoint,Temp,SG,Beer,Color,Comment,RSSI,Uptime`

**Note the header column says "Uptime" but the actual data is `tx_power` (unsigned byte conversion).**

### Deduplication (changed? function)

Before writing to the CSV file, a `changed?` function checks if the data actually changed:

```javascript
var current = currentArray[2] + currentArray[3] + currentArray[4] + currentArray[6];
// Compares Temp + SG + Beer + Comment
// Also forces a write every 15 minutes even if unchanged
if (previous !== current || Date.now() - time > 900000){
    // write to file
}
```

**Output file:** `/home/pi/log.csv` (append mode)

### Log File Stats

An exec node runs `stat` on the log file to get file size, displayed on the Logging tab.

### USB Export

A complete USB export pipeline exists:
1. Watch `/dev` for USB drive insertion
2. Mount the drive at `/mnt/usb`
3. Configure permissions
4. Copy `/home/pi/log.csv` to `/mnt/usb`
5. Unmount and show success message

---

## 10. MQTT Chain (Ian's Tasty MQTT Scrape)

### Current Implementation

**Chain:** `UI Template "1"` (display slot 1) -> `Ian's Tasty MQTT Scrape` -> `RBE` -> `MQTT Out`

**Function Node:**
```javascript
msg.topic = "TiltPi";
msg.payload = JSON.stringify({
    major: parseFloat(msg.payload.displayTemp || 0),
    minor: Math.round((parseFloat(msg.payload.SG) || 0) * 1000)
});
return msg;
```

**RBE (Report By Exception):** Only passes messages when payload changes (deduplication).

**MQTT Out:**
- Topic: `TiltPi`
- Broker: `HASS` at `192.168.0.252:1883`
- No authentication configured
- QoS: 0
- No TLS
- Client ID: empty (auto-generated)
- Clean session: true

### Current Limitations

1. **Only monitors slot 1** -- only the first detected Tilt gets MQTT output
2. **Minimal data** -- only sends `{major: temp, minor: sg*1000}` -- loses all enrichment
3. **No color identification** -- single topic "TiltPi" with no per-color distinction
4. **No calibration data** -- sends calibrated values but loses the metadata about what was calibrated
5. **Static topic** -- hardcoded "TiltPi"
6. **RBE on full payload** -- change in either temp or SG triggers update (which is correct)

### What the MQTT Payload COULD Contain

At the point where "Ian's Tasty MQTT Scrape" receives data from UI Template "1", the full `msg.payload` object contains:

```javascript
{
    // Identity
    Color: "RED",              // or "RED:AA:BB:CC:DD:EE:FF" if IDbyMAC
    displayColor: ["RED"],     // or ["RED", "AA", "BB", "CC", "DD", "EE", "FF"]
    mac: "AA:BB:CC:DD:EE:FF",
    IDbyMAC: false,
    Beer: ["My IPA", true],    // [name, isDefault]
    uuid: "a495bb10c5b14b44b5121370f02d74de",

    // Raw readings
    major: 72,                 // raw temp from BLE (F)
    minor: 1045,               // raw SG * 1000 from BLE
    hd: false,                 // true for TILT Pro

    // Calibrated values
    SG: 1.045,                 // calibrated specific gravity
    uncalSG: 1.045,            // pre-calibration SG
    Temp: "72.0",              // calibrated temperature (string after toFixed)
    uncalTemp: "72.0",         // pre-calibration temperature
    displayTemp: "72.0",       // for display
    displayuncalTemp: "72.0",  // for display

    // Derived units
    Plato: 11.15,              // degrees Plato (from calibrated SG)
    uncalPlato: 11.15,
    Brix: 11.22,               // degrees Brix (from calibrated SG)
    uncalBrix: 11.22,
    ferm: "1.045",             // formatted value in chosen units
    uncalferm: "1.045",
    fermunits: "",             // "", "°P", or "°Bx"

    // Temperature
    tempunits: "°F",           // or "°C"

    // Signal
    rssi: -67,                 // signal strength in dBm
    tx_power: -59,             // iBeacon tx_power byte

    // Timing
    timeStamp: 1714000000000,  // ms since epoch
    formatteddate: "4/23/2026, ...",
    Timepoint: 46139.5,        // Excel serial date

    // Calibration state
    actualSGPoints: "1.000,1.050",
    unCalSGPoints: "0.999,1.048",
    actualTempPoints: "32.0",
    unCalTempPoints: "33.5",

    // Cloud URL
    doclongurl: "",            // HTML link to Google Sheet
    customcloudURL: undefined,
    defaultcloudURL: [...],

    // Settings (attached for backup purposes)
    logCloudDataCheck: true,
    logLocalDataCheck: true,
    loggingInterval: 15,
    localloggingInterval: 15,
    minRSSI: -105,
    alphaSG: 50,
    alphaTemp: 50,
    numberSamples: 0.5,
    smoothSwitch: false,
    enableRangeBoost: "false",
    rangerHostnames: [...]
}
```

---

## 11. HTTP API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/data/:color` | GET | Returns stored JSON for a specific color (e.g., `/data/RED`) |
| `/data/` | GET | Returns stored JSON for "global" |
| `/log.csv` | GET | Returns the full local CSV log file |
| `/macid/:mac` | GET | Returns data for a specific MAC address (or `/macid/all` for all) |
| `/tiltscan` | GET | Returns latest raw scan data (for Range Booster system) |

### Find macID Function

```javascript
var requestedMac = msg.req.params.mac;
for (i = 1; i < 26; i++){
    tiltData = flow.get("storage-" + i.toString());
    if (requestedMac == "all"){
        allData.push(tiltData);
    } else if (requestedMac == tiltData.mac) {
        msg.payload = tiltData;
        break;
    }
}
```

---

## 12. Settings Persistence & Restore

### What Gets Saved

**Per-Tilt settings** saved to `/home/pi/{COLOR}.json`:
- Beer name and cloud ID
- SG calibration points (uncal + actual arrays)
- Temp calibration points (uncal + actual arrays)
- Custom cloud URL

**Global settings** saved to `/home/pi/global.json`:
- Cloud logging enabled state
- Local logging enabled state
- Logging intervals
- Default cloud URL
- Display units (F/C, SG/Plato/Brix)
- RSSI filter threshold
- IDbyMAC setting
- Smoothing parameters (alpha, samples, switch)
- Range booster settings

### Backup Trigger: Changed? Function

Monitors a concatenated string of all settings on every BLE scan. If any setting changed, triggers a backup write (rate-limited to 1 write per 15 seconds via delay queue).

```javascript
var current =
    msg.payload.Beer +
    msg.payload.unCalSGPoints +
    msg.payload.actualSGPoints +
    msg.payload.actualTempPoints +
    msg.payload.unCalTempPoints +
    msg.payload.fermunits +
    msg.payload.tempunits +
    msg.payload.defaultcloudURL +
    msg.payload.customcloudURL +
    msg.payload.logCloudDataCheck +
    msg.payload.logLocalDataCheck +
    msg.payload.localloggingInterval +
    msg.payload.loggingInterval +
    msg.payload.minRSSI +
    msg.payload.IDbyMAC +
    msg.payload.alphaSG +
    msg.payload.alphaTemp +
    msg.payload.numberSamples +
    msg.payload.smoothSwitch +
    msg.payload.enableRangeBoost +
    msg.payload.rangerHostnames;
```

### Restore on Startup

1. Start inject fires
2. `ls /home/pi/*.json` lists all saved settings files
3. Split by newline, rate-limited read of each file
4. `Restore Tilt Settings` function restores per-color settings
5. `Restore Global` function restores global settings
6. After all files processed (filename === 0), starts the BLE scanner

```javascript
// Restore Tilt Settings
flow.set(color + '-Beer', msg.payload.Beer);
flow.set('actualSGpoints-' + color, msg.payload.actualSGPoints);
flow.set('uncalSGpoints-' + color, msg.payload.unCalSGPoints);
flow.set('actualTemppoints-' + color, msg.payload.actualTempPoints);
flow.set('uncalTemppoints-' + color, msg.payload.unCalTempPoints);
flow.set('cloudURL-' + color, msg.payload.customcloudURL);
```

---

## 13. Dashboard UI Structure

### Tab: Tilt Pi (order 1)
- 25 display groups (width: 6 each, 2 per row on desktop)
- Each shows: beer name, color, SG bar chart, temp bar chart, staleness, RSSI
- Groups 9-25 hidden by default (shown in IDbyMAC mode)

### Tab: Logging (order 3)
- **Quick Start:** One-click setup from `/boot/firmware/cloud_log_*.json` files
- **Cloud Settings:** Tilt color dropdown, beer name input, cloud URL, logging toggle, interval slider, comment field
- **Tilt Pi Settings:** Local logging toggle, interval slider, log file size display

### Tab: Calibration (order 4)
- **Select Tilt in Range:** Dropdown of detected Tilts
- **Specific Gravity Calibration:** Current reading display, actual value input, calibrate in water, add/remove/clear buttons, calibration table
- **Temperature Calibration:** Same layout for temperature

### Tab: System (order 5)
- **Time:** Timezone dropdown, manual time set
- **Display Units:** F/C toggle, SG/Plato/Brix radio buttons
- **Measurement Smoothing:** Toggle, alpha sliders, sample count
- **Filter by RSSI:** Slider (-30 to -105 dBm)
- **Identify by MAC:** Toggle for >8 Tilt support
- **App Admin:** Current version, update checker, beta test URL input, update button
- **Dashboard Link:** Shows local URL (hostname:1880/ui)
- **Range Booster:** Add/remove other TiltPi hostnames
- **Raspberry Pi:** Reboot, shutdown, RPi3 stability fix, hostname config, screen timeout, zoom level, WiFi config

---

## 14. System Management Nodes

### Reboot / Shutdown
- `sudo reboot` and `sudo shutdown` exec nodes
- Triggered by dashboard buttons

### WiFi Configuration
On boot, checks `/boot/firmware/wpa_supplicant.conf` for WiFi credentials:
```javascript
// Parses ssid= and psk= lines
msg.payload = ssid + ' ' + psk + ' 0 0';
// Executes: sudo raspi-config nonint do_wifi_ssid_passphrase
```

### Hostname Configuration
- Validates hostname against RFC 1123 regex
- Renames Node-RED flow files to match new hostname
- Requires reboot

### Timezone
- Dropdown with all timezone strings
- Writes to `/home/pi/timezone`
- Sets symlink: `sudo ln -fs /usr/share/zoneinfo/{tz} /etc/localtime`
- Copies to `/etc/timezone`

### Screen Management (RPi Display)
- Configurable screen timeout (dropdown)
- Zoom level control
- Modifies `/etc/xdg/lxsession//LXDE-pi/autostart`
- Note: double slash in path (`//LXDE-pi`) is likely a bug

### RPi3 Stability Fix
- `sudo sed -i` to modify UART baud rate (known RPi3 BLE stability issue)

### App Updates
- Checks GitHub releases API: `https://api.github.com/repos/baronbrew/TILTpi/releases/latest`
- Downloads flow.json from `https://raw.githubusercontent.com/baronbrew/TILTpi/Aioblescan/flow.json`
- POSTs to local Node-RED API to deploy: `curl -X POST http://localhost:1880/flows`
- Supports dev-mode with custom update URLs

### Version Info

```javascript
var release = {
    name: "v.2.9.2",
    notes: "Now with customizable hostname (for custom local URL) and option
            to use other Tilt Pi's on your network as range boosters."
}
```

---

## 15. Range Booster System

Allows multiple TiltPi devices to share BLE scan data over the local network.

### How It Works

1. Each TiltPi exposes `/tiltscan` HTTP endpoint returning latest raw scan data
2. Configure remote TiltPi hostnames (up to 4)
3. Periodically fetch scans from remote TiltPis via HTTP GET
4. Inject received scans into the local RSSI filter (via Link In/Out nodes)
5. Remote scans are processed identically to local scans

### Validate Hostname Function (Range Booster)

Manages an array of up to 4 hostnames in `flow.rangerHostnames`. For each hostname, constructs URL: `http://{hostname}:1880/tiltscan`.

### Web Response / Array of Scans

The `/tiltscan` endpoint collects the latest scan from each unique MAC address and returns them as an array. Rate-limited to avoid flooding.

---

## 16. Battery / tx_power Analysis

### What tx_power Contains

The iBeacon `tx_power` field is a signed 8-bit integer. In the TiltPi flows, it appears in:

1. **Setup Local Log function:** Converts to unsigned byte and includes in CSV output
   ```javascript
   var uint8 = new Uint8Array(1);
   uint8[0] = msg.payload.tx_power;
   msg.payload.tx_power = uint8[0];
   ```

2. **CSV header:** Labels it as "Uptime" (misleading -- it is tx_power, not uptime)

### Battery Interpretation

The TILT hydrometer encodes battery information in the `tx_power` byte:

- **Standard TILT:** `tx_power` = 197 (0xC5) is typical at full battery. The value represents "weeks since battery change" in some firmware versions, but this is not standardized.
- **TILT Pro:** May use `tx_power` differently (sometimes encodes firmware version or extended data).

**The TiltPi flows do NOT compute battery percentage.** The `tx_power` byte is:
- Passed through to local CSV logging (as unsigned byte)
- Available in `msg.payload.tx_power` at all pipeline stages
- NOT displayed on the dashboard
- NOT sent to cloud logging
- NOT sent via MQTT (in current implementation)

### What We Could Do

The `tx_power` value is available in the message payload at the point where our MQTT scrape function runs. We could:
1. Forward `tx_power` raw value via MQTT
2. Interpret it as "weeks on battery" (if firmware supports it)
3. Calculate approximate battery percentage: `Math.max(0, Math.min(100, (52 - tx_power_unsigned) / 52 * 100))` (rough estimate assuming 1 year battery life)

**Caution:** The exact meaning of `tx_power` varies by TILT firmware version. Some versions use it for TX power calibration (standard iBeacon usage), others encode battery weeks. The unsigned conversion in the local log function suggests the TiltPi developers expect a positive "weeks" value, not the standard signed TX power dBm.

---

## 17. Additional Data Available for MQTT Scraping

### Currently Sent via MQTT
```json
{
    "major": 72.0,      // temperature (display value)
    "minor": 1045        // SG * 1000
}
```

### Additional Data We Could Scrape

**High-value additions:**

| Field | Source | Notes |
|-------|--------|-------|
| `color` | `msg.payload.Color` | Tilt color identifier |
| `mac` | `msg.payload.mac` | BLE MAC address |
| `beer_name` | `msg.payload.Beer[0]` | User-assigned beer name |
| `sg_calibrated` | `msg.payload.SG` | Full-precision calibrated SG |
| `sg_uncalibrated` | `msg.payload.uncalSG` | Raw SG before calibration |
| `temp_calibrated` | `msg.payload.displayTemp` | Calibrated temperature |
| `temp_uncalibrated` | `msg.payload.displayuncalTemp` | Raw temperature |
| `plato` | `msg.payload.Plato` | Degrees Plato |
| `brix` | `msg.payload.Brix` | Degrees Brix |
| `rssi` | `msg.payload.rssi` | Signal strength dBm |
| `tx_power` | `msg.payload.tx_power` | Battery/power byte |
| `hd` | `msg.payload.hd` | true if TILT Pro |
| `temp_units` | `msg.payload.tempunits` | "°F" or "°C" |
| `ferm_units` | `msg.payload.fermunits` | "", "°P", or "°Bx" |
| `timestamp` | `msg.payload.timeStamp` | Epoch ms |
| `formatted_date` | `msg.payload.formatteddate` | Human-readable date |

**Computed values we could add:**

| Computation | Formula | Notes |
|-------------|---------|-------|
| ABV (basic) | `(OG - FG) * 131.25` | Requires tracking OG |
| Apparent Attenuation | `(OG - SG) / (OG - 1) * 100` | Requires OG reference |
| Battery estimate | `Uint8(tx_power)` raw value | Firmware-dependent meaning |

**State information:**

| Field | Source | Notes |
|-------|--------|-------|
| `is_calibrated` | Check if actualSGPoints is non-empty | Boolean |
| `smoothing_enabled` | `msg.payload.smoothSwitch` | Boolean |
| `cloud_logging` | `msg.payload.logCloudDataCheck` | Boolean |
| `local_logging` | `msg.payload.logLocalDataCheck` | Boolean |

### Limitation: Slot 1 Only

The current MQTT scrape only sees data from display slot 1 (the first detected Tilt). To get all Tilts via MQTT, the scrape function should be wired to ALL 25 display template outputs, or better yet, tapped directly from the Interpolate output (before the Display switch).

---

## 18. Optimization Opportunities

### 1. MASSIVE Code Duplication: 25 Identical Check Functions

**Problem:** The `check` function is copy-pasted 25 times (nodes 13-84), each with the same 50-line body that clears all 25 storage slots. This is ~1,250 lines of identical code.

**Fix:** Use a single function node with a `msg.slot` parameter, or use a subflow (not available in v0.18.4, but available in later versions).

### 2. Nuclear Disconnect Handler

**Problem:** When any single Tilt goes stale, ALL 25 storage slots are cleared. This causes a flash of empty displays for all active Tilts.

**Fix:** Only clear the specific slot that went stale. The current approach forces a complete re-discovery cycle.

### 3. 25 Inject Nodes Polling Every Second

**Problem:** 25 inject nodes fire every 1 second, each reading a flow variable, running through a change node, function node, and template. That is 25 * 4 = 100 node executions per second just for display refresh.

**Fix:** Use a single inject that iterates over active slots, or event-driven updates only when new data arrives.

### 4. All Settings Attached to Every BLE Packet

**Problem:** The `Add Parameter` function attaches ~15 settings (logging intervals, RSSI thresholds, smoothing parameters) to every single BLE scan message. These settings rarely change but are carried through the entire pipeline.

**Fix:** Read settings directly from flow context where needed instead of passing them on every message.

### 5. BLE Scanner as Exec Node

**Problem:** Running `python3 -u -m aioblescan -T` as an exec node means:
- No structured error handling beyond stderr detection
- No graceful shutdown (uses `pkill`)
- Memory leaks in long-running Python process accumulate

**Fix:** For our RAPT2MQTT project, we use a native Python BLE scanner with proper lifecycle management. For TiltPi, a Node-RED native BLE node would be more robust.

### 6. Watchdog Timer (30 seconds)

**Assessment:** 30 seconds is appropriate for the TILT broadcast interval (every ~5 seconds). It provides 6 missed broadcasts before reset, which handles momentary interference. However, the reset action (pkill + restart) is heavy-handed.

**Potential improvement:** Track per-color staleness separately. Only restart the scanner if ALL Tilts have gone silent, which indicates a BLE adapter issue rather than a Tilt going out of range.

### 7. Cloud Logging Rate Limiter

**Problem:** The delay node after `Setup Cloud Post` limits to 1 request per 5 seconds across all colors. With many Tilts, cloud posts could queue up significantly.

**Fix:** Per-color rate limiting (already partially done via `lastpost-{color}` tracking).

### 8. Smoothing Sample Rate Logic

**Problem:** The smoothing function uses a flag-toggle mechanism (`sampleTakenFlag`) that alternates between "taken" and "not taken" on consecutive messages. This means it only samples every OTHER message, not based on actual time.

**Fix:** Use proper timestamp-based sampling.

---

## 19. Issues & Concerns

### Security

1. **MQTT broker has no authentication** -- `HASS` broker at `192.168.0.252:1883` uses no username/password and no TLS.
2. **No authentication on Node-RED** -- Node-RED v0.18.4 dashboard is accessible to anyone on the network.
3. **`sudo` exec nodes** -- Multiple exec nodes run with `sudo` (reboot, shutdown, mount, raspi-config, sed). These are necessary for system management but expose OS-level control through the Node-RED UI.
4. **Self-update mechanism** -- Downloads and deploys flow.json from GitHub without any signature verification. A MITM attack could inject malicious Node-RED code.
5. **WiFi credentials** -- Read from `/boot/firmware/wpa_supplicant.conf` and passed to `raspi-config` on the command line (visible in process list).

### Stability

1. **Node-RED v0.18.4 is ancient** (released ~2018). Many bugs fixed in later versions. No longer maintained.
2. **Flow context not persistent** by default -- all settings lost on Node-RED restart unless JSON backups restore correctly.
3. **Double-slash in path** -- `/etc/xdg/lxsession//LXDE-pi/autostart` -- the double slash may cause issues on some systems.
4. **`node.warn()` calls left in production** -- `handle changes` function has `node.warn(flowFileArray)` which logs the entire array on every invocation.
5. **Error swallowing** -- Most catch nodes have empty wire targets (do nothing). The cloud post catch shows an alert toast, but other error paths are silently dropped.

### Deprecated Patterns

1. **AngularJS templates** -- The `ui_template` nodes use `ng-bind-html` (AngularJS). The Node-RED dashboard moved away from Angular.
2. **`msg.headers` handling** -- Uses manual header construction instead of built-in HTTP request node features.
3. **String concatenation for change detection** -- The `Changed?` function builds a massive concatenated string to detect changes, which is fragile (e.g., `undefined` + `true` = `"undefinedtrue"`).
4. **Array.indexOf for set membership** -- Uses `indexOf()` instead of `Set` or `includes()`.

### Data Accuracy

1. **Celsius conversion bug in Interpolate function:**
   ```javascript
   Temp -= 32;
   Temp *= 0.5555;
   ```
   Should be `0.5556` (5/9 = 0.55555...). The truncation introduces a small systematic error (~0.01 degree at 212F).

2. **Plato/Brix formulas** -- The polynomial coefficients are standard brewing industry approximations. They are accurate within the normal brewing SG range (1.000-1.120) but diverge at extremes.

3. **Calibration sentinel values** -- Using `-0.001` and `Number.MAX_VALUE` as bracket values means uncalibrated readings below the lowest calibration point are extrapolated (not clamped), which can produce nonsensical results.

### Missing Features

1. **No OG tracking** -- Cannot compute ABV or attenuation without a reference original gravity.
2. **No trend display** -- Dashboard shows instantaneous values only; no graphs or history.
3. **No alerts** -- No notification when temperature goes out of range or fermentation appears stuck.
4. **No MQTT discovery** -- MQTT output has no Home Assistant auto-discovery payload.

---

## Appendix A: UUID-to-Color Mapping

| UUID | Color |
|------|-------|
| `a495bb10c5b14b44b5121370f02d74de` | RED |
| `a495bb20c5b14b44b5121370f02d74de` | GREEN |
| `a495bb30c5b14b44b5121370f02d74de` | BLACK |
| `a495bb40c5b14b44b5121370f02d74de` | PURPLE |
| `a495bb50c5b14b44b5121370f02d74de` | ORANGE |
| `a495bb60c5b14b44b5121370f02d74de` | BLUE |
| `a495bb70c5b14b44b5121370f02d74de` | YELLOW |
| `a495bb80c5b14b44b5121370f02d74de` | PINK |

## Appendix B: Flow Context Variables

### Global Settings
| Variable | Default | Description |
|----------|---------|-------------|
| `displayUnits` | `"°F"` | Temperature display units |
| `fermdisplayUnits` | `""` | `""` = SG, `"°P"` = Plato, `"°Bx"` = Brix |
| `logCloudDataCheck` | `true` | Cloud logging enabled |
| `logLocalDataCheck` | `undefined` | Local logging enabled |
| `loggingInterval` | `15` | Cloud logging interval (minutes) |
| `localloggingInterval` | `15` | Local logging interval (minutes) |
| `cloudURL` | `[url, true]` | `[url, useDefault]` -- true = use for all colors |
| `minRSSI` | `-105` | Minimum RSSI threshold (dBm) |
| `IDbyMAC` | `false` | Identify Tilts by MAC (>8 support) |
| `displayTimeout` | `120000` | Stale data timeout (ms) |
| `smoothSwitch` | `false` | Smoothing enabled |
| `alphaSG` | `100` | SG smoothing alpha (0-100) |
| `alphaTemp` | `100` | Temp smoothing alpha (0-100) |
| `numberSamples` | `0.5` | Smoothing window multiplier |
| `enableRangeBoost` | `"false"` | Range booster enabled (string!) |
| `rangerHostnames` | `undefined` | Array of remote TiltPi hostnames |
| `options` | `[]` | Array of discovered Tilt color names |
| `dev-mode` | `false` | Developer mode for custom updates |
| `ipaddress` | `"http://tiltpi.local:1880/ui"` | Local URL |

### Per-Color Variables (replace `{COLOR}` with e.g. `RED`, `GREEN:AA:BB:CC:DD:EE:FF`)
| Variable | Default | Description |
|----------|---------|-------------|
| `{COLOR}-Beer` | `["Untitled", true]` | `[name, isLocalOnly]` |
| `{COLOR}-Comment` | `""` | Comment for next cloud post |
| `{COLOR}-URL` | `""` | HTML link to Google Sheet |
| `cloudURL-{COLOR}` | `undefined` | Custom cloud URL(s) |
| `lastpost-{COLOR}` | `0` | Last cloud post timestamp |
| `lastlocalpost-{COLOR}` | `0` | Last local log timestamp |
| `uncalSGpoints-{COLOR}` | `[]` | Uncalibrated SG calibration points |
| `actualSGpoints-{COLOR}` | `[]` | Actual SG calibration points |
| `uncalTemppoints-{COLOR}` | `[]` | Uncalibrated temp calibration points |
| `actualTemppoints-{COLOR}` | `[]` | Actual temp calibration points |
| `storage-{N}` | `undefined` | Full data object for display slot N (1-25) |

## Appendix C: Complete Data Object at MQTT Scrape Point

This is the full `msg.payload` available when the MQTT scrape function executes (from UI Template "1", which receives data from `check` function, which reads from `flow.storage-1`):

```javascript
{
    // === BLE Identity ===
    uuid: "a495bb10c5b14b44b5121370f02d74de",
    Color: "RED",                    // or "RED:AA:BB:CC:DD:EE:FF" if IDbyMAC
    displayColor: ["RED"],           // array, split by ":"
    mac: "AA:BB:CC:DD:EE:FF",
    IDbyMAC: false,

    // === Raw BLE Data ===
    major: 72,                       // raw temperature (F, or F/10 for Pro)
    minor: 1045,                     // raw SG*1000 (or SG*10000 for Pro)
    tx_power: -59,                   // signed int8 from iBeacon
    rssi: -67,                       // signal strength
    hd: false,                       // true for TILT Pro

    // === Processed Readings ===
    SG: 1.045,                       // calibrated specific gravity (float)
    uncalSG: 1.045,                  // pre-calibration SG (float)
    Temp: "72.0",                    // calibrated temp (string, toFixed(1))
    uncalTemp: "72.0",               // pre-calibration temp
    displayTemp: "72.0",             // display-formatted calibrated temp
    displayuncalTemp: "72.0",        // display-formatted uncal temp

    // === Derived Units ===
    Plato: 11.15,                    // degrees Plato from calibrated SG
    uncalPlato: 11.15,               // degrees Plato from uncal SG
    Brix: 11.22,                     // degrees Brix from calibrated SG
    uncalBrix: 11.22,                // degrees Brix from uncal SG
    ferm: "1.045",                   // display value in chosen units
    uncalferm: "1.045",              // pre-cal display value
    fermunits: "",                   // "", "°P", or "°Bx"
    tempunits: "°F",                 // "°F" or "°C"

    // === Beer Info ===
    Beer: ["My IPA", true],          // [name, isLocalOnly]
    doclongurl: "",                  // HTML <a> tag link to cloud log

    // === Timestamps ===
    timeStamp: 1714000000000,        // epoch ms
    formatteddate: "4/23/2026, ...", // locale string
    Timepoint: 46139.5,             // Excel serial date number

    // === Calibration State ===
    actualSGPoints: "1.000,1.050",   // comma-separated string
    unCalSGPoints: "0.999,1.048",
    actualTempPoints: "32.0",
    unCalTempPoints: "33.5",

    // === Cloud Config ===
    customcloudURL: undefined,
    defaultcloudURL: [url, true],
    logCloudDataCheck: true,
    logLocalDataCheck: true,
    loggingInterval: 15,
    localloggingInterval: 15,

    // === System Config ===
    minRSSI: -105,
    alphaSG: 50,
    alphaTemp: 50,
    numberSamples: 0.5,
    smoothSwitch: false,
    enableRangeBoost: "false",
    rangerHostnames: [],

    // === Added by clock/check ===
    clock: 1714000001000              // current time (from inject+change)
}
```
