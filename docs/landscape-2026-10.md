# Terminal graphics on Windows for Claude Mods — landscape, 11 Oct 2026

Machine surveyed: Windows 11 26H2 (build 26300), Windows Terminal 1.24 stable, Claude Code 2.1.296.

## What the Mod API offers (terminal surface)

- `Image` — a picture over a box of cells. Emits the **kitty graphics protocol** only; where the
  terminal cannot draw it, the required `alt` text is drawn dim in its place. Sources: base64 PNG,
  base64 RGBA, a PNG/raw file path the terminal reads itself, or a POSIX shm name (not Windows).
- `Raster` — a grid of `columns × rows` cells, each `[codePoint, fg, bg]` (u32 LE triplets, base64).
  Any width‑1 BMP glyph, 24‑bit colors. Works in every terminal. `$.ui.blit` repaints it without a redraw.
- Detection inside Claude Code (from the 2.1.296 binary): `kittyGraphics` is *settled true* only with
  `CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1`; off in tmux/screen and bg workers; otherwise "not asked yet"
  and the terminal is queried (`ESC _ G a=T,t=f,f=100,q=2 …` / `t=d` variants). Only `kitty` (≥0.28)
  and `ghostty` are treated as likely. Windows Terminal never answers, so `Image` draws its alt.

## Windows terminals

| Terminal | kitty graphics | sixel | notes |
|---|---|---|---|
| Windows Terminal 1.24/1.25 stable, 1.26 preview | no (microsoft/terminal#8389, team "experimenting", Aug 2026) | yes since 1.22 | kitty **keyboard** protocol since 1.25 |
| WezTerm (Windows) | broken under ConPTY (wezterm#1673, open) | iTerm2 protocol works | Claude Code does not emit iTerm2 or sixel |
| Ghostty | n/a | n/a | no Windows build |
| kitty | n/a | n/a | no Windows build |
| VS Code 1.110+ integrated terminal | yes (`terminal.integrated.enableImages`, `windowsUseConptyDll`) | yes | Windows path reported but not independently verified |
| WSL + any of the above | same as host terminal | | Claude Code in WSL still talks to the Windows terminal through ConPTY |

## ConPTY

- The in‑box `conhost`/ConPTY (System32) drops APC (`ESC _ … ESC \`) and sixel DCS payloads.
- The bundled `Microsoft.Windows.Console.ConPTY` NuGet (conpty.dll + OpenConsole.exe, MIT) passes both
  through byte‑exact (reports on 1.24/1.25). Windows Terminal hosts shells under its own bundled copy,
  which is why sixel works in it and why kitty APC reaches it only to be ignored.

## Candidate designs for "witty"

A. **Mod‑level layer** (portable, no pixels): a `ui.render` hook above other mods walks the tree it gets
   from `next(e)` and rewrites every `Image` into a `Raster` of half‑block (`▀`, 1×2 px/cell) or
   quadrant (2×2 px/cell) glyphs. Needs a PNG decoder in the module sandbox (pure‑TS inflate) or an
   external decoder via `$.process.run`. Resolution is coarse; a 1‑row band favicon is ~2 px tall.

B. **PTY shim** (real pixels in Windows Terminal): a launcher that hosts `claude.exe` in the bundled
   ConPTY, parses kitty APC from the output stream, answers `a=q` queries with `_Gi=…;OK`, decodes
   PNG/RGBA (incl. `o=z`), scales to the cell box using `CSI 16 t`, emits **sixel** DCS at the cursor,
   and forwards everything else (input, mouse, resize). Run with `CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1`
   so Claude Code emits images. Sixel limits: 256‑color palette, no z‑index/placeholders/animation,
   image erased when its cells are overwritten.

C. **Wait / switch**: Windows Terminal is experimenting with kitty graphics; VS Code's terminal has it now.

## Tools

- `tools/probe-terminal.ps1` — run in a plain tab; prints replies to DA1, XTSMGRAPHICS, CSI 14/16 t,
  the kitty query and the kitty keyboard query, then draws a sixel square.
