"""FastAPI backend for the churn dashboard.

Security posture: no /docs, /redoc or /openapi.json; strict request schemas;
generic error bodies; no CORS middleware (same-origin only, nothing wildcard);
CSP that allows iframe embedding only from Hugging Face.
"""

import logging
from typing import Annotated

from fastapi import FastAPI, Path, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import assistant, config
from .features import TENURE_BANDS, PROTECTION_BANDS
from .model import ChurnModel, Portfolio
from .schemas import (AssistantRequest, CampaignQuery,
                      CustomerQuery, Profile, SegmentQuery)
from .drift import DriftMonitor

logging.basicConfig(level=logging.INFO,
                    format="%(levelname)s %(name)s %(message)s")
log = logging.getLogger("churn")

model = ChurnModel()
portfolio = Portfolio(model)
drift = DriftMonitor([c["profile"] for c in portfolio.customers],
                     [c["probability"] for c in portfolio.customers])

app = FastAPI(title="Churn dashboard", docs_url=None,
              redoc_url=None, openapi_url=None)

CSP = ("default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
       "font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; "
       f"form-action 'self'; frame-ancestors {config.FRAME_ANCESTORS}")
SECURITY_HEADERS = {
    "Content-Security-Policy": CSP,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=()",
    "Cross-Origin-Opener-Policy": "same-origin",
}


class BodyLimit:
    """Reject request bodies over MAX_BODY_BYTES, declared or streamed."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)
        headers = dict(scope.get("headers") or [])
        declared = headers.get(b"content-length")
        too_big = JSONResponse({"error": "Request body too large."}, status_code=413,
                               headers=SECURITY_HEADERS)
        if declared is not None and (not declared.isdigit() or int(declared) > config.MAX_BODY_BYTES):
            return await too_big(scope, receive, send)
        seen = 0

        async def limited_receive():
            nonlocal seen
            msg = await receive()
            if msg["type"] == "http.request":
                seen += len(msg.get("body", b""))
                if seen > config.MAX_BODY_BYTES:
                    raise _TooBig()
            return msg

        try:
            await self.app(scope, limited_receive, send)
        except _TooBig:
            await too_big(scope, receive, send)


class _TooBig(Exception):
    pass


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    for k, v in SECURITY_HEADERS.items():
        response.headers[k] = v
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    return response


app.add_middleware(BodyLimit)


@app.exception_handler(RequestValidationError)
async def validation_error(request: Request, exc: RequestValidationError):
    # Field path and message only: never echo the submitted input back.
    details = [{"field": ".".join(str(p) for p in e.get("loc", ()) if p not in ("body", "query"))[:60],
                "problem": str(e.get("msg", "invalid"))[:160]} for e in exc.errors()[:10]]
    return JSONResponse({"error": "Invalid request.", "details": details}, status_code=422)


@app.exception_handler(StarletteHTTPException)
async def http_error(request: Request, exc: StarletteHTTPException):
    messages = {404: "Not found.", 405: "Method not allowed."}
    return JSONResponse({"error": messages.get(exc.status_code, "Request failed.")},
                        status_code=exc.status_code)


@app.exception_handler(Exception)
async def unhandled(request: Request, exc: Exception):
    log.error("unhandled error on %s: %s",
              request.url.path, type(exc).__name__)
    return JSONResponse({"error": "Something went wrong."}, status_code=500)


# ---------------------------------------------------------------------------- helpers
def _filter(customers, q):
    out = customers
    for field in ("contract", "tenure_band", "risk_band"):
        v = getattr(q, field)
        if v is not None:
            key = "band" if field == "risk_band" else field
            out = [c for c in out if (
                c[key] if key in c else c["profile"][key]) == v]
    if q.internet_service is not None:
        out = [c for c in out if c["profile"]
               ["internet_service"] == q.internet_service]
    return out


def _summary_row(c):
    return {"id": c["id"], "probability": c["probability"], "band": c["band"],
            "churned": c["churned"], "contract": c["profile"]["contract"],
            "tenure_months": c["profile"]["tenure_months"],
            "internet_service": c["profile"]["internet_service"],
            "monthly_charges": c["monthly_charges"],
            "drivers": [d for d in c["drivers"] if d["impact"] > 0][:3],
            "action": c["action"]}


def _detail(c):
    return {**_summary_row(c), "profile": c["profile"], "drivers": c["drivers"],
            "base_logodds": c["base_logodds"]}


# ---------------------------------------------------------------------------- routes
@app.api_route("/", methods=["GET", "HEAD"], include_in_schema=False)
def index():
    return FileResponse(config.STATIC_DIR / "index.html", headers={"Cache-Control": "no-cache"})


@app.get("/api/health")
def health():
    return {"status": "ok", "customers": len(portfolio.customers)}


@app.get("/api/config")
def ui_config():
    return {"assistant_enabled": config.hf_token() is not None,
            "question_max_chars": config.QUESTION_MAX_CHARS,
            "risk_bands": {"high": config.HIGH_RISK, "medium": config.MEDIUM_RISK},
            "presets": portfolio.presets,
            "tenure_bands": TENURE_BANDS, "protection_bands": PROTECTION_BANDS}


@app.get("/api/summary")
def summary(q: Annotated[CampaignQuery, Query()]):
    cs = portfolio.customers  # sorted riskiest first
    n = len(cs)
    k = max(1, round(n * q.target_share))
    target = cs[:k]
    churners = sum(c["churned"] for c in cs)
    exp_in_target = sum(c["probability"] for c in target)
    saved = q.save_rate * exp_in_target
    revenue_kept = q.save_rate * \
        sum(c["probability"] * c["monthly_charges"]
            for c in target) * q.horizon_months
    cost = k * q.contact_cost + saved * q.offer_cost
    return {
        "customers": n,
        "roc_auc": portfolio.report["roc_auc"],
        "target_share": q.target_share,
        "contacted": k,
        "churners_total": churners,
        "churners_reached": sum(c["churned"] for c in target),
        "share_of_churners_reached": round(sum(c["churned"] for c in target) / churners, 4),
        "expected_churners": round(sum(c["probability"] for c in cs), 1),
        "revenue_at_risk": round(sum(c["probability"] * c["monthly_charges"] for c in cs) * q.horizon_months),
        "revenue_at_risk_monthly": round(sum(c["probability"] * c["monthly_charges"] for c in cs)),
        "campaign": {"expected_saved_customers": round(saved, 1),
                     "revenue_retained": round(revenue_kept), "cost": round(cost),
                     "net_saving": round(revenue_kept - cost)},
        "assumptions": q.model_dump(),
    }


@app.get("/api/segments")
def segments(q: Annotated[SegmentQuery, Query()]):
    cs = _filter(portfolio.customers, q)
    groups: dict[str, list] = {}
    for c in cs:
        key = c[q.by] if q.by in (
            "tenure_band", "protection") else c["profile"][q.by]
        groups.setdefault(str(key), []).append(c)
    order = {"tenure_band": TENURE_BANDS,
             "protection": PROTECTION_BANDS}.get(q.by)
    keys = [k for k in order if k in groups] if order else sorted(
        groups, key=lambda k: -sum(c["probability"] for c in groups[k]) / len(groups[k]))
    rows = []
    for k in keys:
        g = groups[k]
        rows.append({"segment": k, "customers": len(g),
                     "avg_risk": round(sum(c["probability"] for c in g) / len(g), 4),
                     "expected_churners": round(sum(c["probability"] for c in g), 1),
                     "actual_churn_rate": round(sum(c["churned"] for c in g) / len(g), 4),
                     "revenue_at_risk_monthly": round(sum(c["probability"] * c["monthly_charges"] for c in g)),
                     "high_risk_customers": sum(c["band"] == "High" for c in g)})
    totals = {"expected_churners": round(sum(c["probability"] for c in cs), 1),
              "revenue_at_risk_monthly": round(sum(c["probability"] * c["monthly_charges"] for c in cs)),
              "high_risk_customers": sum(c["band"] == "High" for c in cs)}
    return {"by": q.by, "filtered_customers": len(cs), "totals": totals, "rows": rows}


@app.get("/api/customers")
def customers(q: Annotated[CustomerQuery, Query()]):
    cs = _filter(portfolio.customers, q)
    return {"total": len(cs), "offset": q.offset,
            "rows": [_summary_row(c) for c in cs[q.offset:q.offset + q.limit]]}


@app.get("/api/customers/{customer_id}")
def customer(customer_id: Annotated[str, Path(pattern=r"^\d{4}-[A-Z]{5}$", max_length=10)]):
    c = portfolio.by_id.get(customer_id)
    if c is None:
        raise StarletteHTTPException(404)
    return _detail(c)


@app.post("/api/score")
def score(profile: Profile):
    p = profile.model_dump()
    s = model.score([p])[0]
    drift.record(p, s["probability"])
    return {"probability": s["probability"], "band": s["band"], "drivers": s["drivers"],
            "action": s["action"], "base_logodds": s["base_logodds"]}


@app.get("/api/drift")
def drift_report():
    return drift.report()


@app.get("/api/model")
def model_report():
    return portfolio.report


@app.post("/api/assistant")
def ask(body: AssistantRequest, request: Request):
    c = portfolio.by_id.get(body.customer_id)
    if c is None:
        raise StarletteHTTPException(404)
    ip = assistant.client_ip(
        request.headers, request.client.host if request.client else None)
    return assistant.answer(c, body.question, ip)


app.mount("/static", StaticFiles(directory=config.STATIC_DIR), name="static")
