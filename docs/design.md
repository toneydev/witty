# witty — design

Goal: make the kitty graphics protocol work for Claude Code on Windows terminals that have no kitty
support but do render sixel (Windows Terminal 1.22+, Tabby 1.0.238+), by hosting the program in a
pseudo-console that passes the kitty APC sequences through and translating them to sixel on the way out.

```
┌──────────────┐  stdin (VT)  ┌───────────────────────────┐  conin   ┌──────────────┐
│ outer terminal│ ───────────► │ witty                     │ ───────► │ claude.exe   │
│ WT / Tabby    │ ◄─────────── │  node-pty + bundled ConPTY│ ◄─────── │ (or any app) │
└──────────────┘  stdout      │  APC G parser → sixel     │  conout  └──────────────┘
                              └───────────────────────────┘
```

## Pieces

| Module | Job |
|---|---|
| `src/cli.ts` | arguments, environment, wiring |
| `src/host/pty.ts` | spawn the child in node-pty with `useConptyDll: true` and `conptyInheritCursor: true` (see "Two consoles, one cursor"); forward input; resize |
| `src/host/resolve.ts` | find the command on PATH (never the current directory); run `.cmd`/`.bat` through `cmd.exe` with arguments quoted so cmd cannot run them (see "Security") |
| `src/host/console.ts` | raw mode on Node 24 already leaves the console input in VT mode (measured: mode 0x208); a hidden PowerShell P/Invoke fallback sets it on older Node |
| `src/kitty/splitter.ts` | streaming splitter: output bytes → text runs and complete `ESC _ G … ESC \` commands, chunk-safe |
| `src/kitty/command.ts` | parse `k=v,k=v;payload` into a typed command |
| `src/kitty/engine.ts` | the interpreter: image store, chunk accumulation (`m=1`), transmit / put / delete / query, responses |
| `src/kitty/decode.ts` | payload → RGBA: PNG (`f=100`), raw `f=24`/`f=32`, `o=z` inflate, `t=d` direct, `t=f`/`t=t` file |
| `src/kitty/files.ts` | the file transport policy: which paths may be read (and `t=t` files deleted), uniform errors, timeout |
| `src/image/resize.ts` | scale to the target pixel box, or only its top-left region: nearest-neighbour or smooth (box / bilinear), `auto` picks |
| `src/sixel/quantize.ts` | median cut to ≤255 colors plus a transparent index |
| `src/sixel/encode.ts` | RGBA → sixel DCS string |
| `src/term/metrics.ts` | learn the (fractional) cell size: `CSI 14 t` / `CSI 18 t`, else `CSI 16 t`, else `--cell` |
| `src/term/emit.ts` | wrap a placement (clipped to the screen, cached): save cursor, sixel, restore cursor, move per kitty's cursor policy; encode a placeholder strip |
| `src/term/placeholders.ts` | the unicode placeholder pass over outgoing text, and the registry of virtual placements |
| `src/term/diacritics.ts` | kitty's row/column diacritic table (`rowcolumn-diacritics.txt`, 297 code points) |
| `src/image/crop.ts` | cut a pixel rectangle out of an image (transparent outside it) |

## Placement semantics

kitty draws an image at the cursor and, with `C=0` (default), leaves the cursor to the right of the
image's bottom-right cell. Sixel terminals disagree about where the cursor lands after an image, so
every placement is emitted as

```
ESC 7   DCS q … ST   ESC 8   CSI (rows-1) B   CSI (cols) C
```

The image box is `c`×`r` cells when given (scaled to fill, as Claude Code's `Image` does), else
`ceil(width / cellW)` × `ceil(height / cellH)`.

A placement is clipped to the screen as kitty clips it at the screen edge: with a known terminal
size, only the top-left `min(c, screen columns)` × `min(r, screen rows)` cells are scaled
(`resizeRegion`, the same filter taps as the whole box) and encoded, so one put never costs more
than a screenful of sixel; the cursor still moves past the whole box. Encoded placements are cached
per source image (an uncropped `a=p` reuses the stored image) under box, cell size, visible cells
and cursor policy, LRU within 32 MiB, so repeated puts reuse their bytes.

Scaling policy (`--scale`, default `auto`): `nearest` copies the source pixel under each target
pixel's centre, `smooth` filters (box when shrinking, bilinear when growing, alpha premultiplied),
and `auto` uses nearest when the image grows 2x or more on both axes and smooth otherwise. Small
sprites and icons (an 8x4 sprite in a 72x38 box, say) stay sharp; downscaled photos and small
enlargements stay smooth. Smooth filtering runs the axis that gives the smaller intermediate first,
so scratch memory stays within a small multiple of the larger of source and destination, whatever
the source's shape (a 256x65536 image in an 8192x20 box once asked for 8 GiB). The same policy applies to normal placements (`createPlaceEmitter`) and
to virtual placements (the placeholder pass scales the whole box once, then cuts strips from it).

`a=d` deletes: the cells of every matching placement are overwritten with spaces (sixel has no
delete), then the cursor is restored.

Unsupported and ignored, logged at `--debug`: animations, relative placements (`P`,`Q`), `z`
(everything draws above text), `t=s` shared memory.

## Unicode placeholders

What Claude Code sends (captured from its real output with forced images):

```
ESC _ G a=T,U=1,q=2,f=32,s=8,v=4,i=8605545,c=8,r=2;<base64 RGBA> ESC \
... later, between cursor moves, one row at a time:
ESC[38;2;131;79;105m  U+10EEEE U+0305 U+0305  U+10EEEE U+0305 U+030D  ...  (8 cells per row)
```

`U=1` creates a *virtual placement*: nothing is drawn. The image shows wherever the program writes
placeholder cells, U+10EEEE followed by up to three diacritics from kitty's table (row, column, most
significant byte of the image id). The low 24 bits of the image id are the cell's foreground colour
(`38;2;r;g;b` → r<<16|g<<8|b, `38;5;n` → n, 30–37/90–97 → 0–15, colon forms too), the placement id
its underline colour (`58;…`). A cell without diacritics continues the cell to its left (same
colours): row, column + 1, high byte; a row-only cell continues its row.

The engine turns `a=T`/`a=p` with `U=1` into a `virtual` event (box `c`×`r`, computed as for a normal
placement when one is missing) instead of `place`. Deletes by `i`/`I`/`n`/`N`/`r`/`R` drop virtual
placements (`d=a` keeps them, as in kitty); re-transmitting the image re-emits them with the new
pixels. The pipeline keeps a registry of them from `virtual` and `delete` events.

What witty writes instead: every text item leaving the splitter goes through the placeholder pass,
in byte order (so after the events of every command before it). It tracks the foreground and
underline colours from SGR as they pass, and groups consecutive cells of the same image, row and
consecutive columns into a strip. Each strip of `n` cells becomes

```
ESC 7   n spaces   ESC 8   DCS q … ST   ESC 8   CSI n C
```

The spaces clear stale glyphs (with the current attributes); DECRC rather than `CSI n D` goes back,
because spaces ending in the last column leave the cursor pending-wrap there and `CSI n D` would
land one cell short. No glyph is written where the image is. Cells of an image id with no virtual
placement pass through unchanged; cells outside the `c`×`r` box become spaces.

The strip's pixels: the placement's image scaled once to `round(columns*cellW)` ×
`round(rows*cellH)` (filling the box, like a normal placement; Claude Code picks `c`/`r` from the
aspect ratio), cropped to `x = round(c0*cellW) .. round((c0+n)*cellW)`,
`y = round(row*cellH) .. round((row+1)*cellH)`. The cell size may be fractional (see "Cell size"),
and rounding the boundaries rather than the size keeps neighbouring strips tiled. A `virtual` event
carries the stored image itself plus its source rectangle (`x,y,w,h`), never a copy; the rectangle
is cut only while the cache is built, and the cut is dropped after scaling. Cache: per virtual
placement, the scaled image for the current cell size and the encoded strips keyed by (row, c0, n),
least recently drawn first within one 128 MiB budget across all placements (scaled images and
strips counted) and at most 256 placements; a new cell size rebuilds it, and the caches of replaced
or deleted placements are dropped when the next one is built.

Chunk safety: escape sequences are parsed by a streaming state machine (their bytes are never held),
OSC/DCS/APC strings are skipped. Only a trailing partial U+10EEEE and a run whose last cell may still
get diacritics (fewer than three) are held for the next chunk; a run ending in a complete cell is
flushed at the chunk end (it may then come out as two strips). A held run is written out when the
next item is a kitty command (the command ends it, and its bytes come first), when no new chunk has
arrived for 25 ms (an idle timer, reset by every chunk, so a row that ends a frame is drawn even if
the child goes quiet; if it fires while a command is in flight, the flush queues behind it), and at
`end()`, which also clears the timer. If the
cell size is wrong, strips are misaligned: the `--log` file records `cell size WxH (terminal reply)`
or `(fallback)` at startup.

## Responses

A command with `q` absent or `0` is answered on the child's input as kitty would:
`ESC _ G i=<id>[,I=<n>];OK ESC \`, or `EINVAL`/`ENOENT`/`EBADPNG` with a message. `q=1` suppresses
OK, `q=2` suppresses everything. `a=q` never stores anything.

The status is sanitised before it goes to the child's input: every character outside printable
ASCII (0x20–0x7e), and `;` and `\`, becomes `?`, and it is cut to 128 characters, so nothing in it
can end the response or inject a sequence. Messages are fixed strings and never echo the command's
values (`unsupported format`, `unknown action`, `invalid value for key s`, every pngjs failure is
`EBADPNG:invalid PNG`). Log lines name an action or selector only when it is a known one; the
logged APC keys go through the same sanitising.

## Security: untrusted child output

Everything the child writes is treated as untrusted input.

**File transports (`t=f`, `t=t`).** They are on by default (Claude Mods can use file image sources),
and `--no-files` turns both off (`EINVAL:file transmission is not supported`). The path comes from
the payload, so `src/kitty/files.ts` enforces a policy before the engine sees any data:

- Only absolute drive paths (`^[A-Za-z]:[\\/]`) are accepted. Rejected: anything starting with two
  separators (UNC `\\server\share`, `\\.\` and `\\?\` device namespaces, `//`), relative and
  drive-relative paths (`C:x`), NUL, a `:` after the drive (alternate data streams), and any path
  whose basename stem is a DOS device (CON PRN AUX NUL COM1–9 LPT1–9, case-insensitive, trailing
  spaces ignored).
- `path.resolve`, then `lstat`: regular files only, no directory, symlink, reparse point or device.
  The file is then opened and `fstat`ed, and the handle must be the same file (`dev`/`ino`) as the
  one checked, so it cannot be swapped for a link in between.
- Its size must be at most the image limit (64 MiB) and the `O`/`S` range must lie inside it,
  checked before any byte is read.
- The read (`FileHandle.readFile` with `AbortSignal.timeout(2000)`), together with the checks, is
  raced against a 2 s timer, so a stalled volume (a mapped network drive, say) errors instead of
  freezing the pipeline.
- Every failure, including decoding a file that was read (inflate, PNG, raw size, a malformed
  `O`/`S`), gives exactly one status, `EBADF:Failed to read image file`, with no detail, so the
  response says nothing about whether a path exists, how large it is or whether it is readable.
  Only a file that decodes as the image the command describes is answered OK, as in kitty.
- A `t=t` file is deleted only when the resolved path lies inside `os.tmpdir()` (resolved, and
  `path.relative` neither starting with `..` nor absolute) and its basename contains
  `tty-graphics-protocol`. Nothing else is ever deleted, whether or not the decode succeeds.
  `X\tty-graphics-protocol\..\victim.txt` resolves to `X\victim.txt` and is not deleted.

A read that stalls inside the OS still holds a libuv threadpool thread until the OS returns. The
pipeline goes on, but repeated stalls could exhaust the pool's four threads.

**Allocation bounds.** A placement (normal or virtual, `c`/`r` given or derived from the aspect
ratio) larger than 1024 cells on a side is refused with `EINVAL:placement too large`. Any scaled
image (normal placements in `emit.ts`, virtual ones in `placeholders.ts`) is capped at 8192 pixels a
side and 16,777,216 pixels in area. A larger box is scaled down proportionally, and the image then
draws smaller than its cells. For a virtual placement the strips are cut with a matching smaller
cell, so they still tile. Decoded images are capped at 64 MiB of RGBA, payloads at 32 MiB, and the
image store at 256 MiB and 4096 images (LRU; storing an image costs constant time while the store
fits). At most 4096 virtual placements are kept (past that the oldest is dropped, with a log line
and a `delete`), and 1024 distinct placement ids per image (the rest are only counted, so the image
stays referenced). The placeholder caches share 128 MiB and the encoded placement cache 32 MiB. A
normal placement costs at most one screenful of sixel per put (see "Placement semantics").

**The console-mode helper** (`host/console.ts`, only on Node < 24 or `--vt-input always`) starts
`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` by absolute path, never by a PATH
lookup. If that file does not exist, the helper is skipped with a log line. It declares its
P/Invoke calls with Reflection.Emit rather than Add-Type, so no C# compiler runs and no temp files are
written; on a cold CI runner, Add-Type compiling with csc ran past the old 10 s timeout. The timeout
is now 30 s (`WITTY_CONSOLE_HELPER_TIMEOUT_MS` overrides it), and a failure is never fatal: the log
line carries the helper's stderr and witty goes on without VT input.

**The child command** (`host/resolve.ts`) is looked up in the `PATH` directories only, never the
current directory. A `.cmd`/`.bat` file (npm's `claude.cmd`) runs as
`cmd.exe /d /e:on /v:off /s /c ""<file>" <args>"`, with `ComSpec` or else
`%SystemRoot%\System32\cmd.exe`. cmd parses the arguments twice, once on that line and again where
the batch file expands `%*`, so they are quoted the way Rust does since CVE-2024-24576: anything
outside `[A-Za-z0-9#$*+-./:?@\_]` is quoted per the MSVC rules with an embedded `"` written `""`
(cmd's quote state never flips, so `&|<>^()` stay quoted on both passes, and node.exe reads `""` as
one `"`), each `%` becomes `%%cd:~,%` (nothing can pair up into `%name%`), and `/v:off` keeps `!`
literal. An argument holding CR, LF or NUL cannot be carried through cmd and is refused. A batch
file that turns on delayed expansion itself, or re-parses `%1` carelessly, is beyond any quoting.

**The portable launcher** (`witty.cmd`) finds `node.exe` with `%~$PATH:I`, which searches the
`PATH` directories only: a bare `node` (or `where node`) would let cmd.exe run a `node.exe`,
`node.cmd` or `node.bat` planted in the current directory, even when witty was started from
PowerShell. It starts node with the caller's environment unchanged.

## Environment of the child

`CLAUDE_CODE_FORCE_TERMINAL_IMAGES=1` is set unless `--no-force`, because Claude Code only draws
images for terminals it recognises or when forced. Nothing else is changed: Claude Code still sees
`WT_SESSION`/`TERM_PROGRAM` and keeps its Windows Terminal behaviour for keys and mouse.

## Two consoles, one cursor

The child has its own console (witty's ConPTY) whose screen buffer starts empty with the cursor at
the top-left, while the outer terminal still shows what the shell printed, with its cursor below
that. Claude Code sends no `CSI 6 n`; it reads its cursor row from the Windows console
(`GetConsoleScreenBufferInfo`) and draws its header from that row with `CSI row;1 H`. Run directly in
a terminal that row is where the shell left the cursor; under a fresh ConPTY it is 1, so the header
landed on top of the shell's last lines and, because the renderer places words with `CSI n G` and
never erases between them, the old text showed through the gaps (seen in Tabby and Windows Terminal
with 2.1.296).

The child is therefore spawned with node-pty's `conptyInheritCursor` (ConPTY's
`PSEUDOCONSOLE_INHERIT_CURSOR`): at startup the ConPTY writes `CSI 6 n`, which witty forwards to
the terminal like any output, the terminal's `CSI row;col R` comes back on stdin and is forwarded like
any input, and the ConPTY consumes it, sets its cursor there and writes `CSI row;col H` to sync the
terminal. Measured: Windows Terminal and Tabby answer, and when nothing answers the ConPTY goes on
after about 100 ms. `--no-inherit-cursor` turns it off.

## Known risks

- The inner ConPTY re-paints from its own buffer. If it ever repaints the cells under an image with
  spaces, the terminal erases the image there. Claude Code does not resend an unchanged image, so a
  repaint would leave a hole until the next redraw.
- Outer input: on Node 24 raw mode passes the VT byte stream through; mouse and kitty-keyboard bytes
  were verified end to end in the tests. Older Node may need the fallback in `host/console.ts`, which
  sets `ENABLE_VIRTUAL_TERMINAL_INPUT` through a hidden PowerShell helper.
- Cell pixel size: see "Cell size" below. xterm.js (Tabby) answers only when its `windowOptions`
  allow it. The fallback is `--cell WxH`, default 10x20.

## Cell size

Cell sizes are fractional end to end. xterm.js cells are fractional in CSS pixels and its
`CSI 16 t` reply is rounded (Tabby says 10x20), so a strip of n cells at the rounded size is off by
up to n/2 pixels; measured in Tabby, an 8-cell sprite came out about 8.5 cells wide. At startup witty
sends `CSI 14 t` (text area in pixels, reply `CSI 4;h;w t`), `CSI 18 t` (text area in cells, reply
`CSI 8;rows;cols t`) and `CSI 16 t` (cell in pixels, reply `CSI 6;h;w t`) together. It stops waiting
once all three are in, 60 ms after the latest reply when some never come, or after 300 ms.

Preference:
1. `CSI 14 t` divided by the cell count: `pixelWidth / cols`, `pixelHeight / rows`, with cols and
   rows from `CSI 18 t`, else the console's own size;
2. else the `CSI 16 t` reply;
3. else `--cell` (decimals allowed, e.g. `9.375x20`).

Replies seen later on the input (the child asked) are followed: a text area re-derives the cell
size; a `CSI 16 t` reply replaces it, unless the current size came from the text area and the reply
is only its rounding (within a pixel per side). Every reply and the chosen size, with three
decimals, are logged (`cell size 9.373x20.000 (text area)`).

Geometry rounds cell boundaries, never cell sizes. A placement covers `round(columns*cw)` ×
`round(rows*ch)` pixels. For a virtual placement the whole image is scaled to that box once, and
the strip for cells `c0..c0+n-1` on row `r` is the crop `x = round(c0*cw) .. round((c0+n)*cw)`,
`y = round(r*ch) .. round((r+1)*ch)`. Neighbouring strips share their boundaries, so they tile with
no gap or overlap; at `cw = 9.375` the cells are 9 or 10 pixels wide.

## Known limitation: images past the bottom row

If a placement runs below the last screen row the terminal scrolls, and `ESC 8` restores a row that
has since moved, so the cursor policy lands off by the scroll amount. kitty scrolls in the same
situation. Claude Code lays images out inside bands and panes that fit the screen, so this is not
expected in practice; a future fix is to make room first (`rows-1` newlines, then `CSI (rows-1) A`).
