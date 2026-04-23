import json
import time
import threading
import requests
import paho.mqtt.client as mqtt
from datetime import datetime

from app.config import TOKEN_FILE


class RaptBridge:
    """RAPT API to MQTT bridge service."""

    API_ENDPOINT = "https://api.rapt.io/api/"
    TOKEN_URL = "https://id.rapt.io/connect/token"
    PUBLISH_TOPIC = "RAPT/temperatureController"
    COMMAND_TOPIC = "RAPT/temperatureController/Command"

    def __init__(self, config, logger):
        self._config = config
        self._logger = logger
        self._running = threading.Event()
        self._thread = None
        self._mqtt_client = None
        self._headers = {
            "Accept": "application/json",
        }

    @property
    def is_running(self):
        return self._running.is_set()

    def update_config(self, config):
        self._config = config

    def start(self):
        if self._running.is_set():
            self._logger.warning("Bridge is already running.")
            return

        self._logger.info("Starting RAPT2MQTT bridge...")
        self._running.set()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def stop(self):
        if not self._running.is_set():
            self._logger.warning("Bridge is not running.")
            return

        self._logger.info("Stopping RAPT2MQTT bridge...")
        self._running.clear()
        if self._thread:
            self._thread.join(timeout=10)
        self._logger.info("Bridge stopped.")

    def _run(self):
        try:
            self._mqtt_client = mqtt.Client()

            # Set MQTT credentials if provided
            username = self._config.get("mqtt_username", "")
            password = self._config.get("mqtt_password", "")
            if username:
                self._mqtt_client.username_pw_set(username, password)

            self._mqtt_client.on_connect = self._on_connect
            self._mqtt_client.on_disconnect = self._on_disconnect
            self._mqtt_client.on_message = self._on_message
            self._mqtt_client.reconnect_delay_set(min_delay=1, max_delay=120)

            mqtt_host = self._config["mqtt_host"]
            mqtt_port = int(self._config.get("mqtt_port", 1883))

            self._logger.info(f"Connecting to MQTT broker at {mqtt_host}:{mqtt_port}...")
            self._mqtt_client.connect(mqtt_host, mqtt_port, keepalive=60)
            self._mqtt_client.loop_start()

            poll_interval = int(self._config.get("poll_interval", 60))

            while self._running.is_set():
                try:
                    token = self._retrieve_token()
                    self._headers["Authorization"] = f"Bearer {token}"
                    self._update_mqtt()
                except requests.HTTPError as e:
                    self._logger.error(f"RAPT API error: {e}")
                except requests.ConnectionError as e:
                    self._logger.error(f"Connection error: {e}")
                except Exception as e:
                    self._logger.error(f"Unexpected error in poll loop: {e}")

                # Wait for poll_interval, but wake up immediately if stop() is called
                self._running.wait(timeout=poll_interval)
                if not self._running.is_set():
                    break

        except Exception as e:
            self._logger.error(f"Bridge failed to start: {e}")
        finally:
            if self._mqtt_client:
                try:
                    self._mqtt_client.loop_stop()
                    self._mqtt_client.disconnect()
                except Exception:
                    pass
            self._running.clear()
            self._logger.info("Bridge thread exited.")

    def _on_connect(self, client, userdata, flags, rc):
        if rc == 0:
            self._logger.info("Connected to MQTT broker.")
            client.subscribe(self.COMMAND_TOPIC)
            self._logger.info(f"Subscribed to {self.COMMAND_TOPIC}")
        else:
            self._logger.error(f"MQTT connection failed with code {rc}")

    def _on_disconnect(self, client, userdata, rc):
        if rc != 0:
            self._logger.warning(f"MQTT disconnected unexpectedly (rc={rc}). Will auto-reconnect.")

    def _on_message(self, client, userdata, msg):
        try:
            payload = msg.payload.decode("utf-8")
            # Original format: payload is "Temperature" : "xx.xx" (without braces)
            target_temp = json.loads("{" + payload + "}")
            target_temp = target_temp["Temperature"]
            self._logger.info(f"New temperature requested: {target_temp}")
            self._set_temperature(target_temp)
        except Exception as e:
            self._logger.error(f"Error processing MQTT command: {e}")

    def _update_token(self):
        """Request a new auth token from the RAPT API."""
        self._logger.info("Requesting new API token...")

        headers = {
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
        }

        payload = {
            "client_id": "rapt-user",
            "grant_type": "password",
            "username": self._config["rapt_email"],
            "password": self._config["rapt_secret"],
        }

        r = requests.post(self.TOKEN_URL, data=payload, headers=headers)
        r.raise_for_status()

        response = r.json()
        token = response["access_token"]
        timestamp = str(int(time.time()))

        with open(TOKEN_FILE, "w") as f:
            f.write(timestamp + "\n")
            f.write(token)

        self._logger.info("Token renewed.")

    def _retrieve_token(self):
        """Read cached token, refresh if expired."""
        try:
            with open(TOKEN_FILE, "r") as f:
                content = f.readlines()
            token_age = time.time() - float(content[0].strip())
            remaining = round(60 - token_age / 60)
            self._logger.info(f"Token valid for ~{remaining} minutes.")
            if token_age > 3400:
                self._update_token()
                with open(TOKEN_FILE, "r") as f:
                    content = f.readlines()
        except (FileNotFoundError, IndexError, ValueError):
            self._update_token()
            with open(TOKEN_FILE, "r") as f:
                content = f.readlines()

        return content[1].strip()

    def _update_mqtt(self):
        """Poll RAPT API and publish temperature data to MQTT."""
        url = f"{self.API_ENDPOINT}TemperatureControllers/GetTemperatureControllers"
        r = requests.get(url, headers=self._headers)
        r.raise_for_status()
        response = r.json()

        if not response:
            self._logger.warning("No temperature controllers found.")
            return None

        controller = response[0]
        device_id = controller["id"]
        current_temp = "%.2f" % controller["temperature"]
        target_temp = "%.2f" % controller["targetTemperature"]

        self._logger.info(
            f"{datetime.now().strftime('%B %d - %H:%M')} | "
            f"Device: {device_id[:8]}... | "
            f"Current: {current_temp}°C | Target: {target_temp}°C"
        )

        # Publish to MQTT using the persistent client connection
        payload = json.dumps({
            "device_id": device_id,
            "current_temp": current_temp,
            "target_temp": target_temp,
        })
        self._mqtt_client.publish(self.PUBLISH_TOPIC, payload)

        return device_id

    def _set_temperature(self, target):
        """Set target temperature on the RAPT controller."""
        device_id = self._update_mqtt()
        if not device_id:
            self._logger.error("Cannot set temperature: no controller found.")
            return

        url = f"{self.API_ENDPOINT}TemperatureControllers/SetTargetTemperature"
        payload = {
            "temperatureControllerId": device_id,
            "target": target,
        }

        r = requests.post(url, data=payload, headers=self._headers)
        r.raise_for_status()
        response = r.json()
        self._logger.info(f"Set temperature response: {response}")

        # Give RAPT a moment to update, then publish new readings
        time.sleep(5)
        self._update_mqtt()
