"""Load the model from fixed paths, score customers, explain with TreeSHAP.

SHAP values come from XGBoost's built-in TreeSHAP (pred_contribs=True), in
log-odds. Platt calibration is linear in log-odds (logit p = a*margin + b), so
multiplying each contribution by `a` gives exact additive contributions to the
CALIBRATED log-odds; every number shown is on the calibrated scale.
"""

import json
import math

import numpy as np
import xgboost as xgb

from . import config
from .actions import suggest
from .features import (DRIVER_GROUPS, DRIVER_LABELS, FEATURES, display_value, featurise,
                       protection_band, tenure_band)

_IDX = {f: i for i, f in enumerate(FEATURES)}


class ChurnModel:
    def __init__(self):
        cal = json.loads(config.CALIBRATION_PATH.read_text())
        if cal["features"] != FEATURES:
            raise RuntimeError("feature list mismatch between model artefacts and code")
        self.a, self.b = float(cal["a"]), float(cal["b"])
        self.booster = xgb.Booster(model_file=str(config.MODEL_PATH))
        self.booster.set_param({"nthread": 1})

    def _dmatrix(self, rows):
        return xgb.DMatrix(np.asarray(rows, dtype=float), feature_names=FEATURES)

    def score(self, profiles: list[dict]) -> list[dict]:
        dm = self._dmatrix([featurise(p) for p in profiles])
        margins = self.booster.predict(dm, output_margin=True)
        contribs = self.booster.predict(dm, pred_contribs=True)
        out = []
        for p, m, c in zip(profiles, margins, contribs):
            prob = 1.0 / (1.0 + math.exp(-(self.a * float(m) + self.b)))
            drivers = []
            for group, cols in DRIVER_GROUPS.items():
                impact = self.a * float(sum(c[_IDX[col]] for col in cols))
                drivers.append({"group": group, "label": DRIVER_LABELS[group],
                                "value": display_value(group, p), "impact": round(impact, 4)})
            drivers.sort(key=lambda d: abs(d["impact"]), reverse=True)
            drivers = [d for d in drivers if abs(d["impact"]) >= 0.005]
            band = risk_band(prob)
            out.append({"probability": round(prob, 4), "band": band,
                        "base_logodds": round(self.a * float(c[-1]) + self.b, 4),
                        "drivers": drivers[:8], "action": suggest(p, prob, band, drivers)})
        return out


def risk_band(prob: float) -> str:
    if prob >= config.HIGH_RISK:
        return "High"
    if prob >= config.MEDIUM_RISK:
        return "Medium"
    return "Low"


class Portfolio:
    """Held-out test customers, scored once at start-up."""

    def __init__(self, model: ChurnModel):
        data = json.loads(config.PORTFOLIO_PATH.read_text())
        self.presets = data["presets"]
        rows = data["customers"]
        scored = model.score([r["profile"] for r in rows])
        self.customers = []
        for r, s in zip(rows, scored):
            p = r["profile"]
            self.customers.append({
                "id": r["id"], "churned": r["churned"], "profile": p, **s,
                "monthly_charges": p["monthly_charges"],
                "tenure_band": tenure_band(p["tenure_months"]),
                "protection": protection_band(p),
            })
        self.customers.sort(key=lambda c: c["probability"], reverse=True)
        self.by_id = {c["id"]: c for c in self.customers}
        self.report = json.loads(config.REPORT_PATH.read_text())
