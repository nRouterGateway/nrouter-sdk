# nRouter — Instructor (Pydantic Structured Outputs) Integration
# Structured extraction with schema enforcement and server-side guardrails.
#
# pip install instructor pydantic nrouter-sdk

from pydantic import BaseModel, Field
import instructor
from nroutersdk import nRouter

# Initialize nRouter SDK client (reads NROUTER_API_KEY from env)
client = nRouter()
MODEL = "gpt-5.4-mini"

# ━━━ 1. SEE WHAT THIS KEY CAN REACH ━━━━━━━━━━━━━━━━━━━━━━━

print("Models:", [m.id for m in client.models.list().data])

# ━━━ 2. DEFINE ENTERPRISE SCHEMA ━━━━━━━━━━━━━━━━━━━━━━━━━━

class ArchitectureReview(BaseModel):
    summary: str = Field(description="Executive technical summary")
    capabilities: list[str] = Field(description="Key supported capabilities")
    compliance_passed: bool = Field(description="Whether enterprise compliance criteria are satisfied")

# ━━━ 3. STRUCTURED EXTRACTION TARGETING NROUTER ━━━━━━━━━━━

# Pass the nRouter client directly to Instructor: zero OpenAI dependency.
instructor_client = instructor.from_openai(client)

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

# Metadata is captured directly from the actual structured extraction call:
meta = client.last_response
if meta:
    print(f"\nrequest  {meta.request_id}")
    print(f"tokens   {meta.input_tokens} in / {meta.output_tokens} out")
    if meta.cost_status == "exact":
        print(f"cost     ${meta.cost:.6f}")
    else:
        print(f"cost     unpriced ({meta.cost_status})")

