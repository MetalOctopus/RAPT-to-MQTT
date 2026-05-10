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

/* Auth state */
let authEnabled = false;
let currentRole = null;   // "brewmaster", "guest", or null
let currentUsername = null;

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
    if (page === "tilt-about") {} // static page, no loading needed
    if (page === "rapt-about") {} // static page, no loading needed
    if (page === "recipes") loadRecipesPage();
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
  document.getElementById("device-type-label").textContent = isTilt ? "Tilt Hydrometer" : "RAPT Temperature Controller";

  // Device hero photo
  const photoWrapper = document.getElementById("device-photo-wrapper");
  const photoPlaceholder = document.getElementById("device-photo-placeholder");
  const photoIcon = document.getElementById("device-photo-icon");
  photoIcon.innerHTML = isTilt ? '&#x1F4A7;' : '&#x1F321;';
  const existingImg = photoWrapper.querySelector(".brew-hero-photo");
  if (existingImg) existingImg.remove();
  const testImg = new Image();
  testImg.onload = () => {
    photoPlaceholder.style.display = "none";
    testImg.className = "brew-hero-photo";
    photoWrapper.insertBefore(testImg, photoPlaceholder);
  };
  testImg.onerror = () => { photoPlaceholder.style.display = ""; };
  testImg.src = "/api/devices/" + dev.id + "/photo?t=" + Date.now();

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
      const header = document.querySelector("#page-device .brew-hero");
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
  document.querySelectorAll(".tilt-only").forEach(el => el.style.display = isTilt ? "" : "none");

  // TILT default charts
  document.getElementById("tilt-default-charts").style.display = isTilt ? "block" : "none";
  if (isTilt) loadTiltDefaultCharts(dev.id);

  if (isTilt) {
    const tempStr = dev.temperature != null
      ? formatTemp(dev.temperature, "C") + " (" + dev.temperature_f + "\u00b0F)"
      : "--";
    document.getElementById("device-current-temp").textContent = tempStr;
    document.getElementById("device-gravity").textContent = fmtG(dev.specificGravity);

    // Signal card (always available)
    document.getElementById("device-signal").innerHTML = rssiLabel(dev.rssi);

    // Enriched fields (from Ian's Tasty MQTT Scrape v2)
    if (dev.txPower != null) {
      document.getElementById("device-tx-power").textContent = dev.txPower + " dBm";
    } else {
      document.getElementById("card-tx-power").style.display = "none";
    }
    document.getElementById("device-tilt-model").textContent = dev.isProModel ? "Tilt Pro (HD)" : "Tilt Standard";
    document.getElementById("device-tilt-cal").textContent = dev.calibrated ? "Yes" : "No";
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

  // Enriched Tilt fields (from upgraded TiltPi flow)
  const hasTiltExtras = isTilt && dev.txPower != null;
  document.getElementById("row-tx-power").style.display = hasTiltExtras ? "" : "none";
  document.getElementById("row-tilt-model").style.display = hasTiltExtras ? "" : "none";
  document.getElementById("row-tilt-calibrated").style.display = hasTiltExtras ? "" : "none";
  if (hasTiltExtras) {
    document.getElementById("info-tx-power").textContent = dev.txPower + " dBm";
    document.getElementById("info-tilt-model").textContent = dev.isProModel ? "Tilt Pro (HD)" : "Tilt Standard";
    document.getElementById("info-tilt-calibrated").textContent = dev.calibrated ? "Yes" : "No";
  }

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
    const tempData = await (await fetch(`/api/history/${deviceId}/temperature?start=${start}`)).json();
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
    const sgData = await (await fetch(`/api/history/${deviceId}/specificGravity?start=${start}`)).json();
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
    const data = await (await fetch(`/api/history/${deviceId}/${metric}?start=${start}`)).json();
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
    const data = await (await fetch(`/api/history/${deviceId}/rssi?start=${start}`)).json();
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

  const isCompleted = b.status === "completed" || b.status === "cancelled";

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

  // Batch badge
  const batchBadge = document.getElementById("brew-batch-badge");
  if (b.batch_number) {
    batchBadge.textContent = "Batch #" + b.batch_number;
    batchBadge.style.display = "";
    batchBadge.style.background = "rgba(230,168,23,0.15)";
    batchBadge.style.color = "#e6a817";
  } else {
    batchBadge.style.display = "none";
  }

  // Brew Again button (show for completed brews)
  const brewAgainWrapper = document.getElementById("brew-again-wrapper");
  if (brewAgainWrapper) {
    brewAgainWrapper.style.display = (b.status === "completed") ? "" : "none";
  }

  // Lineage links
  renderLineageLinks(b);

  // --- Graceful degradation: show/hide based on available gear ---
  const hasTilt = !!b.tilt_device_id;
  const hasCtrl = !!b.controller_device_id;

  document.querySelectorAll(".brew-needs-tilt").forEach(el => {
    el.style.display = hasTilt ? "" : "none";
  });
  document.querySelectorAll(".brew-needs-ctrl").forEach(el => {
    el.style.display = hasCtrl ? "" : "none";
  });

  // --- Completed brew: legendary view ---
  const gaugeDashboard = document.getElementById("gauge-dashboard");
  const legendaryStats = document.getElementById("legendary-stats-panel");
  const legendaryNotes = document.getElementById("legendary-notes-panel");
  const brewTiles = document.getElementById("brew-detail-tiles");
  const brewActionsBar = document.getElementById("brew-actions-bar");
  const manualPanel = document.getElementById("manual-reading-panel");
  const chartPanelActive = document.getElementById("brew-chart-panel-active");
  const chartPanelCompleted = document.getElementById("brew-chart-panel-completed");
  const brewDeviceConfig = document.getElementById("brew-device-config");
  const brewLogAddEvent = document.getElementById("brew-log-add-event-row");

  if (isCompleted) {
    // Hide active-brew-only elements
    if (gaugeDashboard) gaugeDashboard.style.display = "none";
    if (brewTiles) brewTiles.style.display = "none";
    if (brewActionsBar) brewActionsBar.style.display = "none";
    if (manualPanel) manualPanel.style.display = "none";
    if (chartPanelActive) chartPanelActive.style.display = "none";
    if (chartPanelCompleted) chartPanelCompleted.style.display = "";
    if (brewDeviceConfig) brewDeviceConfig.style.display = "none";
    if (brewLogAddEvent) brewLogAddEvent.style.display = "none";
    const fbPanel = document.getElementById("feedback-panel");
    if (fbPanel) fbPanel.style.display = "none";

    // Show legendary stats
    if (legendaryStats) {
      legendaryStats.style.display = "";
      const computedAbv = b.current_abv != null ? b.current_abv
        : (b.og && b.fg) ? Math.round((b.og - b.fg) * 131.25 * 10) / 10
        : null;
      document.getElementById("legendary-og").textContent = fmtG(b.og);
      document.getElementById("legendary-fg").textContent = fmtG(b.fg);
      document.getElementById("legendary-abv").textContent = computedAbv != null ? computedAbv.toFixed(1) + "%" : "--";

      // Brew time
      if (b.started_at && b.completed_at) {
        const startMs = new Date(b.started_at).getTime();
        const endMs = new Date(b.completed_at).getTime();
        const brewDays = Math.floor((endMs - startMs) / 86400000);
        document.getElementById("legendary-brew-time").textContent = brewDays + (brewDays === 1 ? " day" : " days");
      } else {
        document.getElementById("legendary-brew-time").textContent = "--";
      }

      // Target temp (or temp profile summary)
      const profile = b.temp_profile;
      if (profile && profile.steps && profile.steps.length > 1) {
        const temps = profile.steps.map(s => s.temp);
        const minT = Math.min(...temps);
        const maxT = Math.max(...temps);
        document.getElementById("legendary-target-temp").textContent = formatTemp(minT, "C") + " - " + formatTemp(maxT, "C");
      } else if (b.target_beer_temp != null) {
        document.getElementById("legendary-target-temp").textContent = formatTemp(b.target_beer_temp, "C");
      } else {
        document.getElementById("legendary-target-temp").textContent = "--";
      }

      // Devices
      document.getElementById("legendary-tilt").textContent = b.tilt_name || (b.tilt_device_id ? b.tilt_device_id : "None");
      document.getElementById("legendary-ctrl").textContent = b.controller_name || (b.controller_device_id ? b.controller_device_id : "None");
    }

    // Duration for completed brews
    if (b.started_at && b.completed_at) {
      const startMs = new Date(b.started_at).getTime();
      const endMs = new Date(b.completed_at).getTime();
      const brewDays = Math.floor((endMs - startMs) / 86400000);
      const dateStr = new Date(b.started_at).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
      const endStr = new Date(b.completed_at).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
      document.getElementById("brew-detail-duration").textContent = `${dateStr} \u2014 ${endStr} (${brewDays} day${brewDays !== 1 ? 's' : ''})`;
    } else {
      const days = daysSince(b.started_at);
      document.getElementById("brew-detail-duration").textContent = `Day ${Math.floor(days)} (${formatSeconds(days * 86400)})`;
    }

    // Show legendary notes panel
    if (legendaryNotes) {
      legendaryNotes.style.display = "";
      const ratingStars = document.getElementById("legendary-rating-stars");
      ratingStars.setAttribute("data-brew-id", b.id);
      ratingStars.innerHTML = renderStars(b.rating || 0);
      document.getElementById("legendary-tasting-notes").value = b.tasting_notes || "";
      document.getElementById("legendary-brewer-notes").value = b.brewing_notes || "";
    }

    // Move chart canvas into completed accordion
    moveChartToCompletedAccordion();

  } else {
    // Active brew: show normal elements, hide legendary panels
    if (gaugeDashboard) gaugeDashboard.style.display = "";
    if (brewTiles) brewTiles.style.display = "";
    if (brewActionsBar) brewActionsBar.style.display = "";
    if (chartPanelActive) chartPanelActive.style.display = "";
    if (chartPanelCompleted) chartPanelCompleted.style.display = "none";
    if (brewDeviceConfig) brewDeviceConfig.style.display = "";
    if (brewLogAddEvent) brewLogAddEvent.style.display = "";
    if (legendaryStats) legendaryStats.style.display = "none";
    if (legendaryNotes) legendaryNotes.style.display = "none";

    // Restore chart canvas to active panel if it was moved
    restoreChartToActivePanel();

    // Cold crash button: enable only if controller assigned and brew active
    const coldCrashBtn = document.getElementById("btn-cold-crash");
    if (coldCrashBtn) {
      coldCrashBtn.disabled = !hasCtrl || b.status !== "active";
    }
    const noCtrlHint = document.querySelector(".brew-no-ctrl-hint");
    if (noCtrlHint) noCtrlHint.style.display = (!hasCtrl && b.status === "active") ? "" : "none";

    // Gauges: show/hide based on gear
    const gaugeBeer = document.querySelector("#gauge-beer-temp")?.closest(".gauge-panel");
    const gaugeSGPanel = document.querySelector("#gauge-sg")?.closest(".gauge-panel");
    const gaugeFridge = document.querySelector("#gauge-fridge")?.closest(".gauge-panel");
    if (gaugeBeer) gaugeBeer.style.display = hasTilt ? "" : "none";
    if (gaugeSGPanel) gaugeSGPanel.style.display = hasTilt ? "" : "none";
    if (gaugeFridge) gaugeFridge.style.display = hasCtrl ? "" : "none";

    // Smart feedback needs both Tilt + Controller
    const fbPanel = document.getElementById("feedback-panel");
    if (fbPanel) fbPanel.style.display = (hasTilt && hasCtrl) ? "" : "none";

    // Manual reading panel: show when missing Tilt (no auto SG/temp)
    if (manualPanel) {
      manualPanel.style.display = (!hasTilt && b.status === "active") ? "" : "none";
      const manualTempGroup = document.getElementById("manual-temp-group");
      if (manualTempGroup) manualTempGroup.style.display = hasCtrl ? "none" : "";
    }

    const days = daysSince(b.started_at);
    document.getElementById("brew-detail-duration").textContent = `Day ${Math.floor(days)} (${formatSeconds(days * 86400)})`;

    // Beer temp from live data
    const beerTemp = b.beer_temp;
    document.getElementById("brew-beer-temp").textContent = beerTemp != null ? formatTemp(beerTemp, "C") : "--";
    document.getElementById("brew-fridge-temp").textContent = b.fridge_temp != null ? formatTemp(b.fridge_temp, "C") : "--";
    document.getElementById("brew-sg").textContent = fmtG(b.current_sg);
    const computedAbv = b.current_abv != null ? b.current_abv
      : (b.og && b.fg) ? Math.round((b.og - b.fg) * 131.25 * 10) / 10
      : null;
    document.getElementById("brew-abv").textContent = computedAbv != null ? computedAbv.toFixed(1) + "%" : "--";

    const og = b.og;
    document.getElementById("brew-og-display").textContent = fmtG(og);
    const fgCard = document.getElementById("brew-fg-card");
    const fgDisplay = document.getElementById("brew-fg-display");
    if (fgCard && fgDisplay) {
      if (b.fg != null) {
        fgCard.style.display = "";
        fgDisplay.textContent = fmtG(b.fg);
      } else {
        fgCard.style.display = "none";
      }
    }
    document.getElementById("brew-target-display").textContent = b.target_beer_temp != null ? formatTemp(b.target_beer_temp, "C") : "--";
    document.getElementById("brew-fridge-target").textContent = b.controller_target != null ? formatTemp(b.controller_target, "C") : "--";

    // Device config summary
    const sourceLabels = { hydrometer: "Hydrometer (in-liquid)", controller: "Controller (fridge air)", mean: "Mean of both" };
    document.getElementById("brew-cfg-tilt").textContent = b.tilt_name || "None";
    document.getElementById("brew-cfg-ctrl").textContent = b.controller_name || "None";
    document.getElementById("brew-cfg-source").textContent = sourceLabels[b.temp_source] || "Hydrometer (in-liquid)";

    // ABV under gauge
    const abvText = computedAbv != null ? computedAbv.toFixed(1) + "% ABV" : "-- ABV";
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
  }

  // Temperature profile
  renderProfileDesigner(b);

  // Feedback explanation and live status
  renderFeedbackStatus(b);

  // Reminders
  renderReminders(b.reminders || [], b.id);

  // Events (text-based brew log)
  renderBrewLog(b.events || [], b.started_at);

  // Brew photo + Recipe
  renderBrewPhoto(b);
  renderBrewRecipePhoto(b);

  // Hide actions for completed/cancelled brews
  const actionsPanel = document.getElementById("brew-actions-panel");
  if (actionsPanel) actionsPanel.style.display = (b.status === "active") ? "" : "none";

  // Load feedback chart
  if (b.temp_feedback_enabled) loadFeedbackChart(b.id, true);

  // Load legendary profile dropdown for active brews
  if (b.status === "active") loadLegendaryProfileDropdown();
}

// Move the brew chart canvas into the completed accordion
function moveChartToCompletedAccordion() {
  const completedBody = document.getElementById("brew-chart-completed-body");
  const chartCanvas = document.getElementById("brew-chart");
  if (!completedBody || !chartCanvas) return;
  // Only move if not already there
  if (chartCanvas.closest("#brew-chart-completed-body")) return;
  const chartContainer = chartCanvas.closest(".chart-container");
  if (chartContainer) {
    completedBody.appendChild(chartContainer);
  }
}

// Restore the brew chart canvas back to the active panel
function restoreChartToActivePanel() {
  const activePanel = document.getElementById("brew-chart-panel-active");
  const chartCanvas = document.getElementById("brew-chart");
  if (!activePanel || !chartCanvas) return;
  // Only move if not already there
  if (chartCanvas.closest("#brew-chart-panel-active")) return;
  const chartContainer = chartCanvas.closest(".chart-container");
  if (chartContainer) {
    // Insert after the controls div
    const controlsDiv = document.getElementById("brew-chart-active-controls");
    if (controlsDiv) {
      controlsDiv.after(chartContainer);
    } else {
      activePanel.appendChild(chartContainer);
    }
  }
}

// Resize chart when completed accordion opens (Chart.js needs visible container)
(function() {
  const acc = document.getElementById("brew-chart-panel-completed");
  if (acc) {
    acc.addEventListener("toggle", function() {
      if (acc.open) {
        const sid = currentBrewId;
        if (sid && brewCharts[sid]) {
          setTimeout(() => brewCharts[sid].resize(), 50);
        }
      }
    });
  }
})();

// Save legendary notes (rating is saved via star clicks; this saves text fields)
async function saveLegendaryNotes() {
  const brewId = currentBrewId;
  if (!brewId) return;
  const updates = {
    tasting_notes: document.getElementById("legendary-tasting-notes").value,
    brewing_notes: document.getElementById("legendary-brewer-notes").value,
  };
  try {
    await fetch(`/api/brews/${brewId}/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates),
    });
    showToast("Notes saved", "success");
  } catch (e) {
    showToast("Failed to save notes", "error");
  }
}

async function renderLineageLinks(b) {
  const container = document.getElementById("brew-lineage-links");
  if (!container) return;
  if (!b.parent_brew_id && !b.batch_number) {
    // Check if this brew has children (is a parent of other brews)
    try {
      const lineage = await (await fetch(`/api/brews/${b.id}/lineage`)).json();
      if (lineage.length <= 1) { container.style.display = "none"; return; }
      const links = lineage.filter(l => l.id !== b.id).map(l =>
        `<a href="#" onclick="event.preventDefault();showPage('brew-detail','${l.id}')" style="color:#58a6ff">${esc(l.name)}</a>`
      );
      container.innerHTML = "Lineage: " + links.join(", ");
      container.style.display = "";
    } catch (e) { container.style.display = "none"; }
    return;
  }
  try {
    const lineage = await (await fetch(`/api/brews/${b.id}/lineage`)).json();
    if (lineage.length <= 1) { container.style.display = "none"; return; }
    const links = lineage.filter(l => l.id !== b.id).map(l =>
      `<a href="#" onclick="event.preventDefault();showPage('brew-detail','${l.id}')" style="color:#58a6ff">${esc(l.name)}</a>`
    );
    container.innerHTML = "Lineage: " + links.join(", ");
    container.style.display = "";
  } catch (e) { container.style.display = "none"; }
}

async function loadLegendaryProfileDropdown() {
  const sel = document.getElementById("load-legendary-profile");
  if (!sel) return;
  try {
    const profiles = await (await fetch("/api/brews/legendary-profiles")).json();
    sel.innerHTML = '<option value="">-- Select a brew --</option>';
    profiles.forEach(p => {
      const opt = document.createElement("option");
      opt.value = p.id;
      const steps = (p.temp_profile.steps || []).length;
      opt.textContent = `${p.name} (${steps} step${steps !== 1 ? 's' : ''})`;
      sel.appendChild(opt);
    });
  } catch (e) {}
}

async function loadLegendaryProfile() {
  const sel = document.getElementById("load-legendary-profile");
  if (!sel || !sel.value) return;
  try {
    const profiles = await (await fetch("/api/brews/legendary-profiles")).json();
    const match = profiles.find(p => p.id === sel.value);
    if (!match || !match.temp_profile || !match.temp_profile.steps) return;
    if (profileSteps.length > 0 && !confirm("Replace current profile steps with the profile from " + match.name + "?")) {
      sel.value = "";
      return;
    }
    profileSteps = JSON.parse(JSON.stringify(match.temp_profile.steps));
    // Remove runtime state
    profileSteps.forEach(s => { delete s._active; });
    renderProfileSteps();
    if (currentBrewId) {
      const brew = await (await fetch(`/api/brews/${currentBrewId}`)).json();
      renderProfileTimeline(brew);
    }
    showToast("Profile loaded from " + match.name, "success");
    sel.value = "";
  } catch (e) { showToast("Failed to load profile", "error"); }
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

function gaugeBase(min, max, value, fmt, arcColors, needleColor, anchorColor, targetValue, labelFormatter) {
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
      axisLabel: { distance: 16, color: "#484f58", fontSize: 11, ...(labelFormatter ? { formatter: labelFormatter } : {}) },
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
      "#c9d1d9", "rgb(201,209,217)", ogVal,
      v => String(Math.round((v % 1) * 1000)).padStart(3, "0").slice(-2)));
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
  const systemEvents = new Set(["brew_started", "brew_completed", "brew_cancelled"]);
  el.innerHTML = events.map(ev => {
    const dt = new Date(ev.timestamp * 1000);
    const day = Math.floor((ev.timestamp * 1000 - new Date(startedAt).getTime()) / 86400000);
    const hh = String(dt.getHours()).padStart(2, "0");
    const mm = String(dt.getMinutes()).padStart(2, "0");
    const dateStr = dt.toLocaleDateString([], { month: "short", day: "numeric" });
    const typeLabels = {
      brew_started: "Started",
      brew_completed: "Completed",
      brew_cancelled: "Cancelled",
      dry_hop: "Dry Hop",
      sample: "Sample",
      note: "Note",
      reminder_fired: "Reminder",
      cold_crash: "Cold Crash",
      profile_step: "Profile Step",
      clarifier: "Clarifying Agent",
      ingredient: "Ingredient",
      yeast: "Yeast Pitched",
      transfer: "Transferred",
      bottled: "Bottled/Kegged",
    };
    const label = typeLabels[ev.event_type] || ev.event_type;
    const editable = !systemEvents.has(ev.event_type) && ev.id;
    const editBtns = editable
      ? `<span class="brew-log-actions">
           <button class="brew-log-edit-btn" onclick="editBrewEvent(${ev.id}, ${ev.timestamp}, '${esc(ev.description || '').replace(/'/g, "\\'")}')">edit</button>
           <button class="brew-log-del-btn" onclick="deleteBrewEvent(${ev.id})">x</button>
         </span>`
      : '';
    return `<div class="brew-log-entry">
      <span class="brew-log-day">Day ${day}</span>
      <span class="brew-log-time">${dateStr} ${hh}:${mm}</span>
      <span class="brew-log-type">${esc(label)}</span>
      <span class="brew-log-desc">${esc(ev.description || '')}</span>
      ${editBtns}
    </div>`;
  }).join("");
}

async function editBrewEvent(eventId, currentTs, currentDesc) {
  const dt = new Date(currentTs * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  const dtStr = `${dt.getFullYear()}-${pad(dt.getMonth()+1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`;

  const html = `<div style="display:flex;flex-direction:column;gap:8px">
    <label>When did this actually happen?</label>
    <input type="datetime-local" id="edit-event-time" value="${dtStr}" style="background:var(--bg-input);color:var(--text-primary);border:1px solid var(--border-color);padding:6px 8px;border-radius:4px">
    <label>Description</label>
    <input type="text" id="edit-event-desc" value="${currentDesc}" style="background:var(--bg-input);color:var(--text-primary);border:1px solid var(--border-color);padding:6px 8px;border-radius:4px">
  </div>`;

  // Use a simple modal approach — inject into DOM
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `<div class="modal-box" style="max-width:400px">
    <h3 style="margin-bottom:12px">Edit Event</h3>
    ${html}
    <div class="btn-row" style="margin-top:16px">
      <button class="btn-save" id="edit-event-save">Save</button>
      <button class="btn-stop" id="edit-event-cancel">Cancel</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);

  return new Promise(resolve => {
    overlay.querySelector("#edit-event-cancel").onclick = () => { overlay.remove(); resolve(); };
    overlay.onclick = (e) => { if (e.target === overlay) { overlay.remove(); resolve(); } };
    overlay.querySelector("#edit-event-save").onclick = async () => {
      const newTime = new Date(overlay.querySelector("#edit-event-time").value).getTime() / 1000;
      const newDesc = overlay.querySelector("#edit-event-desc").value;
      try {
        await fetch(`/api/brews/${currentBrewId}/event/${eventId}`, {
          method: "PUT", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ timestamp: newTime, description: newDesc })
        });
        showToast("Event updated", "success");
        loadBrewDetail(currentBrewId);
      } catch (e) { showToast("Failed", "error"); }
      overlay.remove();
      resolve();
    };
  });
}

async function deleteBrewEvent(eventId) {
  if (!confirm("Delete this log entry?")) return;
  try {
    await fetch(`/api/brews/${currentBrewId}/event/${eventId}`, { method: "DELETE" });
    showToast("Event deleted", "success");
    loadBrewDetail(currentBrewId);
  } catch (e) { showToast("Failed", "error"); }
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
let brewChartRange = {}; // "full" (default) or "24h"

function toggleBrewChartRange() {
  if (!currentBrewId) return;
  const cur = brewChartRange[currentBrewId] || "full";
  brewChartRange[currentBrewId] = cur === "full" ? "24h" : "full";
  const btn = document.getElementById("btn-brew-chart-range");
  if (btn) btn.textContent = brewChartRange[currentBrewId] === "24h" ? "Show: Full Brew" : "Show: Last 24h";
  // Force rebuild with new range
  const existing = brewCharts[currentBrewId];
  if (existing) { existing.destroy(); delete brewCharts[currentBrewId]; }
  brewChartCleared[currentBrewId] = false;
  // Refetch current brew data to rebuild chart
  fetch(`/api/brews/${currentBrewId}`).then(r => r.json()).then(b => autoPopulateBrewChart(b, true)).catch(() => {});
}

function _brewChartStart(brew) {
  const brewStart = brew.started_at ? new Date(brew.started_at).getTime() / 1000 : (Date.now() / 1000) - 604800;
  const range = brewChartRange[brew.id] || "full";
  if (range === "24h") {
    return Math.max(brewStart, (Date.now() / 1000) - 86400);
  }
  return brewStart;
}

async function autoPopulateBrewChart(brew, forceRebuild) {
  const sessionId = brew.id;
  if (brewChartCleared[sessionId]) return;

  // If chart already exists, update its data in-place (live refresh)
  const existing = brewCharts[sessionId];
  if (existing && !forceRebuild) {
    await refreshBrewChart(brew, existing);
    return;
  }
  if (forceRebuild && existing) { existing.destroy(); delete brewCharts[sessionId]; }

  const start = _brewChartStart(brew);

  const tiltId = brew.tilt_device_id;
  const ctrlId = brew.controller_device_id;
  const manualId = `manual-${sessionId}`;

  // Need at least one data source (real device or manual readings)
  if (!tiltId && !ctrlId) {
    const manualCheck = await fetch(`/api/history/${manualId}/temperature?start=${start}&limit=1`).then(r => r.json()).catch(() => []);
    const manualSGCheck = await fetch(`/api/history/${manualId}/specificGravity?start=${start}&limit=1`).then(r => r.json()).catch(() => []);
    if (!manualCheck.length && !manualSGCheck.length) return;
  }

  const fetches = {};
  if (tiltId) {
    fetches.beerTemp = fetch(`/api/history/${tiltId}/temperature?start=${start}`).then(r => r.json()).catch(() => []);
    fetches.sg = fetch(`/api/history/${tiltId}/specificGravity?start=${start}`).then(r => r.json()).catch(() => []);
  } else {
    fetches.beerTemp = fetch(`/api/history/${manualId}/temperature?start=${start}`).then(r => r.json()).catch(() => []);
    fetches.sg = fetch(`/api/history/${manualId}/specificGravity?start=${start}`).then(r => r.json()).catch(() => []);
  }
  // Beer target temp (not fridge target) — from session/profile/feedback history
  fetches.beerTarget = fetch(`/api/brews/${sessionId}/target-history`).then(r => r.json()).catch(() => []);

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
      label: "Actual Temp (\u00b0C)",
      data: pts,
      borderColor: "#f0883e",
      borderWidth: 2, pointRadius: 0, tension: 0.3, fill: false, yAxisID: "y",
    });
  }
  if (results.beerTarget?.length) {
    let pts = mapPts(results.beerTarget);
    // Filter to chart range
    if (brewChartRange[sessionId] === "24h") {
      const cutoff = (Date.now() / 1000 - 86400) * 1000;
      pts = pts.filter(p => p.x >= cutoff);
    }
    if (pts.length) {
      datasets.push({
        label: "Target Temp (\u00b0C)",
        data: pts,
        borderColor: "#2ea043",
        borderWidth: 2, borderDash: [5, 5], pointRadius: 0, stepped: "before", fill: false, yAxisID: "y",
      });
    }
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

  if (!datasets.length) return;

  const scales = {
    x: { type: "time", time: { tooltipFormat: "MMM d, yyyy HH:mm:ss", displayFormats: { minute: "HH:mm", hour: "HH:mm", day: "MMM d", week: "MMM d", month: "MMM yyyy" } },
         ticks: { color: "#8b949e", maxTicksLimit: 12, major: { enabled: true },
                  font: ctx => ctx.tick && ctx.tick.major ? { weight: "bold", size: 11 } : { size: 10 },
                  callback: function(val, idx, ticks) {
                    const d = new Date(val);
                    const hm = String(d.getHours()).padStart(2,"0") + ":" + String(d.getMinutes()).padStart(2,"0");
                    if (ticks[idx] && ticks[idx].major) {
                      const mon = d.toLocaleString("en",{month:"short"});
                      return [hm, mon + " " + d.getDate()];
                    }
                    return [hm, ""];
                  }
         },
         grid: {
           color: function(ctx) {
             const d = new Date(ctx.tick.value);
             if (d.getHours() === 0 && d.getMinutes() === 0) return "rgba(139,148,158,0.4)";
             return "#21262d";
           },
           lineWidth: function(ctx) {
             const d = new Date(ctx.tick.value);
             if (d.getHours() === 0 && d.getMinutes() === 0) return 2;
             return 1;
           }
         }
    },
    y: { position: "left", grace: "10%", title: { display: true, text: "Temperature (\u00b0C)", color: "#8b949e" },
         ticks: { color: "#8b949e" }, grid: { color: "#21262d" } },
  };
  if (hasSG) {
    scales.y1 = { position: "right", grace: "10%", title: { display: true, text: "Specific Gravity", color: "#8b949e" },
                  ticks: { color: "#8b949e", callback: v => v.toFixed(3) }, grid: { drawOnChartArea: false } };
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

/* Refresh brew chart data in-place without rebuilding */
async function refreshBrewChart(brew, chart) {
  const tiltId = brew.tilt_device_id;
  const manualId = `manual-${brew.id}`;

  const start = _brewChartStart(brew);
  const doFilter = brewFilterEnabled[brew.id];
  const mapPts = (arr) => arr.map(d => ({ x: d.timestamp * 1000, y: d.value }));

  const fetches = {};
  const tempSource = tiltId || manualId;
  fetches.beerTemp = fetch(`/api/history/${tempSource}/temperature?start=${start}`).then(r => r.json()).catch(() => []);
  fetches.sg = fetch(`/api/history/${tempSource}/specificGravity?start=${start}`).then(r => r.json()).catch(() => []);
  fetches.beerTarget = fetch(`/api/brews/${brew.id}/target-history`).then(r => r.json()).catch(() => []);

  const keys = Object.keys(fetches);
  const values = await Promise.all(keys.map(k => fetches[k]));
  const results = {};
  keys.forEach((k, i) => results[k] = values[i]);

  // Map labels to fresh data
  const dataMap = {};
  if (results.beerTemp?.length) {
    let pts = mapPts(results.beerTemp);
    if (doFilter) pts = filterOutliers(pts, 2.0);
    dataMap["Actual Temp (\u00b0C)"] = pts;
  }
  if (results.beerTarget?.length) {
    let pts = mapPts(results.beerTarget);
    if (brewChartRange[brew.id] === "24h") {
      const cutoff = (Date.now() / 1000 - 86400) * 1000;
      pts = pts.filter(p => p.x >= cutoff);
    }
    dataMap["Target Temp (\u00b0C)"] = pts;
  }
  if (results.sg?.length) {
    let pts = mapPts(results.sg);
    if (doFilter) pts = filterOutliers(pts, 0.002);
    dataMap["Specific Gravity"] = pts;
  }

  // Update existing datasets in-place
  let changed = false;
  for (const ds of chart.data.datasets) {
    const fresh = dataMap[ds.label];
    if (fresh && fresh.length !== ds.data.length) {
      ds.data = fresh;
      changed = true;
    }
  }
  if (changed) chart.update("none");
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
  btn.textContent = feedbackRangeAll ? "Show: Last 24 Hours" : "Show: Entire Brew";
  if (lastFeedbackSession) loadFeedbackChart(lastFeedbackSession, true);
}

async function loadFeedbackChart(sessionId, forceReload) {
  // Only recreate if session changed or forced
  if (!forceReload && lastFeedbackSession === sessionId && feedbackChart) return;
  if (feedbackChart) { feedbackChart.destroy(); feedbackChart = null; }
  lastFeedbackSession = sessionId;
  try {
    let url = `/api/brews/${sessionId}/feedback/log`;
    if (!feedbackRangeAll) {
      const since = (Date.now() / 1000) - 86400;
      url += `?since=${since}`;
    }
    const pts = await (await fetch(url)).json();
    if (!pts.length) return;

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
            title: { display: true, text: feedbackRangeAll ? "Entire Brew" : "Last 24 Hours", color: "#484f58", font: { size: 11 } },
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
  if (textArea && document.activeElement !== textArea) textArea.value = brew.recipe || "";

  // Recipe photo
  const container = document.getElementById("brew-recipe-photo-container");
  if (brew.recipe_photo) {
    container.innerHTML = `<img src="/api/brews/${brew.id}/recipe-photo" style="width:100%;max-height:400px;object-fit:contain;border-radius:6px">`;
  } else {
    container.innerHTML = '<p class="help-text">No recipe photo yet.</p>';
  }
}

function renderBrewPhoto(brew) {
  const wrapper = document.getElementById("brew-photo-wrapper");
  const placeholder = document.getElementById("brew-photo-placeholder");
  if (!wrapper) return;
  if (brew.brew_photo) {
    placeholder.innerHTML = `<img class="brew-hero-photo" src="/api/brews/${brew.id}/brew-photo?t=${Date.now()}">`;
  } else {
    placeholder.innerHTML = '<span class="brew-photo-icon">&#x1F37A;</span>';
  }
}

/* Brew photo upload */
document.getElementById("brew-photo-upload").addEventListener("change", async (e) => {
  if (!currentBrewId || !e.target.files.length) return;
  const formData = new FormData();
  formData.append("photo", e.target.files[0]);
  try {
    await fetch(`/api/brews/${currentBrewId}/brew-photo`, { method: "POST", body: formData });
    showToast("Beer photo uploaded", "success");
    loadBrewDetail(currentBrewId);
  } catch (e) { showToast("Upload failed", "error"); }
});

/* Device hero photo upload */
document.getElementById("device-photo-upload").addEventListener("change", async (e) => {
  if (!currentDeviceId || !e.target.files.length) return;
  const formData = new FormData();
  formData.append("photo", e.target.files[0]);
  try {
    await fetch(`/api/devices/${currentDeviceId}/photo`, { method: "POST", body: formData });
    showToast("Device photo uploaded", "success");
    loadDevice(currentDeviceId);
  } catch (e) { showToast("Upload failed", "error"); }
});

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

  // Try to auto-detect FG from hydrometer data
  let suggestedFg = null;
  try {
    const res = await fetch(`/api/brews/${currentBrewId}/suggest-fg`);
    if (res.ok) {
      const suggestion = await res.json();
      suggestedFg = suggestion.fg;
    }
  } catch (e) { /* ignore — will fall back to blank prompt */ }

  let fgRaw;
  if (suggestedFg != null) {
    fgRaw = prompt(
      `Final Gravity detected from hydrometer: ${suggestedFg.toFixed(4)}\n\nAccept this value, enter a different FG, or leave blank:`,
      suggestedFg.toFixed(4)
    );
  } else {
    fgRaw = prompt("Enter Final Gravity (e.g. 1.010) or leave blank:");
  }
  if (fgRaw === null) return; // user pressed Cancel — abort completion

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

function openAddEventModal() {
  if (!currentBrewId) return;
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `<div class="modal-box" style="max-width:420px">
    <h3 style="margin-bottom:12px">Add Brew Event</h3>
    <div class="form-group" style="margin-bottom:10px">
      <label for="event-type-select">Event Type</label>
      <select id="event-type-select" style="background:var(--bg-input);color:var(--text-primary);border:1px solid var(--border-color);padding:6px 8px;border-radius:4px;width:100%">
        <option value="note">Note</option>
        <option value="dry_hop">Dry Hopped</option>
        <option value="sample">Took Sample</option>
        <option value="clarifier">Added Clarifying Agent</option>
        <option value="ingredient">Added Ingredient</option>
        <option value="yeast">Added Yeast / Pitched</option>
        <option value="cold_crash">Cold Crash</option>
        <option value="transfer">Transferred / Racked</option>
        <option value="bottled">Bottled / Kegged</option>
      </select>
    </div>
    <div class="form-group" style="margin-bottom:10px">
      <label for="event-desc-input">Details</label>
      <input type="text" id="event-desc-input" placeholder="What happened?" style="background:var(--bg-input);color:var(--text-primary);border:1px solid var(--border-color);padding:6px 8px;border-radius:4px;width:100%">
    </div>
    <div class="form-group" style="margin-bottom:16px">
      <label for="event-time-input">When (leave blank for now)</label>
      <input type="datetime-local" id="event-time-input" style="background:var(--bg-input);color:var(--text-primary);border:1px solid var(--border-color);padding:6px 8px;border-radius:4px;width:100%">
    </div>
    <div class="btn-row">
      <button class="btn-save" id="event-modal-save">Log Event</button>
      <button class="btn-stop" id="event-modal-cancel">Cancel</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);

  // Pre-fill time to now
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  document.getElementById("event-time-input").value =
    `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;

  overlay.querySelector("#event-modal-cancel").onclick = () => overlay.remove();
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  overlay.querySelector("#event-modal-save").onclick = async () => {
    const eventType = document.getElementById("event-type-select").value;
    const desc = document.getElementById("event-desc-input").value.trim();
    const timeVal = document.getElementById("event-time-input").value;
    const eventTypeLabels = {
      note: "Note", dry_hop: "Dry hopped", sample: "Took sample",
      clarifier: "Clarifying agent added", ingredient: "Ingredient added",
      yeast: "Yeast pitched", cold_crash: "Cold crash started",
      transfer: "Transferred", bottled: "Bottled/kegged"
    };
    const finalDesc = desc || eventTypeLabels[eventType] || eventType;

    overlay.remove();
    try {
      const body = { event_type: eventType, description: finalDesc };
      const res = await fetch(`/api/brews/${currentBrewId}/event`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!res.ok) throw new Error();

      // If the user set a custom time (different from now), update the event timestamp
      if (timeVal) {
        const customTs = new Date(timeVal).getTime() / 1000;
        const nowTs = Date.now() / 1000;
        if (Math.abs(customTs - nowTs) > 120) {
          // Fetch the latest event and update its timestamp
          const brewRes = await fetch(`/api/brews/${currentBrewId}`);
          const brew = await brewRes.json();
          const events = brew.events || [];
          const lastEvent = events[events.length - 1];
          if (lastEvent && lastEvent.id) {
            await fetch(`/api/brews/${currentBrewId}/event/${lastEvent.id}`, {
              method: "PUT", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ timestamp: customTs })
            });
          }
        }
      }

      showToast("Event logged", "success");
      loadBrewDetail(currentBrewId);
    } catch (e) { showToast("Failed", "error"); }
  };
}

/* --- Temperature Profile --- */
let profileSteps = [];  // Working copy while editing
let _profileBrew = null;  // Cached brew object for re-rendering

function renderProfileDesigner(brew) {
  _profileBrew = brew;
  const profile = brew.temp_profile || {};
  const steps = profile.steps || [];
  profileSteps = JSON.parse(JSON.stringify(steps));  // deep copy for editing

  // Auto-open the accordion if there's an active profile
  const panel = document.getElementById("profile-panel");
  if (panel && steps.length) panel.open = true;

  // Mark the active step
  if (brew.started_at && profileSteps.length) {
    const elapsed = (Date.now() - new Date(brew.started_at).getTime()) / 86400000;
    const sorted = [...profileSteps].sort((a, b) => a.day - b.day);
    let activeIdx = -1;
    for (let i = 0; i < sorted.length; i++) {
      if (elapsed >= sorted[i].day) activeIdx = i;
    }
    profileSteps.forEach(s => s._active = false);
    if (activeIdx >= 0) sorted[activeIdx]._active = true;
  }

  renderProfileSteps();
  renderProfileTimeline(brew);
}

function renderProfileSteps() {
  const el = document.getElementById("profile-steps-list");
  if (!profileSteps.length) {
    el.innerHTML = '<div class="help-text" style="margin:8px 0">No steps defined. Add steps below or click the chart to place points.</div>';
    return;
  }
  const sorted = [...profileSteps].sort((a, b) => a.day - b.day);
  el.innerHTML = `<div class="profile-steps-table">
    ${sorted.map((s, i) => `<div class="profile-step-row${s._active ? ' active' : ''}">
      <span class="profile-step-day">Day ${s.day}${s.day % 1 !== 0 ? '' : '+'}</span>
      <span class="profile-step-temp">${s.temp}°C</span>
      <span class="profile-step-label">${esc(s.label || '')}</span>
      <button class="brew-log-del-btn" onclick="removeProfileStep(${i})">x</button>
    </div>`).join('')}
  </div>`;
}

function _profileLayout(el) {
  const w = el.clientWidth || 500;
  const h = 200;
  const pad = { l: 45, r: 15, t: 15, b: 30 };
  const cw = w - pad.l - pad.r;
  const ch = h - pad.t - pad.b;
  return { w, h, pad, cw, ch };
}

function _profileScales(sorted, layout) {
  const maxDay = Math.max(sorted[sorted.length - 1].day + 3, 14);
  const minTemp = Math.min(...sorted.map(s => s.temp)) - 2;
  const maxTemp = Math.max(...sorted.map(s => s.temp)) + 2;
  const tempRange = maxTemp - minTemp || 1;
  const { pad, cw, ch } = layout;
  const xScale = (d) => pad.l + (d / maxDay) * cw;
  const yScale = (t) => pad.t + ch - ((t - minTemp) / tempRange) * ch;
  const xInv = (px) => ((px - pad.l) / cw) * maxDay;
  const yInv = (py) => minTemp + ((pad.t + ch - py) / ch) * tempRange;
  return { maxDay, minTemp, maxTemp, tempRange, xScale, yScale, xInv, yInv };
}

function _snapVal(v, step) { return Math.round(Math.round(v / step) * step * 10) / 10; }

function renderProfileTimeline(brew) {
  if (brew) _profileBrew = brew;
  const el = document.getElementById("profile-timeline");
  if (!profileSteps.length) {
    // Show empty chart area with click hint
    const layout = _profileLayout(el);
    el.innerHTML = `<svg width="100%" height="${layout.h}" viewBox="0 0 ${layout.w} ${layout.h}" preserveAspectRatio="none">
      <rect class="profile-bg-hit" x="${layout.pad.l}" y="${layout.pad.t}" width="${layout.cw}" height="${layout.ch}" fill="transparent"/>
      <text x="${layout.w / 2}" y="${layout.h / 2}" fill="#484f58" font-size="11" text-anchor="middle">Click to add temperature steps</text>
    </svg>`;
    _attachProfileClickHandler(el, brew);
    return;
  }

  const sorted = [...profileSteps].sort((a, b) => a.day - b.day);
  const layout = _profileLayout(el);
  const { w, h, pad } = layout;
  const scales = _profileScales(sorted, layout);
  const { maxDay, minTemp, tempRange, xScale, yScale } = scales;

  // Find current day
  let currentDay = 0;
  if (brew && brew.started_at) {
    currentDay = (Date.now() - new Date(brew.started_at).getTime()) / 86400000;
  }

  // Build stepped path
  let path = '';
  for (let i = 0; i < sorted.length; i++) {
    const x = xScale(sorted[i].day);
    const y = yScale(sorted[i].temp);
    if (i === 0) path += `M${x},${y}`;
    else path += `L${x},${y}`;
    const nextDay = i < sorted.length - 1 ? sorted[i + 1].day : maxDay;
    path += `L${xScale(nextDay)},${y}`;
  }

  // Fill path
  let fillPath = path + `L${xScale(maxDay)},${yScale(minTemp)}L${xScale(0)},${yScale(minTemp)}Z`;

  // Current day marker
  const nowX = xScale(Math.min(currentDay, maxDay));

  // Day gridlines
  let gridLines = '';
  for (let d = 0; d <= maxDay; d += Math.ceil(maxDay / 7)) {
    const x = xScale(d);
    gridLines += `<line x1="${x}" y1="${pad.t}" x2="${x}" y2="${h - pad.b}" stroke="#21262d"/>`;
    gridLines += `<text x="${x}" y="${h - 5}" fill="#484f58" font-size="10" text-anchor="middle">Day ${d}</text>`;
  }

  // Temp labels
  let tempLabels = '';
  const tempSteps = Math.max(2, Math.ceil(tempRange / 5));
  for (let i = 0; i <= tempSteps; i++) {
    const t = minTemp + (i / tempSteps) * tempRange;
    const y = yScale(t);
    tempLabels += `<text x="${pad.l - 5}" y="${y + 3}" fill="#484f58" font-size="10" text-anchor="end">${t.toFixed(0)}°</text>`;
    tempLabels += `<line x1="${pad.l}" y1="${y}" x2="${w - pad.r}" y2="${y}" stroke="#21262d" stroke-dasharray="2,2"/>`;
  }

  // Step labels on the chart
  let stepLabels = '';
  for (let i = 0; i < sorted.length; i++) {
    const x = xScale(sorted[i].day) + 4;
    const y = yScale(sorted[i].temp) - 6;
    if (sorted[i].label) {
      stepLabels += `<text x="${x}" y="${y}" fill="#c9d1d9" font-size="10" font-weight="600">${esc(sorted[i].label)}</text>`;
    }
  }

  el.innerHTML = `<svg width="100%" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <rect class="profile-bg-hit" x="${pad.l}" y="${pad.t}" width="${layout.cw}" height="${layout.ch}" fill="transparent"/>
    ${gridLines}${tempLabels}
    <path d="${fillPath}" fill="rgba(46,160,67,0.1)" stroke="none"/>
    <path d="${path}" fill="none" stroke="#2ea043" stroke-width="2"/>
    ${stepLabels}
    ${currentDay > 0 ? `<line x1="${nowX}" y1="${pad.t}" x2="${nowX}" y2="${h - pad.b}" stroke="#f0883e" stroke-width="1.5" stroke-dasharray="4,3"/>
    <text x="${nowX}" y="${pad.t - 2}" fill="#f0883e" font-size="9" text-anchor="middle">now</text>` : ''}
    ${sorted.map((s, i) => `<circle class="profile-step-dot" data-index="${i}" cx="${xScale(s.day)}" cy="${yScale(s.temp)}" r="6" fill="#2ea043" stroke="#0d1117" stroke-width="1.5"/>`).join('')}
  </svg>`;

  // Attach interaction handlers
  _attachProfileClickHandler(el, brew);
  _attachProfileDragHandlers(el, sorted, layout, scales, brew);
}

function _attachProfileClickHandler(el, brew) {
  const svg = el.querySelector('svg');
  if (!svg) return;
  const bgRect = svg.querySelector('.profile-bg-hit');
  if (!bgRect) return;

  bgRect.addEventListener('click', function(e) {
    // Don't trigger if we just finished a drag
    if (_profileDragOccurred) { _profileDragOccurred = false; return; }

    const svgEl = el.querySelector('svg');
    const pt = svgEl.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const svgPt = pt.matrixTransform(svgEl.getScreenCTM().inverse());

    // If no steps yet, use reasonable defaults for scale inversion
    if (!profileSteps.length) {
      const layout = _profileLayout(el);
      const defaultMaxDay = 14;
      const defaultMinTemp = 15;
      const defaultMaxTemp = 25;
      const defaultRange = defaultMaxTemp - defaultMinTemp;
      const rawDay = ((svgPt.x - layout.pad.l) / layout.cw) * defaultMaxDay;
      const rawTemp = defaultMinTemp + ((layout.pad.t + layout.ch - svgPt.y) / layout.ch) * defaultRange;
      const day = Math.max(0, _snapVal(rawDay, 0.5));
      const temp = _snapVal(rawTemp, 0.5);
      profileSteps.push({ day, temp, label: '' });
      profileSteps.sort((a, b) => a.day - b.day);
      renderProfileSteps();
      renderProfileTimeline(_profileBrew);
      showToast(`Added step: Day ${day}, ${temp}°C`, 'success');
      return;
    }

    const sorted = [...profileSteps].sort((a, b) => a.day - b.day);
    const layout = _profileLayout(el);
    const scales = _profileScales(sorted, layout);

    const rawDay = scales.xInv(svgPt.x);
    const rawTemp = scales.yInv(svgPt.y);
    const day = Math.max(0, _snapVal(rawDay, 0.5));
    const temp = _snapVal(rawTemp, 0.5);

    // Check we're within chart bounds
    if (svgPt.x < layout.pad.l || svgPt.x > layout.pad.l + layout.cw) return;
    if (svgPt.y < layout.pad.t || svgPt.y > layout.pad.t + layout.ch) return;

    profileSteps.push({ day, temp, label: '' });
    profileSteps.sort((a, b) => a.day - b.day);
    renderProfileSteps();
    renderProfileTimeline(_profileBrew);
    showToast(`Added step: Day ${day}, ${temp}°C`, 'success');
  });
}

let _profileDragOccurred = false;

function _attachProfileDragHandlers(el, sorted, layout, scales, brew) {
  const svg = el.querySelector('svg');
  if (!svg) return;
  const dots = svg.querySelectorAll('.profile-step-dot');
  const { pad } = layout;

  // Build a map from sorted index to profileSteps index for reliable reference
  const used = new Set();
  const sortedToOrigIdx = sorted.map(s => {
    const idx = profileSteps.findIndex((p, i) => {
      if (used.has(i)) return false;
      return p.day === s.day && p.temp === s.temp;
    });
    if (idx >= 0) used.add(idx);
    return idx;
  });

  dots.forEach(dot => {
    let dragging = false;
    let dragLabel = null;
    let origIdx = -1;

    const onPointerDown = (e) => {
      e.preventDefault();
      e.stopPropagation();
      dragging = true;
      _profileDragOccurred = false;
      const sortIdx = parseInt(dot.getAttribute('data-index'));
      origIdx = sortedToOrigIdx[sortIdx];

      dot.style.cursor = 'grabbing';
      dot.setAttribute('r', '8');

      // Create floating label
      dragLabel = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      dragLabel.setAttribute('class', 'profile-drag-label');
      dragLabel.setAttribute('text-anchor', 'middle');
      svg.appendChild(dragLabel);

      dot.setPointerCapture(e.pointerId);
      dot.addEventListener('pointermove', onPointerMove);
      dot.addEventListener('pointerup', onPointerUp);
    };

    const onPointerMove = (e) => {
      if (!dragging) return;
      _profileDragOccurred = true;

      const pt = svg.createSVGPoint();
      pt.x = e.clientX;
      pt.y = e.clientY;
      const svgPt = pt.matrixTransform(svg.getScreenCTM().inverse());

      // Clamp to chart area
      const cx = Math.max(pad.l, Math.min(pad.l + layout.cw, svgPt.x));
      const cy = Math.max(pad.t, Math.min(pad.t + layout.ch, svgPt.y));

      dot.setAttribute('cx', cx);
      dot.setAttribute('cy', cy);

      // Show snapped values
      const rawDay = scales.xInv(cx);
      const rawTemp = scales.yInv(cy);
      const snapDay = Math.max(0, _snapVal(rawDay, 0.5));
      const snapTemp = _snapVal(rawTemp, 0.5);

      if (dragLabel) {
        dragLabel.setAttribute('x', cx);
        dragLabel.setAttribute('y', cy - 12);
        dragLabel.textContent = `Day ${snapDay}, ${snapTemp}°C`;
      }
    };

    const onPointerUp = (e) => {
      if (!dragging) return;
      dragging = false;
      dot.releasePointerCapture(e.pointerId);
      dot.removeEventListener('pointermove', onPointerMove);
      dot.removeEventListener('pointerup', onPointerUp);

      if (dragLabel) { dragLabel.remove(); dragLabel = null; }
      dot.style.cursor = '';
      dot.setAttribute('r', '6');

      if (!_profileDragOccurred) return;  // Was just a click, not a drag

      // Compute final snapped position
      const pt = svg.createSVGPoint();
      pt.x = e.clientX;
      pt.y = e.clientY;
      const svgPt = pt.matrixTransform(svg.getScreenCTM().inverse());
      const cx = Math.max(pad.l, Math.min(pad.l + layout.cw, svgPt.x));
      const cy = Math.max(pad.t, Math.min(pad.t + layout.ch, svgPt.y));

      const newDay = Math.max(0, _snapVal(scales.xInv(cx), 0.5));
      const newTemp = _snapVal(scales.yInv(cy), 0.5);

      if (origIdx >= 0 && origIdx < profileSteps.length) {
        profileSteps[origIdx].day = newDay;
        profileSteps[origIdx].temp = newTemp;
      }
      profileSteps.sort((a, b) => a.day - b.day);
      renderProfileSteps();
      renderProfileTimeline(_profileBrew);
    };

    dot.addEventListener('pointerdown', onPointerDown);

    // Double-click to delete
    dot.addEventListener('dblclick', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const sortIdx = parseInt(dot.getAttribute('data-index'));
      const origI = sortedToOrigIdx[sortIdx];
      const step = sorted[sortIdx];
      if (origI >= 0) profileSteps.splice(origI, 1);
      renderProfileSteps();
      renderProfileTimeline(_profileBrew);
      showToast(`Removed step: Day ${step.day}, ${step.temp}°C`, 'success');
    });
  });
}

function addProfileStep() {
  const day = parseFloat(document.getElementById("profile-step-day").value);
  const temp = parseFloat(document.getElementById("profile-step-temp").value);
  const label = document.getElementById("profile-step-label").value.trim();
  if (isNaN(day) || isNaN(temp)) { showToast("Enter a day and temperature", "error"); return; }
  profileSteps.push({ day, temp, label });
  profileSteps.sort((a, b) => a.day - b.day);
  renderProfileSteps();
  renderProfileTimeline(_profileBrew);
  document.getElementById("profile-step-day").value = "";
  document.getElementById("profile-step-temp").value = "";
  document.getElementById("profile-step-label").value = "";
}

function removeProfileStep(index) {
  const sorted = [...profileSteps].sort((a, b) => a.day - b.day);
  const step = sorted[index];
  profileSteps = profileSteps.filter(s => s !== step);
  renderProfileSteps();
  renderProfileTimeline(_profileBrew);
}

async function saveProfile() {
  if (!currentBrewId) return;
  const profile = profileSteps.length ? { steps: profileSteps } : null;
  try {
    await fetch(`/api/brews/${currentBrewId}/update`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ temp_profile: profile })
    });
    showToast(profile ? "Profile saved" : "Profile cleared", "success");
    loadBrewDetail(currentBrewId);
  } catch (e) { showToast("Failed", "error"); }
}

async function clearProfile() {
  if (!confirm("Clear the temperature profile?")) return;
  profileSteps = [];
  renderProfileSteps();
  document.getElementById("profile-timeline").innerHTML = '';
  await saveProfile();
}

/* --- Manual Reading --- */
async function submitManualReading() {
  if (!currentBrewId) return;
  const sgVal = document.getElementById("manual-sg").value;
  const tempVal = document.getElementById("manual-temp").value;
  const body = {};
  if (sgVal) body.sg = parseFloat(sgVal);
  if (tempVal) body.temperature = parseFloat(tempVal);
  if (!body.sg && !body.temperature) { showToast("Enter at least one reading", "error"); return; }
  try {
    await fetch(`/api/brews/${currentBrewId}/manual_reading`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    showToast("Reading logged", "success");
    document.getElementById("manual-sg").value = "";
    document.getElementById("manual-temp").value = "";
    loadBrewDetail(currentBrewId);
  } catch (e) { showToast("Failed", "error"); }
}

/* --- Cold Crash --- */
async function coldCrash() {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `<div class="modal-box" style="max-width:420px">
    <h3 style="margin-bottom:8px">Cold Crash</h3>
    <p style="color:#c9d1d9;margin-bottom:12px">This will set your fridge target to <strong>0.5°C</strong> to crash-cool your beer. The controller will start cooling immediately.</p>
    <p style="color:#8b949e;margin-bottom:16px">If smart feedback is active, it will be stopped — cold crash takes direct control of the fridge.</p>
    <div class="btn-row">
      <button class="btn-stop" id="cold-crash-confirm">Start Cold Crash</button>
      <button class="btn-save" id="cold-crash-cancel">Cancel</button>
    </div>
  </div>`;
  document.body.appendChild(overlay);

  overlay.querySelector("#cold-crash-cancel").onclick = () => overlay.remove();
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  overlay.querySelector("#cold-crash-confirm").onclick = async () => {
    overlay.remove();
    try {
      // Stop feedback if active
      await fetch(`/api/brews/${currentBrewId}/feedback/stop`, { method: "POST" }).catch(() => {});
      // Set target to 0.5°C
      await fetch("/api/control/temperature", { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ target: 0.5 }) });
      // Log the event
      await fetch(`/api/brews/${currentBrewId}/event`, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event_type: "cold_crash", description: "Cold crash started — fridge target set to 0.5°C" }) });
      showToast("Cold crash started", "success");
      loadBrewDetail(currentBrewId);
    } catch (e) { showToast("Failed to start cold crash", "error"); }
  };
}

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
let legendaryBrewsCache = [];

async function loadLegendaryBrews() {
  try {
    const data = await (await fetch("/api/brew/history")).json();
    legendaryBrewsCache = data.filter(b => b.status !== "active");
    filterLegendaryBrews();
  } catch (e) {}
}

function filterLegendaryBrews() {
  const query = (document.getElementById("legendary-search").value || "").toLowerCase();
  const sort = document.getElementById("legendary-sort").value;
  const container = document.getElementById("legendary-brew-list");

  let brews = legendaryBrewsCache.slice();

  // Filter
  if (query) {
    brews = brews.filter(b =>
      (b.name || "").toLowerCase().includes(query) ||
      (b.tasting_notes || "").toLowerCase().includes(query) ||
      (b.recipe || "").toLowerCase().includes(query) ||
      (b.brewing_notes || "").toLowerCase().includes(query)
    );
  }

  // Sort
  if (sort === "newest") brews.sort((a, b) => (b.started_at || "").localeCompare(a.started_at || ""));
  else if (sort === "oldest") brews.sort((a, b) => (a.started_at || "").localeCompare(b.started_at || ""));
  else if (sort === "rating") brews.sort((a, b) => (b.rating || 0) - (a.rating || 0));
  else if (sort === "name") brews.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  else if (sort === "abv") brews.sort((a, b) => {
    const abvA = (a.og && a.fg) ? (a.og - a.fg) * 131.25 : 0;
    const abvB = (b.og && b.fg) ? (b.og - b.fg) * 131.25 : 0;
    return abvB - abvA;
  });

  if (!brews.length) {
    container.innerHTML = '<div class="panel"><p class="help-text">' +
      (query ? 'No brews match your search.' : 'No legendary brews yet. Complete a brew session to start your hall of fame.') +
      '</p></div>';
    return;
  }

  container.innerHTML = brews.map(b => {
    const abvStr = (b.og && b.fg) ? ((b.og - b.fg) * 131.25).toFixed(1) + "%" : "--";
    const dateStr = b.started_at ? new Date(b.started_at).toLocaleDateString() : "--";
    const rating = b.rating || 0;
    const stars = renderStars(rating);

    // Brew photo takes priority, then recipe photo, then big text fallback
    let photoSection;
    if (b.brew_photo) {
      photoSection = `<div class="legendary-tile-photo"><img src="/api/brews/${b.id}/brew-photo" alt="${esc(b.name)}"></div>`;
    } else if (b.recipe_photo) {
      photoSection = `<div class="legendary-tile-photo"><img src="/api/brews/${b.id}/recipe-photo" alt="${esc(b.name)}"></div>`;
    } else {
      photoSection = `<div class="legendary-tile-nophoto"><span class="legendary-tile-bigname">${esc(b.name)}</span></div>`;
    }

    return `
      <div class="legendary-tile" onclick="showPage('brew-detail','${b.id}')">
        ${photoSection}
        <div class="legendary-tile-body">
          <div class="legendary-tile-header">
            <h3>${esc(b.name)}</h3>
            <div class="legendary-stars" data-brew-id="${b.id}" onclick="event.stopPropagation()">${stars}</div>
          </div>
          <div class="legendary-tile-meta">
            <span>${dateStr}</span>
            <span>ABV: ${abvStr}</span>
            <span>OG: ${fmtG(b.og)}</span>
            <span>FG: ${fmtG(b.fg)}</span>
          </div>
          ${b.tasting_notes ? `<p class="legendary-tile-notes">${esc(b.tasting_notes)}</p>` : ''}
          ${b.batch_number ? `<span class="badge-sm" style="background:rgba(230,168,23,0.15);color:#e6a817;margin-bottom:6px;display:inline-block">Batch #${b.batch_number}</span>` : ''}
          <div class="card-actions" onclick="event.stopPropagation()">
            <button onclick="editLegendaryBrew('${b.id}')">Edit</button>
            <button onclick="showPage('brew-detail','${b.id}')">Details</button>
            <button onclick="openBrewAgainModal('${b.id}')" class="btn-brew-again">Brew Again</button>
          </div>
        </div>
      </div>`;
  }).join("");
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
    // Re-render stars immediately for visual feedback
    el.parentElement.innerHTML = renderStars(rating);
    el.parentElement.setAttribute("data-brew-id", brewId);
    // Refresh legendary list if visible
    if (currentPage === "legendary") loadLegendaryBrews();
  } catch (e) {}
}

async function editLegendaryBrew(brewId) {
  try {
    const brew = await (await fetch(`/api/brew/history`)).json();
    const b = brew.find(x => x.id === brewId);
    if (!b) return;
    document.getElementById("legendary-edit-id").value = brewId;
    document.getElementById("legendary-edit-og").value = b.og || "";
    document.getElementById("legendary-edit-fg").value = b.fg || "";
    document.getElementById("legendary-edit-tasting").value = b.tasting_notes || "";
    document.getElementById("legendary-edit-recipe").value = b.recipe || "";
    document.getElementById("legendary-edit-brewing").value = b.brewing_notes || "";
    document.getElementById("legendary-edit-modal").style.display = "";
  } catch (e) {}
}

async function suggestLegendaryFG() {
  const brewId = document.getElementById("legendary-edit-id").value;
  if (!brewId) return;
  try {
    const res = await fetch(`/api/brews/${brewId}/suggest-fg`);
    const data = await res.json();
    if (data.fg) {
      document.getElementById("legendary-edit-fg").value = data.fg;
      showToast("FG suggested: " + fmtG(data.fg), "success");
    } else {
      showToast("No hydrometer data available to suggest FG", "warning");
    }
  } catch (e) { showToast("Failed to suggest FG", "error"); }
}

function closeLegendaryEdit() {
  document.getElementById("legendary-edit-modal").style.display = "none";
}

async function saveLegendaryEdit() {
  const brewId = document.getElementById("legendary-edit-id").value;
  const recipePhotoInput = document.getElementById("legendary-edit-photo");
  const brewPhotoInput = document.getElementById("legendary-edit-brew-photo");
  const ogVal = document.getElementById("legendary-edit-og").value;
  const fgVal = document.getElementById("legendary-edit-fg").value;
  const updates = {
    tasting_notes: document.getElementById("legendary-edit-tasting").value,
    recipe: document.getElementById("legendary-edit-recipe").value,
    brewing_notes: document.getElementById("legendary-edit-brewing").value,
  };
  if (ogVal) updates.og = parseFloat(ogVal);
  if (fgVal) updates.fg = parseFloat(fgVal);
  try {
    await fetch(`/api/brews/${brewId}/notes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(updates)
    });
    // Upload brew photo if selected
    if (brewPhotoInput && brewPhotoInput.files.length > 0) {
      const formData = new FormData();
      formData.append("photo", brewPhotoInput.files[0]);
      await fetch(`/api/brews/${brewId}/brew-photo`, { method: "POST", body: formData });
    }
    // Upload recipe photo if selected
    if (recipePhotoInput && recipePhotoInput.files.length > 0) {
      const formData = new FormData();
      formData.append("photo", recipePhotoInput.files[0]);
      await fetch(`/api/brews/${brewId}/recipe-photo`, { method: "POST", body: formData });
    }
    closeLegendaryEdit();
    loadLegendaryBrews();
    // Refresh brew detail page if viewing this brew
    if (currentPage === "brew-detail" && currentBrewId === brewId) loadBrewDetail(brewId);
    showToast("Brew updated", "success");
  } catch (e) { showToast("Failed to save", "error"); }
}

/* --- Brew Again --- */
let brewAgainData = null;  // Stores the clone data while modal is open

async function openBrewAgainModal(brewId) {
  try {
    const res = await fetch(`/api/brews/${brewId}/brew-again`, { method: "POST" });
    if (!res.ok) { showToast("Failed to prepare re-brew", "error"); return; }
    brewAgainData = await res.json();

    // Populate device selects
    const tiltSel = document.getElementById("brew-again-tilt");
    const ctrlSel = document.getElementById("brew-again-controller");
    tiltSel.innerHTML = '<option value="">None</option>';
    ctrlSel.innerHTML = '<option value="">None</option>';
    try {
      const devices = await (await fetch("/api/devices")).json();
      Object.keys(devices).forEach(id => {
        const dev = devices[id];
        const opt = document.createElement("option");
        opt.value = id;
        opt.textContent = dev._nickname || dev.name || id.substring(0, 8);
        if (dev.deviceType === "TILT") tiltSel.appendChild(opt);
        else ctrlSel.appendChild(opt);
      });
    } catch (e) {}

    // Fill form fields
    document.getElementById("brew-again-parent-id").value = brewAgainData.parent_brew_id || "";
    document.getElementById("brew-again-batch-number").value = brewAgainData.batch_number || "";
    document.getElementById("brew-again-name").value = brewAgainData.name || "";
    document.getElementById("brew-again-og").value = brewAgainData.og || "";
    document.getElementById("brew-again-target-temp").value = brewAgainData.target_beer_temp || "";
    document.getElementById("brew-again-notes").value = brewAgainData.notes || "";
    document.getElementById("brew-again-recipe").value = brewAgainData.recipe || "";
    document.getElementById("brew-again-temp-source").value = brewAgainData.temp_source || "hydrometer";

    // Show temp profile preview if it exists
    const profileSection = document.getElementById("brew-again-profile-section");
    const profilePreview = document.getElementById("brew-again-profile-preview");
    if (brewAgainData.temp_profile && brewAgainData.temp_profile.steps && brewAgainData.temp_profile.steps.length) {
      const steps = brewAgainData.temp_profile.steps.sort((a, b) => a.day - b.day);
      profilePreview.innerHTML = steps.map(s =>
        `Day ${s.day}+: ${s.temp}&deg;C${s.label ? ' (' + esc(s.label) + ')' : ''}`
      ).join('<br>');
      profileSection.style.display = "";
    } else {
      profileSection.style.display = "none";
    }

    document.getElementById("brew-again-modal").style.display = "";
  } catch (e) { showToast("Failed to prepare re-brew", "error"); }
}

function closeBrewAgainModal() {
  document.getElementById("brew-again-modal").style.display = "none";
  brewAgainData = null;
}

// Close modal on overlay click
document.getElementById("brew-again-modal").addEventListener("click", (e) => {
  if (e.target === e.currentTarget) closeBrewAgainModal();
});

async function confirmBrewAgain() {
  if (!brewAgainData) return;
  const data = {
    name: document.getElementById("brew-again-name").value || "Untitled Brew",
    og: parseFloat(document.getElementById("brew-again-og").value) || null,
    target_beer_temp: parseFloat(document.getElementById("brew-again-target-temp").value) || null,
    tilt_device_id: document.getElementById("brew-again-tilt").value || null,
    controller_device_id: document.getElementById("brew-again-controller").value || null,
    temp_source: document.getElementById("brew-again-temp-source").value,
    notes: document.getElementById("brew-again-notes").value,
    recipe: document.getElementById("brew-again-recipe").value,
    parent_brew_id: document.getElementById("brew-again-parent-id").value || null,
    batch_number: parseInt(document.getElementById("brew-again-batch-number").value) || null,
    temp_profile: brewAgainData.temp_profile || null,
  };
  try {
    const res = await fetch("/api/brews/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data)
    });
    if (res.ok) {
      const session = await res.json();
      closeBrewAgainModal();
      showToast("Brew started!", "success");
      loadBrewNav();
      showPage("brew-detail", session.id);
    } else {
      const r = await res.json();
      showToast(r.error || "Failed to start brew", "error");
    }
  } catch (e) { showToast("Failed to start brew", "error"); }
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


/* --- Auth & Init --- */

function showLoginScreen() {
  const screen = document.getElementById("login-screen");
  if (!screen) return;
  screen.style.display = "";
  fetch("/api/auth/status").then(r => r.json()).then(auth => {
    if (auth.guest_mode === "button") {
      document.getElementById("guest-button-row").style.display = "";
    } else {
      document.getElementById("guest-button-row").style.display = "none";
    }
  }).catch(() => {});
}

function hideLoginScreen() {
  const screen = document.getElementById("login-screen");
  if (screen) screen.style.display = "none";
}

function applyRoleUI() {
  const isGuest = currentRole === "guest";

  // Hide write-action elements for guests
  document.querySelectorAll(".brewmaster-only").forEach(el => {
    el.style.display = isGuest ? "none" : "";
  });

  // Hide config/tiltpi nav for guests
  document.querySelectorAll('[data-page="config"], [data-page="tiltpi"]').forEach(el => {
    if (isGuest) el.style.display = "none";
  });

  // Show auth config panel for brewmaster
  const authPanel = document.getElementById("auth-config-panel");
  if (authPanel) authPanel.style.display = (currentRole === "brewmaster") ? "" : "none";

  // Sidebar user info
  const userInfo = document.getElementById("auth-user-info");
  if (userInfo) {
    userInfo.style.display = authEnabled ? "" : "none";
    const roleDisplay = document.getElementById("auth-role-display");
    if (roleDisplay) roleDisplay.textContent = (currentUsername || currentRole || "").replace(/^./, c => c.toUpperCase());
  }
}

async function doAppInit() {
  loadConfig();
  checkStatus();
  initConsole();
  loadDevices();
  loadBrewNav();
  applyRoleUI();
  loadAuthConfig();

  fetch("/api/version").then(r => r.json()).then(d => {
    const el = document.getElementById("app-version");
    if (el) el.textContent = d.version;
  }).catch(() => {});

  // Navigate to latest active brew on startup (or stay on config if none)
  try {
    const brews = await (await fetch("/api/brews")).json();
    if (brews.length) {
      const latest = brews.sort((a, b) => (b.started_at || "").localeCompare(a.started_at || ""))[0];
      showPage("brew-detail", latest.id);
    }
  } catch (e) {}
}

// Login button
document.getElementById("btn-login").addEventListener("click", async () => {
  const username = document.getElementById("login-username").value;
  const password = document.getElementById("login-password").value;
  const errEl = document.getElementById("login-error");
  try {
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({username, password}),
    });
    if (res.ok) {
      const data = await res.json();
      currentRole = data.role;
      currentUsername = data.username;
      hideLoginScreen();
      doAppInit();
    } else {
      errEl.textContent = "Invalid credentials";
      errEl.style.display = "";
    }
  } catch (e) {
    errEl.textContent = "Connection error";
    errEl.style.display = "";
  }
});

// Enter key on password field
document.getElementById("login-password").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("btn-login").click();
});

// Guest button
document.getElementById("btn-guest-login").addEventListener("click", async () => {
  try {
    const res = await fetch("/api/auth/guest", {method: "POST"});
    if (res.ok) {
      currentRole = "guest";
      currentUsername = "Guest";
      hideLoginScreen();
      doAppInit();
    }
  } catch (e) {}
});

// Logout
document.getElementById("btn-logout").addEventListener("click", async (e) => {
  e.preventDefault();
  await fetch("/api/auth/logout", {method: "POST"});
  currentRole = null;
  currentUsername = null;
  showLoginScreen();
});

// Auth config panel logic
function loadAuthConfig() {
  fetch("/api/auth/status").then(r => r.json()).then(auth => {
    const chk = document.getElementById("auth_enabled");
    if (chk) chk.checked = auth.auth_enabled;
    const fields = document.getElementById("auth-fields");
    if (fields) fields.style.display = auth.auth_enabled ? "" : "none";
    const gm = document.getElementById("guest_mode");
    if (gm) gm.value = auth.guest_mode || "button";
    toggleGuestFields();
  }).catch(() => {});

  // Load usernames from config (only visible to brewmaster)
  if (currentRole === "brewmaster") {
    fetch("/api/config").then(r => r.json()).then(cfg => {
      const bm = document.getElementById("bm_username");
      if (bm && cfg.brewmaster_username) bm.value = cfg.brewmaster_username;
      const gu = document.getElementById("guest_username_cfg");
      if (gu && cfg.guest_username) gu.value = cfg.guest_username;
    }).catch(() => {});
  }
}

function toggleGuestFields() {
  const mode = document.getElementById("guest_mode");
  const fields = document.getElementById("guest-password-fields");
  if (mode && fields) fields.style.display = mode.value === "password" ? "" : "none";
}

document.getElementById("auth_enabled")?.addEventListener("change", function() {
  const fields = document.getElementById("auth-fields");
  if (fields) fields.style.display = this.checked ? "" : "none";
});
document.getElementById("guest_mode")?.addEventListener("change", toggleGuestFields);

document.getElementById("btn-save-auth")?.addEventListener("click", async () => {
  const data = {
    auth_enabled: document.getElementById("auth_enabled").checked,
    brewmaster_username: document.getElementById("bm_username").value,
    brewmaster_password: document.getElementById("bm_password").value,
    guest_mode: document.getElementById("guest_mode").value,
    guest_username: document.getElementById("guest_username_cfg").value,
    guest_password: document.getElementById("guest_password_cfg").value,
  };
  try {
    const res = await fetch("/api/auth/settings", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify(data),
    });
    const result = await res.json();
    if (res.ok) {
      showToast("Auth settings saved");
      authEnabled = data.auth_enabled;
      // Clear password fields after save
      document.getElementById("bm_password").value = "";
      document.getElementById("guest_password_cfg").value = "";
      applyRoleUI();
    } else {
      showToast(result.error || "Save failed", "error");
    }
  } catch (e) {
    showToast("Save error", "error");
  }
});

// Intercept 401s globally (session expired)
const _origFetch = window.fetch;
window.fetch = async function(...args) {
  const res = await _origFetch.apply(this, args);
  if (res.status === 401 && authEnabled && !String(args[0]).includes("/api/auth/")) {
    currentRole = null;
    showLoginScreen();
  }
  return res;
};

// Boot: check auth status, then init or show login
(async () => {
  try {
    const res = await _origFetch("/api/auth/status");
    const auth = await res.json();
    authEnabled = auth.auth_enabled;
    currentRole = auth.auth_enabled ? auth.role : "brewmaster";
    currentUsername = auth.username;
  } catch (e) {
    authEnabled = false;
    currentRole = "brewmaster";
  }

  if (authEnabled && !currentRole) {
    showLoginScreen();
  } else {
    doAppInit();
  }
})();

/* ========== Coopers DIY Recipes ========== */
let recipesCache = null;
let recipesLoaded = false;

const COOPERS_STORE = "https://www.diybeer.com/au/";
const DIFFICULTY_ORDER = { "Easy": 0, "Intermediate": 1, "Advanced": 2, "Expert": 3 };

async function loadRecipesPage() {
  if (!recipesCache) {
    try {
      recipesCache = await (await fetch("/static/coopers_recipes.json")).json();
      recipesLoaded = true;
      populateRecipeFilters();
    } catch (e) { return; }
  }
  filterAndRenderRecipes();
}

function populateRecipeFilters() {
  const types = [...new Set(recipesCache.map(r => r.type).filter(Boolean))].sort();
  const sel = document.getElementById("recipe-type-filter");
  types.forEach(t => {
    const opt = document.createElement("option");
    opt.value = t; opt.textContent = t;
    sel.appendChild(opt);
  });

  // Wire up filter events
  document.getElementById("recipe-search").addEventListener("input", filterAndRenderRecipes);
  document.getElementById("recipe-type-filter").addEventListener("change", filterAndRenderRecipes);
  document.getElementById("recipe-difficulty-filter").addEventListener("change", filterAndRenderRecipes);
  document.getElementById("recipe-sort").addEventListener("change", filterAndRenderRecipes);
}

function filterAndRenderRecipes() {
  if (!recipesCache) return;
  const query = document.getElementById("recipe-search").value.toLowerCase().trim();
  const typeFilter = document.getElementById("recipe-type-filter").value;
  const diffFilter = document.getElementById("recipe-difficulty-filter").value;
  const sortBy = document.getElementById("recipe-sort").value;

  let filtered = recipesCache.filter(r => {
    if (typeFilter && r.type !== typeFilter) return false;
    if (diffFilter && r.difficulty !== diffFilter) return false;
    if (query) {
      const searchable = [r.name, r.type, r.difficulty, ...r.cans, ...r.yeasts,
        ...r.hops.map(h => h.name), ...r.grains.map(g => g.name),
        ...r.fermentables.map(f => f.name), r.other, r.variations].join(" ").toLowerCase();
      if (!searchable.includes(query)) return false;
    }
    return true;
  });

  // Sort
  filtered.sort((a, b) => {
    if (sortBy === "name") return (a.name || "").localeCompare(b.name || "");
    if (sortBy === "abv") return (b.abv || 0) - (a.abv || 0);
    if (sortBy === "ibu") return (b.ibu || 0) - (a.ibu || 0);
    if (sortBy === "ebc") return (a.ebc || 0) - (b.ebc || 0);
    if (sortBy === "type") return (a.type || "").localeCompare(b.type || "");
    if (sortBy === "difficulty") return (DIFFICULTY_ORDER[a.difficulty] || 0) - (DIFFICULTY_ORDER[b.difficulty] || 0);
    return 0;
  });

  document.getElementById("recipe-count").textContent = filtered.length + " of " + recipesCache.length + " recipes";

  const grid = document.getElementById("recipe-grid");
  if (!filtered.length) {
    grid.innerHTML = '<p class="help-text" style="padding:20px;text-align:center">No recipes match your filters.</p>';
    return;
  }

  grid.innerHTML = filtered.map((r, idx) => {
    const diffClass = (r.difficulty || "").toLowerCase().replace(/\s/g, "");
    const abvStr = r.abv != null ? r.abv.toFixed(1) + "%" : "--";
    const ibuStr = r.ibu != null ? Math.round(r.ibu) : "--";
    const ebcStr = r.ebc != null ? Math.round(r.ebc) : "--";
    const ebcColor = ebcToColor(r.ebc);
    const ingredients = [...r.cans, ...r.fermentables.map(f => f.name), ...r.hops.map(h => h.name)].filter(Boolean).slice(0, 4);
    return `
      <div class="recipe-card" onclick="openRecipeDetail(${recipesCache.indexOf(r)})">
        <div class="recipe-card-header">
          <span class="recipe-card-name">${esc(r.name)}</span>
          <span class="recipe-diff-badge ${diffClass}">${esc(r.difficulty || "")}</span>
        </div>
        <div class="recipe-card-type">${esc(r.type || "")}</div>
        <div class="recipe-card-stats">
          <span title="ABV"><strong>${abvStr}</strong> ABV</span>
          <span title="IBU (Bitterness)"><strong>${ibuStr}</strong> IBU</span>
          <span title="EBC (Colour)"><span class="ebc-dot" style="background:${ebcColor}"></span><strong>${ebcStr}</strong> EBC</span>
          ${r.volume ? `<span title="Volume"><strong>${r.volume}L</strong></span>` : ""}
        </div>
        <div class="recipe-card-ingredients">${ingredients.map(i => `<span class="recipe-ing-tag">${esc(i)}</span>`).join("")}</div>
      </div>`;
  }).join("");
}

function ebcToColor(ebc) {
  if (ebc == null) return "#8b949e";
  if (ebc <= 4) return "#f8e8a0";
  if (ebc <= 8) return "#f0d060";
  if (ebc <= 12) return "#e8b820";
  if (ebc <= 20) return "#d09010";
  if (ebc <= 35) return "#a86810";
  if (ebc <= 50) return "#804008";
  if (ebc <= 80) return "#602808";
  if (ebc <= 120) return "#401808";
  return "#200800";
}

function openRecipeDetail(idx) {
  const r = recipesCache[idx];
  if (!r) return;
  const vol = r.volume || 23;

  const diffClass = (r.difficulty || "").toLowerCase().replace(/\s/g, "");
  const ebcColor = ebcToColor(r.ebc);

  let html = `
    <div class="recipe-detail-header">
      <h2>${esc(r.name)}</h2>
      <div class="recipe-detail-meta">
        <span class="recipe-diff-badge ${diffClass}">${esc(r.difficulty || "")}</span>
        <span class="recipe-detail-type">${esc(r.type || "")}</span>
        ${r.link ? `<a href="${esc(r.link)}" target="_blank" rel="noopener" class="recipe-link-btn">View on Coopers DIY</a>` : ""}
      </div>
    </div>

    <div class="recipe-detail-stats">
      <div class="recipe-stat"><span class="recipe-stat-val">${r.abv != null ? r.abv.toFixed(1) + "%" : "--"}</span><span class="recipe-stat-label">ABV</span></div>
      <div class="recipe-stat"><span class="recipe-stat-val">${r.ibu != null ? Math.round(r.ibu) : "--"}</span><span class="recipe-stat-label">IBU</span></div>
      <div class="recipe-stat"><span class="recipe-stat-val"><span class="ebc-dot" style="background:${ebcColor}"></span>${r.ebc != null ? Math.round(r.ebc) : "--"}</span><span class="recipe-stat-label">EBC</span></div>
      <div class="recipe-stat"><span class="recipe-stat-val">${vol}L</span><span class="recipe-stat-label">Volume</span></div>
      ${r.ferment_temp ? `<div class="recipe-stat"><span class="recipe-stat-val">${r.ferment_temp}&deg;C</span><span class="recipe-stat-label">Ferment</span></div>` : ""}
    </div>

    <div class="recipe-scaler-row">
      <label>Scale to: <input type="number" id="recipe-scale-vol" value="${vol}" min="1" max="100" step="0.5" onchange="rescaleRecipe(${idx})"> litres</label>
      <span class="help-text">(original: ${vol}L)</span>
    </div>

    <div id="recipe-ingredients-${idx}">
      ${renderRecipeIngredients(r, 1)}
    </div>

    ${r.method ? `<div class="recipe-section"><h3>Method</h3><p>${esc(r.method)}</p></div>` : ""}
    ${r.variations ? `<div class="recipe-section"><h3>Variations</h3><p>${esc(r.variations)}</p></div>` : ""}

    <div class="recipe-section">
      <h3>Shopping List</h3>
      <button class="btn-save" onclick="copyShoppingList(${idx})" id="btn-copy-list-${idx}">Copy to Clipboard</button>
      <pre id="recipe-shopping-list-${idx}" class="shopping-list">${buildShoppingList(r, 1)}</pre>
      <p class="help-text" style="margin-top:8px">
        <a href="${COOPERS_STORE}" target="_blank" rel="noopener">Shop at Coopers DIY Beer</a> — support the homebrew community.
      </p>
    </div>
  `;

  document.getElementById("recipe-detail-content").innerHTML = html;
  document.getElementById("recipe-detail-modal").style.display = "";
}

function closeRecipeDetail() {
  document.getElementById("recipe-detail-modal").style.display = "none";
}

function rescaleRecipe(idx) {
  const r = recipesCache[idx];
  if (!r) return;
  const origVol = r.volume || 23;
  const newVol = parseFloat(document.getElementById("recipe-scale-vol").value) || origVol;
  const scale = newVol / origVol;

  const container = document.getElementById("recipe-ingredients-" + idx);
  if (container) container.innerHTML = renderRecipeIngredients(r, scale);

  const listEl = document.getElementById("recipe-shopping-list-" + idx);
  if (listEl) listEl.textContent = buildShoppingList(r, scale);
}

function renderRecipeIngredients(r, scale) {
  let html = "";

  // Extract kits / cans
  if (r.cans.length) {
    html += '<div class="recipe-section"><h3>Extract Kits</h3><table class="recipe-ing-table"><tbody>';
    r.cans.forEach(c => {
      const qty = scale === 1 ? "1 can" : scaleDisplay(1 * scale, "can");
      html += `<tr><td>${esc(c)}</td><td class="recipe-qty">${qty}</td></tr>`;
    });
    html += "</tbody></table></div>";
  }

  // Fermentables
  if (r.fermentables.length) {
    html += '<div class="recipe-section"><h3>Fermentables</h3><table class="recipe-ing-table"><tbody>';
    r.fermentables.forEach(f => {
      const baseQty = parseFloat(f.qty) || 1;
      const scaled = baseQty * scale;
      html += `<tr><td>${esc(f.name)}</td><td class="recipe-qty">${scaleWeight(scaled, "kg")}</td></tr>`;
    });
    html += "</tbody></table></div>";
  }

  // Hops
  if (r.hops.length) {
    html += '<div class="recipe-section"><h3>Hops</h3><table class="recipe-ing-table"><thead><tr><th>Hop</th><th>Weight</th><th>Addition</th></tr></thead><tbody>';
    r.hops.forEach(h => {
      const baseWt = parseFloat(h.weight) || 0;
      const scaled = baseWt * scale;
      html += `<tr><td>${esc(h.name)}</td><td class="recipe-qty">${scaleWeight(scaled, "g")}</td><td>${esc(h.method || "")}</td></tr>`;
    });
    html += "</tbody></table></div>";
  }

  // Grains
  if (r.grains.length) {
    html += '<div class="recipe-section"><h3>Grains</h3><table class="recipe-ing-table"><thead><tr><th>Grain</th><th>Weight</th><th>Method</th></tr></thead><tbody>';
    r.grains.forEach(g => {
      const baseWt = parseFloat(g.weight) || 0;
      const scaled = baseWt * scale;
      html += `<tr><td>${esc(g.name)}</td><td class="recipe-qty">${scaleWeight(scaled, "g")}</td><td>${esc(g.method || "")}</td></tr>`;
    });
    html += "</tbody></table></div>";
  }

  // Yeast
  if (r.yeasts.length) {
    html += '<div class="recipe-section"><h3>Yeast</h3><ul class="recipe-yeast-list">';
    r.yeasts.forEach(y => { html += `<li>${esc(y)}</li>`; });
    html += "</ul></div>";
  }

  // Other
  if (r.other) {
    html += `<div class="recipe-section"><h3>Other Ingredients</h3><p>${esc(r.other)}</p></div>`;
  }

  return html;
}

function scaleWeight(val, unit) {
  if (val <= 0) return "--";
  if (unit === "g") {
    if (val >= 1000) return (val / 1000).toFixed(2) + " kg";
    return Math.round(val) + " g";
  }
  if (unit === "kg") {
    if (val < 0.1) return Math.round(val * 1000) + " g";
    return val.toFixed(2) + " kg";
  }
  return val.toFixed(1) + " " + unit;
}

function scaleDisplay(val, unit) {
  if (val === 1) return "1 " + unit;
  return val.toFixed(1) + " " + unit + (val !== 1 ? "s" : "");
}

function buildShoppingList(r, scale) {
  const lines = [];
  lines.push(r.name + (scale !== 1 ? " (scaled to " + ((r.volume || 23) * scale).toFixed(1) + "L)" : " (" + (r.volume || 23) + "L)"));
  lines.push("─".repeat(40));

  if (r.cans.length) {
    lines.push("EXTRACT KITS:");
    r.cans.forEach(c => {
      const qty = scale === 1 ? "1 can" : scaleDisplay(1 * scale, "can");
      lines.push("  " + c + " — " + qty);
    });
  }

  if (r.fermentables.length) {
    lines.push("FERMENTABLES:");
    r.fermentables.forEach(f => {
      const baseQty = parseFloat(f.qty) || 1;
      lines.push("  " + f.name + " — " + scaleWeight(baseQty * scale, "kg"));
    });
  }

  if (r.hops.length) {
    lines.push("HOPS:");
    r.hops.forEach(h => {
      const baseWt = parseFloat(h.weight) || 0;
      lines.push("  " + h.name + " — " + scaleWeight(baseWt * scale, "g") + (h.method ? " (" + h.method + ")" : ""));
    });
  }

  if (r.grains.length) {
    lines.push("GRAINS:");
    r.grains.forEach(g => {
      const baseWt = parseFloat(g.weight) || 0;
      lines.push("  " + g.name + " — " + scaleWeight(baseWt * scale, "g") + (g.method ? " (" + g.method + ")" : ""));
    });
  }

  if (r.yeasts.length) {
    lines.push("YEAST:");
    r.yeasts.forEach(y => lines.push("  " + y));
  }

  if (r.other) {
    lines.push("OTHER:");
    lines.push("  " + r.other);
  }

  if (r.ferment_temp) lines.push("\nFERMENT: " + r.ferment_temp + "\u00b0C");

  return lines.join("\n");
}

function copyShoppingList(idx) {
  const el = document.getElementById("recipe-shopping-list-" + idx);
  if (!el) return;
  navigator.clipboard.writeText(el.textContent).then(() => {
    const btn = document.getElementById("btn-copy-list-" + idx);
    if (btn) { btn.textContent = "Copied!"; setTimeout(() => btn.textContent = "Copy to Clipboard", 2000); }
  });
}

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
