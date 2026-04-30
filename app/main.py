import os
import json
import queue
import time
import logging
import logging.handlers
import threading
import socket
import requests

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


# Log DB stats on startup so we can see if data survived
def _log_db_stats():
    try:
        import sqlite3
        db_path = os.path.join(CONFIG_DIR, "history.db")
        if os.path.exists(db_path):
            size_kb = os.path.getsize(db_path) / 1024
            conn = sqlite3.connect(db_path)
            count = conn.execute("SELECT COUNT(*) FROM device_history").fetchone()[0]
            oldest = conn.execute("SELECT MIN(timestamp) FROM device_history").fetchone()[0]
            newest = conn.execute("SELECT MAX(timestamp) FROM device_history").fetchone()[0]
            conn.close()
            if oldest and newest:
                span_hours = (newest - oldest) / 3600
                logger.info(
                    f"Database: {count} records, {span_hours:.1f}h span "
                    f"({span_hours/24:.1f} days), {size_kb:.0f}KB on disk"
                )
            else:
                logger.info(f"Database: empty ({size_kb:.0f}KB on disk)")
        else:
            logger.info("Database: not found, will be created on first write")
    except Exception as e:
        logger.warning(f"DB stats check failed: {e}")

_log_db_stats()

# No automatic pruning — data is kept forever.
# SQLite handles large datasets fine. If a user ever needs to trim,
# they can delete history.db and it'll be recreated.


# --- Version ---
_version_file = os.path.join(os.path.dirname(__file__), "VERSION")
APP_VERSION = open(_version_file).read().strip() if os.path.exists(_version_file) else "dev"


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/version")
def get_version():
    return jsonify({"version": APP_VERSION})


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


# --- TiltPi Management ---

TILTPI_FLOW_DIR = os.path.join(os.path.dirname(__file__), "tiltpi_flows")
TILTPI_BACKUP_DIR = os.path.join(CONFIG_DIR, "tiltpi_backups")


def _check_tiltpi(host, port=1880, timeout=2):
    """Check if a Node-RED instance is running at host:port and return info."""
    try:
        r = requests.get(f"http://{host}:{port}/flows", timeout=timeout,
                         headers={"Accept": "application/json"})
        if r.status_code == 200:
            flows = r.json()
            # Count nodes, look for RAPT2MQTT marker
            node_count = len(flows) if isinstance(flows, list) else 0
            has_rapt2mqtt = any(
                n.get("name", "").startswith("RAPT2MQTT")
                for n in (flows if isinstance(flows, list) else [])
            )
            has_mqtt_scrape = any(
                "Tasty MQTT" in n.get("name", "")
                for n in (flows if isinstance(flows, list) else [])
            )
            # Try to get Node-RED settings for version
            version = "unknown"
            try:
                sr = requests.get(f"http://{host}:{port}/settings", timeout=timeout)
                if sr.status_code == 200:
                    version = sr.json().get("version", "unknown")
            except Exception:
                pass
            return {
                "host": host,
                "port": port,
                "reachable": True,
                "node_count": node_count,
                "nodered_version": version,
                "has_rapt2mqtt_upgrade": has_rapt2mqtt,
                "has_mqtt_scrape": has_mqtt_scrape,
                "flow_type": "upgraded" if has_rapt2mqtt else ("modified" if has_mqtt_scrape else "stock"),
            }
    except Exception:
        pass
    return {"host": host, "port": port, "reachable": False}


@app.route("/api/tiltpi/scan", methods=["POST"])
def scan_tiltpi():
    """Scan the local network for TiltPi instances running Node-RED on port 1880."""
    data = request.get_json() or {}
    # Get the subnet to scan from the request, or auto-detect
    targets = data.get("targets", [])

    if not targets:
        # Auto-detect: scan common local subnets based on our own IP
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.connect(("8.8.8.8", 80))
            my_ip = s.getsockname()[0]
            s.close()
            # Scan /24 subnet
            base = ".".join(my_ip.split(".")[:3])
            targets = [f"{base}.{i}" for i in range(1, 255)]
        except Exception:
            targets = [f"192.168.0.{i}" for i in range(1, 255)]

    # Also try mDNS hostname
    try:
        tiltpi_ip = socket.gethostbyname("tiltpi.local")
        if tiltpi_ip not in targets:
            targets.insert(0, tiltpi_ip)
    except Exception:
        pass

    # Parallel scan using threads
    results = []
    lock = threading.Lock()

    def check_host(host):
        info = _check_tiltpi(host, timeout=1)
        if info["reachable"]:
            with lock:
                results.append(info)

    threads = []
    for host in targets:
        t = threading.Thread(target=check_host, args=(host,), daemon=True)
        threads.append(t)
        t.start()

    # Wait for all threads (max 10 seconds)
    for t in threads:
        t.join(timeout=10)

    return jsonify(results)


@app.route("/api/tiltpi/check", methods=["POST"])
def check_tiltpi():
    """Check a specific TiltPi instance."""
    data = request.get_json()
    if not data or "host" not in data:
        return jsonify({"error": "Missing 'host' field"}), 400
    port = data.get("port", 1880)
    info = _check_tiltpi(data["host"], port=port)
    return jsonify(info)


@app.route("/api/tiltpi/backup", methods=["POST"])
def backup_tiltpi_flow():
    """Backup the current flow from a TiltPi instance before deploying changes."""
    data = request.get_json()
    if not data or "host" not in data:
        return jsonify({"error": "Missing 'host' field"}), 400
    host = data["host"]
    port = data.get("port", 1880)

    try:
        r = requests.get(f"http://{host}:{port}/flows", timeout=5,
                         headers={"Accept": "application/json"})
        if r.status_code != 200:
            return jsonify({"error": f"Failed to read flows: HTTP {r.status_code}"}), 502

        os.makedirs(TILTPI_BACKUP_DIR, exist_ok=True)
        ts = time.strftime("%Y%m%d-%H%M%S")
        filename = f"tiltpi-backup-{host.replace('.', '_')}-{ts}.json"
        filepath = os.path.join(TILTPI_BACKUP_DIR, filename)
        with open(filepath, "w") as f:
            json.dump(r.json(), f, indent=2)

        logger.info(f"TiltPi flow backed up from {host}:{port} -> {filename}")
        return jsonify({"status": "ok", "filename": filename, "node_count": len(r.json())})
    except requests.exceptions.ConnectionError:
        return jsonify({"error": f"Cannot connect to {host}:{port}"}), 502
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/tiltpi/deploy", methods=["POST"])
def deploy_tiltpi_flow():
    """Deploy a flow to a TiltPi instance. Supports 'upgraded' or 'stock' flow types."""
    data = request.get_json()
    if not data or "host" not in data:
        return jsonify({"error": "Missing 'host' field"}), 400
    if "flow_type" not in data:
        return jsonify({"error": "Missing 'flow_type' (upgraded or stock)"}), 400

    host = data["host"]
    port = data.get("port", 1880)
    flow_type = data["flow_type"]
    mqtt_host = data.get("mqtt_host", "")
    mqtt_port = data.get("mqtt_port", "1883")

    # Load the appropriate flow template
    if flow_type == "upgraded":
        flow_file = os.path.join(TILTPI_FLOW_DIR, "tiltpi-upgraded-flow.json")
    elif flow_type == "stock":
        flow_file = os.path.join(TILTPI_FLOW_DIR, "tiltpi-stock-flow.json")
    else:
        return jsonify({"error": f"Unknown flow_type: {flow_type}"}), 400

    if not os.path.exists(flow_file):
        return jsonify({"error": f"Flow file not found: {flow_type}"}), 500

    try:
        with open(flow_file) as f:
            flow_data = f.read()

        # For upgraded flow, substitute MQTT broker placeholders
        if flow_type == "upgraded":
            if not mqtt_host:
                # Use our own MQTT config
                cfg = load_config()
                mqtt_host = cfg.get("mqtt_host", "")
                mqtt_port = str(cfg.get("mqtt_port", 1883))
            if not mqtt_host:
                return jsonify({"error": "MQTT host required for upgraded flow. Configure it in MQTT Config or pass mqtt_host."}), 400
            flow_data = flow_data.replace("%%MQTT_HOST%%", mqtt_host)
            flow_data = flow_data.replace("%%MQTT_PORT%%", str(mqtt_port))

        flow_json = json.loads(flow_data)

        # Deploy via Node-RED API (full flow replacement)
        r = requests.post(
            f"http://{host}:{port}/flows",
            json=flow_json,
            headers={"Content-Type": "application/json", "Node-RED-Deployment-Type": "full"},
            timeout=30,
        )

        if r.status_code == 204 or r.status_code == 200:
            logger.info(f"TiltPi flow deployed ({flow_type}) to {host}:{port}")
            return jsonify({"status": "ok", "flow_type": flow_type, "node_count": len(flow_json)})
        else:
            return jsonify({"error": f"Deploy failed: HTTP {r.status_code} - {r.text[:200]}"}), 502

    except requests.exceptions.ConnectionError:
        return jsonify({"error": f"Cannot connect to {host}:{port}"}), 502
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route("/api/tiltpi/backups", methods=["GET"])
def list_tiltpi_backups():
    """List all TiltPi flow backups."""
    if not os.path.isdir(TILTPI_BACKUP_DIR):
        return jsonify([])
    backups = []
    for fname in sorted(os.listdir(TILTPI_BACKUP_DIR), reverse=True):
        if fname.endswith(".json"):
            path = os.path.join(TILTPI_BACKUP_DIR, fname)
            backups.append({
                "filename": fname,
                "size": os.path.getsize(path),
                "created": os.path.getmtime(path),
            })
    return jsonify(backups)


@app.route("/api/tiltpi/restore", methods=["POST"])
def restore_tiltpi_flow():
    """Restore a previously backed-up flow to a TiltPi instance."""
    data = request.get_json()
    if not data or "host" not in data or "filename" not in data:
        return jsonify({"error": "Missing 'host' or 'filename'"}), 400

    host = data["host"]
    port = data.get("port", 1880)
    filename = secure_filename(data["filename"])
    filepath = os.path.join(TILTPI_BACKUP_DIR, filename)

    if not os.path.exists(filepath):
        return jsonify({"error": "Backup file not found"}), 404

    try:
        with open(filepath) as f:
            flow_json = json.load(f)

        r = requests.post(
            f"http://{host}:{port}/flows",
            json=flow_json,
            headers={"Content-Type": "application/json", "Node-RED-Deployment-Type": "full"},
            timeout=30,
        )

        if r.status_code in (200, 204):
            logger.info(f"TiltPi flow restored from {filename} to {host}:{port}")
            return jsonify({"status": "ok", "filename": filename, "node_count": len(flow_json)})
        else:
            return jsonify({"error": f"Restore failed: HTTP {r.status_code}"}), 502
    except Exception as e:
        return jsonify({"error": str(e)}), 500


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
