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
// CSS custom properties are set through the CSSOM, which the CSP allows (no style attributes in markup).
const setVar = (el, name, value) => { el.style.setProperty(name, value); return el; };

// ---------------------------------------------------------------- formatting
const pct = (x, d = 0) => (x * 100).toFixed(d) + "%";
const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const usd2 = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2 });
const usdK = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 });
const int = new Intl.NumberFormat("en-US");
const num1 = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const signed = (x) => (x > 0 ? "+" : "−") + Math.abs(x).toFixed(2);

// ---------------------------------------------------------------- motion
const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
const calm = () => motionQuery.matches;

/* Count a number up (or across) to its new value. The last frame always writes
   `final`, the exact string the static version would have shown. */
function countTo(el, to, fmt, final) {
  const from = Number(el.dataset.v);
  el.dataset.v = String(to);
  cancelAnimationFrame(el._raf);
  if (calm() || !Number.isFinite(from) || !Number.isFinite(to) || from === to) { el.textContent = final; return; }
  const t0 = performance.now(), dur = 900;
  const step = (t) => {
    const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 4);
    if (k < 1) { el.textContent = fmt(from + (to - from) * e); el._raf = requestAnimationFrame(step); }
    else el.textContent = final;
  };
  el._raf = requestAnimationFrame(step);
}
// Add a class that runs an entrance animation once, then remove it so redraws stay still.
function enter(el, ms = 1600) {
  if (calm()) return el;
  el.classList.add("enter");
  setTimeout(() => el.classList.remove("enter"), ms);
  return el;
}

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
const state = { config: null, report: null, assume: { ...DEFAULTS }, built: {}, presetCache: new Map() };
const OPTIONS = {
  contract: ["Month-to-month", "One year", "Two year"],
  internet_service: ["Fiber optic", "DSL", "No"],
  risk_band: ["High", "Medium", "Low"],
  payment_method: ["Electronic check", "Mailed check", "Bank transfer (automatic)", "Credit card (automatic)"],
};

// ---------------------------------------------------------------- theme (remembered for this browser session only)
const THEMES = ["light", "dark", "auto"];
function storedTheme() { try { return sessionStorage.getItem("theme") || "auto"; } catch { return "auto"; } }
function applyTheme(t) {
  if (t === "auto") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", t);
  for (const b of document.querySelectorAll("#theme [data-theme-choice]")) {
    b.setAttribute("aria-pressed", String(b.dataset.themeChoice === t));
  }
}
function initTheme() {
  let t = new URLSearchParams(location.search).get("theme");
  if (!THEMES.includes(t)) t = storedTheme();
  applyTheme(t);
  for (const b of document.querySelectorAll("#theme [data-theme-choice]")) {
    b.addEventListener("click", () => {
      const next = b.dataset.themeChoice;
      try { sessionStorage.setItem("theme", next); } catch { /* storage unavailable */ }
      applyTheme(next);
    });
  }
}

// ---------------------------------------------------------------- phone navigation
function initNav() {
  const btn = $("#nav-toggle"), nav = $("#nav");
  const set = (open) => {
    btn.setAttribute("aria-expanded", String(open));
    nav.classList.toggle("open", open);
    $(".top").classList.toggle("menu-open", open);  // on phones the theme switch lives in the menu
  };
  btn.addEventListener("click", () => set(btn.getAttribute("aria-expanded") !== "true"));
  nav.addEventListener("click", (e) => { if (e.target.closest("a")) set(false); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && btn.getAttribute("aria-expanded") === "true") { set(false); btn.focus(); }
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
  t.style.top = (y - hh - 14 < 8 ? y + 18 : y - hh - 14) + "px";
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
    if (c && w > 0 && w !== c.w) {
      if (!c.w) enter(e.target);  // first time it is actually visible
      c.w = w; e.target.replaceChildren(c.draw(w));
    }
  }
});
function chart(draw, label) {
  const el = h("div", { class: "chart", role: "img", "aria-label": label });
  charts.set(el, { draw, w: 0 });
  ro.observe(el);
  return el;
}
let gradSeq = 0;
function vGradient(cls) {
  const id = "g" + (++gradSeq);
  return { id, el: s("defs", {}, s("linearGradient", { id, x1: 0, y1: 0, x2: 0, y2: 1 },
    s("stop", { offset: "0%", class: cls + "-1" }), s("stop", { offset: "100%", class: cls + "-0" }))) };
}
function hGradient(cls) {
  const id = "g" + (++gradSeq);
  return { id, el: s("defs", {}, s("linearGradient", { id, x1: 0, y1: 0, x2: 1, y2: 0 },
    s("stop", { offset: "0%", class: cls + "-0" }), s("stop", { offset: "100%", class: cls + "-1" }))) };
}

// ---------------------------------------------------------------- shared pieces
function bandPill(band) {
  return h("span", { class: "pill " + band }, h("span", { class: "dot " + band, "aria-hidden": "true" }), band + " risk");
}
function field(label, input, out, { prefix = false, wide = false } = {}) {
  const id = "f-" + Math.random().toString(36).slice(2, 9);
  input.id = id;
  return h("div", { class: "field" + (wide ? " wide" : "") },
    h("label", { for: id }, h("span", { text: label }), out || null),
    prefix ? h("span", { class: "prefix" }, input) : input);
}
function select(options, value, allLabel) {
  const el = h("select", {}, allLabel ? h("option", { value: "", text: allLabel }) : null,
    options.map((o) => h("option", { value: o, text: o, selected: o === value })));
  return el;
}
// Range inputs paint their filled part from --fill.
function paintRange(el) {
  const min = Number(el.min), max = Number(el.max);
  setVar(el, "--fill", ((Number(el.value) - min) / (max - min)) * 100 + "%");
}
const icon = {
  check: () => s("svg", { viewBox: "0 0 16 16", width: 14, height: 14, "aria-hidden": "true" },
    s("path", { d: "M3.5 8.5l3 3 6-7", fill: "none", stroke: "currentColor", "stroke-width": 2.2, "stroke-linecap": "round", "stroke-linejoin": "round" })),
  chev: () => s("svg", { viewBox: "0 0 16 16", width: 14, height: 14, "aria-hidden": "true" },
    s("path", { d: "M6 3.5l4.5 4.5L6 12.5", fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round" })),
  phone: () => s("svg", { viewBox: "0 0 20 20", width: 18, height: 18, "aria-hidden": "true" },
    s("path", { d: "M5.2 2.8h2.3l1.2 3.4-1.6 1.1a9.5 9.5 0 0 0 5.6 5.6l1.1-1.6 3.4 1.2v2.3a1.6 1.6 0 0 1-1.7 1.6A14.4 14.4 0 0 1 3.6 4.5a1.6 1.6 0 0 1 1.6-1.7z", fill: "none", stroke: "currentColor", "stroke-width": 1.6, "stroke-linejoin": "round" })),
  sliders: () => s("svg", { viewBox: "0 0 20 20", width: 18, height: 18, "aria-hidden": "true" },
    s("path", { d: "M3 6h8M15 6h2M3 14h2M9 14h8", stroke: "currentColor", "stroke-width": 1.7, "stroke-linecap": "round" }),
    s("circle", { cx: 13, cy: 6, r: 2, fill: "none", stroke: "currentColor", "stroke-width": 1.7 }),
    s("circle", { cx: 7, cy: 14, r: 2, fill: "none", stroke: "currentColor", "stroke-width": 1.7 })),
  spark: () => s("svg", { viewBox: "0 0 20 20", width: 18, height: 18, "aria-hidden": "true" },
    s("path", { d: "M10 2.5l1.7 4.6 4.8 1.4-4.8 1.6L10 15l-1.7-4.9-4.8-1.6 4.8-1.4z", fill: "currentColor" })),
};

/* Semicircular gauge: three risk zones, the score drawn as an arc, and a knob
   that swings to the score. The number sits inside the arc. */
function gauge(prob, band) {
  const { high, medium } = state.config.risk_bands;
  const cx = 120, cy = 124, r = 100;
  const pt = (v, rr = r) => { const a = Math.PI * (1 - v); return [cx + rr * Math.cos(a), cy - rr * Math.sin(a)]; };
  const arc = (a, b, rr = r) => { const [x1, y1] = pt(a, rr), [x2, y2] = pt(b, rr); return `M${x1.toFixed(2)} ${y1.toFixed(2)} A${rr} ${rr} 0 0 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`; };
  const gap = 0.006, v = Math.min(Math.max(prob, 0.004), 1);
  const zones = [[0, medium, "Low"], [medium, high, "Medium"], [high, 1, "High"]];
  const [kx, ky] = pt(v);
  const tick = (t, anchor) => { const [x, y] = pt(t, r + 20); return s("text", { class: "g-tick", x, y: y + 4, "text-anchor": anchor, text: pct(t) }); };
  const knob = s("g", { class: "g-needle-g" },
    s("circle", { cx: kx, cy: ky, r: 12, class: "g-knob-halo" }),
    s("circle", { cx: kx, cy: ky, r: 7, class: "g-hub" }));
  setVar(knob, "--from", -(v * 180) + "deg");
  const svg = s("svg", { viewBox: "0 -8 240 150", "aria-hidden": "true" },
    zones.map(([a, b, l]) => s("path", { class: "g-zone " + l, d: arc(a + (a ? gap : 0), b - (b < 1 ? gap : 0)) })),
    s("path", { class: "g-val " + band, d: arc(0, v), pathLength: 1 }),
    knob,
    s("text", { class: "g-tick", x: cx - r, y: cy + 24, "text-anchor": "middle", text: "0%" }),
    s("text", { class: "g-tick", x: cx + r, y: cy + 24, "text-anchor": "middle", text: "100%" }),
    tick(medium, "end"), tick(high, "middle"));
  const read = h("div", { class: "big-prob", "data-v": "0", text: pct(prob) });
  const el = h("div", { class: "gauge", role: "img",
    "aria-label": `Churn probability ${pct(prob)}: ${band.toLowerCase()} risk. Bands: low below ${pct(medium)}, medium ${pct(medium)} to ${pct(high)}, high from ${pct(high)}.` },
    svg, h("div", { class: "gauge-read", "aria-hidden": "true" }, read));
  enter(el);
  requestAnimationFrame(() => countTo(read, prob, (x) => pct(x), pct(prob)));
  return el;
}

// Ranked diverging bars: what pushes this customer's risk up or down.
function driverList(drivers) {
  const rows = [...drivers].sort((a, b) => Math.abs(b.impact) - Math.abs(a.impact)).slice(0, 8);
  const max = Math.max(0.2, ...rows.map((d) => Math.abs(d.impact)));
  const list = h("ol", { class: "drivers", "aria-label": "Drivers ranked by size of effect" },
    rows.map((d) => {
      const up = d.impact > 0;
      const fill = setVar(h("span", { class: "drv-fill" }), "--w", String(Math.max(0.02, Math.abs(d.impact) / max)));
      return h("li", { class: "drv " + (up ? "up" : "down") },
        h("div", { class: "drv-text" }, h("span", { class: "drv-label", text: d.label }), h("span", { class: "drv-value", text: d.value })),
        h("div", { class: "drv-bar", "aria-hidden": "true" }, fill),
        h("span", { class: "drv-num" }, h("span", { "aria-hidden": "true", text: up ? "▲ " : "▼ " }),
          h("span", { class: "sr", text: up ? "raises risk by " : "lowers risk by " }), signed(d.impact)));
    }));
  return [h("div", { class: "drv-scale", "aria-hidden": "true" }, h("span", {}),
    h("div", { class: "dir" }, h("span", { text: "◀ lowers risk" }), h("span", { text: "raises risk ▶" })), h("span", {})),
  enter(list, 1400)];
}

function actionBox(action) {
  return h("div", { class: "action-box" },
    h("p", { class: "channel" }, icon.phone(), h("span", { text: action.channel })),
    action.steps.length ? h("ol", {}, action.steps.map((st) =>
      h("li", {}, h("div", {}, st.action, h("span", { class: "because", text: "(driver: " + st.because + ")" }))))) : null);
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
  return h("section", { class: "subpanel assistant", "aria-label": "Retention assistant" },
    h("div", { class: "sp-head" }, icon.spark(), h("h3", { class: "sp-title", text: "Retention assistant" })),
    h("div", { class: "sp-body" },
      h("p", { class: "notice", text: cfg.assistant_enabled
        ? "Open-source LLM via Hugging Face. It only explains the model's output and is rate-limited."
        : "AI is off on this copy (no HF_TOKEN), so you get a template briefing built from the same drivers." }),
      h("div", { class: "assistant-row" }, brief),
      cfg.assistant_enabled ? h("div", { class: "assistant-row" }, q, askBtn) : null,
      out));
}

function customerMeta(d) {
  const p = d.profile;
  const row = (k, v) => [h("dt", { text: k }), h("dd", { text: v })];
  return h("dl", { class: "meta-list" },
    row("Customer", d.id), row("Contract", p.contract),
    row("Tenure", `${p.tenure_months} month${p.tenure_months === 1 ? "" : "s"}`),
    row("Monthly bill", usd2.format(p.monthly_charges) + "/mo"),
    row("Internet", p.internet_service === "No" ? "no internet" : p.internet_service),
    row("Payment", p.payment_method));
}

function resultView(d, { whatIf = null, showOutcome = true } = {}) {
  return h("div", { class: "result" },
    h("div", { class: "result-score" },
      h("p", { class: "score-caption" }, whatIf ? "What-if churn probability (calibrated)" : "Calibrated churn probability"),
      gauge(d.probability, d.band),
      bandPill(d.band),
      d.profile ? customerMeta(d) : null,
      showOutcome && d.churned != null ? h("p", { class: "outcome", text: `Outcome in the historical data: ${d.churned ? "left this quarter" : "stayed"}. The model did not see this.` }) : null),
    h("div", {},
      h("h4", { text: "What drives this score (SHAP)" }),
      driverList(d.drivers),
      h("p", { class: "notice", text: "Bar length is the driver's contribution to the calibrated log-odds of churn. These are associations in the model, not proven causes." }),
      h("div", { class: "block-gap" }, h("h4", { text: "Suggested retention action" }), actionBox(d.action))));
}

// ---------------------------------------------------------------- overview
function kpi(id, label, extraClass) {
  return h("div", { class: "kpi" + (extraClass ? " " + extraClass : ""), id },
    h("p", { class: "kpi-label", "data-k": "label", text: label }),
    h("p", { class: "kpi-value", "data-k": "value", "data-v": "0", text: "" }, h("span", { class: "sk sk-text", "aria-hidden": "true" })),
    h("p", { class: "kpi-note", "data-k": "note", text: "" }));
}
function setKpi(id, to, fmt, final, label, note) {
  const t = document.getElementById(id);
  countTo($("[data-k=value]", t), to, fmt, final);
  if (label) $("[data-k=label]", t).textContent = label;
  $("[data-k=note]", t).textContent = note;
}

const ledgerEls = {};
async function refreshSummary() {
  const tiles = $("#tiles");
  tiles.classList.add("stale");
  try {
    const r = await api("/api/summary?" + qs(state.assume));
    const c = r.campaign;
    setKpi("t-auc", r.roc_auc, (v) => v.toFixed(3), r.roc_auc.toFixed(3), "ROC AUC on held-out customers", "1.0 ranks perfectly, 0.5 is a coin flip");
    setKpi("t-reach", r.share_of_churners_reached, (v) => pct(v), pct(r.share_of_churners_reached),
      `Churners reached by contacting the riskiest ${pct(r.target_share)}`,
      `${int.format(r.churners_reached)} of ${int.format(r.churners_total)} churners in ${int.format(r.contacted)} contacts`);
    setKpi("t-risk", r.revenue_at_risk, (v) => usdK.format(v), usdK.format(r.revenue_at_risk), `Revenue at risk over the next ${r.assumptions.horizon_months} months`,
      `${num1.format(r.expected_churners)} expected churners (sum of calibrated probabilities)`);
    setKpi("t-save", c.net_saving, (v) => usdK.format(v), usdK.format(c.net_saving), "Estimated net saving from a retention campaign",
      `${num1.format(c.expected_saved_customers)} kept: ${usdK.format(c.revenue_retained)} revenue minus ${usdK.format(c.cost)} cost`);
    // Live results beside the assumptions.
    const L = ledgerEls;
    countTo(L.contacted, r.contacted, (v) => int.format(Math.round(v)), int.format(r.contacted));
    countTo(L.kept, c.expected_saved_customers, (v) => num1.format(v), num1.format(c.expected_saved_customers));
    countTo(L.revenue, c.revenue_retained, (v) => usdK.format(v), usdK.format(c.revenue_retained));
    countTo(L.cost, c.cost, (v) => "− " + usdK.format(v), "− " + usdK.format(c.cost));
    countTo(L.net, c.net_saving, (v) => usdK.format(v), usdK.format(c.net_saving));
    const tot = c.revenue_retained + c.cost;
    setVar(L.keepBar, "--w", (tot > 0 ? (c.revenue_retained / tot) * 100 : 0) + "%");
    setVar(L.costBar, "--w", (tot > 0 ? (c.cost / tot) * 100 : 0) + "%");
    $("#assume-err").textContent = "";
  } catch (e) {
    $("#assume-err").textContent = e.message;
  } finally { tiles.classList.remove("stale"); }
}

function simulator() {
  const a = state.assume;
  const inputs = {};
  const outs = {};
  const range = (k, min, max, step, fmt) => {
    outs[k] = h("output", { text: fmt(a[k]) });
    inputs[k] = h("input", { type: "range", min, max, step, value: String(a[k]) });
    paintRange(inputs[k]);
    inputs[k].addEventListener("input", () => { outs[k].textContent = fmt(Number(inputs[k].value)); paintRange(inputs[k]); });
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
    field("Customers contacted (riskiest first)", range("target_share", 0.05, 1, 0.05, fmtPct), outs.target_share, { wide: true }),
    field("Save rate: would-be churners who stay after contact", range("save_rate", 0, 1, 0.05, fmtPct), outs.save_rate, { wide: true }),
    field("Cost per contact ($)", numIn("contact_cost", 0, 500, 1), null, { prefix: true }),
    field("Incentive per customer kept ($)", numIn("offer_cost", 0, 2000, 5), null, { prefix: true }),
    field("Months of revenue kept per saved customer", numIn("horizon_months", 1, 36, 1), null, { wide: true }));
  fields.addEventListener("input", onChange);
  // Show the clamped value once the user leaves the field, so the box matches the maths.
  fields.addEventListener("change", () => { for (const [k, el] of Object.entries(inputs)) el.value = String(a[k]); });
  const reset = h("button", { class: "btn", type: "button", text: "Reset assumptions" });
  reset.addEventListener("click", () => {
    Object.assign(a, DEFAULTS);
    for (const [k, el] of Object.entries(inputs)) { el.value = String(a[k]); if (el.type === "range") paintRange(el); }
    for (const [k, o] of Object.entries(outs)) o.textContent = fmtPct(a[k]);
    refreshSummary();
  });

  const L = ledgerEls;
  const val = (key) => (L[key] = h("span", { "data-v": "0", text: "" }));
  L.keepBar = h("span", { class: "keep" });
  L.costBar = h("span", { class: "cost" });
  return h("section", { class: "card sim", id: "sim", "aria-labelledby": "h-sim" },
    h("div", { class: "sim-controls" },
      h("h3", { id: "h-sim", text: "Campaign assumptions" }),
      h("p", { class: "card-sub", text: "Change these and the headline numbers update. The defaults are illustrative, not measured." }),
      fields,
      h("div", { class: "sim-foot" }, reset, h("p", { class: "notice error", id: "assume-err", role: "alert" }))),
    h("div", { class: "sim-out", "aria-live": "polite", "aria-atomic": "false" },
      h("h3", { text: "What this campaign returns" }),
      h("ul", { class: "ledger" },
        h("li", {}, h("span", { text: "Customers contacted" }), val("contacted")),
        h("li", {}, h("span", { text: "Expected customers kept" }), val("kept")),
        h("li", {}, h("span", { text: "Revenue kept" }), val("revenue")),
        h("li", {}, h("span", { text: "Campaign cost" }), val("cost")),
        h("li", { class: "total" }, h("span", { text: "Net saving" }), val("net"))),
      h("div", { class: "split", "aria-hidden": "true" },
        h("div", { class: "split-bar" }, L.keepBar, L.costBar),
        h("div", { class: "split-key" }, h("span", {}, h("i", { class: "k-keep" }), "Revenue kept"), h("span", {}, h("i", { class: "k-cost" }), "Cost"))),
      h("div", { class: "formula" },
        h("div", { text: "Revenue at risk = Σ calibrated churn probability × monthly bill × months." }),
        h("div", { text: "Net saving = save rate × Σ (probability × monthly bill × months) over contacted customers − contacts × cost per contact − customers kept × incentive." }),
        h("div", { text: "Revenue, not profit: the data has no margins. Assumes a churner's bill is lost for the whole period, and that contact does not change who would have stayed anyway." }))));
}

function whatIfForm(base, onResult) {
  const p = base.profile;
  const tenure = h("input", { type: "range", min: 0, max: 72, step: 1, value: String(p.tenure_months) });
  paintRange(tenure);
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
  tenure.addEventListener("input", () => { tOut.textContent = tenure.value + " months"; paintRange(tenure); run(); });
  for (const el of [monthly, contract, payment]) el.addEventListener("input", run);
  const reset = h("button", { class: "btn", type: "button", text: "Back to the real customer" });
  reset.addEventListener("click", () => {
    tenure.value = String(p.tenure_months); paintRange(tenure); tOut.textContent = p.tenure_months + " months";
    monthly.value = String(p.monthly_charges); contract.value = p.contract; payment.value = p.payment_method;
    onResult(null);
  });
  return h("details", { class: "subpanel whatif" },
    h("summary", {}, icon.sliders(), h("span", { text: "What if? Change this customer and re-score live" })),
    h("div", { class: "sp-body" },
      h("div", { class: "fields" },
        field("Tenure", tenure, tOut, { wide: true }), field("Monthly charges ($)", monthly, null, { prefix: true }),
        field("Contract", contract), field("Payment method", payment, null, { wide: true })),
      h("p", { class: "notice", text: "If tenure or charges change, total charges are re-estimated as monthly × tenure." }),
      err, h("div", { class: "sim-foot" }, reset)));
}

function presetDetail(key) {
  const preset = state.config.presets.find((p) => p.key === key);
  if (!state.presetCache.has(key)) {
    const pr = api("/api/customers/" + encodeURIComponent(preset.customer_id));
    pr.catch(() => state.presetCache.delete(key));
    state.presetCache.set(key, pr);
  }
  return state.presetCache.get(key);
}

async function showPreset(key, root) {
  for (const b of root.querySelectorAll(".preset")) b.setAttribute("aria-pressed", String(b.dataset.key === key));
  const area = $("#preset-result", root);
  if (!area.firstChild) area.replaceChildren(h("div", { class: "sk sk-block", "aria-hidden": "true" }));
  area.classList.add("stale");
  try {
    const d = await presetDetail(key);
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
    const sim = $("#sim");
    sim.scrollIntoView({ behavior: calm() ? "auto" : "smooth", block: "start" });
    $("input", sim).focus({ preventScroll: true });
  });
  return b;
}

function buildOverview(root) {
  const presetsEl = h("div", { class: "presets", role: "group", "aria-label": "Example customers" },
    state.config.presets.map((p) => {
      const band = p.label.split(" ")[0];
      const score = h("span", { class: "p-score", "aria-hidden": "true" });
      const b = h("button", { class: "preset " + band, type: "button", "aria-pressed": "false", "data-key": p.key },
        h("span", { class: "p-main" },
          h("span", { class: "p-title" }, h("span", { class: "dot " + band, "aria-hidden": "true" }), p.label),
          h("span", { class: "p-blurb", text: p.blurb })),
        score,
        h("span", { class: "p-check", "aria-hidden": "true" }, icon.check()));
      b.addEventListener("click", () => showPreset(p.key, examples));
      presetDetail(p.key).then((d) => { score.textContent = pct(d.probability); }, () => {});
      return b;
    }));
  const examples = h("section", { class: "card", "aria-labelledby": "h-examples" },
    h("h3", { id: "h-examples", text: "Try an example customer" }),
    h("p", { class: "card-sub", text: "Real held-out customers from the dataset. One click shows the score, why, and what to do." }),
    presetsEl,
    h("div", { id: "preset-result", class: "result-card" }));
  root.replaceChildren(
    h("div", { class: "hero" },
      h("h2", { id: "h-overview", text: "Finds the telecom customers most likely to leave, explains why, and suggests what to do about it." }),
      h("p", { text: "Scores every customer with a calibrated churn probability, so expected churners and revenue at risk add up to real counts and dollars." })),
    h("div", { class: "kpis", id: "tiles" },
      kpi("t-auc", "ROC AUC"), kpi("t-reach", "Churners reached"), kpi("t-risk", "Revenue at risk"),
      add(kpi("t-save", "Net saving", "feature"), [editLink()])),
    simulator(),
    examples);
  refreshSummary();
  showPreset("high", examples);
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
    const narrow = W < 520;
    const labelW = narrow ? Math.max(104, W * 0.34) : Math.min(200, Math.max(130, W * 0.26)), rowH = 48, top = 26, right = 52, bottom = 26;
    const plotW = W - labelW - right, x = (v) => labelW + (v / max) * plotW;
    const H = top + rows.length * rowH + bottom;
    const ticks = []; for (let t = 0; t <= max + 1e-9; t += max > 0.5 ? 0.2 : 0.1) ticks.push(t);
    const g = hGradient("bar-stop");
    const first = rows[0];
    const ax = Math.min(Math.max(x(first.actual_churn_rate), labelW + 20), W - 30);
    return s("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H },
      g.el,
      ticks.map((t) => [s("line", { class: t === 0 ? "base" : "grid", x1: x(t), x2: x(t), y1: top - 6, y2: H - bottom + 2 }),
        s("text", { class: "axis-label", x: x(t), y: H - 6, "text-anchor": "middle", text: pct(t) })]),
      // Direct label for the tick on the first row, instead of a legend.
      s("text", { class: "axis-title annot", x: ax, y: top - 12, "text-anchor": "middle", text: "actual" }),
      rows.map((r, i) => {
        const y = top + i * rowH;
        const row = s("g", { class: "row" },
          s("rect", { class: "row-band", x: -6, y: y + 1, width: W + 12, height: rowH - 2, rx: 8 }),
          s("text", { class: "seg-name", x: 0, y: y + 21, text: r.segment }),
          s("text", { class: "axis-label", x: 0, y: y + 37, text: int.format(r.customers) + " customers" }),
          s("rect", { class: "bar", fill: `url(#${g.id})`, x: labelW, y: y + 12, width: Math.max(2, x(r.avg_risk) - labelW), height: 20, rx: 5 }),
          s("line", { class: "tick-actual", x1: x(r.actual_churn_rate), x2: x(r.actual_churn_rate), y1: y + 7, y2: y + 37 }),
          s("text", { class: "val", x: Math.max(x(r.avg_risk), x(r.actual_churn_rate)) + 8, y: y + 27, text: pct(r.avg_risk) }));
        return hover(row, () => [r.segment, `Predicted (calibrated): ${pct(r.avg_risk, 1)}`, `Actual churn in data: ${pct(r.actual_churn_rate, 1)}`,
          `${num1.format(r.expected_churners)} expected churners · ${usd.format(r.revenue_at_risk_monthly)}/mo at risk`]);
      }));
  }, "Average predicted churn risk by segment: " + rows.map((r) => `${r.segment} ${pct(r.avg_risk)}`).join(", "));
}

function buildSegments(root) {
  const st = { by: "contract", filters: { contract: "", internet_service: "", tenure_band: "", risk_band: "" } };
  const body = h("div", { class: "stack" }, h("div", { class: "sk sk-kpis", "aria-hidden": "true" }), h("div", { class: "sk sk-block", "aria-hidden": "true" }));
  const byBtns = GROUP_BY.map(([k, label]) => {
    const b = h("button", { class: "btn", type: "button", "aria-pressed": String(k === st.by), text: label });
    b.addEventListener("click", () => { st.by = k; byBtns.forEach((x, i) => x.setAttribute("aria-pressed", String(GROUP_BY[i][0] === k))); load(); });
    return b;
  });
  const small = (label, value) => h("div", { class: "kpi" }, h("p", { class: "kpi-label", text: label }), h("p", { class: "kpi-value", text: value }));
  async function load() {
    body.classList.add("stale");
    try {
      const r = await api("/api/segments?" + qs({ by: st.by, ...st.filters }));
      const label = GROUP_BY.find(([k]) => k === st.by)[1];
      if (!r.rows.length) { body.replaceChildren(h("div", { class: "card" }, h("p", { text: "No customers match these filters." }))); return; }
      const tot = { ec: r.totals.expected_churners, rev: r.totals.revenue_at_risk_monthly, hi: r.totals.high_risk_customers };
      body.replaceChildren(
        h("div", { class: "kpis small" },
          small("Customers in view", int.format(r.filtered_customers)),
          small("Expected churners", num1.format(tot.ec)),
          small("Revenue at risk per month", usd.format(tot.rev)),
          small("High-risk customers", int.format(tot.hi))),
        h("section", { class: "card", "aria-label": "Chart" },
          h("h3", { text: "Average churn risk by " + label.toLowerCase() }),
          segmentChart(r.rows),
          h("p", { class: "chart-caption" },
            h("span", { class: "key-bar", "aria-hidden": "true" }), "Bars: average predicted churn risk (calibrated). ",
            h("span", { class: "key-tick", "aria-hidden": "true" }), "Ticks: actual churn in data. ",
            "Close bars and ticks show the calibrated scores match what really happened.")),
        h("section", { class: "card", "aria-label": "Segment table" },
          h("h3", { text: "Segment table" }),
          h("div", { class: "table-wrap" }, h("table", {},
            h("thead", {}, h("tr", {}, h("th", { text: label }), h("th", { class: "r", text: "Customers" }), h("th", { class: "r", text: "Avg risk" }),
              h("th", { class: "r", text: "Expected churners" }), h("th", { class: "r", text: "At risk $/mo" }), h("th", { class: "r", text: "Actual churn" }))),
            h("tbody", {}, r.rows.map((x) => h("tr", {},
              h("td", { text: x.segment }), h("td", { class: "r", text: int.format(x.customers) }), h("td", { class: "r", text: pct(x.avg_risk, 1) }),
              h("td", { class: "r", text: num1.format(x.expected_churners) }), h("td", { class: "r", text: usd.format(x.revenue_at_risk_monthly) }),
              h("td", { class: "r", text: pct(x.actual_churn_rate, 1) }))))))));
    } catch (e) {
      body.replaceChildren(h("p", { class: "error", text: e.message }));
    } finally { body.classList.remove("stale"); }
  }
  root.replaceChildren(
    h("div", { class: "view-head" }, h("h2", { id: "h-segments", text: "Segments" }),
      h("p", { text: "Where the risk and the money sit. Expected churners and revenue at risk are sums of calibrated probabilities, so they can be read as counts and dollars." })),
    h("div", { class: "card" },
      h("p", { class: "ctl-label", id: "l-groupby", text: "Group by" }),
      h("div", { class: "seg-ctl", role: "group", "aria-labelledby": "l-groupby" }, byBtns),
      h("p", { class: "ctl-label", text: "Filter" }),
      h("div", { class: "filters" }, filterRow(st.filters, load))),
    body);
  load();
}

// ---------------------------------------------------------------- customers
function customerCard(row) {
  const bodyId = "cb-" + row.id;
  const body = h("div", { class: "cust-body", id: bodyId, hidden: true });
  const bar = setVar(h("span", { class: row.band }), "--w", (row.probability * 100).toFixed(1) + "%");
  const head = h("button", { class: "cust-head", type: "button", "aria-expanded": "false", "aria-controls": bodyId },
    h("div", { class: "cust-score" }, h("div", { class: "cust-prob " + row.band, text: pct(row.probability) }), h("div", { class: "mini-bar", "aria-hidden": "true" }, bar)),
    h("div", {},
      h("div", { class: "cust-id" }, h("span", { text: row.id }), bandPill(row.band)),
      h("div", { class: "cust-sub", text: `${row.contract}, ${row.tenure_months} mo, ${usd2.format(row.monthly_charges)}/mo` })),
    h("div", { class: "cust-detail" },
      h("div", { class: "chips" }, row.drivers.map((d) => h("span", { class: "chip", text: `${d.label}: ${d.value}` }))),
      h("div", { class: "cust-channel", text: row.action.channel })),
    h("span", { class: "chev", "aria-hidden": "true" }, icon.chev()));
  const card = h("div", { class: "card cust" }, head, body);
  let loaded = false;
  head.addEventListener("click", async () => {
    const open = head.getAttribute("aria-expanded") === "true";
    head.setAttribute("aria-expanded", String(!open));
    card.classList.toggle("open", !open);
    body.hidden = open;
    if (!open && !loaded) {
      loaded = true;
      body.replaceChildren(h("div", { class: "sk sk-block", "aria-hidden": "true" }), h("p", { class: "sr", text: "Loading…" }));
      try {
        const d = await api("/api/customers/" + encodeURIComponent(row.id));
        body.replaceChildren(resultView(d), assistantBlock(d.id));
      } catch (e) { loaded = false; body.replaceChildren(h("p", { class: "error", text: e.message })); }
    }
  });
  return card;
}

function buildCustomers(root) {
  const st = { filters: { contract: "", internet_service: "", tenure_band: "", risk_band: "" }, offset: 0 };
  const list = h("div", { class: "cust-list" }, Array.from({ length: 5 }, () => h("div", { class: "sk sk-row", "aria-hidden": "true" })));
  const count = h("p", { class: "list-meta", "aria-live": "polite" });
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
  root.replaceChildren(
    h("div", { class: "view-head" }, h("h2", { id: "h-customers", text: "Customers" }),
      h("p", { text: "Highest risk first. Open a customer to see the SHAP drivers behind the score and a retention action matched to those drivers and their contract." })),
    h("div", { class: "card" }, h("div", { class: "filters" }, filterRow(st.filters, () => load(false)))),
    h("div", {}, count, list, h("div", { class: "list-foot" }, more)));
  load(false);
}

// ---------------------------------------------------------------- model view
/* Line chart with direct labels. `labels` places series names next to the lines;
   `refLabel` names the dashed diagonal. */
function lineChart({ series, diagonal = true, xLabel, yLabel, tipFn, crosshair = true, annotate, labels = [], refLabel, refAt = 0.8, refDy = 16, area = false, label }) {
  return chart((W) => {
    const H = Math.round(Math.min(340, Math.max(250, W * 0.68)));
    const m = { l: 48, r: 14, t: 14, b: 44 };
    const pw = W - m.l - m.r, ph = H - m.t - m.b;
    const x = (v) => m.l + v * pw, y = (v) => m.t + (1 - v) * ph;
    const ticks = [0, 0.25, 0.5, 0.75, 1];
    const grad = area ? vGradient("area-stop") : null;
    const main = series[0];
    const diagAngle = (Math.atan2(y(1) - y(0), x(1) - x(0)) * 180) / Math.PI;
    const svg = s("svg", { viewBox: `0 0 ${W} ${H}`, width: W, height: H },
      grad ? grad.el : null,
      ticks.map((t) => [
        s("line", { class: t === 0 ? "base" : "grid", x1: m.l, x2: W - m.r, y1: y(t), y2: y(t) }),
        s("text", { class: "axis-label", x: m.l - 8, y: y(t) + 4, "text-anchor": "end", text: pct(t) }),
        s("text", { class: "axis-label", x: x(t), y: H - m.b + 18, "text-anchor": t === 0 ? "start" : t === 1 ? "end" : "middle", text: pct(t) })]),
      s("text", { class: "axis-title", x: m.l + pw / 2, y: H - 4, "text-anchor": "middle", text: xLabel }),
      s("text", { class: "axis-title", x: -(m.t + ph / 2), y: 12, transform: "rotate(-90)", "text-anchor": "middle", text: yLabel }),
      diagonal ? [s("line", { class: "ref", x1: x(0), y1: y(0), x2: x(1), y2: y(1) }),
        refLabel ? s("text", { class: "ref-label", x: x(refAt), y: y(refAt) + refDy, "text-anchor": "middle", transform: `rotate(${diagAngle} ${x(refAt)} ${y(refAt) + refDy})`, text: refLabel }) : null] : null,
      grad ? s("path", { class: "area", fill: `url(#${grad.id})`,
        d: `M${x(main.points[0].x)},${y(0)} ` + main.points.map((p) => `L${x(p.x)},${y(p.y)}`).join(" ") + ` L${x(main.points[main.points.length - 1].x)},${y(0)} Z` }) : null,
      series.map((sr) => [
        s("polyline", { class: `line ${sr.cls}${sr.dashed ? " dashed" : ""}`, points: sr.points.map((p) => `${x(p.x)},${y(p.y)}`).join(" "), pathLength: 1 }),
        sr.markers ? sr.points.map((p) => hover(s("g", { class: "pt-g" },
          s(sr.square ? "rect" : "circle", sr.square
            ? { class: `pt ${sr.cls}`, x: x(p.x) - 4.5, y: y(p.y) - 4.5, width: 9, height: 9, rx: 1.5 }
            : { class: `pt ${sr.cls}`, cx: x(p.x), cy: y(p.y), r: 5 }),
          s("circle", { class: "hit", cx: x(p.x), cy: y(p.y), r: 12 })), () => tipFn(p, sr))) : null]),
      labels.map((l) => s("text", { class: `lbl ${l.cls}`, x: x(l.x) + (l.dx || 0), y: y(l.y) + (l.dy || 0), "text-anchor": l.anchor || "start", text: l.text })),
      annotate ? s("g", { class: "annot" }, annotate(x, y)) : null);
    if (crosshair) {
      const vline = s("line", { class: "hover-line", y1: m.t, y2: m.t + ph, visibility: "hidden" });
      const dot = s("circle", { class: `pt ${main.cls}`, r: 5.5, visibility: "hidden" });
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
  const statTile = (label, value, note) => h("div", { class: "kpi" }, h("p", { class: "kpi-label", text: label }),
    h("p", { class: "kpi-value", text: value }), h("p", { class: "kpi-note", text: note }));
  const roc = r.roc_curve.map((p) => ({ x: p.fpr, y: p.tpr }));
  const gains = [{ x: 0, y: 0, share: 0, reached: 0 }].concat(r.gains.map((g) => ({ x: g.share_contacted, y: g.share_of_churners, g })));
  const before = cal.curve_before.map((b) => ({ x: b.predicted, y: b.observed, b }));
  const after = cal.curve_after.map((b) => ({ x: b.predicted, y: b.observed, b }));
  const d = r.duplicates;
  const li = (strong, rest) => h("li", {}, h("strong", { text: strong }), " ", rest);
  // Where to put a series' direct label: near its point closest to a given x.
  const near = (pts, vx) => pts.reduce((a, b) => (Math.abs(b.x - vx) < Math.abs(a.x - vx) ? b : a));
  const rocAt = near(roc, 0.3), gainAt = near(gains, 0.55);
  const midBefore = near(before, 0.5), lastAfter = after.reduce((a, b) => (b.x > a.x ? b : a));

  root.replaceChildren(
    h("div", { class: "view-head" }, h("h2", { id: "h-model", text: "Model" }),
      h("p", { text: `Tuned XGBoost, evaluated on ${int.format(r.dataset.test_rows)} customers it never saw during training or calibration.` })),
    h("div", { class: "kpis small" },
      statTile("ROC AUC (test)", r.roc_auc.toFixed(3), `Cross-validated on training data: ${r.cv_auc_reported.toFixed(3)}`),
      statTile("Churners in riskiest 20%", pct(g20.share_of_churners), `${g20.lift.toFixed(1)}× better than random contact`),
      statTile("Calibration error", `${pct(cal.before.ece, 1)} → ${pct(cal.after.ece, 1)}`, "Expected calibration error, before → after"),
      statTile("Average predicted churn", `${pct(cal.before.mean_predicted, 1)} → ${pct(cal.after.mean_predicted, 1)}`, `Actual rate ${pct(cal.observed_rate, 1)}`)),
    h("div", { class: "grid-2e" },
      h("section", { class: "card", "aria-labelledby": "h-roc" }, h("h3", { id: "h-roc", text: "ROC curve" }),
        h("p", { class: "card-sub", text: "How well the model ranks churners above stayers at every cut-off." }),
        lineChart({ series: [{ cls: "s1", points: roc }], xLabel: "False positive rate", yLabel: "True positive rate", area: true,
          labels: [{ cls: "s1", x: rocAt.x, y: rocAt.y, dx: 10, dy: 20, text: `XGBoost (AUC ${r.roc_auc.toFixed(3)})` }], refLabel: "Random guess",
          tipFn: (p) => [`${pct(p.y)} of churners caught`, `${pct(p.x)} of stayers flagged`], label: `ROC curve, AUC ${r.roc_auc.toFixed(3)}` })),
      h("section", { class: "card", "aria-labelledby": "h-lift" }, h("h3", { id: "h-lift", text: "Lift: cumulative churners reached" }),
        h("p", { class: "card-sub", text: "Contact customers in order of risk. How many churners have you reached?" }),
        lineChart({ series: [{ cls: "s1", points: gains }], xLabel: "Share of customers contacted", yLabel: "Share of churners reached", area: true,
          labels: [{ cls: "s1", x: gainAt.x, y: gainAt.y, dx: 10, dy: 22, text: "By model risk" }], refLabel: "Random order",
          tipFn: (p) => p.g ? [`Contact riskiest ${pct(p.x)}`, `Reach ${pct(p.y)} of churners (${p.g.churners_reached})`, `Lift ${p.g.lift.toFixed(2)}×, precision ${pct(p.g.precision)}`] : ["Start"],
          annotate: (x, y) => [s("circle", { class: "marker", cx: x(0.2), cy: y(g20.share_of_churners), r: 5 }),
            s("text", { class: "val", x: x(0.2) + 10, y: y(g20.share_of_churners) + 18, text: `20% → ${pct(g20.share_of_churners)}` })],
          label: `Cumulative gains: contacting the riskiest 20% reaches ${pct(g20.share_of_churners)} of churners` }),
        dataTable(["Contacted", "Churners reached", "Share of churners", "Lift", "Precision"],
          r.gains.filter((_, i) => i % 2 === 1).map((g) => [pct(g.share_contacted), int.format(g.churners_reached), pct(g.share_of_churners), g.lift.toFixed(2) + "×", pct(g.precision)])))),
    h("section", { class: "card", "aria-labelledby": "h-cal" }, h("h3", { id: "h-cal", text: "Calibration: before and after" }),
      h("p", { class: "card-sub", text: `The model was trained with class weighting (scale_pos_weight ${r.hyperparameters.scale_pos_weight}), which inflates raw scores. ${cal.method}; the test set was never used to fit it.` }),
      h("div", { class: "grid-2e" },
        h("div", {},
          lineChart({ series: [{ cls: "s2", points: before, markers: true, square: true, dashed: true, name: "Before" }, { cls: "s1", points: after, markers: true, name: "After" }],
            crosshair: false, xLabel: "Predicted churn probability", yLabel: "Observed churn rate", refLabel: "Perfect", refAt: 0.93, refDy: -8,
            labels: [{ cls: "s2", x: midBefore.x, y: midBefore.y, dx: 10, dy: 24, text: "Before (raw)" },
              { cls: "s1", x: lastAfter.x, y: lastAfter.y, dx: -12, dy: -12, anchor: "end", text: "After (calibrated)" }],
            tipFn: (p, sr) => [`${sr.name}: bin ${p.b.bin}`, `Predicted ${pct(p.b.predicted, 1)}, observed ${pct(p.b.observed, 1)}`, `${p.b.n} customers`],
            label: "Reliability diagram: calibrated points sit on the diagonal, raw points sit below it" })),
        h("div", {},
          h("div", { class: "table-wrap" }, h("table", { class: "metric-table" },
            h("thead", {}, h("tr", {}, h("th", { text: "Test set" }), h("th", { class: "r", text: "Raw" }), h("th", { class: "r hl", text: "Platt (used)" }), h("th", { class: "r", text: "Isotonic" }))),
            h("tbody", {}, [["Brier score", "brier", 4], ["Log loss", "log_loss", 4], ["Calibration error (ECE)", "ece", 4], ["Mean predicted", "mean_predicted", 4]].map(([l, k]) =>
              h("tr", {}, h("td", { text: l }), h("td", { class: "r", text: cal.before[k].toFixed(3) }), h("td", { class: "r hl", text: cal.after[k].toFixed(3) }), h("td", { class: "r", text: cal.isotonic_for_comparison[k].toFixed(3) })))))),
          h("p", { class: "notice", text: `Lower is better for all three errors. Actual churn rate: ${pct(cal.observed_rate, 1)}. Platt scaling was chosen before looking at test results because it is monotone and linear in log-odds, so SHAP drivers stay additive on the calibrated scale; ranking (AUC) is unchanged by calibration.` })))),
    h("section", { class: "card", "aria-labelledby": "h-limits" }, h("h3", { id: "h-limits", text: "Limitations" }),
      h("p", { class: "card-sub", text: "What this proof of concept can and cannot tell you." }),
      h("ul", { class: "limits" },
        li("Fictional sample data.", "One quarter of an invented California telco. Real operators' data will differ, and there is no later period to test on (no out-of-time validation)."),
        li("No behavioural data.", "No complaints, usage, network quality, satisfaction or contract end dates. The model can say who is at risk, not what went wrong."),
        li("Prediction is not persuasion.", "It ranks who is likely to leave, not who an offer would change. The saving figure rests on an assumed save rate; only a controlled test or an uplift model can measure it."),
        li("Revenue, not profit.", "There is no margin or cost-to-serve data, and the campaign maths assumes a lost bill is lost for the whole period."),
        li("SHAP is association, not cause.", "Correlated inputs (tenure, total charges) share credit between them. Demographic inputs are shown for transparency but never drive actions, and fairness has not been audited."),
        li("Calibration is approximate.", "Fitted on out-of-fold predictions from models with the same settings, then applied to the final model, which is standard but not exact."),
        li("Demo infrastructure.", "One process, in-memory rate limits that reset on restart, no authentication, no monitoring."))),
    h("section", { class: "card", "aria-labelledby": "h-dupes" }, h("h3", { id: "h-dupes", text: "Data quality: duplicate check" }),
      h("ul", { class: "facts" },
        li(`${d.duplicate_customer_ids} duplicate customer IDs`, `and ${d.exact_duplicate_rows} exact duplicate rows.`),
        li(`${d.rows_sharing_identical_model_inputs} rows (${d.profile_groups} groups) share identical model inputs.`,
          `${d.groups_with_conflicting_outcomes} of those groups contain both a churner and a stayer, and ${d.groups_split_across_train_and_test} groups straddle the train/test split (${d.test_rows_with_profile_seen_in_training} test rows).`),
        li("Kept, not removed.", "All are 1-month, month-to-month customers whose total charges equal one bill, and every group spans different cities, so they look like different people with the same simple profile."),
        li(`Test AUC without the overlapping rows: ${r.roc_auc_excluding_profiles_seen_in_training.toFixed(4)}`, `(vs ${r.roc_auc.toFixed(4)} with them), so they do not inflate the headline.`))),
    h("section", { class: "card", "aria-labelledby": "h-built" }, h("h3", { id: "h-built", text: "How it was built" }),
      h("ol", { class: "built" },
        h("li", {}, h("h4", { text: "Data" }), h("p", { text: `IBM Telco Customer Churn sample: ${int.format(r.dataset.rows)} customers, ${pct(r.dataset.churn_rate, 1)} churned. Identifiers, geography and leaky fields (IBM's own churn score, churn reason, CLTV) dropped. 11 blank total charges (zero tenure) set to 0.` })),
        h("li", {}, h("h4", { text: "Features" }), h("p", { text: "34 inputs: one-hot account, service and billing fields, plus engineered average monthly spend, tenure in years, a new-customer flag (6 months or less) and a count of active services." })),
        h("li", {}, h("h4", { text: "Model" }), h("p", { text: `XGBoost tuned by randomised search (20 settings, 5-fold CV): depth ${r.hyperparameters.max_depth}, learning rate ${r.hyperparameters.learning_rate}, ${r.hyperparameters.n_estimators} trees, class weight ${r.hyperparameters.scale_pos_weight}. Beat logistic regression (0.851) and random forest (0.850) on AUC.` })),
        h("li", {}, h("h4", { text: "Validation" }), h("p", { text: `Stratified 80/20 split (seed 42): ${int.format(r.dataset.train_rows)} train, ${int.format(r.dataset.test_rows)} test. Calibration fitted on out-of-fold training predictions. Every number in this dashboard comes from the test customers.` })),
        h("li", {}, h("h4", { text: "Serving" }), h("p", { text: "Model exported to XGBoost's JSON format, so nothing is unpickled at runtime. TreeSHAP from XGBoost itself. FastAPI with strict validation, plain HTML/CSS/JS front end." })),
        h("li", {}, h("h4", { text: "What I'd do next" }), h("p", { text: "Validate on a later period, add complaint and usage data, run a controlled retention test to measure the real save rate, move to uplift modelling, and monitor drift and calibration." })))));
}

// ---------------------------------------------------------------- router
const VIEWS = { overview: buildOverview, segments: buildSegments, customers: buildCustomers, model: buildModel };
const TITLES = { overview: "Overview", segments: "Segments", customers: "Customers", model: "Model" };
let currentView = null;
function route() {
  let v = (location.hash.match(/^#\/(\w+)/) || [])[1];
  if (!VIEWS[v]) v = "overview";
  for (const k of Object.keys(VIEWS)) {
    document.getElementById("view-" + k).hidden = k !== v;
    const a = $(`.tabs a[data-view="${k}"]`);
    if (k === v) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
  }
  const el = document.getElementById("view-" + v);
  if (!state.built[v]) { state.built[v] = true; VIEWS[v](el); }
  if (currentView && currentView !== v && !calm()) {
    el.classList.remove("entering"); void el.offsetWidth; el.classList.add("entering");
    window.scrollTo({ top: 0 });
  }
  currentView = v;
  document.title = TITLES[v] + " · Churn Risk Dashboard";
  hideTip();
}

async function init() {
  initTheme();
  initNav();
  for (const v of document.querySelectorAll(".view")) v.addEventListener("animationend", (e) => { if (e.target === v) v.classList.remove("entering"); });
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

// ---------------------------------------------------------------- drift monitor
async function initDrift() {
  const dot = h("span", { class: "drift-dot" });
  const label = h("span", { text: "Drift: checking" });
  const body = h("div", { class: "drift-body", hidden: true });
  const pill = h("button", {
    class: "drift-pill", type: "button",
    events: { click: () => { body.hidden = !body.hidden; } },
  }, dot, label);
  const root = h("div", { class: "drift", "data-level": "unknown" }, pill, body);
  document.body.append(root);

  async function refresh() {
    let r;
    try { r = await api("/api/drift"); } catch { return; }
    body.replaceChildren();
    if (r.status === "insufficient_data") {
      root.setAttribute("data-level", "unknown");
      label.textContent = "Drift: collecting data";
      body.append(h("p", { text: "Seen " + r.n + " of " + r.needed + " scored requests needed." }));
    } else {
      root.setAttribute("data-level", r.status);
      label.textContent = "Drift: " + r.status;
      body.append(h("p", { text: r.n + " recent requests vs the test set. Score PSI " + r.score.psi.toFixed(2) + "." }));
      for (const f of r.features.slice(0, 3)) {
        body.append(h("div", { class: "drift-row" },
          h("span", { text: f.feature.replaceAll("_", " ") }),
          h("span", { text: "PSI " + f.psi.toFixed(2) })));
      }
    }
    body.append(h("p", { class: "drift-note", text: "In memory only; resets on restart." }));
  }
  await refresh();
  setInterval(refresh, 10000);
}
document.addEventListener("DOMContentLoaded", initDrift);
