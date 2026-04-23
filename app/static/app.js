const consoleEl = document.getElementById("console");
const statusDot = document.getElementById("status-dot");
const statusText = document.getElementById("status-text");
const btnStart = document.getElementById("btn-start");
const btnStop = document.getElementById("btn-stop");
const btnSave = document.getElementById("btn-save");

const MAX_LINES = 500;

function appendLog(line) {
  const div = document.createElement("div");
  div.className = "log-line";
  if (line.includes("[ERROR]")) div.className += " error";
  else if (line.includes("[WARNING]")) div.className += " warning";
  div.textContent = line;
  consoleEl.appendChild(div);

  // Cap lines
  while (consoleEl.children.length > MAX_LINES) {
    consoleEl.removeChild(consoleEl.firstChild);
  }

  // Auto-scroll if near bottom
  const atBottom = consoleEl.scrollHeight - consoleEl.scrollTop - consoleEl.clientHeight < 60;
  if (atBottom) consoleEl.scrollTop = consoleEl.scrollHeight;
}

function showToast(msg, type) {
  const toast = document.getElementById("toast");
  toast.textContent = msg;
  toast.className = "toast " + type + " show";
  setTimeout(() => toast.classList.remove("show"), 3000);
}

function updateStatus(running) {
  statusDot.className = "status-dot " + (running ? "running" : "stopped");
  statusText.textContent = running ? "Running" : "Stopped";
  btnStart.disabled = running;
  btnStop.disabled = !running;
}

async function loadConfig() {
  try {
    const res = await fetch("/api/config");
    const cfg = await res.json();
    document.getElementById("mqtt_host").value = cfg.mqtt_host || "";
    document.getElementById("mqtt_port").value = cfg.mqtt_port || 1883;
    document.getElementById("mqtt_username").value = cfg.mqtt_username || "";
    document.getElementById("mqtt_password").value = cfg.mqtt_password || "";
    document.getElementById("rapt_email").value = cfg.rapt_email || "";
    document.getElementById("rapt_secret").value = cfg.rapt_secret || "";
    document.getElementById("poll_interval").value = cfg.poll_interval || 60;
    document.getElementById("auto_start").checked = cfg.auto_start !== false;
  } catch (e) {
    showToast("Failed to load config", "error");
  }
}

async function saveConfig() {
  const data = {
    mqtt_host: document.getElementById("mqtt_host").value,
    mqtt_port: document.getElementById("mqtt_port").value,
    mqtt_username: document.getElementById("mqtt_username").value,
    mqtt_password: document.getElementById("mqtt_password").value,
    rapt_email: document.getElementById("rapt_email").value,
    rapt_secret: document.getElementById("rapt_secret").value,
    poll_interval: document.getElementById("poll_interval").value,
    auto_start: document.getElementById("auto_start").checked,
  };

  try {
    const res = await fetch("/api/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    const result = await res.json();
    if (res.ok) showToast("Configuration saved", "success");
    else showToast(result.error || "Save failed", "error");
  } catch (e) {
    showToast("Failed to save config", "error");
  }
}

async function startBridge() {
  try {
    const res = await fetch("/api/bridge/start", { method: "POST" });
    const result = await res.json();
    if (res.ok) {
      updateStatus(true);
      showToast("Bridge started", "success");
    } else {
      showToast(result.error || "Start failed", "error");
    }
  } catch (e) {
    showToast("Failed to start bridge", "error");
  }
}

async function stopBridge() {
  try {
    const res = await fetch("/api/bridge/stop", { method: "POST" });
    const result = await res.json();
    if (res.ok) {
      updateStatus(false);
      showToast("Bridge stopped", "success");
    } else {
      showToast(result.error || "Stop failed", "error");
    }
  } catch (e) {
    showToast("Failed to stop bridge", "error");
  }
}

async function checkStatus() {
  try {
    const res = await fetch("/api/bridge/status");
    const result = await res.json();
    updateStatus(result.running);
  } catch (e) {
    // Silently fail — server might be restarting
  }
}

function initConsole() {
  // Load existing log history
  fetch("/api/logs/history")
    .then((r) => r.json())
    .then((lines) => lines.forEach(appendLog))
    .catch(() => {});

  // Open SSE stream
  const source = new EventSource("/api/logs/stream");
  source.onmessage = (e) => appendLog(e.data);
  source.onerror = () => {
    // EventSource will auto-reconnect
  };
}

// Wire up buttons
btnSave.addEventListener("click", saveConfig);
btnStart.addEventListener("click", startBridge);
btnStop.addEventListener("click", stopBridge);

// Init
loadConfig();
checkStatus();
initConsole();

// Poll status every 5 seconds
setInterval(checkStatus, 5000);
