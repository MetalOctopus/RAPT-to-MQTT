"""Home Assistant MQTT auto-discovery for RAPT2MQTT.

Publishes HA-native discovery configs so that RAPT controllers and Tilt
hydrometers appear automatically in Home Assistant without manual YAML.
Uses the standard HA MQTT discovery protocol:
    <prefix>/<component>/<node_id>/<object_id>/config
"""

import json
import re


# ---------------------------------------------------------------------------
# Entity definitions — one list per device type
# ---------------------------------------------------------------------------

RAPT_CONTROLLER_ENTITIES = [
    {
        "component": "sensor",
        "object_id": "temperature",
        "name_suffix": "Temperature",
        "value_template_key": "temperature",
        "device_class": "temperature",
        "unit_of_measurement": "°C",
        "icon": "mdi:thermometer",
    },
    {
        "component": "sensor",
        "object_id": "target",
        "name_suffix": "Target",
        "value_template_key": "targetTemperature",
        "device_class": "temperature",
        "unit_of_measurement": "°C",
        "icon": "mdi:thermometer-chevron-up",
    },
    {
        "component": "binary_sensor",
        "object_id": "cooling",
        "name_suffix": "Cooling",
        "value_template_key": "_cooling_active",
        "device_class": "running",
        "icon": "mdi:snowflake",
    },
    {
        "component": "binary_sensor",
        "object_id": "heating",
        "name_suffix": "Heating",
        "value_template_key": "_heating_active",
        "device_class": "running",
        "icon": "mdi:fire",
    },
    {
        "component": "sensor",
        "object_id": "rssi",
        "name_suffix": "RSSI",
        "value_template_key": "rssi",
        "device_class": "signal_strength",
        "unit_of_measurement": "dBm",
        "icon": "mdi:wifi",
    },
    {
        "component": "number",
        "object_id": "set_target",
        "name_suffix": "Set Target",
        "device_class": "temperature",
        "unit_of_measurement": "°C",
        "icon": "mdi:thermometer-chevron-up",
        "min": 0,
        "max": 35,
        "step": 0.5,
        "mode": "slider",
    },
]

TILT_HYDROMETER_ENTITIES = [
    {
        "component": "sensor",
        "object_id": "temperature",
        "name_suffix": "Temperature",
        "value_template_key": "temperature",
        "device_class": "temperature",
        "unit_of_measurement": "°C",
        "icon": "mdi:thermometer",
    },
    {
        "component": "sensor",
        "object_id": "gravity",
        "name_suffix": "Gravity",
        "value_template_key": "specificGravity",
        "unit_of_measurement": "SG",
        "icon": "mdi:flask-outline",
    },
    {
        "component": "sensor",
        "object_id": "rssi",
        "name_suffix": "RSSI",
        "value_template_key": "rssi",
        "device_class": "signal_strength",
        "unit_of_measurement": "dBm",
        "icon": "mdi:bluetooth",
    },
]


class HADiscovery:
    """Manages Home Assistant MQTT auto-discovery for brewing devices."""

    def __init__(self, mqtt_client, config, logger):
        self._mqtt = mqtt_client
        self._config = config
        self._logger = logger
        self._published_entities = set()

    # ------------------------------------------------------------------
    # Internal helpers
    # ------------------------------------------------------------------

    def _sanitize_id(self, device_id):
        """Lowercase device_id and replace non-alphanumeric chars with underscores."""
        return re.sub(r"[^a-z0-9]", "_", device_id.lower())

    def _build_device_block(self, device_id, device_name, device_type):
        """Return the HA device registry dict for a discovery payload."""
        sanitized = self._sanitize_id(device_id)
        if device_type == "RAPT Temperature Controller":
            manufacturer = "Kegland"
            model = "RAPT Temperature Controller"
        else:
            manufacturer = "Baron Brew Equipment"
            model = "TILT Hydrometer"

        return {
            "identifiers": [f"rapt2mqtt_{sanitized}"],
            "name": device_name,
            "manufacturer": manufacturer,
            "model": model,
            "via_device": "rapt2mqtt",
        }

    def _entity_defs(self, device_type):
        """Return the entity definition list for a device type."""
        if device_type == "RAPT Temperature Controller":
            return RAPT_CONTROLLER_ENTITIES
        return TILT_HYDROMETER_ENTITIES

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def publish_discovery(self, device_id, device_type, device_name):
        """Publish HA MQTT discovery config for every entity of a device."""
        if not self._config.get("ha_discovery_enabled", True):
            return

        prefix = self._config.get("ha_discovery_prefix", "homeassistant")
        sanitized = self._sanitize_id(device_id)
        node_id = f"rapt2mqtt_{sanitized}"
        state_topic = f"rapt2mqtt/{device_id}/state"
        device_block = self._build_device_block(device_id, device_name, device_type)

        for entity in self._entity_defs(device_type):
            component = entity["component"]
            object_id = entity["object_id"]
            topic = f"{prefix}/{component}/{node_id}/{object_id}/config"

            payload = {
                "name": f"{device_name} {entity['name_suffix']}",
                "unique_id": f"{node_id}_{object_id}",
                "state_topic": state_topic,
                "availability_topic": "rapt2mqtt/status",
                "payload_available": "online",
                "payload_not_available": "offline",
                "device": device_block,
            }

            # Icon
            if "icon" in entity:
                payload["icon"] = entity["icon"]

            # Device class (optional — gravity sensor has none)
            if "device_class" in entity:
                payload["device_class"] = entity["device_class"]

            # Unit of measurement
            if "unit_of_measurement" in entity:
                payload["unit_of_measurement"] = entity["unit_of_measurement"]

            # Component-specific fields
            if component == "sensor":
                key = entity["value_template_key"]
                payload["value_template"] = "{{ value_json." + key + " }}"

            elif component == "binary_sensor":
                key = entity["value_template_key"]
                payload["value_template"] = "{{ value_json." + key + " | lower }}"
                payload["payload_on"] = "true"
                payload["payload_off"] = "false"

            elif component == "number":
                payload["command_topic"] = f"rapt2mqtt/{device_id}/set_target"
                payload["value_template"] = "{{ value_json.targetTemperature }}"
                payload["min"] = entity["min"]
                payload["max"] = entity["max"]
                payload["step"] = entity["step"]
                payload["mode"] = entity["mode"]

            self._mqtt.publish(topic, json.dumps(payload), qos=0, retain=True)
            self._published_entities.add(topic)

        self._logger.info(
            "HA discovery published for %s (%s)", device_name, device_type
        )

    def publish_state(self, device_id, state_dict):
        """Publish device state JSON to the shared state topic."""
        if not self._config.get("ha_discovery_enabled", True):
            return

        topic = f"rapt2mqtt/{device_id}/state"
        self._mqtt.publish(topic, json.dumps(state_dict), qos=0, retain=True)

    def remove_device(self, device_id):
        """Remove all discovered entities by publishing empty retained payloads."""
        prefix = self._config.get("ha_discovery_prefix", "homeassistant")
        sanitized = self._sanitize_id(device_id)
        node_id = f"rapt2mqtt_{sanitized}"

        # Determine which entity lists could apply — just clear both to be safe
        all_entities = RAPT_CONTROLLER_ENTITIES + TILT_HYDROMETER_ENTITIES
        cleared = set()
        for entity in all_entities:
            component = entity["component"]
            object_id = entity["object_id"]
            key = (component, object_id)
            if key in cleared:
                continue
            cleared.add(key)

            topic = f"{prefix}/{component}/{node_id}/{object_id}/config"
            self._mqtt.publish(topic, "", qos=0, retain=True)
            self._published_entities.discard(topic)

        self._logger.info("HA discovery removed for device %s", device_id)

    def setup_lwt(self, mqtt_client):
        """Configure the MQTT Last Will and Testament before connecting."""
        mqtt_client.will_set("rapt2mqtt/status", "offline", qos=1, retain=True)

    def publish_online(self):
        """Announce that RAPT2MQTT is online."""
        self._mqtt.publish("rapt2mqtt/status", "online", qos=0, retain=True)
