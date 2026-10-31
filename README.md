# witty

Kitty graphics for Claude Code on Windows terminals that only speak sixel.

witty runs a program (by default `claude`) inside node-pty's bundled passthrough ConPTY, picks the
kitty graphics protocol commands out of its output, decodes the images, and draws them as sixel
where the kitty placement would have been. Everything else, keys, mouse, resizes and the terminal's
own handshakes, passes through untouched.

Works in **Windows Terminal 1.22+** and **Tabby 1.0.238+** (both render sixel through their bundled
ConPTY). Nothing to configure in either terminal.

## What it offers

- **Claude Mod `Image` elements draw as pictures** instead of their alt text, as they would in kitty
  or Ghostty. witty sets `CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1` for the child so Claude Code emits
  kitty graphics without waiting for a kitty terminal to answer.
- **The kitty protocol Claude Code uses**: transmit, put, delete and query; chunked transfers;
  PNG, raw RGB/RGBA and zlib payloads; direct, file and temp-file transports; unicode placeholders
  (virtual placements, `U=1`), which is how Claude Code places its images; and kitty's OK/error
  responses back to the child.
- **Exact geometry**: the cell size is read from the terminal, fractional where it can be (Tabby's
  cells are not whole pixels), so images fill their cells and placeholder strips tile without gaps.
- **Sharp sprites, smooth photos**: pixel art and icons enlarged 2x or more are scaled
  nearest-neighbour, everything else is filtered (`--scale`).
- **Claude Code draws in the right place**: the child's console starts at the terminal's cursor, so
  Claude Code's header lands below what the shell printed instead of over it.
- **Hardened against the child's output**, which Claude Code fills with tool results and model text:
  every allocation is capped, file reads are confined and leak nothing, and nothing runs from the
  current directory (see [Security](#security)).
- **Portable release**: a zip with the compiled code and node-pty's prebuilt ConPTY, plus a per-user
  installer. No build, no admin.

## Requirements

- Windows 10 2004 or later (Windows 11 tested), x64
- Node.js 22.18 or later on PATH (`winget install OpenJS.NodeJS.LTS`). Node 24 is recommended and
  what CI runs: its raw mode already passes the terminal's VT input through, while on Node 22 witty
  switches the console to VT input with a hidden PowerShell helper.

## Install

### Portable release (no build)

Download `witty-<version>-win-x64.zip` from the [releases page](https://github.com/toneydev/witty/releases)
(latest: 0.2.4), extract it anywhere, and either run `witty.cmd` from there or install it for your user:

```powershell
Expand-Archive witty-0.2.4-win-x64.zip
powershell -ExecutionPolicy Bypass -File .\witty-0.2.4-win-x64\install.ps1
```

`install.ps1` copies the folder to `%LOCALAPPDATA%\Programs\witty` and adds it to your user PATH
(`-Uninstall` reverses both); open a new terminal afterwards. Installing over a witty that is
still running is fine: the old copy is moved aside and removed by the next install. The zip holds the compiled code and
node-pty's prebuilt ConPTY, so the only requirement on the machine is `node.exe` on PATH; the
launcher looks for it in the PATH directories only, never the current directory.

### From source

```powershell
cd C:\Repositories\witty
npm ci
npm run build
npm link          # puts `witty` on PATH; `npm unlink -g witty` removes it
```

`npm start -- <witty options>` runs it straight from `src\` without a build.

## Use

```powershell
witty                               # runs claude
witty -- claude --resume            # pass arguments to claude
witty -- claude --plugin-dir C:\path\to\a-mod
witty --cell 9x19 -- some-other-program
```

To see it work, load the example mod, which draws one 8x4 sprite twice above the prompt, as an
`Image` (kitty graphics, through witty) and as a `Raster` (colored half-block cells):

```powershell
witty -- claude --plugin-dir C:\Repositories\witty\examples\witty-probe
```

Without witty the Image slot shows its alt text; with witty it shows the sprite.

| Option | Meaning |
|---|---|
| `--cell WxH` | cell size in pixels when the terminal does not report it (default 10x20; decimals allowed, e.g. `9.375x20`). witty asks `CSI 14 t` and `CSI 18 t` (exact, fractional) and `CSI 16 t` (rounded) at startup and switches to the answers as they arrive |
| `--no-force` | do not set `CLAUDE_CODE_FORCE_TERMINAL_IMAGES` for the command |
| `--no-inherit-cursor` | start the command's console with its cursor at the top-left. By default witty's ConPTY asks the terminal where its cursor is (`CSI 6 n`) and starts the console there, so Claude Code, which draws from its console cursor row, draws below what the shell left on screen instead of over it |
| `--no-files` | refuse the file transports (`t=f`, `t=t`); by default witty reads only absolute local regular files, with a size check, a timeout and no file-system oracle (see SECURITY.md) |
| `--scale auto\|nearest\|smooth` | how images are scaled to their cells. `auto` (default) uses sharp nearest-neighbour when an image is enlarged 2x or more on both axes (pixel art, icons, sprites) and smooth filtering otherwise; `nearest` and `smooth` force one |
| `--debug` | log diagnostics to `%TEMP%\witty.log` |
| `--log <file>` | append diagnostics to `<file>` instead (implies `--debug`). The log records the command's arguments |
| `--help`, `--version` | |

Switches take no value (`--no-files=false` is an error), and an option's value given as the next
argument cannot start with `--`; write `--log=--odd-name` for that.

If placeholder images look misaligned, run with `--debug` and check the `cell size` lines in the
log: the first, `(fallback, until the terminal answers)`, is `--cell`; if no other follows it, the
terminal did not report its cell size and `--cell` stays in use.

## How it works

See [`docs/design.md`](docs/design.md). In short: `src/kitty/` splits and interprets the protocol
(transmit, put, delete, query, chunking, PNG and raw pixels, zlib, the file transport policy),
`src/image/` scales and crops, `src/sixel/` quantizes and encodes, `src/term/emit.ts` wraps each
placement (clipped to the screen and cached) in save-cursor / sixel / restore-cursor plus kitty's
cursor move, `src/term/placeholders.ts` draws unicode placeholder cells as sixel strips,
`src/term/metrics.ts` learns the cell size, and `src/host/` plus `src/pipeline.ts` run the child
and keep bytes in order between it and the terminal.

Not translated, because sixel has no equivalent: z-index (everything draws above text), animation
(refused with `EINVAL`), relative placements, shared-memory transport (`t=s`), and deletes by
screen position or cell (`d=c/p/q/x/y/z`, ignored since witty does not track where placements
landed). They are logged with `--debug`. A placement that runs past the bottom row scrolls the
screen and leaves the cursor off by the scroll amount; Claude Code keeps its images inside bands
and panes, so this does not come up in practice.

[`docs/landscape-2026-10.md`](docs/landscape-2026-10.md) surveys terminal graphics on Windows as of
October 2026 (which terminals speak what, ConPTY's behaviour, Claude Code's image detection) and the
designs considered before witty.

## Develop

```powershell
npm run typecheck
npm test                          # 250 tests: protocol, decoder, scaler, encoder, placeholders, host, launcher, and an end-to-end run in a ConPTY
npm run build                     # compiles src\ to dist\
tools\probe-terminal.ps1          # what does this terminal answer to graphics queries?
node tools\capture-claude.mjs     # record Claude Code's raw output in a ConPTY and summarise its kitty commands
pwsh tools\pack-release.ps1       # build, test and pack release\witty-<version>-win-x64.zip
```

CI (`.github/workflows/ci.yml`) typechecks, tests and runs `npm audit` on Windows with Node 24.
Pushing a `v<version>` tag that matches `package.json` runs `.github/workflows/release.yml`, which
packs the zip, smoke-tests `witty.cmd --version` from it, and publishes it as a GitHub release.

## Security

The child's output is treated as untrusted: it can make witty draw pictures and nothing else.
Payloads, decoded images, the image store, placements, scaling memory and caches are all capped; the
file transports read only absolute local regular files and answer every failure with one identical
status; the child command, `cmd.exe` and the launcher's `node.exe` are never taken from the current
directory, and arguments to a `.cmd` child are quoted so cmd.exe cannot run them. `SECURITY.md` has
the threat model, the full list of guarantees, and how to report a vulnerability.

## License

MIT
