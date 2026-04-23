import logging
import queue
from collections import deque


class WebLogHandler(logging.Handler):
    """Logging handler that buffers records for SSE streaming to the web UI."""

    def __init__(self, maxlen=1000):
        super().__init__()
        self._buffer = deque(maxlen=maxlen)
        self._listeners = []

    def emit(self, record):
        entry = self.format(record)
        self._buffer.append(entry)
        # Push to all SSE subscribers
        dead = []
        for q in self._listeners:
            try:
                q.put_nowait(entry)
            except queue.Full:
                dead.append(q)
        for q in dead:
            self._listeners.remove(q)

    def subscribe(self):
        """Create a new SSE subscriber queue."""
        q = queue.Queue(maxsize=500)
        self._listeners.append(q)
        return q

    def unsubscribe(self, q):
        """Remove an SSE subscriber queue."""
        try:
            self._listeners.remove(q)
        except ValueError:
            pass

    def get_history(self):
        """Return buffered log lines."""
        return list(self._buffer)
