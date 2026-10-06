from app.drift import DriftMonitor, MIN_SAMPLES


def make_ref(n=200):
    profiles = [{"contract": "Month-to-month" if i % 2 else "Two year",
                 "monthly_charges": 20.0 + (i % 100)} for i in range(n)]
    scores = [(i % 100) / 100 for i in range(n)]
    return profiles, scores


def test_insufficient_data_until_min_samples():
    profiles, scores = make_ref()
    m = DriftMonitor(profiles, scores)
    for p, s in zip(profiles[:MIN_SAMPLES - 1], scores):
        m.record(p, s)
    assert m.report()["status"] == "insufficient_data"


def test_same_distribution_is_ok():
    profiles, scores = make_ref()
    m = DriftMonitor(profiles, scores)
    for p, s in zip(profiles, scores):
        m.record(p, s)
    assert m.report()["status"] == "ok"


def test_shifted_distribution_alerts():
    profiles, scores = make_ref()
    m = DriftMonitor(profiles, scores)
    for _ in range(60):
        m.record({"contract": "Month-to-month",
                 "monthly_charges": 119.0}, 0.95)
    r = m.report()
    assert r["status"] == "alert"
    assert r["features"][0]["level"] == "alert"


def test_drift_endpoint_responds():
    from fastapi.testclient import TestClient
    from app.main import app
    r = TestClient(app).get("/api/drift")
    assert r.status_code == 200
    assert "status" in r.json()
