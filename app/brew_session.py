"""Brew session management with multi-brew support, reminders, and smart temperature feedback."""

import json
import time
import threading
import uuid
from datetime import datetime


class BrewSession:
    """Manages multiple concurrent brew sessions with per-session feedback loops."""

    def __init__(self, history, bridge, logger):
        self._history = history
        self._bridge = bridge
        self._logger = logger
        self._active_sessions = {}  # id -> session dict
        self._feedback_threads = {}  # id -> (thread, stop_event)
        self._reminder_thread = None
        self._reminder_stop = threading.Event()
        self._load_active()
        self._start_reminder_checker()

    def _load_active(self):
        """Restore active sessions from DB on startup."""
        for sid, data_json in self._history.list_sessions():
            session = json.loads(data_json)
            if session.get("status") == "active":
                self._active_sessions[session["id"]] = session
                if session.get("temp_feedback_enabled"):
                    self._start_feedback_loop(session["id"])

    @property
    def active(self):
        """Backward compat: return first active session or None."""
        if self._active_sessions:
            return next(iter(self._active_sessions.values()))
        return None

    @property
    def active_sessions(self):
        return dict(self._active_sessions)

    def start_brew(self, name, tilt_device_id=None, controller_device_id=None,
                   target_beer_temp=None, og=None, notes="", temp_source="hydrometer"):
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
            "temp_source": temp_source,
        }

        self._history.save_session(session_id, json.dumps(session))
        self._history.add_event(session_id, "brew_started", f"Started: {name}")
        self._active_sessions[session_id] = session
        self._logger.info(f"Brew session started: {name} ({session_id})")
        return session

    def update_session(self, session_id, updates):
        session = self._active_sessions.get(session_id)
        if not session:
            raise ValueError(f"No active brew session with id {session_id}.")

        for key in ["name", "target_beer_temp", "og", "fg", "notes",
                     "tilt_device_id", "controller_device_id",
                     "temp_feedback_gain", "temp_feedback_interval",
                     "temp_feedback_min", "temp_feedback_max", "temp_feedback_deadband",
                     "temp_source"]:
            if key in updates:
                session[key] = updates[key]

        self._history.save_session(session["id"], json.dumps(session))
        return session

    def add_event(self, session_id, event_type, description=""):
        session = self._active_sessions.get(session_id)
        if not session:
            raise ValueError(f"No active brew session with id {session_id}.")
        self._history.add_event(session_id, event_type, description)
        self._logger.info(f"Brew event: {event_type} - {description}")

    def complete_brew(self, session_id, fg=None, notes=""):
        session = self._active_sessions.get(session_id)
        if not session:
            raise ValueError(f"No active brew session with id {session_id}.")

        self._stop_feedback(session_id)
        session["status"] = "completed"
        session["completed_at"] = datetime.now().isoformat()
        if fg is not None:
            session["fg"] = fg
        if notes:
            session["notes"] = (session.get("notes", "") + "\n" + notes).strip()

        self._history.save_session(session["id"], json.dumps(session))
        self._history.add_event(session["id"], "brew_completed", f"FG: {fg}")
        self._logger.info(f"Brew completed: {session['name']}")
        del self._active_sessions[session_id]
        return session

    def cancel_brew(self, session_id):
        session = self._active_sessions.get(session_id)
        if not session:
            raise ValueError(f"No active brew session with id {session_id}.")

        self._stop_feedback(session_id)
        session["status"] = "cancelled"
        session["completed_at"] = datetime.now().isoformat()
        self._history.save_session(session["id"], json.dumps(session))
        self._history.add_event(session["id"], "brew_cancelled", "Session cancelled")
        self._logger.info(f"Brew cancelled: {session['name']}")
        del self._active_sessions[session_id]

    def get_brew_status(self, session_id=None):
        """Get current brew status with live device data."""
        if session_id:
            session = self._active_sessions.get(session_id)
        else:
            session = self.active
        if not session:
            return None

        session = dict(session)
        devices = self._bridge.devices

        tilt_id = session.get("tilt_device_id")
        if tilt_id and tilt_id in devices:
            tilt = devices[tilt_id]
            sg = tilt.get("specificGravity")
            session["current_sg"] = sg
            session["beer_temp"] = tilt.get("temperature")
            session["tilt_name"] = tilt.get("name", "Hydrometer")
            if sg and session.get("og"):
                session["current_abv"] = round((session["og"] - sg) * 131.25, 2)

        ctrl_id = session.get("controller_device_id")
        if ctrl_id and ctrl_id in devices:
            ctrl = devices[ctrl_id]
            session["fridge_temp"] = ctrl.get("temperature")
            session["controller_target"] = ctrl.get("targetTemperature")
            session["controller_name"] = ctrl.get("name", "Controller")
            session["compressor_delay"] = ctrl.get("compressorDelay")
            session["cooling_hysteresis"] = ctrl.get("coolingHysteresis")
            session["heating_hysteresis"] = ctrl.get("heatingHysteresis")
            session["cooling_active"] = ctrl.get("_cooling_active", False)
            session["heating_active"] = ctrl.get("_heating_active", False)

        # Last feedback action
        fb_log = self._history.get_temp_feedback_log(session["id"], limit=1)
        if fb_log:
            last = fb_log[-1]
            session["last_feedback"] = {
                "timestamp": last["timestamp"],
                "beer_temp": last["beer_temp"],
                "fridge_temp": last["fridge_temp"],
                "target_beer_temp": last["target_beer_temp"],
                "old_target": last["old_controller_target"],
                "new_target": last["new_controller_target"],
                "error": last["error"],
                "adjustment": last["adjustment"],
            }

        session["events"] = self._history.get_events(session["id"])
        session["reminders"] = self._history.get_reminders(session["id"])
        return session

    def get_all_active(self):
        """Get all active brews with live data."""
        result = []
        for sid in list(self._active_sessions.keys()):
            status = self.get_brew_status(sid)
            if status:
                result.append(status)
        return result

    # --- Smart Temperature Feedback (per-session) ---

    def start_feedback(self, session_id):
        session = self._active_sessions.get(session_id)
        if not session:
            raise ValueError(f"No active brew session with id {session_id}.")
        session["temp_feedback_enabled"] = True
        self._history.save_session(session["id"], json.dumps(session))
        self._start_feedback_loop(session_id)
        self._logger.info(f"Smart temperature feedback enabled for {session['name']}.")

    def stop_feedback(self, session_id):
        self._stop_feedback(session_id)
        session = self._active_sessions.get(session_id)
        if session:
            session["temp_feedback_enabled"] = False
            self._history.save_session(session["id"], json.dumps(session))
        self._logger.info("Smart temperature feedback disabled.")

    def _start_feedback_loop(self, session_id):
        if session_id in self._feedback_threads:
            thread, stop_event = self._feedback_threads[session_id]
            if thread.is_alive():
                return
        stop_event = threading.Event()
        thread = threading.Thread(
            target=self._feedback_loop, args=(session_id, stop_event), daemon=True
        )
        self._feedback_threads[session_id] = (thread, stop_event)
        thread.start()

    def _stop_feedback(self, session_id):
        if session_id in self._feedback_threads:
            thread, stop_event = self._feedback_threads[session_id]
            if thread.is_alive():
                stop_event.set()
                thread.join(timeout=10)
            del self._feedback_threads[session_id]

    def _feedback_loop(self, session_id, stop_event):
        """Cascaded control: adjust controller target based on TILT beer temp."""
        self._logger.info(f"Feedback loop started for session {session_id}.")
        while not stop_event.is_set():
            try:
                session = self._active_sessions.get(session_id)
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
                    stop_event.wait(timeout=60)
                    continue

                devices = self._bridge.devices
                tilt = devices.get(tilt_id)
                ctrl = devices.get(ctrl_id)

                if not tilt or not ctrl:
                    self._logger.warning("Feedback: waiting for device data...")
                    stop_event.wait(timeout=60)
                    continue

                # Which sensor provides "beer temp" for the feedback calculation?
                # The loop adjusts the controller's TARGET so that measured
                # beer temp converges on the brew's desired beer temp.
                temp_source = session.get("temp_source", "hydrometer")
                if temp_source == "controller":
                    beer_temp = ctrl.get("temperature") if ctrl else None
                elif temp_source == "mean":
                    t_tilt = tilt.get("temperature") if tilt else None
                    t_ctrl = ctrl.get("temperature") if ctrl else None
                    if t_tilt is not None and t_ctrl is not None:
                        beer_temp = round((t_tilt + t_ctrl) / 2, 1)
                    else:
                        beer_temp = t_tilt if t_tilt is not None else t_ctrl
                else:  # "hydrometer" (default) -- sensor is IN the liquid
                    beer_temp = tilt.get("temperature") if tilt else None

                fridge_temp = ctrl.get("temperature") if ctrl else None
                current_target = ctrl.get("targetTemperature")

                if beer_temp is None or current_target is None:
                    stop_event.wait(timeout=60)
                    continue

                error = target_beer - beer_temp
                adjustment = error * gain
                new_target = round(target_beer + adjustment, 1)
                new_target = max(temp_min, min(temp_max, new_target))

                if abs(new_target - current_target) > deadband:
                    self._logger.info(
                        f"Feedback: beer={beer_temp}\u00b0C target={target_beer}\u00b0C "
                        f"error={error:+.1f}\u00b0C | "
                        f"fridge {current_target}\u00b0C \u2192 {new_target}\u00b0C"
                    )
                    self._bridge.set_target_temperature(new_target, ctrl_id)
                    self._history.log_temp_feedback(
                        session["id"], beer_temp, fridge_temp, target_beer,
                        current_target, new_target, error, adjustment
                    )
                else:
                    self._logger.info(
                        f"Feedback: beer={beer_temp}\u00b0C (target {target_beer}\u00b0C) "
                        f"- within deadband, no adjustment"
                    )

                interval = session.get("temp_feedback_interval", 300)
                stop_event.wait(timeout=interval)

            except Exception as e:
                self._logger.error(f"Feedback loop error: {e}")
                stop_event.wait(timeout=60)

        self._logger.info(f"Feedback loop stopped for session {session_id}.")

    # --- Reminders ---

    def _start_reminder_checker(self):
        self._reminder_stop.clear()
        self._reminder_thread = threading.Thread(target=self._reminder_loop, daemon=True)
        self._reminder_thread.start()

    def _reminder_loop(self):
        """Check reminders every 60s and fire MQTT notifications."""
        while not self._reminder_stop.is_set():
            try:
                for sid, session in list(self._active_sessions.items()):
                    reminders = self._history.get_reminders(sid)
                    for r in reminders:
                        if r["fired"]:
                            continue
                        if self._should_fire_reminder(session, r):
                            self._fire_reminder(session, r)
            except Exception as e:
                self._logger.error(f"Reminder check error: {e}")
            self._reminder_stop.wait(timeout=60)

    def _should_fire_reminder(self, session, reminder):
        if reminder["reminder_type"] == "day":
            started = datetime.fromisoformat(session["started_at"])
            days_elapsed = (datetime.now() - started).total_seconds() / 86400
            return days_elapsed >= reminder["trigger_value"]
        elif reminder["reminder_type"] == "sg_stable":
            return self._is_sg_stable(session, reminder["trigger_value"])
        return False

    def _is_sg_stable(self, session, days_required):
        """Check if SG has been stable (within 2 points) for N days."""
        tilt_id = session.get("tilt_device_id")
        if not tilt_id:
            return False
        end = time.time()
        start = end - (days_required * 86400)
        data = self._history.query(tilt_id, "specificGravity", start=start, end=end, limit=10000)
        if len(data) < 10:
            return False
        values = [d["value"] for d in data]
        sg_range = max(values) - min(values)
        return sg_range <= 2  # stable within 2 SG points (e.g. 1050 vs 1052)

    def _fire_reminder(self, session, reminder):
        self._history.mark_reminder_fired(reminder["id"])
        msg = reminder["message"]
        icon = reminder.get("icon", "mdi:beer")
        title = f"{session['name']} - Alert"
        self._logger.info(f"Reminder fired: {title} - {msg}")
        self._bridge.publish_notification(title, msg, icon)
        self._history.add_event(session["id"], "reminder_fired", msg)
