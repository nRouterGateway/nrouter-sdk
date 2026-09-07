"""Sampling policy shared with the JavaScript SDK."""

from __future__ import annotations

import math

from nroutersdk._errors import nRouterRequestError

_NEUTRAL_TOP_P = 1.0


def is_claude_model(model: str, provider: str | None = None) -> bool:
    """Return true when the model belongs to the Claude family."""
    m = (model or "").lower()
    p = (provider or "").lower()
    return any(k in m for k in ("claude", "anthropic", "haiku", "sonnet", "opus")) or "anthropic" in p


def _require_usable(name: str, value: float, maximum: float | None = None) -> None:
    if not math.isfinite(value):
        raise nRouterRequestError(
            f"{name} must be a finite number; sent as-is it serializes to JSON null."
        )
    if value < 0 or (maximum is not None and value > maximum):
        if maximum is None:
            bounds = "0 or greater"
        else:
            bounds = f"between 0 and {maximum:g}"
        raise nRouterRequestError(f"{name} must be {bounds}, got {value}.")


SAMPLING_DEPRECATED: tuple[str, ...] = (
    "claude-opus-4-7",
    "claude-opus-4-8",
    "claude-opus-5",
    "claude-sonnet-5",
    "claude-fable-5",
)


def sampling_params_deprecated(model: str) -> bool:
    """Return true when the model rejects sampling parameters entirely."""
    m = (model or "").lower()
    return any(dep in m for dep in SAMPLING_DEPRECATED)


def build_sampling_params(
    *,
    advanced: bool,
    model: str,
    provider: str | None = None,
    canonical_model: str | None = None,
    temperature: float | None = None,
    top_p: float | None = None,
) -> dict[str, float]:
    """Build the wire sampling fields.

    With advanced sampling off, nothing is sent. For models that deprecate
    sampling outright, nothing is sent. For other Claude-family models,
    non-neutral top_p wins over temperature because Anthropic rejects both
    together.
    """
    if not advanced:
        return {}

    if sampling_params_deprecated(model) or sampling_params_deprecated(canonical_model or ""):
        return {}

    if temperature is not None:
        _require_usable("temperature", temperature)
    if top_p is not None:
        _require_usable("top_p", top_p, 1)

    top_p_set = top_p is not None and top_p != _NEUTRAL_TOP_P
    suppress_temperature = top_p_set and is_claude_model(model, provider)

    out: dict[str, float] = {}
    if temperature is not None and not suppress_temperature:
        out["temperature"] = temperature
    if top_p_set and top_p is not None:
        out["top_p"] = top_p
    return out
