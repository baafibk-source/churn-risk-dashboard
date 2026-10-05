"""API tests, including hostile and malformed input. No network calls are made:
the LLM call is monkeypatched, and HF_TOKEN is only ever a fake value."""

import json

import pytest
from fastapi.testclient import TestClient

from app import assistant, config
from app.main import app, portfolio

client = TestClient(app)
PRESET = portfolio.presets[0]["customer_id"]
FAKE_TOKEN = "hf_FAKE_test_token_do_not_leak_123"

GOOD = {
    "gender": "Female", "senior_citizen": False, "partner": False, "dependents": False,
    "tenure_months": 3, "phone_service": True, "multiple_lines": "No",
    "internet_service": "Fiber optic", "online_security": "No", "online_backup": "No",
    "device_protection": "No", "tech_support": "No", "streaming_tv": "Yes",
    "streaming_movies": "No", "contract": "Month-to-month", "paperless_billing": True,
    "payment_method": "Electronic check", "monthly_charges": 89.5, "total_charges": None,
}


@pytest.fixture(autouse=True)
def reset_limits(monkeypatch):
    monkeypatch.delenv("HF_TOKEN", raising=False)
    assistant.limiter.__init__()


def assert_generic_error(r, status):
    assert r.status_code == status, r.text
    body = r.json()
    assert set(body) <= {"error", "details"}
    assert "Traceback" not in r.text


# ------------------------------------------------------------------ surface
@pytest.mark.parametrize("path", ["/docs", "/redoc", "/openapi.json", "/docs/oauth2-redirect"])
def test_docs_disabled(path):
    assert client.get(path).status_code == 404


def test_security_headers_and_no_cors():
    r = client.get("/", headers={"Origin": "https://evil.example"})
    assert r.status_code == 200
    csp = r.headers["content-security-policy"]
    assert "frame-ancestors 'self' https://huggingface.co https://*.hf.space" in csp
    assert "script-src 'self'" in csp and "unsafe-inline" not in csp
    assert "x-frame-options" not in r.headers  # would block the HF iframe
    assert "access-control-allow-origin" not in r.headers
    pre = client.options("/api/score", headers={"Origin": "https://evil.example",
                                                "Access-Control-Request-Method": "POST"})
    assert "access-control-allow-origin" not in pre.headers
    assert client.head("/").status_code == 200


@pytest.mark.parametrize("path", ["/static/../app/config.py", "/static/%2e%2e/app/config.py",
                                  "/static/..%2fapp%2fconfig.py", "/artifacts/model.json"])
def test_no_path_traversal(path):
    r = client.get(path)
    assert r.status_code == 404
    assert "HF_TOKEN" not in r.text


# ------------------------------------------------------------------ model correctness
def test_runtime_auc_matches_report():
    cs = portfolio.customers
    pos = [c["probability"] for c in cs if c["churned"]]
    neg = [c["probability"] for c in cs if not c["churned"]]
    wins = sum((p > n) + 0.5 * (p == n) for p in pos for n in neg)
    assert round(wins / (len(pos) * len(neg)),
                 4) == portfolio.report["roc_auc"]


def test_score_ok_and_shap_adds_up():
    r = client.post("/api/score", json=GOOD)
    assert r.status_code == 200
    d = r.json()
    assert 0 < d["probability"] < 1 and d["band"] in {"High", "Medium", "Low"}
    assert d["action"]["steps"]


# ------------------------------------------------------------------ bad score inputs
BAD_PROFILES = {
    "string number": {"tenure_months": "3"},
    "string bool": {"partner": "yes"},
    "int bool": {"partner": 1},
    "tenure too high": {"tenure_months": 73},
    "negative tenure": {"tenure_months": -1},
    "float tenure": {"tenure_months": 3.5},
    "charges too low": {"monthly_charges": 1},
    "charges huge": {"monthly_charges": 1e308},
    "unknown contract": {"contract": "Lifetime"},
    "script in enum": {"gender": "<script>alert(1)</script>"},
    "inconsistent add-on": {"online_security": "No internet service"},
    "inconsistent phone": {"phone_service": False},
    "null required": {"contract": None},
    "negative total": {"total_charges": -5},
}


@pytest.mark.parametrize("name", BAD_PROFILES)
def test_score_rejects_bad_profiles(name):
    r = client.post("/api/score", json={**GOOD, **BAD_PROFILES[name]})
    assert_generic_error(r, 422)
    assert "<script>" not in r.text  # input never echoed


def test_score_rejects_extra_and_missing_fields():
    assert_generic_error(client.post(
        "/api/score", json={**GOOD, "is_admin": True}), 422)
    missing = dict(GOOD)
    del missing["contract"]
    assert_generic_error(client.post("/api/score", json=missing), 422)


@pytest.mark.parametrize("raw", ["{not json", "[]", "null", '"text"', '{"tenure_months": NaN}', ""])
def test_score_rejects_malformed_json(raw):
    r = client.post("/api/score", content=raw,
                    headers={"Content-Type": "application/json"})
    assert_generic_error(r, 422)


def test_body_size_cap():
    big = {**GOOD, "padding": "x" * 10_000}
    r = client.post("/api/score", content=json.dumps(big),
                    headers={"Content-Type": "application/json"})
    assert_generic_error(r, 413)


def test_wrong_method():
    assert_generic_error(client.get("/api/score"), 405)


# ------------------------------------------------------------------ bad query inputs
@pytest.mark.parametrize("url", [
    "/api/summary?target_share=5", "/api/summary?target_share=abc", "/api/summary?save_rate=-0.1",
    "/api/summary?horizon_months=0", "/api/summary?contact_cost=nan", "/api/summary?debug=1",
    "/api/segments?by=__class__", "/api/segments?contract=Lifetime", "/api/segments?risk_band=high",
    "/api/customers?limit=1000", "/api/customers?offset=-1", "/api/customers?sort=id",
])
def test_bad_queries(url):
    assert_generic_error(client.get(url), 422)


def test_good_queries():
    r = client.get(
        "/api/summary?target_share=0.3&save_rate=0.5&contact_cost=0&offer_cost=0&horizon_months=24")
    assert r.status_code == 200 and r.json()["contacted"] == round(1409 * 0.3)
    r = client.get(
        "/api/segments?by=tenure_band&contract=Month-to-month&risk_band=High")
    assert r.status_code == 200 and r.json()["rows"]
    r = client.get("/api/customers?limit=5&risk_band=Low")
    rows = r.json()["rows"]
    assert len(rows) == 5 and all(x["band"] == "Low" for x in rows)
    probs = [x["probability"]
             for x in client.get("/api/customers?limit=50").json()["rows"]]
    assert probs == sorted(probs, reverse=True)


@pytest.mark.parametrize("cid,status", [("1234-abcde", 422), ("x" * 500, 422), ("0000-ZZZZZ", 404),
                                        ("..%2F..%2Fetc%2Fpasswd", 404)])
def test_customer_ids(cid, status):
    assert_generic_error(client.get(f"/api/customers/{cid}"), status)


# ------------------------------------------------------------------ assistant
def test_assistant_off_without_token():
    assert client.get("/api/config").json()["assistant_enabled"] is False
    r = client.post("/api/assistant", json={"customer_id": PRESET})
    d = r.json()
    assert r.status_code == 200 and d["source"] == "template" and "switched off" in d["notice"]


@pytest.mark.parametrize("body", [
    {"customer_id": PRESET, "question": "x" * (config.QUESTION_MAX_CHARS + 1)},
    {"customer_id": PRESET, "question": ""},
    {"customer_id": PRESET, "question": "\u0000\u0007"},
    {"customer_id": PRESET, "question": 42},
    {"customer_id": 1234},
    {"customer_id": PRESET, "model": "gpt-4"},
    {},
])
def test_assistant_bad_input(body):
    assert_generic_error(client.post("/api/assistant", json=body), 422)


def test_assistant_unknown_customer():
    assert_generic_error(client.post(
        "/api/assistant", json={"customer_id": "0000-ZZZZZ"}), 404)


def test_assistant_error_never_leaks_token(monkeypatch):
    monkeypatch.setenv("HF_TOKEN", FAKE_TOKEN)

    def boom(token, messages):
        raise RuntimeError(
            f"upstream 401 for token {token} at {config.LLM_URL}")

    monkeypatch.setattr(assistant, "_call_llm", boom)
    r = client.post("/api/assistant",
                    json={"customer_id": PRESET, "question": "Why?"})
    assert r.status_code == 200
    assert FAKE_TOKEN not in r.text and "401" not in r.text and "router" not in r.text
    assert r.json()["source"] == "template"
    assert FAKE_TOKEN not in client.get("/api/config").text


def test_assistant_rate_limit_and_length_cap(monkeypatch):
    monkeypatch.setenv("HF_TOKEN", FAKE_TOKEN)
    calls = []

    def fake(token, messages):
        calls.append(messages)
        return "word " * 1000

    monkeypatch.setattr(assistant, "_call_llm", fake)
    results = [client.post("/api/assistant", json={"customer_id": PRESET}).json()
               for _ in range(config.ASSISTANT_PER_IP_PER_MINUTE + 2)]
    ai = [x for x in results if x["source"] == "ai"]
    assert len(ai) == config.ASSISTANT_PER_IP_PER_MINUTE == len(calls)
    assert all(len(x["text"]) <= config.ANSWER_MAX_CHARS + 1 for x in ai)
    assert "limit" in results[-1]["notice"]
    # The prompt is built from server-side facts, never client-supplied numbers.
    assert "Calibrated churn probability" in calls[0][0]["content"]


def test_client_ip_ignores_spoofed_left_entries():
    assert assistant.client_ip(
        {"x-forwarded-for": "1.2.3.4, 8.8.8.8, 10.0.0.1"}, "10.0.0.2") == "8.8.8.8"
    assert assistant.client_ip(
        {"x-forwarded-for": "garbage"}, "10.0.0.2") == "10.0.0.2"
    assert assistant.client_ip({}, None) == "unknown"


def test_health():
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.json()["status"] == "ok"
    assert r.json()["customers"] == len(portfolio.customers)
