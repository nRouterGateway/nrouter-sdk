# nRouter Kotlin SDK Demos & Examples

Runnable demonstrations for the nRouter Kotlin SDK (`ai.nrouter:nrouter-sdk-kotlin`).

## Prerequisites

```bash
export NROUTER_API_KEY="sk-nrouter-..."
```

## Available Demos

- `quickstart.kt`: Kotlin coroutine client demonstration with streaming, typed metadata, and error handling.

## Running

```bash
kotlinc -cp "../build/libs/*" quickstart.kt -include-runtime -d quickstart.jar
java -jar quickstart.jar
```
