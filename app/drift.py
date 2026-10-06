from collections import Counter, deque
from threading import Lock

import numpy as np
from scipy.stats import ks_2samp

MIN_SAMPLES = 30
WINDOW = 500
EPS = 1e-4


def _psi(ref_p, live_p):
    r = np.clip(np.asarray(ref_p, float), EPS, None)
    l = np.clip(np.asarray(live_p, float), EPS, None)
    return float(np.sum((l - r) * np.log(l / r)))


def _level(psi):
    return "alert" if psi > 0.25 else "watch" if psi > 0.10 else "ok"


def _is_num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _numeric(ref, live):
    ref, live = np.asarray(ref, float), np.asarray(live, float)
    edges = np.unique(np.quantile(ref, np.linspace(0, 1, 6)))
    if len(edges) < 3:
        psi = 0.0
    else:
        edges[0], edges[-1] = -np.inf, np.inf
        psi = _psi(np.histogram(ref, edges)[0] / len(ref),
                   np.histogram(live, edges)[0] / len(live))
    return psi, float(ks_2samp(ref, live).pvalue)


def _categorical(ref, live):
    cats = sorted(set(ref) | set(live))
    rc, lc = Counter(ref), Counter(live)
    return _psi([rc[c] / len(ref) for c in cats],
                [lc[c] / len(live) for c in cats])


class DriftMonitor:
    def __init__(self, ref_profiles, ref_scores):
        self.ref = list(ref_profiles)
        self.ref_scores = list(ref_scores)
        self.live = deque(maxlen=WINDOW)
        self.live_scores = deque(maxlen=WINDOW)
        self._lock = Lock()

    def record(self, profile, probability):
        with self._lock:
            self.live.append(dict(profile))
            self.live_scores.append(float(probability))

    def report(self):
        with self._lock:
            live, scores = list(self.live), list(self.live_scores)
        n = len(live)
        if n < MIN_SAMPLES:
            return {"status": "insufficient_data", "n": n, "needed": MIN_SAMPLES}
        features = []
        for key, sample in self.ref[0].items():
            lv = [p[key] for p in live if key in p]
            if len(lv) < MIN_SAMPLES:
                continue
            rv = [p[key] for p in self.ref]
            if _is_num(sample):
                psi, ks_p = _numeric(rv, lv)
                features.append({"feature": key, "psi": round(psi, 3),
                                 "ks_p": round(ks_p, 4), "level": _level(psi)})
            else:
                psi = _categorical([str(v) for v in rv], [str(v) for v in lv])
                features.append({"feature": key, "psi": round(psi, 3),
                                 "level": _level(psi)})
        s_psi, s_ks = _numeric(self.ref_scores, scores)
        score = {"psi": round(s_psi, 3), "ks_p": round(
            s_ks, 4), "level": _level(s_psi)}
        features.sort(key=lambda f: f["psi"], reverse=True)
        order = {"ok": 0, "watch": 1, "alert": 2}
        worst = max([f["level"] for f in features] +
                    [score["level"]], key=order.get)
        return {"status": worst, "n": n, "score": score, "features": features}
