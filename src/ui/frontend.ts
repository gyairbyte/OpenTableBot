/**
 * Operator console served by the UI server. It is intentionally dependency-free
 * plain HTML/CSS/JS so the console needs no build step: the only contract with
 * the backend is the JSON API in server.ts.
 */
export const FRONTEND_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>OpenTableBot console</title>
<style>
  :root { color-scheme: light dark; }
  /* Author display rules otherwise beat the user-agent rule for [hidden]. */
  [hidden] { display: none !important; }
  body { margin: 0; padding: 24px; font: 14px/1.5 "Segoe UI", system-ui, sans-serif; background: #f6f7f9; color: #14161a; }
  h1 { font-size: 20px; margin: 0; }
  h2 { font-size: 15px; margin: 0 0 12px; text-transform: uppercase; letter-spacing: .04em; color: #4b5563; }
  header { display: flex; flex-wrap: wrap; gap: 12px; align-items: baseline; justify-content: space-between; margin-bottom: 20px; }
  section { background: #fff; border: 1px solid #d9dee5; border-radius: 8px; padding: 16px; margin-bottom: 20px; }
  .status-controls { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; justify-content: flex-end; }
  .status { font-size: 13px; color: #4b5563; }
  .status.ok { color: #0f7b3f; }
  .status.warn { color: #a2530a; }
  .mode-control { flex-direction: row; align-items: center; font-size: 12px; }
  .mode-control select { padding: 3px 6px; }
  .message { min-height: 20px; font-size: 13px; margin: 8px 0; }
  .message.error { color: #b3261e; }
  .message.ok { color: #0f7b3f; }
  .message.info { color: #4b5563; }
  form.grid, .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 10px 14px; align-items: end; }
  .wide { grid-column: 1 / -1; }
  label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: #4b5563; }
  input, select, button { font: inherit; padding: 6px 8px; border: 1px solid #c3cad4; border-radius: 6px; background: #fff; color: inherit; }
  input[type=checkbox] { align-self: start; width: 16px; height: 16px; }
  label.check { flex-direction: row; align-items: center; gap: 8px; font-size: 13px; color: #14161a; }
  button { cursor: pointer; background: #1f2937; color: #fff; border-color: #1f2937; }
  button.secondary { background: #fff; color: #1f2937; }
  button.danger { background: #fff; color: #b3261e; border-color: #e2b6b3; }
  button:disabled { opacity: .5; cursor: default; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #e5e8ee; vertical-align: top; }
  th { font-weight: 600; color: #4b5563; }
  .state { font-weight: 600; }
  .state-armed, .state-booked { color: #0f7b3f; }
  .state-paused, .state-outcome_unknown, .state-slot_lost { color: #b3261e; }
  .state-waiting, .state-locking, .state-locked, .state-submitting, .state-revalidating { color: #a2530a; }
  .actions { display: flex; gap: 6px; flex-wrap: wrap; }
  .task-row { grid-template-columns: repeat(5, minmax(130px, 1fr)); }
  .task-row.secondary { grid-template-columns: repeat(4, minmax(150px, 1fr)); }
  .policy-list { display: flex; flex-direction: column; gap: 10px; align-items: flex-start; }
  .policy-list label { width: min(100%, 360px); }
  .banner { padding: 8px 12px; border-radius: 6px; font-size: 13px; margin-bottom: 16px; background: #fff4e5; border: 1px solid #f0c48a; color: #8a4b08; }
  fieldset { border: 1px solid #e5e8ee; border-radius: 6px; padding: 10px 12px; margin: 12px 0 0; }
  legend { font-size: 12px; color: #4b5563; padding: 0 4px; }
  .hint { font-size: 12px; color: #6b7280; margin-top: 6px; }
  .actions-bar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin-top: 12px; }
  .combo { position: relative; }
  .combo-list { position: absolute; z-index: 20; left: 0; right: 0; top: 100%; margin-top: 2px; background: #fff; border: 1px solid #c3cad4; border-radius: 6px; box-shadow: 0 6px 18px rgba(15, 23, 42, .12); max-height: 280px; overflow: auto; }
  .combo-item { display: block; width: 100%; text-align: left; border: 0; border-radius: 0; background: #fff; color: #14161a; padding: 6px 10px; font-size: 13px; }
  .combo-item.active, .combo-item:hover { background: #eef2f7; }
  .combo-item small { display: block; color: #6b7280; font-size: 11px; }
  .panel { border: 1px solid #e5e8ee; border-radius: 6px; padding: 10px 12px; margin-top: 12px; background: #fbfcfd; }
  .panel h3 { font-size: 13px; margin: 0 0 6px; color: #4b5563; text-transform: uppercase; letter-spacing: .04em; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
  .chip { border: 1px solid #c3cad4; border-radius: 999px; background: #fff; color: #14161a; padding: 2px 12px; font-size: 12px; }
  .chip.selected { background: #1f2937; color: #fff; border-color: #1f2937; }
  .area-list { display: flex; flex-wrap: wrap; gap: 12px; }
  dl.terms { display: grid; grid-template-columns: max-content 1fr; gap: 2px 14px; margin: 8px 0 0; font-size: 13px; }
  dl.terms dt { color: #4b5563; }
  dl.terms dd { margin: 0; }
  .decision { font-weight: 600; font-size: 13px; }
  .decision.allowed { color: #0f7b3f; }
  .decision.rejected { color: #b3261e; }
  ul.reasons { margin: 6px 0 0; padding-left: 18px; font-size: 13px; color: #b3261e; }
  .availability-detail { margin-top: 6px; }
  .availability-detail > summary { cursor: pointer; font-size: 12px; font-weight: 600; color: #1f5feb; }
  .availability-detail[open] > summary { margin-bottom: 6px; }
  .availability-detail .detail-overview { font-size: 12px; color: #4b5563; margin-bottom: 4px; }
  .availability-detail .detail-attempt { font-size: 12px; font-weight: 600; color: #4b5563; margin-top: 8px; }
  .availability-detail .chips { margin-bottom: 4px; }
  .chip.in-window { background: #e7f5ec; border-color: #a9d9b8; color: #0f7b3f; }
  .chip.out-window { background: #f1f3f6; color: #6b7280; }
  .chip.none { background: #fff4e5; border-color: #f0c48a; color: #8a4b08; }
</style>
</head>
<body>
<header>
  <h1>OpenTableBot console</h1>
  <div class="status-controls">
    <div id="status" class="status">Loading status...</div>
    <label class="mode-control">Booking mode
      <select id="mode-select">
        <option value="execute">Live</option>
        <option value="dry-run">Dry Run</option>
      </select>
      <button type="button" id="mode-apply">Apply</button>
    </label>
  </div>
</header>

<div id="banner" class="banner" hidden></div>

<section>
  <h2>Find a restaurant</h2>
  <form id="search-form" class="grid">
    <label class="wide combo">Search term
      <input name="term" autocomplete="off" placeholder="Catch, sushi, Italian" required>
      <div id="search-suggestions" class="combo-list" hidden></div>
    </label>
    <label>Date<input name="date" type="date"></label>
    <label>Time<input name="time" type="time"></label>
    <label>Party size<input name="partySize" type="number" min="1" max="20" value="2"></label>
    <label>&nbsp;<button type="submit">Search all</button></label>
  </form>
  <div id="search-message" class="message"></div>
  <table id="search-results" hidden>
    <thead><tr><th>Restaurant</th><th>Id</th><th>Details</th><th></th></tr></thead>
    <tbody id="search-body"></tbody>
  </table>
  <div class="hint">Searching uses the paired OpenTable tab, so keep one OpenTable page open. Matching is OpenTable's own full-text search: partial names, cuisines, and neighborhoods all work.</div>
</section>

<section>
  <h2>Reservation task</h2>
  <div id="task-mode" class="hint"></div>
  <form id="task-form" class="grid">
    <label>Restaurant id<input name="restaurantId" required></label>
    <label>Restaurant name<input name="restaurantName" required></label>
    <label>Time zone<input name="timeZone" value="America/New_York" required></label>
    <input name="profileUrl" type="hidden">
    <div class="grid wide task-row">
      <label>Party size<input name="partySize" type="number" min="1" max="20" value="2" required></label>
      <label>Start date<input name="startDate" type="date" required></label>
      <label>End date<input name="endDate" type="date" required></label>
      <label>Earliest time<input name="earliest" type="time" required></label>
      <label>Latest time<input name="latest" type="time" required></label>
    </div>
    <div class="grid wide task-row secondary">
      <label>Preferred time<input name="preferred" type="time" required></label>
      <label>Mode
        <select name="mode">
          <option value="known-drop">known-drop (release time)</option>
          <option value="cancellation-watch">cancellation-watch</option>
        </select>
      </label>
      <label id="release-at-label">Release time (known-drop)<input name="releaseAt" type="datetime-local"></label>
      <label id="watch-stop-at-label" hidden>Stop watching at (restaurant local time)<input name="watchStopAt" type="datetime-local"></label>
      <label>Dining area policy
        <select name="diningMode">
          <option value="any">any</option>
          <option value="allow">allow listed areas</option>
          <option value="prefer">prefer listed areas</option>
        </select>
      </label>
    </div>
    <div id="mode-hint" class="hint wide"></div>
    <label id="dining-categories-label" hidden>Extra allowed categories
      <select name="diningCategories" multiple size="4"></select>
    </label>
    <label id="dining-labels-label" hidden>Extra allowed labels (comma separated)<input name="diningLabels"></label>
    <label id="dining-preferences-label" hidden>Preferred areas (comma separated)<input name="diningPreferences"></label>
    <label id="dining-fallback-label" hidden>Fallback
      <select name="diningFallback"><option value="any">any</option><option value="none">none</option></select>
    </label>
    <div id="dining-discovery" class="wide">
      <div class="hint" id="dining-discovery-hint">Run "Check availability" to list the dining areas this restaurant actually offers, then tick the ones you want.</div>
    </div>

    <fieldset class="wide">
      <legend>Booking policy (fail-closed)</legend>
      <div class="policy-list">
        <label class="check"><input name="autoBookAuthorized" type="checkbox"> Authorize automatic booking</label>
        <label class="check"><input name="allowPrepaid" type="checkbox"> Allow prepaid reservations</label>
        <label>Max prepaid deposit ($)<input name="maxAuthorizedPrepaidDollars" type="number" min="0" step="0.01" value="0"></label>
        <label class="check"><input name="allowExperiences" type="checkbox"> Allow experiences</label>
        <label class="check"><input name="allowPaymentMethodRequired" type="checkbox"> Allow payment method required</label>
        <label>Max cancellation/no-show fee per person ($)<input name="maxAuthorizedCancellationNoShowDollarsPerPerson" type="number" min="0" step="0.01" value="0"></label>
        <label>Currency<input name="currency" value="USD" maxlength="3"></label>
      </div>
    </fieldset>

    <div class="actions-bar wide">
      <label class="check"><input name="arm" type="checkbox"> Arm immediately</label>
      <button type="submit" id="task-submit">Create task</button>
      <button type="button" id="task-cancel" class="secondary" hidden>Cancel edit</button>
      <button type="button" id="task-probe" class="secondary">Check availability</button>
      <button type="button" id="task-preview" class="secondary">Preview terms</button>
    </div>
  </form>
  <div id="task-message" class="message"></div>

  <div id="probe-panel" class="panel" hidden>
    <h3>What this restaurant offers</h3>
    <div id="probe-summary" class="hint"></div>
    <div class="chips" id="probe-times"></div>
    <div class="area-list" id="probe-area-choices"></div>
  </div>

  <div id="preview-panel" class="panel" hidden>
    <h3>Booking terms for the selected slot</h3>
    <div id="preview-decision" class="decision"></div>
    <ul id="preview-reasons" class="reasons" hidden></ul>
    <dl id="preview-terms" class="terms"></dl>
  </div>
</section>

<section>
  <h2>Scheduled tasks</h2>
  <table id="targets-table">
    <thead><tr><th>Restaurant</th><th>Dates</th><th>Window</th><th>Party</th><th>Mode</th><th>State</th><th>Detail</th><th></th></tr></thead>
    <tbody id="targets-body"></tbody>
  </table>
  <div id="targets-message" class="message"></div>
</section>

<script>
var DINING_CATEGORIES = [
  "dining-room", "indoor", "outdoor", "patio", "terrace", "rooftop", "bar",
  "bar-seating", "counter", "high-top", "lounge", "garden", "communal",
  "private-dining", "chefs-counter", "other", "unknown"
];

var LEGACY_SEATING_CATEGORY = {
  "standard": "dining-room",
  "outdoor": "outdoor",
  "bar": "bar",
  "counter": "counter",
  "high-top": "high-top",
  "private-dining": "private-dining",
  "other": "other"
};

var EDITABLE_STATES = ["DRAFT", "ARMED", "WAITING", "PAUSED", "SLOT_LOST"];

var REASON_TEXT = {
  AUTO_BOOK_NOT_AUTHORIZED: "This task's booking policy does not authorize automatic booking.",
  AMBIGUOUS_PREVIEW: "OpenTable returned ambiguous terms, so the run must fail closed.",
  SLOT_MISMATCH: "The preview described a different slot than the one selected.",
  RESTAURANT_MISMATCH: "The preview described a different restaurant.",
  DATE_MISMATCH: "The preview date is outside this task's date range.",
  TIME_MISMATCH: "The preview time is outside this task's time window.",
  PARTY_SIZE_MISMATCH: "The preview party size differs from this task's party size.",
  UNEXPECTED_SEATING: "The dining area offered is not allowed by this task's dining area policy.",
  RESERVATION_KIND_MISMATCH: "The reservation kind changed between discovery and preview.",
  EXPERIENCE_NOT_AUTHORIZED: "This is an experience reservation and the policy does not allow experiences.",
  UNKNOWN_RESERVATION_KIND: "OpenTable returned an unrecognized reservation kind.",
  UNEXPECTED_PREPAID_REQUIREMENT: "Prepaid is required and the policy does not allow prepaid.",
  PREPAID_AMOUNT_UNKNOWN: "Prepaid is required but the amount is unknown, so it cannot be authorized.",
  PREPAID_AMOUNT_EXCEEDS_AUTHORIZATION: "The prepaid amount is above the authorized maximum.",
  CANCELLATION_FEE_UNKNOWN: "The cancellation fee is unknown, so exposure cannot be authorized.",
  NO_SHOW_FEE_UNKNOWN: "The no-show fee is unknown, so exposure cannot be authorized.",
  CANCELLATION_EXPOSURE_EXCEEDS_AUTHORIZATION: "The cancellation or no-show fee is above the authorized maximum.",
  CURRENCY_MISMATCH: "The reservation is priced in a different currency than the policy allows.",
  CURRENCY_UNKNOWN: "The currency is unknown while the reservation carries financial exposure.",
  PAYMENT_METHOD_REQUIRED_NOT_AUTHORIZED: "A payment method is required and the policy does not allow it.",
  PAYMENT_REQUIREMENT_UNKNOWN: "OpenTable did not say whether a payment method is required.",
  STRONG_CUSTOMER_AUTHENTICATION_REQUIRED: "The bank requires strong customer authentication, which this bot cannot complete.",
  STRONG_CUSTOMER_AUTHENTICATION_UNKNOWN: "Strong customer authentication may be required and could not be established."
};

var state = {
  probe: null,
  selectedAreas: {},
  editing: null,
  lastTargetsJson: "",
  lastStatusJson: "",
  mode: "dry-run",
  suggestions: [],
  suggestionIndex: -1,
  searchTimer: null
};

function byId(id) { return document.getElementById(id); }

function el(tag, text, className) {
  var node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = String(text);
  if (className) node.className = className;
  return node;
}

function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

function setMessage(id, text, kind) {
  var node = byId(id);
  node.textContent = text || "";
  node.className = "message" + (kind ? " " + kind : "");
}

function api(path, options) {
  var init = options || {};
  if ((init.method || "GET") !== "GET") {
    init.headers = { "content-type": "application/json" };
  }
  if (init.body !== undefined) {
    init.body = JSON.stringify(init.body);
  }
  return fetch(path, init).then(function (response) {
    return response.json().catch(function () { return {}; }).then(function (payload) {
      if (!response.ok || payload.ok === false) {
        var message = payload && payload.error ? payload.error.message : "Request failed";
        if (payload && payload.error && payload.error.issues && payload.error.issues.length) {
          message += ": " + payload.error.issues.map(function (issue) {
            return (issue.path ? issue.path + " " : "") + issue.message;
          }).join("; ");
        }
        throw new Error(message);
      }
      return payload;
    });
  });
}

function splitList(value) {
  return String(value || "").split(",").map(function (item) {
    return item.trim();
  }).filter(function (item) { return item !== ""; });
}

function unique(values) {
  var seen = {};
  var result = [];
  values.forEach(function (value) {
    if (!seen[value]) { seen[value] = true; result.push(value); }
  });
  return result;
}

function selectedValues(select) {
  var values = [];
  for (var index = 0; index < select.options.length; index += 1) {
    if (select.options[index].selected) values.push(select.options[index].value);
  }
  return values;
}

function shiftTime(value, deltaMinutes) {
  if (!value) return "";
  var parts = value.split(":");
  var minutes = Number(parts[0]) * 60 + Number(parts[1]) + deltaMinutes;
  minutes = Math.max(0, Math.min(23 * 60 + 59, minutes));
  var hours = Math.floor(minutes / 60);
  var rest = minutes % 60;
  return (hours < 10 ? "0" : "") + hours + ":" + (rest < 10 ? "0" : "") + rest;
}

function pad2(value) { return (value < 10 ? "0" : "") + value; }

function todayLocal() {
  var now = new Date();
  return now.getFullYear() + "-" + pad2(now.getMonth() + 1) + "-" + pad2(now.getDate());
}

/** Renders an ISO instant into the local value a datetime-local input expects. */
function toLocalInput(iso, timeZone) {
  var parsed = new Date(iso);
  if (isNaN(parsed.getTime())) return "";
  var parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(parsed);
  var values = {};
  parts.forEach(function (part) {
    if (part.type !== "literal") values[part.type] = part.value;
  });
  return values.year + "-" + values.month + "-" + values.day +
    "T" + values.hour + ":" + values.minute;
}

function localInputToIso(value, timeZone) {
  if (!value) return "";
  var match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u.exec(value);
  if (!match) return "";
  var year = Number(match[1]);
  var month = Number(match[2]);
  var day = Number(match[3]);
  var hour = Number(match[4]);
  var minute = Number(match[5]);
  var guess = Date.UTC(year, month - 1, day, hour, minute);
  var parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(new Date(guess));
  var values = {};
  parts.forEach(function (part) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  });
  var instant = guess;
  for (var iteration = 0; iteration < 3; iteration += 1) {
    var represented = Date.UTC(
      values.year, values.month - 1, values.day, values.hour, values.minute
    );
    var adjusted = guess - (represented - instant);
    if (adjusted === instant) break;
    instant = adjusted;
    var adjustedParts = new Intl.DateTimeFormat("en-US", {
      timeZone: timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).formatToParts(new Date(instant));
    adjustedParts.forEach(function (part) {
      if (part.type !== "literal") values[part.type] = Number(part.value);
    });
  }
  if (
    values.year !== year ||
    values.month !== month ||
    values.day !== day ||
    values.hour !== hour ||
    values.minute !== minute
  ) {
    throw new Error("The selected local time does not exist in the restaurant timezone");
  }
  return new Date(instant).toISOString();
}

function formatMoney(cents, currency) {
  var code = currency && currency !== "unknown" ? currency : "";
  return (code ? code + " " : "") + (cents / 100).toFixed(2);
}

function describePrepaid(term, currency) {
  if (!term) return "unknown";
  if (term.status === "not-required") return "not required";
  if (term.status === "required-known") return "required, " + formatMoney(term.amountCents, currency);
  return "required, amount unknown (fails closed)";
}

function describeFinancial(term, currency) {
  if (!term) return "unknown";
  if (term.status === "none") return "none";
  if (term.status === "known") return formatMoney(term.amountCents, currency);
  return "unknown (fails closed)";
}

function areaKey(area) { return area.category + "|" + area.label; }

function selectedAreas() {
  var result = [];
  var node = byId("probe-area-choices");
  var inputs = node.querySelectorAll("input[type=checkbox]");
  for (var index = 0; index < inputs.length; index += 1) {
    var input = inputs[index];
    if (input.checked) {
      result.push({
        category: input.getAttribute("data-category"),
        label: input.getAttribute("data-label"),
        providerOrder: Number(input.getAttribute("data-order") || 0)
      });
    }
  }
  return result;
}

function loadStatus() {
  return api("/api/status").then(function (payload) {
    var status = payload.status;
    state.mode = status.mode;
    byId("mode-select").value = status.mode;
    var serialized = JSON.stringify(status);
    if (serialized === state.lastStatusJson) return;
    state.lastStatusJson = serialized;
    var parts = [
      "mode " + status.mode,
      "bridge " + (status.bridgeReachable ? "reachable" : "unreachable"),
      "session " + (status.authenticated ? "authenticated" : "not authenticated")
    ];
    if (status.lastTickAt) parts.push("last scheduler check " + status.lastTickAt);
    if (status.lastTickError) parts.push("scheduler error " + status.lastTickError);
    if (status.schedulerSkippedReason) parts.push(status.schedulerSkippedReason);
    var node = byId("status");
    node.textContent = parts.join("  |  ");
    node.className = "status " + (status.bridgeReachable && status.authenticated && !status.schedulerSkippedReason ? "ok" : "warn");
    var banner = byId("banner");
    if (status.mode === "execute") {
      banner.hidden = false;
      banner.textContent = "WRITE MODE: armed tasks submit real reservations through the paired browser session.";
    } else {
      banner.hidden = true;
    }
  }).catch(function (error) {
    var node = byId("status");
    node.textContent = "Status unavailable: " + error.message;
    node.className = "status warn";
  });
}

function changeMode() {
  var select = byId("mode-select");
  var mode = select.value;
  if (mode === "execute" && !window.confirm(
    "Switch to LIVE mode? Armed tasks can submit real reservations at their release time."
  )) {
    loadStatus();
    return;
  }
  var button = byId("mode-apply");
  button.disabled = true;
  api("/api/mode", { method: "POST", body: { mode: mode } }).then(function () {
    setMessage(
      "task-message",
      mode === "execute"
        ? "Live mode enabled. Armed tasks may submit real reservations."
        : "Dry Run enabled. No reservation will be submitted.",
      mode === "execute" ? "error" : "info"
    );
    return loadStatus();
  }).catch(function (error) {
    setMessage("task-message", error.message, "error");
    return loadStatus();
  }).then(function () {
    button.disabled = false;
  });
}

function loadTargets() {
  return api("/api/targets").then(function (payload) {
    var serialized = JSON.stringify(payload.targets);
    if (serialized === state.lastTargetsJson) return;
    state.lastTargetsJson = serialized;
    renderTargets(payload.targets);
  }).catch(function (error) {
    setMessage("targets-message", error.message, "error");
  });
}

function renderTargets(targets) {
  var body = byId("targets-body");
  clear(body);
  if (!targets.length) {
    var empty = el("tr");
    var cell = el("td", "No tasks yet.");
    cell.colSpan = 8;
    empty.appendChild(cell);
    body.appendChild(empty);
    return;
  }
  targets.forEach(function (record) {
    var row = el("tr");
    var restaurant = record.target.restaurant;
    row.appendChild(el("td", restaurant.name + " (" + restaurant.id + ")"));
    row.appendChild(el("td", record.target.dateRange.startDate + " to " + record.target.dateRange.endDate));
    row.appendChild(el("td", record.target.timeWindow.earliest + "-" + record.target.timeWindow.latest + " preferred " + record.target.timeWindow.preferred));
    row.appendChild(el("td", record.target.partySize));
    var modeDetail = record.target.mode;
    if (record.target.knownReservationReleaseAt) modeDetail += " at " + record.target.knownReservationReleaseAt;
    if (record.target.cancellationWatchStopAt) modeDetail += " until " + record.target.cancellationWatchStopAt;
    row.appendChild(el("td", modeDetail));
    row.appendChild(el("td", record.state, "state state-" + record.state.toLowerCase()));
    var detail = "";
    if (record.confirmation) detail = "confirmation " + record.confirmation.confirmationId + " at " + record.confirmation.startsAt;
    else if (record.pauseReason) detail = record.pauseReason;
    var detailCell = el("td");
    if (detail) detailCell.appendChild(el("div", detail));
    if (record.scanBlockedReason) {
      detailCell.appendChild(el("div", "Could not scan on the last poll: " + record.scanBlockedReason));
    }
    if (record.availabilityDetail) {
      detailCell.appendChild(availabilityDetailWidget(record.availabilityDetail));
    }
    row.appendChild(detailCell);
    var actions = el("td", null, "actions");
    if (EDITABLE_STATES.indexOf(record.state) >= 0) {
      actions.appendChild(editButton(record));
    }
    if (record.state === "DRAFT" || record.state === "PAUSED") {
      actions.appendChild(actionButton("Arm", "arm", record));
    }
    if (record.state === "ARMED" || record.state === "WAITING") {
      actions.appendChild(runNowButton(record));
    }
    if (record.target.mode === "known-drop" && record.target.knownReservationReleaseAt) {
      actions.appendChild(windowsTaskButton(record));
    }
    if (["DRAFT", "ARMED", "WAITING", "MATCH_FOUND", "VALIDATING", "LOCKING", "LOCKED", "REVALIDATING", "SUBMITTING"].indexOf(record.state) >= 0) {
      actions.appendChild(actionButton("Pause", "pause", record));
    }
    actions.appendChild(actionButton("Delete", "delete", record));
    row.appendChild(actions);
    body.appendChild(row);
  });
}

function runNowButton(record) {
  var button = el("button", "Run now", "secondary");
  button.type = "button";
  button.addEventListener("click", function () {
    var modeLabel = state.mode === "execute" ? "LIVE" : "DRY RUN";
    if (!window.confirm(
      "Run " + record.target.restaurant.name + " immediately in " + modeLabel +
      " mode? Live mode may submit a real reservation."
    )) return;
    button.disabled = true;
    api("/api/targets/" + encodeURIComponent(record.target.id) + "/run-now", {
      method: "POST",
      body: { version: record.version }
    }).then(function () {
      setMessage("targets-message", "Immediate run started for " + record.target.id, "ok");
      return loadTargets();
    }).catch(function (error) {
      button.disabled = false;
      setMessage("targets-message", error.message, "error");
    });
  });
  return button;
}

function windowsTaskButton(record) {
  var button = el("button", "Create Windows task", "secondary");
  button.type = "button";
  button.addEventListener("click", function () {
    var restaurantUrl = record.target.restaurant.profileUrl || "";
    if (!restaurantUrl) {
      restaurantUrl = window.prompt(
        "Enter the OpenTable restaurant profile URL:",
        "https://www.opentable.com/r/restaurant-name"
      ) || "";
    }
    if (!restaurantUrl.trim()) return;
    var modeLabel = state.mode === "execute" ? "LIVE" : "DRY RUN";
    if (!window.confirm(
      "Register a Windows wake task for " + record.target.restaurant.name +
      " in " + modeLabel + " mode? This replaces the task with the same target name."
    )) return;
    button.disabled = true;
    api("/api/targets/" + encodeURIComponent(record.target.id) + "/windows-task", {
      method: "POST",
      body: { version: record.version, restaurantUrl: restaurantUrl.trim() }
    }).then(function (payload) {
      var task = payload.task;
      setMessage(
        "targets-message",
        "Windows task " + task.taskName + " registered for " + task.dropDate +
          " " + task.dropTime + ".",
        "ok"
      );
      button.disabled = false;
    }).catch(function (error) {
      button.disabled = false;
      setMessage("targets-message", error.message, "error");
    });
  });
  return button;
}

function editButton(record) {
  var button = el("button", "Edit", "secondary");
  button.type = "button";
  button.addEventListener("click", function () { startEdit(record); });
  return button;
}

function actionButton(label, action, record) {
  var button = el("button", label, action === "delete" ? "danger" : "secondary");
  button.type = "button";
  button.addEventListener("click", function () {
    button.disabled = true;
    var request = action === "delete"
      ? api("/api/targets/" + encodeURIComponent(record.target.id) + "?version=" + record.version, { method: "DELETE" })
      : api("/api/targets/" + encodeURIComponent(record.target.id) + "/state", {
          method: "POST",
          body: { action: action, version: record.version }
        });
    request.then(function () {
      setMessage("targets-message", label + " applied to " + record.target.id, "ok");
      return loadTargets();
    }).catch(function (error) {
      button.disabled = false;
      setMessage("targets-message", error.message, "error");
    });
  });
  return button;
}

function renderResults(results) {
  var body = byId("search-body");
  clear(body);
  byId("search-results").hidden = results.length === 0;
  results.forEach(function (result) {
    var row = el("tr");
    row.appendChild(el("td", result.name));
    row.appendChild(el("td", result.restaurantId));
    var details = [result.cuisine, result.metro, result.priceBand].filter(function (value) {
      return Boolean(value);
    }).join(", ");
    row.appendChild(el("td", details + (result.bookable ? "" : "  (not bookable)")));
    var actions = el("td", null, "actions");
    var use = el("button", "Use");
    use.type = "button";
    use.addEventListener("click", function () { useRestaurant(result); });
    actions.appendChild(use);
    row.appendChild(actions);
    body.appendChild(row);
  });
}

function searchParams() {
  var form = byId("search-form");
  var params = new URLSearchParams();
  params.set("term", form.term.value.trim());
  if (form.date.value) params.set("date", form.date.value);
  if (form.time.value) params.set("time", form.time.value);
  if (form.partySize.value) params.set("partySize", form.partySize.value);
  return params;
}

function closeSuggestions() {
  var list = byId("search-suggestions");
  list.hidden = true;
  clear(list);
  state.suggestionIndex = -1;
}

function renderSuggestions() {
  var list = byId("search-suggestions");
  clear(list);
  if (!state.suggestions.length) { list.hidden = true; return; }
  state.suggestions.forEach(function (result, index) {
    var item = el("button", null, "combo-item" + (index === state.suggestionIndex ? " active" : ""));
    item.type = "button";
    item.appendChild(el("span", result.name));
    var details = [result.restaurantId, result.cuisine, result.metro, result.priceBand].filter(function (value) {
      return Boolean(value);
    }).join("  |  ");
    item.appendChild(el("small", details + (result.bookable ? "" : "  (not bookable)")));
    item.addEventListener("mousedown", function (event) {
      event.preventDefault();
      useRestaurant(result);
    });
    list.appendChild(item);
  });
  list.hidden = false;
}

function fetchSuggestions(term) {
  var params = searchParams();
  params.set("term", term);
  api("/api/search?" + params.toString()).then(function (payload) {
    if (byId("search-form").term.value.trim() !== term) return;
    state.suggestions = payload.results;
    state.suggestionIndex = payload.results.length ? 0 : -1;
    renderSuggestions();
    setMessage("search-message", payload.results.length + " suggestion(s)", "ok");
  }).catch(function (error) {
    state.suggestions = [];
    closeSuggestions();
    setMessage("search-message", error.message, "error");
  });
}

function scheduleTypeahead() {
  if (state.searchTimer) clearTimeout(state.searchTimer);
  var term = byId("search-form").term.value.trim();
  if (term.length < 2) { closeSuggestions(); return; }
  state.searchTimer = setTimeout(function () { fetchSuggestions(term); }, 250);
}

function handleTermKey(event) {
  var list = byId("search-suggestions");
  if (event.key === "Escape") { closeSuggestions(); return; }
  if (list.hidden || !state.suggestions.length) return;
  if (event.key === "ArrowDown") {
    event.preventDefault();
    state.suggestionIndex = Math.min(state.suggestionIndex + 1, state.suggestions.length - 1);
    renderSuggestions();
    return;
  }
  if (event.key === "ArrowUp") {
    event.preventDefault();
    state.suggestionIndex = Math.max(state.suggestionIndex - 1, 0);
    renderSuggestions();
    return;
  }
  if (event.key === "Enter" && state.suggestionIndex >= 0) {
    event.preventDefault();
    useRestaurant(state.suggestions[state.suggestionIndex]);
  }
}

function useRestaurant(result) {
  var form = byId("task-form");
  var search = byId("search-form");
  form.restaurantId.value = result.restaurantId;
  form.restaurantName.value = result.name;
  form.profileUrl.value = result.profileUrl || "";
  if (search.date.value) {
    form.startDate.value = search.date.value;
    form.endDate.value = search.date.value;
  }
  if (search.time.value) {
    form.earliest.value = shiftTime(search.time.value, -30);
    form.latest.value = shiftTime(search.time.value, 30);
    form.preferred.value = search.time.value;
  }
  if (search.partySize.value) form.partySize.value = search.partySize.value;
  search.term.value = result.name;
  closeSuggestions();
  resetProbe();
  byId("preview-panel").hidden = true;
  setMessage("task-message", "Loaded " + result.name + " (" + result.restaurantId + "). Run Check availability to see real times and dining areas.", "info");
}

function populateCategories() {
  var select = byId("task-form").diningCategories;
  clear(select);
  DINING_CATEGORIES.forEach(function (category) {
    var option = document.createElement("option");
    option.value = category;
    option.textContent = category;
    select.appendChild(option);
  });
}

function selectCategories(categories) {
  var select = byId("task-form").diningCategories;
  for (var index = 0; index < select.options.length; index += 1) {
    select.options[index].selected = categories.indexOf(select.options[index].value) >= 0;
  }
}

function syncDiningFields() {
  var form = byId("task-form");
  var mode = form.diningMode.value;
  byId("dining-categories-label").hidden = mode !== "allow";
  byId("dining-labels-label").hidden = mode !== "allow";
  byId("dining-preferences-label").hidden = mode !== "prefer";
  byId("dining-fallback-label").hidden = mode !== "prefer";
}

function parsePreferences(value) {
  return splitList(value).map(function (token) {
    if (token.indexOf("category:") === 0) {
      return { type: "category", value: token.slice("category:".length).trim() };
    }
    return { type: "label", value: token };
  });
}

/** Parses an operator-entered dollar amount like 35 or 35.50; blank means 0. */
function parseDollars(value, label) {
  var trimmed = String(value || "").trim();
  if (!trimmed) return 0;
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) {
    throw new Error(label + " must be a dollar amount like 35 or 35.50");
  }
  return Number(trimmed);
}

function buildTarget() {
  var form = byId("task-form");
  var target = {
    restaurant: {
      id: form.restaurantId.value.trim(),
      name: form.restaurantName.value.trim(),
      timeZone: form.timeZone.value.trim(),
      ...(form.profileUrl.value.trim() ? { profileUrl: form.profileUrl.value.trim() } : {})
    },
    dateRange: {
      startDate: form.startDate.value,
      endDate: form.endDate.value
    },
    partySize: Number(form.partySize.value),
    timeWindow: {
      earliest: form.earliest.value,
      latest: form.latest.value,
      preferred: form.preferred.value
    },
    mode: form.mode.value,
    bookingPolicy: {
      allowPrepaid: form.allowPrepaid.checked,
      maxAuthorizedPrepaidDollars: parseDollars(form.maxAuthorizedPrepaidDollars.value, "Max prepaid deposit"),
      maxAuthorizedCancellationNoShowDollarsPerPerson: parseDollars(form.maxAuthorizedCancellationNoShowDollarsPerPerson.value, "Max cancellation/no-show fee per person"),
      currency: form.currency.value.trim().toUpperCase(),
      allowExperiences: form.allowExperiences.checked,
      allowPaymentMethodRequired: form.allowPaymentMethodRequired.checked,
      autoBookAuthorized: form.autoBookAuthorized.checked
    }
  };
  if (form.mode.value === "known-drop" && form.releaseAt.value) {
    target.knownReservationReleaseAt = localInputToIso(form.releaseAt.value, form.timeZone.value);
  }
  if (form.mode.value === "cancellation-watch" && form.watchStopAt.value) {
    target.cancellationWatchStopAt = localInputToIso(form.watchStopAt.value, form.timeZone.value);
  }
  var diningMode = form.diningMode.value;
  var areas = selectedAreas();
  if (diningMode === "any") {
    target.diningAreaPolicy = { mode: "any", selection: "provider-order" };
  } else if (diningMode === "allow") {
    var categories = unique(selectedValues(form.diningCategories).concat(areas.map(function (area) {
      return area.category;
    })));
    var labels = unique(splitList(form.diningLabels.value).concat(areas.map(function (area) {
      return area.label;
    })));
    if (categories.length + labels.length === 0) {
      throw new Error("Allow mode needs at least one dining area or category: tick an area from Check availability, or add a category or label.");
    }
    target.diningAreaPolicy = {
      mode: "allow",
      categories: categories,
      labels: labels,
      selection: "provider-order"
    };
  } else {
    var preferences = areas.map(function (area) {
      return { type: "label", value: area.label };
    }).concat(parsePreferences(form.diningPreferences.value));
    if (preferences.length === 0) {
      throw new Error("Prefer mode needs at least one preferred area: tick an area from Check availability, or type a label.");
    }
    target.diningAreaPolicy = {
      mode: "prefer",
      preferences: preferences,
      fallback: form.diningFallback.value,
      selection: "provider-order"
    };
  }
  return target;
}

function probeRequest() {
  var form = byId("task-form");
  if (!form.restaurantId.value.trim()) {
    throw new Error("Pick a restaurant first: search above and press Use.");
  }
  if (!form.startDate.value) {
    throw new Error("Set a start date before checking availability.");
  }
  return {
    restaurantId: form.restaurantId.value.trim(),
    restaurantName: form.restaurantName.value.trim(),
    timeZone: form.timeZone.value.trim(),
    date: form.startDate.value,
    partySize: Number(form.partySize.value),
    earliest: form.earliest.value,
    latest: form.latest.value,
    preferred: form.preferred.value
  };
}

function resetProbe() {
  state.probe = null;
  state.selectedAreas = {};
  byId("probe-panel").hidden = true;
  clear(byId("probe-times"));
  clear(byId("probe-area-choices"));
  byId("dining-discovery-hint").hidden = false;
}

function checkAvailability() {
  var request;
  try {
    request = probeRequest();
  } catch (error) {
    setMessage("task-message", error.message, "error");
    return;
  }
  var button = byId("task-probe");
  button.disabled = true;
  setMessage("task-message", "Reading live availability from the paired tab...", "info");
  api("/api/probe", { method: "POST", body: request }).then(function (payload) {
    state.probe = payload.probe;
    state.selectedAreas = {};
    renderProbe();
    setMessage("task-message", "Availability loaded.", "ok");
  }).catch(function (error) {
    setMessage("task-message", error.message, "error");
  }).then(function () {
    button.disabled = false;
  });
}

function renderProbe() {
  var probe = state.probe;
  var panel = byId("probe-panel");
  if (!probe) { panel.hidden = true; return; }
  panel.hidden = false;
  byId("probe-summary").textContent =
    probe.times.length + " available time(s) and " + probe.diningAreas.length +
    " dining area(s) on " + byId("task-form").startDate.value +
    ". Times come from the provider; clicking one sets the preferred time.";

  var times = byId("probe-times");
  clear(times);
  if (!probe.times.length) {
    times.appendChild(el("span", "No times matched this window. Widen the earliest/latest times and probe again.", "hint"));
  }
  var preferred = byId("task-form").preferred.value;
  probe.times.forEach(function (time) {
    var chip = el("button", time, "chip" + (time === preferred ? " selected" : ""));
    chip.type = "button";
    chip.addEventListener("click", function () {
      byId("task-form").preferred.value = time;
      renderProbe();
      byId("preview-panel").hidden = true;
    });
    times.appendChild(chip);
  });

  var choices = byId("probe-area-choices");
  clear(choices);
  byId("dining-discovery-hint").hidden = probe.diningAreas.length > 0;
  if (!probe.diningAreas.length) {
    choices.appendChild(el("span", "No dining areas were discovered for this date and party size.", "hint"));
  }
  probe.diningAreas.forEach(function (area) {
    var key = areaKey(area);
    var label = el("label", null, "check");
    var input = document.createElement("input");
    input.type = "checkbox";
    input.checked = state.selectedAreas[key] === true;
    input.setAttribute("data-category", area.category);
    input.setAttribute("data-label", area.label);
    input.setAttribute("data-order", String(area.providerOrder));
    input.addEventListener("change", function () {
      state.selectedAreas[key] = input.checked;
      if (input.checked && byId("task-form").diningMode.value === "any") {
        byId("task-form").diningMode.value = "allow";
        syncDiningFields();
      }
      byId("preview-panel").hidden = true;
    });
    label.appendChild(input);
    label.appendChild(el("span", area.label + " (" + area.category + ")"));
    choices.appendChild(label);
  });
}

function previewTerms() {
  var target;
  try {
    target = buildTarget();
  } catch (error) {
    setMessage("task-message", error.message, "error");
    return;
  }
  var form = byId("task-form");
  var body = {
    target: target,
    time: form.preferred.value
  };
  var areas = selectedAreas();
  if (areas.length > 0) body.diningAreaLabel = areas[0].label;
  var button = byId("task-preview");
  button.disabled = true;
  setMessage("task-message", "Reading the exact terms for the selected slot...", "info");
  api("/api/preview", { method: "POST", body: body }).then(function (payload) {
    renderPreview(payload.preview);
    setMessage("task-message", "Terms loaded.", "ok");
  }).catch(function (error) {
    byId("preview-panel").hidden = true;
    setMessage("task-message", error.message, "error");
  }).then(function () {
    button.disabled = false;
  });
}

function renderPreview(preview) {
  var panel = byId("preview-panel");
  panel.hidden = false;
  var decision = byId("preview-decision");
  decision.textContent = preview.allowed
    ? "Allowed: the current booking policy authorizes this reservation."
    : "Rejected: the current booking policy would refuse this reservation.";
  decision.className = "decision " + (preview.allowed ? "allowed" : "rejected");

  var reasons = byId("preview-reasons");
  clear(reasons);
  reasons.hidden = preview.reasons.length === 0;
  preview.reasons.forEach(function (reason) {
    reasons.appendChild(el("li", REASON_TEXT[reason] || reason));
  });

  var terms = preview.terms;
  var currency = terms.currency && terms.currency.status === "known" ? terms.currency.code : "unknown";
  var definition = byId("preview-terms");
  clear(definition);
  var rows = [
    ["Slot", terms.localDate + " " + terms.localTime + ", party " + terms.partySize],
    ["Dining area", terms.diningArea ? terms.diningArea.label + " (" + terms.diningArea.category + ")" : "not reported"],
    ["Seating type", terms.seatingType],
    ["Reservation kind", terms.reservationKind && terms.reservationKind.kind ? terms.reservationKind.kind : "unknown"],
    ["Prepaid", describePrepaid(terms.prepaid, currency)],
    ["Cancellation fee", describeFinancial(terms.cancellationFee, currency)],
    ["No-show fee", describeFinancial(terms.noShowFee, currency)],
    ["Currency", currency],
    ["Payment method", terms.paymentRequirement],
    ["Strong customer auth", terms.strongAuthentication],
    ["Ambiguous terms", terms.isAmbiguous ? "yes (fails closed)" : "no"]
  ];
  rows.forEach(function (row) {
    definition.appendChild(el("dt", row[0]));
    definition.appendChild(el("dd", row[1]));
  });
  if (terms.termsSummary) {
    definition.appendChild(el("dt", "Provider summary"));
    definition.appendChild(el("dd", terms.termsSummary));
  }
}

function setEditing(record) {
  state.editing = record === null ? null : { id: record.target.id, version: record.version };
  var editing = state.editing !== null;
  byId("task-submit").textContent = editing ? "Save changes" : "Create task";
  byId("task-cancel").hidden = !editing;
  byId("task-mode").textContent = editing
    ? "Editing " + state.editing.id + " at version " + state.editing.version + ". The task keeps its current state."
    : "New task. Dining areas and times come from Check availability.";
}

function startEdit(record) {
  var target = record.target;
  var form = byId("task-form");
  form.restaurantId.value = target.restaurant.id;
  form.restaurantName.value = target.restaurant.name;
  form.profileUrl.value = target.restaurant.profileUrl || "";
  form.timeZone.value = target.restaurant.timeZone;
  form.partySize.value = target.partySize;
  form.startDate.value = target.dateRange.startDate;
  form.endDate.value = target.dateRange.endDate;
  form.earliest.value = target.timeWindow.earliest;
  form.latest.value = target.timeWindow.latest;
  form.preferred.value = target.timeWindow.preferred;
  form.mode.value = target.mode;
  form.releaseAt.value = target.knownReservationReleaseAt
    ? toLocalInput(target.knownReservationReleaseAt, target.restaurant.timeZone)
    : "";
  form.watchStopAt.value = target.cancellationWatchStopAt
    ? toLocalInput(target.cancellationWatchStopAt, target.restaurant.timeZone)
    : "";
  form.arm.checked = false;

  var policy = target.bookingPolicy;
  form.autoBookAuthorized.checked = policy.autoBookAuthorized;
  form.allowPrepaid.checked = policy.allowPrepaid;
  form.maxAuthorizedPrepaidDollars.value = policy.maxAuthorizedPrepaidDollars;
  form.allowExperiences.checked = policy.allowExperiences;
  form.allowPaymentMethodRequired.checked = policy.allowPaymentMethodRequired;
  form.maxAuthorizedCancellationNoShowDollarsPerPerson.value = policy.maxAuthorizedCancellationNoShowDollarsPerPerson;
  form.currency.value = policy.currency;

  var dining = target.diningAreaPolicy;
  if (dining && dining.mode === "allow") {
    form.diningMode.value = "allow";
    selectCategories(dining.categories);
    form.diningLabels.value = dining.labels.join(", ");
    form.diningPreferences.value = "";
  } else if (dining && dining.mode === "prefer") {
    form.diningMode.value = "prefer";
    selectCategories([]);
    form.diningLabels.value = "";
    form.diningPreferences.value = dining.preferences.map(function (preference) {
      return preference.type === "category" ? "category:" + preference.value : preference.value;
    }).join(", ");
    form.diningFallback.value = dining.fallback;
  } else if (dining && dining.mode === "any") {
    form.diningMode.value = "any";
    selectCategories([]);
    form.diningLabels.value = "";
    form.diningPreferences.value = "";
  } else {
    // Legacy targets carry allowedSeatingTypes instead of a dining area policy.
    form.diningMode.value = target.allowedSeatingTypes ? "allow" : "any";
    selectCategories(unique((target.allowedSeatingTypes || []).map(function (seatingType) {
      return LEGACY_SEATING_CATEGORY[seatingType] || "unknown";
    })));
    form.diningLabels.value = "";
    form.diningPreferences.value = "";
  }
  syncDiningFields();
  syncModeFields();
  resetProbe();
  byId("preview-panel").hidden = true;
  setEditing(record);
  setMessage("task-message", "Loaded " + target.id + " for editing.", "info");
  form.scrollIntoView({ block: "start" });
}

function cancelEdit() {
  setEditing(null);
  resetProbe();
  byId("preview-panel").hidden = true;
  setMessage("task-message", "Edit cancelled. The form still shows the edited values.", "info");
}

function submitTask(event) {
  event.preventDefault();
  var form = byId("task-form");
  var target;
  try {
    target = buildTarget();
  } catch (error) {
    setMessage("task-message", error.message, "error");
    return;
  }
  var editing = state.editing;
  var request = editing === null
    ? api("/api/targets", { method: "POST", body: { target: target, arm: form.arm.checked } })
    : api("/api/targets/" + encodeURIComponent(editing.id), {
        method: "PUT",
        body: { target: target, version: editing.version }
      });
  var submit = byId("task-submit");
  submit.disabled = true;
  setMessage("task-message", editing === null ? "Creating task..." : "Saving changes...", "info");
  request.then(function (payload) {
    setMessage(
      "task-message",
      (editing === null ? "Created " : "Saved ") + payload.target.target.id +
        " in state " + payload.target.state + " (version " + payload.target.version + ")",
      "ok"
    );
    state.editing = null;
    setEditing(null);
    return loadTargets();
  }).catch(function (error) {
    setMessage("task-message", error.message, "error");
  }).then(function () {
    submit.disabled = false;
  });
}

function runSearch(event) {
  event.preventDefault();
  closeSuggestions();
  setMessage("search-message", "Searching through the paired tab...", "info");
  api("/api/search?" + searchParams().toString()).then(function (payload) {
    renderResults(payload.results);
    setMessage("search-message", payload.results.length + " result(s)", "ok");
  }).catch(function (error) {
    setMessage("search-message", error.message, "error");
  });
}

function syncModeFields() {
  var form = byId("task-form");
  var knownDrop = form.mode.value === "known-drop";
  form.releaseAt.disabled = !knownDrop;
  byId("release-at-label").hidden = !knownDrop;
  form.watchStopAt.disabled = knownDrop;
  byId("watch-stop-at-label").hidden = knownDrop;
  var note = byId("mode-hint");
  note.textContent = knownDrop
    ? "The scheduler only runs known-drop tasks that have a release time."
    : "The watcher checks every 30 seconds, chooses the closest available time in the window, and auto-books only when Live mode and policy authorize it.";
  note.className = "hint";
}

function defaultTimes() {
  var form = byId("task-form");
  var search = byId("search-form");
  if (!search.date.value) search.date.value = todayLocal();
  if (!search.time.value) search.time.value = "19:00";
  if (!form.startDate.value) form.startDate.value = search.date.value;
  if (!form.endDate.value) form.endDate.value = search.date.value;
  if (!form.earliest.value) form.earliest.value = "18:30";
  if (!form.latest.value) form.latest.value = "19:30";
  if (!form.preferred.value) form.preferred.value = "19:00";
}

function formatInstant(iso) {
  var parsed = new Date(iso);
  return isNaN(parsed.getTime()) ? String(iso) : parsed.toLocaleTimeString();
}

function sortObservations(slots) {
  return slots.slice().sort(function (left, right) {
    if (left.localDate !== right.localDate) return left.localDate < right.localDate ? -1 : 1;
    if (left.localTime !== right.localTime) return left.localTime < right.localTime ? -1 : 1;
    return 0;
  });
}

function observedChip(slot, detail) {
  var chip = el("span", null, "chip " + (slot.withinWindow ? "in-window" : "out-window"));
  chip.textContent = slot.localDate + " " + slot.localTime;
  var windowText = (slot.withinWindow ? "inside" : "outside") +
    " the " + detail.earliest + "-" + detail.latest + " window";
  var notes = [slot.seatingType, slot.reservationKind, windowText];
  if (slot.diningAreas.length) notes.push("dining areas: " + slot.diningAreas.join(", "));
  if (slot.rejectionReasons.length) notes.push(slot.rejectionReasons.join(", "));
  chip.title = notes.join(" · ");
  return chip;
}

/**
 * Expander under a task row: every open time each availability attempt saw,
 * including times outside the configured window, with when it ran, how long it
 * took, and what the adapter returned.
 */
function availabilityDetailWidget(detail) {
  var box = document.createElement("details");
  box.className = "availability-detail";
  var summary = el("summary");
  summary.textContent = "Availability detail (" + detail.attempts.length +
    (detail.attempts.length === 1 ? " attempt" : " attempts") +
    ", captured " + formatInstant(detail.capturedAt) + ")";
  box.appendChild(summary);
  var overview = el("div", null, "detail-overview");
  // A watcher matches any acceptable time in the window, so the outcome is
  // read from the final attempt rather than from the match flag alone: saying
  // "the preferred time was found" about a 19:15 table would be false.
  var last = detail.attempts[detail.attempts.length - 1];
  var outcome = !detail.matched
    ? " · the preferred time was not found"
    : (last && last.preferredSlots > 0
        ? " · the preferred time was found"
        : " · a bookable time was found in the window");
  overview.textContent = "Preferred " + detail.preferredTime +
    " · window " + detail.earliest + "-" + detail.latest + outcome;
  box.appendChild(overview);
  detail.attempts.forEach(function (attempt, index) {
    var head = el("div", null, "detail-attempt");
    head.textContent = "Attempt " + (index + 1) + " at " + formatInstant(attempt.startedAt) +
      " (" + (attempt.durationMs / 1000).toFixed(2) + "s): " +
      attempt.acceptableSlots + " slot(s) returned, " +
      attempt.observedSlots.length + " open time(s) observed, " +
      attempt.preferredSlots + " at the preferred time";
    box.appendChild(head);
    var chips = el("div", null, "chips");
    if (!attempt.observedSlots.length) {
      chips.appendChild(el("span", "The availability lookup returned no open times at all.", "chip none"));
    }
    sortObservations(attempt.observedSlots).forEach(function (slot) {
      chips.appendChild(observedChip(slot, detail));
    });
    box.appendChild(chips);
  });
  return box;
}

populateCategories();
syncDiningFields();
syncModeFields();
defaultTimes();
setEditing(null);
byId("task-form").diningMode.addEventListener("change", syncDiningFields);
byId("task-form").mode.addEventListener("change", syncModeFields);
byId("task-form").addEventListener("submit", submitTask);
byId("task-cancel").addEventListener("click", cancelEdit);
byId("task-probe").addEventListener("click", checkAvailability);
byId("task-preview").addEventListener("click", previewTerms);
byId("mode-apply").addEventListener("click", changeMode);
byId("search-form").addEventListener("submit", runSearch);
byId("search-form").term.addEventListener("input", scheduleTypeahead);
byId("search-form").term.addEventListener("keydown", handleTermKey);
byId("search-form").term.addEventListener("focus", function () {
  if (state.suggestions.length) renderSuggestions();
});
document.addEventListener("click", function (event) {
  var combo = byId("search-form").term.parentNode;
  if (!combo.contains(event.target)) closeSuggestions();
});
loadStatus();
loadTargets();
setInterval(loadStatus, 5000);
setInterval(loadTargets, 5000);
</script>
</body>
</html>
`;
