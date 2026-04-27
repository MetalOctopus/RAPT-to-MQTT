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
let currentBrewId = null;

/* Chart instances (persisted across navigation) */
let dashboardChart = null;
let dashboardSeries = [];
let deviceChart = null;
let deviceSeries = [];
let rssiChart = null;
let feedbackChart = null;
let tiltTempChart = null;
let tiltSgChart = null;
let brewCharts = {};      // sessionId -> Chart instance
let brewChartSeries = {}; // sessionId -> series array

/* Dashboard toggles */
let dashboardEnabled = {};
const chartColors = ["#58a6ff", "#f0883e", "#2ea043", "#bc8cff", "#f85149", "#79c0ff", "#d29922", "#7ee787"];
let colorIdx = 0;

/* --- Navigation --- */
function showPage(page, id) {
  document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
  document.querySelectorAll(".nav-item").forEach(n => n.classList.remove("active"));

  if (page === "device" && id) {
    document.getElementById("page-device").classList.add("active");
    const navItem = document.querySelector(`.nav-item[data-device="${id}"]`);
    if (navItem) navItem.classList.add("active");
    currentPage = "device";
    currentDeviceId = id;
    currentBrewId = null;
    loadDevice(id);
    showSubtab("overview");
    loadDeviceMetrics(id);
  } else if (page === "brew-detail" && id) {
    document.getElementById("page-brew-detail").classList.add("active");
    document.querySelector('[data-page="brews"]').classList.add("active");
    currentPage = "brew-detail";
    currentBrewId = id;
    currentDeviceId = null;
    loadBrewDetail(id);
  } else {
    const pageEl = document.getElementById("page-" + page);
    if (pageEl) pageEl.classList.add("active");
    const navItem = document.querySelector(`[data-page="${page}"]`);
    if (navItem) navItem.classList.add("active");
    currentPage = page;
    currentDeviceId = null;
    if (page !== "brew-detail") currentBrewId = null;
    if (page === "dashboard") { refreshDashboard(); loadChartDeviceList(); }
    if (page === "brews") loadBrewsPage();
    if (page === "newbrew") { loadNewBrewForm(); applyAffiliateVisibility(); }
    if (page === "integrations") applyAffiliateVisibility();
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
  if (secs == null || isNaN(secs)) return "--";
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
  if (val == null || isNaN(val)) return "--";
  return parseFloat(val).toFixed(1) + (unit === "F" ? "\u00b0F" : "\u00b0C");
}

function boolText(val) {
  if (val === true) return "Enabled";
  if (val === false) return "Disabled";
  return "--";
}

function rssiLabel(rssi) {
  if (rssi == null || isNaN(rssi)) return "--";
  const v = parseInt(rssi);
  let label;
  if (v >= -40) label = "Excellent";
  else if (v >= -50) label = "Great";
  else if (v >= -60) label = "Good";
  else if (v >= -70) label = "Fair";
  else label = "Weak";
  return rssiIcon(rssi) + " " + label + " (" + v + " dBm)";
}

function rssiIcon(rssi) {
  if (rssi == null) return "";
  const v = parseInt(rssi);
  let bars;
  if (v >= -40) bars = 5;
  else if (v >= -50) bars = 4;
  else if (v >= -60) bars = 3;
  else if (v >= -70) bars = 2;
  else bars = 1;
  const heights = [4, 7, 10, 13, 16];
  let svg = '<svg viewBox="0 0 20 16" width="18" height="14" class="rssi-bars" style="vertical-align:middle;margin-left:5px">';
  for (let i = 0; i < 5; i++) {
    const h = heights[i];
    const x = i * 4;
    const fill = i < bars ? "#58a6ff" : "#30363d";
    svg += `<rect x="${x}" y="${16 - h}" width="3" height="${h}" rx="0.5" fill="${fill}"/>`;
  }
  svg += "</svg>";
  return svg;
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

function daysSince(isoStr) {
  if (!isoStr) return 0;
  return (Date.now() - new Date(isoStr).getTime()) / 86400000;
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
    document.getElementById("notification_topic").value = cfg.notification_topic || "RAPT2MQTT/notify";
    document.getElementById("auto_start").checked = cfg.auto_start !== false;
    document.getElementById("hide_affiliate_links").checked = !!cfg.hide_affiliate_links;
    window._hideAffiliateLinks = !!cfg.hide_affiliate_links;
    applyAffiliateVisibility();
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
    notification_topic: document.getElementById("notification_topic").value,
    auto_start: document.getElementById("auto_start").checked,
    hide_affiliate_links: document.getElementById("hide_affiliate_links").checked,
  };
  try {
    const res = await fetch("/api/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
    const result = await res.json();
    if (res.ok) {
      showToast("Configuration saved", "success");
      window._hideAffiliateLinks = data.hide_affiliate_links;
      applyAffiliateVisibility();
    } else showToast(result.error || "Save failed", "error");
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
    window._cachedDevices = devices;
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
      el.innerHTML = esc(name) + rssiIcon(dev.rssi);
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

  document.getElementById("card-target-temp").style.display = isTilt ? "none" : "";
  document.getElementById("card-gravity").style.display = isTilt ? "" : "none";
  document.getElementById("card-mode").style.display = isTilt ? "none" : "";
  document.querySelectorAll(".rapt-only").forEach(el => el.style.display = isTilt ? "none" : "");

  // TILT default charts
  document.getElementById("tilt-default-charts").style.display = isTilt ? "block" : "none";
  if (isTilt) loadTiltDefaultCharts(dev.id);

  if (isTilt) {
    const tempStr = dev.temperature != null
      ? formatTemp(dev.temperature, "C") + " (" + dev.temperature_f + "\u00b0F)"
      : "--";
    document.getElementById("device-current-temp").textContent = tempStr;
    document.getElementById("device-gravity").textContent =
      dev.specificGravity != null ? Math.round(dev.specificGravity * 1000) : "--";
  } else {
    document.getElementById("device-current-temp").textContent = formatTemp(dev.temperature, unit);
    document.getElementById("device-target-temp").textContent = formatTemp(dev.targetTemperature, unit);
    const cooling = dev._cooling_active;
    const heating = dev._heating_active;
    const mode = cooling ? "Cooling" : (heating ? "Heating" : "Idle");
    const modeEl = document.getElementById("device-mode");
    modeEl.textContent = mode;
    modeEl.className = "card-value" + (cooling ? " mode-cool" : (heating ? " mode-heat" : ""));
  }

  document.getElementById("info-name").textContent = dev.name || "--";
  document.getElementById("info-type").textContent = dev.deviceType || "--";
  document.getElementById("info-use").textContent = dev.customerUse || "--";
  document.getElementById("info-mac").textContent = dev.macAddress || "--";
  document.getElementById("info-firmware").textContent = dev.firmwareVersion || "--";
  document.getElementById("info-rssi").innerHTML = rssiLabel(dev.rssi);
  document.getElementById("info-unit").textContent = unit === "F" ? "Fahrenheit" : "Celsius";
  document.getElementById("info-sensor").textContent = dev.useInternalSensor === true ? "Internal" : dev.useInternalSensor === false ? "External" : "--";

  const tf = dev.telemetryFrequency;
  document.getElementById("info-telemetry").textContent = tf != null ? formatSeconds(tf * 60) : "--";

  document.getElementById("row-use").style.display = isTilt ? "none" : "";
  document.getElementById("row-sensor").style.display = isTilt ? "none" : "";
  document.getElementById("row-telemetry").style.display = isTilt ? "none" : "";

  const lastActivity = dev.lastActivityTime || dev._last_seen;
  if (lastActivity) {
    document.getElementById("info-last-activity").textContent =
      new Date(lastActivity).toLocaleString() + " (" + timeAgo(lastActivity) + ")";
  } else {
    document.getElementById("info-last-activity").textContent = "--";
  }

  document.getElementById("stats-total").textContent = formatSeconds(dev.totalRunTime);
  document.getElementById("stats-cooling-time").textContent = formatSeconds(dev.coolingRunTime);
  document.getElementById("stats-cooling-starts").textContent = dev.coolingStarts != null ? dev.coolingStarts : "--";
  document.getElementById("stats-heating-time").textContent = formatSeconds(dev.heatingRunTime);
  document.getElementById("stats-heating-starts").textContent = dev.heatingStarts != null ? dev.heatingStarts : "--";

  document.getElementById("settings-cool-allowed").textContent = boolText(dev.coolingEnabled);
  document.getElementById("settings-heat-allowed").textContent = boolText(dev.heatingEnabled);
  document.getElementById("settings-pid").textContent = boolText(dev.pidEnabled);
  document.getElementById("settings-cool-hyst").textContent = dev.coolingHysteresis != null ? dev.coolingHysteresis + "\u00b0" : "--";
  document.getElementById("settings-heat-hyst").textContent = dev.heatingHysteresis != null ? dev.heatingHysteresis + "\u00b0" : "--";
  document.getElementById("settings-compressor").textContent = dev.compressorDelay != null ? dev.compressorDelay + " min" : "--";
  document.getElementById("settings-mode-switch").textContent = dev.modeSwitchDelay != null ? dev.modeSwitchDelay + " min" : "--";
  document.getElementById("settings-high-alarm").textContent = dev.highTempAlarm != null ? formatTemp(dev.highTempAlarm, unit) : "--";
  document.getElementById("settings-low-alarm").textContent = dev.lowTempAlarm != null ? formatTemp(dev.lowTempAlarm, unit) : "--";
  document.getElementById("settings-bluetooth").textContent = boolText(dev.bluetoothEnabled);
}

/* --- TILT Default Charts --- */
async function loadTiltDefaultCharts(deviceId) {
  try {
    const start = (Date.now() / 1000) - 86400;

    // Temperature chart with red-blue gradient (4-30 C)
    const tempData = await (await fetch(`/api/history/${deviceId}/temperature?start=${start}&limit=10000`)).json();
    if (tiltTempChart) { tiltTempChart.destroy(); tiltTempChart = null; }
    if (tempData.length) {
      const ctx = document.getElementById("tilt-temp-chart").getContext("2d");
      const grad = ctx.createLinearGradient(0, 0, 0, 300);
      grad.addColorStop(0, "rgba(218, 54, 51, 0.6)");   // hot red at top (30C)
      grad.addColorStop(1, "rgba(88, 166, 255, 0.6)");   // cold blue at bottom (4C)
      tiltTempChart = new Chart(ctx, {
        type: "line",
        data: { datasets: [{
          label: "Temperature (\u00b0C)",
          data: tempData.map(d => ({ x: d.timestamp * 1000, y: d.value })),
          borderColor: "#f0883e",
          backgroundColor: grad,
          fill: true, borderWidth: 2, pointRadius: 0, tension: 0.3,
        }]},
        options: {
          responsive: true, maintainAspectRatio: false,
          scales: {
            x: { type: "time", time: { tooltipFormat: "HH:mm:ss", displayFormats: { minute: "HH:mm", hour: "HH:mm" } },
                 ticks: { color: "#8b949e" }, grid: { color: "#21262d" } },
            y: { min: 4, max: 30, ticks: { color: "#8b949e" }, grid: { color: "#21262d" } },
          },
          plugins: { legend: { labels: { color: "#c9d1d9" } } },
        },
      });
    }

    // SG chart with theme-appropriate line
    const sgData = await (await fetch(`/api/history/${deviceId}/specificGravity?start=${start}&limit=10000`)).json();
    if (tiltSgChart) { tiltSgChart.destroy(); tiltSgChart = null; }
    if (sgData.length) {
      const ctx2 = document.getElementById("tilt-sg-chart").getContext("2d");
      tiltSgChart = new Chart(ctx2, {
        type: "line",
        data: { datasets: [{
          label: "Specific Gravity",
          data: sgData.map(d => ({ x: d.timestamp * 1000, y: d.value })),
          borderColor: "#c9d1d9",
          backgroundColor: "rgba(201, 209, 217, 0.1)",
          fill: true, borderWidth: 2, pointRadius: 0, tension: 0.3,
        }]},
        options: {
          responsive: true, maintainAspectRatio: false,
          scales: {
            x: { type: "time", time: { tooltipFormat: "HH:mm:ss", displayFormats: { minute: "HH:mm", hour: "HH:mm" } },
                 ticks: { color: "#8b949e" }, grid: { color: "#21262d" } },
            y: { ticks: { color: "#8b949e" }, grid: { color: "#21262d" } },
          },
          plugins: { legend: { labels: { color: "#c9d1d9" } } },
        },
      });
    }
  } catch (e) {}
}

/* --- Dashboard --- */
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

      let html = `<div class="dash-card-header">
        <strong>${esc(dev.name || id.substring(0, 8))}${rssiIcon(dev.rssi)}</strong>
        <span class="badge ${isOnline ? 'online' : 'offline'}">${isOnline ? 'Online' : 'Offline'}</span>
      </div><div class="dash-card-metrics">`;

      html += `<div class="dash-metric"><span class="dash-metric-label">Temp</span><span class="dash-metric-value">${formatTemp(dev.temperature, unit)}</span></div>`;
      if (isTilt && dev.specificGravity != null) {
        html += `<div class="dash-metric"><span class="dash-metric-label">SG</span><span class="dash-metric-value">${Math.round(dev.specificGravity * 1000)}</span></div>`;
      }
      if (!isTilt) {
        html += `<div class="dash-metric"><span class="dash-metric-label">Target</span><span class="dash-metric-value">${formatTemp(dev.targetTemperature, unit)}</span></div>`;
        const cooling = dev._cooling_active;
        const heating = dev._heating_active;
        const mode = cooling ? "Cooling" : (heating ? "Heating" : "Idle");
        const modeClass = cooling ? "active-cool" : (heating ? "active-heat" : "dim-value");
        html += `<div class="dash-metric"><span class="dash-metric-label">Mode</span><span class="dash-metric-value ${modeClass}">${mode}</span></div>`;
      }

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
      opt.value = m; opt.textContent = m;
      sel.appendChild(opt);
    });
  } catch (e) {}
}

async function addChartSeries(chartObj, seriesArr, canvasId, deviceId, metric, range, axis) {
  try {
    const start = (Date.now() / 1000) - parseInt(range);
    const limit = parseInt(range) >= 604800 ? 10000 : 5000;
    const data = await (await fetch(`/api/history/${deviceId}/${metric}?start=${start}&limit=${limit}`)).json();
    if (!data.length) { showToast("No data for this range", "error"); return chartObj; }

    const color = chartColors[colorIdx++ % chartColors.length];
    const devices = window._cachedDevices || {};
    const devName = devices[deviceId]?.name || deviceId.substring(0, 8);

    seriesArr.push({ deviceId, metric, range, axis, color });

    const dataset = {
      label: `${devName} - ${metric}`,
      data: data.map(d => ({ x: d.timestamp * 1000, y: d.value })),
      borderColor: color,
      backgroundColor: color + "33",
      borderWidth: 2, pointRadius: 0, tension: 0.3,
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
    const data = await (await fetch(`/api/history/${deviceId}/rssi?start=${start}&limit=5000`)).json();
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
  const dev = (window._cachedDevices || {})[deviceId];
  if (!dev) return;
  if (dev.targetTemperature != null) {
    document.getElementById("ctrl-target-temp").value = parseFloat(dev.targetTemperature).toFixed(1);
  }
  document.getElementById("ctrl-pid-status").textContent = dev.pidEnabled ? "Enabled" : "Disabled";
  if (dev.pidProportional != null) document.getElementById("ctrl-pid-p").value = dev.pidProportional;
  if (dev.pidIntegral != null) document.getElementById("ctrl-pid-i").value = dev.pidIntegral;
  if (dev.pidDerivative != null) document.getElementById("ctrl-pid-d").value = dev.pidDerivative;
}

document.getElementById("btn-set-temp").addEventListener("click", async () => {
  if (!currentDeviceId) return;
  const target = parseFloat(document.getElementById("ctrl-target-temp").value);
  if (isNaN(target)) { showToast("Enter a valid temperature", "error"); return; }
  try {
    const res = await fetch(`/api/devices/${currentDeviceId}/set_temperature`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target: Math.round(target * 10) / 10 }),
    });
    const result = await res.json();
    if (res.ok) showToast(`Target set to ${(Math.round(target * 10) / 10).toFixed(1)}\u00b0C`, "success");
    else showToast(result.error || "Failed", "error");
  } catch (e) { showToast("Failed to set temperature", "error"); }
});

document.getElementById("btn-pid-enable").addEventListener("click", async () => {
  if (!currentDeviceId) return;
  try {
    const res = await fetch(`/api/devices/${currentDeviceId}/set_pid_enabled`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: true }),
    });
    if (res.ok) { showToast("PID enabled", "success"); loadControlTab(currentDeviceId); }
    else showToast("Failed", "error");
  } catch (e) { showToast("Failed", "error"); }
});

document.getElementById("btn-pid-disable").addEventListener("click", async () => {
  if (!currentDeviceId) return;
  try {
    const res = await fetch(`/api/devices/${currentDeviceId}/set_pid_enabled`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: false }),
    });
    if (res.ok) { showToast("PID disabled", "success"); loadControlTab(currentDeviceId); }
    else showToast("Failed", "error");
  } catch (e) { showToast("Failed", "error"); }
});

document.getElementById("btn-set-pid").addEventListener("click", async () => {
  if (!currentDeviceId) return;
  const p = parseFloat(document.getElementById("ctrl-pid-p").value);
  const i = parseFloat(document.getElementById("ctrl-pid-i").value);
  const d = parseFloat(document.getElementById("ctrl-pid-d").value);
  if (isNaN(p) || isNaN(i) || isNaN(d)) { showToast("Enter valid PID values", "error"); return; }
  try {
    const res = await fetch(`/api/devices/${currentDeviceId}/set_pid`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ p, i, d }),
    });
    if (res.ok) showToast("PID values updated", "success");
    else showToast("Failed", "error");
  } catch (e) { showToast("Failed", "error"); }
});

/* --- Brews Page (tiles) --- */
async function loadBrewsPage() {
  try {
    const brews = await (await fetch("/api/brews")).json();
    const tilesEl = document.getElementById("brew-tiles");
    const emptyEl = document.getElementById("brew-tiles-empty");
    tilesEl.innerHTML = "";

    if (!brews.length) {
      emptyEl.style.display = "block";
    } else {
      emptyEl.style.display = "none";
      brews.forEach(b => {
        const tile = document.createElement("div");
        tile.className = "panel brew-tile";
        tile.style.cursor = "pointer";
        tile.addEventListener("click", () => showPage("brew-detail", b.id));

        const og = b.og;
        const sg = b.current_sg;
        const abv = b.current_abv;
        const pct = (og && sg) ? Math.min(100, Math.max(0, Math.round(((og - sg) / (og - 1.010)) * 100))) : 0;
        const days = daysSince(b.started_at).toFixed(1);

        tile.innerHTML = `
          <div class="brew-tile-header">
            <strong>${esc(b.name)}</strong>
            <span class="badge online">Active</span>
          </div>
          <div class="brew-tile-metrics">
            <div class="brew-tile-metric">
              <span class="brew-tile-label">Day</span>
              <span class="brew-tile-value">${days}</span>
            </div>
            <div class="brew-tile-metric">
              <span class="brew-tile-label">SG</span>
              <span class="brew-tile-value">${sg != null ? Math.round(sg * 1000) : '--'}</span>
            </div>
            <div class="brew-tile-metric">
              <span class="brew-tile-label">ABV</span>
              <span class="brew-tile-value">${abv != null ? abv.toFixed(1) + '%' : '--'}</span>
            </div>
            <div class="brew-tile-metric">
              <span class="brew-tile-label">Progress</span>
              <span class="brew-tile-value">${pct}%</span>
            </div>
          </div>
          <div class="brew-tile-bar"><div class="brew-tile-fill" style="width:${pct}%"></div></div>
        `;
        tilesEl.appendChild(tile);
      });
    }
    loadBrewHistory();
  } catch (e) {}
}

async function loadBrewHistory() {
  try {
    const data = await (await fetch("/api/brew/history")).json();
    const el = document.getElementById("brew-history-list");
    const completed = data.filter(b => b.status !== "active");
    if (!completed.length) { el.innerHTML = "No previous brews."; return; }
    el.innerHTML = completed.map(b => {
      const ogStr = b.og ? Math.round(b.og * 1000) : "--";
      const fgStr = b.fg ? Math.round(b.fg * 1000) : "--";
      return `<div class="brew-history-item"><strong>${esc(b.name)}</strong> -- ${b.status} (${new Date(b.started_at).toLocaleDateString()}) OG: ${ogStr} FG: ${fgStr}</div>`;
    }).join("");
  } catch (e) {}
}

/* --- +Brew Page --- */
async function loadNewBrewForm() {
  try {
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
    temp_source: document.getElementById("brew-temp-source").value,
    notes: document.getElementById("brew-notes").value,
  };
  try {
    const res = await fetch("/api/brews/start", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
    if (res.ok) {
      const session = await res.json();
      showToast("Brew started!", "success");
      // Clear form
      document.getElementById("brew-name").value = "";
      document.getElementById("brew-og").value = "";
      document.getElementById("brew-target-temp").value = "";
      document.getElementById("brew-notes").value = "";
      showPage("brew-detail", session.id);
    } else {
      const r = await res.json();
      showToast(r.error || "Failed", "error");
    }
  } catch (e) { showToast("Failed to start brew", "error"); }
});

/* --- Brew Detail --- */
async function loadBrewDetail(sessionId) {
  try {
    const res = await fetch(`/api/brews/${sessionId}`);
    if (!res.ok) { showToast("Brew not found", "error"); showPage("brews"); return; }
    const b = await res.json();
    renderBrewDetail(b);
    autoPopulateBrewChart(b);
    // Restore filter button state
    const filterBtn = document.getElementById("btn-brew-filter");
    if (filterBtn) filterBtn.textContent = brewFilterEnabled[sessionId] ? "Filter: ON" : "Filter: OFF";
  } catch (e) {}
}

function renderBrewDetail(b) {
  document.getElementById("brew-detail-name").textContent = b.name || "Untitled Brew";

  const days = daysSince(b.started_at);
  document.getElementById("brew-detail-duration").textContent = `Day ${Math.floor(days)} (${formatSeconds(days * 86400)})`;

  // Beer temp from live data
  const beerTemp = b.beer_temp;
  document.getElementById("brew-beer-temp").textContent = beerTemp != null ? formatTemp(beerTemp, "C") : "--";
  document.getElementById("brew-fridge-temp").textContent = b.fridge_temp != null ? formatTemp(b.fridge_temp, "C") : "--";
  document.getElementById("brew-sg").textContent = b.current_sg != null ? Math.round(b.current_sg * 1000) : "--";
  document.getElementById("brew-abv").textContent = b.current_abv != null ? b.current_abv.toFixed(1) + "%" : "--";

  const og = b.og;
  document.getElementById("brew-og-display").textContent = og != null ? Math.round(og * 1000) : "--";
  document.getElementById("brew-target-display").textContent = b.target_beer_temp != null ? formatTemp(b.target_beer_temp, "C") : "--";
  document.getElementById("brew-fridge-target").textContent = b.controller_target != null ? formatTemp(b.controller_target, "C") : "--";

  // Temp source display
  const sourceLabels = { hydrometer: "Hydrometer", controller: "Controller", mean: "Mean" };
  document.getElementById("brew-temp-source-display").textContent = sourceLabels[b.temp_source] || "Hydrometer";

  // ABV under gauge
  const abvText = b.current_abv != null ? b.current_abv.toFixed(1) + "% ABV" : "-- ABV";
  document.getElementById("gauge-abv-display").textContent = abvText;

  // OG hint: if current SG > OG, suggest updating
  if (og && b.current_sg && b.current_sg > og) {
    const hint = document.getElementById("brew-og-hint");
    hint.style.display = "block";
    hint.textContent = `SG reading ${Math.round(b.current_sg * 1000)} > OG ${Math.round(og * 1000)} -- update OG?`;
    hint.style.cursor = "pointer";
    hint.onclick = () => {
      const newOg = Math.round(b.current_sg * 1000);
      if (confirm(`Update OG to ${newOg}?`)) {
        updateBrewField(b.id, "og", b.current_sg);
      }
    };
  } else {
    document.getElementById("brew-og-hint").style.display = "none";
  }

  // Needle gauge
  updateNeedleGauge(b);

  // Feedback status
  const fbEnabled = b.temp_feedback_enabled;
  document.getElementById("btn-feedback-start").disabled = fbEnabled;
  document.getElementById("btn-feedback-stop").disabled = !fbEnabled;
  document.getElementById("feedback-status").textContent = fbEnabled ? "Active -- adjusting fridge target" : "Disabled";

  // Reminders
  renderReminders(b.reminders || [], b.id);

  // Events (text-based brew log)
  renderBrewLog(b.events || [], b.started_at);

  // Load feedback chart (only if not already loaded for this session)
  loadFeedbackChart(b.id);
}

let brewGauges = {};

function ensureGauge(id) {
  if (!brewGauges[id]) {
    const el = document.getElementById(id);
    if (!el) return null;
    brewGauges[id] = echarts.init(el, null, { renderer: "canvas" });
  }
  return brewGauges[id];
}

function gaugeBase(min, max, value, fmt, arcColors, needleColor, anchorColor, targetValue) {
  const series = [
    // Outer decorative ring
    { type: "gauge", startAngle: 180, endAngle: 0, min, max, z: 1,
      radius: "95%", center: ["50%", "78%"],
      axisLine: { lineStyle: { width: 2, color: [[1, anchorColor.replace(")", ",0.15)").replace("rgb", "rgba")]] } },
      axisTick: { show: false }, splitLine: { show: false }, axisLabel: { show: false },
      pointer: { show: false }, detail: { show: false }, title: { show: false } },
    // Main gauge
    { type: "gauge", startAngle: 180, endAngle: 0, min, max, z: 2,
      radius: "88%", center: ["50%", "78%"],
      axisLine: { roundCap: true, lineStyle: { width: 14, color: arcColors } },
      axisTick: { distance: 2, length: 4, lineStyle: { color: "#8b949e", width: 1 } },
      splitLine: { distance: 2, length: 10, lineStyle: { color: "#8b949e", width: 1.5 } },
      axisLabel: { distance: 16, color: "#484f58", fontSize: 11 },
      pointer: {
        length: "65%", width: 5, offsetCenter: [0, "-8%"],
        itemStyle: {
          color: { type: "linear", x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [{ offset: 0, color: needleColor }, { offset: 1, color: "#484f58" }] },
          shadowColor: "rgba(0,0,0,0.6)", shadowBlur: 8, shadowOffsetY: 4,
        },
      },
      anchor: { show: true, size: 12, showAbove: true,
        itemStyle: { borderWidth: 2, borderColor: anchorColor, color: "#21262d",
          shadowColor: anchorColor.replace(")", ",0.3)").replace("rgb", "rgba"), shadowBlur: 8 } },
      detail: {
        valueAnimation: true, fontSize: 28, fontWeight: "700",
        color: "#e6edf3", offsetCenter: [0, "28%"], formatter: fmt,
      },
      title: { show: false },
      data: [{ value }],
      animationDuration: 2000, animationEasingUpdate: "elasticOut",
    },
  ];
  // Target marker
  if (targetValue != null) {
    series.push({
      type: "gauge", startAngle: 180, endAngle: 0, min, max, z: 3,
      radius: "88%", center: ["50%", "78%"],
      axisLine: { show: false }, axisTick: { show: false }, splitLine: { show: false }, axisLabel: { show: false },
      pointer: { length: "90%", width: 2, offsetCenter: [0, 0], itemStyle: { color: "rgba(46,160,67,0.6)" } },
      detail: { show: false }, title: { show: false },
      data: [{ value: targetValue }], silent: true,
    });
  }
  return { series, backgroundColor: "transparent" };
}

function updateNeedleGauge(b) {
  const og = b.og;
  const sg = b.current_sg;
  const estFg = 1.010;

  // --- Fermentation % ---
  let pct = 0;
  if (og && sg) {
    const totalDrop = og - estFg;
    const currentDrop = og - sg;
    pct = totalDrop > 0 ? Math.min(100, Math.max(0, (currentDrop / totalDrop) * 100)) : 0;
  }
  const gFerm = ensureGauge("gauge-fermentation");
  if (gFerm) {
    const opt = gaugeBase(0, 100, Math.round(pct), "{value}%",
      [[0.30, "#2ea043"], [0.50, "#7ee787"], [0.70, "#d29922"], [0.85, "#f0883e"], [1, "#f85149"]],
      "#ffffff", "rgb(88,166,255)");
    // Add inner progress track
    opt.series.push({
      type: "gauge", startAngle: 180, endAngle: 0, min: 0, max: 100, z: 1,
      radius: "72%", center: ["50%", "78%"],
      axisLine: { lineStyle: { width: 3, color: [[pct / 100, "rgba(46,160,67,0.3)"], [1, "transparent"]] } },
      axisTick: { show: false }, splitLine: { show: false }, axisLabel: { show: false },
      pointer: { show: false }, detail: { show: false }, title: { show: false },
    });
    gFerm.setOption(opt);
  }
  const ogLabel = og ? Math.round(og * 1000) : "--";
  const sgLabel = sg ? Math.round(sg * 1000) : "--";
  document.getElementById("gauge-og-sg-label").textContent = `OG ${ogLabel} \u2192 SG ${sgLabel}`;

  // --- Beer Temperature ---
  const beerTemp = b.beer_temp;
  const gBeer = ensureGauge("gauge-beer-temp");
  if (gBeer) {
    gBeer.setOption(gaugeBase(0, 35, beerTemp != null ? parseFloat(beerTemp).toFixed(1) : 0,
      "{value}\u00b0C",
      [[0.11, "#58a6ff"], [0.34, "#79c0ff"], [0.63, "#2ea043"], [0.80, "#d29922"], [1, "#f85149"]],
      "#f0883e", "rgb(240,136,62)", b.target_beer_temp));
  }
  document.getElementById("gauge-beer-target-label").textContent =
    b.target_beer_temp != null ? `Target ${b.target_beer_temp}\u00b0C` : "--";

  // --- Specific Gravity ---
  const sgVal = sg ? Math.round(sg * 1000) : 0;
  const ogVal = og ? Math.round(og * 1000) : null;
  const gSG = ensureGauge("gauge-sg");
  if (gSG) {
    gSG.setOption(gaugeBase(1000, 1060, sgVal, "{value}",
      [[0.25, "#2ea043"], [0.50, "#7ee787"], [0.75, "#d29922"], [1, "#f0883e"]],
      "#c9d1d9", "rgb(201,209,217)", ogVal));
  }
  document.getElementById("gauge-sg-label").textContent =
    sg ? "Dropping toward FG" : "--";

  // --- Fridge Controller ---
  const fridgeTemp = b.fridge_temp;
  const gFridge = ensureGauge("gauge-fridge");
  if (gFridge) {
    gFridge.setOption(gaugeBase(0, 30,
      fridgeTemp != null ? parseFloat(fridgeTemp).toFixed(1) : 0,
      "{value}\u00b0C",
      [[0.13, "#1f3d5c"], [0.33, "#58a6ff"], [0.60, "#2ea043"], [0.80, "#d29922"], [1, "#f85149"]],
      "#58a6ff", "rgb(88,166,255)", b.controller_target));
  }
  const ctrlTarget = b.controller_target != null ? parseFloat(b.controller_target).toFixed(1) : "--";
  document.getElementById("gauge-fridge-label").textContent = `Target ${ctrlTarget}\u00b0C`;
}

function renderBrewLog(events, startedAt) {
  const el = document.getElementById("brew-events-list");
  if (!events.length) {
    el.innerHTML = '<div class="brew-log-entry dim">No events yet.</div>';
    return;
  }
  el.innerHTML = events.map(ev => {
    const dt = new Date(ev.timestamp * 1000);
    const day = Math.floor((ev.timestamp * 1000 - new Date(startedAt).getTime()) / 86400000);
    const timeStr = dt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const dateStr = dt.toLocaleDateString([], { month: "short", day: "numeric" });
    const typeLabels = {
      brew_started: "Started",
      brew_completed: "Completed",
      brew_cancelled: "Cancelled",
      dry_hop: "Dry Hop",
      sample: "Sample",
      note: "Note",
      reminder_fired: "Reminder",
    };
    const label = typeLabels[ev.event_type] || ev.event_type;
    return `<div class="brew-log-entry">
      <span class="brew-log-day">Day ${day}</span>
      <span class="brew-log-time">${dateStr} ${timeStr}</span>
      <span class="brew-log-type">${esc(label)}</span>
      <span class="brew-log-desc">${esc(ev.description || '')}</span>
    </div>`;
  }).join("");
}

function renderReminders(reminders, sessionId) {
  const el = document.getElementById("reminder-list");
  if (!reminders.length) {
    el.innerHTML = '<div class="help-text" style="margin-top:8px">No reminders set.</div>';
    return;
  }
  el.innerHTML = reminders.map(r => {
    const typeLabel = r.reminder_type === "day" ? `Day ${r.trigger_value}` : `SG stable ${r.trigger_value}d`;
    const status = r.fired ? '<span class="badge-sm fired">Fired</span>' : '<span class="badge-sm pending">Pending</span>';
    return `<div class="reminder-item">
      ${status}
      <span class="reminder-trigger">${typeLabel}</span>
      <span class="reminder-msg">${esc(r.message)}</span>
      <span class="reminder-icon">${esc(r.icon)}</span>
      ${!r.fired ? `<button class="btn-tiny btn-stop" onclick="deleteReminder('${sessionId}', ${r.id})">x</button>` : ''}
    </div>`;
  }).join("");
}

async function deleteReminder(sessionId, reminderId) {
  try {
    await fetch(`/api/brews/${sessionId}/reminder/${reminderId}`, { method: "DELETE" });
    showToast("Reminder removed", "success");
    loadBrewDetail(sessionId);
  } catch (e) { showToast("Failed", "error"); }
}

// Add reminder button
document.getElementById("btn-add-reminder").addEventListener("click", async () => {
  if (!currentBrewId) return;
  const rType = document.getElementById("reminder-type").value;
  const rValue = parseFloat(document.getElementById("reminder-value").value);
  const rMsg = document.getElementById("reminder-message").value;
  const rIcon = document.getElementById("reminder-icon").value;
  if (!rValue || !rMsg) { showToast("Fill in day/value and message", "error"); return; }
  try {
    const res = await fetch(`/api/brews/${currentBrewId}/reminder`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reminder_type: rType, trigger_value: rValue, message: rMsg, icon: rIcon }),
    });
    if (res.ok) {
      showToast("Reminder added", "success");
      document.getElementById("reminder-message").value = "";
      document.getElementById("reminder-value").value = "";
      loadBrewDetail(currentBrewId);
    } else showToast("Failed", "error");
  } catch (e) { showToast("Failed", "error"); }
});

// Reminder unit label toggle
document.getElementById("reminder-type").addEventListener("change", (e) => {
  document.getElementById("reminder-unit-label").textContent = e.target.value === "day" ? "days" : "days stable";
});

/* Edit OG and Target Temp inline */
function editBrewOG() {
  if (!currentBrewId) return;
  const newOg = prompt("Enter new OG (e.g. 1050):");
  if (!newOg) return;
  const ogFloat = parseFloat(newOg) / 1000;
  updateBrewField(currentBrewId, "og", ogFloat);
}

function editBrewTargetTemp() {
  if (!currentBrewId) return;
  const newTemp = prompt("Enter new target beer temp (\u00b0C):");
  if (!newTemp) return;
  updateBrewField(currentBrewId, "target_beer_temp", parseFloat(newTemp));
}

function editBrewTempSource() {
  if (!currentBrewId) return;
  const choice = prompt("Temperature source for feedback loop:\n1 = Hydrometer (in-liquid)\n2 = Controller (fridge air)\n3 = Mean of both\n\nEnter 1, 2, or 3:");
  const map = { "1": "hydrometer", "2": "controller", "3": "mean" };
  if (map[choice]) updateBrewField(currentBrewId, "temp_source", map[choice]);
}

async function updateBrewField(sessionId, field, value) {
  try {
    const res = await fetch(`/api/brews/${sessionId}/update`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ [field]: value }),
    });
    if (res.ok) { showToast("Updated", "success"); loadBrewDetail(sessionId); }
    else showToast("Failed to update", "error");
  } catch (e) { showToast("Failed", "error"); }
}

/* Outlier filter — rate-of-change filter for chart data */
let brewFilterEnabled = {};

function filterOutliers(data, maxRate) {
  if (data.length < 2) return data;
  const filtered = [data[0]];
  for (let i = 1; i < data.length; i++) {
    const dt = (data[i].x - data[i - 1].x) / 1000;
    if (dt <= 0) continue;
    const rate = Math.abs(data[i].y - filtered[filtered.length - 1].y) / (dt / 60);
    if (rate <= maxRate) filtered.push(data[i]);
  }
  return filtered;
}

/* Auto-populate brew chart with default series */
let brewChartCleared = {};

async function autoPopulateBrewChart(brew, forceRebuild) {
  const sessionId = brew.id;
  if (!forceRebuild && (brewCharts[sessionId] || brewChartCleared[sessionId])) return;
  if (forceRebuild && brewCharts[sessionId]) { brewCharts[sessionId].destroy(); delete brewCharts[sessionId]; }

  const range = parseInt(document.getElementById("brew-chart-range").value);
  const start = (Date.now() / 1000) - range;
  const limit = range >= 604800 ? 10000 : 5000;

  const tiltId = brew.tilt_device_id;
  const ctrlId = brew.controller_device_id;
  if (!tiltId && !ctrlId) return;

  const fetches = {};
  if (tiltId) {
    fetches.beerTemp = fetch(`/api/history/${tiltId}/temperature?start=${start}&limit=${limit}`).then(r => r.json()).catch(() => []);
    fetches.sg = fetch(`/api/history/${tiltId}/specificGravity?start=${start}&limit=${limit}`).then(r => r.json()).catch(() => []);
  }
  if (ctrlId) {
    fetches.fridgeTemp = fetch(`/api/history/${ctrlId}/temperature?start=${start}&limit=${limit}`).then(r => r.json()).catch(() => []);
    fetches.fridgeTarget = fetch(`/api/history/${ctrlId}/targetTemperature?start=${start}&limit=${limit}`).then(r => r.json()).catch(() => []);
    fetches.mode = fetch(`/api/history/${ctrlId}/mode?start=${start}&limit=${limit}`).then(r => r.json()).catch(() => []);
  }

  const keys = Object.keys(fetches);
  const values = await Promise.all(keys.map(k => fetches[k]));
  const results = {};
  keys.forEach((k, i) => results[k] = values[i]);

  const doFilter = brewFilterEnabled[sessionId];
  const mapPts = (arr) => arr.map(d => ({ x: d.timestamp * 1000, y: d.value }));

  const datasets = [];
  let hasSG = false;

  if (results.beerTemp?.length) {
    let pts = mapPts(results.beerTemp);
    if (doFilter) pts = filterOutliers(pts, 2.0);
    datasets.push({
      label: "Beer Temp (\u00b0C)",
      data: pts,
      borderColor: "#f0883e", backgroundColor: "#f0883e33",
      borderWidth: 2, pointRadius: 0, tension: 0.3, yAxisID: "y",
    });
  }
  if (results.fridgeTemp?.length) {
    let pts = mapPts(results.fridgeTemp);
    if (doFilter) pts = filterOutliers(pts, 2.0);
    datasets.push({
      label: "Fridge Temp (\u00b0C)",
      data: pts,
      borderColor: "#58a6ff", backgroundColor: "#58a6ff33",
      borderWidth: 2, pointRadius: 0, tension: 0.3, yAxisID: "y",
    });
  }
  if (results.fridgeTarget?.length) {
    datasets.push({
      label: "Fridge Target (\u00b0C)",
      data: mapPts(results.fridgeTarget),
      borderColor: "#2ea043",
      borderWidth: 1, borderDash: [5, 5], pointRadius: 0, yAxisID: "y",
    });
  }
  if (results.sg?.length) {
    hasSG = true;
    let pts = mapPts(results.sg);
    if (doFilter) pts = filterOutliers(pts, 20);
    datasets.push({
      label: "Specific Gravity",
      data: pts,
      borderColor: "#c9d1d9", backgroundColor: "rgba(201,209,217,0.1)",
      borderWidth: 2, pointRadius: 0, tension: 0.3, yAxisID: "y1",
    });
  }

  let hasMode = false;
  if (results.mode?.length) {
    hasMode = true;
    datasets.push({
      label: "Mode",
      data: results.mode.map(d => ({ x: d.timestamp * 1000, y: d.value })),
      borderWidth: 0,
      pointRadius: 0,
      fill: true,
      stepped: true,
      yAxisID: "yMode",
      backgroundColor: "rgba(100,100,100,0.08)",
      segment: {
        backgroundColor: ctx => {
          const v = ctx.p1.parsed.y;
          if (v < 0) return "rgba(88,166,255,0.18)";
          if (v > 0) return "rgba(240,136,62,0.18)";
          return "rgba(100,100,100,0.08)";
        },
      },
    });
  }

  if (!datasets.length) return;

  const scales = {
    x: { type: "time", time: { tooltipFormat: "HH:mm:ss", displayFormats: { minute: "HH:mm", hour: "HH:mm" } },
         ticks: { color: "#8b949e" }, grid: { color: "#21262d" } },
    y: { position: "left", title: { display: true, text: "Temperature (\u00b0C)", color: "#8b949e" },
         ticks: { color: "#8b949e" }, grid: { color: "#21262d" } },
  };
  if (hasSG) {
    scales.y1 = { position: "right", title: { display: true, text: "Specific Gravity", color: "#8b949e" },
                  ticks: { color: "#8b949e", callback: v => Math.round(v) }, grid: { drawOnChartArea: false } };
  }
  if (hasMode) {
    scales.yMode = { display: false, min: -1.5, max: 1.5 };
  }

  const ctx = document.getElementById("brew-chart").getContext("2d");
  brewCharts[sessionId] = new Chart(ctx, {
    type: "line",
    data: { datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      scales,
      plugins: { legend: { labels: { color: "#c9d1d9" } } },
    },
  });
  brewChartSeries[sessionId] = datasets.map(d => ({ label: d.label }));
}

/* Brew chart (persistent per session) */
document.getElementById("btn-brew-add-series").addEventListener("click", async () => {
  if (!currentBrewId) return;
  const metric = document.getElementById("brew-chart-metric").value;
  const range = document.getElementById("brew-chart-range").value;

  // Get the TILT device for this brew
  try {
    const b = await (await fetch(`/api/brews/${currentBrewId}`)).json();
    const deviceId = metric === "temperature" ? (b.tilt_device_id || b.controller_device_id) : b.tilt_device_id;
    if (!deviceId) { showToast("No device assigned for this metric", "error"); return; }

    if (!brewChartSeries[currentBrewId]) brewChartSeries[currentBrewId] = [];
    const existing = brewCharts[currentBrewId];
    brewCharts[currentBrewId] = await addChartSeries(
      existing || null, brewChartSeries[currentBrewId], "brew-chart",
      deviceId, metric, range, "left"
    );
  } catch (e) { showToast("Failed", "error"); }
});

document.getElementById("btn-brew-filter").addEventListener("click", async () => {
  if (!currentBrewId) return;
  brewFilterEnabled[currentBrewId] = !brewFilterEnabled[currentBrewId];
  const btn = document.getElementById("btn-brew-filter");
  btn.textContent = brewFilterEnabled[currentBrewId] ? "Filter: ON" : "Filter: OFF";
  // Rebuild chart with filter applied/removed
  try {
    const b = await (await fetch(`/api/brews/${currentBrewId}`)).json();
    autoPopulateBrewChart(b, true);
  } catch (e) {}
});

document.getElementById("btn-brew-clear-chart").addEventListener("click", () => {
  if (currentBrewId) {
    if (brewCharts[currentBrewId]) {
      brewCharts[currentBrewId].destroy();
      delete brewCharts[currentBrewId];
    }
    delete brewChartSeries[currentBrewId];
    brewChartCleared[currentBrewId] = true;
  }
});

/* Feedback chart */
let lastFeedbackSession = null;

async function loadFeedbackChart(sessionId) {
  // Only recreate if session changed
  if (lastFeedbackSession === sessionId && feedbackChart) return;
  if (feedbackChart) { feedbackChart.destroy(); feedbackChart = null; }
  lastFeedbackSession = sessionId;
  try {
    const data = await (await fetch(`/api/brews/${sessionId}/feedback/log`)).json();
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

/* Brew action buttons */
document.getElementById("btn-complete-brew").addEventListener("click", async () => {
  if (!currentBrewId) return;
  const fgRaw = prompt("Enter Final Gravity (e.g. 1010) or leave blank:");
  const data = {};
  if (fgRaw) data.fg = parseFloat(fgRaw) / 1000;
  try {
    await fetch(`/api/brews/${currentBrewId}/complete`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data)
    });
    showToast("Brew completed!", "success");
    showPage("brews");
  } catch (e) { showToast("Failed", "error"); }
});

document.getElementById("btn-cancel-brew").addEventListener("click", async () => {
  if (!currentBrewId) return;
  if (!confirm("Cancel this brew session?")) return;
  try {
    await fetch(`/api/brews/${currentBrewId}/cancel`, { method: "POST" });
    showToast("Brew cancelled", "success");
    showPage("brews");
  } catch (e) { showToast("Failed", "error"); }
});

document.getElementById("btn-feedback-start").addEventListener("click", async () => {
  if (!currentBrewId) return;
  try {
    await fetch(`/api/brews/${currentBrewId}/feedback/start`, { method: "POST" });
    showToast("Smart feedback enabled", "success");
    loadBrewDetail(currentBrewId);
  } catch (e) { showToast("Failed", "error"); }
});

document.getElementById("btn-feedback-stop").addEventListener("click", async () => {
  if (!currentBrewId) return;
  try {
    await fetch(`/api/brews/${currentBrewId}/feedback/stop`, { method: "POST" });
    showToast("Smart feedback disabled", "success");
    loadBrewDetail(currentBrewId);
  } catch (e) { showToast("Failed", "error"); }
});

document.querySelectorAll(".brew-event-btn").forEach(btn => {
  btn.addEventListener("click", async () => {
    if (!currentBrewId) return;
    const eventType = btn.dataset.event;
    let desc = "";
    if (eventType === "note") {
      desc = prompt("Enter note:");
      if (!desc) return;
    } else if (eventType === "dry_hop") {
      desc = prompt("Hop addition details (optional):") || "Dry hopped";
    } else if (eventType === "sample") {
      desc = prompt("Sample notes (optional):") || "Took sample";
    }
    try {
      await fetch(`/api/brews/${currentBrewId}/event`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event_type: eventType, description: desc }) });
      showToast("Event logged", "success");
      loadBrewDetail(currentBrewId);
    } catch (e) { showToast("Failed", "error"); }
  });
});

/* --- SSE Console --- */
function initConsole() {
  fetch("/api/logs/history").then(r => r.json()).then(lines => lines.forEach(appendLog)).catch(() => {});
  const source = new EventSource("/api/logs/stream");
  source.onmessage = (e) => appendLog(e.data);
}

/* --- Affiliate link visibility --- */
function applyAffiliateVisibility() {
  const hide = window._hideAffiliateLinks;
  document.querySelectorAll(".integration-affiliate, .affiliate-hint").forEach(el => {
    el.style.display = hide ? "none" : "";
  });
}

/* --- Dummy fund/donate buttons --- */
document.addEventListener("click", (e) => {
  if (e.target.classList.contains("integration-fund") || e.target.classList.contains("donate-btn")) {
    e.preventDefault();
    showToast("Payment integration coming soon! Check GitHub to sponsor.", "success");
  }
});

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

// Periodic refreshes
setInterval(checkStatus, 5000);
setInterval(loadDevices, 10000);
setInterval(() => {
  if (currentPage === "dashboard") updateDashboardCards();
  if (currentPage === "brew-detail" && currentBrewId) loadBrewDetail(currentBrewId);
  if (currentPage === "brews") loadBrewsPage();
}, 10000);
