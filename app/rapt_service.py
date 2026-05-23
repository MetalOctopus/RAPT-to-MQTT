import json
import time
import threading
import requests
import paho.mqtt.client as mqtt
from datetime import datetime

from app.config import TOKEN_FILE
from app.ha_discovery import HADiscovery


class RaptBridge:
    """RAPT API to MQTT bridge service."""

    API_ENDPOINT = "https://api.rapt.io/api/"
    TOKEN_URL = "https://id.rapt.io/connect/token"
    PUBLISH_TOPIC = "RAPT/temperatureController"
    COMMAND_TOPIC = "RAPT/temperatureController/Command"
    TILT_TOPIC = "TiltPi"
    TILT_TOPIC_WILDCARD = "TiltPi/#"

    # Map iBeacon UUID color bytes to TILT color names
    TILT_UUID_COLORS = {
        "10": "Red", "20": "Green", "30": "Black", "40": "Purple",
        "50": "Orange", "60": "Blue", "70": "Yellow", "80": "Pink",
    }

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
        # Home Assistant MQTT auto-discovery
        self._ha_discovery = HADiscovery(None, self._config, self._logger)

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

    def restore_known_devices(self):
        """Load known devices from DB so they appear on dashboard before first ping."""
        if not self._history:
            return
        known = self._history.get_known_devices()

        # Clean up phantom "tilt-unknown" if a proper tilt-{color} device exists.
        # This happens when iBeacon-format messages slip through before the enriched
        # flow data arrives (startup race condition).
        has_named_tilt = any(
            kd["device_id"].startswith("tilt-") and kd["device_id"] != "tilt-unknown"
            for kd in known
        )
        if has_named_tilt:
            phantoms = [kd for kd in known if kd["device_id"] == "tilt-unknown"]
            for p in phantoms:
                self._history.forget_device(p["device_id"])
                self._logger.info("Cleaned up phantom 'tilt-unknown' device (proper Tilt device exists).")
            known = [kd for kd in known if kd["device_id"] != "tilt-unknown"]

        with self._devices_lock:
            for kd in known:
                device_id = kd["device_id"]
                if device_id in self._devices:
                    continue  # Already have live data
                try:
                    last_state = json.loads(kd["last_state"]) if kd["last_state"] else {}
                except (json.JSONDecodeError, TypeError):
                    last_state = {}
                last_state["_stale"] = True
                last_state["_last_seen"] = datetime.fromtimestamp(kd["last_seen"]).isoformat()
                last_state["_nickname"] = kd.get("nickname")
                last_state["_photo_path"] = kd.get("photo_path")
                if not last_state.get("id"):
                    last_state["id"] = device_id
                if not last_state.get("name"):
                    last_state["name"] = kd.get("nickname") or kd["name"]
                self._devices[device_id] = last_state
        if known:
            self._logger.info(f"Restored {len(known)} known device(s) from database.")

    def start(self):
        if self.is_running:
            self._logger.warning("Bridge is already running.")
            return

        self._logger.info("Starting RAPT2MQTT bridge...")
        self.restore_known_devices()
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

            # Wire HA discovery to the MQTT client before connecting
            self._ha_discovery._mqtt = self._mqtt_client
            if self._config.get("ha_discovery_enabled"):
                self._ha_discovery.setup_lwt(self._mqtt_client)

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
            client.subscribe(self.TILT_TOPIC_WILDCARD)
            self._logger.info(f"Subscribed to {self.TILT_TOPIC} and {self.TILT_TOPIC_WILDCARD}")
            # HA MQTT discovery: announce online and publish configs for known devices
            if self._config.get("ha_discovery_enabled"):
                self._ha_discovery.publish_online()
                for did, dev in list(self._devices.items()):
                    dtype = "TILT Hydrometer" if dev.get("deviceType") == "TILT" else "RAPT Temperature Controller"
                    dname = dev.get("_nickname") or dev.get("name") or dev.get("tiltColor", "Unknown")
                    self._ha_discovery.publish_discovery(did, dtype, dname)
                client.subscribe("rapt2mqtt/+/set_target")
                self._logger.info("Subscribed to rapt2mqtt/+/set_target (HA target temp)")
        else:
            self._logger.error(f"MQTT connection failed with code {rc}")

    def _on_disconnect(self, client, userdata, rc):
        if rc != 0:
            self._logger.warning(f"MQTT disconnected unexpectedly (rc={rc}). Will auto-reconnect.")

    def _on_message(self, client, userdata, msg):
        try:
            # HA discovery: handle set_target commands from Home Assistant
            topic = msg.topic
            if topic.startswith("rapt2mqtt/") and topic.endswith("/set_target"):
                try:
                    parts = topic.split("/")
                    device_id = parts[1]
                    target = float(msg.payload.decode())
                    self._logger.info(f"HA set_target: {device_id} -> {target}°C")
                    self.set_target_temperature(target, device_id)
                except (ValueError, IndexError) as e:
                    self._logger.warning(f"Invalid set_target: {e}")
                return

            if msg.topic == self.TILT_TOPIC or msg.topic.startswith("TiltPi/"):
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

            # Enriched format from upgraded TiltPi flow (per-colour topic)
            if "gravity" in payload and "color" in payload:
                sg = float(payload["gravity"])
                temp_c = round(float(payload["temperature"]), 1)
                temp_f = round(temp_c * 9 / 5 + 32, 1)
                color = payload.get("color", "Unknown")
                beer = payload.get("beerName", "")
                rssi = payload.get("rssi")
                mac = payload.get("mac", "")
                uuid_str = ""
                tx_power = payload.get("txPower")
                is_pro = payload.get("isProModel", False)
                calibrated = payload.get("calibrated", False)
                tilt_timestamp = payload.get("timestamp")
            # Legacy format (sg + temperature_raw in Fahrenheit)
            elif "sg" in payload:
                sg = float(payload["sg"])
                temp_c = round((float(payload.get("temperature_raw", 0)) - 32) * 5 / 9, 1)
                temp_f = float(payload.get("temperature_raw", 0))
                color = payload.get("color", "Unknown")
                beer = payload.get("beer", "")
                rssi = payload.get("rssi")
                mac = payload.get("mac", "")
                uuid_str = payload.get("uuid", "")
                tx_power = payload.get("tx_power")
                is_pro = payload.get("is_pro", False)
                calibrated = payload.get("calibrated", False)
                tilt_timestamp = payload.get("timestamp")
            # Raw iBeacon format (major/minor) — backward compat from upgraded flow
            # or from stock TiltPi. If we're getting enriched per-colour messages,
            # skip the flat topic duplicate to avoid a phantom "tilt-unknown" device.
            elif "major" in payload and "minor" in payload:
                if msg.topic == self.TILT_TOPIC:
                    # Skip if any proper tilt-{color} device already exists
                    # (in-memory OR in DB) — prevents startup race creating tilt-unknown
                    has_named_tilt = any(
                        did.startswith("tilt-") and did != "tilt-unknown"
                        for did in self._devices
                    )
                    if not has_named_tilt and self._history:
                        known = self._history.get_known_devices()
                        has_named_tilt = any(
                            kd["device_id"].startswith("tilt-") and kd["device_id"] != "tilt-unknown"
                            for kd in known
                        )
                    if has_named_tilt:
                        return  # enriched/legacy flow is active, skip flat duplicate

                # Try to extract color from UUID (iBeacon includes it)
                uuid_str = payload.get("uuid", "")
                color = "Unknown"
                if uuid_str and uuid_str.startswith("a495bb") and len(uuid_str) >= 8:
                    color_byte = uuid_str[6:8]
                    color = self.TILT_UUID_COLORS.get(color_byte, "Unknown")

                temp_f = float(payload["major"])
                sg = float(payload["minor"]) / 1000.0
                temp_c = round((temp_f - 32) * 5 / 9, 1)
                beer = ""
                rssi = payload.get("rssi")
                mac = payload.get("mac", "")
                tx_power = payload.get("tx_power")
                is_pro = False
                calibrated = False
                tilt_timestamp = None
            else:
                return

            device_id = f"tilt-{color.lower()}" if color != "Unknown" else "tilt-unknown"
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
                "txPower": tx_power,
                "isProModel": is_pro,
                "calibrated": calibrated,
                "tiltTimestamp": tilt_timestamp,
                "_last_seen": datetime.now().isoformat(),
                "_stale": False,
                "_source": "mqtt",
            }

            # Always update in-memory device (cheap, keeps UI responsive)
            with self._devices_lock:
                old = self._devices.get(device_id)
                if old and old.get("_nickname"):
                    device["_nickname"] = old["_nickname"]
                self._devices[device_id] = device

            last = self._tilt_last.get(device_id, {})
            last["rx_count"] = last.get("rx_count", 0) + 1
            now = time.time()

            temp_changed = abs(temp_c - last.get("temp", float("inf"))) > 0.1
            sg_changed = abs(sg - last.get("sg", float("inf"))) > 0.0005

            # Temp/SG: record immediately on change — no time gate
            if temp_changed or sg_changed:
                rx = last.get("rx_count", 1)
                elapsed = now - last.get("time", 0)
                reason = []
                if temp_changed:
                    reason.append(f"temp {last.get('temp', '?')}\u2192{temp_c}")
                if sg_changed:
                    reason.append(f"SG {last.get('sg', 0):.3f}\u2192{sg:.3f}")

                self._logger.info(
                    f"TILT {color} | {temp_c}\u00b0C ({temp_f}\u00b0F) | "
                    f"SG: {sg:.3f} | "
                    f"Recorded ({', '.join(reason)}) [{rx} msgs/{elapsed:.0f}s]"
                )

                last.update({"temp": temp_c, "sg": sg, "time": now, "rx_count": 0})
                if self._history:
                    self._history.record(device_id, {
                        "temperature": temp_c,
                        "temperature_f": temp_f,
                        "specificGravity": sg,
                    })

            # RSSI: record on its own lazy timer (every 5 min)
            rssi_elapsed = now - last.get("rssi_time", 0)
            if rssi is not None and rssi_elapsed >= 300:
                last["rssi_time"] = now
                if self._history:
                    self._history.record(device_id, {"rssi": rssi})

            self._tilt_last[device_id] = last

            # Persist to known_devices so it survives restarts
            if self._history:
                self._history.save_known_device(
                    device_id, "tilt", name,
                    json.dumps({k: v for k, v in device.items() if not k.startswith("_")})
                )

            # Publish HA discovery state for this Tilt
            if self._config.get("ha_discovery_enabled"):
                ha_state = {
                    "temperature": round(device.get("temperature", 0), 1),
                    "specificGravity": round(device.get("specificGravity", 1.0), 4),
                    "rssi": device.get("rssi", 0),
                }
                dname = device.get("_nickname") or device.get("tiltColor", "Unknown")
                self._ha_discovery.publish_discovery(device_id, "TILT Hydrometer", dname)
                self._ha_discovery.publish_state(device_id, ha_state)

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
                controller["_stale"] = False

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

                # Preserve nickname from previous state
                old = self._devices.get(cid)
                if old and old.get("_nickname"):
                    controller["_nickname"] = old["_nickname"]
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
                # mode: -1 = cooling, 0 = idle, 1 = heating (graphable integer)
                if ctrl.get("_cooling_active"):
                    mode_val = -1
                elif ctrl.get("_heating_active"):
                    mode_val = 1
                else:
                    mode_val = 0
                self._history.record(cid, {
                    "temperature": ctrl.get("temperature"),
                    "targetTemperature": ctrl.get("targetTemperature"),
                    "rssi": ctrl.get("rssi"),
                    "mode": mode_val,
                })
                # Persist to known_devices so it survives restarts
                self._history.save_known_device(
                    cid, "controller", ctrl.get("name", "Unknown"),
                    json.dumps({k: v for k, v in ctrl.items() if not k.startswith("_")})
                )
                # Publish HA discovery state for this controller
                if self._config.get("ha_discovery_enabled"):
                    ha_state = {
                        "temperature": round(ctrl.get("temperature", 0), 1),
                        "targetTemperature": round(ctrl.get("targetTemperature", 0), 1),
                        "_cooling_active": ctrl.get("_cooling_active", False),
                        "_heating_active": ctrl.get("_heating_active", False),
                        "rssi": ctrl.get("rssi", 0),
                        "connectionState": ctrl.get("connectionState", "Unknown"),
                    }
                    dname = ctrl.get("_nickname") or ctrl.get("name", "Controller")
                    self._ha_discovery.publish_discovery(cid, "RAPT Temperature Controller", dname)
                    self._ha_discovery.publish_state(cid, ha_state)

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
            return {"sent": target, "confirmed": None, "error": "No controller found"}
        return self._set_temperature_for_device(round(float(target), 1), device_id)

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

    def publish_notification(self, title, message, icon="mdi:beer", important=False):
        """Publish an MQTT notification for Home Assistant."""
        level = self._config.get("notification_level", "all")
        if level == "off":
            return
        if level == "important" and not important:
            return
        if not self._mqtt_client:
            self._logger.warning("Cannot publish notification: MQTT not connected")
            return
        target_device = self._config.get("notification_target_device", "").strip()
        if not target_device:
            self._logger.debug("Notification skipped: no notification_target_device configured")
            return
        payload = json.dumps({
            "title": title,
            "message": message,
            "icon": icon,
            "target_device": target_device,
            "timestamp": datetime.now().isoformat(),
        })
        self._mqtt_client.publish("homeassistant_notifications", payload)
        self._logger.info(f"Notification: {title} - {message}")

    def _set_temperature(self, target):
        """Set target temperature via MQTT command (legacy)."""
        device_id = self._update_mqtt()
        if not device_id:
            self._logger.error("Cannot set temperature: no controller found.")
            return
        self._set_temperature_for_device(target, device_id)

    def _set_temperature_for_device(self, target, device_id):
        """Set target temperature on a specific RAPT controller.
        Returns dict with sent/confirmed values, or None on failure."""
        url = f"{self.API_ENDPOINT}TemperatureControllers/SetTargetTemperature"
        payload = {
            "temperatureControllerId": device_id,
            "target": target,
        }

        self._logger.info(f"Setting target temperature to {target}\u00b0C...")
        try:
            r = requests.post(url, data=payload, headers=self._headers)
            r.raise_for_status()
            response = r.json()
            self._logger.info(f"RAPT API response: {response} (HTTP {r.status_code})")
        except Exception as e:
            self._logger.error(f"RAPT API rejected target {target}\u00b0C: {e}")
            return {"sent": target, "confirmed": None, "error": str(e)}

        # Re-poll with retries — RAPT firmware can take 10-15s to apply changes
        for attempt in range(3):
            time.sleep(5)
            self._update_mqtt()
            with self._devices_lock:
                ctrl = self._devices.get(device_id)
            confirmed = ctrl.get("targetTemperature") if ctrl else None
            if confirmed is not None and abs(confirmed - target) <= 0.15:
                self._logger.info(f"Confirmed: controller target is now {confirmed}\u00b0C (attempt {attempt + 1})")
                return {"sent": target, "confirmed": confirmed, "error": None}
            self._logger.info(
                f"Verify attempt {attempt + 1}/3: sent {target}\u00b0C, controller reports {confirmed}\u00b0C"
            )

        self._logger.warning(
            f"Sent {target}\u00b0C but controller still reports {confirmed}\u00b0C after 3 checks"
        )
        return {"sent": target, "confirmed": confirmed, "error": None}
