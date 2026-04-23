import os
import queue
import logging
import logging.handlers

from flask import Flask, render_template, request, jsonify, Response

from app.config import (
    load_config, save_config, is_configured, mask_secret, LOG_DIR, CONFIG_DIR
)
from app.rapt_service import RaptBridge
from app.log_handler import WebLogHandler

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
bridge = RaptBridge(config=config, logger=logger)

# Auto-start if configured
if is_configured(config) and config.get("auto_start", True):
    logger.info("Auto-starting bridge (config found)...")
    bridge.start()


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/config", methods=["GET"])
def get_config():
    cfg = load_config()
    # Mask secrets in the response
    cfg["rapt_secret"] = mask_secret(cfg.get("rapt_secret", ""))
    cfg["mqtt_password"] = mask_secret(cfg.get("mqtt_password", ""))
    return jsonify(cfg)


@app.route("/api/config", methods=["POST"])
def post_config():
    data = request.get_json()
    if not data:
        return jsonify({"error": "Invalid JSON"}), 400

    cfg = load_config()

    # Only update fields that are present and not masked placeholders
    for key in ["mqtt_host", "mqtt_username", "rapt_email"]:
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

    # Only update secrets if they don't look like masked values
    if "rapt_secret" in data and not data["rapt_secret"].startswith("*"):
        cfg["rapt_secret"] = data["rapt_secret"]
    if "mqtt_password" in data and not data["mqtt_password"].startswith("*"):
        cfg["mqtt_password"] = data["mqtt_password"]

    save_config(cfg)
    logger.info("Configuration saved.")
    return jsonify({"status": "ok"})


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
                    # Keepalive to prevent proxy/browser timeout
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
