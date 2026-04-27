"""Number platform for BEER2MQTT — the control entity.

This is the ONE control entity in the integration. It lets HA set the
target temperature for a RAPT controller.

The clever part — feedback-aware routing:
─────────────────────────────────────────
When the user changes this number in HA, we publish the value to
rapt2mqtt/{device_id}/set_target. The RAPT2MQTT bridge receives it
and routes it intelligently:

  1. If NO active brew session or feedback is OFF:
     → Sets the fridge target directly via RAPT API.
     → This is what you'd expect: "set fridge to 4°C".

  2. If a brew session has smart feedback ENABLED:
     → Updates the brew's BEER target temperature.
     → The feedback loop then calculates and sets the fridge target.
     → This is the right abstraction: HA controls what matters (beer
       temp), and the control loop handles the fridge.

From the HA user's perspective, this number always means "desired
temperature". Whether that's fridge temp or beer temp depends on
whether smart feedback is running — and the user doesn't need to
care about the distinction.

Why only one control entity:
────────────────────────────
- RAPT2MQTT already has the full control UI (brew sessions, PID tuning,
  feedback loop, device config). HA doesn't need to duplicate all of that.
- Adding mode control (heat/cool/auto) would conflict with the controller's
  own logic and the feedback loop.
- Adding PID tuning to HA would be dangerous — one wrong value and the
  compressor cycles destructively.
- One number entity for target temp is the 90% use case: quick adjustment
  from a phone without opening the RAPT2MQTT web UI.
"""

import json
import logging

from homeassistant.components import mqtt
from homeassistant.components.number import NumberEntity, NumberMode
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers.entity import DeviceInfo
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import (
    DOMAIN,
    TOPIC_STATUS,
    TOPIC_SET_TARGET_SUFFIX,
    DEVICE_TYPE_CONTROLLER,
    MANUFACTURER_KEGLAND,
)

_LOGGER = logging.getLogger(__name__)


async def async_setup_entry(
    hass: HomeAssistant,
    entry: ConfigEntry,
    async_add_entities: AddEntitiesCallback,
) -> None:
    """Set up BEER2MQTT number entities (target temperature control)."""
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

            if device_type != DEVICE_TYPE_CONTROLLER:
                continue
            if not device_id or not state_topic:
                continue
            if device_id in known:
                continue

            entity = Beer2MqttTargetTemp(
                entry=entry,
                device_id=device_id,
                device_name=device_name,
                state_topic=state_topic,
            )
            known[device_id] = entity
            new_entities.append(entity)

        if new_entities:
            async_add_entities(new_entities)

    hass.bus.async_listen(f"{DOMAIN}_discovery", _handle_discovery)


class Beer2MqttTargetTemp(NumberEntity):
    """Number entity for setting the target temperature.

    - Reads current value from the controller's state topic (target_temperature key)
    - Writes new values to rapt2mqtt/{device_id}/set_target
    - Range: 0-35°C, step 0.5°C (matches RAPT controller range)
    - Availability tracks the bridge LWT
    """

    _attr_has_entity_name = True
    _attr_should_poll = False
    _attr_name = "Target Temperature"
    _attr_icon = "mdi:thermometer-chevron-up"
    _attr_native_unit_of_measurement = "°C"
    _attr_native_min_value = 0.0
    _attr_native_max_value = 35.0
    _attr_native_step = 0.5
    _attr_mode = NumberMode.BOX

    def __init__(self, entry, device_id, device_name, state_topic):
        self._entry = entry
        self._device_id = device_id
        self._device_name = device_name
        self._state_topic = state_topic
        self._command_topic = f"rapt2mqtt/{device_id}{TOPIC_SET_TARGET_SUFFIX}"

        self._attr_unique_id = f"beer2mqtt_{device_id}_set_target"
        self._attr_native_value = None

    @property
    def device_info(self) -> DeviceInfo:
        return DeviceInfo(
            identifiers={(DOMAIN, self._device_id)},
            name=self._device_name,
            manufacturer=MANUFACTURER_KEGLAND,
            model="RAPT Temperature Controller",
            via_device=(DOMAIN, "rapt2mqtt_bridge"),
        )

    async def async_added_to_hass(self):
        """Subscribe to state updates for the current target value."""

        @callback
        def _handle_state(msg):
            try:
                payload = json.loads(msg.payload)
            except (json.JSONDecodeError, TypeError):
                return
            target = payload.get("target_temperature")
            if target is not None:
                self._attr_native_value = round(float(target), 1)
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

    async def async_set_native_value(self, value: float) -> None:
        """Publish the new target temperature to RAPT2MQTT.

        The bridge receives this on rapt2mqtt/{device_id}/set_target
        and routes it based on whether smart feedback is active:
        - Feedback OFF: sets fridge target directly via RAPT API
        - Feedback ON: updates the brew's beer target, loop handles the rest
        """
        _LOGGER.info(
            "BEER2MQTT: Setting target to %.1f°C on %s",
            value, self._device_name
        )
        await mqtt.async_publish(
            self.hass,
            self._command_topic,
            str(round(value, 1)),
            qos=1,
            retain=False,
        )
        # Optimistically update the displayed value
        self._attr_native_value = round(value, 1)
        self.async_write_ha_state()
