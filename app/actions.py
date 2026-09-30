"""Suggested retention action, driven by the customer's SHAP drivers and contract.

Rules only fire for drivers that RAISE this customer's risk. Demographic drivers
(gender, age, partner, dependants) are never turned into actions.
"""

from .features import DEMOGRAPHIC_DRIVERS


def _step(group: str, p: dict) -> str | None:
    v = p.get(group)
    if group == "contract":
        if v == "Month-to-month":
            return "Offer a move to a 12-month contract with a loyalty benefit."
        if v == "One year":
            return "Offer early renewal onto a two-year term before the current one ends."
        return None
    if group == "payment_method" and v in ("Electronic check", "Mailed check"):
        return "Invite them to switch to automatic payment (card or bank transfer)."
    if group == "internet_service" and v == "Fiber optic":
        return "Run a proactive fibre service-quality check and a plan value review."
    if group == "tech_support" and v == "No":
        return "Offer a free three-month tech support trial."
    if group == "online_security" and v == "No":
        return "Offer a free trial of online security."
    if group in ("online_backup", "device_protection") and v == "No":
        return "Suggest a protection bundle (backup and device cover) at a trial price."
    if group == "tenure" and int(p["tenure_months"]) <= 12:
        return "Book an early-life check-in call to resolve set-up or billing issues."
    if group in ("monthly_charges", "total_charges"):
        return "Review the plan against usage and offer a better-fitting bundle if one exists."
    if group == "services_count":
        return "Suggest one relevant add-on to deepen engagement."
    if group == "paperless_billing" and v is True:
        return "Send a clear bill explainer so charges are not a surprise."
    return None


def suggest(p: dict, prob: float, band: str, drivers: list[dict]) -> dict:
    steps, seen = [], set()
    for d in drivers:
        if d["impact"] <= 0 or d["group"] in DEMOGRAPHIC_DRIVERS:
            continue
        text = _step(d["group"], p)
        if text and text not in seen:
            seen.add(text)
            steps.append({"action": text, "because": f"{d['label']}: {d['value']}"})
        if len(steps) == 3:
            break

    if band == "High":
        channel = "Outbound call from a retention specialist within 7 days"
    elif band == "Medium":
        channel = "Targeted email or SMS offer; call if they open or reply"
    else:
        channel = "No proactive contact; standard service"
        steps = []

    if band != "Low" and p["contract"] == "Two year":
        channel += " (on a two-year contract, so prioritise service quality over contract offers)"
    if band != "Low" and not steps:
        steps = [{"action": "Check in on service satisfaction; no single actionable driver stands out.",
                  "because": "Risk comes mainly from profile factors the team cannot change"}]
    return {"channel": channel, "steps": steps}
