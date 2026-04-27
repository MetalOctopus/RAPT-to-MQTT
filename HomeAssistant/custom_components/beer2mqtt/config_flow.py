"""Config flow for BEER2MQTT.

Why this is so simple:
─────────────────────
BEER2MQTT discovers everything via MQTT. There's nothing to configure.
The RAPT2MQTT Docker container publishes device manifests to MQTT, and
this integration subscribes to them. The user just clicks "Add Integration"
and it works.

We don't ask for:
- RAPT API credentials (RAPT2MQTT handles that)
- MQTT broker details (HA already has MQTT configured)
- Device selection (auto-discovered from RAPT2MQTT)

The only requirement is that the user has:
1. MQTT integration set up in HA
2. RAPT2MQTT Docker container running and connected to the same MQTT broker
3. "Enable Home Assistant Discovery" toggled on in RAPT2MQTT config
"""

from homeassistant import config_entries
from homeassistant.core import HomeAssistant
from homeassistant.data_entry_flow import FlowResult

from .const import DOMAIN


class Beer2MqttConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """Handle a config flow for BEER2MQTT.

    This is a zero-config flow. The user adds the integration, we confirm,
    and discovery happens automatically via MQTT.
    """

    VERSION = 1

    async def async_step_user(self, user_input=None) -> FlowResult:
        """Handle the initial step.

        Since there's nothing to configure, we just confirm and create
        the entry. The user sees a simple "Add BEER2MQTT?" confirmation.
        """
        # Prevent duplicate entries
        await self.async_set_unique_id(DOMAIN)
        self._abort_if_unique_id_configured()

        if user_input is not None:
            return self.async_create_entry(title="BEER2MQTT", data={})

        return self.async_show_form(step_id="user")

    async def async_step_mqtt(self, discovery_info) -> FlowResult:
        """Handle MQTT-based auto-discovery.

        When RAPT2MQTT publishes to rapt2mqtt/discovery, HA's MQTT
        integration can trigger this flow automatically. The user sees
        "BEER2MQTT discovered" in their notifications.
        """
        await self.async_set_unique_id(DOMAIN)
        self._abort_if_unique_id_configured()
        return self.async_show_form(step_id="user")
