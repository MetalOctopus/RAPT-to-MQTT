import os
import json
import threading

CONFIG_DIR = os.environ.get("CONFIG_DIR", "/config")
CONFIG_FILE = os.path.join(CONFIG_DIR, "config.json")
TOKEN_FILE = os.path.join(CONFIG_DIR, "token.txt")
LOG_DIR = os.path.join(CONFIG_DIR, "logs")

DEFAULTS = {
    "mqtt_host": "",
    "mqtt_port": 1883,
    "mqtt_username": "",
    "mqtt_password": "",
    "rapt_email": "",
    "rapt_secret": "",
    "poll_interval": 300,
    "auto_start": True,
    "gravity_unit": "sg",
}

# Environment variable name -> config key (or tuple with type converter)
ENV_MAP = {
    "MQTT_HOST": "mqtt_host",
    "MQTT_PORT": ("mqtt_port", int),
    "MQTT_USERNAME": "mqtt_username",
    "MQTT_PASSWORD": "mqtt_password",
    "RAPT_EMAIL": "rapt_email",
    "RAPT_SECRET": "rapt_secret",
    "POLL_INTERVAL": ("poll_interval", int),
    "AUTO_START": ("auto_start", lambda v: v.lower() in ("true", "1", "yes")),
}

_lock = threading.Lock()


def _ensure_dirs():
    os.makedirs(CONFIG_DIR, exist_ok=True)
    os.makedirs(LOG_DIR, exist_ok=True)


def load_config():
    """Load config from file, then overlay environment variables."""
    _ensure_dirs()
    config = dict(DEFAULTS)

    if os.path.exists(CONFIG_FILE):
        with _lock:
            with open(CONFIG_FILE, "r") as f:
                try:
                    saved = json.load(f)
                    config.update(saved)
                except json.JSONDecodeError:
                    pass

    # Environment variables override file config
    for env_var, mapping in ENV_MAP.items():
        val = os.environ.get(env_var)
        if val is not None:
            if isinstance(mapping, tuple):
                key, converter = mapping
                config[key] = converter(val)
            else:
                config[mapping] = val

    return config


def save_config(config):
    """Save config to JSON file. Does not save env-var-only fields."""
    _ensure_dirs()
    with _lock:
        with open(CONFIG_FILE, "w") as f:
            json.dump(config, f, indent=2)


def is_configured(config):
    """Check if minimum required fields are set."""
    return bool(
        config.get("mqtt_host")
        and config.get("rapt_email")
        and config.get("rapt_secret")
    )


def mask_secret(secret):
    """Mask a secret string, showing only the last 4 characters."""
    if not secret or len(secret) <= 4:
        return "****"
    return "*" * (len(secret) - 4) + secret[-4:]
