# TiltPi Node-RED Flows Research

## Connection Details

- **Hostname:** tiltpi.local (mDNS not resolvable from this host)
- **IP Address:** 192.168.0.94
- **Port:** 1880 (Node-RED)
- **Dashboard UI:** http://192.168.0.94:1880/ui
- **Node-RED Version:** 0.18.4
- **TiltPi App Version:** v.2.9.2 (baronbrew/TILTpi, Aioblescan branch)

## Architecture Overview

The TiltPi is a Raspberry Pi running Node-RED with a single "Main" flow tab. It uses
`python3 -u -m aioblescan -T` (the aioblescan Python module in Tilt mode) to scan for
Tilt Hydrometer BLE iBeacon advertisements. The exec node runs this as a long-lived
spawned process, and stdout is parsed as JSON line-by-line.

### Data Pipeline

```
BLE Scan (aioblescan -T)
    |
    v
exec "scan control" (spawned process, sudo python3 -u -m aioblescan -T)
    |
    v
json (parse stdout lines)
    |
    +---> RSSI filter (drops signals below threshold)
    |         |
    |         v
    |     switch "Tilts" (regex match on UUID: a495bb..c5b14b44b5121370f02d74de)
    |         |
    |         v
    |     change "Colors" (UUID -> color name mapping)
    |         |
    |         v
    |     function "Add Parameter" (beer name, cal points, display options)
    |         |
    |         +---> function "Smooth" (optional EMA smoothing)
    |         +---> link out "found Tilts"
    |         |
    |         v
    |     function "Changed?" -> file "Backup Settings"
    |
    +---> change (set msg.topic = mac) -> smoothing pipeline
```

### Custom MQTT Pipeline (Ian's Tasty MQTT Scrape)

The MQTT pipeline branches off the main display template node:

```
ui_template "1" (Tilt display card - receives fully processed Tilt data)
    |
    +---> function "Ian's Tasty MQTT Scrape"
    |         |
    |         v
    |     rbe (Report By Exception - only sends on change)
    |         |
    |         v
    |     mqtt out (topic: "TiltPi", broker: 192.168.0.252:1883)
    |
    +---> function "Setup Cloud Post" (Google Sheets logging)
    +---> function "Setup Local Log" (CSV file logging)
```

## Ian's Tasty MQTT Scrape - Function Code

```javascript
msg.topic = "TiltPi";
msg.payload = JSON.stringify({
  major: parseFloat(msg.payload.displayTemp || 0),
  minor: Math.round((parseFloat(msg.payload.SG) || 0) * 1000)
});
return msg;
```

### What it does:
- Sets MQTT topic to `"TiltPi"`
- Creates a JSON payload with:
  - `major`: The **calibrated display temperature** (as float)
  - `minor`: The **specific gravity x 1000** (as integer, e.g. 1.050 -> 1050)
- The naming convention (major/minor) matches iBeacon terminology since the Tilt
  is an iBeacon device where major=temp, minor=SG*10000 in raw BLE

### MQTT Broker Configuration

```json
{
  "name": "HASS",
  "broker": "192.168.0.252",
  "port": "1883",
  "usetls": false,
  "keepalive": "60",
  "cleansession": true
}
```

The broker is named "HASS" (Home Assistant), running on `192.168.0.252:1883`.

### RBE (Report By Exception) Filter

Between the function and MQTT out, there is an `rbe` node that only forwards
messages when the payload changes. This means MQTT only receives updates when
the temperature or SG actually changes, reducing unnecessary traffic.

## Input Data Format

The data arriving at "Ian's Tasty MQTT Scrape" has this structure (from the
ui_template that forwards it):

```javascript
msg.payload = {
  // Raw BLE data
  uuid: "a495bb60c5b14b44b5121370f02d74de",  // iBeacon UUID
  major: 68,              // Raw temperature (Fahrenheit)
  minor: 1003,            // Raw SG * 10000 (e.g., 1003 = 1.0030)
  tx_power: 12,           // Transmit power / bonus byte
  rssi: -63,              // BLE signal strength
  mac: "e7:57:bd:bf:29:c9",

  // Processed fields
  Color: "BLUE",          // Tilt color name
  displayColor: ["BLUE"], // Array for display
  Beer: ["Untitled", true], // Beer name
  Temp: 68,               // Raw temperature
  SG: 1.003,              // Calculated SG (minor/10000)
  displayTemp: 20.0,      // Calibrated temperature (converted if metric)
  displayuncalTemp: 68,   // Uncalibrated display temp
  ferm: "...",            // Fermentation display value
  fermunits: "...",       // Fermentation units
  tempunits: "...",       // Temperature units
  uncalferm: "...",       // Uncalibrated fermentation
  formatteddate: "...",   // Display date
  timeStamp: 1234567890,  // Millisecond timestamp
  clock: 1234567890,      // Current time for timeout detection

  // Calibration data
  actualSGPoints: "...",
  unCalSGPoints: "...",
  actualTempPoints: "...",
  unCalTempPoints: "...",
}
```

## Tilt iBeacon UUID-to-Color Mapping

The Tilt hydrometers are identified by their iBeacon UUID. All Tilts share the
same base UUID `a495bb__c5b14b44b5121370f02d74de` with different bytes at
positions 7-8:

| UUID (full)                              | Color  | UUID byte |
|------------------------------------------|--------|-----------|
| `a495bb10c5b14b44b5121370f02d74de`       | RED    | 10        |
| `a495bb20c5b14b44b5121370f02d74de`       | GREEN  | 20        |
| `a495bb30c5b14b44b5121370f02d74de`       | BLACK  | 30        |
| `a495bb40c5b14b44b5121370f02d74de`       | PURPLE | 40        |
| `a495bb50c5b14b44b5121370f02d74de`       | ORANGE | 50        |
| `a495bb60c5b14b44b5121370f02d74de`       | BLUE   | 60        |
| `a495bb70c5b14b44b5121370f02d74de`       | YELLOW | 70        |
| `a495bb80c5b14b44b5121370f02d74de`       | PINK   | 80        |

The switch node uses regex `a495bb..c5b14b44b5121370f02d74de` to match all Tilt colors.

## Live Data Snapshot (at time of research)

### /tiltscan endpoint response:
```json
[
  {
    "uuid": "a495bb60c5b14b44b5121370f02d74de",
    "major": 68,
    "minor": 1003,
    "tx_power": 12,
    "rssi": -63,
    "mac": "e7:57:bd:bf:29:c9"
  }
]
```

**Interpretation:** One BLUE Tilt in range reporting:
- Temperature: 68 F (raw, from iBeacon major value)
- Specific Gravity: 1.0030 (minor/10000 = 1003/10000)
- Signal strength: -63 dBm (good signal)
- MAC: e7:57:bd:bf:29:c9

## HTTP API Endpoints

| Method | Path              | Description                                    |
|--------|-------------------|------------------------------------------------|
| GET    | `/data/`          | Returns all Tilt data (timed out during test)  |
| GET    | `/data/:color`    | Returns data for a specific Tilt color         |
| GET    | `/macid/:mac`     | Returns data for a specific MAC address        |
| GET    | `/tiltscan`       | Returns raw BLE scan data (array of iBeacons)  |
| GET    | `/log.csv`        | Returns the local CSV log file                 |

## Installed Node-RED Modules

| Module                       | Version | Description                    |
|------------------------------|---------|--------------------------------|
| node-red                     | 0.18.4  | Core Node-RED                  |
| node-red-dashboard           | 2.15.5  | Dashboard UI widgets           |
| node-red-node-smooth         | 0.1.2   | Smoothing functions            |
| node-red-node-rbe            | 0.2.9   | Report By Exception            |
| node-red-contrib-play-audio  | 2.5.0   | Audio playback                 |
| node-red-node-pi-gpio        | 2.0.2   | Raspberry Pi GPIO              |
| node-red-node-ping           | 0.3.1   | Network ping                   |
| node-red-node-random         | 0.4.0   | Random number generator        |
| node-red-node-email          | 0.1.29  | Email send/receive             |
| node-red-node-feedparser     | 0.1.16  | RSS feed parser                |
| node-red-node-twitter        | 0.1.15  | Twitter integration            |

## Key Node Statistics

| Node Type       | Count | Notes                                       |
|-----------------|-------|---------------------------------------------|
| function        | 105   | JavaScript processing nodes                 |
| change          | 77    | Property set/change nodes                   |
| inject          | 50    | Timer/trigger nodes (many 1s display clocks)|
| ui_group        | 40    | Dashboard layout groups                     |
| ui_template     | 29    | Dashboard HTML templates                    |
| exec            | 29    | Shell command execution                     |
| mqtt-broker     | 1     | Single MQTT broker config (HASS)            |
| mqtt out        | 1     | Single MQTT output (topic: TiltPi)          |

## BLE Scanning Details

The TiltPi uses `aioblescan` (Python async BLE scanner) in Tilt mode:
```
sudo python3 -u -m aioblescan -T
```

This command:
1. Runs with sudo (required for BLE HCI access)
2. Uses `-u` for unbuffered output (important for real-time streaming)
3. Uses `-T` flag for Tilt-specific parsing mode
4. Outputs one JSON line per detected iBeacon advertisement to stdout
5. Runs as a long-lived spawned process via Node-RED exec node

### Watchdog
A 30-second watchdog trigger monitors the scan output. If no data arrives for
30 seconds, it restarts the scan process via a "restart" function node.

### BLE Error Handling
A 5-second trigger monitors stderr from the exec node for BLE scan errors,
also triggering a restart if errors persist.

## Additional Features

### Calibration
- SG calibration: Up to 5-point calibration table per Tilt color
- Temperature calibration: Up to 5-point calibration table per Tilt color
- Calibration data stored in flow context and backed up to JSON files

### Smoothing (Optional)
- Exponential Moving Average (EMA) smoothing
- Configurable alpha values for SG and temperature independently
- Configurable sample window (number of samples)
- Can be toggled on/off via dashboard switch

### Cloud Logging
- Posts to Google Sheets via Tilt cloud API
- Configurable logging interval (default 15 minutes)
- Per-color logging with beer name and comments

### Local Logging
- CSV file logging to `/home/pi/log.csv`
- USB drive export capability (mount/copy/unmount)
- Configurable interval

### Range Boosting
- Can use other TiltPi devices on the network as range boosters
- Fetches data from other TiltPi hostnames via HTTP
- Up to 4 ranger hostnames supported

### System Management
- Hostname configuration via raspi-config
- WiFi credential management
- Timezone configuration
- Reboot/shutdown controls
- OTA update from GitHub (baronbrew/TILTpi Aioblescan branch)

## Raw Data Files

The complete raw JSON files are saved alongside this document:
- `tiltpi-flows-raw.json` - Complete Node-RED flows (248KB, all nodes)
- `tiltpi-nodes-raw.json` - Installed node modules list (10KB)

## Relevance to RAPT2MQTT Project

The MQTT payload format published by "Ian's Tasty MQTT Scrape" is:
```json
{
  "major": <temperature_float>,
  "minor": <sg_times_1000_int>
}
```

Published to topic `TiltPi` on broker `192.168.0.252:1883` (named "HASS").

Key observations for integration:
1. The data uses iBeacon terminology (major/minor) but the values are processed:
   - `major` = calibrated display temperature (float), NOT raw iBeacon major
   - `minor` = SG * 1000 (integer), NOT raw iBeacon minor (which would be SG * 10000)
2. Only publishes on change (RBE filter)
3. Single topic for all Tilts (no color discrimination in MQTT topic)
4. The raw iBeacon data format from aioblescan is:
   `{uuid, major, minor, tx_power, rssi, mac}`
   where major=temp(F), minor=SG*10000
