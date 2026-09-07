# nRouter — Instructor (Pydantic Structured Outputs) Integration
# Structured extraction with schema enforcement and server-side guardrails.
#
# pip install instructor openai pydantic nroutersdk

import os
from pydantic import BaseModel, Field
from openai import OpenAI
import instructor
from nroutersdk import nRouter

NROUTER_BASE = "https://api.nrouter.ai"
NROUTER_KEY = os.environ["NROUTER_API_KEY"]

client = nRouter()  # reads NROUTER_API_KEY from env
MODEL = "gpt-5.4-mini"

# ━━━ 1. SEE WHAT THIS KEY CAN REACH ━━━━━━━━━━━━━━━━━━━━━━━

print("Models:", [m.id for m in client.models.list().data])

# ━━━ 2. DEFINE ENTERPRISE SCHEMA ━━━━━━━━━━━━━━━━━━━━━━━━━━

class ArchitectureReview(BaseModel):
    summary: str = Field(description="Executive technical summary")
    capabilities: list[str] = Field(description="Key supported capabilities")
    compliance_passed: bool = Field(description="Whether enterprise compliance criteria are satisfied")

# ━━━ 3. STRUCTURED EXTRACTION TARGETING NROUTER ━━━━━━━━━━━

instructor_client = instructor.from_openai(
    OpenAI(
        base_url=f"{NROUTER_BASE}/v1",
        api_key=NROUTER_KEY,
    )
)

# Guardrails, semantic caching, and spend telemetry run server-side
review = instructor_client.chat.completions.create(
    model=MODEL,
    response_model=ArchitectureReview,
    max_completion_tokens=1024,
    messages=[
        {
            "role": "user",
            "content": "Evaluate nRouter unified gateway for enterprise multi-provider LLM routing.",
        }
    ],
)

print(f"\nSummary: {review.summary}")
print(f"Compliance Passed: {review.compliance_passed}")
for cap in review.capabilities:
    print(f"  • {cap}")

# ━━━ 4. WHAT THAT COST ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

client.chat.completions.create(
    model=MODEL,
    messages=[{"role": "user", "content": "One-line summary of the run."}],
    max_tokens=256,
)

meta = client.last_response
print(f"\nrequest  {meta.request_id}")
print(f"tokens   {meta.input_tokens} in / {meta.output_tokens} out")
if meta.cost_status == "exact":
    print(f"cost     ${meta.cost:.6f}")
else:
    print(f"cost     unpriced ({meta.cost_status})")
