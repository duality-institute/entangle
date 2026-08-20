# Development

## Requirements

- Bun 1.3 or newer
- OpenCode 1.18.18
- `make`
- Git

The real E2E suite additionally requires `curl`, `jq`, `lsof`, configured model credentials, and macOS or Linux.

## Setup

```sh
bun install
make check
```

`make check` typechecks, builds `dist/`, and then runs the tests so the built-artifact test cannot be skipped.

## Commands

| Command | Action |
| --- | --- |
| `make install` | Install dependencies |
| `make dev` | Start the Vite UI development server |
| `make test` | Run unit and integration tests |
| `make typecheck` | Run TypeScript checks |
| `make build` | Build the plugin, CLI, and mobile UI |
| `make check` | Typecheck, build, and test |
| `make e2e` | Run the real-OpenCode E2E suite |
| `make pack` | Build and preview the npm package without publishing |
| `make clean` | Remove `dist/` |
| `make publish` | Verify and publish to npm |

Run `make help` to print the same list.

## UI development

```sh
make dev
```

The production app opens at the Vite URL. Development fixtures are selected with `?fixture=`:

- `?fixture=all-parts`
- `?fixture=permission`
- `?fixture=pickers`
- `?fixture=stream`

The fixture harness is guarded by `import.meta.env.DEV` and is omitted from production builds.

## Manual test before npm publication

Build the package and install its CLI from the current checkout:

```sh
make build
npm install -g .
entangle --help
```

Because the package is not yet available from npm, register the checkout itself in the `opencode.json` of the project you want to control:

```json
{
  "plugin": [
    [
      "/absolute/path/to/entangle",
      {
        "host": "0.0.0.0",
        "port": 0,
        "pairingTtlMs": 300000
      }
    ]
  ]
}
```

Restart OpenCode and launch it in that project. In a second terminal, from the same project directory, run:

```sh
entangle
```

Scan the QR code from a phone on the same trusted Wi-Fi network. If discovery fails, run `entangle --list` and confirm both terminals use the same project directory.

To verify remote mode, connect the computer and phone to the same Tailscale tailnet, run `entangle --remote`, and open the QR from cellular or a different Wi-Fi network. This machine must expose `tailscale ip --4`, the bundled macOS Tailscale CLI, or a standard `100.64.0.0/10` Tailscale interface for automatic discovery.

A global CLI installation is optional. The built CLI can also run directly:

```sh
bun /absolute/path/to/entangle/dist/cli.js
```

Remove the local global installation with:

```sh
npm uninstall -g @dualityinstitute/entangle
```

## Editing locally

A local global install created with `npm install -g .` normally links the command back to this checkout. Confirm where it resolves:

```sh
which entangle
python3 -c 'import os, shutil; print(os.path.realpath(shutil.which("entangle") or ""))'
```

If the resolved path ends in this checkout's `dist/cli.js`, ordinary edits need only a rebuild:

```sh
make build
```

Use `make check` instead when you also want typechecking and tests.

What must be refreshed depends on the files changed:

- **CLI (`src/cli.ts`, `src/install.ts`)** — rebuild; the next `entangle` invocation uses the new CLI.
- **Plugin or server (`src/plugin.ts`, `src/server/`, `src/shared/`)** — rebuild and fully restart OpenCode because the plugin stays loaded in its process.
- **Mobile UI (`ui/`)** — rebuild, restart OpenCode, and scan a fresh QR or reload the paired page. Restarting OpenCode invalidates existing phone sessions.
- **Dependencies (`package.json`, `bun.lock`)** — run `bun install`, then rebuild.
- **The `bin` name or global installation location** — rerun `npm install -g .`.

To guarantee that you are bypassing every global link, run the built CLI directly:

```sh
bun /absolute/path/to/entangle/dist/cli.js
```

Before npm publication, keep the absolute checkout path in OpenCode's plugin configuration. Do not run the default `entangle install` flow because it intentionally installs the package from npm.

## Installer development

After the package is published, the supported user flow is:

```sh
bunx @dualityinstitute/entangle@latest install
```

Before publication, do not run the default installer path because it intentionally requests the package from npm. To exercise only its config editing against a disposable file:

```sh
make build
bun dist/cli.js install --no-global --config /tmp/entangle-opencode.jsonc
```

The installer preserves JSONC comments and unrelated settings, recognizes existing string and tuple registrations, and refuses malformed configuration instead of overwriting it.

## Real E2E

```sh
make e2e
```

This starts a real OpenCode instance, uses configured model credentials, and provisions Playwright outside the repository. Reports and screenshots are written out of tree to `$E2E_EVIDENCE` (default `/tmp/entangle-e2e-evidence`), so the suite never writes inside the checkout. It may incur model usage.

## Package and release

Preview exactly what npm would receive without creating or uploading a release:

```sh
make pack
```

When intentionally releasing:

```sh
make check
npm login
make publish
```

`make publish` runs `npm publish --access public`. Never use it for a dry run.
