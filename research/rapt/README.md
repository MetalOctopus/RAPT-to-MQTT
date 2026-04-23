# RAPT Ecosystem Integration

This document covers how RAPT2MQTT integrates with the RAPT ecosystem of brewing devices manufactured by KegLand (Australia).

---

## What Is RAPT?

RAPT is KegLand's cloud-connected brewing device platform. "RAPT" stands for the portal and API at [rapt.io](https://rapt.io) that connects their WiFi-enabled brewing hardware: temperature controllers, hydrometers (Pill), fermentation chambers, BrewZillas, stills, can fillers, and BLE peripherals.

All RAPT devices report telemetry to the RAPT cloud. The RAPT API allows third-party tools to read device state and, for some devices, send control commands (set target temperature, enable/disable PID, etc.).

**Important caveats from KegLand:**
- API access is officially "unsupported" -- no KegLand tech support for API usage
- Endpoints, parameters, and response models may change without notice
- Misuse causing device damage voids warranty
- Extreme abuse can trigger permanent bans rendering devices non-functional

---

## Authentication

RAPT uses OAuth 2.0 password grant for API authentication.

### Token Request

```
POST https://id.rapt.io/connect/token
Content-Type: application/x-www-form-urlencoded

client_id=rapt-user
grant_type=password
username=<RAPT account email>
password=<API Secret>
```

The API Secret is created in the RAPT portal under **My Account > API Secrets**. It is hashed on creation and cannot be recovered -- you must create a new one if lost.

### Token Response

```json
{
    "access_token": "eyJ...",
    "token_type": "Bearer",
    "expires_in": 3600
}
```

### Token Lifetime and Refresh

- **Lifetime:** 3600 seconds (60 minutes)
- **No refresh token** is issued. When the token expires, you must re-authenticate with credentials.
- RAPT2MQTT refreshes the token proactively at **3400 seconds** (~56.7 minutes) to avoid using an expired token mid-request.
- The token and its creation timestamp are cached in `token.txt` (configurable via `TOKEN_FILE` / `CONFIG_DIR`).

### Usage

All API calls require the token in an Authorization header:

```
Authorization: Bearer <access_token>
```

### JWT Claims

The token is a JWT with scopes: `openid`, `profile`, `rapt-api`, `rapt-api.public` and audience: `rapt-api`.

---

## Currently Supported: Temperature Controllers

RAPT2MQTT currently integrates with **RAPT Temperature Controllers** only. This is a WiFi box (~$99.95 AUD) that switches heating and cooling relays for fermentation temperature control, with PID support and Bluetooth gateway capability.

### API Endpoints Used

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/TemperatureControllers/GetTemperatureControllers` | List all temperature controllers |
| POST | `/api/TemperatureControllers/SetTargetTemperature` | Change target temperature |

These are called in `app/rapt_service.py` by the `RaptBridge` class:

- `_update_mqtt()` -- polls `GetTemperatureControllers` on a configurable interval (default 300 seconds), caches all discovered devices, and publishes the first controller's data to MQTT.
- `_set_temperature()` -- called when an MQTT command is received, posts to `SetTargetTemperature`.

### Additional Endpoints Available (Not Yet Used)

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/api/TemperatureControllers/GetTemperatureController` | Get single controller by ID |
| POST | `/api/TemperatureControllers/SetPIDEnabled` | Enable/disable PID control |
| POST | `/api/TemperatureControllers/SetPID` | Set PID parameters (P, I, D) |
| GET | `/api/TemperatureControllers/GetTelemetry` | Historical telemetry data |

---

## MQTT Topics

### Published by RAPT2MQTT

**Topic:** `RAPT/temperatureController`

**Payload:**
```json
{
    "device_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    "name": "Fermenter Controller",
    "current_temp": "20.50",
    "target_temp": "18.00",
    "cooling_enabled": false,
    "heating_enabled": true,
    "connection_state": "Connected",
    "rssi": -65
}
```

### Subscribed by RAPT2MQTT

**Topic:** `RAPT/temperatureController/Command`

**Payload format:** `"Temperature" : "xx.xx"` (without outer braces -- legacy format)

Example to set target to 18 degrees:
```
mosquitto_pub -h <broker> -t "RAPT/temperatureController/Command" -m '"Temperature" : "18.00"'
```

**Topic:** `TiltPi`

TILT hydrometer data. See `research/tilt/README.md` for payload format.

---

## Temperature Controller Data Model

The full `TemperatureControllerModel` returned by the API contains these field groups:

### Identity

| Field | Type | Description |
|---|---|---|
| `id` | uuid | Device unique identifier |
| `name` | string | User-assigned name |
| `serialNumber` | string | Hardware serial number |
| `macAddress` | string | WiFi MAC address |
| `deviceType` | enum | Device type identifier |
| `active` | boolean | Device is active |
| `disabled` | boolean | Device is disabled by user |
| `connectionState` | string | "Connected" / "Disconnected" |
| `status` | string | Current status |
| `error` | string | Error message if any |
| `lastActivityTime` | datetime | Last telemetry timestamp |
| `firmwareVersion` | string | Current firmware version |
| `isLatestFirmware` | boolean | Whether firmware is up to date |
| `deleted` | boolean | Soft-deleted flag |
| `createdOn` | datetime | Device registration date |
| `modifiedOn` | datetime | Last modification date |

### Temperature

| Field | Type | Description |
|---|---|---|
| `temperature` | double | Current temperature (Celsius) |
| `targetTemperature` | double | Target temperature (Celsius) |
| `minTargetTemperature` | double | Minimum allowed target |
| `maxTargetTemperature` | double | Maximum allowed target |
| `tempUnit` | string | Display unit preference |

### Heating / Cooling

| Field | Type | Description |
|---|---|---|
| `coolingEnabled` | boolean | Cooling relay active |
| `coolingRunTime` | int | Total cooling runtime |
| `coolingStarts` | int | Number of cooling cycles |
| `heatingEnabled` | boolean | Heating relay active |
| `heatingRunTime` | int | Total heating runtime |
| `heatingStarts` | int | Number of heating cycles |
| `heatingUtilisation` | double | Heating element utilisation % |
| `auxillaryRunTime` | int | Auxiliary relay runtime |
| `auxillaryStarts` | int | Auxiliary relay starts |

### PID

| Field | Type | Description |
|---|---|---|
| `pidEnabled` | boolean | PID control active |
| `pidProportional` | double | P parameter |
| `pidIntegral` | double | I parameter |
| `pidDerivative` | double | D parameter |
| `pidCycleTime` | double | PID cycle time |

### Alarms

| Field | Type | Description |
|---|---|---|
| `highTempAlarm` | double | High temperature alarm threshold |
| `lowTempAlarm` | double | Low temperature alarm threshold |

### Sensor Configuration

| Field | Type | Description |
|---|---|---|
| `rssi` | int | WiFi signal strength |
| `useInternalSensor` | boolean | Use internal vs external sensor |
| `controlDeviceType` | enum | Type of paired control device |
| `controlDeviceMacAddress` | string | Paired device MAC |
| `controlDeviceTemperature` | double | Paired device temperature reading |
| `ntcBeta` | double | NTC thermistor beta coefficient |
| `ntcRefResistance` | double | NTC reference resistance |
| `ntcRefTemperature` | double | NTC reference temperature |
| `sensorDifferential` | double | Sensor calibration offset |
| `sensorTimeout` | int | Sensor timeout threshold |

### UI / Configuration

| Field | Type | Description |
|---|---|---|
| `showGraph` | boolean | Show graph in RAPT portal |
| `soundsEnabled` | boolean | Audible alerts enabled |
| `customerUse` | string | Usage notes |
| `telemetryFrequency` | int | Telemetry reporting interval (minutes) |
| `compressorDelay` | int | Compressor restart delay (minutes) |
| `modeSwitchDelay` | int | Heat/cool mode switch delay (minutes) |
| `coolingHysteresis` | double | Cooling hysteresis (degrees) |
| `heatingHysteresis` | double | Heating hysteresis (degrees) |
| `betaUpdates` | boolean | Opted into beta firmware |
| `bluetoothEnabled` | boolean | Bluetooth gateway active |

### Profile

| Field | Type | Description |
|---|---|---|
| `activeProfileId` | uuid | Currently running fermentation profile |
| `activeProfileStepId` | uuid | Current step within profile |
| `activeProfileSession` | object | Profile session data |

### Telemetry

| Field | Type | Description |
|---|---|---|
| `telemetry` | array | Array of `TemperatureControllerTelemetryModel` objects |

---

## Rate Limiting

No explicit rate limit is documented. KegLand warns that "all requests are tracked" and abuse may result in warnings or access revocation.

Community-established safe polling intervals:
- **ha-rapt-package:** 600s (10 min)
- **rapt-mqtt-bridge:** 900s (15 min)
- **RAPT2MQTT default:** 300s (5 min)
- **Safe minimum:** 60s

---

## Webhook Integration

The RAPT portal supports custom webhooks that fire on telemetry updates. Available template variables:

- All devices: `@device_id`, `@device_type`, `@device_name`, `@temperature`, `@rssi`, `@created_date`
- Hydrometer adds: `@gravity`, `@battery`
- FermentationChamber / TempController / BrewZilla add: `@target_temperature`

RAPT2MQTT does not use webhooks -- it polls the REST API. Webhooks could be an alternative for push-based updates in the future.

---

## Future Device Support

The RAPT API exposes endpoints for several device types not yet supported by RAPT2MQTT:

### RAPT Pill Hydrometer

- Floating WiFi/BLE specific gravity and temperature sensor (~$69.95 AUD)
- **API:** Read-only -- `GetHydrometers`, `GetHydrometer`, `GetTelemetry`
- **Fields:** `temperature`, `gravity`, `gravityVelocity`, `battery`, `pairedDeviceType`, `pairedDeviceId`
- **Note:** Not to be confused with the TILT hydrometer. The Pill is RAPT's own product and uses the RAPT cloud API, while the TILT uses BLE iBeacon and requires a separate bridge.

### Fermentation Chamber

- Integrated cooling/heating unit (-5 C to 45 C)
- **API:** `SetTargetTemperature`, `SetPIDEnabled`, `SetPID`, telemetry
- **Extra fields:** `compressorDelay`, `modeSwitchDelay`, `coolingHysteresis`, `heatingHysteresis`, `fanEnabled`, `lightEnabled`

### BrewZilla Gen 4 / 4.1

- All-in-one electric brewing system
- **API:** `SetTargetTemperature`, `SetHeatingEnabled`, `SetHeatingUtilisation`, `SetPumpEnabled`, `SetPumpUtilisation`, `SetPIDEnabled`, `SetPID`

### Still

- Distillation controller, API nearly identical to BrewZilla

### Can & Bottle Filler

- Read-only tracking of fills, failures, fill times, temperature
- **Fields:** `totalFillCount`, `totalFailedCount`, `calibrationFactor`, `fillTimeout`

### Bonded Devices (BLE Peripherals)

- BLE-only peripherals bonded to gateway devices
- Read-only: temperature, battery

### External Devices

- Non-RAPT devices submitting telemetry via API POST
- Requires RAPT subscription

### BLE-Only Devices (No API Endpoints)

These appear in the DeviceTypes enum but have no dedicated API controller:
- BLETemperature (Bluetooth Thermometer)
- BLEHumidity
- BLETempHumidity
- BLEPressure (Digital Regulator & Spunding Valve)
- GrainWeigh / GrainWeighDevice
- GlycolChiller
- Fridge

### Upcoming Hardware

- **RAPT Laser Level Sensor** -- uses laser array to map keg internals for liquid level measurement. BLE, 3x AAA, 18-36 month battery.

---

## Swagger / OpenAPI

- **Swagger UI:** https://api.rapt.io/index.html
- **OpenAPI spec:** https://api.rapt.io/swagger/v1/swagger.json

---

## Community Projects

Several community projects integrate with the RAPT API. See `community-projects.md` for details:

| Project | Type | Devices |
|---|---|---|
| sgoadhouse/rapt-mqtt-bridge | Python MQTT bridge | Pill only |
| thewolf-oz/ha-rapt-package | HA YAML package | Pill, BrewZilla, Temp Controller |
| sbaird123/rapt-brewing-hacs | HACS integration | Pill (BLE, not cloud) |
| sairon/rapt-ble | Python BLE parser | Pill BLE |
| tonymacdonald2008/node-red-rapt-pull | Node-RED node | Hydrometers |
| Home Assistant rapt_ble | Official HA integration | Pill (BLE local) |

---

## Related Files

| File | Description |
|---|---|
| `rapt-api.md` | Complete API endpoint reference with all parameters |
| `rapt-devices.md` | Full device ecosystem with complete schema documentation |
| `community-projects.md` | Detailed breakdown of community RAPT integrations |
