/* --- DOM refs --- */
const consoleEl = document.getElementById("console");
const statusDot = document.getElementById("status-dot");
const btnStart = document.getElementById("btn-start");
const btnStop = document.getElementById("btn-stop");
const btnSave = document.getElementById("btn-save");
const deviceListEl = document.getElementById("device-list");

const MAX_LINES = 500;
let currentPage = "config";
let currentDeviceId = null;

/* --- Navigation --- */
function showPage(page, deviceId) {
  document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
  document.querySelectorAll(".nav-item").forEach(n => n.classList.remove("active"));

  if (page === "config" || page === "dashboard" || page === "help") {
    const pageEl = document.getElementById("page-" + page);
    if (pageEl) pageEl.classList.add("active");
    const navItem = document.querySelector(`[data-page="${page}"]`);
    if (navItem) navItem.classList.add("active");
    currentPage = page;
    currentDeviceId = null;
    if (page === "dashboard") refreshDashboard();
  } else if (page === "device" && deviceId) {
    document.getElementById("page-device").classList.add("active");
    const navItem = document.querySelector(`.nav-item[data-device="${deviceId}"]`);
    if (navItem) navItem.classList.add("active");
    currentPage = "device";
    currentDeviceId = deviceId;
    loadDevice(deviceId);
  }
}

/* --- Console --- */
function appendLog(line) {
  const div = document.createElement("div");
  div.className = "log-line";
  if (line.includes("[ERROR]")) div.className += " error";
  else if (line.includes("[WARNING]")) div.className += " warning";
  div.textContent = line;
  consoleEl.appendChild(div);

  while (consoleEl.children.length > MAX_LINES) {
    consoleEl.removeChild(consoleEl.firstChild);
  }

  const atBottom = consoleEl.scrollHeight - consoleEl.scrollTop - consoleEl.clientHeight < 60;
  if (atBottom) consoleEl.scrollTop = consoleEl.scrollHeight;
}

/* --- Toast --- */
function showToast(msg, type) {
  const toast = document.getElementById("toast");
  toast.textContent = msg;
  toast.className = "toast " + type + " show";
  setTimeout(() => toast.classList.remove("show"), 3000);
}

/* --- Bridge status --- */
function updateStatus(running) {
  statusDot.className = "status-dot " + (running ? "running" : "stopped");
  btnStart.disabled = running;
  btnStop.disabled = !running;
}

async function checkStatus() {
  try {
    const res = await fetch("/api/bridge/status");
    const result = await res.json();
    updateStatus(result.running);
  } catch (e) {
    // Server might be restarting
  }
}

/* --- Config --- */
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
    document.getElementById("poll_interval").value = cfg.poll_interval || 300;
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

/* --- Bridge controls --- */
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

/* --- Devices --- */
function formatSeconds(secs) {
  if (secs == null || isNaN(secs)) return "—";
  const s = Math.round(secs);
  if (s < 60) return s + "s";
  if (s < 3600) return Math.floor(s / 60) + "m " + (s % 60) + "s";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h < 24) return h + "h " + m + "m";
  const d = Math.floor(h / 24);
  const rh = h % 24;
  if (d < 365) return d + "d " + rh + "h";
  const y = Math.floor(d / 365);
  const rd = d % 365;
  return y + "y " + rd + "d";
}

function formatTemp(val, unit) {
  if (val == null || isNaN(val)) return "—";
  const suffix = unit === "F" ? "°F" : "°C";
  return parseFloat(val).toFixed(1) + suffix;
}

function boolText(val) {
  if (val === true) return "Yes";
  if (val === false) return "No";
  return "—";
}

async function loadDevices() {
  try {
    const res = await fetch("/api/devices");
    const devices = await res.json();
    const ids = Object.keys(devices);

    if (ids.length === 0) {
      deviceListEl.innerHTML = '<div class="nav-item dim">No devices discovered</div>';
      return;
    }

    deviceListEl.innerHTML = "";
    ids.forEach(id => {
      const dev = devices[id];
      const name = dev.name || id.substring(0, 8);
      const existing = deviceListEl.querySelector(`[data-device="${id}"]`);
      if (!existing) {
        const el = document.createElement("a");
        el.className = "nav-item" + (currentDeviceId === id ? " active" : "");
        el.setAttribute("data-device", id);
        el.href = "#";
        el.textContent = name;
        el.addEventListener("click", (e) => {
          e.preventDefault();
          showPage("device", id);
        });
        deviceListEl.appendChild(el);
      }
    });

    // If currently viewing a device, refresh its data
    if (currentPage === "device" && currentDeviceId && devices[currentDeviceId]) {
      renderDevice(devices[currentDeviceId]);
    }
  } catch (e) {
    // Silently fail
  }
}

async function loadDevice(deviceId) {
  try {
    const res = await fetch("/api/devices/" + deviceId);
    if (!res.ok) return;
    const dev = await res.json();
    renderDevice(dev);
  } catch (e) {
    // Silently fail
  }
}

function renderDevice(dev) {
  const unit = dev.tempUnit || "C";
  const isTilt = dev.deviceType === "TILT";

  // Header
  document.getElementById("device-name").textContent = dev.name || "Unknown Device";
  const connBadge = document.getElementById("device-connection");
  const connState = (dev.connectionState || "").toLowerCase();
  const isOnline = connState === "connected" || connState === "online";
  connBadge.textContent = isOnline ? "Online" : "Offline";
  connBadge.className = "badge " + (isOnline ? "online" : "offline");

  // Show/hide cards based on device type
  document.getElementById("card-target-temp").style.display = isTilt ? "none" : "";
  document.getElementById("card-gravity").style.display = isTilt ? "" : "none";
  document.getElementById("card-cooling").style.display = isTilt ? "none" : "";
  document.getElementById("card-heating").style.display = isTilt ? "none" : "";
  document.querySelectorAll(".rapt-only").forEach(el => el.style.display = isTilt ? "none" : "");

  // Temperature cards
  if (isTilt) {
    const tempStr = dev.temperature != null
      ? formatTemp(dev.temperature, "C") + " (" + dev.temperature_f + "°F)"
      : "—";
    document.getElementById("device-current-temp").textContent = tempStr;
    document.getElementById("device-gravity").textContent =
      dev.specificGravity != null ? Math.round(dev.specificGravity * 1000) : "—";
  } else {
    document.getElementById("device-current-temp").textContent = formatTemp(dev.temperature, unit);
    document.getElementById("device-target-temp").textContent = formatTemp(dev.targetTemperature, unit);
    document.getElementById("device-cooling").textContent = boolText(dev.coolingEnabled);
    document.getElementById("device-heating").textContent = boolText(dev.heatingEnabled);
  }

  // Device info table
  document.getElementById("info-name").textContent = dev.name || "—";
  document.getElementById("info-type").textContent = dev.deviceType || "—";
  document.getElementById("info-use").textContent = dev.customerUse || "—";
  document.getElementById("info-mac").textContent = dev.macAddress || "—";
  document.getElementById("info-firmware").textContent = dev.firmwareVersion || "—";
  document.getElementById("info-rssi").textContent = dev.rssi != null ? dev.rssi + " dBm" : "—";
  document.getElementById("info-unit").textContent = unit === "F" ? "Fahrenheit" : "Celsius";
  document.getElementById("info-sensor").textContent = dev.useInternalSensor === true ? "Internal" : dev.useInternalSensor === false ? "External" : "—";
  document.getElementById("info-telemetry").textContent = dev.telemetryFrequency != null ? dev.telemetryFrequency + " min" : "—";

  const lastActivity = dev.lastActivityTime || dev._last_seen;
  if (lastActivity) {
    const d = new Date(lastActivity);
    document.getElementById("info-last-activity").textContent = d.toLocaleString();
  } else {
    document.getElementById("info-last-activity").textContent = "—";
  }

  // Runtime stats
  document.getElementById("stats-total").textContent = formatSeconds(dev.totalRunTime);
  document.getElementById("stats-cooling-time").textContent = formatSeconds(dev.coolingRunTime);
  document.getElementById("stats-cooling-starts").textContent = dev.coolingStarts != null ? dev.coolingStarts : "—";
  document.getElementById("stats-heating-time").textContent = formatSeconds(dev.heatingRunTime);
  document.getElementById("stats-heating-starts").textContent = dev.heatingStarts != null ? dev.heatingStarts : "—";

  // Controller settings
  document.getElementById("settings-pid").textContent = boolText(dev.pidEnabled);
  document.getElementById("settings-cool-hyst").textContent = dev.coolingHysteresis != null ? dev.coolingHysteresis + "°" : "—";
  document.getElementById("settings-heat-hyst").textContent = dev.heatingHysteresis != null ? dev.heatingHysteresis + "°" : "—";
  document.getElementById("settings-compressor").textContent = dev.compressorDelay != null ? dev.compressorDelay + " min" : "—";
  document.getElementById("settings-mode-switch").textContent = dev.modeSwitchDelay != null ? dev.modeSwitchDelay + " min" : "—";
  document.getElementById("settings-high-alarm").textContent = dev.highTempAlarm != null ? formatTemp(dev.highTempAlarm, unit) : "—";
  document.getElementById("settings-low-alarm").textContent = dev.lowTempAlarm != null ? formatTemp(dev.lowTempAlarm, unit) : "—";
  document.getElementById("settings-bluetooth").textContent = boolText(dev.bluetoothEnabled);
}

/* --- SSE Console --- */
function initConsole() {
  fetch("/api/logs/history")
    .then(r => r.json())
    .then(lines => lines.forEach(appendLog))
    .catch(() => {});

  const source = new EventSource("/api/logs/stream");
  source.onmessage = (e) => appendLog(e.data);
  source.onerror = () => {};
}

/* --- Dashboard --- */
let dashboardEnabled = {}; // deviceId -> bool

function refreshDashboard() {
  updateDashboardSelect();
  updateDashboardCards();
}

async function updateDashboardSelect() {
  try {
    const res = await fetch("/api/devices");
    const devices = await res.json();
    const container = document.getElementById("dashboard-device-select");
    const ids = Object.keys(devices);

    if (ids.length === 0) {
      container.innerHTML = '<span class="help-text">No devices discovered yet. Start the bridge first.</span>';
      return;
    }

    ids.forEach(id => {
      if (container.querySelector(`[data-dash-device="${id}"]`)) return;
      const dev = devices[id];
      const label = document.createElement("label");
      label.className = "checkbox-group dash-check";
      label.setAttribute("data-dash-device", id);
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = dashboardEnabled[id] !== false;
      cb.addEventListener("change", () => {
        dashboardEnabled[id] = cb.checked;
        updateDashboardCards();
      });
      if (!(id in dashboardEnabled)) dashboardEnabled[id] = true;
      const span = document.createElement("span");
      span.textContent = dev.name || id.substring(0, 8);
      label.appendChild(cb);
      label.appendChild(span);
      container.appendChild(label);
    });
  } catch (e) {}
}

async function updateDashboardCards() {
  try {
    const res = await fetch("/api/devices");
    const devices = await res.json();
    const container = document.getElementById("dashboard-cards");
    container.innerHTML = "";

    Object.keys(devices).forEach(id => {
      if (dashboardEnabled[id] === false) return;
      const dev = devices[id];
      const isTilt = dev.deviceType === "TILT";
      const unit = dev.tempUnit || "C";

      const card = document.createElement("div");
      card.className = "panel dash-card";

      const name = dev.name || id.substring(0, 8);
      const connState = (dev.connectionState || "").toLowerCase();
      const isOnline = connState === "connected" || connState === "online";

      let html = `<div class="dash-card-header">
        <strong>${esc(name)}</strong>
        <span class="badge ${isOnline ? 'online' : 'offline'}">${isOnline ? 'Online' : 'Offline'}</span>
      </div><div class="dash-card-metrics">`;

      html += `<div class="dash-metric">
        <span class="dash-metric-label">Temp</span>
        <span class="dash-metric-value">${formatTemp(dev.temperature, unit)}</span>
      </div>`;

      if (isTilt && dev.specificGravity != null) {
        html += `<div class="dash-metric">
          <span class="dash-metric-label">SG</span>
          <span class="dash-metric-value">${Math.round(dev.specificGravity * 1000)}</span>
        </div>`;
      }

      if (!isTilt) {
        html += `<div class="dash-metric">
          <span class="dash-metric-label">Target</span>
          <span class="dash-metric-value">${formatTemp(dev.targetTemperature, unit)}</span>
        </div>`;
        if (dev.coolingEnabled) {
          html += `<div class="dash-metric"><span class="dash-metric-label">Cooling</span><span class="dash-metric-value active-cool">Active</span></div>`;
        }
        if (dev.heatingEnabled) {
          html += `<div class="dash-metric"><span class="dash-metric-label">Heating</span><span class="dash-metric-value active-heat">Active</span></div>`;
        }
      }

      const lastSeen = dev._last_seen || dev.lastActivityTime;
      if (lastSeen) {
        const ago = Math.round((Date.now() - new Date(lastSeen).getTime()) / 1000);
        html += `<div class="dash-metric">
          <span class="dash-metric-label">Updated</span>
          <span class="dash-metric-value">${formatSeconds(ago)} ago</span>
        </div>`;
      }

      html += "</div>";
      card.innerHTML = html;
      container.appendChild(card);
    });
  } catch (e) {}
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

/* --- Nav click handlers --- */
document.querySelectorAll("[data-page]").forEach(el => {
  el.addEventListener("click", (e) => {
    e.preventDefault();
    showPage(el.getAttribute("data-page"));
  });
});

/* --- Wire up buttons --- */
btnSave.addEventListener("click", saveConfig);
btnStart.addEventListener("click", startBridge);
btnStop.addEventListener("click", stopBridge);

/* --- Init --- */
loadConfig();
checkStatus();
initConsole();
loadDevices();

// Poll status and devices
setInterval(checkStatus, 5000);
setInterval(loadDevices, 10000);
// Refresh dashboard if viewing it
setInterval(() => { if (currentPage === "dashboard") updateDashboardCards(); }, 10000);
