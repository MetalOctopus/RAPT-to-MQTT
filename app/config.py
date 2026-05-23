import os
import json
import secrets
import threading

CONFIG_DIR = os.environ.get("CONFIG_DIR", "/config")
CONFIG_FILE = os.path.join(CONFIG_DIR, "config.json")
TOKEN_FILE = os.path.join(CONFIG_DIR, "token.txt")
LOG_DIR = os.path.join(CONFIG_DIR, "logs")
SECRET_KEY_FILE = os.path.join(CONFIG_DIR, ".flask_secret")

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
    "auth_enabled": False,
    "brewmaster_username": "admin",
    "brewmaster_password_hash": "",
    "guest_mode": "button",
    "guest_username": "guest",
    "guest_password_hash": "",
    "ha_discovery_enabled": False,
    "ha_discovery_prefix": "homeassistant",
    "notification_target_device": "",
    "notification_level": "all",
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
    "AUTH_ENABLED": ("auth_enabled", lambda v: v.lower() in ("true", "1", "yes")),
    "BREWMASTER_USERNAME": "brewmaster_username",
    "GUEST_MODE": "guest_mode",
    "HA_DISCOVERY_ENABLED": ("ha_discovery_enabled", lambda v: v.lower() in ("true", "1", "yes")),
    "HA_DISCOVERY_PREFIX": "ha_discovery_prefix",
    "NOTIFICATION_TARGET_DEVICE": "notification_target_device",
    "NOTIFICATION_LEVEL": "notification_level",
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


def get_or_create_secret_key():
    """Load or generate a persistent Flask secret key.

    Persisted to CONFIG_DIR so sessions survive container restarts.
    """
    _ensure_dirs()
    if os.path.exists(SECRET_KEY_FILE):
        with open(SECRET_KEY_FILE, "r") as f:
            key = f.read().strip()
            if key:
                return key
    key = secrets.token_hex(32)
    with open(SECRET_KEY_FILE, "w") as f:
        f.write(key)
    return key
