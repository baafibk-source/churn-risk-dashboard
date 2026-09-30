"""Strict request schemas. Unknown fields are rejected everywhere."""

import math
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from .config import QUESTION_MAX_CHARS

CustomerId = Field(pattern=r"^\d{4}-[A-Z]{5}$", min_length=10, max_length=10)
Addon = Literal["Yes", "No", "No internet service"]
Contract = Literal["Month-to-month", "One year", "Two year"]
Internet = Literal["DSL", "Fiber optic", "No"]
RiskBand = Literal["High", "Medium", "Low"]
TenureBand = Literal["0–6 months", "7–12 months", "1–2 years", "2–4 years", "4–6 years"]
Payment = Literal["Bank transfer (automatic)", "Credit card (automatic)", "Electronic check",
                  "Mailed check"]


class Profile(BaseModel):
    """A what-if customer. strict=True: no string->number or "yes"->bool coercion."""
    model_config = ConfigDict(extra="forbid", strict=True)

    gender: Literal["Female", "Male"]
    senior_citizen: bool
    partner: bool
    dependents: bool
    tenure_months: int = Field(ge=0, le=72)
    phone_service: bool
    multiple_lines: Literal["Yes", "No", "No phone service"]
    internet_service: Internet
    online_security: Addon
    online_backup: Addon
    device_protection: Addon
    tech_support: Addon
    streaming_tv: Addon
    streaming_movies: Addon
    contract: Contract
    paperless_billing: bool
    payment_method: Payment
    monthly_charges: float = Field(ge=18, le=120)
    total_charges: float | None = Field(default=None, ge=0, le=9000)

    @field_validator("monthly_charges", "total_charges")
    @classmethod
    def finite(cls, v):
        if v is not None and not math.isfinite(v):
            raise ValueError("must be a finite number")
        return v

    @model_validator(mode="after")
    def consistent(self):
        if (self.multiple_lines == "No phone service") == self.phone_service:
            raise ValueError("multiple_lines must be 'No phone service' exactly when phone_service is false")
        no_net = self.internet_service == "No"
        for f in ("online_security", "online_backup", "device_protection", "tech_support",
                  "streaming_tv", "streaming_movies"):
            if (getattr(self, f) == "No internet service") != no_net:
                raise ValueError(f"{f} must be 'No internet service' exactly when internet_service is 'No'")
        if not self.phone_service and no_net:
            raise ValueError("a customer needs phone or internet service")
        return self


class CampaignQuery(BaseModel):
    model_config = ConfigDict(extra="forbid")
    target_share: float = Field(0.20, ge=0.05, le=1.0, description="share of customers contacted")
    save_rate: float = Field(0.25, ge=0.0, le=1.0, description="share of contacted would-be churners who stay")
    contact_cost: float = Field(15.0, ge=0, le=500, description="$ per customer contacted")
    offer_cost: float = Field(60.0, ge=0, le=2000, description="$ incentive per customer retained")
    horizon_months: int = Field(12, ge=1, le=36, description="months of revenue kept per saved customer")


class SegmentQuery(BaseModel):
    model_config = ConfigDict(extra="forbid")
    by: Literal["contract", "tenure_band", "internet_service", "protection", "payment_method",
                "tech_support"] = "contract"
    contract: Contract | None = None
    internet_service: Internet | None = None
    tenure_band: TenureBand | None = None
    risk_band: RiskBand | None = None


class CustomerQuery(BaseModel):
    model_config = ConfigDict(extra="forbid")
    limit: int = Field(25, ge=1, le=100)
    offset: int = Field(0, ge=0, le=5000)
    contract: Contract | None = None
    internet_service: Internet | None = None
    tenure_band: TenureBand | None = None
    risk_band: RiskBand | None = None


class AssistantRequest(BaseModel):
    model_config = ConfigDict(extra="forbid", strict=True)
    customer_id: str = CustomerId
    question: str | None = Field(default=None, min_length=1, max_length=QUESTION_MAX_CHARS)

    @field_validator("question")
    @classmethod
    def clean(cls, v):
        if v is None:
            return v
        v = "".join(ch for ch in v if ch.isprintable() or ch == " ").strip()
        if not v:
            raise ValueError("question is empty")
        return v
