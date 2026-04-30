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

/* Gravity formatting */
let gravityUnit = "sg"; // "sg" or "plato"

function sgToPlato(sg) {
  if (sg == null) return null;
  return -616.868 + 1111.14 * sg - 630.272 * sg * sg + 135.997 * sg * sg * sg;
}

function fmtG(sg) {
  if (sg == null) return "--";
  if (gravityUnit === "plato") return sgToPlato(sg).toFixed(1) + "°P";
  return sg.toFixed(3);
}

function fmtGLabel() {
  return gravityUnit === "plato" ? "Plato (°P)" : "Specific Gravity";
}

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
    const brewNav = document.querySelector(`.brew-nav[data-brew="${id}"]`);
    if (brewNav) brewNav.classList.add("active");
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
    if (page === "devices") loadManageDevices();
    if (page === "tiltpi") loadTiltPiPage();
    if (page === "legendary") loadLegendaryBrews();
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
    document.getElementById("gravity_unit").value = cfg.gravity_unit || "sg";
    gravityUnit = cfg.gravity_unit || "sg";
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
    gravity_unit: document.getElementById("gravity_unit").value,
  };
  try {
    const res = await fetch("/api/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) });
    const result = await res.json();
    if (res.ok) {
      showToast("Configuration saved", "success");
      gravityUnit = data.gravity_unit;
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
      const name = dev._nickname || dev.name || id.substring(0, 8);
      const isStale = dev._stale === true;
      const el = document.createElement("a");
      el.className = "nav-item" + (currentDeviceId === id ? " active" : "") + (isStale ? " stale" : "");
      el.setAttribute("data-device", id);
      el.href = "#";
      if (isStale) {
        el.innerHTML = '<span class="status-dot offline"></span>' + esc(name);
      } else {
        el.innerHTML = esc(name) + rssiIcon(dev.rssi);
      }
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
  const isStale = dev._stale === true;

  document.getElementById("device-name").textContent = dev._nickname || dev.name || "Unknown Device";
  const connBadge = document.getElementById("device-connection");
  if (isStale) {
    connBadge.textContent = "Offline";
    connBadge.className = "badge offline";
  } else {
    const connState = (dev.connectionState || "").toLowerCase();
    const isOnline = connState === "connected" || connState === "online";
    connBadge.textContent = isOnline ? "Online" : "Offline";
    connBadge.className = "badge " + (isOnline ? "online" : "offline");
  }

  // Stale banner
  let staleBanner = document.getElementById("device-stale-banner");
  if (isStale) {
    if (!staleBanner) {
      staleBanner = document.createElement("div");
      staleBanner.id = "device-stale-banner";
      staleBanner.className = "stale-banner";
      const header = document.querySelector("#page-device .device-header");
      header.parentNode.insertBefore(staleBanner, header.nextSibling);
    }
    const lastSeen = dev._last_seen ? new Date(dev._last_seen).toLocaleString() + " (" + timeAgo(dev._last_seen) + ")" : "unknown";
    staleBanner.innerHTML = '<span class="stale-banner-icon">&#x26a0;</span> This device is offline. Last seen: ' + lastSeen + '. Showing last known data.';
    staleBanner.style.display = "";
  } else if (staleBanner) {
    staleBanner.style.display = "none";
  }

  // Dim the overview when stale
  const overview = document.getElementById("subtab-overview");
  if (overview) overview.classList.toggle("stale-content", isStale);

  // Hide control tab for stale devices
  document.querySelectorAll('.sub-tab[data-subtab="control"]').forEach(t => {
    t.style.display = isStale ? "none" : "";
  });

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
    document.getElementById("device-gravity").textContent = fmtG(dev.specificGravity);
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
  const isTiltDev = dev.deviceType === "TILT";
  document.getElementById("info-type").textContent = isTiltDev ? "Tilt Hydrometer" : (dev.deviceType ? "RAPT Temperature Controller" : "--");
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

  // Manage link and source hint
  const manageRow = document.getElementById("row-manage-link");
  const manageCell = document.getElementById("info-manage-link");
  const sourceHint = document.getElementById("device-source-hint");
  if (isTilt) {
    manageRow.style.display = "none";
    sourceHint.textContent = "Device name and color come from TILT firmware. Beer name is set in TiltPi.";
  } else {
    manageRow.style.display = "";
    manageCell.innerHTML = '<a href="https://app.rapt.io" target="_blank" rel="noopener">Manage in RAPT Portal</a>';
    sourceHint.textContent = "Device name, target temperature, and settings are managed through the RAPT Portal. RAPT2MQTT reads and works alongside the RAPT API \u2014 it doesn\u2019t replace it.";
  }

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
let deviceFilterEnabled = { "tilt-temp": true, "tilt-sg": true };
let currentTiltDeviceId = null;

async function loadTiltDefaultCharts(deviceId) {
  currentTiltDeviceId = deviceId;
  try {
    const start = (Date.now() / 1000) - 86400;

    // Temperature chart with red-blue gradient (4-30 C)
    const tempData = await (await fetch(`/api/history/${deviceId}/temperature?start=${start}&limit=10000`)).json();
    if (tiltTempChart) { tiltTempChart.destroy(); tiltTempChart = null; }
    if (tempData.length) {
      let pts = tempData.map(d => ({ x: d.timestamp * 1000, y: d.value }));
      if (deviceFilterEnabled["tilt-temp"]) pts = filterOutliers(pts, 2.0);
      const ctx = document.getElementById("tilt-temp-chart").getContext("2d");
      const grad = ctx.createLinearGradient(0, 0, 0, 300);
      grad.addColorStop(0, "rgba(218, 54, 51, 0.6)");
      grad.addColorStop(1, "rgba(88, 166, 255, 0.6)");
      tiltTempChart = new Chart(ctx, {
        type: "line",
        data: { datasets: [{
          label: "Temperature (\u00b0C)",
          data: pts,
          borderColor: "#f0883e",
          backgroundColor: grad,
          fill: true, borderWidth: 2, pointRadius: 0, tension: 0.3,
        }]},
        options: {
          responsive: true, maintainAspectRatio: false,
          scales: {
            x: { type: "time", time: { tooltipFormat: "MMM d, yyyy HH:mm:ss", displayFormats: { minute: "HH:mm", hour: "HH:mm", day: "MMM d", week: "MMM d", month: "MMM yyyy" } },
                 ticks: { color: "#8b949e", maxTicksLimit: 12, major: { enabled: true }, font: ctx => ctx.tick && ctx.tick.major ? { weight: "bold", size: 11 } : { size: 10 },
                   callback: function(val, idx, ticks) { const d = new Date(val); const hm = String(d.getHours()).padStart(2,"0") + ":" + String(d.getMinutes()).padStart(2,"0"); if (ticks[idx] && ticks[idx].major) { const mon = d.toLocaleString("en",{month:"short"}); return [mon + " " + d.getDate(), hm]; } return hm; } }, grid: { color: "#21262d" } },
            y: { grace: "10%", ticks: { color: "#8b949e" }, grid: { color: "#21262d" } },
          },
          plugins: { legend: { labels: { color: "#c9d1d9" } } },
        },
      });
    }

    // SG chart with theme-appropriate line
    const sgData = await (await fetch(`/api/history/${deviceId}/specificGravity?start=${start}&limit=10000`)).json();
    if (tiltSgChart) { tiltSgChart.destroy(); tiltSgChart = null; }
    if (sgData.length) {
      let pts = sgData.map(d => ({ x: d.timestamp * 1000, y: d.value }));
      if (deviceFilterEnabled["tilt-sg"]) pts = filterOutliers(pts, 0.002);
      const ctx2 = document.getElementById("tilt-sg-chart").getContext("2d");
      tiltSgChart = new Chart(ctx2, {
        type: "line",
        data: { datasets: [{
          label: "Specific Gravity",
          data: pts,
          borderColor: "#c9d1d9",
          backgroundColor: "rgba(201, 209, 217, 0.1)",
          fill: true, borderWidth: 2, pointRadius: 0, tension: 0.3,
        }]},
        options: {
          responsive: true, maintainAspectRatio: false,
          scales: {
            x: { type: "time", time: { tooltipFormat: "MMM d, yyyy HH:mm:ss", displayFormats: { minute: "HH:mm", hour: "HH:mm", day: "MMM d", week: "MMM d", month: "MMM yyyy" } },
                 ticks: { color: "#8b949e", maxTicksLimit: 12, major: { enabled: true }, font: ctx => ctx.tick && ctx.tick.major ? { weight: "bold", size: 11 } : { size: 10 },
                   callback: function(val, idx, ticks) { const d = new Date(val); const hm = String(d.getHours()).padStart(2,"0") + ":" + String(d.getMinutes()).padStart(2,"0"); if (ticks[idx] && ticks[idx].major) { const mon = d.toLocaleString("en",{month:"short"}); return [mon + " " + d.getDate(), hm]; } return hm; } }, grid: { color: "#21262d" } },
            y: { grace: "10%", ticks: { color: "#8b949e", callback: v => v.toFixed(3) }, grid: { color: "#21262d" } },
          },
          plugins: { legend: { labels: { color: "#c9d1d9" } } },
        },
      });
    }

    // Update filter button labels
    document.getElementById("btn-tilt-temp-filter").textContent = deviceFilterEnabled["tilt-temp"] ? "Filter: ON" : "Filter: OFF";
    document.getElementById("btn-tilt-sg-filter").textContent = deviceFilterEnabled["tilt-sg"] ? "Filter: ON" : "Filter: OFF";
  } catch (e) {}
}

function toggleDeviceFilter(chartKey) {
  deviceFilterEnabled[chartKey] = !deviceFilterEnabled[chartKey];
  document.getElementById(`btn-${chartKey}-filter`).textContent = deviceFilterEnabled[chartKey] ? "Filter: ON" : "Filter: OFF";
  if (currentTiltDeviceId) loadTiltDefaultCharts(currentTiltDeviceId);
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
        html += `<div class="dash-metric"><span class="dash-metric-label">${gravityUnit === "plato" ? "°P" : "SG"}</span><span class="dash-metric-value">${fmtG(dev.specificGravity)}</span></div>`;
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
    const limit = parseInt(range) >= 604800 ? 50000 : 10000;
    const data = await (await fetch(`/api/history/${deviceId}/${metric}?start=${start}&limit=${limit}`)).json();
    if (!data.length) { showToast("No data for this range", "error"); return chartObj; }

    const color = chartColors[colorIdx++ % chartColors.length];
    const devices = window._cachedDevices || {};
    const d = devices[deviceId];
    const devName = d?._nickname || d?.name || deviceId.substring(0, 8);

    seriesArr.push({ deviceId, metric, range, axis, color });

    const dataset = {
      label: `${devName} - ${metric}`,
      data: data.map(d => ({ x: d.timestamp * 1000, y: d.value })),
      borderColor: color,
      backgroundColor: color + "33",
      borderWidth: 2, pointRadius: 0, tension: 0.3,
      yAxisID: axis === "right" ? "y1" : "y",
    };

    const isSG = metric.toLowerCase().includes("gravity");
    const sgTicks = { color: "#8b949e", callback: v => v.toFixed(3) };
    const defaultTicks = { color: "#8b949e" };

    if (!chartObj) {
      const ctx = document.getElementById(canvasId).getContext("2d");
      const cfg = {
        type: "line",
        data: { datasets: [dataset] },
        options: {
          responsive: true, maintainAspectRatio: false,
          interaction: { mode: "index", intersect: false },
          scales: {
            x: { type: "time", time: { tooltipFormat: "MMM d, yyyy HH:mm:ss", displayFormats: { minute: "HH:mm", hour: "HH:mm", day: "MMM d", week: "MMM d", month: "MMM yyyy" } },
                 ticks: { color: "#8b949e", maxTicksLimit: 12, major: { enabled: true }, font: ctx => ctx.tick && ctx.tick.major ? { weight: "bold", size: 11 } : { size: 10 },
                   callback: function(val, idx, ticks) { const d = new Date(val); const hm = String(d.getHours()).padStart(2,"0") + ":" + String(d.getMinutes()).padStart(2,"0"); if (ticks[idx] && ticks[idx].major) { const mon = d.toLocaleString("en",{month:"short"}); return [mon + " " + d.getDate(), hm]; } return hm; } }, grid: { color: "#21262d" } },
            y: { position: "left", grace: "10%", ticks: isSG && axis !== "right" ? sgTicks : defaultTicks, grid: { color: "#21262d" } },
          },
          plugins: { legend: { labels: { color: "#c9d1d9" } } },
        },
      };
      if (axis === "right") {
        cfg.options.scales.y1 = { position: "right", grace: "10%", ticks: isSG ? sgTicks : defaultTicks, grid: { drawOnChartArea: false } };
      }
      return new Chart(ctx, cfg);
    } else {
      chartObj.data.datasets.push(dataset);
      if (axis === "right" && !chartObj.options.scales.y1) {
        chartObj.options.scales.y1 = { position: "right", ticks: isSG ? sgTicks : defaultTicks, grid: { drawOnChartArea: false } };
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
          x: { type: "time", time: { tooltipFormat: "MMM d, yyyy HH:mm:ss", displayFormats: { minute: "HH:mm", hour: "HH:mm", day: "MMM d", week: "MMM d", month: "MMM yyyy" } }, ticks: { color: "#8b949e", maxTicksLimit: 12, major: { enabled: true }, font: ctx => ctx.tick && ctx.tick.major ? { weight: "bold", size: 11 } : { size: 10 },
                   callback: function(val, idx, ticks) { const d = new Date(val); const hm = String(d.getHours()).padStart(2,"0") + ":" + String(d.getMinutes()).padStart(2,"0"); if (ticks[idx] && ticks[idx].major) { const mon = d.toLocaleString("en",{month:"short"}); return [mon + " " + d.getDate(), hm]; } return hm; } }, grid: { color: "#21262d" } },
          y: { grace: "10%", ticks: { color: "#8b949e" }, grid: { color: "#21262d" } },
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
              <span class="brew-tile-label">${gravityUnit === "plato" ? "°P" : "SG"}</span>
              <span class="brew-tile-value">${fmtG(sg)}</span>
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
      const ogStr = fmtG(b.og);
      const fgStr = fmtG(b.fg);
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
      opt.textContent = dev._nickname || dev.name || id.substring(0, 8);
      if (dev.deviceType === "TILT") tiltSel.appendChild(opt);
      else ctrlSel.appendChild(opt);
    });
  } catch (e) {}
}

document.getElementById("btn-start-brew").addEventListener("click", async () => {
  const ogRaw = document.getElementById("brew-og").value;
  const data = {
    name: document.getElementById("brew-name").value || "Untitled Brew",
    og: ogRaw ? parseFloat(ogRaw) : null,
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
      loadBrewNav();
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
    if (!res.ok) { showToast("Brew not found", "error"); showPage("legendary"); return; }
    const b = await res.json();
    renderBrewDetail(b);
    // Default filter ON for new sessions
    if (brewFilterEnabled[sessionId] === undefined) brewFilterEnabled[sessionId] = true;
    autoPopulateBrewChart(b);
    const filterBtn = document.getElementById("btn-brew-filter");
    if (filterBtn) filterBtn.textContent = brewFilterEnabled[sessionId] ? "Filter: ON" : "Filter: OFF";
  } catch (e) {}
}

function renderBrewDetail(b) {
  document.getElementById("brew-detail-name").textContent = b.name || "Untitled Brew";

  const statusBadge = document.getElementById("brew-status-badge");
  if (b.status === "active") {
    statusBadge.textContent = "Active";
    statusBadge.className = "badge online";
  } else if (b.status === "completed") {
    statusBadge.textContent = "Completed";
    statusBadge.className = "badge";
  } else {
    statusBadge.textContent = b.status || "--";
    statusBadge.className = "badge offline";
  }

  const days = daysSince(b.started_at);
  document.getElementById("brew-detail-duration").textContent = `Day ${Math.floor(days)} (${formatSeconds(days * 86400)})`;

  // Beer temp from live data
  const beerTemp = b.beer_temp;
  document.getElementById("brew-beer-temp").textContent = beerTemp != null ? formatTemp(beerTemp, "C") : "--";
  document.getElementById("brew-fridge-temp").textContent = b.fridge_temp != null ? formatTemp(b.fridge_temp, "C") : "--";
  document.getElementById("brew-sg").textContent = fmtG(b.current_sg);
  document.getElementById("brew-abv").textContent = b.current_abv != null ? b.current_abv.toFixed(1) + "%" : "--";

  const og = b.og;
  document.getElementById("brew-og-display").textContent = fmtG(og);
  document.getElementById("brew-target-display").textContent = b.target_beer_temp != null ? formatTemp(b.target_beer_temp, "C") : "--";
  document.getElementById("brew-fridge-target").textContent = b.controller_target != null ? formatTemp(b.controller_target, "C") : "--";

  // Device config summary
  const sourceLabels = { hydrometer: "Hydrometer (in-liquid)", controller: "Controller (fridge air)", mean: "Mean of both" };
  document.getElementById("brew-cfg-tilt").textContent = b.tilt_name || "None";
  document.getElementById("brew-cfg-ctrl").textContent = b.controller_name || "None";
  document.getElementById("brew-cfg-source").textContent = sourceLabels[b.temp_source] || "Hydrometer (in-liquid)";

  // ABV under gauge
  const abvText = b.current_abv != null ? b.current_abv.toFixed(1) + "% ABV" : "-- ABV";
  document.getElementById("gauge-abv-display").textContent = abvText;

  // OG hint: if current SG > OG, suggest updating
  if (og && b.current_sg && b.current_sg > og) {
    const hint = document.getElementById("brew-og-hint");
    hint.style.display = "block";
    hint.textContent = `SG reading ${fmtG(b.current_sg)} > OG ${fmtG(og)} -- update OG?`;
    hint.style.cursor = "pointer";
    hint.onclick = () => {
      if (confirm(`Update OG to ${fmtG(b.current_sg)}?`)) {
        updateBrewField(b.id, "og", b.current_sg);
      }
    };
  } else {
    document.getElementById("brew-og-hint").style.display = "none";
  }

  // Needle gauge
  updateNeedleGauge(b);

  // Feedback explanation and live status
  renderFeedbackStatus(b);

  // Reminders
  renderReminders(b.reminders || [], b.id);

  // Events (text-based brew log)
  renderBrewLog(b.events || [], b.started_at);

  // Recipe photo
  renderBrewRecipePhoto(b);

  // Hide actions for completed/cancelled brews
  const actionsPanel = document.getElementById("brew-actions-panel");
  if (actionsPanel) actionsPanel.style.display = (b.status === "active") ? "" : "none";

  // Load feedback chart
  if (b.temp_feedback_enabled) loadFeedbackChart(b.id, true);
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
  document.getElementById("gauge-og-sg-label").textContent = `OG ${fmtG(og)} \u2192 SG ${fmtG(sg)}`;

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
  const sgVal = sg ? parseFloat(sg.toFixed(3)) : 0;
  const ogVal = og ? parseFloat(og.toFixed(3)) : null;
  const gSG = ensureGauge("gauge-sg");
  if (gSG) {
    gSG.setOption(gaugeBase(1.000, 1.060, sgVal, "{value}",
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

function renderFeedbackStatus(b) {
  const fbEnabled = b.temp_feedback_enabled;
  const ctrlName = b.controller_name || "the controller";
  const tiltName = b.tilt_name || "the hydrometer";
  const targetBeer = b.target_beer_temp;
  const targetLabel = targetBeer != null ? targetBeer + "\u00b0C" : "--";
  const interval = b.temp_feedback_interval || 300;
  const intervalMin = Math.round(interval / 60);
  const deadband = b.temp_feedback_deadband || 0.3;
  const srcLabels = { hydrometer: "Hydrometer (in-liquid)", controller: "Controller probe (fridge air)", mean: "Mean of both sensors" };
  const tempSource = b.temp_source || "hydrometer";

  // Button state
  document.getElementById("btn-feedback-start").disabled = fbEnabled;
  document.getElementById("btn-feedback-stop").disabled = !fbEnabled;

  // Explanation — always visible, describes what this does
  const explEl = document.getElementById("feedback-explanation");
  let sensorDesc;
  if (tempSource === "controller") {
    sensorDesc = `${ctrlName}'s probe (fridge air)`;
  } else if (tempSource === "mean") {
    sensorDesc = `the average of ${tiltName} and ${ctrlName}'s probe`;
  } else {
    sensorDesc = `${tiltName} (in the liquid)`;
  }

  const beerTemp = b.beer_temp;
  const fridgeTemp = b.fridge_temp;
  const ctrlTarget = b.controller_target;

  if (!fbEnabled) {
    // Situational explanation showing current readings
    let situation = "";
    if (ctrlTarget != null && fridgeTemp != null) {
      situation = `Right now, ${ctrlName} is set to ${parseFloat(ctrlTarget).toFixed(1)}\u00b0C and the fridge air reads ${parseFloat(fridgeTemp).toFixed(1)}\u00b0C. `;
    }
    if (beerTemp != null && targetBeer != null) {
      const delta = (beerTemp - targetBeer).toFixed(1);
      const absDelta = Math.abs(delta);
      if (absDelta > deadband) {
        situation += `However, ${sensorDesc} reads the actual liquid at ${parseFloat(beerTemp).toFixed(1)}\u00b0C \u2014 that's ${absDelta}\u00b0C ${delta > 0 ? "above" : "below"} your beer target of ${targetLabel}. `;
        situation += `The fridge air hits target quickly, but the liquid has far more thermal mass. `;
        situation += `Enable this to automatically ${delta > 0 ? "lower" : "raise"} ${ctrlName}'s target via the RAPT API until the liquid reaches ${targetLabel}.`;
      } else {
        situation += `${sensorDesc} reads ${parseFloat(beerTemp).toFixed(1)}\u00b0C \u2014 within ${deadband}\u00b0C of your ${targetLabel} target. Looking good, but enable this to keep it there automatically.`;
      }
    } else if (targetBeer != null) {
      situation += `Enable this to automatically adjust ${ctrlName}'s target via the RAPT API so that ${sensorDesc} converges on your beer target of ${targetLabel}.`;
    } else {
      situation += `Set a beer target temperature above, then enable this to automatically adjust ${ctrlName} to match.`;
    }
    explEl.textContent = situation;
  } else {
    // Active state — what it's doing right now
    let activeDesc = `Enabled \u2014 checking ${sensorDesc} every ${intervalMin} minutes and adjusting ${ctrlName}'s target via the RAPT API to hold your beer at ${targetLabel}. `;
    if (beerTemp != null && targetBeer != null) {
      const err = beerTemp - targetBeer;
      const absErr = Math.abs(err);
      if (absErr <= deadband) {
        activeDesc += `Currently on target (${parseFloat(beerTemp).toFixed(1)}\u00b0C). No correction needed.`;
      } else if (err > 0) {
        activeDesc += `Beer is ${absErr.toFixed(1)}\u00b0C too warm (${parseFloat(beerTemp).toFixed(1)}\u00b0C). Controller target has been lowered to compensate.`;
      } else {
        activeDesc += `Beer is ${absErr.toFixed(1)}\u00b0C too cold (${parseFloat(beerTemp).toFixed(1)}\u00b0C). Controller target has been raised to compensate.`;
      }
    }
    explEl.textContent = activeDesc;
  }

  // Populate "how it works" dynamic values (always, even when disabled)
  const gain = b.temp_feedback_gain || 1.5;
  const tempMin = b.temp_feedback_min != null ? b.temp_feedback_min : 0;
  const tempMax = b.temp_feedback_max != null ? b.temp_feedback_max : 35;
  const setIfExists = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
  setIfExists("how-interval", intervalMin);
  setIfExists("how-interval2", intervalMin);
  setIfExists("how-gain", gain);
  setIfExists("how-gain2", gain);
  setIfExists("how-deadband", deadband);
  setIfExists("how-min", tempMin);
  setIfExists("how-max", tempMax);

  // Live status panel — only visible when enabled
  const livePanel = document.getElementById("feedback-live-status");
  if (!fbEnabled) {
    livePanel.style.display = "none";
    return;
  }
  livePanel.style.display = "block";

  // Current state
  const cooling = b.cooling_active;
  const heating = b.heating_active;
  const mode = cooling ? "Cooling" : (heating ? "Heating" : "Idle");
  const compDelay = b.compressor_delay;
  const coolHyst = b.cooling_hysteresis;
  const heatHyst = b.heating_hysteresis;

  // Status card
  const statusEl = document.getElementById("fb-status");
  statusEl.textContent = mode === "Cooling" ? "\u2744\ufe0f Cooling" : mode === "Heating" ? "\ud83d\udd25 Heating" : "Idle";
  statusEl.className = "card-value" + (cooling ? " mode-cool" : heating ? " mode-heat" : "");

  // Error card
  const errorEl = document.getElementById("fb-error");
  if (beerTemp != null && targetBeer != null) {
    const err = (beerTemp - targetBeer).toFixed(1);
    const sign = err > 0 ? "+" : "";
    errorEl.textContent = sign + err + "\u00b0C";
    errorEl.style.color = Math.abs(err) <= deadband ? "#2ea043" : Math.abs(err) <= 1.0 ? "#d29922" : "#f85149";
  } else {
    errorEl.textContent = "--";
    errorEl.style.color = "";
  }

  // Next check card
  const nextEl = document.getElementById("fb-next-check");
  const fb = b.last_feedback;
  if (fb) {
    const elapsed = Date.now() / 1000 - fb.timestamp;
    const remaining = Math.max(0, interval - elapsed);
    if (remaining > 0) {
      nextEl.textContent = Math.ceil(remaining / 60) + " min";
    } else {
      nextEl.textContent = "Any moment";
    }
  } else {
    nextEl.textContent = intervalMin + " min";
  }

  // Last action card
  const actionEl = document.getElementById("fb-last-action");
  if (fb) {
    const diff = fb.new_target - fb.old_target;
    const dir = diff > 0 ? "\u2191" : diff < 0 ? "\u2193" : "\u2192";
    const ago = Math.round((Date.now() / 1000 - fb.timestamp) / 60);
    actionEl.textContent = `${dir} ${fb.old_target.toFixed(1)} \u2192 ${fb.new_target.toFixed(1)}\u00b0C (${ago}m ago)`;
  } else {
    actionEl.textContent = "No adjustments yet";
  }

  // RAPT API state — did the controller accept the change?
  const apiEl = document.getElementById("fb-api-state");
  const fbs = b.feedback_state;
  const fmtT = v => v != null ? parseFloat(v).toFixed(1) : "--";
  if (fbs) {
    const ago = Math.round((Date.now() / 1000 - fbs.timestamp) / 60);
    const agoText = ago < 1 ? "just now" : ago + "m ago";
    if (fbs.phase === "confirmed") {
      apiEl.style.background = "rgba(46,160,67,0.1)";
      apiEl.style.border = "1px solid rgba(46,160,67,0.3)";
      apiEl.style.color = "#7ee787";
      apiEl.textContent = `Sent ${fmtT(fbs.sent_target)}\u00b0C to RAPT API \u2192 confirmed at ${fmtT(fbs.confirmed_target)}\u00b0C (${agoText})`;
    } else if (fbs.phase === "mismatch") {
      apiEl.style.background = "rgba(210,153,34,0.1)";
      apiEl.style.border = "1px solid rgba(210,153,34,0.3)";
      apiEl.style.color = "#d29922";
      apiEl.textContent = `Sent ${fmtT(fbs.sent_target)}\u00b0C to RAPT API but controller reports ${fmtT(fbs.confirmed_target)}\u00b0C \u2014 will retry next cycle (${agoText})`;
    } else if (fbs.phase === "error") {
      apiEl.style.background = "rgba(248,81,73,0.1)";
      apiEl.style.border = "1px solid rgba(248,81,73,0.3)";
      apiEl.style.color = "#f85149";
      apiEl.textContent = `Failed to send ${fmtT(fbs.sent_target)}\u00b0C to RAPT API: ${fbs.error} \u2014 will retry next cycle (${agoText})`;
    } else if (fbs.phase === "sending") {
      apiEl.style.background = "rgba(88,166,255,0.1)";
      apiEl.style.border = "1px solid rgba(88,166,255,0.3)";
      apiEl.style.color = "#58a6ff";
      apiEl.textContent = `Sending ${fmtT(fbs.sent_target)}\u00b0C to RAPT API\u2026`;
    } else if (fbs.phase === "stable") {
      apiEl.style.background = "rgba(46,160,67,0.06)";
      apiEl.style.border = "1px solid rgba(46,160,67,0.15)";
      apiEl.style.color = "#484f58";
      apiEl.textContent = `Within deadband \u2014 no adjustment sent to RAPT API (${agoText})`;
    } else if (fbs.phase === "unconfirmed") {
      apiEl.style.background = "rgba(210,153,34,0.1)";
      apiEl.style.border = "1px solid rgba(210,153,34,0.3)";
      apiEl.style.color = "#d29922";
      apiEl.textContent = `Sent ${fmtT(fbs.sent_target)}\u00b0C to RAPT API \u2014 waiting to confirm (${agoText})`;
    }
    // Next check countdown
    if (fbs.next_check) {
      const remaining = Math.max(0, fbs.next_check - Date.now() / 1000);
      const remSec = Math.round(remaining);
      const remText = remSec > 60 ? Math.ceil(remSec / 60) + " min" : remSec > 0 ? remSec + "s" : "Now";
      nextEl.textContent = remText;
    }
  } else {
    apiEl.style.background = "";
    apiEl.style.border = "1px solid #21262d";
    apiEl.style.color = "#484f58";
    apiEl.textContent = "Waiting for first feedback cycle\u2026";
  }

  // Narrative — the human-readable "what's happening right now"
  const narEl = document.getElementById("feedback-narrative");
  let narrative = "";
  if (beerTemp != null && targetBeer != null) {
    const err = beerTemp - targetBeer;
    const absErr = Math.abs(err);
    if (absErr <= deadband) {
      narrative = `${sensorDesc} reads ${beerTemp}\u00b0C \u2014 within ${deadband}\u00b0C of your ${targetLabel} target. No adjustment needed.`;
    } else if (err > 0) {
      narrative = `${sensorDesc} reads ${beerTemp}\u00b0C, which is ${absErr.toFixed(1)}\u00b0C above your ${targetLabel} target. `;
      if (fb) {
        narrative += `${ctrlName}'s target was lowered to ${fb.new_target.toFixed(1)}\u00b0C to bring it down.`;
      }
      if (cooling) {
        narrative += ` ${ctrlName} is actively cooling.`;
      } else if (mode === "Idle") {
        narrative += ` ${ctrlName} is idle \u2014 waiting for the next cooling cycle.`;
      }
    } else {
      narrative = `${sensorDesc} reads ${beerTemp}\u00b0C, which is ${absErr.toFixed(1)}\u00b0C below your ${targetLabel} target. `;
      if (fb) {
        narrative += `${ctrlName}'s target was raised to ${fb.new_target.toFixed(1)}\u00b0C to warm it up.`;
      }
      if (heating) {
        narrative += ` ${ctrlName} is actively heating.`;
      } else if (mode === "Idle") {
        narrative += ` ${ctrlName} is idle \u2014 waiting for the next heating cycle.`;
      }
    }
  }
  narEl.textContent = narrative;

  // Hardware constraints note
  const hwEl = document.getElementById("feedback-hardware-note");
  const parts = [];
  if (compDelay != null) parts.push(`compressor cooldown of ${compDelay} min`);
  if (coolHyst != null) parts.push(`cooling hysteresis of ${coolHyst}\u00b0C`);
  if (heatHyst != null) parts.push(`heating hysteresis of ${heatHyst}\u00b0C`);
  if (parts.length) {
    hwEl.textContent = `${ctrlName} has a ${parts.join(", ")}. ` +
      `The feedback loop checks every ${intervalMin} min and only adjusts if the delta exceeds ${deadband}\u00b0C \u2014 ` +
      `these hardware constraints mean convergence takes multiple cycles. This is as fast as the controller allows.`;
  } else {
    hwEl.textContent = `Feedback loop checks every ${intervalMin} min, adjusts only if delta exceeds ${deadband}\u00b0C deadband.`;
  }

  // Action plan — what's going to happen and when
  const hystEl = document.getElementById("feedback-hysteresis-note");
  if (beerTemp != null && targetBeer != null && ctrlTarget != null) {
    const currentCtrlTarget = parseFloat(ctrlTarget);
    const err = beerTemp - targetBeer;
    const absErr = Math.abs(err);
    const needsCool = err > deadband;
    const needsHeat = err < -deadband;
    const relevantHyst = needsCool ? coolHyst : heatHyst;
    const action = needsCool ? "cool" : "heat";
    const gain = b.temp_feedback_gain || 1.5;
    const nextTarget = Math.round((targetBeer + (targetBeer - beerTemp) * gain) * 10) / 10;
    const nextTargetClamped = Math.max(b.temp_feedback_min || 0, Math.min(b.temp_feedback_max || 35, nextTarget));

    // Time until next check
    let countdownText = "";
    if (fbs && fbs.next_check) {
      const remSec = Math.max(0, Math.round(fbs.next_check - Date.now() / 1000));
      countdownText = remSec > 60 ? `in ~${Math.ceil(remSec / 60)} minutes` : remSec > 0 ? `in ${remSec} seconds` : "any moment now";
    } else {
      countdownText = `in ~${intervalMin} minutes`;
    }

    let plan = "";
    if (absErr <= deadband) {
      hystEl.style.color = "#2ea043";
      plan = `On target. Next check ${countdownText} \u2014 if beer is still within ${deadband}\u00b0C of ${targetLabel}, no action needed.`;
    } else {
      // Explain hysteresis situation
      let hystNote = "";
      if (relevantHyst != null && fridgeTemp != null) {
        const airDelta = Math.abs(parseFloat(fridgeTemp) - currentCtrlTarget);
        if (airDelta <= relevantHyst) {
          hystNote = ` Right now the fridge air (${parseFloat(fridgeTemp).toFixed(1)}\u00b0C) is only ${airDelta.toFixed(1)}\u00b0C from the controller target (${currentCtrlTarget.toFixed(1)}\u00b0C) \u2014 within the ${relevantHyst}\u00b0C ${action}ing hysteresis, so the compressor won't fire yet.`;
        }
      }

      hystEl.style.color = "#58a6ff";
      plan = `Next check ${countdownText}: beer is ${absErr.toFixed(1)}\u00b0C ${needsCool ? "above" : "below"} target. ` +
        `Plan is to set ${ctrlName} to ~${nextTargetClamped.toFixed(1)}\u00b0C ` +
        `(${needsCool ? "lower" : "higher"} to ${action} the liquid faster).${hystNote}`;
    }
    hystEl.textContent = plan;
  } else {
    hystEl.textContent = "";
  }

  // Populate "how it works" dynamic hardware values
  setIfExists("how-cool-hyst", coolHyst != null ? coolHyst : "0.5");
  setIfExists("how-heat-hyst", heatHyst != null ? heatHyst : "0.3");
  setIfExists("how-comp-delay", compDelay != null ? compDelay : "5");
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

const mdiEmoji = {
  "mdi:beer": "\ud83c\udf7a", "mdi:hops": "\ud83c\udf31", "mdi:thermometer": "\ud83c\udf21\ufe0f",
  "mdi:flask": "\ud83e\uddea", "mdi:bell-ring": "\ud83d\udd14", "mdi:alert": "\u26a0\ufe0f",
  "mdi:check-circle": "\u2705", "mdi:cup": "\ud83c\udf7b",
};

function renderReminders(reminders, sessionId) {
  const el = document.getElementById("reminder-list");
  if (!reminders.length) {
    el.innerHTML = '<div class="help-text">No reminders set. Add one above to get notified at key moments during your brew.</div>';
    return;
  }
  let html = '<table class="reminder-table"><thead><tr>';
  html += '<th>Status</th><th>Trigger</th><th>Message</th><th></th>';
  html += '</tr></thead><tbody>';
  reminders.forEach(r => {
    const typeLabel = r.reminder_type === "day" ? `On day ${r.trigger_value}` : `SG stable ${r.trigger_value} days`;
    const status = r.fired ? '<span class="badge-sm fired">Sent</span>' : '<span class="badge-sm pending">Waiting</span>';
    const icon = mdiEmoji[r.icon] || "\ud83c\udf7a";
    const del = !r.fired ? `<button class="btn-tiny btn-stop" onclick="deleteReminder('${sessionId}', ${r.id})">\u00d7</button>` : '';
    html += `<tr>
      <td>${status}</td>
      <td>${typeLabel}</td>
      <td>${icon} ${esc(r.message)}</td>
      <td>${del}</td>
    </tr>`;
  });
  html += '</tbody></table>';
  el.innerHTML = html;
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
  document.getElementById("reminder-unit-label").textContent = e.target.value === "day" ? "Day" : "Days stable";
});

// Icon picker
document.getElementById("icon-picker").addEventListener("click", (e) => {
  const btn = e.target.closest(".icon-pick");
  if (!btn) return;
  document.querySelectorAll(".icon-pick").forEach(b => b.classList.remove("selected"));
  btn.classList.add("selected");
  document.getElementById("reminder-icon").value = btn.dataset.icon;
});

/* Edit OG and Target Temp inline */
function editBrewOG() {
  if (!currentBrewId) return;
  const newOg = prompt("Enter new OG (e.g. 1.050):");
  if (!newOg) return;
  updateBrewField(currentBrewId, "og", parseFloat(newOg));
}

function editBrewTargetTemp() {
  if (!currentBrewId) return;
  const newTemp = prompt("Enter new target beer temp (\u00b0C):");
  if (!newTemp) return;
  updateBrewField(currentBrewId, "target_beer_temp", parseFloat(newTemp));
}

function editBrewTempSource() {
  // Legacy — now handled by device config panel
  document.getElementById("brew-device-edit").style.display = "block";
}

// Device config toggle
document.getElementById("btn-toggle-device-config").addEventListener("click", async () => {
  const editPanel = document.getElementById("brew-device-edit");
  const showing = editPanel.style.display !== "none";
  if (showing) {
    editPanel.style.display = "none";
    return;
  }
  editPanel.style.display = "block";
  // Populate selects with current devices
  try {
    const devices = await (await fetch("/api/devices")).json();
    const brew = await (await fetch(`/api/brews/${currentBrewId}`)).json();
    const tiltSel = document.getElementById("brew-edit-tilt");
    const ctrlSel = document.getElementById("brew-edit-ctrl");
    const srcSel = document.getElementById("brew-edit-source");
    tiltSel.innerHTML = '<option value="">None</option>';
    ctrlSel.innerHTML = '<option value="">None</option>';
    Object.keys(devices).forEach(id => {
      const dev = devices[id];
      const opt = document.createElement("option");
      opt.value = id;
      opt.textContent = dev._nickname || dev.name || id.substring(0, 8);
      if (dev.deviceType === "TILT") tiltSel.appendChild(opt);
      else ctrlSel.appendChild(opt);
    });
    if (brew.tilt_device_id) tiltSel.value = brew.tilt_device_id;
    if (brew.controller_device_id) ctrlSel.value = brew.controller_device_id;
    srcSel.value = brew.temp_source || "hydrometer";
  } catch (e) {}
});

document.getElementById("btn-save-device-config").addEventListener("click", async () => {
  if (!currentBrewId) return;
  const updates = {
    tilt_device_id: document.getElementById("brew-edit-tilt").value || null,
    controller_device_id: document.getElementById("brew-edit-ctrl").value || null,
    temp_source: document.getElementById("brew-edit-source").value,
  };
  try {
    const res = await fetch(`/api/brews/${currentBrewId}/update`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    });
    if (res.ok) {
      showToast("Devices updated", "success");
      document.getElementById("brew-device-edit").style.display = "none";
      loadBrewDetail(currentBrewId);
    } else showToast("Failed to update", "error");
  } catch (e) { showToast("Failed", "error"); }
});

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

  // Use brew start date, not relative time — show entire fermentation
  const brewStart = brew.started_at ? new Date(brew.started_at).getTime() / 1000 : (Date.now() / 1000) - 604800;
  const start = brewStart;
  const limit = 50000;

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
      borderColor: "#f0883e",
      borderWidth: 2, pointRadius: 0, tension: 0.3, fill: false, yAxisID: "y",
    });
  }
  if (results.fridgeTemp?.length) {
    let pts = mapPts(results.fridgeTemp);
    if (doFilter) pts = filterOutliers(pts, 2.0);
    datasets.push({
      label: "Fridge Temp (\u00b0C)",
      data: pts,
      borderColor: "#58a6ff",
      borderWidth: 2, pointRadius: 0, tension: 0.3, fill: false, yAxisID: "y",
    });
  }
  if (results.fridgeTarget?.length) {
    datasets.push({
      label: "Fridge Target (\u00b0C)",
      data: mapPts(results.fridgeTarget),
      borderColor: "#2ea043",
      borderWidth: 1, borderDash: [5, 5], pointRadius: 0, fill: false, yAxisID: "y",
    });
  }
  if (results.sg?.length) {
    hasSG = true;
    let pts = mapPts(results.sg);
    if (doFilter) pts = filterOutliers(pts, 0.002);
    datasets.push({
      label: "Specific Gravity",
      data: pts,
      borderColor: "#c9d1d9",
      borderWidth: 2, pointRadius: 0, tension: 0.3, fill: false, yAxisID: "y1",
    });
  }

  let hasMode = false;
  if (results.mode?.length) {
    hasMode = true;
    // Build per-point background colors for the fill
    const modePoints = results.mode.map(d => ({ x: d.timestamp * 1000, y: d.value }));
    const modeBg = results.mode.map(d => {
      if (d.value < 0) return "rgba(88,166,255,0.15)";
      if (d.value > 0) return "rgba(240,136,62,0.15)";
      return "rgba(0,0,0,0)";
    });
    datasets.push({
      label: "Mode",
      data: modePoints,
      borderWidth: 0,
      pointRadius: 0,
      fill: true,
      stepped: true,
      yAxisID: "yMode",
      backgroundColor: modeBg,
    });
  }

  if (!datasets.length) return;

  const scales = {
    x: { type: "time", time: { tooltipFormat: "MMM d, yyyy HH:mm:ss", displayFormats: { minute: "HH:mm", hour: "HH:mm", day: "MMM d", week: "MMM d", month: "MMM yyyy" } },
         ticks: { color: "#8b949e", maxTicksLimit: 12, major: { enabled: true }, font: ctx => ctx.tick && ctx.tick.major ? { weight: "bold", size: 11 } : { size: 10 },
                   callback: function(val, idx, ticks) { const d = new Date(val); const hm = String(d.getHours()).padStart(2,"0") + ":" + String(d.getMinutes()).padStart(2,"0"); if (ticks[idx] && ticks[idx].major) { const mon = d.toLocaleString("en",{month:"short"}); return [mon + " " + d.getDate(), hm]; } return hm; } }, grid: { color: "#21262d" } },
    y: { position: "left", grace: "10%", title: { display: true, text: "Temperature (\u00b0C)", color: "#8b949e" },
         ticks: { color: "#8b949e" }, grid: { color: "#21262d" } },
  };
  if (hasSG) {
    scales.y1 = { position: "right", grace: "10%", title: { display: true, text: "Specific Gravity", color: "#8b949e" },
                  ticks: { color: "#8b949e", callback: v => v.toFixed(3) }, grid: { drawOnChartArea: false } };
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
let feedbackRangeAll = false;

function toggleFeedbackRange() {
  feedbackRangeAll = !feedbackRangeAll;
  const btn = document.getElementById("btn-feedback-range");
  btn.textContent = feedbackRangeAll ? "Show: Entire Brew" : "Show: Last 4 Hours";
  if (lastFeedbackSession) loadFeedbackChart(lastFeedbackSession, true);
}

async function loadFeedbackChart(sessionId, forceReload) {
  // Only recreate if session changed or forced
  if (!forceReload && lastFeedbackSession === sessionId && feedbackChart) return;
  if (feedbackChart) { feedbackChart.destroy(); feedbackChart = null; }
  lastFeedbackSession = sessionId;
  try {
    const data = await (await fetch(`/api/brews/${sessionId}/feedback/log`)).json();
    if (!data.length) return;

    let pts;
    if (feedbackRangeAll) {
      pts = data; // entire brew
    } else {
      const cutoff = Date.now() - (4 * 60 * 60 * 1000);
      const recent = data.filter(d => d.timestamp * 1000 >= cutoff);
      pts = recent.length ? recent : data.slice(-48);
    }

    // Compute Y range: find min/max across all temps, pad by 2°C
    let allTemps = [];
    pts.forEach(d => {
      if (d.beer_temp != null) allTemps.push(d.beer_temp);
      if (d.fridge_temp != null) allTemps.push(d.fridge_temp);
      if (d.target_beer_temp != null) allTemps.push(d.target_beer_temp);
      if (d.new_controller_target != null) allTemps.push(d.new_controller_target);
    });
    const yMin = Math.floor(Math.min(...allTemps) - 2);
    const yMax = Math.ceil(Math.max(...allTemps) + 2);

    const ctx = document.getElementById("feedback-chart").getContext("2d");

    // Error band fill between beer temp and beer target
    const beerData = pts.map(d => ({ x: d.timestamp * 1000, y: d.beer_temp }));
    const targetData = pts.map(d => ({ x: d.timestamp * 1000, y: d.target_beer_temp }));

    feedbackChart = new Chart(ctx, {
      type: "line",
      data: {
        datasets: [
          // Beer target — the green dashed line you want the beer to hit
          { label: "Your Beer Target",
            data: targetData,
            borderColor: "#2ea043", borderWidth: 2, borderDash: [6, 4],
            pointRadius: 0, fill: false, order: 3 },
          // Beer temp — actual liquid reading (the truth)
          { label: "Actual Beer Temp (hydrometer)",
            data: beerData,
            borderColor: "#f0883e", borderWidth: 3, pointRadius: 2, pointBackgroundColor: "#f0883e",
            tension: 0.3,
            fill: { target: 0, above: "rgba(248,81,73,0.12)", below: "rgba(88,166,255,0.12)" },
            order: 2 },
          // Controller target — what we told the fridge to do via RAPT API
          { label: "Controller Target (what we sent)",
            data: pts.map(d => ({ x: d.timestamp * 1000, y: d.new_controller_target })),
            borderColor: "#58a6ff", borderWidth: 2, borderDash: [8, 4], pointRadius: 0,
            stepped: "before", fill: false, order: 4 },
          // Fridge air — what the controller's probe reads
          { label: "Fridge Air Temp",
            data: pts.map(d => ({ x: d.timestamp * 1000, y: d.fridge_temp })),
            borderColor: "rgba(121,192,255,0.5)", borderWidth: 1, pointRadius: 0,
            tension: 0.3, fill: false, order: 5 },
        ],
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: "index", intersect: false },
        scales: {
          x: { type: "time",
            time: { tooltipFormat: "MMM d, yyyy HH:mm:ss", displayFormats: { minute: "HH:mm", hour: "HH:mm", day: "MMM d", week: "MMM d", month: "MMM yyyy" } },
            ticks: { color: "#8b949e", maxTicksLimit: 12, major: { enabled: true }, font: ctx => ctx.tick && ctx.tick.major ? { weight: "bold", size: 11 } : { size: 10 },
                   callback: function(val, idx, ticks) { const d = new Date(val); const hm = String(d.getHours()).padStart(2,"0") + ":" + String(d.getMinutes()).padStart(2,"0"); if (ticks[idx] && ticks[idx].major) { const mon = d.toLocaleString("en",{month:"short"}); return [mon + " " + d.getDate(), hm]; } return hm; } },
            grid: { color: "#21262d" },
            title: { display: true, text: feedbackRangeAll ? "Entire Brew" : "Last 4 Hours", color: "#484f58", font: { size: 11 } },
          },
          y: { min: yMin, max: yMax,
            ticks: { color: "#8b949e", stepSize: 1, callback: v => v + "\u00b0C" },
            grid: { color: "#21262d" },
            title: { display: true, text: "Temperature (\u00b0C)", color: "#484f58", font: { size: 11 } },
          },
        },
        plugins: {
          legend: {
            labels: { color: "#c9d1d9", usePointStyle: true, pointStyle: "line", padding: 16 },
          },
          tooltip: {
            callbacks: {
              label: ctx => `${ctx.dataset.label}: ${ctx.parsed.y.toFixed(1)}\u00b0C`,
            },
          },
        },
      },
    });
  } catch (e) {}
}

/* Recipe photo upload */
document.getElementById("brew-recipe-photo-upload").addEventListener("change", async (e) => {
  if (!currentBrewId || !e.target.files.length) return;
  const formData = new FormData();
  formData.append("photo", e.target.files[0]);
  try {
    await fetch(`/api/brews/${currentBrewId}/recipe-photo`, { method: "POST", body: formData });
    showToast("Recipe photo uploaded", "success");
    loadBrewDetail(currentBrewId);
  } catch (e) { showToast("Upload failed", "error"); }
});

function renderBrewRecipePhoto(brew) {
  // Recipe text
  const textArea = document.getElementById("brew-recipe-text");
  if (textArea) textArea.value = brew.recipe || "";

  // Recipe photo
  const container = document.getElementById("brew-recipe-photo-container");
  if (brew.recipe_photo) {
    container.innerHTML = `<img src="/api/brews/${brew.id}/recipe-photo" style="width:100%;max-height:400px;object-fit:contain;border-radius:6px">`;
  } else {
    container.innerHTML = '<p class="help-text">No recipe photo yet.</p>';
  }
}

async function saveBrewRecipe() {
  if (!currentBrewId) return;
  const recipe = document.getElementById("brew-recipe-text").value;
  try {
    const res = await fetch(`/api/brews/${currentBrewId}/notes`, {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({recipe}),
    });
    if (res.ok) showToast("Recipe saved", "success");
    else showToast("Save failed", "error");
  } catch (e) { showToast("Save failed", "error"); }
}

/* Brew action buttons */
document.getElementById("btn-complete-brew").addEventListener("click", async () => {
  if (!currentBrewId) return;
  const fgRaw = prompt("Enter Final Gravity (e.g. 1.010) or leave blank:");
  const data = {};
  if (fgRaw) data.fg = parseFloat(fgRaw);
  try {
    await fetch(`/api/brews/${currentBrewId}/complete`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data)
    });
    showToast("Brew completed!", "success");
    loadBrewNav();
    showPage("legendary");
  } catch (e) { showToast("Failed", "error"); }
});

document.getElementById("btn-cancel-brew").addEventListener("click", async () => {
  if (!currentBrewId) return;
  if (!confirm("Cancel this brew session?")) return;
  try {
    await fetch(`/api/brews/${currentBrewId}/cancel`, { method: "POST" });
    showToast("Brew cancelled", "success");
    loadBrewNav();
    showPage("legendary");
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

/* --- Device Management --- */
let editingDeviceId = null;

async function loadManageDevices() {
  try {
    const res = await fetch("/api/devices/manage");
    const devices = await res.json();
    const grid = document.getElementById("manage-device-list");
    const empty = document.getElementById("manage-device-empty");
    if (!devices.length) {
      grid.innerHTML = "";
      empty.style.display = "";
      return;
    }
    empty.style.display = "none";
    grid.innerHTML = devices.map(d => {
      const isLive = d.online;
      const isTilt = d.device_type.toLowerCase() === "tilt";
      const typeClass = isTilt ? "tilt" : "rapt";
      const typeLabel = isTilt ? "Tilt Hydrometer" : "RAPT Temperature Controller";
      const displayName = d.nickname || d.name;
      const lastSeen = d.last_seen ? new Date(d.last_seen * 1000).toLocaleString() : "Never";
      const photoHtml = d.photo_path
        ? `<img class="device-photo" src="/api/devices/${d.device_id}/photo" alt="${esc(displayName)}">`
        : `<div class="device-photo-placeholder">${isTilt ? '&#x1F4A7;' : '&#x1F321;'}</div>`;
      return `
        <div class="manage-device-card${isLive ? '' : ' offline'}">
          ${photoHtml}
          <div class="device-meta">
            <span class="name">${esc(displayName)}${!isLive ? ' <span class="status-dot offline" style="display:inline-block"></span>' : ' <span class="status-dot online" style="display:inline-block"></span>'}</span>
            ${d.nickname ? `<span class="nickname">${esc(d.name)}</span>` : ''}
            <span class="type-badge ${typeClass}">${typeLabel}</span>
            <span class="nickname">Last seen: ${lastSeen}</span>
          </div>
          <div class="card-actions">
            <button onclick="openDeviceEdit('${d.device_id}', '${esc(d.nickname || '')}', '${d.photo_path || ''}')">Edit</button>
            <button onclick="showPage('device','${d.device_id}')">View</button>
            <button class="btn-forget" onclick="forgetDevice('${d.device_id}', '${esc(displayName)}')">Forget</button>
          </div>
        </div>`;
    }).join("");
  } catch (e) {}
}

function openDeviceEdit(deviceId, nickname, photoPath) {
  editingDeviceId = deviceId;
  document.getElementById("modal-nickname").value = nickname;
  const preview = document.getElementById("modal-photo-preview");
  const img = document.getElementById("modal-photo-img");
  if (photoPath) {
    img.src = "/api/devices/" + deviceId + "/photo";
    preview.style.display = "";
  } else {
    preview.style.display = "none";
  }
  document.getElementById("modal-photo").value = "";
  document.getElementById("modal-device-title").textContent = "Edit Device";
  document.getElementById("device-edit-modal").style.display = "";
}

function closeDeviceEdit() {
  document.getElementById("device-edit-modal").style.display = "none";
  editingDeviceId = null;
}

async function saveDeviceEdit() {
  if (!editingDeviceId) return;
  const nickname = document.getElementById("modal-nickname").value.trim();
  const photoInput = document.getElementById("modal-photo");

  // Save nickname
  try {
    await fetch("/api/devices/" + editingDeviceId + "/manage", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ nickname: nickname })
    });
  } catch (e) {}

  // Upload photo if selected
  if (photoInput.files.length > 0) {
    const formData = new FormData();
    formData.append("photo", photoInput.files[0]);
    try {
      await fetch("/api/devices/" + editingDeviceId + "/photo", {
        method: "POST",
        body: formData
      });
    } catch (e) {}
  }

  closeDeviceEdit();
  loadManageDevices();
  loadDevices();
  showToast("Device updated", "success");
}

async function forgetDevice(deviceId, name) {
  if (!confirm("Forget " + name + "? This removes it from the device list but keeps history data.")) return;
  try {
    const res = await fetch("/api/devices/" + deviceId + "/forget", { method: "POST" });
    if (res.ok) {
      showToast("Device forgotten", "success");
      loadManageDevices();
      loadDevices();
    } else {
      showToast("Failed to forget device", "error");
    }
  } catch (e) { showToast("Failed to forget device", "error"); }
}

// Modal button handlers
document.getElementById("btn-modal-save").addEventListener("click", saveDeviceEdit);
document.getElementById("btn-modal-cancel").addEventListener("click", closeDeviceEdit);
document.getElementById("device-edit-modal").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) closeDeviceEdit();
});

// Photo preview
document.getElementById("modal-photo").addEventListener("change", (e) => {
  const file = e.target.files[0];
  if (file) {
    const reader = new FileReader();
    reader.onload = (ev) => {
      document.getElementById("modal-photo-img").src = ev.target.result;
      document.getElementById("modal-photo-preview").style.display = "";
    };
    reader.readAsDataURL(file);
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

/* --- Brew Nav List --- */
async function loadBrewNav() {
  try {
    const brews = await (await fetch("/api/brews")).json();
    const navList = document.getElementById("brew-nav-list");
    if (!brews.length) {
      navList.innerHTML = '';
      return;
    }
    const sorted = brews.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
    navList.innerHTML = sorted.map(b => {
      const active = currentPage === "brew-detail" && currentBrewId === b.id;
      return `<a class="nav-item brew-nav${active ? ' active' : ''}" data-brew="${b.id}" href="#" onclick="event.preventDefault();showPage('brew-detail','${b.id}')">${esc(b.name)}</a>`;
    }).join("");
  } catch (e) {}
}

/* --- Legendary Brews --- */
async function loadLegendaryBrews() {
  try {
    const data = await (await fetch("/api/brew/history")).json();
    const completed = data.filter(b => b.status !== "active");
    const container = document.getElementById("legendary-brew-list");
    if (!completed.length) {
      container.innerHTML = '<div class="panel"><p class="help-text">No legendary brews yet. Complete a brew session to start your hall of fame.</p></div>';
      return;
    }
    container.innerHTML = completed.map(b => {
      const ogStr = fmtG(b.og);
      const fgStr = fmtG(b.fg);
      const abvStr = (b.og && b.fg) ? ((b.og - b.fg) * 131.25).toFixed(1) + "%" : "--";
      const dateStr = b.started_at ? new Date(b.started_at).toLocaleDateString() : "--";
      const rating = b.rating || 0;
      const stars = renderStars(rating);
      const photoHtml = b.recipe_photo
        ? `<img class="legendary-photo" src="/api/brews/${b.id}/recipe-photo" alt="Recipe">`
        : '';
      return `
        <div class="panel legendary-brew-card">
          <div class="legendary-header">
            <div>
              <h3>${esc(b.name)}</h3>
              <span class="help-text">${dateStr} &middot; ${b.status}</span>
            </div>
            <div class="legendary-stars" data-brew-id="${b.id}">${stars}</div>
          </div>
          ${photoHtml}
          <div class="legendary-stats">
            <span>OG: ${ogStr}</span>
            <span>FG: ${fgStr}</span>
            <span>ABV: ${abvStr}</span>
          </div>
          ${b.tasting_notes ? `<div class="legendary-notes"><strong>Tasting Notes</strong><p>${esc(b.tasting_notes)}</p></div>` : ''}
          ${b.recipe ? `<div class="legendary-notes"><strong>Recipe</strong><p>${esc(b.recipe)}</p></div>` : ''}
          ${b.brewing_notes ? `<div class="legendary-notes"><strong>Brewing Notes</strong><p>${esc(b.brewing_notes)}</p></div>` : ''}
          <div class="card-actions" style="margin-top:12px">
            <button onclick="editLegendaryBrew('${b.id}')">Edit Notes</button>
            <button onclick="showPage('brew-detail','${b.id}')">View Details</button>
          </div>
        </div>`;
    }).join("");
  } catch (e) {}
}

function renderStars(rating) {
  let html = '';
  for (let i = 1; i <= 5; i++) {
    html += `<span class="star${i <= rating ? ' filled' : ''}" onclick="rateBrew(this, ${i})">&#9733;</span>`;
  }
  return html;
}

async function rateBrew(el, rating) {
  const brewId = el.parentElement.getAttribute("data-brew-id");
  try {
    await fetch(`/api/brews/${brewId}/rate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rating })
    });
    loadLegendaryBrews();
  } catch (e) {}
}

async function editLegendaryBrew(brewId) {
  try {
    const brew = await (await fetch(`/api/brew/history`)).json();
    const b = brew.find(x => x.id === brewId);
    if (!b) return;
    document.getElementById("legendary-edit-id").value = brewId;
    document.getElementById("legendary-edit-tasting").value = b.tasting_notes || "";
    document.getElementById("legendary-edit-recipe").value = b.recipe || "";
    document.getElementById("legendary-edit-brewing").value = b.brewing_notes || "";
    document.getElementById("legendary-edit-modal").style.display = "";
  } catch (e) {}
}

function closeLegendaryEdit() {
  document.getElementById("legendary-edit-modal").style.display = "none";
}

async function saveLegendaryEdit() {
  const brewId = document.getElementById("legendary-edit-id").value;
  const photoInput = document.getElementById("legendary-edit-photo");
  const updates = {
    tasting_notes: document.getElementById("legendary-edit-tasting").value,
    recipe: document.getElementById("legendary-edit-recipe").value,
    brewing_notes: document.getElementById("legendary-edit-brewing").value,
  };
  try {
    await fetch(`/api/brews/${brewId}/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates)
    });
    // Upload recipe photo if selected
    if (photoInput && photoInput.files.length > 0) {
      const formData = new FormData();
      formData.append("photo", photoInput.files[0]);
      await fetch(`/api/brews/${brewId}/recipe-photo`, { method: "POST", body: formData });
    }
    closeLegendaryEdit();
    loadLegendaryBrews();
    showToast("Brew notes saved", "success");
  } catch (e) { showToast("Failed to save", "error"); }
}

/* --- TiltPi Management --- */
let selectedTiltPi = null;

function loadTiltPiPage() {
  // Reset state when navigating to the page
  document.getElementById("tiltpi-scanning").style.display = "none";
  document.getElementById("tiltpi-results").style.display = "none";
  document.getElementById("tiltpi-none").style.display = "none";
  // Keep detail visible if we have a selected TiltPi
  if (!selectedTiltPi) {
    document.getElementById("tiltpi-detail").style.display = "none";
  }
}

async function scanTiltPi() {
  document.getElementById("tiltpi-scanning").style.display = "";
  document.getElementById("tiltpi-results").style.display = "none";
  document.getElementById("tiltpi-none").style.display = "none";
  document.getElementById("tiltpi-detail").style.display = "none";
  document.getElementById("btn-tiltpi-scan").disabled = true;

  try {
    const res = await fetch("/api/tiltpi/scan", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({}),
    });
    const instances = await res.json();
    document.getElementById("tiltpi-scanning").style.display = "none";
    document.getElementById("btn-tiltpi-scan").disabled = false;

    if (!instances.length) {
      document.getElementById("tiltpi-none").style.display = "";
      return;
    }

    document.getElementById("tiltpi-results").style.display = "";
    const list = document.getElementById("tiltpi-list");
    list.innerHTML = instances.map(inst => {
      const flowBadge = inst.flow_type === "upgraded"
        ? '<span class="type-badge tilt">RAPT2MQTT Upgraded</span>'
        : inst.flow_type === "modified"
          ? '<span class="type-badge" style="background:#854d0e;color:#fbbf24">User Modified (MQTT Scrape)</span>'
          : '<span class="type-badge rapt">Stock TiltPi</span>';
      return `
        <div class="manage-device-card" style="cursor:pointer" onclick="selectTiltPi('${inst.host}', ${inst.port})">
          <div class="device-photo-placeholder">&#x1F4E1;</div>
          <div class="device-meta">
            <span class="name">${inst.host}:${inst.port} <span class="status-dot online" style="display:inline-block"></span></span>
            <span class="nickname">Node-RED ${inst.nodered_version} &middot; ${inst.node_count} nodes</span>
            ${flowBadge}
          </div>
          <div class="card-actions">
            <button onclick="event.stopPropagation();selectTiltPi('${inst.host}', ${inst.port})">Configure</button>
          </div>
        </div>`;
    }).join("");
  } catch (e) {
    document.getElementById("tiltpi-scanning").style.display = "none";
    document.getElementById("btn-tiltpi-scan").disabled = false;
    showToast("Scan failed: " + e.message, "error");
  }
}

async function checkTiltPiManual() {
  const host = document.getElementById("tiltpi-manual-host").value.trim();
  if (!host) { showToast("Enter an IP address", "error"); return; }

  try {
    const res = await fetch("/api/tiltpi/check", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({host}),
    });
    const info = await res.json();
    if (!info.reachable) {
      showToast(`No TiltPi found at ${host}:1880`, "error");
      return;
    }
    selectTiltPi(host, info.port || 1880);
  } catch (e) {
    showToast("Check failed: " + e.message, "error");
  }
}

async function selectTiltPi(host, port) {
  try {
    const res = await fetch("/api/tiltpi/check", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({host, port}),
    });
    const info = await res.json();
    if (!info.reachable) {
      showToast(`Cannot reach ${host}:${port}`, "error");
      return;
    }

    selectedTiltPi = {host, port};
    // Hide scan result panels when selecting a TiltPi
    document.getElementById("tiltpi-none").style.display = "none";
    document.getElementById("tiltpi-scanning").style.display = "none";
    document.getElementById("tiltpi-detail").style.display = "";
    document.getElementById("tiltpi-detail-title").textContent = `TiltPi at ${host}`;
    document.getElementById("tiltpi-addr").textContent = `${host}:${port}`;
    document.getElementById("tiltpi-version").textContent = info.nodered_version;
    document.getElementById("tiltpi-nodes").textContent = info.node_count;

    const typeEl = document.getElementById("tiltpi-flow-type");
    if (info.flow_type === "upgraded") {
      typeEl.innerHTML = '<span class="type-badge tilt">RAPT2MQTT Upgraded</span>';
    } else if (info.flow_type === "modified") {
      typeEl.innerHTML = '<span class="type-badge" style="background:#854d0e;color:#fbbf24">User Modified (MQTT Scrape)</span>';
    } else {
      typeEl.innerHTML = '<span class="type-badge rapt">Stock TiltPi</span>';
    }

    // Load backups
    loadTiltPiBackups();
  } catch (e) {
    showToast("Failed to load TiltPi info: " + e.message, "error");
  }
}

async function deployTiltPiFlow(flowType) {
  if (!selectedTiltPi) { showToast("No TiltPi selected", "error"); return; }

  const action = flowType === "upgraded" ? "deploy the upgraded RAPT2MQTT flow" : "revert to the stock TiltPi flow";
  if (!confirm(`This will ${action} to ${selectedTiltPi.host}.\n\nThe current flow will be backed up first. Continue?`)) return;

  const {host, port} = selectedTiltPi;

  try {
    // Step 1: Backup current flow
    showToast("Backing up current flow...", "info");
    const backupRes = await fetch("/api/tiltpi/backup", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({host, port}),
    });
    const backup = await backupRes.json();
    if (backup.error) {
      showToast("Backup failed: " + backup.error, "error");
      return;
    }

    // Step 2: Deploy new flow
    showToast(`Deploying ${flowType} flow...`, "info");
    const deployRes = await fetch("/api/tiltpi/deploy", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({host, port, flow_type: flowType}),
    });
    const deploy = await deployRes.json();
    if (deploy.error) {
      showToast("Deploy failed: " + deploy.error, "error");
      return;
    }

    showToast(`${flowType === "upgraded" ? "Upgraded" : "Stock"} flow deployed to ${host} (${deploy.node_count} nodes)`, "success");

    // Refresh the detail view
    selectTiltPi(host, port);
  } catch (e) {
    showToast("Deploy error: " + e.message, "error");
  }
}

async function loadTiltPiBackups() {
  try {
    const res = await fetch("/api/tiltpi/backups");
    const backups = await res.json();
    const container = document.getElementById("tiltpi-backups");

    if (!backups.length) {
      container.innerHTML = '<p class="help-text">No backups yet. A backup is created automatically before each deployment.</p>';
      return;
    }

    container.innerHTML = backups.slice(0, 10).map(b => {
      const date = new Date(b.created * 1000).toLocaleString();
      const sizeKB = (b.size / 1024).toFixed(0);
      return `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid var(--border-color)">
          <div>
            <span style="color:var(--text-primary)">${b.filename}</span>
            <span class="nickname">${date} &middot; ${sizeKB}KB</span>
          </div>
          <button class="btn-start" style="font-size:0.8rem;padding:4px 10px" onclick="restoreTiltPiBackup('${b.filename}')">Restore</button>
        </div>`;
    }).join("");
  } catch (e) {}
}

async function restoreTiltPiBackup(filename) {
  if (!selectedTiltPi) { showToast("No TiltPi selected", "error"); return; }
  if (!confirm(`Restore backup "${filename}" to ${selectedTiltPi.host}?\n\nThis will replace the current flow.`)) return;

  const {host, port} = selectedTiltPi;
  try {
    showToast("Restoring backup...", "info");
    const res = await fetch("/api/tiltpi/restore", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({host, port, filename}),
    });
    const result = await res.json();
    if (result.error) {
      showToast("Restore failed: " + result.error, "error");
      return;
    }
    showToast(`Backup restored to ${host} (${result.node_count} nodes)`, "success");
    selectTiltPi(host, port);
  } catch (e) {
    showToast("Restore error: " + e.message, "error");
  }
}


/* --- Init --- */
loadConfig();
checkStatus();
initConsole();
loadDevices();
loadBrewNav();

// Load version into About page
fetch("/api/version").then(r => r.json()).then(d => {
  const el = document.getElementById("app-version");
  if (el) el.textContent = d.version;
}).catch(() => {});

// Navigate to latest active brew on startup (or stay on config if none)
(async () => {
  try {
    const brews = await (await fetch("/api/brews")).json();
    if (brews.length) {
      // Sort by started_at descending, show most recent
      const latest = brews.sort((a, b) => (b.started_at || "").localeCompare(a.started_at || ""))[0];
      showPage("brew-detail", latest.id);
    }
  } catch (e) {}
})();

// Periodic refreshes
setInterval(checkStatus, 5000);
setInterval(loadDevices, 10000);
setInterval(loadBrewNav, 15000);
setInterval(() => {
  if (currentPage === "dashboard") updateDashboardCards();
  if (currentPage === "brew-detail" && currentBrewId) loadBrewDetail(currentBrewId);
  if (currentPage === "legendary") loadLegendaryBrews();
  if (currentPage === "devices") loadManageDevices();
}, 10000);
