# WOBB Mobile

React Native Android client for a self-hosted Xray / VLESS / REALITY workflow.

WOBB Mobile is the Android-facing public repository in the WOBB split project. It stores profiles locally on-device, supports import and export, provides optional bootstrap planning through the helper backend, and connects through an Android runtime bridge. It is intentionally not a public VPN SaaS client.

## Release Summary

This repo is intended to publish:

- debug APKs for local testing
- release APKs for manual distribution or GitHub releases
- source code and docs for the Android self-hosted client flow

## Features

- local profile CRUD for VLESS / REALITY
- import from VLESS URI or supported JSON
- export and share the active profile
- self-hosted onboarding flow
- optional helper-backed VPS bootstrap planning
- Android VPN bridge integration
- runtime-oriented status and logs

## Tech Stack

- React Native 0.85
- React 19
- Android native bridge in Java
- Local storage for profiles
- External Android core archive via `android/app/libs/wobb-core.aar`

## Repository Responsibility

This repo is responsible for:

- mobile UI and onboarding
- local profile storage and validation
- import / export UX
- Android VPN bridge wiring
- release APK build flow and public repo presentation

This repo is not responsible for:

- hosted accounts
- subscriptions or billing
- public server inventory
- mandatory backend auth for normal use

## Related Repositories

- `wobb-mobile`: Android client
- `wobb-desktop`: Electron desktop client
- `wobb-backend`: optional helper service for validation and bootstrap planning

The backend is optional. The main product flow is local and profile-based.

## Folder Overview

```text
android/                Android app project and Gradle build
android/app/            App module, manifest, native VPN bridge, local AAR slot
scripts/                Cross-platform helper scripts for Gradle tasks
App.tsx                 Main mobile UI
profileUtils.ts         Profile model, parsing, normalization, validation
storage.ts              Local persistence helpers
```

## Requirements

- Node.js 20+
- Java 17
- Android SDK and platform tools
- `adb`
- local Android core archive at `android/app/libs/wobb-core.aar`

## Setup

Install dependencies:

```bash
npm install
```

Place the Android runtime archive here:

```text
android/app/libs/wobb-core.aar
```

The AAR is a local runtime dependency and should stay out of source control.

## Local Development

Start Metro:

```bash
npm run start
```

If you want the optional helper backend over USB:

```bash
npm run reverse
```

Run on a connected device or emulator:

```bash
npm run android
```

## Build Commands

### Debug APK

```bash
npm run android:debug-apk
```

Debug APK output:

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

Install debug APK manually:

```bash
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

### Release APK

```bash
npm run android:release-apk
```

If signing is not configured, Gradle will produce an unsigned release APK:

```text
android/app/build/outputs/apk/release/app-release-unsigned.apk
```

If signing is configured, the output is typically:

```text
android/app/build/outputs/apk/release/app-release.apk
```

Install a signed release APK manually:

```bash
adb install -r android/app/build/outputs/apk/release/app-release.apk
```

Optional release bundle command:

```bash
npm run android:release-bundle
```

## Release Signing

This repo is release-build friendly, but signing still has to be supplied manually.

A template is provided at:

```text
android/signing.properties.example
```

To enable signed release builds:

1. copy `android/signing.properties.example` to `android/signing.properties`
2. provide real values for:
   - `WOBB_RELEASE_STORE_FILE`
   - `WOBB_RELEASE_STORE_PASSWORD`
   - `WOBB_RELEASE_KEY_ALIAS`
   - `WOBB_RELEASE_KEY_PASSWORD`

The same keys can also be provided through environment variables or Gradle properties.

## Architecture Overview

The mobile app follows a local-first client model:

1. onboarding explains the self-hosted flow
2. user creates or imports a local VLESS / REALITY profile
3. profile is validated and stored on-device
4. optional helper requests can generate a bootstrap plan
5. the selected profile is converted into tunnel config for the Android bridge
6. runtime state and logs stay visible in the app

## What You Need To Actually Use It

- your own VLESS / REALITY server profile
- or a server you are setting up yourself
- the Android runtime AAR in `android/app/libs/`
- optional helper backend only if you want bootstrap planning

## Current Limitations

- Final real-world runtime verification still needs manual confirmation on a physical device.
- QR import is currently a polished entry point, not a full camera-scanning implementation.
- Bootstrap is a planning helper, not a full remote automation pipeline.
- The mobile runtime path depends on the external Android core archive being present and compatible.
- Release signing material is intentionally not committed and must be provided manually.
- The project is focused on VLESS / REALITY only in this phase.

## Future Improvements

- camera-based QR scanning
- expanded runtime diagnostics and traffic verification UX
- more guided bootstrap flows for self-hosted VPS setup
- signed release CI once keystore strategy is finalized
- additional runtime test coverage and device validation
