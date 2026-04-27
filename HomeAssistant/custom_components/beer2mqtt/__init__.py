"""BEER2MQTT — Home Assistant integration for RAPT2MQTT brewing bridge.

How this integration works:
──────────────────────────
1. User installs via HACS and adds the integration in HA Settings.
2. Config flow asks for nothing — the integration auto-discovers devices
   via MQTT topics published by the RAPT2MQTT Docker container.
3. On startup, we subscribe to:
   - rapt2mqtt/status          → bridge online/offline (LWT)
   - rapt2mqtt/discovery       → device manifest (list of all devices)
   - rapt2mqtt/+/state         → per-device state updates
   - rapt2mqtt/brew/+/state    → active brew session updates
4. When a discovery message arrives, we create/update HA device entries
   and their associated sensor/binary_sensor/number entities.
5. When state messages arrive, we update entity values.
6. When the bridge goes offline (LWT), all entities show "unavailable".

The RAPT2MQTT bridge handles all the hard work:
- Polling the RAPT cloud API for controller data
- Receiving TILT BLE data via TiltPi MQTT
- Running the smart temperature feedback loop
- Managing brew sessions, history, and notifications

This integration is a thin MQTT client that turns that data into
native HA entities. No cloud API calls, no polling, no business logic.
"""

import json
import logging

from homeassistant.components import mqtt
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import device_registry as dr

from .const import (
    DOMAIN,
    TOPIC_STATUS,
    TOPIC_DISCOVERY,
    DEVICE_TYPE_CONTROLLER,
    DEVICE_TYPE_TILT,
    DEVICE_TYPE_BREW,
    MANUFACTURER_KEGLAND,
    MANUFACTURER_TILT,
    MANUFACTURER_BRIDGE,
)

_LOGGER = logging.getLogger(__name__)

PLATFORMS = ["sensor", "binary_sensor", "number"]


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Set up BEER2MQTT from a config entry.

    This is called when the user adds the integration via the HA UI.
    We subscribe to the RAPT2MQTT MQTT topics and wait for discovery.
    """
    hass.data.setdefault(DOMAIN, {})
    hass.data[DOMAIN][entry.entry_id] = {
        "devices": {},       # device_id -> device manifest dict
        "unsub": [],         # MQTT unsubscribe callbacks
        "entities": {},      # device_id -> {sensor_key -> entity}
    }

    # Register the RAPT2MQTT bridge itself as a device in HA
    dev_reg = dr.async_get(hass)
    dev_reg.async_get_or_create(
        config_entry_id=entry.entry_id,
        identifiers={(DOMAIN, "rapt2mqtt_bridge")},
        name="RAPT2MQTT Bridge",
        manufacturer=MANUFACTURER_BRIDGE,
        model="RAPT2MQTT",
        sw_version="1.0.0",
    )

    # Forward setup to each platform (sensor, binary_sensor, number)
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)

    # Subscribe to MQTT topics
    data = hass.data[DOMAIN][entry.entry_id]

    @callback
    def _handle_status(msg):
        """Handle bridge online/offline LWT messages."""
        status = msg.payload
        _LOGGER.info("RAPT2MQTT bridge is %s", status)
        # Availability is handled per-entity via the availability topic

    @callback
    def _handle_discovery(msg):
        """Handle device discovery manifest from RAPT2MQTT.

        The discovery payload is a JSON object:
        {
          "devices": [
            {
              "id": "a1b2c3d4-...",
              "type": "controller",
              "name": "Fermenter",
              "state_topic": "rapt2mqtt/a1b2c3d4-.../state"
            },
            {
              "id": "tilt_blue",
              "type": "tilt",
              "name": "TILT BLUE",
              "color": "Blue",
              "state_topic": "rapt2mqtt/tilt_blue/state"
            },
            {
              "id": "brew_abc123",
              "type": "brew",
              "name": "Black IPA",
              "session_id": "abc123",
              "state_topic": "rapt2mqtt/brew/abc123/state"
            }
          ]
        }

        When we receive this, we update the device registry and fire
        an event so platforms can add/remove entities.
        """
        try:
            payload = json.loads(msg.payload)
        except (json.JSONDecodeError, TypeError):
            _LOGGER.error("Invalid discovery payload: %s", msg.payload)
            return

        devices = payload.get("devices", [])
        _LOGGER.info("BEER2MQTT discovery: %d devices", len(devices))

        for device in devices:
            device_id = device.get("id")
            device_type = device.get("type")
            device_name = device.get("name", "Unknown")

            if not device_id or not device_type:
                continue

            # Register device in HA device registry
            if device_type == DEVICE_TYPE_CONTROLLER:
                manufacturer = MANUFACTURER_KEGLAND
                model = "RAPT Temperature Controller"
            elif device_type == DEVICE_TYPE_TILT:
                manufacturer = MANUFACTURER_TILT
                model = "TILT Hydrometer"
            elif device_type == DEVICE_TYPE_BREW:
                manufacturer = MANUFACTURER_BRIDGE
                model = "Brew Session"
            else:
                manufacturer = MANUFACTURER_BRIDGE
                model = "Unknown"

            dev_reg.async_get_or_create(
                config_entry_id=entry.entry_id,
                identifiers={(DOMAIN, device_id)},
                name=device_name,
                manufacturer=manufacturer,
                model=model,
                via_device=(DOMAIN, "rapt2mqtt_bridge"),
            )

            data["devices"][device_id] = device

        # Signal platforms to refresh entities
        hass.bus.async_fire(f"{DOMAIN}_discovery", {"devices": devices})

    # Subscribe to MQTT topics
    unsub_status = await mqtt.async_subscribe(
        hass, TOPIC_STATUS, _handle_status, qos=1
    )
    unsub_discovery = await mqtt.async_subscribe(
        hass, TOPIC_DISCOVERY, _handle_discovery, qos=1
    )
    data["unsub"].extend([unsub_status, unsub_discovery])

    _LOGGER.info("BEER2MQTT integration set up, waiting for discovery...")
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """Unload BEER2MQTT config entry."""
    # Unsubscribe from MQTT
    data = hass.data[DOMAIN].get(entry.entry_id, {})
    for unsub in data.get("unsub", []):
        unsub()

    # Unload platforms
    unload_ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if unload_ok:
        hass.data[DOMAIN].pop(entry.entry_id, None)

    return unload_ok
