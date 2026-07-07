# Project Journal & Timecard (PJT)

A single-file desktop app for tracking projects, budgets, notes, and daily time, with optional cloud sync across machines via a shared GitHub Gist. The app itself is `src/index.html`; this repo wraps it in a native Windows app using [Tauri](https://tauri.app) and builds the installer in GitHub Actions — no local toolchain required.

> **No secrets live in this repo.** Cloud access is configured at runtime by each user entering a one-time **Team code** in the app's Sync panel, so it's safe for this repo to be public.

## Repo layout

```
src/index.html              the app (the whole thing)
src-tauri/                   the native shell
  tauri.conf.json           app name, window, icon, bundle targets
  Cargo.toml, build.rs, src/main.rs
  capabilities/default.json
  icons/                    generated icon set (from the PJT master)
.github/workflows/build.yml the Windows build pipeline
```

## Building the installer (the whole point)

You don't build locally. Pushing to `main` — or clicking **Run workflow** on the Actions tab — kicks off a build on a free `windows-latest` runner.

1. Go to the **Actions** tab and open the latest **Build Windows installer** run.
2. When it finishes (first run is slower while it compiles the CLI), download the **`pjt-windows-installers`** artifact at the bottom of the run.
3. It contains the `.exe` (NSIS setup) and `.msi` (WiX) installers. Either works — the `.exe` setup is the usual choice.

## Distributing to coworkers

Send them the `.exe` directly (Teams, email, shared drive) — they don't need GitHub. On first launch:

1. Windows SmartScreen will warn "unknown publisher" because the installer is unsigned. Click **More info → Run anyway**. (A code-signing certificate removes this; it costs money and isn't set up here.)
2. In the app: **☁ Sync** → paste the **Team code** you give them → **Connect** → **Create my journal**.

The Team code (which bundles the shared gist ID + token) is what you hand out separately from the app. Rotating the token later just means generating and sharing a new code — no rebuild.

## Updating the app

Edit `src/index.html`, bump the version, commit, and push to `main`. A fresh build runs automatically; grab the new installer from that run.

## Notes

- The app makes network calls to `api.github.com` for sync; the Tauri config leaves CSP open (`"csp": null`) so those requests aren't blocked.
- Installer output lives under `src-tauri/target/release/bundle/` on the runner.
- Want public, login-free download links instead of Actions artifacts? Switch the workflow to tag-triggered releases with `tauri-apps/tauri-action` — the build output is already safe to publish since it carries no secrets.
