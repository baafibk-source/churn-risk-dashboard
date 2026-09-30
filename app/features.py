"""Feature engineering shared by the offline build script and the API.

Mirrors `preprocess()` in the dissertation pipeline exactly (the build script
asserts this against the pandas version on all 7,043 rows), so the saved
XGBoost model sees the same 34 columns, in the same order, that it was trained on.
The model was trained on UNSCALED features; no scaler is applied.
"""

FEATURES = [
    "Tenure Months", "Monthly Charges", "Total Charges", "Avg Monthly Spend",
    "Tenure Years", "New Customer", "Total Services", "Gender_Male",
    "Senior Citizen_Yes", "Partner_Yes", "Dependents_Yes", "Phone Service_Yes",
    "Multiple Lines_No phone service", "Multiple Lines_Yes",
    "Internet Service_Fiber optic", "Internet Service_No",
    "Online Security_No internet service", "Online Security_Yes",
    "Online Backup_No internet service", "Online Backup_Yes",
    "Device Protection_No internet service", "Device Protection_Yes",
    "Tech Support_No internet service", "Tech Support_Yes",
    "Streaming TV_No internet service", "Streaming TV_Yes",
    "Streaming Movies_No internet service", "Streaming Movies_Yes",
    "Contract_One year", "Contract_Two year", "Paperless Billing_Yes",
    "Payment Method_Credit card (automatic)", "Payment Method_Electronic check",
    "Payment Method_Mailed check",
]

ADDONS = ["online_security", "online_backup", "device_protection", "tech_support",
          "streaming_tv", "streaming_movies"]
PROTECTION_ADDONS = ["online_security", "online_backup", "device_protection", "tech_support"]

# Profile field -> dataset column name
FIELD_TO_COLUMN = {
    "gender": "Gender", "senior_citizen": "Senior Citizen", "partner": "Partner",
    "dependents": "Dependents", "tenure_months": "Tenure Months",
    "phone_service": "Phone Service", "multiple_lines": "Multiple Lines",
    "internet_service": "Internet Service", "online_security": "Online Security",
    "online_backup": "Online Backup", "device_protection": "Device Protection",
    "tech_support": "Tech Support", "streaming_tv": "Streaming TV",
    "streaming_movies": "Streaming Movies", "contract": "Contract",
    "paperless_billing": "Paperless Billing", "payment_method": "Payment Method",
    "monthly_charges": "Monthly Charges", "total_charges": "Total Charges",
}
BOOL_FIELDS = {"senior_citizen", "partner", "dependents", "phone_service", "paperless_billing"}

# SHAP values are summed within these groups so each driver is one thing a
# person recognises (e.g. "Contract: Month-to-month" instead of two dummies).
# Summing is exact because SHAP values are additive.
DRIVER_GROUPS = {
    "tenure": ["Tenure Months", "Tenure Years", "New Customer"],
    "monthly_charges": ["Monthly Charges", "Avg Monthly Spend"],
    "total_charges": ["Total Charges"],
    "services_count": ["Total Services"],
    "gender": ["Gender_Male"],
    "senior_citizen": ["Senior Citizen_Yes"],
    "partner": ["Partner_Yes"],
    "dependents": ["Dependents_Yes"],
    "phone_service": ["Phone Service_Yes"],
    "multiple_lines": ["Multiple Lines_No phone service", "Multiple Lines_Yes"],
    "internet_service": ["Internet Service_Fiber optic", "Internet Service_No"],
    "online_security": ["Online Security_No internet service", "Online Security_Yes"],
    "online_backup": ["Online Backup_No internet service", "Online Backup_Yes"],
    "device_protection": ["Device Protection_No internet service", "Device Protection_Yes"],
    "tech_support": ["Tech Support_No internet service", "Tech Support_Yes"],
    "streaming_tv": ["Streaming TV_No internet service", "Streaming TV_Yes"],
    "streaming_movies": ["Streaming Movies_No internet service", "Streaming Movies_Yes"],
    "contract": ["Contract_One year", "Contract_Two year"],
    "paperless_billing": ["Paperless Billing_Yes"],
    "payment_method": ["Payment Method_Credit card (automatic)",
                       "Payment Method_Electronic check", "Payment Method_Mailed check"],
}
DRIVER_LABELS = {
    "tenure": "Tenure", "monthly_charges": "Monthly charges",
    "total_charges": "Total charges to date", "services_count": "Number of services",
    "gender": "Gender", "senior_citizen": "Senior citizen", "partner": "Has partner",
    "dependents": "Has dependants", "phone_service": "Phone service",
    "multiple_lines": "Multiple lines", "internet_service": "Internet service",
    "online_security": "Online security", "online_backup": "Online backup",
    "device_protection": "Device protection", "tech_support": "Tech support",
    "streaming_tv": "Streaming TV", "streaming_movies": "Streaming movies",
    "contract": "Contract", "paperless_billing": "Paperless billing",
    "payment_method": "Payment method",
}
# Drivers a retention team cannot act on; shown for transparency, never turned into actions.
DEMOGRAPHIC_DRIVERS = {"gender", "senior_citizen", "partner", "dependents"}


def _yes(v) -> bool:
    return v is True or v == "Yes"


def total_services(p: dict) -> int:
    count = int(_yes(p["phone_service"]))
    count += int(p["multiple_lines"] == "Yes")
    count += int(p["internet_service"] != "No")
    count += sum(int(p[a] == "Yes") for a in ADDONS)
    return count


def featurise(p: dict) -> list[float]:
    """Profile dict (API field names) -> 34 floats in model column order."""
    t = float(p["tenure_months"])
    m = float(p["monthly_charges"])
    tc = p.get("total_charges")
    tc = m * t if tc is None else float(tc)
    row = dict.fromkeys(FEATURES, 0.0)
    row["Tenure Months"] = t
    row["Monthly Charges"] = m
    row["Total Charges"] = tc
    row["Avg Monthly Spend"] = tc / (t if t != 0 else 1.0)
    row["Tenure Years"] = t / 12
    row["New Customer"] = float(t <= 6)
    row["Total Services"] = float(total_services(p))
    row["Gender_Male"] = float(p["gender"] == "Male")
    row["Senior Citizen_Yes"] = float(_yes(p["senior_citizen"]))
    row["Partner_Yes"] = float(_yes(p["partner"]))
    row["Dependents_Yes"] = float(_yes(p["dependents"]))
    row["Phone Service_Yes"] = float(_yes(p["phone_service"]))
    if p["multiple_lines"] != "No":
        row[f"Multiple Lines_{p['multiple_lines']}"] = 1.0
    if p["internet_service"] != "DSL":
        row[f"Internet Service_{p['internet_service']}"] = 1.0
    for field in ADDONS:
        if p[field] != "No":
            row[f"{FIELD_TO_COLUMN[field]}_{p[field]}"] = 1.0
    if p["contract"] != "Month-to-month":
        row[f"Contract_{p['contract']}"] = 1.0
    row["Paperless Billing_Yes"] = float(_yes(p["paperless_billing"]))
    if p["payment_method"] != "Bank transfer (automatic)":
        row[f"Payment Method_{p['payment_method']}"] = 1.0
    return [row[f] for f in FEATURES]


def tenure_band(t: int) -> str:
    if t <= 6:
        return "0–6 months"
    if t <= 12:
        return "7–12 months"
    if t <= 24:
        return "1–2 years"
    if t <= 48:
        return "2–4 years"
    return "4–6 years"


TENURE_BANDS = ["0–6 months", "7–12 months", "1–2 years", "2–4 years", "4–6 years"]


def protection_band(p: dict) -> str:
    n = sum(int(p[a] == "Yes") for a in PROTECTION_ADDONS)
    if p["internet_service"] == "No":
        return "No internet"
    return {0: "None", 1: "1–2", 2: "1–2"}.get(n, "3–4")


PROTECTION_BANDS = ["None", "1–2", "3–4", "No internet"]


def display_value(group: str, p: dict) -> str:
    """Human-readable value of a driver group for one customer."""
    if group == "tenure":
        t = int(p["tenure_months"])
        return f"{t} month" + ("" if t == 1 else "s")
    if group == "monthly_charges":
        return f"${float(p['monthly_charges']):,.2f}/mo"
    if group == "total_charges":
        tc = p.get("total_charges")
        tc = float(p["monthly_charges"]) * int(p["tenure_months"]) if tc is None else float(tc)
        return f"${tc:,.0f}"
    if group == "services_count":
        return str(total_services(p))
    v = p[group]
    if isinstance(v, bool):
        return "Yes" if v else "No"
    return str(v)
