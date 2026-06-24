# Shipping Clinilytics — Wound Care to the Apple App Store

The app is already a web app + installable PWA. Three paths to a real iOS app,
cheapest first.

## Option 0 — PWA "Add to Home Screen" (today, free, no store)
Already works: open the site in Safari → Share → **Add to Home Screen**. It runs
full-screen, offline-capable. **Not** in the App Store and no native camera/push,
but zero extra work. Good for pilots.

## Option 1 — Capacitor wrapper (recommended for the App Store)
[Capacitor](https://capacitorjs.com) wraps the existing `index.html` in a native
iOS shell (WKWebView) and gives you an Xcode project + native plugins. Lowest
effort because you reuse 100% of the current frontend; the app still talks to your
same backend API.

```bash
# in a new folder (or a /mobile dir), with the web build copied to ./www
npm init -y
npm i @capacitor/core @capacitor/cli @capacitor/ios
npm i @capacitor/camera @capacitor/preferences @capacitor/push-notifications
npx cap init "Clinilytics Wound Care" com.clinilytics.woundcare --web-dir=www
npx cap add ios
npx cap copy
npx cap open ios          # opens Xcode → run on simulator/device, then Archive → upload
```

Use native plugins to add real device value (see App-Review note below):
- **Camera** — capture wound photos directly (better than the web file input).
- **Preferences / Keychain** — store the auth token in the iOS Keychain (more
  secure than web storage).
- **Push notifications** — overdue-rounds / new-alert pushes.
- **Face ID / Touch ID** — biometric unlock (`capacitor-native-biometric`).

## Option 2 — React Native / full native
A native rewrite (or Expo) gives the best feel but re-implements the UI. Only
worth it if you outgrow the WebView. Not necessary now.

## What it takes to publish
1. **Apple Developer Program** — $99/year (enroll the company; needs a D-U-N-S number).
2. **App Store Connect** — create the app record, screenshots, description.
3. **Privacy** — fill the Privacy "Nutrition Label"; add `Info.plist` usage strings
   (`NSCameraUsageDescription`, `NSPhotoLibraryUsageDescription`).
4. **Build & submit** — Archive in Xcode → upload → submit for App Review.

## Healthcare / App-Review gotchas (plan for these)
- **Guideline 4.2 (minimum functionality):** Apple often rejects apps that are
  "just a website in a wrapper." Ship native value — **camera capture, push,
  Face ID, offline** — so it's clearly an app, not a bookmark.
- **HIPAA:** the store app is a client to your BAA-covered backend. Keep PHI off
  third-party analytics/crash tools unless they sign a BAA; store tokens in
  Keychain; certificate-pin if feasible.
- **Medical claims:** keep the AI strictly **decision support a clinician reviews**
  (it already is) — not diagnosis/treatment. Add clear in-app disclaimers. If the
  product ever *directs* treatment autonomously it may become an FDA-regulated
  device (SaMD) — out of scope for the current CDS framing.
- **Account/login:** if there's a paid component, Apple may require specific
  billing handling; a B2B clinical tool sold to facilities can use the
  **Apple Business Manager / custom (unlisted) app** distribution to skip public
  review friction.
- **Data deletion & account:** App Store now requires in-app account deletion if
  you offer account creation.

## Recommended plan
1. Pilot now with the **PWA** (free).
2. When ready for the store, do the **Capacitor** wrap + add camera/push/Face ID,
   enroll in the Developer Program, and submit. I can scaffold the Capacitor
   project and wire the native camera/Keychain/push when you want to start.
