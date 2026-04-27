"""Constants for the BEER2MQTT integration.

BEER2MQTT is the Home Assistant side of RAPT2MQTT. The RAPT2MQTT Docker
container is the bridge that talks to the RAPT cloud API, receives TILT
data via MQTT, manages brew sessions, and runs the smart temperature
feedback loop. This HACS integration subscribes to the MQTT topics that
RAPT2MQTT publishes and creates native HA entities from them.

Architecture:
  RAPT Controller ─WiFi─> RAPT Cloud API
                                │
                          RAPT2MQTT (Docker)
                                │
  TILT ─BLE─> TiltPi ─MQTT─────┘
                                │
                          MQTT Broker
                                │
                     BEER2MQTT (this integration)
                                │
                        Home Assistant
"""

DOMAIN = "beer2mqtt"

MANUFACTURER_KEGLAND = "Kegland"
MANUFACTURER_TILT = "Baron Brew Equipment"
MANUFACTURER_BRIDGE = "RAPT2MQTT"

# ─── MQTT Topics ───────────────────────────────────────────────────────
#
# RAPT2MQTT publishes these topics. This integration subscribes to them.
#
# rapt2mqtt/status                      LWT: "online" or "offline"
# rapt2mqtt/discovery                   JSON manifest of all known devices
# rapt2mqtt/{device_id}/state           Controller state (JSON)
# rapt2mqtt/tilt_{color}/state          TILT state (JSON)
# rapt2mqtt/brew/{session_id}/state     Active brew session state (JSON)
# rapt2mqtt/{device_id}/set_target      Command: HA publishes target temp here
#
# The discovery topic is the key handshake. When RAPT2MQTT starts (or when
# HA discovery is toggled on), it publishes a manifest listing every known
# device with its type, name, and ID. This integration uses that manifest
# to dynamically create/remove entities.

TOPIC_STATUS = "rapt2mqtt/status"
TOPIC_DISCOVERY = "rapt2mqtt/discovery"
TOPIC_SET_TARGET_SUFFIX = "/set_target"

# ─── Device Types ──────────────────────────────────────────────────────

DEVICE_TYPE_CONTROLLER = "controller"
DEVICE_TYPE_TILT = "tilt"
DEVICE_TYPE_BREW = "brew"

# ─── Controller Sensors ────────────────────────────────────────────────
#
# These map JSON keys in the controller state payload to HA sensor entities.
# The state payload looks like:
# {
#   "temperature": 4.25,         <- fridge air temp (°C)
#   "target_temperature": 4.0,   <- controller setpoint (°C)
#   "mode": "Cooling",           <- "Heating", "Cooling", or "Idle"
#   "rssi": -55,                 <- WiFi signal (dBm)
#   "connection_state": "Connected"
# }

CONTROLLER_SENSORS = {
    "temperature": {
        "name": "Fridge Temperature",
        "device_class": "temperature",
        "unit": "°C",
        "icon": "mdi:thermometer",
        "state_class": "measurement",
    },
    "target_temperature": {
        "name": "Fridge Target",
        "device_class": "temperature",
        "unit": "°C",
        "icon": "mdi:thermometer-chevron-up",
        "state_class": "measurement",
    },
    "mode": {
        "name": "Mode",
        "device_class": None,
        "unit": None,
        "icon": "mdi:hvac",
        "state_class": None,
    },
    "rssi": {
        "name": "Signal Strength",
        "device_class": "signal_strength",
        "unit": "dBm",
        "icon": "mdi:wifi",
        "state_class": "measurement",
    },
}

# ─── TILT Sensors ──────────────────────────────────────────────────────
#
# State payload from TILT:
# {
#   "temperature": 18.5,    <- in-liquid beer temp (°C)
#   "temperature_f": 65.3,  <- Fahrenheit (for display)
#   "sg": 1.045,            <- specific gravity (raw float)
#   "rssi": -62             <- BLE signal (dBm)
# }

TILT_SENSORS = {
    "temperature": {
        "name": "Beer Temperature",
        "device_class": "temperature",
        "unit": "°C",
        "icon": "mdi:thermometer",
        "state_class": "measurement",
    },
    "sg": {
        "name": "Specific Gravity",
        "device_class": None,
        "unit": "SG",
        "icon": "mdi:flask-outline",
        "state_class": "measurement",
    },
    "rssi": {
        "name": "Signal Strength",
        "device_class": "signal_strength",
        "unit": "dBm",
        "icon": "mdi:bluetooth",
        "state_class": "measurement",
    },
}

# ─── Brew Session Sensors ──────────────────────────────────────────────
#
# State payload from active brew:
# {
#   "name": "Black IPA",
#   "target_beer_temp": 17.5,
#   "current_sg": 1.012,
#   "abv": 5.2,
#   "days": 14.3,
#   "feedback_active": true
# }
#
# These entities are DYNAMIC — created when a brew starts, removed when
# it completes or is cancelled. The discovery manifest includes active
# brews and RAPT2MQTT publishes empty payloads to remove them.

BREW_SENSORS = {
    "name": {
        "name": "Beer Name",
        "device_class": None,
        "unit": None,
        "icon": "mdi:beer",
        "state_class": None,
    },
    "target_beer_temp": {
        "name": "Beer Target",
        "device_class": "temperature",
        "unit": "°C",
        "icon": "mdi:thermometer-check",
        "state_class": "measurement",
    },
    "current_sg": {
        "name": "Current SG",
        "device_class": None,
        "unit": "SG",
        "icon": "mdi:flask-outline",
        "state_class": "measurement",
    },
    "abv": {
        "name": "Estimated ABV",
        "device_class": None,
        "unit": "%",
        "icon": "mdi:percent",
        "state_class": "measurement",
    },
    "days": {
        "name": "Days Fermenting",
        "device_class": "duration",
        "unit": "d",
        "icon": "mdi:calendar-clock",
        "state_class": "measurement",
    },
}
