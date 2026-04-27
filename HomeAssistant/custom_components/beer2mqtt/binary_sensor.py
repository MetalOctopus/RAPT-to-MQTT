"""Binary sensor platform for BEER2MQTT.

Binary sensors created:
- Controller: Connection state (connected/disconnected)
- Brew session: Feedback active (on/off)

These follow the same discovery → subscribe → update pattern as
the regular sensors (see sensor.py for detailed explanation).
"""

import json
import logging

from homeassistant.components import mqtt
from homeassistant.components.binary_sensor import (
    BinarySensorDeviceClass,
    BinarySensorEntity,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import (
    DOMAIN,
    TOPIC_STATUS,
    DEVICE_TYPE_CONTROLLER,
    DEVICE_TYPE_BREW,
    MANUFACTURER_KEGLAND,
    MANUFACTURER_BRIDGE,
)

_LOGGER = logging.getLogger(__name__)

# Binary sensor definitions per device type
# key: JSON key in state payload
# value: entity config
CONTROLLER_BINARY_SENSORS = {
    "connection_state": {
        "name": "Connection",
        "device_class": BinarySensorDeviceClass.CONNECTIVITY,
        "icon": "mdi:lan-connect",
        "payload_on": "Connected",
    },
}

BREW_BINARY_SENSORS = {
    "feedback_active": {
        "name": "Smart Feedback",
        "device_class": BinarySensorDeviceClass.RUNNING,
        "icon": "mdi:sync",
        "payload_on": True,
    },
}


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up BEER2MQTT binary sensors."""
    known: dict[str, object] = {}

    @callback
    def _handle_discovery(event):
        devices = event.data.get("devices", [])
        new_entities = []

        for device in devices:
            device_id = device.get("id")
            device_type = device.get("type")
            device_name = device.get("name", "Unknown")
            state_topic = device.get("state_topic")

            if not device_id or not state_topic:
                continue

            if device_type == DEVICE_TYPE_CONTROLLER:
                defs = CONTROLLER_BINARY_SENSORS
                manufacturer = MANUFACTURER_KEGLAND
                model = "RAPT Temperature Controller"
            elif device_type == DEVICE_TYPE_BREW:
                defs = BREW_BINARY_SENSORS
                manufacturer = MANUFACTURER_BRIDGE
                model = "Brew Session"
            else:
                continue

            for key, bdef in defs.items():
                uid = f"{device_id}_{key}"
                if uid in known:
                    continue

                entity = Beer2MqttBinarySensor(
                    entry=entry,
                    device_id=device_id,
                    device_name=device_name,
                    manufacturer=manufacturer,
                    model=model,
                    sensor_key=key,
                    sensor_def=bdef,
                    state_topic=state_topic,
                )
                known[uid] = entity
                new_entities.append(entity)

        if new_entities:
            async_add_entities(new_entities)

    hass.bus.async_listen(f"{DOMAIN}_discovery", _handle_discovery)


class Beer2MqttBinarySensor(BinarySensorEntity):
    """Binary sensor entity for BEER2MQTT."""

    _attr_has_entity_name = True
    _attr_should_poll = False

    def __init__(self, entry, device_id, device_name, manufacturer, model,
                 sensor_key, sensor_def, state_topic):
        self._device_id = device_id
        self._device_name = device_name
        self._manufacturer = manufacturer
        self._model = model
        self._sensor_key = sensor_key
        self._state_topic = state_topic
        self._payload_on = sensor_def.get("payload_on", True)

        self._attr_name = sensor_def["name"]
        self._attr_unique_id = f"beer2mqtt_{device_id}_{sensor_key}"
        self._attr_icon = sensor_def.get("icon")
        self._attr_device_class = sensor_def.get("device_class")
        self._attr_is_on = None

    @property
    def device_info(self) -> DeviceInfo:
        return DeviceInfo(
            identifiers={(DOMAIN, self._device_id)},
            name=self._device_name,
            manufacturer=self._manufacturer,
            model=self._model,
            via_device=(DOMAIN, "rapt2mqtt_bridge"),
        )

    async def async_added_to_hass(self):
        @callback
        def _handle_state(msg):
            try:
                payload = json.loads(msg.payload)
            except (json.JSONDecodeError, TypeError):
                return
            value = payload.get(self._sensor_key)
            if value is not None:
                self._attr_is_on = value == self._payload_on
                self.async_write_ha_state()

        @callback
        def _handle_status(msg):
            self._attr_available = msg.payload == "online"
            self.async_write_ha_state()

        self._unsub_state = await mqtt.async_subscribe(
            self.hass, self._state_topic, _handle_state, qos=0
        )
        self._unsub_status = await mqtt.async_subscribe(
            self.hass, TOPIC_STATUS, _handle_status, qos=1
        )

    async def async_will_remove_from_hass(self):
        if self._unsub_state:
            self._unsub_state()
        if self._unsub_status:
            self._unsub_status()
