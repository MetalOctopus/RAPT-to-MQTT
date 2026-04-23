# RAPT Community Projects

## 1. sgoadhouse/rapt-mqtt-bridge
- **URL:** https://github.com/sgoadhouse/rapt-mqtt-bridge
- **Type:** Python script, RAPT Pill only
- **MQTT Topic:** `rapt/pill/{device_name}`
- **Payload fields:** specific_gravity, plato, brix, temperature_celsius, temperature_fahrenheit, battery, rssi, lastActivityTime
- **QoS:** 2 with retain
- **Default poll:** 15 minutes

## 2. thewolf-oz/ha-rapt-package
- **URL:** https://github.com/thewolf-oz/ha-rapt-package
- **Type:** Home Assistant YAML package
- **Supports:** Pill, BrewZilla, Temperature Controller via REST sensors
- **Scan interval:** 600 seconds (10 min)
- **Features:** ABV calculation `(OG - current) * 131.25`, attenuation, fermentation duration
- **Token refresh:** 3000 seconds (50 min)

## 3. sbaird123/rapt-brewing-hacs
- **URL:** https://github.com/sbaird123/rapt-brewing-hacs
- **Type:** HACS integration for Home Assistant
- **Method:** BLE-based (not cloud API)
- **Sensors:** 20+ including gravity (raw + temp-corrected), ABV, attenuation, temperature, battery, signal strength, accelerometer X/Y/Z
- **BLE Discovery:** manufacturer IDs 16722 or 17739
- **Temp correction:** `True_Density = Raw_Gravity - (Temperature - 20) * 0.00013`

## 4. sairon/rapt-ble
- **URL:** https://github.com/sairon/rapt-ble
- **Type:** Python library for parsing RAPT Pill BLE advertisement packets
- **Used by:** Official Home Assistant `rapt_ble` integration (merged in HA 2023.5)
- **PyPI:** `rapt-ble`

## 5. TravisEvashkevich/RAPT-Pill-Bluetooth-Decoder
- **URL:** https://github.com/TravisEvashkevich/RAPT-Pill-Bluetooth-Decoder
- **Type:** Python BLE decoder using Bleak library
- **Logs to:** InfluxDB/Grafana
- **Temp decoding:** `raw_value / 128 - 273.15`

## 6. tonymacdonald2008/node-red-rapt-pull
- **URL:** https://flows.nodered.org/node/@tonymacdonald/node-red-rapt-pull
- **Type:** Node-RED node for RAPT API v1
- **Supports:** GetHydrometers, GetHydrometer, GetTelemetry

## 7. Home Assistant rapt_ble (Official)
- **URL:** https://www.home-assistant.io/integrations/rapt_ble/
- **Method:** BLE local push (no cloud)
- **Requires:** Pill set to Bluetooth telemetry mode
