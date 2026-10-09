# shellcheck shell=bash
# Sourced, never executed: sets GRADLE_JDK_PATHS for every script that runs a
# Gradle SDK build (scripts/test-all.sh, tests/demo-e2e-record.test.sh).
#
# Both Gradle SDKs build with `jvmToolchain(11)`. Homebrew JDKs are not on
# Gradle's auto-detection path on macOS, so name the ones this machine has,
# at invocation time. Never commit these paths to gradle.properties: that file
# is read on every machine, and a Windows build warns about paths it cannot have.
#
# One list, here, so two runners cannot disagree about which JDKs Gradle may
# use: a second copy is how one of them ends up unable to find a toolchain the
# other finds.
#
# GRADLE_JDK_PATHS is a comma-separated list, empty when none of the candidates
# exists. Pass it as `-Porg.gradle.java.installations.paths=$GRADLE_JDK_PATHS`
# only when it is non-empty; with it empty, Gradle's own detection applies.
GRADLE_JDK_PATHS=""
for _gradle_jdk in /opt/homebrew/opt/openjdk@11/libexec/openjdk.jdk/Contents/Home \
                   /opt/homebrew/opt/openjdk@17/libexec/openjdk.jdk/Contents/Home; do
  if [ -d "$_gradle_jdk" ]; then
    GRADLE_JDK_PATHS="${GRADLE_JDK_PATHS:+$GRADLE_JDK_PATHS,}$_gradle_jdk"
  fi
done
unset _gradle_jdk
