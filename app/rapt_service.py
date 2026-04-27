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
    TILT_TOPIC = "TiltPi"

    def __init__(self, config, logger, history=None):
        self._config = config
        self._logger = logger
        self._history = history
        self._stop_event = threading.Event()
        self._thread = None
        self._mqtt_client = None
        self._devices = {}  # id -> full device dict
        self._devices_lock = threading.Lock()
        self._headers = {
            "Accept": "application/json",
        }
        # TILT change detection — only record to history on meaningful change
        self._tilt_last = {}  # device_id -> {temp, sg, time}
        # Controller runtime tracking — infer heating/cooling from deltas
        self._ctrl_last_runtimes = {}  # device_id -> {cooling, heating}

    @staticmethod
    def _rssi_bucket(rssi):
        """Convert RSSI dBm value to 1-5 signal quality bucket."""
        if rssi is None:
            return 0
        v = int(rssi)
        if v >= -40:
            return 5
        if v >= -50:
            return 4
        if v >= -60:
            return 3
        if v >= -70:
            return 2
        return 1

    @property
    def is_running(self):
        return self._thread is not None and self._thread.is_alive()

    @property
    def devices(self):
        with self._devices_lock:
            return dict(self._devices)

    def update_config(self, config):
        self._config = config

    def start(self):
        if self.is_running:
            self._logger.warning("Bridge is already running.")
            return

        self._logger.info("Starting RAPT2MQTT bridge...")
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def stop(self):
        if not self.is_running:
            self._logger.warning("Bridge is not running.")
            return

        self._logger.info("Stopping RAPT2MQTT bridge...")
        self._stop_event.set()
        if self._thread:
            self._thread.join(timeout=10)
        self._logger.info("Bridge stopped.")

    def _run(self):
        try:
            self._mqtt_client = mqtt.Client()

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

            poll_interval = int(self._config.get("poll_interval", 300))

            while not self._stop_event.is_set():
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

                self._stop_event.wait(timeout=poll_interval)

        except Exception as e:
            self._logger.error(f"Bridge failed to start: {e}")
        finally:
            if self._mqtt_client:
                try:
                    self._mqtt_client.loop_stop()
                    self._mqtt_client.disconnect()
                except Exception:
                    pass
            self._stop_event.set()
            self._logger.info("Bridge thread exited.")

    def _on_connect(self, client, userdata, flags, rc):
        if rc == 0:
            self._logger.info("Connected to MQTT broker.")
            client.subscribe(self.COMMAND_TOPIC)
            self._logger.info(f"Subscribed to {self.COMMAND_TOPIC}")
            client.subscribe(self.TILT_TOPIC)
            self._logger.info(f"Subscribed to {self.TILT_TOPIC}")
        else:
            self._logger.error(f"MQTT connection failed with code {rc}")

    def _on_disconnect(self, client, userdata, rc):
        if rc != 0:
            self._logger.warning(f"MQTT disconnected unexpectedly (rc={rc}). Will auto-reconnect.")

    def _on_message(self, client, userdata, msg):
        try:
            if msg.topic == self.TILT_TOPIC:
                self._handle_tilt_message(msg)
                return

            payload = msg.payload.decode("utf-8")
            target_temp = json.loads("{" + payload + "}")
            target_temp = target_temp["Temperature"]
            self._logger.info(f"New temperature requested: {target_temp}")
            self._set_temperature(target_temp)
        except Exception as e:
            self._logger.error(f"Error processing MQTT command: {e}")

    def _handle_tilt_message(self, msg):
        """Process incoming TILT hydrometer data with RSSI bucketing and change detection."""
        try:
            payload = json.loads(msg.payload.decode("utf-8"))

            if "sg" in payload:
                sg = float(payload["sg"])
                temp_c = round((float(payload.get("temperature_raw", 0)) - 32) * 5 / 9, 1)
                temp_f = float(payload.get("temperature_raw", 0))
                color = payload.get("color", "Unknown")
                beer = payload.get("beer", "")
                rssi = payload.get("rssi")
                mac = payload.get("mac", "")
                uuid_str = payload.get("uuid", "")
            elif "major" in payload and "minor" in payload:
                temp_f = float(payload["major"])
                sg = float(payload["minor"]) / 1000.0
                temp_c = round((temp_f - 32) * 5 / 9, 1)
                color = "Unknown"
                beer = ""
                rssi = None
                mac = ""
                uuid_str = ""
            else:
                return

            device_id = "tilt-hydrometer"
            name = f"TILT {color}" if color != "Unknown" else "TILT Hydrometer"
            if beer and beer.lower() not in ("", "untitled"):
                name += f" ({beer})"

            device = {
                "id": device_id,
                "name": name,
                "deviceType": "TILT",
                "temperature": temp_c,
                "temperature_f": temp_f,
                "specificGravity": sg,
                "connectionState": "Connected",
                "tempUnit": "C",
                "macAddress": mac,
                "rssi": rssi,
                "tiltColor": color,
                "tiltBeer": beer,
                "tiltUuid": uuid_str,
                "_last_seen": datetime.now().isoformat(),
                "_source": "mqtt",
            }

            # Always update in-memory device (cheap, keeps UI responsive)
            with self._devices_lock:
                self._devices[device_id] = device

            # Record to history: require value change AND 60s minimum interval
            # (RSSI bounces wildly across buckets; don't let it flood the DB)
            last = self._tilt_last.get(device_id, {})
            now = time.time()
            elapsed = now - last.get("time", 0)

            temp_changed = abs(temp_c - last.get("temp", float("inf"))) > 0.1
            sg_changed = abs(sg - last.get("sg", float("inf"))) > 0.0005

            if (temp_changed or sg_changed) and elapsed >= 60:
                self._tilt_last[device_id] = {
                    "temp": temp_c,
                    "sg": sg,
                    "time": now,
                }

                self._logger.info(
                    f"TILT {color} | Temp: {temp_f}\u00b0F ({temp_c}\u00b0C) | SG: {round(sg * 1000)}"
                )

                if self._history:
                    self._history.record(device_id, {
                        "temperature": temp_c,
                        "temperature_f": temp_f,
                        "specificGravity": sg * 1000,
                        "rssi": rssi if rssi else None,
                    })

        except Exception as e:
            self._logger.error(f"Error processing TILT message: {e}")

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

        with self._devices_lock:
            for controller in response:
                cid = controller["id"]
                controller["_last_seen"] = datetime.now().isoformat()

                # Infer actual heating/cooling mode from runtime deltas
                cool_rt = controller.get("coolingRunTime", 0)
                heat_rt = controller.get("heatingRunTime", 0)
                prev = self._ctrl_last_runtimes.get(cid)
                if prev:
                    controller["_cooling_active"] = cool_rt > prev["cooling"]
                    controller["_heating_active"] = heat_rt > prev["heating"]
                else:
                    # First poll — can't tell yet, assume idle
                    controller["_cooling_active"] = False
                    controller["_heating_active"] = False
                self._ctrl_last_runtimes[cid] = {"cooling": cool_rt, "heating": heat_rt}

                self._devices[cid] = controller

        controller = response[0]
        device_id = controller["id"]
        current_temp = "%.2f" % controller["temperature"]
        target_temp = "%.2f" % controller["targetTemperature"]
        name = controller.get("name", "Unknown")
        cooling = controller.get("_cooling_active", False)
        heating = controller.get("_heating_active", False)
        mode = "Cooling" if cooling else ("Heating" if heating else "Idle")

        self._logger.info(
            f"{datetime.now().strftime('%B %d - %H:%M')} | "
            f"{name} | "
            f"Current: {current_temp}\u00b0C | Target: {target_temp}\u00b0C | Mode: {mode}"
        )

        payload = json.dumps({
            "device_id": device_id,
            "name": name,
            "current_temp": current_temp,
            "target_temp": target_temp,
            "cooling_active": cooling,
            "heating_active": heating,
            "connection_state": controller.get("connectionState", "Unknown"),
            "rssi": controller.get("rssi", 0),
        })
        self._mqtt_client.publish(self.PUBLISH_TOPIC, payload)

        if self._history:
            for ctrl in response:
                cid = ctrl["id"]
                self._history.record(cid, {
                    "temperature": ctrl.get("temperature"),
                    "targetTemperature": ctrl.get("targetTemperature"),
                    "rssi": ctrl.get("rssi"),
                    "coolingActive": 1 if ctrl.get("_cooling_active") else 0,
                    "heatingActive": 1 if ctrl.get("_heating_active") else 0,
                })

        return device_id

    # --- Public control methods ---

    def set_target_temperature(self, target, device_id=None):
        """Set target temperature. Used by brew feedback loop and control tab."""
        if not device_id:
            with self._devices_lock:
                for did, dev in self._devices.items():
                    if dev.get("deviceType") != "TILT":
                        device_id = did
                        break
        if not device_id:
            self._logger.error("Cannot set temperature: no controller found.")
            return
        self._set_temperature_for_device(round(float(target), 1), device_id)

    def set_pid_enabled(self, state, device_id):
        """Enable or disable PID control on a RAPT controller."""
        url = f"{self.API_ENDPOINT}TemperatureControllers/SetPIDEnabled"
        payload = {"temperatureControllerId": device_id, "state": bool(state)}
        self._logger.info(f"Setting PID {'enabled' if state else 'disabled'}...")
        r = requests.post(url, data=payload, headers=self._headers)
        r.raise_for_status()
        self._logger.info(f"PID set: {r.json()}")
        time.sleep(2)
        self._update_mqtt()

    def set_pid_values(self, device_id, p, i, d):
        """Set PID tuning parameters on a RAPT controller."""
        url = f"{self.API_ENDPOINT}TemperatureControllers/SetPID"
        payload = {"temperatureControllerId": device_id, "p": p, "i": i, "d": d}
        self._logger.info(f"Setting PID P={p} I={i} D={d}...")
        r = requests.post(url, data=payload, headers=self._headers)
        r.raise_for_status()
        self._logger.info(f"PID values set: {r.json()}")
        time.sleep(2)
        self._update_mqtt()

    def publish_notification(self, title, message, icon="mdi:beer"):
        """Publish an MQTT notification for Home Assistant / HACS."""
        if not self._mqtt_client:
            self._logger.warning("Cannot publish notification: MQTT not connected")
            return
        topic = self._config.get("notification_topic", "RAPT2MQTT/notify")
        payload = json.dumps({
            "title": title,
            "message": message,
            "icon": icon,
            "timestamp": datetime.now().isoformat(),
        })
        self._mqtt_client.publish(topic, payload)
        self._logger.info(f"Notification: {title} - {message}")

    def _set_temperature(self, target):
        """Set target temperature via MQTT command (legacy)."""
        device_id = self._update_mqtt()
        if not device_id:
            self._logger.error("Cannot set temperature: no controller found.")
            return
        self._set_temperature_for_device(target, device_id)

    def _set_temperature_for_device(self, target, device_id):
        """Set target temperature on a specific RAPT controller."""
        url = f"{self.API_ENDPOINT}TemperatureControllers/SetTargetTemperature"
        payload = {
            "temperatureControllerId": device_id,
            "target": target,
        }

        self._logger.info(f"Setting target temperature to {target}\u00b0C...")
        r = requests.post(url, data=payload, headers=self._headers)
        r.raise_for_status()
        response = r.json()
        self._logger.info(f"Set temperature response: {response}")

        time.sleep(5)
        self._update_mqtt()
