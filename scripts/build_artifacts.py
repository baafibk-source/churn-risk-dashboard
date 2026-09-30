"""Offline build: turn the saved dissertation model into dashboard artefacts.

Run once from the project root (needs requirements-build.txt, NOT used at runtime):

    python scripts/build_artifacts.py

Inputs (fixed paths):
    data/IBM_Telco_customer_churn_IBM_dataset.csv   raw dataset (not committed)
    source_model/best_xgb.joblib                     saved tuned XGBoost (xgboost 2.1.4)

Outputs (artifacts/):
    model.json          the same booster in XGBoost's native JSON format, so the
                        API never unpickles anything
    calibration.json    Platt scaling fitted on out-of-fold TRAINING predictions
    portfolio.json      the 1,409 held-out test customers + preset customer ids
    model_report.json   metrics, ROC, gains, calibration curves, duplicate audit

Steps:
 1. Rebuild features exactly as the dissertation pipeline did and check the
    shared featuriser (app/features.py) reproduces them on every row.
 2. Reproduce the 80/20 stratified split (seed 42) and confirm the saved model
    scores the dissertation's test AUC on UNSCALED features.
 3. Calibrate. The saved model was trained with scale_pos_weight=2.77, so its
    raw probabilities overstate churn. Calibration must not touch the test set,
    and fitting it on in-sample training predictions would be biased, so:
    5-fold out-of-fold margins on the training partition (same hyperparameters),
    then Platt scaling on those margins. Same idea as scikit-learn's
    CalibratedClassifierCV(ensemble=False). Platt is monotone and linear in
    log-odds, so SHAP contributions stay additive in calibrated log-odds.
 4. Evaluate raw vs calibrated on the untouched test set.
"""

import json
import sys
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
import xgboost as xgb
from sklearn.isotonic import IsotonicRegression
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import brier_score_loss, log_loss, roc_auc_score, roc_curve
from sklearn.model_selection import StratifiedKFold, train_test_split

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from app.features import FEATURES, FIELD_TO_COLUMN, BOOL_FIELDS, featurise  # noqa: E402

DATA = ROOT / "data" / "IBM_Telco_customer_churn_IBM_dataset.csv"
SOURCE_MODEL = ROOT / "source_model" / "best_xgb.joblib"
OUT = ROOT / "artifacts"
SEED = 42
DISSERTATION_TEST_AUC = 0.8546126223875584

DROP = ["CustomerID", "Count", "Country", "State", "City", "Zip Code", "Lat Long",
        "Latitude", "Longitude", "Churn Label", "Churn Value", "Churn Score",
        "Churn Reason", "CLTV"]
SERVICE_COLS = ["Phone Service", "Multiple Lines", "Internet Service", "Online Security",
                "Online Backup", "Device Protection", "Tech Support", "Streaming TV",
                "Streaming Movies"]


def pipeline_features(df: pd.DataFrame) -> pd.DataFrame:
    """Verbatim copy of the dissertation's preprocess()."""
    X = df.drop(columns=DROP)
    X["Avg Monthly Spend"] = X["Total Charges"] / X["Tenure Months"].replace(0, 1)
    X["Tenure Years"] = X["Tenure Months"] / 12
    X["New Customer"] = (X["Tenure Months"] <= 6).astype(int)
    X["Total Services"] = X.apply(
        lambda r: sum(r[s] not in ["No", "No phone service", "No internet service"]
                      for s in SERVICE_COLS), axis=1)
    cat = X.select_dtypes(include=["object", "string"]).columns.tolist()
    return pd.get_dummies(X, columns=cat, drop_first=True)


def to_profile(row: pd.Series) -> dict:
    p = {}
    for field, col in FIELD_TO_COLUMN.items():
        v = row[col]
        if field in BOOL_FIELDS:
            p[field] = v == "Yes"
        elif field == "tenure_months":
            p[field] = int(v)
        elif field in ("monthly_charges", "total_charges"):
            p[field] = round(float(v), 2)
        else:
            p[field] = str(v)
    return p


def sigmoid(z):
    return 1.0 / (1.0 + np.exp(-z))


def ece(y, p, bins=10):
    edges = np.linspace(0, 1, bins + 1)
    idx = np.clip(np.digitize(p, edges[1:-1]), 0, bins - 1)
    total = 0.0
    for b in range(bins):
        m = idx == b
        if m.any():
            total += m.mean() * abs(p[m].mean() - y[m].mean())
    return float(total)


def reliability(y, p, bins=10):
    edges = np.linspace(0, 1, bins + 1)
    idx = np.clip(np.digitize(p, edges[1:-1]), 0, bins - 1)
    out = []
    for b in range(bins):
        m = idx == b
        if m.sum() >= 5:
            out.append({"bin": f"{edges[b]:.0%}–{edges[b + 1]:.0%}", "n": int(m.sum()),
                        "predicted": round(float(p[m].mean()), 4),
                        "observed": round(float(y[m].mean()), 4)})
    return out


def gains(y, p):
    order = np.argsort(-p, kind="stable")
    ys = y[order]
    n, pos = len(y), y.sum()
    rows = []
    for pct in range(5, 101, 5):
        k = int(round(n * pct / 100))
        captured = ys[:k].sum()
        rows.append({"share_contacted": pct / 100, "customers": k,
                     "churners_reached": int(captured),
                     "share_of_churners": round(float(captured / pos), 4),
                     "lift": round(float((captured / pos) / (pct / 100)), 3),
                     "precision": round(float(captured / k), 4)})
    return rows


def main():
    df = pd.read_csv(DATA)
    df["Total Charges"] = pd.to_numeric(df["Total Charges"], errors="coerce").fillna(0)
    y_all = df["Churn Value"].to_numpy()

    # ---- 1. features ------------------------------------------------------------
    Xp = pipeline_features(df)
    model = joblib.load(SOURCE_MODEL)
    assert list(Xp.columns) == list(model.feature_names_in_) == FEATURES
    Xp = Xp.astype(float)
    profiles = [to_profile(r) for _, r in df.iterrows()]
    Xf = np.array([featurise(p) for p in profiles])
    max_diff = float(np.abs(Xf - Xp.to_numpy()).max())
    assert max_diff < 1e-9, max_diff
    print(f"shared featuriser matches pipeline on {len(df)} rows (max diff {max_diff:.1e})")

    # ---- duplicate audit ----------------------------------------------------------
    raw = df.drop(columns=DROP)
    dup_mask = raw.duplicated(keep=False)
    key = list(raw.columns)
    grp = pd.concat([raw, df["Churn Value"]], axis=1)[dup_mask].groupby(key, dropna=False)
    n_groups = grp.ngroups
    conflicting = int((grp["Churn Value"].nunique() > 1).sum())

    # ---- 2. split + sanity check ------------------------------------------------
    idx = np.arange(len(df))
    tr, te = train_test_split(idx, test_size=0.2, stratify=y_all, random_state=SEED)
    Xtr, Xte, ytr, yte = Xp.iloc[tr], Xp.iloc[te], y_all[tr], y_all[te]
    raw_margin_te = model.predict(Xte, output_margin=True)
    p_raw = sigmoid(raw_margin_te)
    auc = roc_auc_score(yte, p_raw)
    assert abs(auc - DISSERTATION_TEST_AUC) < 1e-9, auc
    print(f"saved model reproduces dissertation test AUC {auc:.4f} on unscaled features")

    raw_keys = raw.astype(str).agg("|".join, axis=1)
    train_keys = set(raw_keys.iloc[tr])
    te_in_train = raw_keys.iloc[te].isin(train_keys).to_numpy()
    auc_dedup = roc_auc_score(yte[~te_in_train], p_raw[~te_in_train])
    dup_groups_spanning = int(pd.DataFrame({"k": raw_keys[dup_mask],
                                            "s": np.isin(idx[dup_mask], te)})
                              .groupby("k")["s"].nunique().gt(1).sum())

    # ---- 3. calibration on out-of-fold training margins ------------------------
    params = model.get_params()
    oof = np.zeros(len(tr))
    skf = StratifiedKFold(5, shuffle=True, random_state=SEED)
    for f_tr, f_va in skf.split(Xtr, ytr):
        m = xgb.XGBClassifier(**params)
        m.fit(Xtr.iloc[f_tr], ytr[f_tr])
        oof[f_va] = m.predict(Xtr.iloc[f_va], output_margin=True)
    platt = LogisticRegression(C=1e6, max_iter=1000).fit(oof.reshape(-1, 1), ytr)
    a, b = float(platt.coef_[0, 0]), float(platt.intercept_[0])
    iso = IsotonicRegression(out_of_bounds="clip", y_min=0, y_max=1).fit(sigmoid(oof), ytr)
    print(f"OOF AUC on training partition {roc_auc_score(ytr, oof):.4f}; Platt a={a:.4f} b={b:.4f}")

    # ---- 4. evaluate on the untouched test set ---------------------------------
    p_cal = sigmoid(a * raw_margin_te + b)
    p_iso = iso.predict(p_raw)

    def cal_metrics(p):
        return {"brier": round(float(brier_score_loss(yte, p)), 4),
                "log_loss": round(float(log_loss(yte, p)), 4),
                "ece": round(ece(yte, p), 4),
                "mean_predicted": round(float(p.mean()), 4)}

    fpr, tpr, _ = roc_curve(yte, p_cal)
    keep = np.unique(np.linspace(0, len(fpr) - 1, 120).astype(int))

    # ---- export booster as JSON and check it matches -------------------------
    OUT.mkdir(exist_ok=True)
    booster = model.get_booster()
    booster.save_model(OUT / "model.json")
    b2 = xgb.Booster(model_file=str(OUT / "model.json"))
    m2 = b2.predict(xgb.DMatrix(Xte.to_numpy(), feature_names=FEATURES), output_margin=True)
    assert np.allclose(m2, raw_margin_te, atol=1e-5)

    # ---- presets: real test customers at clearly high / medium / low risk ------
    te_ids = df["CustomerID"].iloc[te].to_numpy()

    def pick(target, **cond):
        cands = [i for i in range(len(te)) if all(profiles[te[i]][k] == v for k, v in cond.items())]
        return min(cands, key=lambda i: abs(p_cal[i] - target))

    presets = [
        {"key": "high", "label": "High risk", "blurb": "One month in, month-to-month fibre, pays by electronic check",
         "customer_id": te_ids[pick(0.75, contract="Month-to-month", internet_service="Fiber optic",
                                    payment_method="Electronic check")]},
        {"key": "medium", "label": "Medium risk", "blurb": "Four years in, but month-to-month and paying by electronic check",
         "customer_id": te_ids[pick(0.35, contract="Month-to-month", internet_service="DSL")]},
        {"key": "low", "label": "Low risk", "blurb": "Two-year contract, pays automatically by card",
         "customer_id": te_ids[pick(0.02, contract="Two year", payment_method="Credit card (automatic)")]},
    ]

    portfolio = {
        "note": "Held-out test customers (20% stratified split, seed 42). The model never saw them in training "
                "or calibration.",
        "customers": [{"id": te_ids[i], "churned": int(yte[i]), "profile": profiles[te[i]]}
                      for i in range(len(te))],
        "presets": [{**p, "customer_id": str(p["customer_id"])} for p in presets],
    }
    (OUT / "portfolio.json").write_text(json.dumps(portfolio, separators=(",", ":")))
    (OUT / "calibration.json").write_text(json.dumps({
        "method": "platt", "a": a, "b": b, "fitted_on": "5-fold out-of-fold margins, training partition",
        "features": FEATURES}, indent=2))

    report = {
        "dataset": {"rows": len(df), "train_rows": len(tr), "test_rows": len(te),
                    "churn_rate": round(float(y_all.mean()), 4),
                    "test_churn_rate": round(float(yte.mean()), 4)},
        "roc_auc": round(float(auc), 4),
        "roc_auc_excluding_profiles_seen_in_training": round(float(auc_dedup), 4),
        "roc_auc_oof_train": round(float(roc_auc_score(ytr, oof)), 4),
        "cv_auc_reported": 0.8644,
        "hyperparameters": {k: params[k] for k in ["max_depth", "learning_rate", "n_estimators",
                                                  "subsample", "colsample_bytree"]}
                           | {"scale_pos_weight": round(float(params["scale_pos_weight"]), 3)},
        "roc_curve": [{"fpr": round(float(fpr[i]), 4), "tpr": round(float(tpr[i]), 4)} for i in keep],
        "gains": gains(yte, p_cal),
        "calibration": {
            "method": "Platt scaling on 5-fold out-of-fold margins from the training partition",
            "platt": {"a": round(a, 4), "b": round(b, 4)},
            "before": cal_metrics(p_raw), "after": cal_metrics(p_cal),
            "isotonic_for_comparison": cal_metrics(p_iso),
            "observed_rate": round(float(yte.mean()), 4),
            "curve_before": reliability(yte, p_raw), "curve_after": reliability(yte, p_cal),
        },
        "duplicates": {
            "duplicate_customer_ids": int(df["CustomerID"].duplicated().sum()),
            "exact_duplicate_rows": int(df.duplicated().sum()),
            "rows_sharing_identical_model_inputs": int(dup_mask.sum()),
            "profile_groups": int(n_groups),
            "groups_with_conflicting_outcomes": conflicting,
            "groups_split_across_train_and_test": dup_groups_spanning,
            "test_rows_with_profile_seen_in_training": int(te_in_train.sum()),
            "action": "Kept. IDs are unique, every match is a 1-month, month-to-month customer (so total "
                      "charges equal the monthly charge), and every group spans different cities, so these "
                      "are different people with the same simple profile, not copied records. Test AUC "
                      "without the overlapping rows is reported alongside.",
            "all_tenure_one_month": bool((raw[dup_mask]["Tenure Months"] == 1).all()),
            "groups_spanning_multiple_cities": int(
                (df[dup_mask].groupby(key, dropna=False)["City"].nunique() > 1).sum()),
        },
    }
    (OUT / "model_report.json").write_text(json.dumps(report, indent=2))

    print(json.dumps({k: report[k] for k in ["roc_auc", "roc_auc_excluding_profiles_seen_in_training",
                                             "duplicates"]}, indent=2))
    print("calibration", json.dumps({k: report["calibration"][k] for k in
                                     ["before", "after", "isotonic_for_comparison"]}, indent=2))
    print("top 20% reach", report["gains"][3])
    print("presets", [(p["key"], p["customer_id"]) for p in portfolio["presets"]])
    q = np.quantile(p_cal, [0.1, 0.25, 0.5, 0.75, 0.9])
    print("calibrated p quantiles", np.round(q, 3), "share >=0.5", (p_cal >= 0.5).mean(),
          "share >=0.25", (p_cal >= 0.25).mean())


if __name__ == "__main__":
    main()
