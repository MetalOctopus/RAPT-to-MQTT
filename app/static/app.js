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
let dashboardChart = null;
let dashboardSeries = [];
let deviceChart = null;
let deviceSeries = [];
let rssiChart = null;
let feedbackChart = null;

/* --- Navigation --- */
function showPage(page, deviceId) {
  document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
  document.querySelectorAll(".nav-item").forEach(n => n.classList.remove("active"));

  if (page === "device" && deviceId) {
    document.getElementById("page-device").classList.add("active");
    const navItem = document.querySelector(`.nav-item[data-device="${deviceId}"]`);
    if (navItem) navItem.classList.add("active");
    currentPage = "device";
    currentDeviceId = deviceId;
    loadDevice(deviceId);
    showSubtab("overview");
    loadDeviceMetrics(deviceId);
  } else {
    const pageEl = document.getElementById("page-" + page);
    if (pageEl) pageEl.classList.add("active");
    const navItem = document.querySelector(`[data-page="${page}"]`);
    if (navItem) navItem.classList.add("active");
    currentPage = page;
    currentDeviceId = null;
    if (page === "dashboard") { refreshDashboard(); loadChartDeviceList(); }
    if (page === "brew") loadBrewState();
  }
}

/* --- Sub-tabs --- */
function showSubtab(name) {
  document.querySelectorAll(".sub-tab").forEach(t => t.classList.remove("active"));
  document.querySelectorAll(".subtab-content").forEach(c => c.classList.remove("active"));
  const tab = document.querySelector(`.sub-tab[data-subtab="${name}"]`);
  const content = document.getElementById("subtab-" + name);
  if (tab) tab.classList.add("active");
  if (content) content.classList.add("active");
  if (name === "charts" && currentDeviceId) {
    loadDeviceMetrics(currentDeviceId);
    loadRssiChart(currentDeviceId);
  }
  if (name === "control" && currentDeviceId) loadControlTab(currentDeviceId);
}

document.querySelectorAll(".sub-tab").forEach(tab => {
  tab.addEventListener("click", () => showSubtab(tab.dataset.subtab));
});

/* --- Console --- */
function appendLog(line) {
  const div = document.createElement("div");
  div.className = "log-line";
  if (line.includes("[ERROR]")) div.className += " error";
  else if (line.includes("[WARNING]")) div.className += " warning";
  div.textContent = line;
  consoleEl.appendChild(div);
  while (consoleEl.children.length > MAX_LINES) consoleEl.removeChild(consoleEl.firstChild);
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

/* --- Helpers --- */
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
  return parseFloat(val).toFixed(1) + (unit === "F" ? "°F" : "°C");
}

function boolText(val) {
  if (val === true) return "Enabled";
  if (val === false) return "Disabled";
  return "—";
}

function rssiLabel(rssi) {
  if (rssi == null || isNaN(rssi)) return "—";
  const v = parseInt(rssi);
  let bars, label;
  if (v >= -50) { bars = "▂▄▆█"; label = "Excellent"; }
  else if (v >= -60) { bars = "▂▄▆"; label = "Good"; }
  else if (v >= -70) { bars = "▂▄"; label = "Fair"; }
  else { bars = "▂"; label = "Weak"; }
  return bars + "  " + label + " (" + v + " dBm)";
}

function timeAgo(isoStr) {
  if (!isoStr) return "";
  const secs = Math.round((Date.now() - new Date(isoStr).getTime()) / 1000);
  if (secs < 0) return "just now";
  if (secs < 60) return secs + "s ago";
  if (secs < 3600) return Math.floor(secs / 60) + "m ago";
  if (secs < 86400) return Math.floor(secs / 3600) + "h " + Math.floor((secs % 3600) / 60) + "m ago";
  return Math.floor(secs / 86400) + "d ago";
}

function esc(s) { const d = document.createElement("div"); d.textContent = s; return d.innerHTML; }

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
  } catch (e) {}
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
  } catch (e) { showToast("Failed to load config", "error"); }
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
    const res = await fetch("/api/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
    const result = await res.json();
    if (res.ok) showToast("Configuration saved", "success");
    else showToast(result.error || "Save failed", "error");
  } catch (e) { showToast("Failed to save config", "error"); }
}

async function startBridge() {
  try {
    const res = await fetch("/api/bridge/start", { method: "POST" });
    const result = await res.json();
    if (res.ok) { updateStatus(true); showToast("Bridge started", "success"); }
    else showToast(result.error || "Start failed", "error");
  } catch (e) { showToast("Failed to start bridge", "error"); }
}

async function stopBridge() {
  try {
    const res = await fetch("/api/bridge/stop", { method: "POST" });
    const result = await res.json();
    if (res.ok) { updateStatus(false); showToast("Bridge stopped", "success"); }
    else showToast(result.error || "Stop failed", "error");
  } catch (e) { showToast("Failed to stop bridge", "error"); }
}

/* --- Devices --- */
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
      const el = document.createElement("a");
      el.className = "nav-item" + (currentDeviceId === id ? " active" : "");
      el.setAttribute("data-device", id);
      el.href = "#";
      const rssi = dev.rssi;
      let rssiIcon = "";
      if (rssi != null) {
        if (rssi >= -50) rssiIcon = " ▂▄▆█";
        else if (rssi >= -60) rssiIcon = " ▂▄▆";
        else if (rssi >= -70) rssiIcon = " ▂▄";
        else rssiIcon = " ▂";
      }
      el.textContent = name + rssiIcon;
      el.addEventListener("click", (e) => { e.preventDefault(); showPage("device", id); });
      deviceListEl.appendChild(el);
    });
    if (currentPage === "device" && currentDeviceId && devices[currentDeviceId]) {
      renderDevice(devices[currentDeviceId]);
    }
  } catch (e) {}
}

async function loadDevice(deviceId) {
  try {
    const res = await fetch("/api/devices/" + deviceId);
    if (!res.ok) return;
    renderDevice(await res.json());
  } catch (e) {}
}

function renderDevice(dev) {
  const unit = dev.tempUnit || "C";
  const isTilt = dev.deviceType === "TILT";

  document.getElementById("device-name").textContent = dev.name || "Unknown Device";
  const connBadge = document.getElementById("device-connection");
  const connState = (dev.connectionState || "").toLowerCase();
  const isOnline = connState === "connected" || connState === "online";
  connBadge.textContent = isOnline ? "Online" : "Offline";
  connBadge.className = "badge " + (isOnline ? "online" : "offline");

  // Show/hide per device type
  document.getElementById("card-target-temp").style.display = isTilt ? "none" : "";
  document.getElementById("card-gravity").style.display = isTilt ? "" : "none";
  document.getElementById("card-cooling").style.display = isTilt ? "none" : "";
  document.getElementById("card-heating").style.display = isTilt ? "none" : "";
  document.querySelectorAll(".rapt-only").forEach(el => el.style.display = isTilt ? "none" : "");

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

  document.getElementById("info-name").textContent = dev.name || "—";
  document.getElementById("info-type").textContent = dev.deviceType || "—";
  document.getElementById("info-use").textContent = dev.customerUse || "—";
  document.getElementById("info-mac").textContent = dev.macAddress || "—";
  document.getElementById("info-firmware").textContent = dev.firmwareVersion || "—";
  document.getElementById("info-rssi").textContent = rssiLabel(dev.rssi);
  document.getElementById("info-unit").textContent = unit === "F" ? "Fahrenheit" : "Celsius";
  document.getElementById("info-sensor").textContent = dev.useInternalSensor === true ? "Internal" : dev.useInternalSensor === false ? "External" : "—";

  // Telemetry frequency: value is in seconds from API, display as human readable
  const tf = dev.telemetryFrequency;
  if (tf != null) {
    document.getElementById("info-telemetry").textContent = formatSeconds(tf * 60);
  } else {
    document.getElementById("info-telemetry").textContent = "—";
  }

  document.getElementById("row-use").style.display = isTilt ? "none" : "";
  document.getElementById("row-sensor").style.display = isTilt ? "none" : "";
  document.getElementById("row-telemetry").style.display = isTilt ? "none" : "";

  const lastActivity = dev.lastActivityTime || dev._last_seen;
  if (lastActivity) {
    document.getElementById("info-last-activity").textContent =
      new Date(lastActivity).toLocaleString() + " (" + timeAgo(lastActivity) + ")";
  } else {
    document.getElementById("info-last-activity").textContent = "—";
  }

  document.getElementById("stats-total").textContent = formatSeconds(dev.totalRunTime);
  document.getElementById("stats-cooling-time").textContent = formatSeconds(dev.coolingRunTime);
  document.getElementById("stats-cooling-starts").textContent = dev.coolingStarts != null ? dev.coolingStarts : "—";
  document.getElementById("stats-heating-time").textContent = formatSeconds(dev.heatingRunTime);
  document.getElementById("stats-heating-starts").textContent = dev.heatingStarts != null ? dev.heatingStarts : "—";

  document.getElementById("settings-pid").textContent = boolText(dev.pidEnabled);
  document.getElementById("settings-cool-hyst").textContent = dev.coolingHysteresis != null ? dev.coolingHysteresis + "°" : "—";
  document.getElementById("settings-heat-hyst").textContent = dev.heatingHysteresis != null ? dev.heatingHysteresis + "°" : "—";
  document.getElementById("settings-compressor").textContent = dev.compressorDelay != null ? dev.compressorDelay + " min" : "—";
  document.getElementById("settings-mode-switch").textContent = dev.modeSwitchDelay != null ? dev.modeSwitchDelay + " min" : "—";
  document.getElementById("settings-high-alarm").textContent = dev.highTempAlarm != null ? formatTemp(dev.highTempAlarm, unit) : "—";
  document.getElementById("settings-low-alarm").textContent = dev.lowTempAlarm != null ? formatTemp(dev.lowTempAlarm, unit) : "—";
  document.getElementById("settings-bluetooth").textContent = boolText(dev.bluetoothEnabled);
}

/* --- Dashboard --- */
let dashboardEnabled = {};

function refreshDashboard() { updateDashboardSelect(); updateDashboardCards(); }

async function updateDashboardSelect() {
  try {
    const devices = await (await fetch("/api/devices")).json();
    const container = document.getElementById("dashboard-device-select");
    Object.keys(devices).forEach(id => {
      if (container.querySelector(`[data-dash-device="${id}"]`)) return;
      const dev = devices[id];
      const label = document.createElement("label");
      label.className = "checkbox-group dash-check";
      label.setAttribute("data-dash-device", id);
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = dashboardEnabled[id] !== false;
      cb.addEventListener("change", () => { dashboardEnabled[id] = cb.checked; updateDashboardCards(); });
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
    const devices = await (await fetch("/api/devices")).json();
    const container = document.getElementById("dashboard-cards");
    container.innerHTML = "";
    Object.keys(devices).forEach(id => {
      if (dashboardEnabled[id] === false) return;
      const dev = devices[id];
      const isTilt = dev.deviceType === "TILT";
      const unit = dev.tempUnit || "C";
      const card = document.createElement("div");
      card.className = "panel dash-card";
      const connState = (dev.connectionState || "").toLowerCase();
      const isOnline = connState === "connected" || connState === "online";
      const rssi = dev.rssi;
      let rssiIcon = "";
      if (rssi != null) {
        if (rssi >= -50) rssiIcon = " ▂▄▆█";
        else if (rssi >= -60) rssiIcon = " ▂▄▆";
        else if (rssi >= -70) rssiIcon = " ▂▄";
        else rssiIcon = " ▂";
      }

      let html = `<div class="dash-card-header">
        <strong>${esc(dev.name || id.substring(0, 8))}${rssiIcon}</strong>
        <span class="badge ${isOnline ? 'online' : 'offline'}">${isOnline ? 'Online' : 'Offline'}</span>
      </div><div class="dash-card-metrics">`;

      // Main metrics first
      html += `<div class="dash-metric"><span class="dash-metric-label">Temp</span><span class="dash-metric-value">${formatTemp(dev.temperature, unit)}</span></div>`;
      if (isTilt && dev.specificGravity != null) {
        html += `<div class="dash-metric"><span class="dash-metric-label">SG</span><span class="dash-metric-value">${Math.round(dev.specificGravity * 1000)}</span></div>`;
      }
      if (!isTilt) {
        html += `<div class="dash-metric"><span class="dash-metric-label">Target</span><span class="dash-metric-value">${formatTemp(dev.targetTemperature, unit)}</span></div>`;
        if (dev.coolingEnabled && !dev.heatingEnabled) {
          html += `<div class="dash-metric"><span class="dash-metric-label">Mode</span><span class="dash-metric-value active-cool">Cooling</span></div>`;
        } else if (dev.heatingEnabled && !dev.coolingEnabled) {
          html += `<div class="dash-metric"><span class="dash-metric-label">Mode</span><span class="dash-metric-value active-heat">Heating</span></div>`;
        } else if (dev.coolingEnabled && dev.heatingEnabled) {
          const temp = dev.temperature, target = dev.targetTemperature;
          if (temp != null && target != null) {
            if (temp > target) html += `<div class="dash-metric"><span class="dash-metric-label">Mode</span><span class="dash-metric-value active-cool">Cooling</span></div>`;
            else html += `<div class="dash-metric"><span class="dash-metric-label">Mode</span><span class="dash-metric-value active-heat">Heating</span></div>`;
          } else {
            html += `<div class="dash-metric"><span class="dash-metric-label">Mode</span><span class="dash-metric-value">Auto</span></div>`;
          }
        }
      }

      // Updated at bottom
      const lastSeen = dev._last_seen || dev.lastActivityTime;
      if (lastSeen) {
        html += `<div class="dash-metric dash-metric-updated"><span class="dash-metric-label">Updated</span><span class="dash-metric-value dim-value">${timeAgo(lastSeen)}</span></div>`;
      }
      html += "</div>";
      card.innerHTML = html;
      container.appendChild(card);
    });
  } catch (e) {}
}

/* --- Charts --- */
const chartColors = ["#58a6ff", "#f0883e", "#2ea043", "#bc8cff", "#f85149", "#79c0ff", "#d29922", "#7ee787"];
let colorIdx = 0;

async function loadChartDeviceList() {
  try {
    const devices = await (await fetch("/api/devices")).json();
    const sel = document.getElementById("chart-device");
    sel.innerHTML = "";
    Object.keys(devices).forEach(id => {
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = devices[id].name || id.substring(0, 8);
      sel.appendChild(opt);
    });
    if (sel.value) loadChartMetrics(sel.value, "chart-metric");
  } catch (e) {}
}

async function loadChartMetrics(deviceId, selectId) {
  try {
    const metrics = await (await fetch(`/api/history/${deviceId}/metrics`)).json();
    const sel = document.getElementById(selectId);
    sel.innerHTML = "";
    metrics.forEach(m => {
      const opt = document.createElement("option");
      opt.value = m;
      opt.textContent = m;
      sel.appendChild(opt);
    });
  } catch (e) {}
}

async function addChartSeries(chartObj, seriesArr, canvasId, deviceId, metric, range, axis) {
  try {
    const start = (Date.now() / 1000) - parseInt(range);
    const data = await (await fetch(`/api/history/${deviceId}/${metric}?start=${start}&limit=2000`)).json();
    if (!data.length) { showToast("No data for this range", "error"); return; }

    const color = chartColors[colorIdx++ % chartColors.length];
    const devices = await (await fetch("/api/devices")).json();
    const devName = devices[deviceId]?.name || deviceId.substring(0, 8);

    seriesArr.push({ deviceId, metric, axis, color });

    const dataset = {
      label: `${devName} - ${metric}`,
      data: data.map(d => ({ x: d.timestamp * 1000, y: d.value })),
      borderColor: color,
      backgroundColor: color + "33",
      borderWidth: 2,
      pointRadius: 0,
      tension: 0.3,
      yAxisID: axis === "right" ? "y1" : "y",
    };

    if (!chartObj) {
      const ctx = document.getElementById(canvasId).getContext("2d");
      const cfg = {
        type: "line",
        data: { datasets: [dataset] },
        options: {
          responsive: true, maintainAspectRatio: false,
          interaction: { mode: "index", intersect: false },
          scales: {
            x: { type: "time", time: { tooltipFormat: "HH:mm:ss", displayFormats: { minute: "HH:mm", hour: "HH:mm" } },
                 ticks: { color: "#8b949e" }, grid: { color: "#21262d" } },
            y: { position: "left", ticks: { color: "#8b949e" }, grid: { color: "#21262d" } },
          },
          plugins: { legend: { labels: { color: "#c9d1d9" } } },
        },
      };
      if (axis === "right") {
        cfg.options.scales.y1 = { position: "right", ticks: { color: "#8b949e" }, grid: { drawOnChartArea: false } };
      }
      return new Chart(ctx, cfg);
    } else {
      chartObj.data.datasets.push(dataset);
      if (axis === "right" && !chartObj.options.scales.y1) {
        chartObj.options.scales.y1 = { position: "right", ticks: { color: "#8b949e" }, grid: { drawOnChartArea: false } };
      }
      chartObj.update();
      return chartObj;
    }
  } catch (e) { showToast("Failed to load chart data", "error"); return chartObj; }
}

// Dashboard chart buttons
document.getElementById("btn-add-series").addEventListener("click", async () => {
  const deviceId = document.getElementById("chart-device").value;
  const metric = document.getElementById("chart-metric").value;
  const range = document.getElementById("chart-range").value;
  const axis = document.getElementById("chart-axis").value;
  if (!deviceId || !metric) return;
  dashboardChart = await addChartSeries(dashboardChart, dashboardSeries, "dashboard-chart", deviceId, metric, range, axis);
});

document.getElementById("btn-clear-chart").addEventListener("click", () => {
  if (dashboardChart) { dashboardChart.destroy(); dashboardChart = null; }
  dashboardSeries = [];
  colorIdx = 0;
});

document.getElementById("chart-device").addEventListener("change", (e) => {
  loadChartMetrics(e.target.value, "chart-metric");
});

// Device chart
async function loadDeviceMetrics(deviceId) {
  try {
    const metrics = await (await fetch(`/api/history/${deviceId}/metrics`)).json();
    const sel = document.getElementById("dev-chart-metric");
    sel.innerHTML = "";
    metrics.forEach(m => {
      const opt = document.createElement("option");
      opt.value = m; opt.textContent = m;
      sel.appendChild(opt);
    });
  } catch (e) {}
}

document.getElementById("btn-dev-add-series").addEventListener("click", async () => {
  if (!currentDeviceId) return;
  const metric = document.getElementById("dev-chart-metric").value;
  const range = document.getElementById("dev-chart-range").value;
  const axis = document.getElementById("dev-chart-axis").value;
  if (!metric) return;
  deviceChart = await addChartSeries(deviceChart, deviceSeries, "device-chart", currentDeviceId, metric, range, axis);
});

document.getElementById("btn-dev-clear-chart").addEventListener("click", () => {
  if (deviceChart) { deviceChart.destroy(); deviceChart = null; }
  deviceSeries = [];
});

async function loadRssiChart(deviceId) {
  if (rssiChart) { rssiChart.destroy(); rssiChart = null; }
  try {
    const start = (Date.now() / 1000) - 86400;
    const data = await (await fetch(`/api/history/${deviceId}/rssi?start=${start}&limit=2000`)).json();
    if (!data.length) return;
    const ctx = document.getElementById("rssi-chart").getContext("2d");
    rssiChart = new Chart(ctx, {
      type: "line",
      data: { datasets: [{ label: "RSSI (dBm)", data: data.map(d => ({ x: d.timestamp * 1000, y: d.value })),
        borderColor: "#58a6ff", backgroundColor: "#58a6ff33", borderWidth: 2, pointRadius: 0, tension: 0.3 }] },
      options: {
        responsive: true, maintainAspectRatio: false,
        scales: {
          x: { type: "time", time: { tooltipFormat: "HH:mm:ss" }, ticks: { color: "#8b949e" }, grid: { color: "#21262d" } },
          y: { ticks: { color: "#8b949e" }, grid: { color: "#21262d" } },
        },
        plugins: { legend: { labels: { color: "#c9d1d9" } } },
      },
    });
  } catch (e) {}
}

/* --- Device Control --- */
function loadControlTab(deviceId) {
  const devices = window._cachedDevices || {};
  const dev = devices[deviceId];
  if (dev && dev.targetTemperature != null) {
    document.getElementById("ctrl-target-temp").value = dev.targetTemperature;
  }
}

document.getElementById("btn-set-temp").addEventListener("click", async () => {
  if (!currentDeviceId) return;
  const target = parseFloat(document.getElementById("ctrl-target-temp").value);
  if (isNaN(target)) { showToast("Enter a valid temperature", "error"); return; }
  try {
    const res = await fetch(`/api/devices/${currentDeviceId}/set_temperature`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target }),
    });
    const result = await res.json();
    if (res.ok) showToast(`Target set to ${target}°C`, "success");
    else showToast(result.error || "Failed", "error");
  } catch (e) { showToast("Failed to set temperature", "error"); }
});

/* --- Brew Session --- */
async function loadBrewState() {
  try {
    // Populate device selects
    const devices = await (await fetch("/api/devices")).json();
    const tiltSel = document.getElementById("brew-tilt");
    const ctrlSel = document.getElementById("brew-controller");
    tiltSel.innerHTML = '<option value="">None</option>';
    ctrlSel.innerHTML = '<option value="">None</option>';
    Object.keys(devices).forEach(id => {
      const dev = devices[id];
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = dev.name || id.substring(0, 8);
      if (dev.deviceType === "TILT") tiltSel.appendChild(opt);
      else ctrlSel.appendChild(opt);
    });

    // Check for active brew
    const brew = await (await fetch("/api/brew")).json();
    if (brew && brew.status === "active") {
      document.getElementById("brew-start-panel").style.display = "none";
      document.getElementById("brew-active-panel").style.display = "block";
      renderActiveBrew(brew);
    } else {
      document.getElementById("brew-start-panel").style.display = "block";
      document.getElementById("brew-active-panel").style.display = "none";
      loadBrewHistory();
    }
  } catch (e) {}
}

function renderActiveBrew(b) {
  document.getElementById("brew-active-name").textContent = b.name || "Untitled Brew";
  document.getElementById("brew-beer-temp").textContent = b.current_sg != null && b.tilt_device_id ? formatTemp(window._cachedDevices?.[b.tilt_device_id]?.temperature, "C") : "—";
  document.getElementById("brew-fridge-temp").textContent = b.fridge_temp != null ? formatTemp(b.fridge_temp, "C") : "—";
  document.getElementById("brew-sg").textContent = b.current_sg != null ? Math.round(b.current_sg * 1000) : "—";
  document.getElementById("brew-abv").textContent = b.current_abv != null ? b.current_abv.toFixed(1) + "%" : "—";

  const og = b.og;
  document.getElementById("brew-og-display").textContent = og != null ? Math.round(og * 1000) : "—";

  // Max ABV assumes FG of 1.010
  const maxAbv = og ? ((og - 1.010) * 131.25).toFixed(1) + "%" : "—";
  document.getElementById("brew-max-abv").textContent = maxAbv;

  // Gauge
  if (og && b.current_sg) {
    const totalDrop = og - 1.010;
    const currentDrop = og - b.current_sg;
    const pct = totalDrop > 0 ? Math.min(100, Math.max(0, Math.round((currentDrop / totalDrop) * 100))) : 0;
    document.getElementById("brew-gauge-fill").style.width = pct + "%";
    document.getElementById("brew-gauge-pct").textContent = pct + "%";
  }

  // Feedback status
  const fbEnabled = b.temp_feedback_enabled;
  document.getElementById("btn-feedback-start").disabled = fbEnabled;
  document.getElementById("btn-feedback-stop").disabled = !fbEnabled;
  document.getElementById("feedback-status").textContent = fbEnabled ? "Active — adjusting fridge target" : "Disabled";

  // Events
  const evList = document.getElementById("brew-events-list");
  evList.innerHTML = "";
  (b.events || []).forEach(ev => {
    const div = document.createElement("div");
    div.className = "brew-event";
    const t = new Date(ev.timestamp * 1000).toLocaleString();
    div.innerHTML = `<span class="brew-event-time">${t}</span> <strong>${esc(ev.event_type)}</strong> ${esc(ev.description || "")}`;
    evList.appendChild(div);
  });

  loadFeedbackChart(b.id);
}

async function loadFeedbackChart(sessionId) {
  if (feedbackChart) { feedbackChart.destroy(); feedbackChart = null; }
  try {
    const data = await (await fetch("/api/brew/feedback/log")).json();
    if (!data.length) return;
    const ctx = document.getElementById("feedback-chart").getContext("2d");
    feedbackChart = new Chart(ctx, {
      type: "line",
      data: {
        datasets: [
          { label: "Beer Temp", data: data.map(d => ({ x: d.timestamp * 1000, y: d.beer_temp })),
            borderColor: "#f0883e", borderWidth: 2, pointRadius: 0, tension: 0.3 },
          { label: "Target Beer", data: data.map(d => ({ x: d.timestamp * 1000, y: d.target_beer_temp })),
            borderColor: "#2ea043", borderWidth: 1, borderDash: [5, 5], pointRadius: 0 },
          { label: "Fridge Target", data: data.map(d => ({ x: d.timestamp * 1000, y: d.new_controller_target })),
            borderColor: "#58a6ff", borderWidth: 2, pointRadius: 0, tension: 0.3 },
          { label: "Fridge Temp", data: data.map(d => ({ x: d.timestamp * 1000, y: d.fridge_temp })),
            borderColor: "#79c0ff", borderWidth: 1, pointRadius: 0, tension: 0.3 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        scales: {
          x: { type: "time", ticks: { color: "#8b949e" }, grid: { color: "#21262d" } },
          y: { ticks: { color: "#8b949e" }, grid: { color: "#21262d" } },
        },
        plugins: { legend: { labels: { color: "#c9d1d9" } } },
      },
    });
  } catch (e) {}
}

document.getElementById("btn-start-brew").addEventListener("click", async () => {
  const ogRaw = document.getElementById("brew-og").value;
  const data = {
    name: document.getElementById("brew-name").value || "Untitled Brew",
    og: ogRaw ? parseFloat(ogRaw) / 1000 : null,
    target_beer_temp: parseFloat(document.getElementById("brew-target-temp").value) || null,
    tilt_device_id: document.getElementById("brew-tilt").value || null,
    controller_device_id: document.getElementById("brew-controller").value || null,
    notes: document.getElementById("brew-notes").value,
  };
  try {
    const res = await fetch("/api/brew/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
    if (res.ok) { showToast("Brew started!", "success"); loadBrewState(); }
    else { const r = await res.json(); showToast(r.error || "Failed", "error"); }
  } catch (e) { showToast("Failed to start brew", "error"); }
});

document.getElementById("btn-complete-brew").addEventListener("click", async () => {
  try {
    await fetch("/api/brew/complete", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
    showToast("Brew completed!", "success");
    loadBrewState();
  } catch (e) { showToast("Failed", "error"); }
});

document.getElementById("btn-cancel-brew").addEventListener("click", async () => {
  if (!confirm("Cancel this brew session?")) return;
  try {
    await fetch("/api/brew/cancel", { method: "POST" });
    showToast("Brew cancelled", "success");
    loadBrewState();
  } catch (e) { showToast("Failed", "error"); }
});

document.getElementById("btn-feedback-start").addEventListener("click", async () => {
  try {
    await fetch("/api/brew/feedback/start", { method: "POST" });
    showToast("Smart feedback enabled", "success");
    loadBrewState();
  } catch (e) { showToast("Failed", "error"); }
});

document.getElementById("btn-feedback-stop").addEventListener("click", async () => {
  try {
    await fetch("/api/brew/feedback/stop", { method: "POST" });
    showToast("Smart feedback disabled", "success");
    loadBrewState();
  } catch (e) { showToast("Failed", "error"); }
});

document.querySelectorAll(".brew-event-btn").forEach(btn => {
  btn.addEventListener("click", async () => {
    const eventType = btn.dataset.event;
    let desc = "";
    if (eventType === "note") {
      desc = prompt("Enter note:");
      if (!desc) return;
    }
    try {
      await fetch("/api/brew/event", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event_type: eventType, description: desc }) });
      showToast("Event logged", "success");
      loadBrewState();
    } catch (e) { showToast("Failed", "error"); }
  });
});

async function loadBrewHistory() {
  try {
    const data = await (await fetch("/api/brew/history")).json();
    const el = document.getElementById("brew-history-list");
    if (!data.length) { el.innerHTML = "No previous brews."; return; }
    el.innerHTML = data.map(b =>
      `<div class="brew-history-item"><strong>${esc(b.name)}</strong> — ${b.status} (${new Date(b.started_at).toLocaleDateString()})</div>`
    ).join("");
  } catch (e) {}
}

/* --- SSE Console --- */
function initConsole() {
  fetch("/api/logs/history").then(r => r.json()).then(lines => lines.forEach(appendLog)).catch(() => {});
  const source = new EventSource("/api/logs/stream");
  source.onmessage = (e) => appendLog(e.data);
}

/* --- Nav click handlers --- */
document.querySelectorAll("[data-page]").forEach(el => {
  el.addEventListener("click", (e) => { e.preventDefault(); showPage(el.getAttribute("data-page")); });
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

// Cache devices for cross-page use
setInterval(async () => {
  try { window._cachedDevices = await (await fetch("/api/devices")).json(); } catch (e) {}
}, 5000);

setInterval(checkStatus, 5000);
setInterval(loadDevices, 10000);
setInterval(() => {
  if (currentPage === "dashboard") updateDashboardCards();
  if (currentPage === "brew") loadBrewState();
}, 10000);
