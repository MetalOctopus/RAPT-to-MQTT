"""Sensor platform for BEER2MQTT.

How sensors are created:
────────────────────────
1. __init__.py subscribes to rapt2mqtt/discovery and fires a
   beer2mqtt_discovery event with the device manifest.
2. This platform listens for that event and creates/updates sensor
   entities for each device based on its type (controller/tilt/brew).
3. Each sensor subscribes to its device's state topic and extracts
   its value from the JSON payload using the key defined in const.py.

Sensor lifecycle:
- Created when a device appears in the discovery manifest
- Updated on every MQTT state message (~every 5 minutes for controllers,
  on-change for TILTs)
- Marked unavailable when the bridge goes offline (LWT)
- Removed when a brew session completes (empty state payload)

Why we don't use HA MQTT Discovery directly:
- We COULD publish discovery JSON from RAPT2MQTT and skip this integration
- But a HACS integration gives us: device grouping, custom services,
  dynamic brew session entities, and a proper config flow
- It also lets us publish brewing-specific entity types that MQTT
  discovery alone can't represent well
"""

import json
import logging

from homeassistant.components import mqtt
from homeassistant.components.sensor import SensorEntity, SensorStateClass
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import (
    DOMAIN,
    TOPIC_STATUS,
    DEVICE_TYPE_CONTROLLER,
    DEVICE_TYPE_TILT,
    DEVICE_TYPE_BREW,
    CONTROLLER_SENSORS,
    TILT_SENSORS,
    BREW_SENSORS,
    MANUFACTURER_KEGLAND,
    MANUFACTURER_TILT,
    MANUFACTURER_BRIDGE,
)

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up BEER2MQTT sensors from a config entry.

    We listen for the discovery event from __init__.py and create sensors
    for each device. We also subscribe to each device's state topic to
    receive live updates.
    """
    data = hass.data[DOMAIN][entry.entry_id]
    known_entities: dict[str, dict] = {}  # f"{device_id}_{key}" -> entity

    @callback
    def _handle_discovery(event):
        """Create sensors for newly discovered devices."""
        devices = event.data.get("devices", [])
        new_entities = []

        for device in devices:
            device_id = device.get("id")
            device_type = device.get("type")
            device_name = device.get("name", "Unknown")
            state_topic = device.get("state_topic")

            if not device_id or not state_topic:
                continue

            # Pick the right sensor definitions for this device type
            if device_type == DEVICE_TYPE_CONTROLLER:
                sensor_defs = CONTROLLER_SENSORS
                manufacturer = MANUFACTURER_KEGLAND
                model = "RAPT Temperature Controller"
            elif device_type == DEVICE_TYPE_TILT:
                sensor_defs = TILT_SENSORS
                manufacturer = MANUFACTURER_TILT
                model = "TILT Hydrometer"
            elif device_type == DEVICE_TYPE_BREW:
                sensor_defs = BREW_SENSORS
                manufacturer = MANUFACTURER_BRIDGE
                model = "Brew Session"
            else:
                continue

            for sensor_key, sensor_def in sensor_defs.items():
                entity_uid = f"{device_id}_{sensor_key}"
                if entity_uid in known_entities:
                    continue  # Already exists

                entity = Beer2MqttSensor(
                    entry=entry,
                    device_id=device_id,
                    device_name=device_name,
                    device_type=device_type,
                    manufacturer=manufacturer,
                    model=model,
                    sensor_key=sensor_key,
                    sensor_def=sensor_def,
                    state_topic=state_topic,
                )
                known_entities[entity_uid] = entity
                new_entities.append(entity)

        if new_entities:
            _LOGGER.info("Adding %d new BEER2MQTT sensors", len(new_entities))
            async_add_entities(new_entities)

    # Listen for discovery events
    hass.bus.async_listen(f"{DOMAIN}_discovery", _handle_discovery)


class Beer2MqttSensor(SensorEntity):
    """A sensor entity backed by an MQTT state topic from RAPT2MQTT.

    Each sensor:
    - Belongs to a device (controller, TILT, or brew session)
    - Reads one key from the device's JSON state payload
    - Uses the bridge LWT topic for availability
    - Has device_class and unit_of_measurement from const.py definitions
    """

    _attr_has_entity_name = True
    _attr_should_poll = False

    def __init__(
        self,
        entry: ConfigEntry,
        device_id: str,
        device_name: str,
        device_type: str,
        manufacturer: str,
        model: str,
        sensor_key: str,
        sensor_def: dict,
        state_topic: str,
    ) -> None:
        """Initialize the sensor.

        Args:
            entry: The config entry this entity belongs to.
            device_id: Unique device identifier (e.g., RAPT UUID, "tilt_blue").
            device_name: Human-readable device name (e.g., "Fermenter", "TILT BLUE").
            device_type: One of "controller", "tilt", "brew".
            manufacturer: Device manufacturer for the HA device registry.
            model: Device model string for the HA device registry.
            sensor_key: The JSON key to extract from the state payload.
            sensor_def: Dict with name, device_class, unit, icon, state_class.
            state_topic: The MQTT topic this device publishes state to.
        """
        self._entry = entry
        self._device_id = device_id
        self._device_name = device_name
        self._device_type = device_type
        self._manufacturer = manufacturer
        self._model = model
        self._sensor_key = sensor_key
        self._state_topic = state_topic
        self._unsub_state = None
        self._unsub_status = None

        # HA entity attributes from the sensor definition
        self._attr_name = sensor_def["name"]
        self._attr_unique_id = f"beer2mqtt_{device_id}_{sensor_key}"
        self._attr_icon = sensor_def.get("icon")
        self._attr_native_unit_of_measurement = sensor_def.get("unit")
        self._attr_native_value = None

        if sensor_def.get("device_class"):
            self._attr_device_class = sensor_def["device_class"]
        if sensor_def.get("state_class"):
            self._attr_state_class = sensor_def["state_class"]

    @property
    def device_info(self) -> DeviceInfo:
        """Return device info for the HA device registry.

        This groups all sensors for the same physical device (e.g.,
        all controller sensors under "Fermenter", all TILT sensors
        under "TILT BLUE"). The via_device links them to the bridge.
        """
        return DeviceInfo(
            identifiers={(DOMAIN, self._device_id)},
            name=self._device_name,
            manufacturer=self._manufacturer,
            model=self._model,
            via_device=(DOMAIN, "rapt2mqtt_bridge"),
        )

    @property
    def available(self) -> bool:
        """Return True if the bridge is online."""
        return self._attr_available

    async def async_added_to_hass(self) -> None:
        """Subscribe to MQTT topics when entity is added to HA.

        We subscribe to two topics:
        1. The device's state topic — for value updates
        2. The bridge status topic — for availability
        """

        @callback
        def _handle_state(msg):
            """Extract this sensor's value from the device state JSON."""
            try:
                payload = json.loads(msg.payload)
            except (json.JSONDecodeError, TypeError):
                return

            value = payload.get(self._sensor_key)
            if value is not None:
                # Round numeric values for clean display
                if isinstance(value, float):
                    if self._attr_device_class == "temperature":
                        value = round(value, 1)
                    elif self._attr_device_class == "signal_strength":
                        value = round(value)
                    else:
                        value = round(value, 3)

                self._attr_native_value = value
                self.async_write_ha_state()

        @callback
        def _handle_status(msg):
            """Update availability based on bridge LWT."""
            self._attr_available = msg.payload == "online"
            self.async_write_ha_state()

        self._unsub_state = await mqtt.async_subscribe(
            self.hass, self._state_topic, _handle_state, qos=0
        )
        self._unsub_status = await mqtt.async_subscribe(
            self.hass, TOPIC_STATUS, _handle_status, qos=1
        )

    async def async_will_remove_from_hass(self) -> None:
        """Unsubscribe from MQTT when entity is removed."""
        if self._unsub_state:
            self._unsub_state()
        if self._unsub_status:
            self._unsub_status()
