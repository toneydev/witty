// Streaming splitter: child output bytes → text runs and kitty graphics APCs.

import type { ApcSplitter, SplitItem } from '../types.ts'
import { parseKittyCommand } from './command.ts'

const ESC = 0x1b
const UNDERSCORE = 0x5f
const G = 0x47
const BACKSLASH = 0x5c
const HEADER = Uint8Array.of(ESC, UNDERSCORE, G)
const LONE_ESC = Uint8Array.of(ESC)
const EMPTY = new Uint8Array(0)
const latin1 = new TextDecoder('latin1')

/** Largest kitty APC body held before it is given up and passed through as text. */
export const DEFAULT_MAX_APC_BYTES = 16 * 1024 * 1024

export type SplitterOptions = {
  /** Body size (bytes between `ESC _ G` and `ESC \`) beyond which an APC is passed through as text. */
  maxApcBytes?: number
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0]!
  let length = 0
  for (const part of parts) length += part.length
  const out = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/**
 * The kitty APC splitter (see `ApcSplitter`). Byte-oriented and chunk-safe:
 * it holds back only a trailing `ESC` or `ESC _` (which may still become
 * `ESC _ G`) or a kitty APC in progress; all other bytes are returned as text
 * from the `push` that delivered them. Text items may alias the pushed chunk.
 *
 * An APC aborted by an `ESC` not followed by `\`, or one that grows past
 * `maxApcBytes`, is passed through as text unchanged. Within one chunk the
 * text before an APC is cut off only once the APC completes, so an aborted
 * one is simply more of the same text run: nothing is copied, however many
 * there are.
 */
export class KittySplitter implements ApcSplitter {
  readonly #maxApcBytes: number
  /** Ground state: a held `ESC` or `ESC _` at the end of the last chunk. */
  #prefix: Uint8Array | null = null
  /** Inside a kitty APC (after `ESC _ G`). */
  #inApc = false
  #body: Uint8Array[] = []
  #bodyLength = 0
  /** Inside an APC, the last chunk ended with `ESC` (possibly the start of ST). */
  #bodyEsc = false

  constructor(options: SplitterOptions = {}) {
    this.#maxApcBytes = options.maxApcBytes ?? DEFAULT_MAX_APC_BYTES
  }

  push(chunk: Uint8Array): SplitItem[] {
    const out: SplitItem[] = []
    let buf = chunk
    if (this.#prefix !== null) {
      buf = concat([this.#prefix, chunk])
      this.#prefix = null
    }
    let pos = 0
    let textStart = 0
    /** Where the APC in progress starts in `buf` (its ESC), or -1 when it began in an earlier chunk. */
    let apcStart = -1
    /** Where the part of its body that lies in `buf` starts. */
    let bodyStart = 0

    if (this.#inApc && this.#bodyEsc && buf.length > 0) {
      this.#bodyEsc = false
      if (buf[0] === BACKSLASH) {
        this.#finishApc(out, EMPTY)
        pos = textStart = 1
      } else {
        // The held ESC aborts the APC; it is rescanned as the start of a new sequence.
        this.#abandonApc(out)
        buf = concat([LONE_ESC, buf])
      }
    }

    const length = buf.length
    while (pos < length) {
      if (!this.#inApc) {
        const esc = buf.indexOf(ESC, pos)
        if (esc < 0) break
        if (esc + 1 >= length || (buf[esc + 1] === UNDERSCORE && esc + 2 >= length)) {
          this.#text(out, buf.subarray(textStart, esc))
          this.#prefix = buf.slice(esc)
          return out
        }
        if (buf[esc + 1] !== UNDERSCORE) {
          pos = esc + 1
          continue
        }
        if (buf[esc + 2] !== G) {
          pos = esc + 2
          continue
        }
        // A kitty APC. The text before it is written when it completes (or at
        // the end of the chunk); if it is aborted, its bytes stay in that text.
        this.#inApc = true
        apcStart = esc
        pos = bodyStart = esc + 3
      } else {
        const esc = buf.indexOf(ESC, pos)
        const end = esc < 0 ? length : esc
        if (this.#bodyLength + (end - bodyStart) > this.#maxApcBytes) {
          this.#abandon(out, apcStart)
          pos = end
          continue
        }
        if (esc < 0 || esc + 1 >= length) {
          // The chunk ends inside the APC (perhaps on the ESC of its ST): keep its body.
          if (apcStart >= 0) this.#text(out, buf.subarray(textStart, apcStart))
          this.#keepBody(buf.slice(bodyStart, end))
          this.#bodyEsc = esc >= 0
          return out
        }
        if (buf[esc + 1] === BACKSLASH) {
          if (apcStart >= 0) this.#text(out, buf.subarray(textStart, apcStart))
          this.#finishApc(out, buf.subarray(bodyStart, esc))
          pos = textStart = esc + 2
        } else {
          this.#abandon(out, apcStart)
          pos = esc
        }
      }
    }
    if (this.#inApc) {
      // The chunk ended right after `ESC _ G` (or was empty, mid-APC).
      if (apcStart >= 0) this.#text(out, buf.subarray(textStart, apcStart))
      this.#keepBody(buf.slice(bodyStart))
      return out
    }
    this.#text(out, buf.subarray(textStart))
    return out
  }

  flush(): SplitItem[] {
    const out: SplitItem[] = []
    if (this.#inApc) {
      const trailing = this.#bodyEsc
      this.#abandonApc(out)
      if (trailing) this.#text(out, LONE_ESC)
    }
    if (this.#prefix !== null) {
      this.#text(out, this.#prefix)
      this.#prefix = null
    }
    return out
  }

  /** Appends text, merging with a preceding text item. */
  #text(out: SplitItem[], data: Uint8Array): void {
    if (data.length === 0) return
    const last = out[out.length - 1]
    if (last !== undefined && last.kind === 'text') last.data = concat([last.data, data])
    else out.push({ kind: 'text', data })
  }

  /** Completes the APC: its kept body plus `tail`, the rest of the body in this chunk. */
  #finishApc(out: SplitItem[], tail: Uint8Array): void {
    const body = latin1.decode(this.#body.length === 0 ? tail : concat([...this.#body, tail]))
    this.#resetApc()
    out.push({ kind: 'apc', command: parseKittyCommand(body) })
  }

  /** Keeps a copy of part of the APC body for the next chunk (the caller may reuse its buffer). */
  #keepBody(part: Uint8Array): void {
    if (part.length === 0) return
    this.#body.push(part)
    this.#bodyLength += part.length
  }

  /**
   * Gives up on the APC in progress inside `push`. One that began at
   * `apcStart` of this chunk is still in it, between `textStart` and the scan
   * position, so its bytes simply stay in the text run. One carried over from
   * earlier chunks (`apcStart` -1, the text run then starts at 0) is written
   * from its kept bytes.
   */
  #abandon(out: SplitItem[], apcStart: number): void {
    if (apcStart >= 0) this.#resetApc()
    else this.#abandonApc(out)
  }

  /** Gives up on the held APC: its bytes so far (`ESC _ G` + body) become text. */
  #abandonApc(out: SplitItem[]): void {
    const data = concat([HEADER, ...this.#body])
    this.#resetApc()
    this.#text(out, data)
  }

  #resetApc(): void {
    this.#inApc = false
    this.#body = []
    this.#bodyLength = 0
    this.#bodyEsc = false
  }
}

/** Creates a streaming kitty APC splitter (see `KittySplitter`). */
export function createSplitter(options: SplitterOptions = {}): ApcSplitter {
  return new KittySplitter(options)
}
