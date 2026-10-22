//! nRouter request option helpers.

use serde_json::{Map, Value};

use crate::NRouterError;

pub const PROMPT_TEMPLATE_ID_FIELD: &str = "nrouter_prompt_template_id";
pub const PROMPT_VARIABLES_FIELD: &str = "nrouter_prompt_variables";
pub const CACHE_FIELD: &str = "nrouter_cache";
pub const FALLBACKS_FIELD: &str = "nrouter_fallbacks";
pub const GUARDRAILS_FIELD: &str = "nrouter_guardrails";
pub const OPTIMIZE_FIELD: &str = "nrouter_optimize";
pub const EXTRA_BODY_FIELDS: [&str; 6] = [
    PROMPT_TEMPLATE_ID_FIELD,
    PROMPT_VARIABLES_FIELD,
    CACHE_FIELD,
    FALLBACKS_FIELD,
    OPTIMIZE_FIELD,
    GUARDRAILS_FIELD,
];

pub const MAX_FALLBACKS: usize = 4;
pub const MAX_GUARDRAILS: usize = 8;

const TENANCY_KEYS: [&str; 5] = ["organizationid", "orgid", "teamid", "userid", "nrouterorg"];

#[derive(Debug, Clone, Default)]
pub struct FeatureOptions {
    pub prompt_template_id: Option<String>,
    pub prompt_variables: Option<Map<String, Value>>,
    pub fallbacks: Vec<String>,
    pub guardrails: Vec<String>,
    pub guardrail_ids: Vec<String>,
    pub cache: Option<bool>,
    /// Strategy for a request on `nrouter/auto` only: `"quality"` (the
    /// organization default) or `"cost"` (lowest list rate among models fit
    /// for the task). Pairing it with any other model is refused by the
    /// gateway with 400 `invalid_request`.
    pub optimize: Option<String>,
}

fn normalize_names(
    values: &[String],
    argument: &str,
    ceiling: usize,
) -> Result<Vec<Value>, NRouterError> {
    let mut out = Vec::with_capacity(values.len());
    for entry in values {
        let trimmed = entry.trim();
        if trimmed.is_empty() {
            return Err(NRouterError::Configuration(format!(
                "{argument} contains an empty entry. Every entry must be a non-empty name."
            )));
        }
        out.push(Value::String(trimmed.to_string()));
    }
    if out.len() > ceiling {
        return Err(NRouterError::Configuration(format!(
            "{argument} carries {} entries; the gateway accepts at most {ceiling}.",
            out.len()
        )));
    }
    Ok(out)
}

pub fn build_extra_body(opts: &FeatureOptions) -> Result<Map<String, Value>, NRouterError> {
    if !opts.guardrail_ids.is_empty() {
        return Err(NRouterError::Configuration(
            "guardrail_ids is not supported: guardrails are assigned per key, team, or organization \
             in the nRouter dashboard and already apply automatically to every call."
                .into(),
        ));
    }

    let mut out = Map::new();
    if let Some(template_id) = opts.prompt_template_id.as_deref() {
        if !template_id.is_empty() {
            out.insert(
                PROMPT_TEMPLATE_ID_FIELD.into(),
                Value::String(template_id.into()),
            );
        }
    }
    if let Some(vars) = &opts.prompt_variables {
        if !vars.is_empty() {
            out.insert(PROMPT_VARIABLES_FIELD.into(), Value::Object(vars.clone()));
        }
    }
    if opts.cache == Some(false) {
        out.insert(CACHE_FIELD.into(), Value::Bool(false));
    }
    if !opts.fallbacks.is_empty() {
        out.insert(
            FALLBACKS_FIELD.into(),
            Value::Array(normalize_names(
                &opts.fallbacks,
                "fallbacks",
                MAX_FALLBACKS,
            )?),
        );
    }
    if let Some(optimize) = opts.optimize.as_deref() {
        if optimize != "quality" && optimize != "cost" {
            return Err(NRouterError::Configuration(
                "optimize must be \"quality\" or \"cost\"; it maps onto the gateway field \
                 nrouter_optimize and applies to the model nrouter/auto only."
                    .into(),
            ));
        }
        out.insert(OPTIMIZE_FIELD.into(), Value::String(optimize.into()));
    }
    if !opts.guardrails.is_empty() {
        out.insert(
            GUARDRAILS_FIELD.into(),
            Value::Array(normalize_names(
                &opts.guardrails,
                "guardrails",
                MAX_GUARDRAILS,
            )?),
        );
    }
    Ok(out)
}

pub fn vet_extra(extra: &Map<String, Value>) -> Result<(), NRouterError> {
    for key in extra.keys() {
        if TENANCY_KEYS.contains(&normalize_key(key).as_str()) {
            return Err(NRouterError::Configuration(format!(
                "extra must not carry the tenancy field \"{key}\". The gateway resolves \
                 organization, team, and user from the authenticated API key alone."
            )));
        }
        if key == "__proto__" {
            return Err(NRouterError::Configuration(
                "extra must not carry a \"__proto__\" key.".into(),
            ));
        }
    }
    Ok(())
}

fn normalize_key(key: &str) -> String {
    key.to_ascii_lowercase().replace('_', "")
}
