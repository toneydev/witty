# witty

Kitty graphics for Claude Code on Windows terminals that only speak sixel.

witty runs a program (by default `claude`) inside node-pty's bundled passthrough ConPTY, picks the
kitty graphics protocol commands out of its output, decodes the images, and draws them as sixel
where the kitty placement would have been. Everything else, keys, mouse, resizes and the terminal's
own handshakes, passes through untouched.

Works in **Windows Terminal 1.22+** and **Tabby 1.0.238+** (both render sixel through their bundled
ConPTY). Nothing to configure in either terminal.

## Requirements

- Windows 10 2004 or later (Windows 11 tested)
- Node.js 24 or later (`winget install OpenJS.NodeJS.LTS`)

## Install

```powershell
cd C:\Repositories\witty
npm ci
npm run build
npm link          # puts `witty` on PATH; `npm unlink -g witty` removes it
```

## Use

```powershell
witty                               # runs claude
witty -- claude --resume            # pass arguments to claude
witty -- claude --plugin-dir C:\path\to\a-mod
witty --cell 9x19 -- some-other-program
```

To see it work, load the example mod, which draws one sprite twice above the prompt, as an
`Image` (kitty graphics, through witty) and as a `Raster` (colored cells):

```powershell
witty -- claude --plugin-dir C:\Repositories\witty\examples\witty-probe
```

Without witty the Image slot shows its alt text; with witty it shows the sprite.

witty sets `CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1` for the child so Claude Code draws images without
waiting for a kitty terminal to answer; `--no-force` leaves the environment alone. A Claude Mod then
draws pictures with the terminal `Image` element as it would in kitty or Ghostty.

| Option | Meaning |
|---|---|
| `--cell WxH` | cell size in pixels when the terminal does not report it (default 10x20; decimals allowed, e.g. `9.375x20`). witty asks `CSI 14 t` and `CSI 18 t` (exact, fractional) and `CSI 16 t` (rounded) first |
| `--no-force` | do not set `CLAUDE_CODE_FORCE_TERMINAL_IMAGES` |
| `--no-inherit-cursor` | start the command's console with its cursor at the top-left. By default witty's ConPTY asks the terminal where its cursor is (`CSI 6 n`) and starts the console there, so Claude Code, which draws from its console cursor row, draws below what the shell left on screen instead of over it |
| `--no-files` | refuse the file transports (`t=f`, `t=t`); by default witty reads only absolute local regular files, with a size check, a timeout and no file-system oracle (see SECURITY.md) |
| `--scale auto\|nearest\|smooth` | how images are scaled to their cells. `auto` (default) uses sharp nearest-neighbour when an image is enlarged 2x or more on both axes (pixel art, icons, sprites) and smooth filtering otherwise; `nearest` and `smooth` force one |
| `--log <file>` | append diagnostics to a file (`--debug` uses `%TEMP%\witty.log`) |
| `--help`, `--version` | |

## How it works

See `docs/design.md`. In short: `src/kitty/` splits and interprets the protocol (transmit, put,
delete, query, chunking, PNG and raw pixels, zlib, file transport), `src/sixel/` quantizes and encodes,
`src/term/emit.ts` wraps each placement in save-cursor / sixel / restore-cursor plus kitty's cursor
move, `src/term/placeholders.ts` draws unicode placeholder cells (virtual placements, `U=1`, which
Claude Code uses) as sixel strips, and `src/host/` plus `src/pipeline.ts` keep bytes in order between
the child and the terminal.

Not translated (sixel has no equivalent): z-index below text, animations, relative placements,
deletes by screen position. They are accepted and logged.

## Develop

```powershell
npm run typecheck
npm test                 # 208 tests: protocol, encoder, placeholders, host, and an end-to-end run in a ConPTY
tools\probe-terminal.ps1 # what does this terminal answer to graphics queries?
```

## Security

The child's output is treated as untrusted. `SECURITY.md` has the threat model, what witty
guarantees, and how to report a vulnerability.
