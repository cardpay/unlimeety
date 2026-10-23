# Release — Unlimeety Desktop

End-to-end checklist for cutting a new signed and notarized macOS build of Unlimeety and publishing it to GitHub Releases.

## Release authorization and branch policy

Do not start a pre-release build, notarization, artifact upload, tag, or GitHub release until the
user explicitly requests that specific release. A ready `beta` branch is not authorization to
publish anything.

Completed `feature/*` branches merge locally into `beta` without a PR, and `beta` may be pushed.
Only `beta` may open a PR to `main`; `main` receives no direct pushes. The stable and beta
procedures below apply only after the explicit release request has been received.

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

### Step 0. Refresh security patches

Before every release cut, refresh Electron within its existing major version and
review the dependency audit from `desktop/`:

```bash
npm update electron
npm ls electron js-yaml yauzl
npm audit --omit=dev
```

Check the [Electron release notes](https://releases.electronjs.org/) for the
resolved version. Raise the `package.json` Electron minimum to that version,
keep its major unchanged, and commit both manifests with the release preparation.
Run all checks below against the refreshed lockfile before building.

### Step 1. Bump version

In `desktop/package.json` change `"version"` to the new value, e.g. `1.0.1`. `desktop/package-lock.json` carries the same version in two places — `npm version` keeps them in step, editing by hand does not.

Prepare the bump on `beta`. It is then the only branch permitted to open the PR into `main`:

```bash
cd unlimeety
git checkout beta && git pull
cd desktop
npm version 1.0.1 --no-git-tag-version    # updates package.json + package-lock.json
cd ..
git add desktop/package.json desktop/package-lock.json
git commit -m "desktop: bump version to 1.0.1"
git push origin beta
gh pr create --head beta --base main --fill
gh pr merge --merge                        # after review
```

### Step 2. Run the checks

There is no CI on this repository, so this is the only place the suite runs before a build goes out
to people. Both must be green.

```bash
cd unlimeety/desktop
npm test              # node --test, Electron-free, under a second
npm run check:layout  # drives a real Electron over CDP; expect "34/34 rows passed"
```

`check:layout` needs a display and Node >= 22. It is the only guard on the Record and Live start
screens and the "From calendar" popover, none of which `npm test` can see.

### Step 3. Build the DMG and update ZIP

```bash
cd unlimeety/desktop
export APPLE_KEYCHAIN_PROFILE=transcriber-notarize
export APPLE_TEAM_ID=<YOUR_TEAM_ID>

npm run build:mac          # arm64, ~5–10 min (notarize waits on Apple)
```

The build:
1. Downloads the pinned llama.cpp `b10516` macOS arm64 archive, verifies SHA-256 `ee3324327d621026ae80c24031670e65fa62a0b23a3a027dbe2f65f240affd30`, and signs its reviewed `llama-runner` binary with hardened runtime.
2. Compiles the Swift live-helper and signs it with hardened runtime.
3. Packages the Electron `.app`, signs it, and embeds both helpers.
3. Submits the `.app` to Apple's notary service via `notarytool submit --wait` and staples the ticket onto it.

Output: the existing version-free `desktop/dist/Unlimeety-arm64.dmg`, a versioned arm64 update ZIP, `latest-mac.yml` (stable) or `beta-mac.yml` (beta), and the unpacked application. The signed/notarized application is shared by both DMG and ZIP targets. `--publish never` keeps builds local. The generic publish configuration only generates metadata and packaged `app-update.yml` with its updater cache name; uploads remain an explicit `gh` step.

What goes inside is whitelisted by `build.files` in `package.json`: `main.js`, `preload.js`, the pure modules and all five `update-*.js` runtime modules, `renderer/**` and
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

# 2b. The local-LLM runner and its bundled dylibs are independently signed too
codesign --verify --verbose dist/mac-arm64/Unlimeety.app/Contents/MacOS/llama-runner
codesign --verify --verbose dist/mac-arm64/Unlimeety.app/Contents/MacOS/lib*.dylib

# 3. Entitlements (mic + screen capture) are intact
codesign --display --entitlements - dist/mac-arm64/Unlimeety.app

# 3b. Native processes have their own minimal entitlements
codesign --display --entitlements - dist/mac-arm64/Unlimeety.app/Contents/MacOS/unlimeety-live
codesign --display --entitlements - dist/mac-arm64/Unlimeety.app/Contents/MacOS/llama-runner
for lib in dist/mac-arm64/Unlimeety.app/Contents/MacOS/lib*.dylib; do
  codesign --display --entitlements - "$lib"
done
# Expect: live helper has only personal-information.calendars;
# runner and dylibs have an empty dictionary, without JIT or unsigned memory.
# build/sign-mac.cjs preserves these profiles during nested signing.
# Chromium helpers keep entitlementsInherit.

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

The beta-to-main PR from step 1 must be merged before the release is cut. No tag is pushed by hand
— `gh release create` in step 7 creates it on the target commit.

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
  --draft \
  --title "Unlimeety X.Y.Z" \
  --notes "Release notes here." \
  desktop/dist/Unlimeety-arm64.dmg \
  desktop/dist/Unlimeety-X.Y.Z-arm64.zip \
  desktop/dist/latest-mac.yml

# Inspect and verify every asset while the release is still a draft.
# Publish only after the verification steps below pass.
gh release edit vX.Y.Z --repo cardpay/unlimeety --draft=false --latest
```

That's it — the README link (`releases/latest/download/Unlimeety-arm64.dmg`) now points at the new build automatically, because the asset name is version-free.

Verify the public URL actually serves the new file:

```bash
curl -fLI https://github.com/cardpay/unlimeety/releases/latest/download/Unlimeety-arm64.dmg | grep -E "^HTTP|content-length"
```

---

## Cutting a beta

A beta ships off the `beta` branch as a **prerelease**, and it must not disturb the stable download. Three things make that true, and all three matter:

Only continue after the user explicitly asks to build and publish this beta. A branch named `beta`,
completed checks, or a version bump does not authorize its build, notarization, upload, tag, or
release publication.

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
  --draft --prerelease \
  --title "Unlimeety 1.5.6-beta" \
  --notes "What to test." \
  desktop/dist/Unlimeety-arm64-beta.dmg \
  desktop/dist/unlimeety-extension-beta.zip \
  desktop/dist/Unlimeety-1.5.6-beta-arm64.zip \
  desktop/dist/beta-mac.yml

# Complete the offline and uploaded-asset checks before making it discoverable.
gh release edit v1.5.6-beta --repo cardpay/unlimeety --draft=false --prerelease --latest=false
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


## In-app update asset gate

Existing updater-free installations need one manual installation of an updater-enabled signed
build. Uploading manifests cannot change an already installed binary. Stable only selects stable;
beta only selects `beta` semantic prereleases. Drafts are ignored. A missing manifest or ZIP makes
the newest release incomplete rather than promoting another channel.

Before either draft is published, run from `desktop/` with its exact version and channel:

```bash
npm run verify:update -- --version X.Y.Z --channel stable --dir dist
# For a beta use its exact version and --channel beta instead.
```

The offline verifier checks the channel manifest, payload filename/size/SHA-512, archive paths,
bundle identifier/version and actual arm64 Mach-O executable. Also run Step 5's native signature,
Gatekeeper and notarization checks against the packaged app. Verify `Contents/Resources/app-update.yml`
exists, contains `updaterCacheDirName`, and contains no credentials. Do not hand-edit the ZIP after
its manifest hash is generated. Stable DMG names and download links stay unchanged.

After uploading to the draft, use `gh release view TAG --repo cardpay/unlimeety --json isDraft,isPrerelease,tagName,assets`
to confirm the exact tag, channel flag and complete asset list. Download the draft assets with
`gh release download TAG --repo cardpay/unlimeety --dir /tmp/update-release-check` into a fresh
folder and rerun the offline verifier there with the same exact version/channel. Compare these
results before the `gh release edit --draft=false` command. No asset may be replaced after publication;
prepare a new release if corrections are required.

The runtime pins `electron-updater@6.8.9`. Its custom provider is bound to our semantic candidate;
the adapter avoids its generic GitHub channel selection and staging UUID. Downloads use restricted
HTTPS redirects and full SHA-512 checks, never deltas. Downloaded cache entries are revalidated,
including the extracted bundle's designated requirement and Team ID, before explicit installation.
Native Squirrel publisher verification remains enabled. `autoInstallOnAppQuit=false` is essential:
normal quit after download must never call native `checkForUpdates` or stage an update. Installation
requires an exclusive readiness reservation and successful acknowledgements from every editing window;
a preparation timeout, lost renderer, draft, failed save, active session or job requires another explicit click.
Preparation and network requests have total cancellation deadlines, including redirects and streaming.
The manifest's optional `minimumSystemVersion` is a Darwin kernel version, while the bundle's
`LSMinimumSystemVersion` is a macOS product version; both are checked before staging.
A verified downloaded candidate is persisted locally and revalidated on restart without downloading
or staging. A changed, corrupt, incompatible or differently signed cache requires another download.
Once native Squirrel staging begins, its watchdog only reports delay: it cannot cancel that native
operation. A terminal native failure releases the reservation. After native readiness and a restart request,
the exclusive reservation remains until confirmed process shutdown, even if a renderer exits
or Quit is requested. Returning from the restart API does not release it. A native failure requires an explicit download action to recreate the serving
proxy before installation can be retried. Normal quit remains available before native commitment.

Release-dependent validation is still pending and requires separate authorization for the necessary
signed builds and releases. For **both stable and beta**, install a signed old updater-enabled build,
make a signed newer same-channel version and an opposite-channel release available, and demonstrate:

- The selected version/channel and signed publisher are correct; normal quit after download does
  not stage or replace the app, and Later does not restart it.
- Explicit installation relaunches into the selected version, clears old update prompts, and
  preserves settings, recordings, transcripts, notes, summaries and downloaded model caches.
- Startup/permission, stopping/saving and queued-job races block staging. Failed saves, renderer
  loss and readiness timeout never stage. Sleep/resume produces one jittered overdue check.
- Wrong signatures/version/architecture, corrupt or interrupted downloads, low disk space,
  mounted/translocated/read-only locations, native errors and failed replacement leave a usable
  previous installation and allow recovery without a deferred surprise restart.

Unit tests and the offline verifier do not establish native replacement, notarization acceptance,
restart or user-data preservation. Keep these demonstrations pending until actually performed.
