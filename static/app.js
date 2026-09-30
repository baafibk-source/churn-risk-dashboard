"use strict";
/* Churn risk dashboard. No framework, no build step.
   Every piece of text (including anything from the API or the LLM) goes in via
   textContent / createTextNode. innerHTML is never used. */

// ---------------------------------------------------------------- DOM helpers
const SVGNS = "http://www.w3.org/2000/svg";
const PROPS = new Set(["value", "checked", "disabled", "hidden", "open", "selected"]);

function attrs(el, props) {
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "style" || /^on/i.test(k)) throw new Error("unsafe attribute " + k);
    if (k === "class") el.setAttribute("class", v);
    else if (k === "text") el.textContent = String(v);
    else if (k === "events") for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
    else if (PROPS.has(k)) el[k] = v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  return el;
}
function add(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return el;
}
const h = (tag, props, ...kids) => add(attrs(document.createElement(tag), props), kids);
const s = (tag, props, ...kids) => add(attrs(document.createElementNS(SVGNS, tag), props), kids);
const $ = (sel, root = document) => root.querySelector(sel);

// ---------------------------------------------------------------- formatting
const pct = (x, d = 0) => (x * 100).toFixed(d) + "%";
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const usd2 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });
const usdK = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 });
const int = new Intl.NumberFormat("en-US");
const num1 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const signed = (x) => (x > 0 ? "+" : "−") + Math.abs(x).toFixed(2);

// ---------------------------------------------------------------- API
async function api(path, opts = {}) {
  const init = { headers: { Accept: "application/json" }, ...opts };
  if (opts.body) init.headers["Content-Type"] = "application/json";
  let r;
  try { r = await fetch(path, init); } catch { throw new Error("Network error. Please try again."); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(typeof data.error === "string" ? data.error : "Request failed.");
  return data;
}
const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== "" && v != null)).toString();
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

// ---------------------------------------------------------------- state
const DEFAULTS = { target_share: 0.2, save_rate: 0.25, contact_cost: 15, offer_cost: 60, horizon_months: 12 };
const state = { config: null, report: null, assume: { ...DEFAULTS }, built: {} };
const OPTIONS = {
  contract: ["Month-to-month", "One year", "Two year"],
  internet_service: ["Fiber optic", "DSL", "No"],
  risk_band: ["High", "Medium", "Low"],
  payment_method: ["Electronic check", "Mailed check", "Bank transfer (automatic)", "Credit card (automatic)"],
};

// ---------------------------------------------------------------- theme
const THEMES = ["auto", "light", "dark"];
function storedTheme() { try { return localStorage.getItem("theme") || "auto"; } catch { return "auto"; } }
function applyTheme(t) {
  if (t === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", t);
  const btn = $("#theme");
  btn.textContent = "Theme: " + t;
  btn.setAttribute("aria-label", "Colour theme: " + t + ". Click to change.");
}
function initTheme() {
  let t = new URLSearchParams(location.search).get("theme");
  if (!THEMES.includes(t)) t = storedTheme();
  applyTheme(t);
  $("#theme").addEventListener("click", () => {
    const next = THEMES[(THEMES.indexOf(storedTheme()) + 1) % THEMES.length];
    try { localStorage.setItem("theme", next); } catch { /* storage unavailable */ }
    applyTheme(next);
  });
}

// ---------------------------------------------------------------- tooltip
const tip = () => $("#tooltip");
function showTip(evt, lines) {
  const t = tip();
  t.replaceChildren(...lines.map((l, i) => h(i ? "div" : "strong", { text: l })));
  t.hidden = false;
  let x, y;
  if (evt.clientX != null && evt.type.startsWith("pointer")) { x = evt.clientX; y = evt.clientY; }
  else { const r = evt.target.getBoundingClientRect(); x = r.left + r.width / 2; y = r.top; }
  const w = t.offsetWidth, hh = t.offsetHeight;
  t.style.left = Math.min(Math.max(8, x - w / 2), window.innerWidth - w - 8) + "px";
  t.style.top = (y - hh - 12 < 8 ? y + 16 : y - hh - 12) + "px";
}
function hideTip() { tip().hidden = true; }
function hover(el, linesFn) {
  el.setAttribute("tabindex", "0");
  el.addEventListener("pointerenter", (e) => showTip(e, linesFn()));
  el.addEventListener("pointermove", (e) => showTip(e, linesFn()));
  el.addEventListener("pointerleave", hideTip);
  el.addEventListener("focus", (e) => showTip(e, linesFn()));
  el.addEventListener("blur", hideTip);
  el.append(s("title", { text: linesFn().join(". ") }));
  return el;
}

// ---------------------------------------------------------------- responsive charts
const charts = new Map();
const ro = new ResizeObserver((entries) => {
  for (const e of entries) {
    const c = charts.get(e.target);
    const w = Math.round(e.contentRect.width);
    if (c && w > 0 && w !== c.w) { c.w = w; e.target.replaceChildren(c.draw(w)); }
  }
});
function chart(draw, label) {
  const el = h("div", { class: "chart", role: "img", "aria-label": label });
  charts.set(el, { draw, w: 0 });
  ro.observe(el);
  return el;
}

// ---------------------------------------------------------------- shared pieces
function bandPill(band) {
  return h("span", { class: "pill" }, h("span", { class: "dot " + band, "aria-hidden": "true" }), band + " risk");
}
function field(label, input, out) {
  const id = "f-" + Math.random().toString(36).slice(2, 9);
  input.id = id;
  return h("div", { class: "field" }, h("label", { for: id }, label, out ? [" ", out] : null), input);
}
function select(options, value, allLabel) {
  const el = h("select", {}, allLabel ? h("option", { value: "", text: allLabel }) : null,
    options.map((o) => h("option", { value: o, text: o, selected: o === value })));
  return el;
}

function meter(prob) {
  const { high, medium } = state.config.risk_bands;
  return chart((W) => {
    const H = 56, y = 8, bh = 10, x = (v) => v * W;
    const zones = [[0, medium, "Low"], [medium, high, "Medium"], [high, 1, "High"]];
    return s("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H },
      zones.map(([a, b, l], i) => [
        s("rect", { class: "zone", x: x(a) + (i ? 1 : 0), y, width: x(b) - x(a) - (i ? 1 : 0), height: bh, rx: i === 0 || i === 2 ? 4 : 0 }),
        s("text", { class: "axis-label", x: (x(a) + x(b)) / 2, y: y + bh + 16, "text-anchor": "middle", text: l }),
        i ? s("text", { class: "axis-label", x: x(a), y: y + bh + 30, "text-anchor": "middle", text: pct(a) }) : null,
      ]),
      s("rect", { class: "marker", x: Math.min(Math.max(x(prob) - 2, 0), W - 4), y: y - 6, width: 4, height: bh + 12, rx: 2 }));
  }, `Churn probability ${pct(prob)} on a scale from 0 to 100 percent`);
}

function driverChart(drivers) {
  const rows = drivers.slice(0, 8);
  const max = Math.max(0.2, ...rows.map((d) => Math.abs(d.impact)));
  return chart((W) => {
    const labelW = Math.min(170, Math.max(118, W * 0.38)), rowH = 38, top = 4;
    const plotW = W - labelW - 44, mid = labelW + 22 + plotW / 2, half = plotW / 2;
    const H = top + rows.length * rowH + 4;
    return s("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H },
      s("line", { class: "base", x1: mid, x2: mid, y1: 0, y2: H }),
      rows.map((d, i) => {
        const y = top + i * rowH, len = Math.max(2, (Math.abs(d.impact) / max) * half);
        const up = d.impact > 0;
        const g = s("g", {},
          s("text", { x: 0, y: y + 14, class: "val", text: d.label }),
          s("text", { x: 0, y: y + 30, class: "axis-label", text: d.value }),
          s("rect", { class: up ? "bar-raise" : "bar-lower", x: up ? mid : mid - len, y: y + 10, width: len, height: 14, rx: 3 }),
          s("text", { class: "axis-label", x: up ? mid + len + 4 : mid - len - 4, y: y + 21, "text-anchor": up ? "start" : "end", text: signed(d.impact) }),
          s("rect", { class: "hit", x: 0, y, width: W, height: rowH }));
        return hover(g, () => [`${d.label}: ${d.value}`, `${up ? "Raises" : "Lowers"} churn risk`,
          `${signed(d.impact)} to calibrated log-odds`]);
      }));
  }, "SHAP drivers: " + rows.map((d) => `${d.label} ${d.value} ${d.impact > 0 ? "raises" : "lowers"} risk`).join("; "));
}

function actionBox(action) {
  return h("div", { class: "action-box" },
    h("p", { class: "channel", text: action.channel }),
    action.steps.length ? h("ol", {}, action.steps.map((st) =>
      h("li", {}, st.action, " ", h("span", { class: "because", text: "(driver: " + st.because + ")" })))) : null);
}

function assistantBlock(customerId) {
  const cfg = state.config;
  const out = h("div", { "aria-live": "polite" });
  const q = h("input", { type: "text", maxlength: cfg.question_max_chars, placeholder: "Ask about this customer, e.g. why is the risk high?", "aria-label": "Question for the assistant" });
  const brief = h("button", { class: "btn", type: "button", text: "Brief me" });
  const askBtn = h("button", { class: "btn primary", type: "button", text: "Ask" });
  async function run(question) {
    brief.disabled = askBtn.disabled = true;
    out.replaceChildren(h("p", { class: "notice", text: "Thinking…" }));
    try {
      const body = { customer_id: customerId };
      if (question) body.question = question;
      const r = await api("/api/assistant", { method: "POST", body: JSON.stringify(body) });
      out.replaceChildren(
        h("div", { class: "answer" }, h("span", { class: "src", text: r.source === "ai" ? "AI answer" : "Template briefing" }), r.text),
        r.notice ? h("p", { class: "notice", text: r.notice }) : null);
    } catch (e) {
      out.replaceChildren(h("p", { class: "notice error", text: e.message }));
    } finally { brief.disabled = askBtn.disabled = false; }
  }
  brief.addEventListener("click", () => run(null));
  askBtn.addEventListener("click", () => { const v = q.value.trim(); if (v) run(v); });
  q.addEventListener("keydown", (e) => { if (e.key === "Enter") askBtn.click(); });
  return h("div", { class: "assistant" },
    h("h3", { text: "Retention assistant" }),
    h("p", { class: "notice", text: cfg.assistant_enabled
      ? "Open-source LLM via Hugging Face. It only explains the model's output and is rate-limited."
      : "AI is off on this copy (no HF_TOKEN), so you get a template briefing built from the same drivers." }),
    h("div", { class: "assistant-row" }, brief),
    cfg.assistant_enabled ? h("div", { class: "assistant-row" }, q, askBtn) : null,
    out);
}

function customerMeta(d) {
  const p = d.profile;
  return h("p", { class: "meta-line" },
    `${d.id} · ${p.contract} · ${p.tenure_months} month${p.tenure_months === 1 ? "" : "s"} · ${usd2.format(p.monthly_charges)}/mo · ${p.internet_service === "No" ? "no internet" : p.internet_service} · ${p.payment_method}`);
}

function resultView(d, { whatIf = null, showOutcome = true } = {}) {
  return h("div", {},
    h("div", { class: "result-top" },
      h("div", {},
        h("div", { class: "section-label", text: whatIf ? "What-if churn probability (calibrated)" : "Calibrated churn probability" }),
        h("div", { class: "big-prob", text: pct(d.probability) })),
      bandPill(d.band)),
    d.profile ? customerMeta(d) : null,
    showOutcome && d.churned != null ? h("p", { class: "outcome", text: `Outcome in the historical data: ${d.churned ? "left this quarter" : "stayed"}. The model did not see this.` }) : null,
    h("div", { class: "meter" }, meter(d.probability)),
    h("div", { class: "section-label", text: "What drives this score (SHAP)" }),
    h("div", { class: "legend" }, h("span", {}, h("i", { class: "sw raise" }), "raises risk"), h("span", {}, h("i", { class: "sw lower" }), "lowers risk")),
    driverChart(d.drivers),
    h("p", { class: "notice", text: "Bar length is the driver's contribution to the calibrated log-odds of churn. These are associations in the model, not proven causes." }),
    h("div", { class: "section-label", text: "Suggested retention action" }),
    actionBox(d.action));
}

// ---------------------------------------------------------------- overview
function tile(id, label) {
  return h("div", { class: "card tile", id },
    h("div", { class: "label", "data-k": "label", text: label }),
    h("div", { class: "value", "data-k": "value", text: "…" }),
    h("p", { class: "note", "data-k": "note", text: "" }));
}
function setTile(id, value, label, note) {
  const t = document.getElementById(id);
  $("[data-k=value]", t).textContent = value;
  if (label) $("[data-k=label]", t).textContent = label;
  $("[data-k=note]", t).textContent = note;
}

async function refreshSummary() {
  const tiles = $("#tiles");
  tiles.classList.add("stale");
  try {
    const r = await api("/api/summary?" + qs(state.assume));
    setTile("t-auc", r.roc_auc.toFixed(3), "ROC AUC on held-out customers", "1.0 ranks perfectly, 0.5 is a coin flip");
    setTile("t-reach", pct(r.share_of_churners_reached),
      `Churners reached by contacting the riskiest ${pct(r.target_share)}`,
      `${int.format(r.churners_reached)} of ${int.format(r.churners_total)} churners in ${int.format(r.contacted)} contacts`);
    setTile("t-risk", usdK.format(r.revenue_at_risk), `Revenue at risk over the next ${r.assumptions.horizon_months} months`,
      `${num1.format(r.expected_churners)} expected churners (sum of calibrated probabilities)`);
    setTile("t-save", usdK.format(r.campaign.net_saving), "Estimated net saving from a retention campaign",
      `${num1.format(r.campaign.expected_saved_customers)} kept: ${usdK.format(r.campaign.revenue_retained)} revenue minus ${usdK.format(r.campaign.cost)} cost`);
    $("#assume-err").textContent = "";
  } catch (e) {
    $("#assume-err").textContent = e.message;
  } finally { tiles.classList.remove("stale"); }
}

function assumptionsCard() {
  const a = state.assume;
  const inputs = {};
  const outs = {};
  const range = (k, min, max, step, fmt) => {
    outs[k] = h("output", { text: fmt(a[k]) });
    inputs[k] = h("input", { type: "range", min, max, step, value: String(a[k]) });
    inputs[k].addEventListener("input", () => { outs[k].textContent = fmt(Number(inputs[k].value)); });
    return inputs[k];
  };
  const numIn = (k, min, max, step) => (inputs[k] = h("input", { type: "number", min, max, step, value: String(a[k]), inputmode: "decimal" }));
  const fmtPct = (v) => pct(v);
  const refresh = debounce(refreshSummary, 250);
  const onChange = () => {
    for (const [k, el] of Object.entries(inputs)) {
      let v = Number(el.value);
      if (!Number.isFinite(v)) continue;
      v = Math.min(Number(el.max), Math.max(Number(el.min), v));
      a[k] = k === "horizon_months" ? Math.round(v) : v;
    }
    refresh();
  };
  const fields = h("div", { class: "fields" },
    field("Customers contacted (riskiest first):", range("target_share", 0.05, 1, 0.05, fmtPct), outs.target_share),
    field("Save rate: would-be churners who stay after contact:", range("save_rate", 0, 1, 0.05, fmtPct), outs.save_rate),
    field("Cost per contact ($)", numIn("contact_cost", 0, 500, 1)),
    field("Incentive per customer kept ($)", numIn("offer_cost", 0, 2000, 5)),
    field("Months of revenue kept per saved customer", numIn("horizon_months", 1, 36, 1)));
  fields.addEventListener("input", onChange);
  // Show the clamped value once the user leaves the field, so the box matches the maths.
  fields.addEventListener("change", () => { for (const [k, el] of Object.entries(inputs)) el.value = String(a[k]); });
  const reset = h("button", { class: "btn", type: "button", text: "Reset assumptions" });
  reset.addEventListener("click", () => {
    Object.assign(a, DEFAULTS);
    for (const [k, el] of Object.entries(inputs)) el.value = String(a[k]);
    for (const [k, o] of Object.entries(outs)) o.textContent = fmtPct(a[k]);
    refreshSummary();
  });
  const det = h("details", { class: "card assume", open: window.innerWidth > 560 },
    h("summary", { text: "Campaign assumptions (edit me)" }),
    h("p", { class: "card-sub", text: "Change these and the headline numbers update. The defaults are illustrative, not measured." }),
    fields,
    h("div", { class: "formula" },
      h("div", { text: "Revenue at risk = Σ calibrated churn probability × monthly bill × months." }),
      h("div", { text: "Net saving = save rate × Σ (probability × monthly bill × months) over contacted customers − contacts × cost per contact − customers kept × incentive." }),
      h("div", { text: "Revenue, not profit: the data has no margins. Assumes a churner's bill is lost for the whole period, and that contact does not change who would have stayed anyway." })),
    h("p", { class: "notice error", id: "assume-err", role: "alert" }),
    reset);
  return det;
}

function whatIfForm(base, onResult) {
  const p = base.profile;
  const tenure = h("input", { type: "range", min: 0, max: 72, step: 1, value: String(p.tenure_months) });
  const tOut = h("output", { text: p.tenure_months + " months" });
  const monthly = h("input", { type: "number", min: 18, max: 120, step: 0.05, value: String(p.monthly_charges), inputmode: "decimal" });
  const contract = select(OPTIONS.contract, p.contract);
  const payment = select(OPTIONS.payment_method, p.payment_method);
  const err = h("p", { class: "notice error", role: "alert" });
  const run = debounce(async () => {
    const m = Number(monthly.value), t = Number(tenure.value);
    if (!(m >= 18 && m <= 120)) { err.textContent = "Monthly charges must be between $18 and $120."; return; }
    const changed = t !== p.tenure_months || m !== p.monthly_charges;
    const profile = { ...p, tenure_months: t, monthly_charges: m, contract: contract.value, payment_method: payment.value,
      total_charges: changed ? null : p.total_charges };
    try {
      const r = await api("/api/score", { method: "POST", body: JSON.stringify(profile) });
      err.textContent = "";
      onResult({ ...r, profile, id: base.id + " (what-if)", churned: null });
    } catch (e) { err.textContent = e.message; }
  }, 200);
  tenure.addEventListener("input", () => { tOut.textContent = tenure.value + " months"; run(); });
  for (const el of [monthly, contract, payment]) el.addEventListener("input", run);
  const reset = h("button", { class: "btn", type: "button", text: "Back to the real customer" });
  reset.addEventListener("click", () => onResult(null));
  return h("details", { class: "whatif" },
    h("summary", { text: "What if? Change this customer and re-score live" }),
    h("div", { class: "fields" },
      field("Tenure:", tenure, tOut), field("Monthly charges ($)", monthly),
      field("Contract", contract), field("Payment method", payment)),
    h("p", { class: "notice", text: "If tenure or charges change, total charges are re-estimated as monthly × tenure." }),
    err, reset);
}

async function showPreset(key, card) {
  const preset = state.config.presets.find((p) => p.key === key);
  for (const b of card.querySelectorAll(".preset")) b.setAttribute("aria-pressed", String(b.dataset.key === key));
  const area = $("#preset-result", card);
  area.classList.add("stale");
  try {
    const d = await api("/api/customers/" + encodeURIComponent(preset.customer_id));
    const main = h("div", {});
    const render = (wi) => main.replaceChildren(resultView(wi || d, { whatIf: wi }));
    render(null);
    area.replaceChildren(main, whatIfForm(d, render), assistantBlock(d.id));
  } catch (e) {
    area.replaceChildren(h("p", { class: "error", text: e.message }));
  } finally { area.classList.remove("stale"); }
}

function editLink() {
  const b = h("button", { class: "linkish", type: "button", text: "Edit assumptions" });
  b.addEventListener("click", () => {
    const d = $("details.assume");
    d.open = true;
    d.scrollIntoView({ behavior: "smooth", block: "start" });
    $("summary", d).focus({ preventScroll: true });
  });
  return b;
}

function buildOverview(root) {
  const presetCard = h("div", { class: "card" },
    h("h3", { text: "Try an example customer" }),
    h("p", { class: "card-sub", text: "Real held-out customers from the dataset. One click shows the score, why, and what to do." }),
    h("div", { class: "presets", role: "group", "aria-label": "Example customers" },
      state.config.presets.map((p) => {
        const b = h("button", { class: "btn preset", type: "button", "aria-pressed": "false", "data-key": p.key },
          h("span", { class: "p-title" }, h("span", { class: "dot " + p.label.split(" ")[0], "aria-hidden": "true" }), p.label),
          h("span", { class: "p-blurb", text: p.blurb }));
        b.addEventListener("click", () => showPreset(p.key, presetCard));
        return b;
      })),
    h("div", { id: "preset-result", class: "section-gap" }));
  root.append(
    h("div", { class: "view-head" }, h("h2", { id: "h-overview", text: "Overview" }),
      h("p", { text: "Scores every customer with a calibrated churn probability, so expected churners and revenue at risk add up to real counts and dollars." })),
    h("div", { class: "grid-4", id: "tiles" },
      tile("t-auc", "ROC AUC"), tile("t-reach", "Churners reached"), tile("t-risk", "Revenue at risk"),
      add(tile("t-save", "Net saving"), [editLink()])),
    h("div", { class: "grid-2" }, presetCard, assumptionsCard()));
  refreshSummary();
  showPreset("high", presetCard);
}

// ---------------------------------------------------------------- segments
const GROUP_BY = [["contract", "Contract"], ["tenure_band", "Tenure"], ["internet_service", "Internet"],
  ["protection", "Protection add-ons"], ["tech_support", "Tech support"], ["payment_method", "Payment"]];

function filterRow(filters, onChange) {
  const mk = (k, label, opts) => {
    const el = select(opts, filters[k], "All");
    el.addEventListener("change", () => { filters[k] = el.value; onChange(); });
    return field(label, el);
  };
  return [mk("contract", "Contract", OPTIONS.contract), mk("internet_service", "Internet service", OPTIONS.internet_service),
    mk("tenure_band", "Tenure band", state.config.tenure_bands), mk("risk_band", "Risk band", OPTIONS.risk_band)];
}

function segmentChart(rows) {
  const max = Math.min(1, Math.ceil(Math.max(0.1, ...rows.map((r) => Math.max(r.avg_risk, r.actual_churn_rate))) * 10) / 10);
  return chart((W) => {
    const labelW = Math.min(180, Math.max(110, W * 0.3)), rowH = 44, top = 22, right = 48;
    const plotW = W - labelW - right, x = (v) => labelW + (v / max) * plotW;
    const H = top + rows.length * rowH + 8;
    const ticks = []; for (let t = 0; t <= max + 1e-9; t += max > 0.5 ? 0.2 : 0.1) ticks.push(t);
    return s("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H },
      ticks.map((t) => [s("line", { class: t === 0 ? "base" : "grid", x1: x(t), x2: x(t), y1: top - 4, y2: H - 4 }),
        s("text", { class: "axis-label", x: x(t), y: 12, "text-anchor": "middle", text: pct(t) })]),
      rows.map((r, i) => {
        const y = top + i * rowH;
        const g = s("g", {},
          s("text", { class: "val", x: 0, y: y + 17, text: r.segment }),
          s("text", { class: "axis-label", x: 0, y: y + 33, text: int.format(r.customers) + " customers" }),
          s("rect", { class: "s1", x: labelW, y: y + 8, width: Math.max(2, x(r.avg_risk) - labelW), height: 18, rx: 4 }),
          s("line", { class: "tick-actual", x1: x(r.actual_churn_rate), x2: x(r.actual_churn_rate), y1: y + 4, y2: y + 30 }),
          s("text", { class: "val", x: Math.max(x(r.avg_risk), x(r.actual_churn_rate)) + 6, y: y + 22, text: pct(r.avg_risk) }),
          s("rect", { class: "hit", x: 0, y, width: W, height: rowH }));
        return hover(g, () => [r.segment, `Predicted (calibrated): ${pct(r.avg_risk, 1)}`, `Actual churn in data: ${pct(r.actual_churn_rate, 1)}`,
          `${num1.format(r.expected_churners)} expected churners · ${usd.format(r.revenue_at_risk_monthly)}/mo at risk`]);
      }));
  }, "Average predicted churn risk by segment: " + rows.map((r) => `${r.segment} ${pct(r.avg_risk)}`).join(", "));
}

function buildSegments(root) {
  const st = { by: "contract", filters: { contract: "", internet_service: "", tenure_band: "", risk_band: "" } };
  const body = h("div", {});
  const byBtns = GROUP_BY.map(([k, label]) => {
    const b = h("button", { class: "btn", type: "button", "aria-pressed": String(k === st.by), text: label });
    b.addEventListener("click", () => { st.by = k; byBtns.forEach((x, i) => x.setAttribute("aria-pressed", String(GROUP_BY[i][0] === k))); load(); });
    return b;
  });
  async function load() {
    body.classList.add("stale");
    try {
      const r = await api("/api/segments?" + qs({ by: st.by, ...st.filters }));
      const label = GROUP_BY.find(([k]) => k === st.by)[1];
      if (!r.rows.length) { body.replaceChildren(h("div", { class: "card" }, h("p", { text: "No customers match these filters." }))); return; }
      const tot = { ec: r.totals.expected_churners, rev: r.totals.revenue_at_risk_monthly, hi: r.totals.high_risk_customers };
      body.replaceChildren(
        h("div", { class: "grid-4" },
          h("div", { class: "card tile" }, h("div", { class: "label", text: "Customers in view" }), h("div", { class: "value", text: int.format(r.filtered_customers) })),
          h("div", { class: "card tile" }, h("div", { class: "label", text: "Expected churners" }), h("div", { class: "value", text: num1.format(tot.ec) })),
          h("div", { class: "card tile" }, h("div", { class: "label", text: "Revenue at risk per month" }), h("div", { class: "value", text: usd.format(tot.rev) })),
          h("div", { class: "card tile" }, h("div", { class: "label", text: "High-risk customers" }), h("div", { class: "value", text: int.format(tot.hi) }))),
        h("div", { class: "stack section-gap" },
          h("div", { class: "card" },
            h("h3", { text: "Average churn risk by " + label.toLowerCase() }),
            h("div", { class: "legend" }, h("span", {}, h("i", { class: "sw bar1" }), "Predicted (calibrated)"), h("span", {}, h("i", { class: "sw tick" }), "Actual churn in data")),
            segmentChart(r.rows),
            h("p", { class: "notice", text: "Close bars and ticks show the calibrated scores match what really happened." })),
          h("div", { class: "card" },
            h("h3", { text: "Segment table" }),
            h("div", { class: "table-wrap" }, h("table", {},
              h("thead", {}, h("tr", {}, h("th", { text: label }), h("th", { class: "r", text: "Customers" }), h("th", { class: "r", text: "Avg risk" }),
                h("th", { class: "r", text: "Expected churners" }), h("th", { class: "r", text: "At risk $/mo" }), h("th", { class: "r", text: "Actual churn" }))),
              h("tbody", {}, r.rows.map((x) => h("tr", {},
                h("td", { text: x.segment }), h("td", { class: "r", text: int.format(x.customers) }), h("td", { class: "r", text: pct(x.avg_risk, 1) }),
                h("td", { class: "r", text: num1.format(x.expected_churners) }), h("td", { class: "r", text: usd.format(x.revenue_at_risk_monthly) }),
                h("td", { class: "r", text: pct(x.actual_churn_rate, 1) }))))))))
      );
    } catch (e) {
      body.replaceChildren(h("p", { class: "error", text: e.message }));
    } finally { body.classList.remove("stale"); }
  }
  root.append(
    h("div", { class: "view-head" }, h("h2", { id: "h-segments", text: "Segments" }),
      h("p", { text: "Where the risk and the money sit. Expected churners and revenue at risk are sums of calibrated probabilities, so they can be read as counts and dollars." })),
    h("div", { class: "card" },
      h("div", { class: "section-label", text: "Group by" }), h("div", { class: "seg-ctl", role: "group", "aria-label": "Group by" }, byBtns),
      h("div", { class: "section-label", text: "Filter" }), h("div", { class: "filters" }, filterRow(st.filters, load))),
    body);
  load();
}

// ---------------------------------------------------------------- customers
function customerCard(row) {
  const bodyId = "cb-" + row.id;
  const body = h("div", { class: "cust-body", id: bodyId, hidden: true });
  const head = h("button", { class: "cust-head", type: "button", "aria-expanded": "false", "aria-controls": bodyId },
    h("div", {}, h("div", { class: "cust-prob", text: pct(row.probability) }), bandPill(row.band)),
    h("div", {},
      h("div", { class: "cust-id", text: row.id }),
      h("div", { class: "small muted", text: `${row.contract} · ${row.tenure_months} mo · ${usd2.format(row.monthly_charges)}/mo` }),
      h("div", { class: "chips" }, row.drivers.map((d) => h("span", { class: "chip", text: `${d.label}: ${d.value}` })))),
    h("div", { class: "cust-channel", text: row.action.channel }),
    h("span", { class: "chev", "aria-hidden": "true", text: "›" }));
  let loaded = false;
  head.addEventListener("click", async () => {
    const open = head.getAttribute("aria-expanded") === "true";
    head.setAttribute("aria-expanded", String(!open));
    body.hidden = open;
    if (!open && !loaded) {
      loaded = true;
      body.replaceChildren(h("p", { class: "notice", text: "Loading…" }));
      try {
        const d = await api("/api/customers/" + encodeURIComponent(row.id));
        body.replaceChildren(resultView(d), assistantBlock(d.id));
      } catch (e) { loaded = false; body.replaceChildren(h("p", { class: "error", text: e.message })); }
    }
  });
  return h("div", { class: "card cust" }, head, body);
}

function buildCustomers(root) {
  const st = { filters: { contract: "", internet_service: "", tenure_band: "", risk_band: "" }, offset: 0 };
  const list = h("div", { class: "cust-list" });
  const count = h("p", { class: "muted small", "aria-live": "polite" });
  const more = h("button", { class: "btn", type: "button", text: "Show 25 more" });
  async function load(append) {
    if (!append) st.offset = 0;
    list.classList.add("stale");
    try {
      const r = await api("/api/customers?" + qs({ ...st.filters, limit: 25, offset: st.offset }));
      const cards = r.rows.map(customerCard);
      if (append) list.append(...cards); else list.replaceChildren(...cards);
      st.offset += r.rows.length;
      count.textContent = r.total ? `Showing ${int.format(st.offset)} of ${int.format(r.total)} customers, highest risk first` : "No customers match these filters.";
      more.hidden = st.offset >= r.total;
    } catch (e) {
      count.textContent = e.message;
    } finally { list.classList.remove("stale"); }
  }
  more.addEventListener("click", () => load(true));
  root.append(
    h("div", { class: "view-head" }, h("h2", { id: "h-customers", text: "Customers" }),
      h("p", { text: "Highest risk first. Open a customer to see the SHAP drivers behind the score and a retention action matched to those drivers and their contract." })),
    h("div", { class: "card" }, h("div", { class: "filters" }, filterRow(st.filters, () => load(false)))),
    count, list, h("div", { class: "list-foot" }, more));
  load(false);
}

// ---------------------------------------------------------------- model view
function lineChart({ series, diagonal = true, xLabel, yLabel, tipFn, crosshair = true, annotate, label }) {
  return chart((W) => {
    const H = Math.round(Math.min(340, Math.max(240, W * 0.7)));
    const m = { l: 44, r: 12, t: 12, b: 40 };
    const pw = W - m.l - m.r, ph = H - m.t - m.b;
    const x = (v) => m.l + v * pw, y = (v) => m.t + (1 - v) * ph;
    const ticks = [0, 0.25, 0.5, 0.75, 1];
    const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H },
      ticks.map((t) => [
        s("line", { class: t === 0 ? "base" : "grid", x1: m.l, x2: W - m.r, y1: y(t), y2: y(t) }),
        s("text", { class: "axis-label", x: m.l - 6, y: y(t) + 4, "text-anchor": "end", text: pct(t) }),
        s("text", { class: "axis-label", x: x(t), y: H - m.b + 16, "text-anchor": t === 0 ? "start" : t === 1 ? "end" : "middle", text: pct(t) })]),
      s("text", { class: "axis-label", x: m.l + pw / 2, y: H - 4, "text-anchor": "middle", text: xLabel }),
      s("text", { class: "axis-label", x: -(m.t + ph / 2), y: 11, transform: "rotate(-90)", "text-anchor": "middle", text: yLabel }),
      diagonal ? s("line", { class: "ref", x1: x(0), y1: y(0), x2: x(1), y2: y(1) }) : null,
      series.map((sr) => [
        s("polyline", { class: `line ${sr.cls}`, points: sr.points.map((p) => `${x(p.x)},${y(p.y)}`).join(" ") }),
        sr.markers ? sr.points.map((p) => hover(s("g", {},
          s("circle", { class: `pt ${sr.cls}`, cx: x(p.x), cy: y(p.y), r: 5 }),
          s("circle", { class: "hit", cx: x(p.x), cy: y(p.y), r: 12 })), () => tipFn(p, sr))) : null]),
      annotate ? annotate(x, y) : null);
    if (crosshair) {
      const main = series[0];
      const vline = s("line", { class: "hover-line", y1: m.t, y2: m.t + ph, visibility: "hidden" });
      const dot = s("circle", { class: `pt ${main.cls}`, r: 5, visibility: "hidden" });
      const overlay = s("rect", { class: "hit", x: m.l, y: m.t, width: pw, height: ph });
      overlay.addEventListener("pointermove", (e) => {
        const r = svg.getBoundingClientRect();
        const vx = ((e.clientX - r.left) * (W / r.width) - m.l) / pw;
        const p = main.points.reduce((a, b) => (Math.abs(b.x - vx) < Math.abs(a.x - vx) ? b : a));
        vline.setAttribute("x1", x(p.x)); vline.setAttribute("x2", x(p.x)); vline.setAttribute("visibility", "visible");
        dot.setAttribute("cx", x(p.x)); dot.setAttribute("cy", y(p.y)); dot.setAttribute("visibility", "visible");
        showTip(e, tipFn(p, main));
      });
      overlay.addEventListener("pointerleave", () => { vline.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); hideTip(); });
      svg.append(vline, dot, overlay);
    }
    return svg;
  }, label);
}

function dataTable(headers, rows) {
  return h("details", { class: "data" }, h("summary", { text: "Show data table" }),
    h("div", { class: "table-wrap" }, h("table", {},
      h("thead", {}, h("tr", {}, headers.map((x, i) => h("th", { class: i ? "r" : null, text: x })))),
      h("tbody", {}, rows.map((r) => h("tr", {}, r.map((c, i) => h("td", { class: i ? "r" : null, text: c }))))))));
}

function buildModel(root) {
  const r = state.report, cal = r.calibration, g20 = r.gains.find((g) => Math.abs(g.share_contacted - 0.2) < 1e-9);
  const statTile = (label, value, note) => h("div", { class: "card tile" }, h("div", { class: "label", text: label }),
    h("div", { class: "value", text: value }), h("p", { class: "note", text: note }));
  const roc = r.roc_curve.map((p) => ({ x: p.fpr, y: p.tpr }));
  const gains = [{ x: 0, y: 0, share: 0, reached: 0 }].concat(r.gains.map((g) => ({ x: g.share_contacted, y: g.share_of_churners, g })));
  const before = cal.curve_before.map((b) => ({ x: b.predicted, y: b.observed, b }));
  const after = cal.curve_after.map((b) => ({ x: b.predicted, y: b.observed, b }));
  const d = r.duplicates;
  const li = (strong, rest) => h("li", {}, h("strong", { text: strong }), " ", rest);

  root.append(
    h("div", { class: "view-head" }, h("h2", { id: "h-model", text: "Model" }),
      h("p", { text: `Tuned XGBoost, evaluated on ${int.format(r.dataset.test_rows)} customers it never saw during training or calibration.` })),
    h("div", { class: "grid-4" },
      statTile("ROC AUC (test)", r.roc_auc.toFixed(3), `Cross-validated on training data: ${r.cv_auc_reported.toFixed(3)}`),
      statTile("Churners in riskiest 20%", pct(g20.share_of_churners), `${g20.lift.toFixed(1)}× better than random contact`),
      statTile("Calibration error", `${pct(cal.before.ece, 1)} → ${pct(cal.after.ece, 1)}`, "Expected calibration error, before → after"),
      statTile("Average predicted churn", `${pct(cal.before.mean_predicted, 1)} → ${pct(cal.after.mean_predicted, 1)}`, `Actual rate ${pct(cal.observed_rate, 1)}`)),
    h("div", { class: "grid-2e" },
      h("div", { class: "card" }, h("h3", { text: "ROC curve" }),
        h("p", { class: "card-sub", text: "How well the model ranks churners above stayers at every cut-off." }),
        h("div", { class: "legend" }, h("span", {}, h("i", { class: "sw s1" }), `XGBoost (AUC ${r.roc_auc.toFixed(3)})`), h("span", {}, h("i", { class: "sw ref" }), "Random guess")),
        lineChart({ series: [{ cls: "s1", points: roc }], xLabel: "False positive rate", yLabel: "True positive rate",
          tipFn: (p) => [`${pct(p.y)} of churners caught`, `${pct(p.x)} of stayers flagged`], label: `ROC curve, AUC ${r.roc_auc.toFixed(3)}` })),
      h("div", { class: "card" }, h("h3", { text: "Lift: cumulative churners reached" }),
        h("p", { class: "card-sub", text: "Contact customers in order of risk. How many churners have you reached?" }),
        h("div", { class: "legend" }, h("span", {}, h("i", { class: "sw s1" }), "By model risk"), h("span", {}, h("i", { class: "sw ref" }), "Random order")),
        lineChart({ series: [{ cls: "s1", points: gains }], xLabel: "Share of customers contacted", yLabel: "Share of churners reached",
          tipFn: (p) => p.g ? [`Contact riskiest ${pct(p.x)}`, `Reach ${pct(p.y)} of churners (${p.g.churners_reached})`, `Lift ${p.g.lift.toFixed(2)}×, precision ${pct(p.g.precision)}`] : ["Start"],
          annotate: (x, y) => [s("circle", { class: "marker", cx: x(0.2), cy: y(g20.share_of_churners), r: 4 }),
            s("text", { class: "val", x: x(0.2) + 8, y: y(g20.share_of_churners) + 16, text: `20% → ${pct(g20.share_of_churners)}` })],
          label: `Cumulative gains: contacting the riskiest 20% reaches ${pct(g20.share_of_churners)} of churners` }),
        dataTable(["Contacted", "Churners reached", "Share of churners", "Lift", "Precision"],
          r.gains.filter((_, i) => i % 2 === 1).map((g) => [pct(g.share_contacted), int.format(g.churners_reached), pct(g.share_of_churners), g.lift.toFixed(2) + "×", pct(g.precision)])))),
    h("div", { class: "card" }, h("h3", { text: "Calibration: before and after" }),
      h("p", { class: "card-sub", text: `The model was trained with class weighting (scale_pos_weight ${r.hyperparameters.scale_pos_weight}), which inflates raw scores. ${cal.method}; the test set was never used to fit it.` }),
      h("div", { class: "grid-2e" },
        h("div", {},
          h("div", { class: "legend" }, h("span", {}, h("i", { class: "sw s2" }), "Before (raw)"), h("span", {}, h("i", { class: "sw s1" }), "After (calibrated)"), h("span", {}, h("i", { class: "sw ref" }), "Perfect")),
          lineChart({ series: [{ cls: "s2", points: before, markers: true, name: "Before" }, { cls: "s1", points: after, markers: true, name: "After" }],
            crosshair: false, xLabel: "Predicted churn probability", yLabel: "Observed churn rate",
            tipFn: (p, sr) => [`${sr.name}: bin ${p.b.bin}`, `Predicted ${pct(p.b.predicted, 1)}, observed ${pct(p.b.observed, 1)}`, `${p.b.n} customers`],
            label: "Reliability diagram: calibrated points sit on the diagonal, raw points sit below it" })),
        h("div", {},
          h("div", { class: "table-wrap" }, h("table", {},
            h("thead", {}, h("tr", {}, h("th", { text: "Test set" }), h("th", { class: "r", text: "Raw" }), h("th", { class: "r", text: "Platt (used)" }), h("th", { class: "r", text: "Isotonic" }))),
            h("tbody", {}, [["Brier score", "brier", 4], ["Log loss", "log_loss", 4], ["Calibration error (ECE)", "ece", 4], ["Mean predicted", "mean_predicted", 4]].map(([l, k]) =>
              h("tr", {}, h("td", { text: l }), h("td", { class: "r", text: cal.before[k].toFixed(3) }), h("td", { class: "r", text: cal.after[k].toFixed(3) }), h("td", { class: "r", text: cal.isotonic_for_comparison[k].toFixed(3) })))))),
          h("p", { class: "notice", text: `Lower is better for all three errors. Actual churn rate: ${pct(cal.observed_rate, 1)}. Platt scaling was chosen before looking at test results because it is monotone and linear in log-odds, so SHAP drivers stay additive on the calibrated scale; ranking (AUC) is unchanged by calibration.` })))),
    h("div", { class: "grid-2e" },
      h("div", { class: "card prose" }, h("h3", { text: "Data quality: duplicate check" }),
        h("ul", {},
          li(`${d.duplicate_customer_ids} duplicate customer IDs`, `and ${d.exact_duplicate_rows} exact duplicate rows.`),
          li(`${d.rows_sharing_identical_model_inputs} rows (${d.profile_groups} groups) share identical model inputs.`,
            `${d.groups_with_conflicting_outcomes} of those groups contain both a churner and a stayer, and ${d.groups_split_across_train_and_test} groups straddle the train/test split (${d.test_rows_with_profile_seen_in_training} test rows).`),
          li("Kept, not removed.", "All are 1-month, month-to-month customers whose total charges equal one bill, and every group spans different cities, so they look like different people with the same simple profile."),
          li(`Test AUC without the overlapping rows: ${r.roc_auc_excluding_profiles_seen_in_training.toFixed(4)}`, `(vs ${r.roc_auc.toFixed(4)} with them), so they do not inflate the headline.`))),
      h("div", { class: "card prose" }, h("h3", { text: "Limitations" }),
        h("ul", {},
          li("Fictional sample data.", "One quarter of an invented California telco. Real operators' data will differ, and there is no later period to test on (no out-of-time validation)."),
          li("No behavioural data.", "No complaints, usage, network quality, satisfaction or contract end dates. The model can say who is at risk, not what went wrong."),
          li("Prediction is not persuasion.", "It ranks who is likely to leave, not who an offer would change. The saving figure rests on an assumed save rate; only a controlled test or an uplift model can measure it."),
          li("Revenue, not profit.", "There is no margin or cost-to-serve data, and the campaign maths assumes a lost bill is lost for the whole period."),
          li("SHAP is association, not cause.", "Correlated inputs (tenure, total charges) share credit between them. Demographic inputs are shown for transparency but never drive actions, and fairness has not been audited."),
          li("Calibration is approximate.", "Fitted on out-of-fold predictions from models with the same settings, then applied to the final model, which is standard but not exact."),
          li("Demo infrastructure.", "One process, in-memory rate limits that reset on restart, no authentication, no monitoring.")))),
    h("div", { class: "card" }, h("h3", { text: "How it was built" }),
      h("div", { class: "built" },
        h("div", {}, h("h4", { text: "Data" }), h("p", { text: `IBM Telco Customer Churn sample: ${int.format(r.dataset.rows)} customers, ${pct(r.dataset.churn_rate, 1)} churned. Identifiers, geography and leaky fields (IBM's own churn score, churn reason, CLTV) dropped. 11 blank total charges (zero tenure) set to 0.` })),
        h("div", {}, h("h4", { text: "Features" }), h("p", { text: "34 inputs: one-hot account, service and billing fields, plus engineered average monthly spend, tenure in years, a new-customer flag (6 months or less) and a count of active services." })),
        h("div", {}, h("h4", { text: "Model" }), h("p", { text: `XGBoost tuned by randomised search (20 settings, 5-fold CV): depth ${r.hyperparameters.max_depth}, learning rate ${r.hyperparameters.learning_rate}, ${r.hyperparameters.n_estimators} trees, class weight ${r.hyperparameters.scale_pos_weight}. Beat logistic regression (0.851) and random forest (0.850) on AUC.` })),
        h("div", {}, h("h4", { text: "Validation" }), h("p", { text: `Stratified 80/20 split (seed 42): ${int.format(r.dataset.train_rows)} train, ${int.format(r.dataset.test_rows)} test. Calibration fitted on out-of-fold training predictions. Every number in this dashboard comes from the test customers.` })),
        h("div", {}, h("h4", { text: "Serving" }), h("p", { text: "Model exported to XGBoost's JSON format, so nothing is unpickled at runtime. TreeSHAP from XGBoost itself. FastAPI with strict validation, plain HTML/CSS/JS front end." })),
        h("div", {}, h("h4", { text: "What I'd do next" }), h("p", { text: "Validate on a later period, add complaint and usage data, run a controlled retention test to measure the real save rate, move to uplift modelling, and monitor drift and calibration." })))));
}

// ---------------------------------------------------------------- router
const VIEWS = { overview: buildOverview, segments: buildSegments, customers: buildCustomers, model: buildModel };
const TITLES = { overview: "Overview", segments: "Segments", customers: "Customers", model: "Model" };
function route() {
  let v = (location.hash.match(/^#\/(\w+)/) || [])[1];
  if (!VIEWS[v]) v = "overview";
  for (const k of Object.keys(VIEWS)) {
    document.getElementById("view-" + k).hidden = k !== v;
    const a = $(`.tabs a[data-view="${k}"]`);
    if (k === v) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  }
  if (!state.built[v]) { state.built[v] = true; VIEWS[v](document.getElementById("view-" + v)); }
  document.title = TITLES[v] + " · Churn Risk Dashboard";
  hideTip();
}

async function init() {
  initTheme();
  try {
    [state.config, state.report] = await Promise.all([api("/api/config"), api("/api/model")]);
  } catch (e) {
    $("#main").replaceChildren(h("div", { class: "card" }, h("p", { class: "error", text: "Could not load the dashboard. " + e.message })));
    return;
  }
  $("#n-customers").textContent = int.format(state.report.dataset.test_rows);
  window.addEventListener("hashchange", route);
  route();
}
document.addEventListener("DOMContentLoaded", init);
