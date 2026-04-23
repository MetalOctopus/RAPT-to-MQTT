# RAPT Device Ecosystem

## Devices with Full API Support

### 1. RAPT Temperature Controller
- **Product:** KL22927, ~$99.95 AUD
- **Function:** WiFi box that switches heating/cooling relays for fermentation temperature control
- **Features:** PID support, Bluetooth gateway capability
- **API:** Full CRUD + telemetry + SetTargetTemperature, SetPIDEnabled, SetPID
- **Telemetry:** temperature, targetTemperature, coolingEnabled, heatingEnabled, coolingRunTime, heatingRunTime, PID settings, alarms, rssi

### 2. RAPT Pill Hydrometer
- **Function:** Floating WiFi/BLE specific gravity and temperature sensor
- **Reports:** gravity, gravityVelocity, temperature, battery
- **API:** Read-only (no control endpoints, sensor only)
- **Can pair** with other RAPT devices (pairedDeviceType, pairedDeviceId)
- **Price:** ~$69.95 AUD

### 3. RAPT Fermentation Chamber
- **Function:** Integrated cooling (-5°C to 45°C) and heating unit
- **Features:** Compressor, fan, light controls, WiFi + Bluetooth
- **API:** SetTargetTemperature, SetPIDEnabled, SetPID
- **Extra fields:** compressorDelay (2-10 min), modeSwitchDelay (2-30 min), coolingHysteresis (0.5-10°), heatingHysteresis (0.1-10°), telemetryFrequency (1-14440 min), fanEnabled, lightEnabled

### 4. BrewZilla Gen 4/4.1
- **Function:** All-in-one electric brewing system, WiFi + BLE
- **Controls:** Heating element (with utilisation %), pump, PID, distillation mode
- **API:** SetTargetTemperature, SetHeatingEnabled, SetHeatingUtilisation, SetPumpEnabled, SetPumpUtilisation, SetPIDEnabled, SetPID
- **Can use** external BLE thermometer as control sensor

### 5. RAPT Still
- **Function:** Distillation controller
- **API:** Nearly identical to BrewZilla (heating, pump, PID, temperature control)

### 6. RAPT Can & Bottle Filler
- **Function:** Tracks fills, fill failures, fill times, temperature
- **API:** Read-only. Has calibration settings and fill presets
- **Fields:** totalFillCount, totalFailedCount, emptyPressure, calibrationFactor, minFillRate, fillTimeout

### 7. Bonded Devices (BLE peripherals)
- **Function:** BLE-only peripherals bonded to gateway devices
- **Reports:** temperature, battery
- **API:** Read-only

### 8. External Devices
- **Function:** Non-RAPT devices submitting telemetry via API
- **Reports:** temperature, gravity, pressure, battery
- **API:** Can submit telemetry via POST
- **Requires** RAPT subscription

## BLE-Only Devices (No Dedicated API Endpoints)

These appear in the DeviceTypes enum but have no API controller group:

- **BLETemperature** — RAPT Bluetooth Thermometer (-20°C to 300°C, 20cm probe, AAA batteries)
- **BLEHumidity**
- **BLETempHumidity**
- **BLEPressure** — Likely the RAPT Digital Regulator & Spunding Valve (0-1.5 bar spunding / 0-8 bar regulator)
- **GrainWeigh / GrainWeighDevice**
- **GlycolChiller** — RAPT Bluetooth Glycol Chiller (400W cooling, BLE controlled)
- **Fridge**

## Upcoming Devices

- **RAPT Laser Level Sensor** — Uses laser array to map keg internals for liquid level. BLE. 3x AAA, 18-36 month battery.

---

## TemperatureControllerModel — Complete Schema

### Identity
`id` (uuid), `name`, `serialNumber`, `macAddress`, `deviceType` (enum), `active`, `disabled`, `connectionState`, `status`, `error`, `lastActivityTime`, `firmwareVersion`, `isLatestFirmware`, `deleted`, `createdOn`/`modifiedOn`

### Temperature
`temperature`, `targetTemperature`, `minTargetTemperature`, `maxTargetTemperature`, `tempUnit`

### Heating/Cooling
`coolingEnabled`, `coolingRunTime`, `coolingStarts`, `heatingEnabled`, `heatingRunTime`, `heatingStarts`, `heatingUtilisation`, `auxillaryRunTime`, `auxillaryStarts`

### PID
`pidEnabled`, `pidProportional`, `pidIntegral`, `pidDerivative`, `pidCycleTime`

### Alarms
`highTempAlarm`, `lowTempAlarm`

### Sensor
`rssi`, `useInternalSensor`, `controlDeviceType`, `controlDeviceMacAddress`, `controlDeviceTemperature`, `ntcBeta`, `ntcRefResistance`, `ntcRefTemperature`, `sensorDifferential`, `sensorTimeout`

### UI/Config
`showGraph`, `soundsEnabled`, `customerUse`, `telemetryFrequency`, `compressorDelay`, `modeSwitchDelay`, `coolingHysteresis`, `heatingHysteresis`, `betaUpdates`, `bluetoothEnabled`

### Profile
`activeProfileId`, `activeProfileStepId`, `activeProfileSession`

### Telemetry
`telemetry` (array of TemperatureControllerTelemetryModel)

---

## HydrometerModel (RAPT Pill) — Complete Schema

All base identity fields plus:
- `temperature` — current temp in Celsius
- `gravity` — specific gravity (e.g. 1.050)
- `gravityVelocity` — rate of gravity change
- `battery` — battery percentage
- `pairedDeviceType` (DeviceTypes enum)
- `pairedDeviceId` (uuid)
- `telemetry` (array)

Telemetry fields: `id`, `rowKey`, `createdOn`, `macAddress`, `rssi`, `temperature`, `gravity`, `gravityVelocity`, `battery`, `version`
