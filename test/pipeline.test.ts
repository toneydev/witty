// Ordering and routing in the output pipeline, with a scripted splitter, a
// slow fake engine and a fixed emitter.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { createPipeline } from '../src/pipeline.ts'
import type { ApcSplitter, EngineEvent, KittyCommand, KittyEngine, PlaceEmitter, SplitItem } from '../src/types.ts'

const enc = new TextEncoder()
const dec = new TextDecoder()

const text = (s: string): SplitItem => ({ kind: 'text', data: enc.encode(s) })
const apc = (id: number, extra: Record<string, string> = {}): SplitItem => ({
  kind: 'apc',
  command: { keys: { a: 'T', i: String(id), ...extra }, payload: '' },
})

/** A splitter that ignores its input and yields the next scripted batch per push. */
function scriptedSplitter(batches: SplitItem[][], tail: SplitItem[] = []): ApcSplitter {
  let n = 0
  return {
    push: () => batches[n++] ?? [],
    flush: () => tail,
  }
}

/** An engine that answers after `delay(command)` ms with a place and an OK response. */
function slowEngine(delay: (c: KittyCommand) => number, calls: string[] = []): KittyEngine {
  return {
    async handle(command) {
      const id = command.keys.i ?? '?'
      calls.push(`start ${id}`)
      await new Promise((r) => setTimeout(r, delay(command)))
      calls.push(`end ${id}`)
      if (command.keys.fail === '1') throw new Error(`boom ${id}`)
      const events: EngineEvent[] = [
        {
          kind: 'place',
          image: { width: 1, height: 1, data: new Uint8Array(4) },
          columns: 2,
          rows: 1,
          cursor: 'move',
          imageId: Number(id),
        },
        { kind: 'respond', data: `OK${id}` },
      ]
      if (command.keys.del === '1') events.push({ kind: 'delete', imageIds: [Number(id)] }, { kind: 'log', message: `note ${id}` })
      return events
    },
  }
}

const emitter: PlaceEmitter = (event, cell) => enc.encode(`[IMG${event.imageId} ${cell.width}x${cell.height}]`)

function setup(batches: SplitItem[][], delay: (c: KittyCommand) => number, tail: SplitItem[] = []) {
  const out: string[] = []
  const child: string[] = []
  const logs: string[] = []
  const calls: string[] = []
  let cell = { width: 10, height: 20 }
  const pipeline = createPipeline({
    splitter: scriptedSplitter(batches, tail),
    engine: slowEngine(delay, calls),
    emitter,
    cellSize: () => cell,
    writeOut: (bytes) => {
      out.push(dec.decode(bytes))
    },
    writeChild: (data) => child.push(data),
    log: (line) => logs.push(line),
  })
  return { pipeline, out, child, logs, calls, setCell: (c: typeof cell) => (cell = c) }
}

const chunk = new Uint8Array(0)

describe('pipeline', () => {
  it('writes text through synchronously when nothing is pending', async () => {
    const t = setup([[text('hello '), text('world')]], () => 0)
    const done = t.pipeline.feed(chunk)
    assert.deepEqual(t.out, ['hello ', 'world'])
    assert.equal(t.pipeline.pending, 0)
    await done
  })

  it('keeps text after a slow APC behind it, within one chunk', async () => {
    const t = setup([[text('A'), apc(1), text('B')]], () => 30)
    const done = t.pipeline.feed(chunk)
    assert.deepEqual(t.out, ['A'], 'B must wait for the image')
    await done
    assert.deepEqual(t.out, ['A', '[IMG1 10x20]', 'B'])
    assert.deepEqual(t.child, ['OK1'])
  })

  it('keeps later chunks behind an APC still being handled from an earlier chunk', async () => {
    const t = setup([[text('A'), apc(1)], [text('B'), apc(2), text('C')], [text('D')]], (c) => (c.keys.i === '1' ? 50 : 5))
    const p1 = t.pipeline.feed(chunk)
    const p2 = t.pipeline.feed(chunk)
    const p3 = t.pipeline.feed(chunk)
    assert.deepEqual(t.out, ['A'])
    await Promise.all([p1, p2, p3])
    assert.equal(t.out.join(''), 'A[IMG1 10x20]B[IMG2 10x20]CD')
    assert.deepEqual(t.child, ['OK1', 'OK2'])
    // handle() calls are serialised, never overlapping.
    assert.deepEqual(t.calls, ['start 1', 'end 1', 'start 2', 'end 2'])
  })

  it('preserves order with many interleaved APCs of random latency', async () => {
    const batches: SplitItem[][] = []
    let expected = ''
    for (let i = 0; i < 20; i++) {
      batches.push([text(`t${i};`), apc(i), text(`u${i};`)])
      expected += `t${i};[IMG${i} 10x20]u${i};`
    }
    const t = setup(batches, () => Math.floor(Math.random() * 8))
    const feeds: Promise<void>[] = []
    for (let i = 0; i < batches.length; i++) {
      feeds.push(t.pipeline.feed(chunk))
      if (i % 3 === 0) await new Promise((r) => setTimeout(r, 2))
    }
    await Promise.all(feeds)
    assert.equal(t.out.join(''), expected)
    assert.deepEqual(
      t.child,
      batches.map((_, i) => `OK${i}`),
    )
  })

  it('resumes writing text synchronously once the queue has drained', async () => {
    const t = setup([[apc(1)], [text('later')]], () => 5)
    await t.pipeline.feed(chunk)
    const done = t.pipeline.feed(chunk)
    assert.deepEqual(t.out, ['[IMG1 10x20]', 'later'])
    await done
  })

  it('reads the cell size at placement time', async () => {
    const t = setup([[apc(1)]], () => 10)
    const done = t.pipeline.feed(chunk)
    t.setCell({ width: 8, height: 16 })
    await done
    assert.deepEqual(t.out, ['[IMG1 8x16]'])
  })

  it('logs deletes, log events and engine failures, and keeps going', async () => {
    const t = setup([[apc(1, { del: '1' }), apc(2, { fail: '1' }), text('Z')]], () => 1)
    await t.pipeline.feed(chunk)
    assert.equal(t.out.join(''), '[IMG1 10x20]Z')
    assert.ok(t.logs.includes('delete images 1'), t.logs.join('\n'))
    assert.ok(t.logs.includes('note 1'))
    assert.ok(t.logs.some((l) => l.startsWith('engine error: boom 2')))
  })

  it('end() flushes held text after everything queued', async () => {
    const t = setup([[text('A'), apc(1)]], () => 20, [text('<held>')])
    void t.pipeline.feed(chunk)
    await t.pipeline.end()
    assert.equal(t.out.join(''), 'A[IMG1 10x20]<held>')
  })

  it('waits on a writeOut that applies backpressure, without dropping or reordering', async () => {
    const out: string[] = []
    let release: (() => void) | undefined
    const pipeline = createPipeline({
      splitter: scriptedSplitter([[text('1')], [text('2'), apc(5)], [text('3')]]),
      engine: slowEngine(() => 1),
      emitter,
      cellSize: () => ({ width: 1, height: 1 }),
      writeOut: (bytes) => {
        out.push(dec.decode(bytes))
        if (out.length === 1) return new Promise<void>((r) => (release = r))
        return undefined
      },
      writeChild: () => {},
    })
    void pipeline.feed(chunk)
    void pipeline.feed(chunk)
    const last = pipeline.feed(chunk)
    await new Promise((r) => setTimeout(r, 20))
    assert.deepEqual(out, ['1'], 'everything waits for the blocked write')
    release?.()
    await last
    assert.deepEqual(out, ['1', '2', '[IMG5 1x1]', '3'])
  })

  it('passes a chunk through as text if the splitter throws', async () => {
    const out: string[] = []
    const logs: string[] = []
    const pipeline = createPipeline({
      splitter: {
        push: () => {
          throw new Error('bad')
        },
        flush: () => [],
      },
      engine: slowEngine(() => 0),
      emitter,
      cellSize: () => ({ width: 1, height: 1 }),
      writeOut: (bytes) => {
        out.push(dec.decode(bytes))
      },
      writeChild: () => {},
      log: (l) => logs.push(l),
    })
    await pipeline.feed(enc.encode('raw'))
    assert.deepEqual(out, ['raw'])
    assert.deepEqual(logs, ['splitter error: bad'])
  })
})

describe('pipeline: unicode placeholders', () => {
  const PH = '\u{10EEEE}'
  // Row 0, columns 0 and 1 (U+0305 is 0, U+030D is 1 in kitty's diacritic table).
  const cells = `\x1b[38;5;42m${PH}\u{305}\u{305}${PH}\u{305}\u{30D}\x1b[0m`

  /** An engine that turns a=T,U=1 into a virtual placement of id 42 and a=d into a delete, after `ms`. */
  function placeholderEngine(ms: number): KittyEngine {
    return {
      async handle(command) {
        await new Promise((r) => setTimeout(r, ms))
        if (command.keys.slow !== undefined) await new Promise((r) => setTimeout(r, Number(command.keys.slow)))
        if (command.keys.a === 'd') return [{ kind: 'delete', imageIds: [42] }]
        if (command.keys.a === 'p') {
          const image = { width: 1, height: 1, data: new Uint8Array(4) }
          return [{ kind: 'place', image, columns: 1, rows: 1, cursor: 'move', imageId: 1 }]
        }
        const image = { width: 2, height: 1, data: Uint8Array.of(255, 0, 0, 255, 0, 0, 255, 255) }
        return [{ kind: 'virtual', imageId: 42, placementId: undefined, image, columns: 2, rows: 1 }]
      },
    }
  }

  function run(batches: SplitItem[][], tail: SplitItem[] = [], idleFlushMs?: number) {
    const out: string[] = []
    const logs: string[] = []
    const pipeline = createPipeline({
      ...(idleFlushMs === undefined ? {} : { idleFlushMs }),
      splitter: scriptedSplitter(batches, tail),
      engine: placeholderEngine(5),
      emitter,
      cellSize: () => ({ width: 4, height: 6 }),
      writeOut: (bytes) => {
        out.push(dec.decode(bytes))
      },
      writeChild: () => {},
      log: (line) => logs.push(line),
    })
    return { pipeline, out, logs }
  }

  const virtualApc: SplitItem = { kind: 'apc', command: { keys: { a: 'T', U: '1', i: '42', q: '2' }, payload: '' } }
  const deleteApc: SplitItem = { kind: 'apc', command: { keys: { a: 'd', d: 'I', i: '42' }, payload: '' } }

  it('draws placeholder cells of a virtual placement as sixel, in byte order', async () => {
    // Cells before the APC have no placement yet; the ones queued behind it do.
    // Markers in <> cannot occur inside sixel data.
    const t = run([[text(`<A>${cells}`), virtualApc, text(`<B>${cells}<C>`)], [text(`<D>${cells}`)]])
    const first = t.pipeline.feed(chunk)
    const second = t.pipeline.feed(chunk)
    await Promise.all([first, second])
    const all = t.out.join('')
    assert.ok(all.startsWith(`<A>${cells}<B>\x1b[38;5;42m\x1b7  \x1b8\x1bP`), JSON.stringify(all.slice(0, 80)))
    const [before, after] = all.split('<B>')
    assert.ok(before!.includes(PH), 'cells before the virtual placement pass through')
    assert.ok(!after!.includes(PH), 'no placeholder glyph after it')
    assert.equal(all.match(/\x1bP/g)?.length, 2)
    assert.ok(all.includes('\x1b8\x1b[2C\x1b[0m<C>'))
    assert.ok(all.includes('<D>\x1b[38;5;42m\x1b7  \x1b8\x1bP'))
    assert.ok(t.logs.some((l) => l.startsWith('virtual placement of image 42')), t.logs.join('\n'))
  })

  it('a delete makes later placeholder cells pass through', async () => {
    const t = run([[virtualApc, text(`<1>${cells}`), deleteApc, text(`<2>${cells}`)]])
    await t.pipeline.feed(chunk)
    const all = t.out.join('')
    const [one, two] = all.split('<2>')
    assert.ok(one!.includes('\x1bP') && !one!.includes(PH))
    assert.equal(two, cells)
  })

  it('end() writes a placeholder run still held by the pass', async () => {
    const open = `\x1b[38;5;42m${PH}\u{305}\u{305}${PH}\u{305}\u{30D}`
    const t = run([[virtualApc], [text(open)]])
    await t.pipeline.feed(chunk)
    await t.pipeline.feed(chunk)
    assert.equal(t.out.join(''), '\x1b[38;5;42m', 'the run may still get diacritics')
    await t.pipeline.end()
    assert.ok(t.out.join('').includes('\x1bP'))
  })

  // Row 0, columns 0 and 1, with no following byte: the pass holds it.
  const open = `\x1b[38;5;42m${PH}\u{305}\u{305}${PH}\u{305}\u{30D}`
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const placeApc = (slow: number): SplitItem => ({ kind: 'apc', command: { keys: { a: 'p', i: '1', slow: String(slow) }, payload: '' } })

  it('an idle flush draws a held run when the child goes quiet', async () => {
    const t = run([[virtualApc], [text(open)]])
    await t.pipeline.feed(chunk)
    await t.pipeline.feed(chunk)
    assert.equal(t.out.join(''), '\x1b[38;5;42m')
    await sleep(80) // default 25 ms
    const all = t.out.join('')
    assert.ok(all.startsWith('\x1b[38;5;42m\x1b7  \x1b8\x1bP'), JSON.stringify(all.slice(0, 40)))
    assert.ok(!all.includes(PH))
    assert.ok(t.logs.some((l) => l.includes('idle')), t.logs.join('\n'))
    await t.pipeline.end()
    assert.equal(t.out.join(''), all, 'nothing more at the end')
  })

  it('a chunk arriving before the idle timer cancels it; the run continues as one strip', async () => {
    const t = run([[virtualApc], [text(open)], [text(`${PH}\u{305}\u{30E}<x>`)]], [], 40)
    await t.pipeline.feed(chunk)
    await t.pipeline.feed(chunk)
    await sleep(15)
    await t.pipeline.feed(chunk)
    await sleep(80)
    const all = t.out.join('')
    assert.equal(all.match(/\x1b7/g)?.length, 1, 'one strip, not a flushed one plus another')
    assert.ok(all.includes('\x1b8\x1b[3C<x>'))
    assert.ok(!t.logs.some((l) => l.includes('idle')), t.logs.join('\n'))
  })

  it('a held run is written before a later APC, and idle flushes keep byte order around slow APCs', async () => {
    const t = run([[virtualApc], [text(`<a>${open}`), placeApc(40), text(`<b>${open}`)]], [], 10)
    await t.pipeline.feed(chunk)
    const done = t.pipeline.feed(chunk)
    await sleep(20) // the APC is in flight; the run before it is already out
    const early = t.out.join('')
    assert.equal(early.match(/\x1bP/g)?.length, 1, JSON.stringify(early))
    assert.ok(!early.includes('[IMG1'))
    await done
    await sleep(40) // the second run is held after the APC, then flushed when idle
    const all = t.out.join('')
    const order = ['<a>', '\x1bP', '[IMG1', '<b>'].map((m) => all.indexOf(m))
    assert.deepEqual([...order].sort((x, y) => x - y), order, JSON.stringify(all))
    assert.equal(all.match(/\x1bP/g)?.length, 2)
    assert.ok(all.lastIndexOf('\x1bP') > all.indexOf('<b>'))
    assert.ok(!all.includes(PH))
  })

  it('end() clears the idle timer', async () => {
    const t = run([[virtualApc], [text(open)]], [], 20)
    await t.pipeline.feed(chunk)
    await t.pipeline.feed(chunk)
    await t.pipeline.end()
    const atEnd = t.out.join('')
    await sleep(50)
    assert.equal(t.out.join(''), atEnd)
    assert.equal(atEnd.match(/\x1bP/g)?.length, 1)
    assert.ok(!t.logs.some((l) => l.includes('idle')))
  })
})
