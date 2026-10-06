"""Send customers to the running server's /api/score, then print /api/drift.

  python scripts/drift_demo.py normal    # random real customers -> expect ok
  python scripts/drift_demo.py shifted   # month-to-month, high charges -> expect alert
Run from the project root, with the server already running on port 8000.
"""
import json
import random
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from app.main import portfolio  # noqa: E402

BASE = "http://localhost:8000"


def get(path):
    with urllib.request.urlopen(BASE + path) as r:
        return json.load(r)


def post(path, body):
    req = urllib.request.Request(
        BASE + path, json.dumps(body).encode(),
        {"Content-Type": "application/json"})
    with urllib.request.urlopen(req) as r:
        return json.load(r)


def main(mode):
    profiles = [c["profile"] for c in portfolio.customers]
    if mode == "shifted":
        profiles = [p for p in profiles
                    if p.get("contract") == "Month-to-month"
                    and p.get("monthly_charges", 0) > 70]
    sent = 0
    for _ in range(60):
        try:
            post("/api/score", random.choice(profiles))
            sent += 1
        except Exception as e:
            print("score failed:", e)
            break
    print(f"sent {sent} profiles")
    print(json.dumps(get("/api/drift"), indent=1))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "normal")
