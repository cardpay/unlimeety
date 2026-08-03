# Release — Unlimeety Desktop

End-to-end checklist for cutting a new signed and notarized macOS build of Unlimeety and publishing it to GitHub Releases.

The app is distributed **outside the Mac App Store**: signed with a *Developer ID Application* certificate and notarized through Apple's `notarytool`. Only Apple Silicon is shipped — the Swift live-helper builds for arm64 only, so an Intel DMG would carry a helper that cannot run. After publication a single DMG appears at:

- `https://github.com/cardpay/unlimeety/releases/download/vX.Y.Z/Unlimeety-arm64.dmg`

The artifact name deliberately carries **no version**, so `https://github.com/cardpay/unlimeety/releases/latest/download/Unlimeety-arm64.dmg` always resolves to the most recent release — this is what the root [README.md](../README.md) links to, and it never needs editing on a version bump.

---

## Prerequisites (one-time setup)

These steps are done **once per release machine**. Skip if you've already done them.

### 1. Developer ID Application certificate

- On [developer.apple.com](https://developer.apple.com/account) ensure your Team ID is known (10 chars) and the membership is active under your organization.
- Open **Keychain Access → Certificate Assistant → Request a Certificate From a Certificate Authority**, save the CSR to disk.
- On Apple Developer portal: **Certificates → +** → type **Developer ID Application** → upload the CSR → download the resulting `.cer`.
- Double-click the `.cer` to import into the `login` keychain. Verify with:
  ```bash
  security find-identity -p codesigning -v
  ```
  You should see one line containing `Developer ID Application: <Your Org> ... (TEAMID)`.

The certificate is valid for 5 years. There is no *Developer ID Installer* needed — DMGs are not signed separately; the `.app` inside is.

### 2. App-specific password for notarytool

- Generate one at [appleid.apple.com → Sign-In and Security → App-Specific Passwords](https://appleid.apple.com/account/manage), label it `transcriber-notarize`. The password is shown **once**.
- Store it in a keychain profile so subsequent builds don't need to handle the raw password:
  ```bash
  xcrun notarytool store-credentials "transcriber-notarize" \
    --apple-id <your-apple-id@example.com> \
    --team-id REPLACE_WITH_TEAM_ID \
    --password xxxx-xxxx-xxxx-xxxx
  ```

### 3. Environment variables

electron-builder 26.x picks up notarization credentials from environment variables, not from `package.json`. Set them in your shell rc file or in `desktop/.env.local`:

```
APPLE_KEYCHAIN_PROFILE=transcriber-notarize
APPLE_TEAM_ID=<YOUR_TEAM_ID>
```

`APPLE_KEYCHAIN_PROFILE` points at the credentials saved in step 2; `APPLE_TEAM_ID` tells `notarytool` which team owns the submission.

### 4. GitHub remote

DMGs are published through stable GitHub Release URLs on [github.com/cardpay/unlimeety](https://github.com/cardpay/unlimeety).

- Make sure `origin` points at it:
  ```bash
  git remote add origin git@github.com:cardpay/unlimeety.git
  ```
- Authenticate the GitHub CLI once:
  ```bash
  gh auth login
  ```

---

## Cutting a release

### Step 1. Bump version

In `desktop/package.json` change `"version"` to the new value, e.g. `1.0.1`. Commit:

```bash
cd unlimeety
git add desktop/package.json
git commit -m "desktop: bump version to 1.0.1"
git push origin main
```

### Step 2. Build the DMG

```bash
cd unlimeety/desktop
export APPLE_KEYCHAIN_PROFILE=transcriber-notarize
export APPLE_TEAM_ID=<YOUR_TEAM_ID>

npm run build:mac          # arm64, ~5–10 min (notarize waits on Apple)
```

The build:
1. Compiles the Swift live-helper and signs it with hardened runtime.
2. Packages the Electron `.app`, signs it, and embeds the helper.
3. Submits the `.app` to Apple's notary service via `notarytool submit --wait` and staples the ticket onto it.

Output: `desktop/dist/Unlimeety-arm64.dmg` (plus the unpacked `desktop/dist/mac-arm64/Unlimeety.app`).

### Step 3. Notarize the DMG itself

electron-builder's `"notarize": true` covers the **`.app` only**. The DMG that wraps it comes out unsigned, and Gatekeeper assesses the DMG when a downloaded copy is mounted — leave this step out and users get an "Apple could not verify…" dialog even though the app inside is fine.

```bash
cd unlimeety/desktop
npm run notarize:dmg       # codesign → notarytool submit --wait → stapler staple
```

Uses the same `APPLE_KEYCHAIN_PROFILE` exported in step 2. Another ~5 min of waiting on Apple.

### Step 4. Verify

Run every check below — none should fail.

```bash
cd unlimeety/desktop

# 1. Signature is valid, hardened runtime is on
codesign --verify --deep --strict --verbose=2 dist/mac-arm64/Unlimeety.app
codesign --display --verbose=4 dist/mac-arm64/Unlimeety.app | grep -E "Authority|TeamIdentifier|flags"
#   Expect: Authority=Developer ID Application: <Your Org> ...
#           flags=0x10000(runtime)

# 2. The Swift helper is signed too
codesign --verify --verbose dist/mac-arm64/Unlimeety.app/Contents/MacOS/unlimeety-live

# 3. Entitlements (mic + screen capture) are intact
codesign --display --entitlements - dist/mac-arm64/Unlimeety.app

# 4. Gatekeeper accepts it
spctl --assess --type execute --verbose dist/mac-arm64/Unlimeety.app
#   Expect: source=Notarized Developer ID

# 5. The notarization ticket is stapled to the DMG (step 3)
xcrun stapler validate dist/Unlimeety-arm64.dmg
#   Expect: The validate action worked!

# 6. Gatekeeper accepts the DMG too
spctl -a -t open --context context:primary-signature -v dist/Unlimeety-arm64.dmg
#   Expect: accepted
#   "rejected / source=no usable signature" means step 3 was skipped.
```

Final smoke test: copy the DMG onto a Mac that has never seen this app (or locally run `xattr -cr ~/Downloads/Unlimeety-arm64.dmg` to drop the Gatekeeper cache), mount it, and launch. There must be no "unidentified developer" dialog.

### Step 5. Tag and push

```bash
cd unlimeety
git tag vX.Y.Z
git push origin main --tags
```

### Step 6. Publish to GitHub Releases

```bash
cd unlimeety
gh release create vX.Y.Z \
  --repo cardpay/unlimeety \
  --title "Unlimeety X.Y.Z" \
  --notes "Release notes here." \
  desktop/dist/Unlimeety-arm64.dmg
```

That's it — the README link (`releases/latest/download/Unlimeety-arm64.dmg`) now points at the new build automatically, because the asset name is version-free.

Verify the public URL actually serves the new file:

```bash
curl -fLI https://github.com/cardpay/unlimeety/releases/latest/download/Unlimeety-arm64.dmg | grep -E "^HTTP|content-length"
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `codesign: no identity found` | The Developer ID certificate isn't in the login keychain or its private key is missing. | Re-import the `.cer`. If the private key is gone, you'll need to revoke and re-issue the cert from a CSR made on this machine. |
| `notarytool: invalid credentials` | The keychain profile is missing or the app-specific password was rotated. | Re-run `xcrun notarytool store-credentials ...`. Don't forget `APPLE_KEYCHAIN_PROFILE=transcriber-notarize`. |
| `stapler: could not validate` | Apple rejected the notarization. | Find the submission UUID in the build log, then `xcrun notarytool log <uuid> --keychain-profile transcriber-notarize`. Common causes: an unsigned binary inside the bundle, missing hardened runtime, or expired timestamp. |
| `Killed: 9` / immediate crash on launch | Cached Gatekeeper verdict for a previous unsigned build. | `xattr -cr /Applications/Unlimeety.app` and retry. On developer machines that previously ran the self-signed version, also `sudo spctl --master-disable && sudo spctl --master-enable` to flush the cache. |
| `notarize step skipped` shown in build log | `APPLE_KEYCHAIN_PROFILE` / `APPLE_TEAM_ID` aren't exported. | Export both before `npm run build:mac`. |
| DMG: `code object is not signed at all` / `spctl` → `rejected, source=no usable signature` | Step 3 wasn't run — electron-builder notarizes the `.app`, never the DMG. | `npm run notarize:dmg`. |
| `/releases/latest/download/...` returns 404 | The uploaded asset name doesn't match the URL — most likely `artifactName` in `package.json` grew a `${version}` back. | It must stay `${productName}-${arch}.${ext}`. |

For anything not in this table, the build log from `electron-builder` is verbose and usually points right at the failing tool — read it before assuming the cert is broken.
