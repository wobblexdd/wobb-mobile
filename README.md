# WOBB Mobile

Portfolio-ready React Native Android client for a self-hosted Xray / VLESS / REALITY workflow.

WOBB Mobile is the Android-facing part of the WOBB project. It focuses on local profile management, import and export, lightweight onboarding, optional VPS bootstrap planning, and a real mobile runtime path for user-owned servers. It is intentionally not a public VPN SaaS client.

## Portfolio Summary

WOBB Mobile demonstrates a practical self-hosted client flow:

- local profile CRUD for VLESS / REALITY
- import from VLESS URI or supported JSON
- onboarding and product framing for a self-hosted model
- optional helper-backed bootstrap planning
- Android native VPN bridge integration
- runtime-oriented status and log surfaces

## Features

- Local profile management: create, edit, duplicate, delete, favorite, select
- VLESS / REALITY profile validation before save and before connect
- Import from pasted VLESS URI or supported JSON
- Export and share the active profile
- Self-hosted onboarding flow
- Optional VPS bootstrap planning through the helper backend
- Mobile connection state model: disconnected, connecting, connected, disconnecting, error
- In-app logs for validation, permission, and runtime feedback

## Tech Stack

- React Native 0.85
- React 19
- Android native bridge in Java
- Local storage for profile persistence
- External Android core archive via `android/app/libs/wobb-core.aar`

## Repository Responsibility

This repository is responsible for:

- the mobile UI and onboarding flow
- local profile storage and validation on Android
- profile import / export UX
- Android VPN bridge wiring

This repository is not responsible for:

- hosted VPN accounts
- billing or subscriptions
- public server inventory
- backend-required login for normal client use

## Related Repositories

WOBB is intentionally split into focused repositories:

- `wobb-mobile`: Android client
- `wobb-desktop`: Electron desktop client
- `wobb-backend`: optional helper service for profile validation and bootstrap planning

For normal self-hosted use, the backend is optional. The core product flow is local profile based.

## Folder Overview

```text
android/                Android app project and native VPN bridge
App.tsx                 Main mobile app surface
profileUtils.ts         Profile model, parsing, normalization, validation
storage.ts              Local persistence helpers
metro.config.js         Metro configuration
```

## Setup

### Requirements

- Node.js 20+
- Java 17
- Android SDK and platform tools
- `adb`
- A local Android core archive at `android/app/libs/wobb-core.aar`

### Install

```bash
npm install
```

### Required local artifact

Put the Android runtime archive here:

```text
android/app/libs/wobb-core.aar
```

The AAR is a local runtime dependency and should stay out of source control unless you intentionally manage it as a versioned binary.

## Local Run

Start Metro:

```bash
npm run start
```

If you want the optional helper backend over USB:

```bash
npm run reverse
```

Run the app on a connected Android device or emulator:

```bash
npm run android
```

## Architecture Overview

The mobile app follows a local-first client model:

1. onboarding explains the self-hosted flow
2. user creates or imports a local VLESS / REALITY profile
3. profile is validated and stored on-device
4. optional helper requests can generate a bootstrap plan
5. the selected profile is converted into tunnel config for the Android bridge
6. runtime state and logs stay visible in the app

## What You Need To Actually Use It

To use WOBB Mobile as a real client, you need:

- your own VLESS / REALITY server profile
- or a server you are setting up yourself
- the Android runtime AAR in `android/app/libs/`
- optional helper backend only if you want bootstrap planning

## Current Limitations

- Final real-world runtime verification still needs manual confirmation on a physical device.
- QR import is currently a polished entry point, not a full camera-scanning implementation.
- Bootstrap is a planning helper, not a full remote server automation pipeline.
- The mobile runtime path depends on the external Android core archive being present and compatible.
- The project is focused on VLESS / REALITY only in this phase.

## Future Improvements

- Camera-based QR scanning
- Expanded runtime diagnostics and traffic verification UX
- More guided bootstrap flows for self-hosted VPS setup
- Better asset and screenshot documentation for GitHub presentation
- Additional runtime test coverage and device validation
