// Cell pixel size, as exact as the terminal lets us know it.
//
// At startup witty asks three XTWINOPS questions at once:
//
//   CSI 14 t   text area in pixels   reply CSI 4 ; height ; width t
//   CSI 18 t   text area in cells    reply CSI 8 ; rows ; cols t
//   CSI 16 t   cell size in pixels   reply CSI 6 ; height ; width t
//
// xterm.js (Tabby) has fractional cells in CSS pixels and rounds its 16 t
// reply, so a strip of n cells drawn at the rounded size is off by up to n/2
// pixels. The text area divided by the cell count is exact, so it wins:
// cell = pixelWidth / cols × pixelHeight / rows (cols and rows from the 18 t
// reply, else the console's own size). Without a 14 t reply the 16 t reply
// is used, and without either the configured fallback (`--cell`, decimals
// allowed).

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
 * Every `CSI 4|6|8 ; a ; b t` report in `bytes` (7-bit `ESC [` or 8-bit 0x9b
 * introducer), in order. Reports with a zero dimension are skipped.
 */
export function parseWindowReports(bytes: Uint8Array): WindowReport[] {
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('latin1')
  const re = /(?:\x1b\[|\x9b)([468]);(\d{1,5});(\d{1,5})t/g
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

/** The readable side `learnCellSize` listens on (process.stdin, already raw). */
export interface ByteSource {
  on(event: 'data', listener: (chunk: Buffer | string) => void): unknown
  off(event: 'data', listener: (chunk: Buffer | string) => void): unknown
  pause(): unknown
}

export type LearnCellSizeOptions = {
  /** Where replies arrive. Default process.stdin. */
  input?: ByteSource
  /** Writes the queries. Default: process.stdout.write. */
  write?: (data: string) => void
  /** Used when the terminal does not answer in time. Default 10x20. */
  fallback?: CellSize
  /** The console size in cells, when the terminal does not answer CSI 18 t. Default process.stdout's. */
  screen?: () => { columns: number; rows: number }
  /** How long to wait for any answer. Default 300 ms. */
  timeoutMs?: number
  /** After a reply, how long to wait for the others. Default 60 ms. */
  settleMs?: number
}

export type LearnedCellSize = {
  cell: CellSize
  /** True when the terminal answered; false when the fallback was used. */
  fromTerminal: boolean
  /** Which answer the cell size is from. */
  source: CellSource
  /** Every size report received, in order. */
  reports: WindowReport[]
  /** Everything else read meanwhile (user typing, other replies), to forward to the child. */
  leftover: Uint8Array
}

/**
 * Picks the cell size from `reports`: the last text area in pixels divided
 * by the last size in cells (or `screen`), else the last CSI 16 t reply.
 */
export function chooseCellSize(
  reports: readonly WindowReport[],
  screen: { columns: number; rows: number } | undefined,
): { cell: CellSize; source: CellSource } | undefined {
  const last = (kind: WindowReport['kind']): WindowReport | undefined => {
    for (let i = reports.length - 1; i >= 0; i--) if (reports[i]!.kind === kind) return reports[i]
    return undefined
  }
  const area = last('text-area')
  if (area !== undefined) {
    const cells = last('cells')
    const derived = deriveCellSize(area, cells !== undefined ? { columns: cells.width, rows: cells.height } : (screen ?? { columns: 0, rows: 0 }))
    if (derived !== undefined) return { cell: derived, source: 'text area' }
  }
  const cell = last('cell')
  if (cell !== undefined) return { cell: { width: cell.width, height: cell.height }, source: 'terminal reply' }
  return undefined
}

/**
 * Sends the startup queries and collects the replies: it resolves once all
 * three have arrived, `settleMs` after the latest reply when some never come,
 * or after `timeoutMs` with the fallback when none does. Every other byte
 * read meanwhile is returned in `leftover`, in order. The input is PAUSED
 * when this resolves, so no byte is lost before the caller attaches its own
 * listener; the caller must `resume()` it.
 */
export function learnCellSize(options: LearnCellSizeOptions = {}): Promise<LearnedCellSize> {
  const input = options.input ?? process.stdin
  const write = options.write ?? ((s: string) => void process.stdout.write(s))
  const fallback = options.fallback ?? DEFAULT_CELL_SIZE
  const screen =
    options.screen ?? (() => ({ columns: process.stdout.columns ?? 0, rows: process.stdout.rows ?? 0 }))
  const timeoutMs = options.timeoutMs ?? 300
  const settleMs = options.settleMs ?? 60

  return new Promise((resolve) => {
    let buffered: Uint8Array = new Uint8Array(0)
    const reports: WindowReport[] = []
    let done = false
    let settle: ReturnType<typeof setTimeout> | undefined

    const finish = () => {
      if (done) return
      done = true
      clearTimeout(timer)
      clearTimeout(settle)
      input.off('data', onData)
      input.pause()
      const chosen = chooseCellSize(reports, screen())
      resolve({
        cell: chosen?.cell ?? fallback,
        fromTerminal: chosen !== undefined,
        source: chosen?.source ?? 'fallback',
        reports,
        leftover: buffered,
      })
    }

    const onData = (chunk: Buffer | string) => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
      const joined = new Uint8Array(buffered.length + bytes.length)
      joined.set(buffered, 0)
      joined.set(bytes, buffered.length)
      // Cut every complete report out; a partial one stays buffered until it completes.
      const found = parseWindowReports(joined)
      if (found.length === 0) {
        buffered = joined
        return
      }
      const kept: Uint8Array[] = []
      let from = 0
      for (const report of found) {
        kept.push(joined.subarray(from, report.start))
        from = report.end
        reports.push({ ...report, start: 0, end: 0 })
      }
      kept.push(joined.subarray(from))
      buffered = new Uint8Array(Buffer.concat(kept))
      const kinds = new Set(reports.map((r) => r.kind))
      if (kinds.size === 3) {
        finish()
        return
      }
      clearTimeout(settle)
      settle = setTimeout(finish, settleMs)
    }

    const timer = setTimeout(finish, timeoutMs)
    input.on('data', onData)
    write(STARTUP_QUERIES)
  })
}

/**
 * Follows size reports seen on the input after startup (the child asked):
 * a text area in pixels re-derives the cell size; a CSI 16 t reply is taken
 * unless the current size came from the text area and the reply is just its
 * rounding (within a pixel per side).
 */
export function trackCellSize(
  current: { cell: CellSize; source: CellSource },
  reports: readonly WindowReport[],
  screen: { columns: number; rows: number },
): { cell: CellSize; source: CellSource } {
  let state = current
  let cells: { columns: number; rows: number } = screen
  for (const report of reports) {
    if (report.kind === 'cells') {
      cells = { columns: report.width, rows: report.height }
    } else if (report.kind === 'text-area') {
      const derived = deriveCellSize(report, cells)
      if (derived !== undefined) state = { cell: derived, source: 'text area' }
    } else {
      const rounding =
        state.source === 'text area' &&
        Math.abs(report.width - state.cell.width) < 1 &&
        Math.abs(report.height - state.cell.height) < 1
      if (!rounding) state = { cell: { width: report.width, height: report.height }, source: 'terminal reply' }
    }
  }
  return state
}
