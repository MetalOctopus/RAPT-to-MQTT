"""Time-series history storage using SQLite."""

import os
import sqlite3
import threading
import time
from datetime import datetime

from app.config import CONFIG_DIR

DB_PATH = os.path.join(CONFIG_DIR, "history.db")


class HistoryStore:
    def __init__(self):
        self._lock = threading.Lock()
        self._init_db()

    def _init_db(self):
        os.makedirs(CONFIG_DIR, exist_ok=True)
        with self._connect() as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS device_history (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    device_id TEXT NOT NULL,
                    timestamp REAL NOT NULL,
                    metric TEXT NOT NULL,
                    value REAL NOT NULL
                )
            """)
            conn.execute("""
                CREATE INDEX IF NOT EXISTS idx_device_time
                ON device_history (device_id, metric, timestamp)
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS brew_sessions (
                    id TEXT PRIMARY KEY,
                    data TEXT NOT NULL
                )
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS brew_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    timestamp REAL NOT NULL,
                    event_type TEXT NOT NULL,
                    description TEXT,
                    data TEXT
                )
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS temp_feedback_log (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT,
                    timestamp REAL NOT NULL,
                    beer_temp REAL,
                    fridge_temp REAL,
                    target_beer_temp REAL,
                    old_controller_target REAL,
                    new_controller_target REAL,
                    error REAL,
                    adjustment REAL
                )
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS brew_reminders (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    session_id TEXT NOT NULL,
                    reminder_type TEXT NOT NULL,
                    trigger_value REAL NOT NULL,
                    message TEXT NOT NULL,
                    icon TEXT DEFAULT 'mdi:beer',
                    fired INTEGER DEFAULT 0,
                    created_at REAL NOT NULL
                )
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS known_devices (
                    device_id TEXT PRIMARY KEY,
                    device_type TEXT NOT NULL,
                    name TEXT NOT NULL,
                    nickname TEXT,
                    photo_path TEXT,
                    last_state TEXT,
                    last_seen REAL NOT NULL,
                    created_at REAL NOT NULL
                )
            """)

    def _connect(self):
        conn = sqlite3.connect(DB_PATH, timeout=5)
        conn.row_factory = sqlite3.Row
        return conn

    def record(self, device_id, metrics):
        """Record a dict of {metric_name: value} for a device."""
        ts = time.time()
        with self._lock:
            with self._connect() as conn:
                rows = [(device_id, ts, k, float(v))
                        for k, v in metrics.items()
                        if v is not None and isinstance(v, (int, float))]
                conn.executemany(
                    "INSERT INTO device_history (device_id, timestamp, metric, value) VALUES (?, ?, ?, ?)",
                    rows
                )

    def query(self, device_id, metric, start=None, end=None, limit=10000):
        """Query history for a device metric. Returns list of {timestamp, value}."""
        sql = "SELECT timestamp, value FROM device_history WHERE device_id = ? AND metric = ?"
        params = [device_id, metric]
        if start:
            sql += " AND timestamp >= ?"
            params.append(start)
        if end:
            sql += " AND timestamp <= ?"
            params.append(end)
        sql += " ORDER BY timestamp DESC LIMIT ?"
        params.append(limit)
        with self._connect() as conn:
            rows = conn.execute(sql, params).fetchall()
        return [{"timestamp": r["timestamp"], "value": r["value"]} for r in reversed(rows)]

    def get_metrics(self, device_id):
        """Get list of available metrics for a device."""
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT DISTINCT metric FROM device_history WHERE device_id = ?",
                (device_id,)
            ).fetchall()
        return [r["metric"] for r in rows]

    def prune(self, max_age_seconds=604800):
        """Delete records older than max_age (default 7 days)."""
        cutoff = time.time() - max_age_seconds
        with self._lock:
            with self._connect() as conn:
                conn.execute("DELETE FROM device_history WHERE timestamp < ?", (cutoff,))
                conn.execute("DELETE FROM temp_feedback_log WHERE timestamp < ?", (cutoff,))

    # --- Brew sessions ---

    def save_session(self, session_id, data_json):
        with self._lock:
            with self._connect() as conn:
                conn.execute(
                    "INSERT OR REPLACE INTO brew_sessions (id, data) VALUES (?, ?)",
                    (session_id, data_json)
                )

    def get_session(self, session_id):
        with self._connect() as conn:
            row = conn.execute("SELECT data FROM brew_sessions WHERE id = ?", (session_id,)).fetchone()
        return row["data"] if row else None

    def list_sessions(self):
        with self._connect() as conn:
            rows = conn.execute("SELECT id, data FROM brew_sessions ORDER BY id DESC").fetchall()
        return [(r["id"], r["data"]) for r in rows]

    def delete_session(self, session_id):
        with self._lock:
            with self._connect() as conn:
                conn.execute("DELETE FROM brew_sessions WHERE id = ?", (session_id,))
                conn.execute("DELETE FROM brew_events WHERE session_id = ?", (session_id,))

    def add_event(self, session_id, event_type, description="", data_json=""):
        ts = time.time()
        with self._lock:
            with self._connect() as conn:
                conn.execute(
                    "INSERT INTO brew_events (session_id, timestamp, event_type, description, data) VALUES (?, ?, ?, ?, ?)",
                    (session_id, ts, event_type, description, data_json)
                )

    def get_events(self, session_id):
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT timestamp, event_type, description, data FROM brew_events WHERE session_id = ? ORDER BY timestamp",
                (session_id,)
            ).fetchall()
        return [dict(r) for r in rows]

    # --- Temp feedback log ---

    def log_temp_feedback(self, session_id, beer_temp, fridge_temp, target_beer_temp,
                          old_target, new_target, error, adjustment):
        ts = time.time()
        with self._lock:
            with self._connect() as conn:
                conn.execute(
                    """INSERT INTO temp_feedback_log
                       (session_id, timestamp, beer_temp, fridge_temp, target_beer_temp,
                        old_controller_target, new_controller_target, error, adjustment)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (session_id, ts, beer_temp, fridge_temp, target_beer_temp,
                     old_target, new_target, error, adjustment)
                )

    def get_temp_feedback_log(self, session_id=None, limit=500):
        sql = "SELECT * FROM temp_feedback_log"
        params = []
        if session_id:
            sql += " WHERE session_id = ?"
            params.append(session_id)
        sql += " ORDER BY timestamp DESC LIMIT ?"
        params.append(limit)
        with self._connect() as conn:
            rows = conn.execute(sql, params).fetchall()
        return [dict(r) for r in reversed(rows)]

    # --- Reminders ---

    def add_reminder(self, session_id, reminder_type, trigger_value, message, icon="mdi:beer"):
        ts = time.time()
        with self._lock:
            with self._connect() as conn:
                conn.execute(
                    """INSERT INTO brew_reminders
                       (session_id, reminder_type, trigger_value, message, icon, fired, created_at)
                       VALUES (?, ?, ?, ?, ?, 0, ?)""",
                    (session_id, reminder_type, trigger_value, message, icon, ts)
                )

    def get_reminders(self, session_id):
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT id, session_id, reminder_type, trigger_value, message, icon, fired, created_at "
                "FROM brew_reminders WHERE session_id = ? ORDER BY created_at",
                (session_id,)
            ).fetchall()
        return [dict(r) for r in rows]

    def mark_reminder_fired(self, reminder_id):
        with self._lock:
            with self._connect() as conn:
                conn.execute("UPDATE brew_reminders SET fired = 1 WHERE id = ?", (reminder_id,))

    def delete_reminder(self, reminder_id):
        with self._lock:
            with self._connect() as conn:
                conn.execute("DELETE FROM brew_reminders WHERE id = ?", (reminder_id,))

    # --- Known devices (persist across restarts) ---

    def save_known_device(self, device_id, device_type, name, last_state_json):
        """Upsert a known device. Called every time fresh data arrives."""
        now = time.time()
        with self._lock:
            with self._connect() as conn:
                existing = conn.execute(
                    "SELECT nickname, photo_path, created_at FROM known_devices WHERE device_id = ?",
                    (device_id,)
                ).fetchone()
                if existing:
                    conn.execute(
                        """UPDATE known_devices
                           SET name = ?, last_state = ?, last_seen = ?, device_type = ?
                           WHERE device_id = ?""",
                        (name, last_state_json, now, device_type, device_id)
                    )
                else:
                    conn.execute(
                        """INSERT INTO known_devices
                           (device_id, device_type, name, nickname, photo_path, last_state, last_seen, created_at)
                           VALUES (?, ?, ?, NULL, NULL, ?, ?, ?)""",
                        (device_id, device_type, name, last_state_json, now, now)
                    )

    def get_known_devices(self):
        """Return all known devices as list of dicts."""
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT device_id, device_type, name, nickname, photo_path, last_state, last_seen, created_at "
                "FROM known_devices ORDER BY name"
            ).fetchall()
        return [dict(r) for r in rows]

    def update_device_config(self, device_id, nickname=None, photo_path=None):
        """Update nickname and/or photo for a device."""
        with self._lock:
            with self._connect() as conn:
                if nickname is not None:
                    conn.execute(
                        "UPDATE known_devices SET nickname = ? WHERE device_id = ?",
                        (nickname, device_id)
                    )
                if photo_path is not None:
                    conn.execute(
                        "UPDATE known_devices SET photo_path = ? WHERE device_id = ?",
                        (photo_path, device_id)
                    )

    def forget_device(self, device_id):
        """Remove a device from known_devices. Does NOT delete history data."""
        with self._lock:
            with self._connect() as conn:
                conn.execute("DELETE FROM known_devices WHERE device_id = ?", (device_id,))
