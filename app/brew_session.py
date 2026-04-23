"""Brew session management and smart temperature feedback."""

import json
import time
import threading
import uuid
from datetime import datetime


class BrewSession:
    """Manages a brew session with optional smart temperature feedback."""

    def __init__(self, history, bridge, logger):
        self._history = history
        self._bridge = bridge
        self._logger = logger
        self._feedback_thread = None
        self._feedback_stop = threading.Event()
        self._active_session = None
        self._load_active()

    def _load_active(self):
        """Restore active session from DB on startup."""
        for sid, data_json in self._history.list_sessions():
            session = json.loads(data_json)
            if session.get("status") == "active":
                self._active_session = session
                if session.get("temp_feedback_enabled"):
                    self._start_feedback_loop()
                break

    @property
    def active(self):
        return self._active_session

    def start_brew(self, name, tilt_device_id=None, controller_device_id=None,
                   target_beer_temp=None, og=None, notes=""):
        if self._active_session:
            raise ValueError("A brew session is already active. Complete or cancel it first.")

        session_id = str(uuid.uuid4())[:8]
        session = {
            "id": session_id,
            "name": name,
            "status": "active",
            "started_at": datetime.now().isoformat(),
            "completed_at": None,
            "tilt_device_id": tilt_device_id,
            "controller_device_id": controller_device_id,
            "target_beer_temp": target_beer_temp,
            "og": og,
            "fg": None,
            "current_sg": None,
            "current_abv": None,
            "notes": notes,
            "temp_feedback_enabled": False,
            "temp_feedback_gain": 1.5,
            "temp_feedback_interval": 300,
            "temp_feedback_min": 0.0,
            "temp_feedback_max": 35.0,
            "temp_feedback_deadband": 0.3,
        }

        self._history.save_session(session_id, json.dumps(session))
        self._history.add_event(session_id, "brew_started", f"Started: {name}")
        self._active_session = session
        self._logger.info(f"Brew session started: {name} ({session_id})")
        return session

    def update_session(self, updates):
        if not self._active_session:
            raise ValueError("No active brew session.")

        session = self._active_session
        for key in ["name", "target_beer_temp", "og", "fg", "notes",
                     "tilt_device_id", "controller_device_id",
                     "temp_feedback_gain", "temp_feedback_interval",
                     "temp_feedback_min", "temp_feedback_max", "temp_feedback_deadband"]:
            if key in updates:
                session[key] = updates[key]

        self._history.save_session(session["id"], json.dumps(session))
        return session

    def add_event(self, event_type, description=""):
        if not self._active_session:
            raise ValueError("No active brew session.")
        self._history.add_event(self._active_session["id"], event_type, description)
        self._logger.info(f"Brew event: {event_type} - {description}")

    def complete_brew(self, fg=None, notes=""):
        if not self._active_session:
            raise ValueError("No active brew session.")

        self.stop_feedback()
        session = self._active_session
        session["status"] = "completed"
        session["completed_at"] = datetime.now().isoformat()
        if fg is not None:
            session["fg"] = fg
        if notes:
            session["notes"] = (session.get("notes", "") + "\n" + notes).strip()

        self._history.save_session(session["id"], json.dumps(session))
        self._history.add_event(session["id"], "brew_completed", f"FG: {fg}")
        self._logger.info(f"Brew completed: {session['name']}")
        self._active_session = None
        return session

    def cancel_brew(self):
        if not self._active_session:
            raise ValueError("No active brew session.")

        self.stop_feedback()
        session = self._active_session
        session["status"] = "cancelled"
        session["completed_at"] = datetime.now().isoformat()
        self._history.save_session(session["id"], json.dumps(session))
        self._history.add_event(session["id"], "brew_cancelled", "Session cancelled")
        self._logger.info(f"Brew cancelled: {session['name']}")
        self._active_session = None

    def get_brew_status(self):
        """Get current brew status with live device data."""
        if not self._active_session:
            return None

        session = dict(self._active_session)
        devices = self._bridge.devices

        # Get live TILT data
        tilt_id = session.get("tilt_device_id")
        if tilt_id and tilt_id in devices:
            tilt = devices[tilt_id]
            sg = tilt.get("specificGravity")
            session["current_sg"] = sg
            if sg and session.get("og"):
                session["current_abv"] = round((session["og"] - sg) * 131.25, 2)

        # Get live controller data
        ctrl_id = session.get("controller_device_id")
        if ctrl_id and ctrl_id in devices:
            ctrl = devices[ctrl_id]
            session["fridge_temp"] = ctrl.get("temperature")
            session["controller_target"] = ctrl.get("targetTemperature")

        session["events"] = self._history.get_events(session["id"])
        return session

    # --- Smart Temperature Feedback ---

    def start_feedback(self):
        if not self._active_session:
            raise ValueError("No active brew session.")
        self._active_session["temp_feedback_enabled"] = True
        self._history.save_session(self._active_session["id"],
                                   json.dumps(self._active_session))
        self._start_feedback_loop()
        self._logger.info("Smart temperature feedback enabled.")

    def stop_feedback(self):
        if self._feedback_thread and self._feedback_thread.is_alive():
            self._feedback_stop.set()
            self._feedback_thread.join(timeout=10)
        self._feedback_stop.clear()
        self._feedback_thread = None
        if self._active_session:
            self._active_session["temp_feedback_enabled"] = False
            self._history.save_session(self._active_session["id"],
                                       json.dumps(self._active_session))
        self._logger.info("Smart temperature feedback disabled.")

    def _start_feedback_loop(self):
        if self._feedback_thread and self._feedback_thread.is_alive():
            return
        self._feedback_stop.clear()
        self._feedback_thread = threading.Thread(target=self._feedback_loop, daemon=True)
        self._feedback_thread.start()

    def _feedback_loop(self):
        """Cascaded control: adjust controller target based on TILT beer temp."""
        self._logger.info("Temperature feedback loop started.")
        while not self._feedback_stop.is_set():
            try:
                session = self._active_session
                if not session or session["status"] != "active":
                    break

                target_beer = session.get("target_beer_temp")
                tilt_id = session.get("tilt_device_id")
                ctrl_id = session.get("controller_device_id")
                gain = session.get("temp_feedback_gain", 1.5)
                deadband = session.get("temp_feedback_deadband", 0.3)
                temp_min = session.get("temp_feedback_min", 0.0)
                temp_max = session.get("temp_feedback_max", 35.0)

                if not all([target_beer, tilt_id, ctrl_id]):
                    self._feedback_stop.wait(timeout=60)
                    continue

                devices = self._bridge.devices
                tilt = devices.get(tilt_id)
                ctrl = devices.get(ctrl_id)

                if not tilt or not ctrl:
                    self._logger.warning("Feedback: waiting for device data...")
                    self._feedback_stop.wait(timeout=60)
                    continue

                beer_temp = tilt.get("temperature")
                fridge_temp = ctrl.get("temperature")
                current_target = ctrl.get("targetTemperature")

                if beer_temp is None or current_target is None:
                    self._feedback_stop.wait(timeout=60)
                    continue

                error = target_beer - beer_temp
                adjustment = error * gain
                new_target = round(target_beer + adjustment, 1)

                # Clamp to safe range
                new_target = max(temp_min, min(temp_max, new_target))

                # Only adjust if change exceeds deadband
                if abs(new_target - current_target) > deadband:
                    self._logger.info(
                        f"Feedback: beer={beer_temp}°C target={target_beer}°C "
                        f"error={error:+.1f}°C | "
                        f"fridge {current_target}°C → {new_target}°C"
                    )
                    self._bridge.set_target_temperature(new_target)

                    self._history.log_temp_feedback(
                        session["id"], beer_temp, fridge_temp, target_beer,
                        current_target, new_target, error, adjustment
                    )
                else:
                    self._logger.info(
                        f"Feedback: beer={beer_temp}°C (target {target_beer}°C) "
                        f"- within deadband, no adjustment"
                    )

                interval = session.get("temp_feedback_interval", 300)
                self._feedback_stop.wait(timeout=interval)

            except Exception as e:
                self._logger.error(f"Feedback loop error: {e}")
                self._feedback_stop.wait(timeout=60)

        self._logger.info("Temperature feedback loop stopped.")
