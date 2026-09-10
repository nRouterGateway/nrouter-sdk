# nRouter Android SDK Demos & Examples

Runnable demonstrations for the nRouter Android SDK (`ai.nrouter.sdk.android:nrouter-sdk-android`).

## Prerequisites

Add the dependency to your app's `build.gradle.kts`:

```kotlin
dependencies {
    implementation("ai.nrouter:nrouter-sdk-android:3.1.2")
}
```

Ensure network permission in `AndroidManifest.xml`:

```xml
<uses-permission android:name="android.permission.INTERNET" />
```

## Available Demos

- `QuickstartDemo.kt`: Demonstrates Android lifecycle initialization, coroutines integration, chat completions, and response metadata extraction.
