// Cell pixel size, as exact as the terminal lets us know it.
//
// At startup witty asks three XTWINOPS questions at once:
//
//   CSI 14 t   text area in pixels   reply CSI 4 ; height ; width t
//   CSI 18 t   text area in cells    reply CSI 8 ; rows ; cols t
//   CSI 16 t   cell size in pixels   reply CSI 6 ; height ; width t
//
// It does not wait for the answers: the child starts at once with the
// configured fallback (`--cell`, decimals allowed), and the answers, which
// come back on the input like anything else, are taken out of it
// (ReplyFilter) and replace the fallback as they arrive (trackCellSize).
//
// xterm.js (Tabby) has fractional cells in CSS pixels and rounds its 16 t
// reply, so a strip of n cells drawn at the rounded size is off by up to n/2
// pixels. The text area divided by the cell count is exact, so it wins:
// cell = pixelWidth / cols × pixelHeight / rows (cols and rows from the 18 t
// reply, else the console's own size). Without a 14 t reply the 16 t reply
// is used, and without either the fallback stays.

import type { CellSize } from '../types.ts'

/** XTWINOPS 16: report the character cell size in pixels. */
export const CELL_SIZE_QUERY = '\x1b[16t'
/** XTWINOPS 14: report the text area size in pixels. */
export const TEXT_AREA_QUERY = '\x1b[14t'
/** XTWINOPS 18: report the text area size in characters. */
export const TEXT_CELLS_QUERY = '\x1b[18t'
/** Everything sent at startup, in the order the replies come back. */
export const STARTUP_QUERIES = TEXT_AREA_QUERY + TEXT_CELLS_QUERY + CELL_SIZE_QUERY

/** The default fallback, `--cell 10x20`. */
export const DEFAULT_CELL_SIZE: CellSize = { width: 10, height: 20 }

/** A located reply inside a byte buffer. */
export type CellSizeReply = {
  cell: CellSize
  /** Offset of the reply's first byte. */
  start: number
  /** Offset just past the reply's last byte. */
  end: number
}

/**
 * One XTWINOPS size report: `text-area` (CSI 4 t, pixels), `cell` (CSI 6 t,
 * pixels) or `cells` (CSI 8 t, characters). `width`/`height` are pixels for
 * the first two and columns/rows for `cells`.
 */
export type WindowReport = {
  kind: 'text-area' | 'cell' | 'cells'
  width: number
  height: number
  start: number
  end: number
}

const REPORT_KINDS = { '4': 'text-area', '6': 'cell', '8': 'cells' } as const

/**
 * Every `CSI 4|6|8 ; a ; b t` report in `bytes`, in order. Reports with a
 * zero dimension are skipped. Only the 7-bit `ESC [` introducer counts: the
 * input is UTF-8, where a 0x9b byte is always part of a character (Û, ě, Л,
 * 💛 ...), and terminals in UTF-8 mode never send a raw 8-bit CSI.
 */
export function parseWindowReports(bytes: Uint8Array): WindowReport[] {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1')
  const re = /\x1b\[([468]);(\d{1,5});(\d{1,5})t/g
  const reports: WindowReport[] = []
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const height = Number(m[2])
    const width = Number(m[3])
    if (width > 0 && height > 0) {
      const kind = REPORT_KINDS[m[1] as '4' | '6' | '8']
      reports.push({ kind, width, height, start: m.index, end: m.index + m[0].length })
    }
  }
  return reports
}

/**
 * Finds the first `CSI 6 ; height ; width t` in `bytes`. Returns undefined
 * when there is none, or when a dimension is zero.
 */
export function parseCellSizeReply(bytes: Uint8Array): CellSizeReply | undefined {
  const report = parseWindowReports(bytes).find((r) => r.kind === 'cell')
  if (report === undefined) return undefined
  return { cell: { width: report.width, height: report.height }, start: report.start, end: report.end }
}

/** Describes a report for the log. */
export function describeReport(report: WindowReport): string {
  switch (report.kind) {
    case 'text-area':
      return `text area ${report.width}x${report.height} px (CSI 14 t)`
    case 'cells':
      return `text area ${report.width}x${report.height} cells (CSI 18 t)`
    default:
      return `cell ${report.width}x${report.height} px (CSI 16 t)`
  }
}

/** A cell size for the log, three decimals per side. */
export function formatCell(cell: CellSize): string {
  return `${cell.width.toFixed(3)}x${cell.height.toFixed(3)}`
}

/** The cell size from a text area in pixels and its size in cells. */
export function deriveCellSize(pixels: { width: number; height: number }, cells: { columns: number; rows: number }): CellSize | undefined {
  if (!(pixels.width > 0 && pixels.height > 0 && cells.columns > 0 && cells.rows > 0)) return undefined
  return { width: pixels.width / cells.columns, height: pixels.height / cells.rows }
}

/** Parses `--cell WxH` (e.g. `10x20`, `9.375x20`). Returns undefined if malformed. */
export function parseCellOption(value: string): CellSize | undefined {
  const m = /^\s*(\d{1,4}(?:\.\d{1,6})?)\s*[xX×]\s*(\d{1,4}(?:\.\d{1,6})?)\s*$/.exec(value)
  if (m === null) return undefined
  const width = Number(m[1])
  const height = Number(m[2])
  return width > 0 && height > 0 ? { width, height } : undefined
}

/** Where a cell size came from. */
export type CellSource = 'text area' | 'terminal reply' | 'fallback'

/** The kinds of report the startup queries ask for. */
export const STARTUP_KINDS: readonly WindowReport['kind'][] = ['text-area', 'cells', 'cell']

/** A cell size, where it came from, and what {@link trackCellSize} keeps between reads. */
export type TrackedCellSize = {
  cell: CellSize
  source: CellSource
  /**
   * Witty's own text-area answer (CSI 14 t), kept while the answer to its
   * CSI 18 t may still come in a later read: that cell count divides it.
   */
  area?: { width: number; height: number }
}

/**
 * Follows the size reports seen on the input, one read at a time. `own` are
 * the answers to witty's startup queries among `reports` (what
 * {@link ReplyFilter.push} consumed); the rest went to the child, which
 * asked.
 *
 * A text area in pixels re-derives the cell size, divided by the size in
 * cells from the same read (the last `CSI 8 t` in it, wherever it stands:
 * the queries go out 14 t first, so its answer comes before the cell count
 * it needs), else by `screen`. Witty's own cell count re-derives it from
 * witty's own text area when that came in an earlier read. A CSI 16 t reply
 * is taken unless the current size came from the text area and the reply
 * is witty's own (the three answers describe one moment, and the text area
 * is exact) or just the text area's rounding (within a pixel per side).
 *
 * However witty's three answers are split across reads, the size they leave
 * is the one picked from all three at once: the text area divided by the
 * cell count (else by `screen`), else the 16 t reply, else `current`.
 */
export function trackCellSize(
  current: TrackedCellSize,
  reports: readonly WindowReport[],
  screen: { columns: number; rows: number },
  own: readonly WindowReport[] = [],
): TrackedCellSize {
  let state: { cell: CellSize; source: CellSource } = { cell: current.cell, source: current.source }
  let area = current.area
  let cells: { columns: number; rows: number } = screen
  for (const report of reports) {
    if (report.kind === 'cells') cells = { columns: report.width, rows: report.height }
  }
  for (const report of reports) {
    const mine = own.includes(report)
    if (report.kind === 'text-area') {
      const derived = deriveCellSize(report, cells)
      if (derived !== undefined) state = { cell: derived, source: 'text area' }
      if (mine) area = { width: report.width, height: report.height }
    } else if (report.kind === 'cells') {
      if (!mine) continue
      if (area !== undefined) {
        const derived = deriveCellSize(area, { columns: report.width, rows: report.height })
        if (derived !== undefined) state = { cell: derived, source: 'text area' }
      }
      area = undefined
    } else {
      const keep =
        state.source === 'text area' &&
        (mine || (Math.abs(report.width - state.cell.width) < 1 && Math.abs(report.height - state.cell.height) < 1))
      if (!keep) state = { cell: { width: report.width, height: report.height }, source: 'terminal reply' }
      // The terminal answers in order: after witty's 16 t answer, no answer to its 18 t is still to come.
      if (mine) area = undefined
    }
  }
  return area === undefined ? state : { ...state, area }
}

/** Which final parameter each report kind has: `CSI 4 ; ... t` and so on. */
const KIND_DIGIT: Record<WindowReport['kind'], string> = { 'text-area': '4', cell: '6', cells: '8' }

/**
 * Takes the answers to witty's own startup queries out of the input. The
 * queries go out before the child starts and the terminal answers in order,
 * so the first report of each kind still owed (all of {@link STARTUP_KINDS}
 * at first) is witty's, however late it comes, and is consumed instead of
 * forwarded; every later one goes to the child, which asked for it. While a
 * kind is owed, a chunk that ends in what can only be the start of its
 * report (`ESC [ 6 ;` and digits, which no key sends as a whole read) is
 * held for the next chunk; `flush` hands it back if none comes.
 */
export class ReplyFilter {
  private readonly owed: Set<WindowReport['kind']>
  private held: Uint8Array = new Uint8Array(0)

  constructor(owed: Iterable<WindowReport['kind']>) {
    this.owed = new Set(owed)
  }

  /** The kinds whose answer has not come yet. */
  get pending(): ReadonlySet<WindowReport['kind']> {
    return this.owed
  }

  /** Whether the start of a report is held back. */
  get holding(): boolean {
    return this.held.length > 0
  }

  /**
   * Splits one input chunk into the bytes to forward and the reports in it:
   * all of them in order (`reports`, for {@link trackCellSize}) and the ones
   * taken out as witty's own (`consumed`).
   */
  push(chunk: Uint8Array): { forward: Uint8Array; reports: WindowReport[]; consumed: WindowReport[] } {
    if (this.owed.size === 0 && this.held.length === 0) {
      return { forward: chunk, reports: parseWindowReports(chunk), consumed: [] }
    }
    const joined = this.held.length === 0 ? chunk : new Uint8Array(Buffer.concat([this.held, chunk]))
    this.held = new Uint8Array(0)
    const reports = parseWindowReports(joined)
    const parts: Uint8Array[] = []
    const consumed: WindowReport[] = []
    let from = 0
    for (const report of reports) {
      if (!this.owed.delete(report.kind)) continue
      consumed.push(report)
      parts.push(joined.subarray(from, report.start))
      from = report.end
    }
    let rest = joined.subarray(from)
    if (this.owed.size > 0) {
      const digits = [...this.owed].map((kind) => KIND_DIGIT[kind]).join('')
      const tailLength = Math.min(rest.length, 16)
      const tail = Buffer.from(rest.buffer, rest.byteOffset + rest.length - tailLength, tailLength).toString('latin1')
      const m = new RegExp(`\\x1b\\[[${digits}];\\d{0,5}(?:;\\d{0,5})?$`).exec(tail)
      if (m !== null) {
        this.held = rest.slice(rest.length - m[0].length)
        rest = rest.subarray(0, rest.length - m[0].length)
      }
    }
    parts.push(rest)
    const forward = parts.length === 1 ? (parts[0] as Uint8Array) : new Uint8Array(Buffer.concat(parts))
    return { forward, reports, consumed }
  }

  /** Gives back whatever is held (nothing when nothing is). */
  flush(): Uint8Array {
    const held = this.held
    this.held = new Uint8Array(0)
    return held
  }
}
