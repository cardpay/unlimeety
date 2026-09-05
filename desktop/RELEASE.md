# Release — Unlimeety Desktop

End-to-end checklist for cutting a new signed and notarized macOS build of Unlimeety and publishing it to GitHub Releases.

The app is distributed **outside the Mac App Store**: signed with a *Developer ID Application* certificate and notarized through Apple's `notarytool`. Only Apple Silicon is shipped — the Swift live-helper builds for arm64 only, so an Intel DMG would carry a helper that cannot run. (`package.json` still defines `build:win`, `build:linux` and `build:all`; they produce a Live-less app and nothing here releases them. There is no Windows or Linux release path.) After publication a single DMG appears at:

- `https://github.com/cardpay/unlimeety/releases/download/vX.Y.Z/Unlimeety-arm64.dmg`

The artifact name deliberately carries **no version**, so `https://github.com/cardpay/unlimeety/releases/latest/download/Unlimeety-arm64.dmg` always resolves to the most recent release — this is what the root [README.md](../README.md) links to, and it never needs editing on a version bump.

---

## Prerequisites (one-time setup)

These steps are done **once per release machine**. Skip if you've already done them.

### 0. Toolchain

- Node >= 18 for `npm test`, >= 22 for `npm run check:layout` (it needs the global `WebSocket`).
- `npm install` in `desktop/` — the build reads `node_modules`, and a stale lockfile install is a
  release that ships different dependencies than the one you tested.
- Xcode Command Line Tools for Swift. `live-helper/Package.swift` declares `.macOS("14.2")` and pins
  `argmax-oss-swift` to an exact revision, so the helper is reproducible but the first build fetches
  and compiles it — 3–10 min.

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

In `desktop/package.json` change `"version"` to the new value, e.g. `1.0.1`. `desktop/package-lock.json` carries the same version in two places — `npm version` keeps them in step, editing by hand does not.

`main` takes no direct pushes, so the bump travels as a PR like any other change, and GitHub is driven through `gh`:

```bash
cd unlimeety/desktop
npm version 1.0.1 --no-git-tag-version    # updates package.json + package-lock.json
cd ..
git checkout -b release/v1.0.1
git add desktop/package.json desktop/package-lock.json
git commit -m "desktop: bump version to 1.0.1"
gh pr create --base main --fill
gh pr merge --merge --delete-branch        # after review
```

### Step 2. Run the checks

There is no CI on this repository, so this is the only place the suite runs before a build goes out
to people. Both must be green.

```bash
cd unlimeety/desktop
npm test              # node --test, Electron-free, under a second
npm run check:layout  # drives a real Electron over CDP; expect "23/23 rows passed"
```

`check:layout` needs a display and Node >= 22. It is the only guard on the Record and Live start
screens and the "From calendar" popover, none of which `npm test` can see.

### Step 3. Build the DMG

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

What goes inside is whitelisted by `build.files` in `package.json`: `main.js`, `preload.js`, the four
pure modules (`summary-frontmatter`, `glossary`, `transcript-enhance`, `job-queue`), `renderer/**` and
`build/**`, plus the Swift helper as an `extraFiles` entry. `scripts/` and `test/` are not shipped —
a new top-level source file that nobody adds to that list is simply missing at runtime.

### Step 4. Notarize the DMG itself

electron-builder's `"notarize": true` covers the **`.app` only**. The DMG that wraps it comes out unsigned, and Gatekeeper assesses the DMG when a downloaded copy is mounted — leave this step out and users get an "Apple could not verify…" dialog even though the app inside is fine.

```bash
cd unlimeety/desktop
npm run notarize:dmg       # codesign → notarytool submit --wait → stapler staple
```

Uses the same `APPLE_KEYCHAIN_PROFILE` exported in step 3. Another ~5 min of waiting on Apple.

### Step 5. Verify

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

# 5. The notarization ticket is stapled to the DMG (step 4)
xcrun stapler validate dist/Unlimeety-arm64.dmg
#   Expect: The validate action worked!

# 6. Gatekeeper accepts the DMG too
spctl -a -t open --context context:primary-signature -v dist/Unlimeety-arm64.dmg
#   Expect: accepted
#   "rejected / source=no usable signature" means step 4 was skipped.
```

Final smoke test: copy the DMG onto a Mac that has never seen this app (or locally run `xattr -cr ~/Downloads/Unlimeety-arm64.dmg` to drop the Gatekeeper cache), mount it, and launch. There must be no "unidentified developer" dialog.

### Step 6. Bring main to the release commit

The version-bump PR from step 1 must be merged before the release is cut. No tag is pushed by hand — `gh release create` in step 7 creates it on the target commit.

```bash
cd unlimeety
git checkout main && git pull
git rev-parse --short HEAD    # the commit step 7 will tag
```

### Step 7. Publish to GitHub Releases

```bash
cd unlimeety
gh release create vX.Y.Z \
  --repo cardpay/unlimeety \
  --target main \
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

## Cutting a beta

A beta ships off the `beta` branch as a **prerelease**, and it must not disturb the stable download. Three things make that true, and all three matter:

- **`--prerelease`.** GitHub's `/releases/latest` resolves to the most recent release that is neither a prerelease nor a draft, so the README's `releases/latest/download/Unlimeety-arm64.dmg` keeps serving the last stable build. Drop this flag and the beta becomes the download every reader of the README gets.
- **`--target beta`.** No PR into `main`, no version-bump PR, no tag pushed by hand — `gh release create` tags the `beta` commit directly. `main` is not involved in a beta at all.
- **Beta-only asset names.** Assets live inside their own release, so an identically named file overwrites nothing — but a downloaded `Unlimeety-arm64.dmg` on someone's disk is then indistinguishable from the stable one. Upload the beta under its own name instead. Do **not** reach for `${version}` in `artifactName` to achieve this: that field feeds the stable release's version-free URL, and changing it breaks the README link. Rename the copy you upload.

Version numbers carry the suffix, with one asymmetry worth remembering: `desktop/package.json` takes it directly (`1.5.6-beta`), while the Chrome extension cannot — `manifest.json`'s `version` accepts only one to four dot-separated integers and Chrome rejects the manifest outright with a suffix there. The extension puts the suffix in `version_name`, which is what `chrome://extensions` displays.

The example below bumps from the versions currently on `beta`: desktop `1.5.5-beta`, extension `1.3.1` / `version_name` `1.3.1-beta`.

```bash
cd unlimeety/desktop
npm test && npm run check:layout                # same gate as a stable build
npm version 1.5.6-beta --no-git-tag-version    # extension: edit manifest.json by hand
cd ..
git add desktop/package.json desktop/package-lock.json extenstion/manifest.json
git commit -m "Bump to 1.5.6-beta (desktop) and 1.3.2-beta (extension)"
git push origin beta

cd desktop
export APPLE_KEYCHAIN_PROFILE=transcriber-notarize
export APPLE_TEAM_ID=<YOUR_TEAM_ID>
npm run build:mac && npm run notarize:dmg       # same signing and notarization as a stable build
cd ..

# Beta-only asset names, so nothing on disk is mistaken for the stable build.
# The copy is taken AFTER notarize:dmg on purpose: that script signs and staples
# dist/Unlimeety-arm64.dmg by name, and the copy inherits the stapled ticket.
# Copy first and you upload an unnotarized DMG that step 5's checks never looked
# at — they only ever name the stable file.
cp desktop/dist/Unlimeety-arm64.dmg desktop/dist/Unlimeety-arm64-beta.dmg
xcrun stapler validate desktop/dist/Unlimeety-arm64-beta.dmg   # prove the copy carries the ticket
zip -r -X desktop/dist/unlimeety-extension-beta.zip extenstion \
  -x "extenstion/2025_Unlimit_Sign_black.jpg" -x "*.DS_Store"

gh release create v1.5.6-beta \
  --repo cardpay/unlimeety \
  --target beta \
  --prerelease \
  --title "Unlimeety 1.5.6-beta" \
  --notes "What to test." \
  desktop/dist/Unlimeety-arm64-beta.dmg \
  desktop/dist/unlimeety-extension-beta.zip
```

Then prove the stable link did not move — this is the one check that catches a forgotten `--prerelease`:

```bash
curl -fsLI https://github.com/cardpay/unlimeety/releases/latest/download/Unlimeety-arm64.dmg \
  | grep -i "^location" | tail -1
#   Expect the URL to still name the last STABLE tag, not the beta one.
gh release list --repo cardpay/unlimeety --limit 5
#   Expect "Latest" to still sit on the stable release, and the beta row to read "Pre-release".
```

The extension has no build step — it is loaded unpacked, so the zip is the whole deliverable. The Unlimit logo is excluded because nothing in the extension references it.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `codesign: no identity found` | The Developer ID certificate isn't in the login keychain or its private key is missing. | Re-import the `.cer`. If the private key is gone, you'll need to revoke and re-issue the cert from a CSR made on this machine. |
| `notarytool: invalid credentials` | The keychain profile is missing or the app-specific password was rotated. | Re-run `xcrun notarytool store-credentials ...`. Don't forget `APPLE_KEYCHAIN_PROFILE=transcriber-notarize`. |
| `stapler: could not validate` | Apple rejected the notarization. | Find the submission UUID in the build log, then `xcrun notarytool log <uuid> --keychain-profile transcriber-notarize`. Common causes: an unsigned binary inside the bundle, missing hardened runtime, or expired timestamp. |
| `Killed: 9` / immediate crash on launch | Cached Gatekeeper verdict for a previous unsigned build. | `xattr -cr /Applications/Unlimeety.app` and retry. On developer machines that previously ran the self-signed version, also `sudo spctl --master-disable && sudo spctl --master-enable` to flush the cache. |
| `notarize step skipped` shown in build log | `APPLE_KEYCHAIN_PROFILE` / `APPLE_TEAM_ID` aren't exported. | Export both before `npm run build:mac`. |
| DMG: `code object is not signed at all` / `spctl` → `rejected, source=no usable signature` | Step 4 wasn't run — electron-builder notarizes the `.app`, never the DMG. | `npm run notarize:dmg`. |
| `/releases/latest/download/...` returns 404 | The uploaded asset name doesn't match the URL — most likely `artifactName` in `package.json` grew a `${version}` back. | It must stay `${productName}-${arch}.${ext}`. |

For anything not in this table, the build log from `electron-builder` is verbose and usually points right at the failing tool — read it before assuming the cert is broken.
