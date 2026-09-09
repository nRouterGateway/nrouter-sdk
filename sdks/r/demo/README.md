# nRouter R SDK Demos & Examples

Runnable demonstrations for the nRouter R SDK (`nrouter`).

## Prerequisites

```R
# Install from R-universe:
install.packages("nrouter", repos = c(nroutergateway = "https://nroutergateway.r-universe.dev", CRAN = "https://cloud.r-project.org"))
```

```bash
export NROUTER_API_KEY="sk-nrouter-..."
```

## Available Demos

- `quickstart.R`: Quickstart script demonstrating client initialization, model lookup, chat completion, and cost header reading.

## Running

```bash
Rscript quickstart.R
```
