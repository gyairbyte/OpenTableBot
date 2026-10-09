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
  .status { font-size: 13px; color: #4b5563; }
  .status.ok { color: #0f7b3f; }
  .status.warn { color: #a2530a; }
  .message { min-height: 20px; font-size: 13px; margin: 8px 0; }
  .message.error { color: #b3261e; }
  .message.ok { color: #0f7b3f; }
  .message.info { color: #4b5563; }
  form.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 10px 14px; align-items: end; }
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
  .banner { padding: 8px 12px; border-radius: 6px; font-size: 13px; margin-bottom: 16px; background: #fff4e5; border: 1px solid #f0c48a; color: #8a4b08; }
  fieldset { border: 1px solid #e5e8ee; border-radius: 6px; padding: 10px 12px; margin: 12px 0 0; }
  legend { font-size: 12px; color: #4b5563; padding: 0 4px; }
  .hint { font-size: 12px; color: #6b7280; margin-top: 6px; }
</style>
</head>
<body>
<header>
  <h1>OpenTableBot console</h1>
  <div id="status" class="status">Loading status...</div>
</header>

<div id="banner" class="banner" hidden></div>

<section>
  <h2>Find a restaurant</h2>
  <form id="search-form" class="grid">
    <label>Search term<input name="term" placeholder="Catch, sushi, Italian" required></label>
    <label>Date<input name="date" type="date"></label>
    <label>Time<input name="time" type="time"></label>
    <label>Party size<input name="partySize" type="number" min="1" max="50" value="2"></label>
    <label>&nbsp;<button type="submit">Search</button></label>
  </form>
  <div id="search-message" class="message"></div>
  <table id="search-results" hidden>
    <thead><tr><th>Restaurant</th><th>Id</th><th>Details</th><th></th></tr></thead>
    <tbody id="search-body"></tbody>
  </table>
  <div class="hint">Searching uses the paired OpenTable tab, so keep one OpenTable page open.</div>
</section>

<section>
  <h2>Reservation task</h2>
  <form id="task-form" class="grid">
    <label>Restaurant id<input name="restaurantId" required></label>
    <label>Restaurant name<input name="restaurantName" required></label>
    <label>Time zone<input name="timeZone" value="America/New_York" required></label>
    <label>Party size<input name="partySize" type="number" min="1" max="20" value="2" required></label>
    <label>Start date<input name="startDate" type="date" required></label>
    <label>End date<input name="endDate" type="date" required></label>
    <label>Earliest time<input name="earliest" type="time" required></label>
    <label>Latest time<input name="latest" type="time" required></label>
    <label>Preferred time<input name="preferred" type="time" required></label>
    <label>Mode
      <select name="mode">
        <option value="known-drop">known-drop (release time)</option>
        <option value="cancellation-watch">cancellation-watch</option>
      </select>
    </label>
    <label>Release time (known-drop)<input name="releaseAt" type="datetime-local"></label>
    <label>Dining area policy
      <select name="diningMode">
        <option value="any">any</option>
        <option value="allow">allow listed areas</option>
        <option value="prefer">prefer listed areas</option>
      </select>
    </label>
    <label id="dining-categories-label" hidden>Allowed categories
      <select name="diningCategories" multiple size="4"></select>
    </label>
    <label id="dining-labels-label" hidden>Allowed labels (comma separated)<input name="diningLabels"></label>
    <label id="dining-preferences-label" hidden>Preferred labels (comma separated)<input name="diningPreferences"></label>
    <label id="dining-fallback-label" hidden>Fallback
      <select name="diningFallback"><option value="any">any</option><option value="none">none</option></select>
    </label>
  </form>

  <fieldset>
    <legend>Booking policy (fail-closed)</legend>
    <form id="policy-form" class="grid">
      <label class="check"><input name="autoBookAuthorized" type="checkbox"> Authorize automatic booking</label>
      <label class="check"><input name="allowPrepaid" type="checkbox"> Allow prepaid reservations</label>
      <label>Max prepaid cents<input name="maxAuthorizedPrepaidCents" type="number" min="0" value="0"></label>
      <label class="check"><input name="allowExperiences" type="checkbox"> Allow experiences</label>
      <label class="check"><input name="allowPaymentMethodRequired" type="checkbox"> Allow payment method required</label>
      <label>Max cancellation/no-show cents<input name="maxAuthorizedCancellationNoShowCents" type="number" min="0" value="0"></label>
      <label>Currency<input name="currency" value="USD" maxlength="3"></label>
    </form>
  </fieldset>

  <form id="task-actions" class="grid">
    <label class="check"><input name="arm" type="checkbox"> Arm immediately</label>
    <label>&nbsp;<button type="submit">Create task</button></label>
  </form>
  <div id="task-message" class="message"></div>
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

function loadStatus() {
  return api("/api/status").then(function (payload) {
    var status = payload.status;
    var parts = [
      "mode " + status.mode,
      "bridge " + (status.bridgeReachable ? "reachable" : "unreachable"),
      "session " + (status.authenticated ? "authenticated" : "not authenticated")
    ];
    if (status.lastTickAt) parts.push("last scheduler check " + status.lastTickAt);
    if (status.lastTickError) parts.push("scheduler error " + status.lastTickError);
    var node = byId("status");
    node.textContent = parts.join("  |  ");
    node.className = "status " + (status.bridgeReachable && status.authenticated ? "ok" : "warn");
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

function loadTargets() {
  return api("/api/targets").then(function (payload) {
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
    row.appendChild(el("td", record.target.mode + (record.target.knownReservationReleaseAt ? " at " + record.target.knownReservationReleaseAt : "")));
    row.appendChild(el("td", record.state, "state state-" + record.state.toLowerCase()));
    var detail = "";
    if (record.confirmation) detail = "confirmation " + record.confirmation.confirmationId + " at " + record.confirmation.startsAt;
    else if (record.pauseReason) detail = record.pauseReason;
    row.appendChild(el("td", detail));
    var actions = el("td", null, "actions");
    if (record.state === "DRAFT" || record.state === "PAUSED") {
      actions.appendChild(actionButton("Arm", "arm", record));
    }
    if (["DRAFT", "ARMED", "WAITING", "MATCH_FOUND", "VALIDATING", "LOCKING", "LOCKED", "REVALIDATING", "SUBMITTING"].indexOf(record.state) >= 0) {
      actions.appendChild(actionButton("Pause", "pause", record));
    }
    actions.appendChild(actionButton("Delete", "delete", record));
    row.appendChild(actions);
    body.appendChild(row);
  });
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

function useRestaurant(result) {
  var form = byId("task-form");
  form.restaurantId.value = result.restaurantId;
  form.restaurantName.value = result.name;
  var search = byId("search-form");
  var date = search.date.value;
  var time = search.time.value;
  if (date) {
    form.startDate.value = date;
    form.endDate.value = date;
  }
  if (time) {
    form.earliest.value = shiftTime(time, -30);
    form.latest.value = shiftTime(time, 30);
    form.preferred.value = time;
  }
  if (search.partySize.value) form.partySize.value = search.partySize.value;
  setMessage("task-message", "Loaded " + result.name + ". Complete the task and create it.", "info");
  form.restaurantId.focus();
}

function buildTarget() {
  var form = byId("task-form");
  var policy = byId("policy-form");
  var target = {
    restaurant: {
      id: form.restaurantId.value.trim(),
      name: form.restaurantName.value.trim(),
      timeZone: form.timeZone.value.trim()
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
      allowPrepaid: policy.allowPrepaid.checked,
      maxAuthorizedPrepaidCents: Number(policy.maxAuthorizedPrepaidCents.value || 0),
      maxAuthorizedCancellationNoShowCents: Number(policy.maxAuthorizedCancellationNoShowCents.value || 0),
      currency: policy.currency.value.trim().toUpperCase(),
      allowExperiences: policy.allowExperiences.checked,
      allowPaymentMethodRequired: policy.allowPaymentMethodRequired.checked,
      autoBookAuthorized: policy.autoBookAuthorized.checked
    }
  };
  if (form.releaseAt.value) {
    target.knownReservationReleaseAt = new Date(form.releaseAt.value).toISOString();
  }
  var diningMode = form.diningMode.value;
  if (diningMode === "any") {
    target.diningAreaPolicy = { mode: "any", selection: "provider-order" };
  } else if (diningMode === "allow") {
    target.diningAreaPolicy = {
      mode: "allow",
      categories: selectedValues(form.diningCategories),
      labels: splitList(form.diningLabels.value),
      selection: "provider-order"
    };
  } else {
    target.diningAreaPolicy = {
      mode: "prefer",
      preferences: splitList(form.diningPreferences.value).map(function (label) {
        return { type: "label", value: label };
      }),
      fallback: form.diningFallback.value,
      selection: "provider-order"
    };
  }
  return target;
}

function createTask(event) {
  event.preventDefault();
  var arm = byId("task-actions").arm.checked;
  var body;
  try {
    body = { target: buildTarget(), arm: arm };
  } catch (error) {
    setMessage("task-message", error.message, "error");
    return;
  }
  setMessage("task-message", "Creating task...", "info");
  api("/api/targets", { method: "POST", body: body }).then(function (payload) {
    setMessage("task-message", "Created " + payload.target.target.id + " in state " + payload.target.state, "ok");
    return loadTargets();
  }).catch(function (error) {
    setMessage("task-message", error.message, "error");
  });
}

function runSearch(event) {
  event.preventDefault();
  var form = byId("search-form");
  var params = new URLSearchParams();
  params.set("term", form.term.value.trim());
  if (form.date.value) params.set("date", form.date.value);
  if (form.time.value) params.set("time", form.time.value);
  if (form.partySize.value) params.set("partySize", form.partySize.value);
  setMessage("search-message", "Searching through the paired tab...", "info");
  api("/api/search?" + params.toString()).then(function (payload) {
    renderResults(payload.results);
    setMessage("search-message", payload.results.length + " result(s)", "ok");
  }).catch(function (error) {
    setMessage("search-message", error.message, "error");
  });
}

function syncDiningFields() {
  var form = byId("task-form");
  var mode = form.diningMode.value;
  byId("dining-categories-label").hidden = mode !== "allow";
  byId("dining-labels-label").hidden = mode !== "allow";
  byId("dining-preferences-label").hidden = mode !== "prefer";
  byId("dining-fallback-label").hidden = mode !== "prefer";
}

function populateCategories() {
  var select = byId("task-form").diningCategories;
  DINING_CATEGORIES.forEach(function (category) {
    var option = document.createElement("option");
    option.value = category;
    option.textContent = category;
    select.appendChild(option);
  });
}

populateCategories();
syncDiningFields();
byId("task-form").diningMode.addEventListener("change", syncDiningFields);
byId("search-form").addEventListener("submit", runSearch);
byId("task-actions").addEventListener("submit", createTask);
loadStatus();
loadTargets();
setInterval(loadStatus, 10000);
setInterval(loadTargets, 15000);
</script>
</body>
</html>
`;
