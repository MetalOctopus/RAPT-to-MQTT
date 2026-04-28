import os
import json
import queue
import time
import logging
import logging.handlers
import threading

from flask import Flask, render_template, request, jsonify, Response, send_from_directory
from werkzeug.utils import secure_filename

from app.config import (
    load_config, save_config, is_configured, mask_secret, LOG_DIR, CONFIG_DIR
)
from app.rapt_service import RaptBridge
from app.log_handler import WebLogHandler
from app.history import HistoryStore
from app.brew_session import BrewSession

# --- Logging setup ---
web_log_handler = WebLogHandler(maxlen=1000)
web_log_handler.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s", datefmt="%H:%M:%S"))

logger = logging.getLogger("rapt2mqtt")
logger.setLevel(logging.INFO)
logger.addHandler(web_log_handler)

# Also log to stdout for `docker logs`
stdout_handler = logging.StreamHandler()
stdout_handler.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
logger.addHandler(stdout_handler)

# File handler with daily rotation
os.makedirs(LOG_DIR, exist_ok=True)
file_handler = logging.handlers.TimedRotatingFileHandler(
    os.path.join(LOG_DIR, "rapt2mqtt.log"),
    when="midnight",
    backupCount=7,
)
file_handler.setFormatter(logging.Formatter("%(asctime)s [%(levelname)s] %(message)s"))
logger.addHandler(file_handler)

# --- App setup ---
app = Flask(__name__)
config = load_config()
history = HistoryStore()
bridge = RaptBridge(config=config, logger=logger, history=history)
brew = BrewSession(history=history, bridge=bridge, logger=logger)

# Auto-start if configured
if is_configured(config) and config.get("auto_start", True):
    logger.info("Auto-starting bridge (config found)...")
    bridge.start()


# Periodic DB pruning (daily, 7-day retention)
def _prune_loop():
    while True:
        try:
            history.prune()
            logger.info("Database pruned (7-day retention)")
        except Exception as e:
            logger.error(f"Prune error: {e}")
        time.sleep(86400)

threading.Thread(target=_prune_loop, daemon=True).start()


@app.route("/")
def index():
    return render_template("index.html")


# --- Config ---

@app.route("/api/config", methods=["GET"])
def get_config():
    cfg = load_config()
    cfg["rapt_secret"] = mask_secret(cfg.get("rapt_secret", ""))
    cfg["mqtt_password"] = mask_secret(cfg.get("mqtt_password", ""))
    return jsonify(cfg)


@app.route("/api/config", methods=["POST"])
def post_config():
    data = request.get_json()
    if not data:
        return jsonify({"error": "Invalid JSON"}), 400

    cfg = load_config()

    for key in ["mqtt_host", "mqtt_username", "rapt_email", "notification_topic"]:
        if key in data:
            cfg[key] = data[key]

    if "mqtt_port" in data:
        try:
            cfg["mqtt_port"] = int(data["mqtt_port"])
        except (ValueError, TypeError):
            return jsonify({"error": "mqtt_port must be a number"}), 400

    if "poll_interval" in data:
        try:
            cfg["poll_interval"] = int(data["poll_interval"])
        except (ValueError, TypeError):
            return jsonify({"error": "poll_interval must be a number"}), 400

    if "auto_start" in data:
        cfg["auto_start"] = bool(data["auto_start"])

    if "rapt_secret" in data and not data["rapt_secret"].startswith("*"):
        cfg["rapt_secret"] = data["rapt_secret"]
    if "mqtt_password" in data and not data["mqtt_password"].startswith("*"):
        cfg["mqtt_password"] = data["mqtt_password"]

    save_config(cfg)
    logger.info("Configuration saved.")
    return jsonify({"status": "ok"})


# --- Bridge control ---

@app.route("/api/bridge/start", methods=["POST"])
def start_bridge():
    cfg = load_config()
    if not is_configured(cfg):
        return jsonify({"error": "Missing required configuration (MQTT host, RAPT email, RAPT secret)"}), 400

    if bridge.is_running:
        return jsonify({"status": "already_running"})

    bridge.update_config(cfg)
    bridge.start()
    return jsonify({"status": "started"})


@app.route("/api/bridge/stop", methods=["POST"])
def stop_bridge():
    if not bridge.is_running:
        return jsonify({"status": "already_stopped"})

    bridge.stop()
    return jsonify({"status": "stopped"})


@app.route("/api/bridge/status", methods=["GET"])
def bridge_status():
    return jsonify({"running": bridge.is_running})


# --- Devices ---

@app.route("/api/devices", methods=["GET"])
def get_devices():
    return jsonify(bridge.devices)


@app.route("/api/devices/<device_id>", methods=["GET"])
def get_device(device_id):
    devices = bridge.devices
    if device_id in devices:
        return jsonify(devices[device_id])
    return jsonify({"error": "Device not found"}), 404


@app.route("/api/devices/<device_id>/set_temperature", methods=["POST"])
def device_set_temperature(device_id):
    data = request.get_json()
    if not data or "target" not in data:
        return jsonify({"error": "Missing 'target' field"}), 400
    try:
        target = round(float(data["target"]), 1)
    except (ValueError, TypeError):
        return jsonify({"error": "target must be a number"}), 400

    devices = bridge.devices
    if device_id not in devices:
        return jsonify({"error": "Device not found"}), 404
    if devices[device_id].get("deviceType") == "TILT":
        return jsonify({"error": "Cannot set temperature on TILT"}), 400

    bridge.set_target_temperature(target, device_id)
    return jsonify({"status": "ok", "target": target})


@app.route("/api/devices/<device_id>/set_pid_enabled", methods=["POST"])
def device_set_pid_enabled(device_id):
    data = request.get_json()
    if not data or "state" not in data:
        return jsonify({"error": "Missing 'state' field"}), 400
    devices = bridge.devices
    if device_id not in devices:
        return jsonify({"error": "Device not found"}), 404
    if devices[device_id].get("deviceType") == "TILT":
        return jsonify({"error": "Cannot set PID on TILT"}), 400
    bridge.set_pid_enabled(data["state"], device_id)
    return jsonify({"status": "ok"})


@app.route("/api/devices/<device_id>/set_pid", methods=["POST"])
def device_set_pid(device_id):
    data = request.get_json()
    if not data:
        return jsonify({"error": "Invalid JSON"}), 400
    for field in ["p", "i", "d"]:
        if field not in data:
            return jsonify({"error": f"Missing '{field}' field"}), 400
    devices = bridge.devices
    if device_id not in devices:
        return jsonify({"error": "Device not found"}), 404
    bridge.set_pid_values(device_id, float(data["p"]), float(data["i"]), float(data["d"]))
    return jsonify({"status": "ok"})


# --- Device Management ---

@app.route("/api/devices/manage", methods=["GET"])
def get_managed_devices():
    """Return all known devices with their live status and management config."""
    live = bridge.devices
    known = history.get_known_devices()
    result = []
    for kd in known:
        did = kd["device_id"]
        entry = {
            "device_id": did,
            "device_type": kd["device_type"],
            "name": kd["name"],
            "nickname": kd.get("nickname"),
            "photo_path": kd.get("photo_path"),
            "last_seen": kd["last_seen"],
            "created_at": kd["created_at"],
            "online": did in live and not live[did].get("_stale", False),
        }
        if did in live:
            entry["live"] = {
                "name": live[did].get("name"),
                "temperature": live[did].get("temperature"),
                "rssi": live[did].get("rssi"),
            }
        result.append(entry)
    return jsonify(result)


@app.route("/api/devices/<device_id>/manage", methods=["POST"])
def update_device_management(device_id):
    """Update nickname or photo for a device."""
    data = request.get_json()
    if not data:
        return jsonify({"error": "Invalid JSON"}), 400
    nickname = data.get("nickname")
    photo_path = data.get("photo_path")
    history.update_device_config(device_id, nickname=nickname, photo_path=photo_path)
    # Update in-memory device so sidebar reflects immediately
    with bridge._devices_lock:
        dev = bridge._devices.get(device_id)
        if dev and nickname is not None:
            dev["_nickname"] = nickname if nickname else None
    return jsonify({"status": "ok"})


@app.route("/api/devices/<device_id>/forget", methods=["POST"])
def forget_device(device_id):
    """Remove a device from known devices. Clears it from sidebar on next refresh."""
    history.forget_device(device_id)
    # Also remove from in-memory devices if present
    with bridge._devices_lock:
        bridge._devices.pop(device_id, None)
    return jsonify({"status": "ok"})


PHOTO_DIR = os.path.join(CONFIG_DIR, "device_photos")
ALLOWED_EXTENSIONS = {"png", "jpg", "jpeg", "gif", "webp"}


@app.route("/api/devices/<device_id>/photo", methods=["POST"])
def upload_device_photo(device_id):
    """Upload a photo for a device."""
    if "photo" not in request.files:
        return jsonify({"error": "No file"}), 400
    f = request.files["photo"]
    if not f.filename:
        return jsonify({"error": "No file selected"}), 400
    ext = f.filename.rsplit(".", 1)[-1].lower() if "." in f.filename else ""
    if ext not in ALLOWED_EXTENSIONS:
        return jsonify({"error": "File type not allowed"}), 400
    os.makedirs(PHOTO_DIR, exist_ok=True)
    safe_id = secure_filename(device_id)
    filename = f"{safe_id}.{ext}"
    # Remove old photos for this device (different extensions)
    for old in os.listdir(PHOTO_DIR):
        if old.startswith(safe_id + "."):
            os.remove(os.path.join(PHOTO_DIR, old))
    filepath = os.path.join(PHOTO_DIR, filename)
    f.save(filepath)
    history.update_device_config(device_id, photo_path=filename)
    return jsonify({"status": "ok", "photo_path": filename})


@app.route("/api/devices/<device_id>/photo", methods=["GET"])
def get_device_photo(device_id):
    """Serve a device photo."""
    safe_id = secure_filename(device_id)
    if not os.path.isdir(PHOTO_DIR):
        return "", 404
    for fname in os.listdir(PHOTO_DIR):
        if fname.startswith(safe_id + "."):
            return send_from_directory(PHOTO_DIR, fname)
    return "", 404


# --- History / Charts ---

@app.route("/api/history/<device_id>/<metric>", methods=["GET"])
def get_history(device_id, metric):
    start = request.args.get("start", type=float)
    end = request.args.get("end", type=float)
    limit = request.args.get("limit", 10000, type=int)
    data = history.query(device_id, metric, start=start, end=end, limit=limit)
    return jsonify(data)


@app.route("/api/history/<device_id>/metrics", methods=["GET"])
def get_device_metrics(device_id):
    return jsonify(history.get_metrics(device_id))


# --- Multi-Brew Sessions ---

@app.route("/api/brews", methods=["GET"])
def get_brews():
    return jsonify(brew.get_all_active())


@app.route("/api/brews/<session_id>", methods=["GET"])
def get_brew_detail(session_id):
    status = brew.get_brew_status(session_id)
    if status:
        return jsonify(status)
    # Fall back to completed/cancelled brews from database
    session_json = history.get_session(session_id)
    if session_json:
        return jsonify(json.loads(session_json))
    return jsonify({"error": "Brew not found"}), 404


@app.route("/api/brews/start", methods=["POST"])
def start_brew_session():
    data = request.get_json() or {}
    try:
        session = brew.start_brew(
            name=data.get("name", "Untitled Brew"),
            tilt_device_id=data.get("tilt_device_id"),
            controller_device_id=data.get("controller_device_id"),
            target_beer_temp=data.get("target_beer_temp"),
            og=data.get("og"),
            notes=data.get("notes", ""),
            temp_source=data.get("temp_source", "hydrometer"),
        )
        return jsonify(session)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400


@app.route("/api/brews/<session_id>/update", methods=["POST"])
def update_brew_session(session_id):
    data = request.get_json()
    if not data:
        return jsonify({"error": "Invalid JSON"}), 400
    try:
        session = brew.update_session(session_id, data)
        return jsonify(session)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400


@app.route("/api/brews/<session_id>/complete", methods=["POST"])
def complete_brew_session(session_id):
    data = request.get_json() or {}
    try:
        session = brew.complete_brew(session_id, fg=data.get("fg"), notes=data.get("notes", ""))
        return jsonify(session)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400


@app.route("/api/brews/<session_id>/cancel", methods=["POST"])
def cancel_brew_session(session_id):
    try:
        brew.cancel_brew(session_id)
        return jsonify({"status": "cancelled"})
    except ValueError as e:
        return jsonify({"error": str(e)}), 400


@app.route("/api/brews/<session_id>/event", methods=["POST"])
def brew_session_event(session_id):
    data = request.get_json()
    if not data or "event_type" not in data:
        return jsonify({"error": "Missing event_type"}), 400
    try:
        brew.add_event(session_id, data["event_type"], data.get("description", ""))
        return jsonify({"status": "ok"})
    except ValueError as e:
        return jsonify({"error": str(e)}), 400


@app.route("/api/brews/<session_id>/feedback/start", methods=["POST"])
def start_brew_feedback(session_id):
    try:
        brew.start_feedback(session_id)
        return jsonify({"status": "started"})
    except ValueError as e:
        return jsonify({"error": str(e)}), 400


@app.route("/api/brews/<session_id>/feedback/stop", methods=["POST"])
def stop_brew_feedback(session_id):
    try:
        brew.stop_feedback(session_id)
        return jsonify({"status": "stopped"})
    except ValueError as e:
        return jsonify({"error": str(e)}), 400


@app.route("/api/brews/<session_id>/feedback/log", methods=["GET"])
def brew_feedback_log(session_id):
    data = history.get_temp_feedback_log(session_id=session_id)
    return jsonify(data)


@app.route("/api/brews/<session_id>/reminder", methods=["POST"])
def add_brew_reminder(session_id):
    data = request.get_json()
    if not data:
        return jsonify({"error": "Invalid JSON"}), 400
    for f in ["message", "reminder_type", "trigger_value"]:
        if f not in data:
            return jsonify({"error": f"Missing required field: {f}"}), 400
    history.add_reminder(
        session_id,
        data["reminder_type"],
        float(data["trigger_value"]),
        data["message"],
        data.get("icon", "mdi:beer"),
    )
    return jsonify({"status": "ok"})


@app.route("/api/brews/<session_id>/reminders", methods=["GET"])
def get_brew_reminders(session_id):
    return jsonify(history.get_reminders(session_id))


@app.route("/api/brews/<session_id>/reminder/<int:reminder_id>", methods=["DELETE"])
def delete_brew_reminder(session_id, reminder_id):
    history.delete_reminder(reminder_id)
    return jsonify({"status": "ok"})


# --- Legacy brew routes (backward compat) ---

@app.route("/api/brew", methods=["GET"])
def get_brew():
    status = brew.get_brew_status()
    if status:
        return jsonify(status)
    return jsonify(None)


@app.route("/api/brew/start", methods=["POST"])
def start_brew_legacy():
    data = request.get_json() or {}
    try:
        session = brew.start_brew(
            name=data.get("name", "Untitled Brew"),
            tilt_device_id=data.get("tilt_device_id"),
            controller_device_id=data.get("controller_device_id"),
            target_beer_temp=data.get("target_beer_temp"),
            og=data.get("og"),
            notes=data.get("notes", ""),
            temp_source=data.get("temp_source", "hydrometer"),
        )
        return jsonify(session)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400


@app.route("/api/brew/update", methods=["POST"])
def update_brew_legacy():
    data = request.get_json()
    if not data:
        return jsonify({"error": "Invalid JSON"}), 400
    session = brew.active
    if not session:
        return jsonify({"error": "No active brew session"}), 400
    try:
        result = brew.update_session(session["id"], data)
        return jsonify(result)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400


@app.route("/api/brew/complete", methods=["POST"])
def complete_brew_legacy():
    data = request.get_json() or {}
    session = brew.active
    if not session:
        return jsonify({"error": "No active brew session"}), 400
    try:
        result = brew.complete_brew(session["id"], fg=data.get("fg"), notes=data.get("notes", ""))
        return jsonify(result)
    except ValueError as e:
        return jsonify({"error": str(e)}), 400


@app.route("/api/brew/cancel", methods=["POST"])
def cancel_brew_legacy():
    session = brew.active
    if not session:
        return jsonify({"error": "No active brew session"}), 400
    try:
        brew.cancel_brew(session["id"])
        return jsonify({"status": "cancelled"})
    except ValueError as e:
        return jsonify({"error": str(e)}), 400


@app.route("/api/brew/event", methods=["POST"])
def brew_event_legacy():
    data = request.get_json()
    if not data or "event_type" not in data:
        return jsonify({"error": "Missing event_type"}), 400
    session = brew.active
    if not session:
        return jsonify({"error": "No active brew session"}), 400
    try:
        brew.add_event(session["id"], data["event_type"], data.get("description", ""))
        return jsonify({"status": "ok"})
    except ValueError as e:
        return jsonify({"error": str(e)}), 400


@app.route("/api/brew/feedback/start", methods=["POST"])
def start_feedback_legacy():
    session = brew.active
    if not session:
        return jsonify({"error": "No active brew session"}), 400
    try:
        brew.start_feedback(session["id"])
        return jsonify({"status": "started"})
    except ValueError as e:
        return jsonify({"error": str(e)}), 400


@app.route("/api/brew/feedback/stop", methods=["POST"])
def stop_feedback_legacy():
    session = brew.active
    if not session:
        return jsonify({"error": "No active brew session"}), 400
    try:
        brew.stop_feedback(session["id"])
        return jsonify({"status": "stopped"})
    except ValueError as e:
        return jsonify({"error": str(e)}), 400


@app.route("/api/brew/feedback/log", methods=["GET"])
def feedback_log_legacy():
    session = brew.active
    sid = session["id"] if session else None
    data = history.get_temp_feedback_log(session_id=sid)
    return jsonify(data)


@app.route("/api/brew/history", methods=["GET"])
def brew_history():
    sessions = history.list_sessions()
    result = []
    for sid, data_json in sessions:
        s = json.loads(data_json)
        result.append({
            "id": s["id"], "name": s["name"], "status": s["status"],
            "started_at": s.get("started_at"), "completed_at": s.get("completed_at"),
            "og": s.get("og"), "fg": s.get("fg"),
            "rating": s.get("rating", 0),
            "tasting_notes": s.get("tasting_notes", ""),
            "recipe": s.get("recipe", ""),
            "brewing_notes": s.get("brewing_notes", ""),
            "recipe_photo": s.get("recipe_photo", ""),
        })
    return jsonify(result)


@app.route("/api/brews/<session_id>/rate", methods=["POST"])
def rate_brew(session_id):
    data = request.get_json()
    rating = data.get("rating", 0)
    session_json = history.get_session(session_id)
    if not session_json:
        return jsonify({"error": "Brew not found"}), 404
    s = json.loads(session_json)
    s["rating"] = max(0, min(5, int(rating)))
    history.save_session(session_id, json.dumps(s))
    return jsonify({"status": "ok"})


@app.route("/api/brews/<session_id>/notes", methods=["POST"])
def update_brew_notes(session_id):
    data = request.get_json()
    session_json = history.get_session(session_id)
    if not session_json:
        return jsonify({"error": "Brew not found"}), 404
    s = json.loads(session_json)
    for field in ("tasting_notes", "recipe", "brewing_notes"):
        if field in data:
            s[field] = data[field]
    history.save_session(session_id, json.dumps(s))
    return jsonify({"status": "ok"})


BREW_PHOTO_DIR = os.path.join(CONFIG_DIR, "brew_photos")


@app.route("/api/brews/<session_id>/recipe-photo", methods=["POST"])
def upload_brew_recipe_photo(session_id):
    if "photo" not in request.files:
        return jsonify({"error": "No file"}), 400
    f = request.files["photo"]
    if not f.filename:
        return jsonify({"error": "No file selected"}), 400
    ext = f.filename.rsplit(".", 1)[-1].lower() if "." in f.filename else ""
    if ext not in ALLOWED_EXTENSIONS:
        return jsonify({"error": "File type not allowed"}), 400
    os.makedirs(BREW_PHOTO_DIR, exist_ok=True)
    safe_id = secure_filename(session_id)
    filename = f"{safe_id}.{ext}"
    for old in os.listdir(BREW_PHOTO_DIR):
        if old.startswith(safe_id + "."):
            os.remove(os.path.join(BREW_PHOTO_DIR, old))
    f.save(os.path.join(BREW_PHOTO_DIR, filename))
    # Update brew session with photo reference
    session_json = history.get_session(session_id)
    if session_json:
        s = json.loads(session_json)
        s["recipe_photo"] = filename
        history.save_session(session_id, json.dumps(s))
    return jsonify({"status": "ok", "photo": filename})


@app.route("/api/brews/<session_id>/recipe-photo", methods=["GET"])
def get_brew_recipe_photo(session_id):
    safe_id = secure_filename(session_id)
    if not os.path.isdir(BREW_PHOTO_DIR):
        return "", 404
    for fname in os.listdir(BREW_PHOTO_DIR):
        if fname.startswith(safe_id + "."):
            return send_from_directory(BREW_PHOTO_DIR, fname)
    return "", 404


# --- Logs ---

@app.route("/api/logs/history", methods=["GET"])
def log_history():
    return jsonify(web_log_handler.get_history())


@app.route("/api/logs/stream")
def log_stream():
    q = web_log_handler.subscribe()

    def generate():
        try:
            while True:
                try:
                    line = q.get(timeout=30)
                    yield f"data: {line}\n\n"
                except queue.Empty:
                    yield ": keepalive\n\n"
        except GeneratorExit:
            pass
        finally:
            web_log_handler.unsubscribe(q)

    return Response(
        generate(),
        mimetype="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8099, threaded=True)
