import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deflateSync } from 'node:zlib'
import { PNG } from 'pngjs'
import { parseKittyCommand } from '../src/kitty/command.ts'
import { DEFAULT_MAX_IMAGES, DEFAULT_MAX_VIRTUAL_PLACEMENTS, createEngine } from '../src/kitty/engine.ts'
import type { EngineOptions } from '../src/kitty/engine.ts'
import type { EngineEvent, KittyEngine } from '../src/types.ts'

type Place = Extract<EngineEvent, { kind: 'place' }>

const b64 = (data: Uint8Array | string): string => Buffer.from(data).toString('base64')
const response = (body: string): string => `\x1b_G${body}\x1b\\`

function engine(options: Partial<EngineOptions> = {}): KittyEngine {
  return createEngine({ cellSize: () => ({ width: 10, height: 20 }), ...options })
}

/** Runs one command given as the APC body text (`keys;payload`). */
function send(e: KittyEngine, body: string): Promise<EngineEvent[]> {
  return e.handle(parseKittyCommand(body))
}

const kinds = (events: EngineEvent[]): string[] => events.filter((ev) => ev.kind !== 'log').map((ev) => ev.kind)
const places = (events: EngineEvent[]): Place[] => events.filter((ev): ev is Place => ev.kind === 'place')
const responses = (events: EngineEvent[]): string[] =>
  events.flatMap((ev) => (ev.kind === 'respond' ? [ev.data] : []))

/** A w×h RGBA image whose pixel (x,y) is [x, y, x+y, 255]. */
function gradient(w: number, h: number): Uint8Array {
  const data = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) data.set([x, y, x + y, 255], (y * w + x) * 4)
  }
  return data
}

function pngOf(w: number, h: number, data: Uint8Array): Uint8Array {
  const png = new PNG({ width: w, height: h })
  png.data = Buffer.from(data)
  return PNG.sync.write(png)
}

test('a=T with f=32 raw places the image with a cell-size box', async () => {
  const e = engine()
  const data = gradient(25, 30)
  const events = await send(e, `a=T,f=32,s=25,v=30,i=7;${b64(data)}`)
  assert.deepEqual(kinds(events), ['place', 'respond'])
  const [place] = places(events)
  assert.ok(place)
  assert.equal(place.imageId, 7)
  assert.equal(place.columns, 3) // ceil(25 / 10)
  assert.equal(place.rows, 2) // ceil(30 / 20)
  assert.equal(place.cursor, 'move')
  assert.deepEqual(place.image, { width: 25, height: 30, data })
  assert.deepEqual(responses(events), [response('i=7;OK')])
})

test('a=T with f=24 raw expands RGB to opaque RGBA', async () => {
  const e = engine()
  const rgb = Uint8Array.of(1, 2, 3, 4, 5, 6)
  const [place] = places(await send(e, `a=T,f=24,s=2,v=1;${b64(rgb)}`))
  assert.ok(place)
  assert.deepEqual([...place.image.data], [1, 2, 3, 255, 4, 5, 6, 255])
})

test('a=T with f=100 PNG', async () => {
  const e = engine()
  const data = gradient(12, 5)
  const events = await send(e, `a=T,f=100,i=3;${b64(pngOf(12, 5, data))}`)
  const [place] = places(events)
  assert.ok(place)
  assert.deepEqual(place.image, { width: 12, height: 5, data })
  assert.deepEqual(responses(events), [response('i=3;OK')])
})

test('PNG in palette, gray and 16-bit forms decodes to RGBA 8-bit', async () => {
  const e = engine()
  const data = gradient(4, 4)
  for (const [colorType, bitDepth] of [[0, 8], [4, 8], [2, 16], [6, 16]] as const) {
    const png = new PNG({ width: 4, height: 4, colorType, bitDepth, inputColorType: 6, inputHasAlpha: true })
    png.data = Buffer.from(data)
    const encoded = PNG.sync.write(png, { colorType, bitDepth, inputColorType: 6, inputHasAlpha: true })
    const [place] = places(await send(e, `a=T,f=100;${b64(encoded)}`))
    assert.ok(place, `colorType ${colorType} depth ${bitDepth}`)
    assert.equal(place.image.data.length, 4 * 4 * 4)
  }
})

test('a broken PNG answers EBADPNG', async () => {
  const e = engine()
  const notPng = await send(e, `a=T,f=100,i=4;${b64('not a png at all, really not')}`)
  assert.match(responses(notPng)[0] ?? '', /^\x1b_Gi=4;EBADPNG:/)
  const png = pngOf(4, 4, gradient(4, 4))
  const truncated = await send(e, `a=T,f=100,i=4;${b64(png.subarray(0, 40))}`)
  assert.match(responses(truncated)[0] ?? '', /^\x1b_Gi=4;EBADPNG:/)
  assert.deepEqual(places(truncated), [])
})

test('o=z inflates before decoding (raw and PNG)', async () => {
  const e = engine()
  const data = gradient(3, 2)
  const [raw] = places(await send(e, `a=T,f=32,s=3,v=2,o=z;${b64(deflateSync(data))}`))
  assert.deepEqual(raw?.image.data, data)
  const [png] = places(await send(e, `a=T,f=100,o=z;${b64(deflateSync(pngOf(3, 2, data)))}`))
  assert.deepEqual(png?.image.data, data)
  const bad = await send(e, `a=T,f=32,s=3,v=2,o=z,i=1;${b64('garbage')}`)
  assert.match(responses(bad)[0] ?? '', /^\x1b_Gi=1;EINVAL:/)
})

test('chunked transmission across three commands', async () => {
  const e = engine()
  const data = gradient(8, 8)
  const text = b64(data)
  const parts = [text.slice(0, 100), text.slice(100, 200), text.slice(200)]
  assert.deepEqual(await send(e, `a=T,f=32,s=8,v=8,i=9,m=1;${parts[0]}`), [])
  assert.deepEqual(await send(e, `m=1;${parts[1]}`), [])
  const events = await send(e, `m=0;${parts[2]}`)
  const [place] = places(events)
  assert.deepEqual(place?.image.data, data)
  assert.equal(place?.imageId, 9)
  assert.deepEqual(responses(events), [response('i=9;OK')])
})

test('chunked: final chunk without m, quiet from a later chunk', async () => {
  const e = engine()
  const text = b64(gradient(2, 2))
  await send(e, `a=t,f=32,s=2,v=2,i=2,m=1;${text.slice(0, 8)}`)
  const events = await send(e, `q=1;${text.slice(8)}`)
  assert.deepEqual(responses(events), [])
  assert.deepEqual(kinds(await send(e, 'a=p,i=2')), ['place', 'respond'])
})

test('chunked: over the payload limit answers EFBIG once, at the end', async () => {
  const e = engine({ maxPayloadBytes: 16 })
  assert.deepEqual(await send(e, `a=T,f=32,s=4,v=4,i=5,m=1;${'A'.repeat(12)}`), [])
  assert.deepEqual(await send(e, `m=1;${'A'.repeat(12)}`), [])
  const events = await send(e, `m=0;${'A'.repeat(12)}`)
  assert.deepEqual(responses(events), [response('i=5;EFBIG:payload too large')], 'a fixed message, no sizes')
  assert.deepEqual(places(events), [])
})

test('a delete aborts a partial chunked upload', async () => {
  const e = engine()
  await send(e, `a=T,f=32,s=1,v=1,i=1,m=1;AAAA`)
  await send(e, 'a=d,d=A')
  // The next command is a fresh one, not a continuation.
  const events = await send(e, `a=T,f=32,s=1,v=1,i=2;${b64(Uint8Array.of(1, 2, 3, 4))}`)
  assert.equal(places(events)[0]?.imageId, 2)
})

test('a=t stores without placing; a=p places it later', async () => {
  const e = engine()
  const data = gradient(10, 20)
  const stored = await send(e, `a=t,f=32,s=10,v=20,i=11;${b64(data)}`)
  assert.deepEqual(kinds(stored), ['respond'])
  assert.deepEqual(responses(stored), [response('i=11;OK')])
  const put = await send(e, 'a=p,i=11,p=4')
  assert.deepEqual(kinds(put), ['place', 'respond'])
  assert.deepEqual(places(put)[0]?.image.data, data)
  assert.deepEqual(responses(put), [response('i=11,p=4;OK')])
})

test('a=p for a missing image answers ENOENT', async () => {
  const e = engine()
  const events = await send(e, 'a=p,i=99')
  assert.deepEqual(places(events), [])
  assert.match(responses(events)[0] ?? '', /^\x1b_Gi=99;ENOENT:/)
})

test('image numbers: I allocates an id, a=p by I uses the newest', async () => {
  const e = engine()
  const first = responses(await send(e, `a=t,f=32,s=1,v=1,I=13;${b64(Uint8Array.of(1, 1, 1, 255))}`))[0] ?? ''
  const second = responses(await send(e, `a=t,f=32,s=1,v=1,I=13;${b64(Uint8Array.of(2, 2, 2, 255))}`))[0] ?? ''
  const id1 = Number(/^\x1b_Gi=(\d+),I=13;OK\x1b\\$/.exec(first)?.[1])
  const id2 = Number(/^\x1b_Gi=(\d+),I=13;OK\x1b\\$/.exec(second)?.[1])
  assert.ok(id1 > 0 && id2 > 0 && id1 !== id2)
  const put = await send(e, 'a=p,I=13')
  assert.equal(places(put)[0]?.imageId, id2)
  assert.deepEqual([...(places(put)[0]?.image.data ?? [])], [2, 2, 2, 255])
  assert.deepEqual(responses(put), [response(`i=${id2},I=13;OK`)])
})

test('i and I together answer EINVAL', async () => {
  const e = engine()
  const events = await send(e, `a=T,f=32,s=1,v=1,i=1,I=2;${b64(Uint8Array.of(1, 2, 3, 4))}`)
  assert.deepEqual(places(events), [])
  assert.match(responses(events)[0] ?? '', /^\x1b_Gi=1,I=2;EINVAL:/)
})

test('a=q validates but never stores or places', async () => {
  const e = engine()
  const ok = await send(e, `a=q,f=32,s=1,v=1,i=31;${b64(Uint8Array.of(1, 2, 3, 4))}`)
  assert.deepEqual(kinds(ok), ['respond'])
  assert.deepEqual(responses(ok), [response('i=31;OK')])
  assert.match(responses(await send(e, 'a=p,i=31'))[0] ?? '', /ENOENT/)

  const bad = await send(e, `a=q,f=32,s=2,v=2,i=31;${b64(Uint8Array.of(1, 2, 3, 4))}`)
  assert.match(responses(bad)[0] ?? '', /^\x1b_Gi=31;ENODATA:/)
  const png = await send(e, `a=q,f=100,i=31;${b64('nope')}`)
  assert.match(responses(png)[0] ?? '', /^\x1b_Gi=31;EBADPNG:/)
})

test('a=q does not replace an existing image with the same id', async () => {
  const e = engine()
  await send(e, `a=t,f=32,s=1,v=1,i=1;${b64(Uint8Array.of(9, 9, 9, 255))}`)
  await send(e, `a=q,f=32,s=1,v=1,i=1;${b64(Uint8Array.of(1, 1, 1, 255))}`)
  assert.deepEqual([...(places(await send(e, 'a=p,i=1'))[0]?.image.data ?? [])], [9, 9, 9, 255])
})

test('responses only when i or I is given', async () => {
  const e = engine()
  const pixel = b64(Uint8Array.of(1, 2, 3, 4))
  assert.deepEqual(kinds(await send(e, `a=T,f=32,s=1,v=1;${pixel}`)), ['place'])
  assert.deepEqual(kinds(await send(e, `a=t,f=32,s=1,v=1;${pixel}`)), [])
  assert.deepEqual(kinds(await send(e, `a=T,f=100;${b64('junk')}`)), [])
  assert.deepEqual(kinds(await send(e, `a=q,f=32,s=1,v=1;${pixel}`)), [])
})

test('quiet modes: q=1 drops OK only, q=2 drops everything', async () => {
  const e = engine()
  const pixel = b64(Uint8Array.of(1, 2, 3, 4))
  assert.deepEqual(kinds(await send(e, `a=T,f=32,s=1,v=1,i=1,q=1;${pixel}`)), ['place'])
  assert.match(responses(await send(e, 'a=p,i=404,q=1'))[0] ?? '', /ENOENT/)
  assert.deepEqual(kinds(await send(e, `a=T,f=32,s=1,v=1,i=2,q=2;${pixel}`)), ['place'])
  assert.deepEqual(kinds(await send(e, 'a=p,i=404,q=2')), [])
})

test('transmitting with an existing i replaces the image', async () => {
  const e = engine()
  await send(e, `a=t,f=32,s=1,v=1,i=1;${b64(Uint8Array.of(1, 1, 1, 255))}`)
  await send(e, `a=t,f=32,s=1,v=1,i=1;${b64(Uint8Array.of(2, 2, 2, 255))}`)
  assert.deepEqual([...(places(await send(e, 'a=p,i=1'))[0]?.image.data ?? [])], [2, 2, 2, 255])
  // Replacing a placed image removes its placements first, as kitty does.
  const again = await send(e, `a=T,f=32,s=1,v=1,i=1;${b64(Uint8Array.of(3, 3, 3, 255))}`)
  assert.deepEqual(kinds(again), ['delete', 'place', 'respond'])
})

test('deletes: d=i keeps data, d=I frees it, d=a/d=A', async () => {
  const e = engine()
  const pixel = b64(Uint8Array.of(1, 2, 3, 4))
  await send(e, `a=T,f=32,s=1,v=1,i=1;${pixel}`)
  await send(e, `a=T,f=32,s=1,v=1,i=2;${pixel}`)

  assert.deepEqual(await send(e, 'a=d,d=i,i=1'), [{ kind: 'delete', imageIds: [1] }])
  assert.deepEqual(kinds(await send(e, 'a=p,i=1')), ['place', 'respond'])
  assert.deepEqual(await send(e, 'a=d,d=I,i=1'), [{ kind: 'delete', imageIds: [1] }])
  assert.match(responses(await send(e, 'a=p,i=1'))[0] ?? '', /ENOENT/)

  assert.deepEqual(await send(e, 'a=d'), [{ kind: 'delete', imageIds: [2] }])
  assert.deepEqual(kinds(await send(e, 'a=p,i=2')), ['place', 'respond'])
  assert.deepEqual(await send(e, 'a=d,d=A'), [{ kind: 'delete', imageIds: [2] }])
  assert.match(responses(await send(e, 'a=p,i=2'))[0] ?? '', /ENOENT/)
})

test('deletes: d=I with p frees only when no placement is left', async () => {
  const e = engine()
  await send(e, `a=t,f=32,s=1,v=1,i=1;${b64(Uint8Array.of(1, 2, 3, 4))}`)
  await send(e, 'a=p,i=1,p=1')
  await send(e, 'a=p,i=1,p=2')
  await send(e, 'a=d,d=I,i=1,p=1')
  assert.deepEqual(kinds(await send(e, 'a=p,i=1,p=3')), ['place', 'respond'])
  await send(e, 'a=d,d=I,i=1,p=2')
  await send(e, 'a=d,d=I,i=1,p=3')
  assert.match(responses(await send(e, 'a=p,i=1'))[0] ?? '', /ENOENT/)
})

test('deletes: d=n/N by number, d=r by id range', async () => {
  const e = engine()
  const pixel = b64(Uint8Array.of(1, 2, 3, 4))
  const reply = responses(await send(e, `a=T,f=32,s=1,v=1,I=5;${pixel}`))[0] ?? ''
  const id = Number(/i=(\d+)/.exec(reply)?.[1])
  assert.deepEqual(await send(e, 'a=d,d=N,I=5'), [{ kind: 'delete', imageIds: [id] }])
  assert.match(responses(await send(e, 'a=p,I=5'))[0] ?? '', /ENOENT/)

  await send(e, `a=t,f=32,s=1,v=1,i=10;${pixel}`)
  await send(e, `a=t,f=32,s=1,v=1,i=11;${pixel}`)
  await send(e, `a=t,f=32,s=1,v=1,i=20;${pixel}`)
  assert.deepEqual(await send(e, 'a=d,d=R,x=10,y=15'), [{ kind: 'delete', imageIds: [10, 11] }])
  assert.match(responses(await send(e, 'a=p,i=11'))[0] ?? '', /ENOENT/)
  assert.deepEqual(kinds(await send(e, 'a=p,i=20')), ['place', 'respond'])
})

test('deletes by position are logged, not errors', async () => {
  const e = engine()
  for (const d of ['c', 'C', 'p', 'x', 'Y', 'z', 'q']) {
    const events = await send(e, `a=d,d=${d},i=1,x=1,y=1`)
    assert.deepEqual(kinds(events), [], `d=${d}`)
    assert.equal(events[0]?.kind, 'log')
  }
})

test('animation actions and unknown actions answer EINVAL', async () => {
  const e = engine()
  for (const a of ['f', 'a', 'c', 'Z']) {
    assert.match(responses(await send(e, `a=${a},i=1`))[0] ?? '', /^\x1b_Gi=1;EINVAL:/, `a=${a}`)
  }
})

test('t=f reads through readFile, honoring O and S', async () => {
  const data = gradient(2, 2)
  const file = new Uint8Array([7, 7, 7, ...data, 9, 9])
  const read: string[] = []
  const e = engine({
    readFile: async (path) => {
      read.push(path)
      return file
    },
  })
  const events = await send(e, `a=T,t=f,f=32,s=2,v=2,O=3,S=${data.length},i=1;${b64('/tmp/image.rgba')}`)
  assert.deepEqual(read, ['/tmp/image.rgba'])
  assert.deepEqual(places(events)[0]?.image.data, data)
  assert.deepEqual(responses(events), [response('i=1;OK')])
})

test('t=f failures and t=f without readFile', async () => {
  const failing = engine({
    readFile: async () => {
      throw new Error('nope')
    },
  })
  assert.match(responses(await send(failing, `a=T,t=f,i=1;${b64('/x')}`))[0] ?? '', /^\x1b_Gi=1;EBADF:/)
  assert.match(responses(await send(engine(), `a=T,t=f,i=1;${b64('/x')}`))[0] ?? '', /^\x1b_Gi=1;EINVAL:/)
  assert.match(responses(await send(engine(), `a=T,t=s,i=1;${b64('/x')}`))[0] ?? '', /^\x1b_Gi=1;EINVAL:/)
})

test('t=t deletes the file only when the path names tty-graphics-protocol', async () => {
  const deleted: string[] = []
  const png = pngOf(1, 1, Uint8Array.of(1, 2, 3, 255))
  const e = engine({
    readFile: async () => png,
    deleteFile: async (path) => {
      deleted.push(path)
    },
  })
  await send(e, `a=T,t=t,f=100;${b64('/tmp/tty-graphics-protocol-abc.png')}`)
  await send(e, `a=T,t=t,f=100;${b64('/home/me/precious.png')}`)
  await send(e, `a=T,t=f,f=100;${b64('/tmp/tty-graphics-protocol-def.png')}`)
  assert.deepEqual(deleted, ['/tmp/tty-graphics-protocol-abc.png'])
})

test('source rectangle x,y,w,h crops the image', async () => {
  const e = engine()
  await send(e, `a=t,f=32,s=6,v=5,i=1;${b64(gradient(6, 5))}`)
  const [place] = places(await send(e, 'a=p,i=1,x=2,y=1,w=3,h=2'))
  assert.ok(place)
  assert.equal(place.image.width, 3)
  assert.equal(place.image.height, 2)
  // pixel (0,0) of the crop is (2,1) of the source; (2,1) of the crop is (4,2).
  assert.deepEqual([...place.image.data.subarray(0, 4)], [2, 1, 3, 255])
  assert.deepEqual([...place.image.data.subarray((1 * 3 + 2) * 4, (1 * 3 + 2) * 4 + 4)], [4, 2, 6, 255])

  // A rectangle past the edge is clipped to the image.
  const [clipped] = places(await send(e, 'a=p,i=1,x=4,y=3,w=100,h=100'))
  assert.equal(clipped?.image.width, 2)
  assert.equal(clipped?.image.height, 2)

  assert.match(responses(await send(e, 'a=p,i=1,x=6'))[0] ?? '', /^\x1b_Gi=1;EINVAL:/)
})

test('c/r give the box; one of them alone keeps the aspect ratio', async () => {
  const cell = { width: 10, height: 20 }
  const e = engine({ cellSize: () => cell })
  await send(e, `a=t,f=32,s=40,v=40,i=1;${b64(gradient(40, 40))}`)
  const box = (events: EngineEvent[]): [number, number] => {
    const [place] = places(events)
    return [place?.columns ?? -1, place?.rows ?? -1]
  }
  assert.deepEqual(box(await send(e, 'a=p,i=1,c=7,r=3')), [7, 3])
  assert.deepEqual(box(await send(e, 'a=p,i=1')), [4, 2])
  assert.deepEqual(box(await send(e, 'a=p,i=1,c=8')), [8, 4]) // 80px wide → 80px tall → 4 rows
  assert.deepEqual(box(await send(e, 'a=p,i=1,r=2')), [4, 2]) // 40px tall → 40px wide → 4 columns
  // The cell size is read at placement time.
  cell.width = 8
  cell.height = 16
  assert.deepEqual(box(await send(e, 'a=p,i=1')), [5, 3])
})

test('cursor policy: C=1 stays, otherwise moves', async () => {
  const e = engine()
  await send(e, `a=t,f=32,s=1,v=1,i=1;${b64(Uint8Array.of(1, 2, 3, 4))}`)
  assert.equal(places(await send(e, 'a=p,i=1,C=1'))[0]?.cursor, 'stay')
  assert.equal(places(await send(e, 'a=p,i=1,C=0'))[0]?.cursor, 'move')
  assert.equal(places(await send(e, 'a=p,i=1'))[0]?.cursor, 'move')
})

test('U=1 makes a virtual placement, never a place; ignored keys are logged once', async () => {
  const e = engine()
  await send(e, `a=t,f=32,s=1,v=1,i=1;${b64(Uint8Array.of(1, 2, 3, 4))}`)
  const unicode = await send(e, 'a=p,i=1,U=1')
  assert.deepEqual(kinds(unicode), ['virtual', 'respond'])
  assert.deepEqual(responses(unicode), [response('i=1;OK')])

  const first = await send(e, 'a=p,i=1,z=-1')
  assert.equal(first.filter((ev) => ev.kind === 'log').length, 1)
  const second = await send(e, 'a=p,i=1,z=-1')
  assert.equal(second.filter((ev) => ev.kind === 'log').length, 0)
})

test('size limits answer EFBIG', async () => {
  const e = engine({ maxImageBytes: 1024, maxPayloadBytes: 64 })
  const big = await send(e, `a=T,f=32,s=100,v=100,i=1;${b64(new Uint8Array(8))}`)
  assert.match(responses(big)[0] ?? '', /^\x1b_Gi=1;EFBIG:/)
  const long = await send(e, `a=T,f=32,s=1,v=1,i=1;${'A'.repeat(100)}`)
  assert.match(responses(long)[0] ?? '', /^\x1b_Gi=1;EFBIG:/)
  const bomb = await send(e, `a=T,f=32,s=10,v=10,o=z,i=1;${b64(deflateSync(new Uint8Array(100_000)))}`)
  assert.match(responses(bomb)[0] ?? '', /^\x1b_Gi=1;EFBIG:/)
  const pngBig = await send(e, `a=T,f=100,i=1;${b64(pngOf(40, 40, gradient(40, 40)))}`)
  assert.match(responses(pngBig)[0] ?? '', /^\x1b_Gi=1;EFBIG:/)
})

test('stored images are bounded: least recently used are evicted', async () => {
  const e = engine({ maxStoreBytes: 3 * 400 })
  const image = b64(gradient(10, 10)) // 400 bytes of RGBA
  for (const i of [1, 2, 3]) await send(e, `a=t,f=32,s=10,v=10,i=${i};${image}`)
  await send(e, 'a=p,i=1') // touch 1: now 2 is the oldest
  await send(e, `a=t,f=32,s=10,v=10,i=4;${image}`)
  assert.match(responses(await send(e, 'a=p,i=2'))[0] ?? '', /ENOENT/)
  for (const i of [1, 3, 4]) assert.deepEqual(kinds(await send(e, `a=p,i=${i}`)), ['place', 'respond'], `i=${i}`)
})

// Unicode placeholders: virtual placements (U=1).

type Virtual = Extract<EngineEvent, { kind: 'virtual' }>
const virtuals = (events: EngineEvent[]): Virtual[] => events.filter((ev): ev is Virtual => ev.kind === 'virtual')

test('U=1 with a=T stores a virtual placement with the c x r box, as Claude Code sends it', async () => {
  const e = engine()
  const data = gradient(8, 4)
  const events = await send(e, `a=T,U=1,q=2,f=32,s=8,v=4,i=8605545,c=8,r=2;${b64(data)}`)
  assert.deepEqual(kinds(events), ['virtual'])
  assert.deepEqual(places(events), [])
  assert.deepEqual(virtuals(events), [
    { kind: 'virtual', imageId: 8605545, placementId: undefined, image: { width: 8, height: 4, data }, columns: 8, rows: 2 },
  ])
})

test('U=1 box: missing c or r follows the aspect ratio, neither is the size in cells; p names the placement', async () => {
  const e = engine()
  await send(e, `a=t,f=32,s=20,v=40,i=3;${b64(gradient(20, 40))}`)
  const [onlyC] = virtuals(await send(e, 'a=p,i=3,U=1,c=4'))
  assert.deepEqual([onlyC?.columns, onlyC?.rows], [4, 4]) // 4*10*40/20/20
  const [onlyR] = virtuals(await send(e, 'a=p,i=3,U=1,r=1'))
  assert.deepEqual([onlyR?.columns, onlyR?.rows], [1, 1])
  const [neither] = virtuals(await send(e, 'a=p,i=3,U=1'))
  assert.deepEqual([neither?.columns, neither?.rows], [2, 2])
  const named = await send(e, 'a=p,i=3,U=1,p=5,c=3,r=3')
  assert.equal(virtuals(named)[0]?.placementId, 5)
  assert.deepEqual(responses(named), [response('i=3,p=5;OK')])
  const cropped = virtuals(await send(e, 'a=p,i=3,U=1,x=2,y=4,w=6,h=8'))[0]
  assert.deepEqual(cropped?.source, { x: 2, y: 4, width: 6, height: 8 })
  assert.deepEqual([cropped?.image.width, cropped?.image.height], [20, 40], 'the stored image, not a crop')
})

test('U=1 errors answer as a put would', async () => {
  const e = engine()
  assert.match(responses(await send(e, 'a=p,i=99,U=1'))[0] ?? '', /ENOENT/)
  await send(e, `a=t,f=32,s=2,v=2,i=4;${b64(gradient(2, 2))}`)
  const outside = await send(e, 'a=p,i=4,U=1,x=5')
  assert.deepEqual(virtuals(outside), [])
  assert.match(responses(outside)[0] ?? '', /^\x1b_Gi=4;EINVAL:/)
})

test('deletes drop virtual placements: d=i all, d=i with p only that one; d=a keeps them', async () => {
  const e = engine()
  await send(e, `a=t,f=32,s=1,v=1,i=1;${b64(Uint8Array.of(1, 2, 3, 4))}`)
  await send(e, 'a=p,i=1,U=1,p=5')
  await send(e, 'a=p,i=1,U=1,p=6')
  assert.deepEqual(await send(e, 'a=d,d=i,i=1,p=5'), [
    { kind: 'delete', imageIds: [1], virtual: [{ imageId: 1, placementId: 5 }] },
  ])
  // d=a/d=A leave virtual placements alone and do not free an image they use.
  assert.deepEqual(await send(e, 'a=d,d=A'), [{ kind: 'delete', imageIds: [] }])
  assert.deepEqual(kinds(await send(e, 'a=p,i=1')), ['place', 'respond'])
  assert.deepEqual(await send(e, 'a=d,d=a'), [{ kind: 'delete', imageIds: [1], virtual: [] }])
  // d=I removes the last one (absent `virtual`: all of them) and frees the image.
  assert.deepEqual(await send(e, 'a=d,d=I,i=1'), [{ kind: 'delete', imageIds: [1] }])
  assert.match(responses(await send(e, 'a=p,i=1'))[0] ?? '', /ENOENT/)
})

test('replacing an image re-emits its virtual placements with the new pixels', async () => {
  const e = engine()
  await send(e, `a=T,U=1,q=2,f=32,s=1,v=1,i=7,c=2,r=1;${b64(Uint8Array.of(1, 1, 1, 255))}`)
  await send(e, 'a=p,i=7,U=1,p=3,c=4,r=4,q=2')
  const events = await send(e, `a=t,f=32,s=1,v=1,i=7,q=2;${b64(Uint8Array.of(2, 2, 2, 255))}`)
  assert.deepEqual(kinds(events), ['delete', 'virtual', 'virtual'])
  assert.deepEqual(
    virtuals(events).map((v) => [v.placementId, v.columns, v.rows, [...v.image.data]]),
    [
      [undefined, 2, 1, [2, 2, 2, 255]],
      [3, 4, 4, [2, 2, 2, 255]],
    ],
  )
})

test('evicting an image with virtual placements reports a delete', async () => {
  const e = engine({ maxStoreBytes: 2 * 400 })
  const image = b64(gradient(10, 10))
  await send(e, `a=T,U=1,f=32,s=10,v=10,i=1,q=2;${image}`)
  await send(e, `a=t,f=32,s=10,v=10,i=2,q=2;${image}`)
  const events = await send(e, `a=t,f=32,s=10,v=10,i=3,q=2;${image}`)
  assert.deepEqual(kinds(events), ['delete'])
  assert.deepEqual(events.find((ev) => ev.kind === 'delete'), { kind: 'delete', imageIds: [1] })
})

// Hardening against untrusted child output.

test('placement boxes over 1024 cells on a side answer EINVAL, given or derived', async () => {
  const e = engine()
  await send(e, `a=t,f=32,s=1,v=1,i=1;${b64(Uint8Array.of(1, 2, 3, 255))}`)
  for (const keys of ['c=5000', 'r=5000', 'c=1025,r=1', 'c=5000,U=1', 'r=1025,U=1']) {
    const events = await send(e, `a=p,i=1,${keys}`)
    assert.deepEqual(kinds(events), ['respond'], keys)
    assert.equal(responses(events)[0], response('i=1;EINVAL:placement too large'), keys)
  }
  assert.deepEqual(kinds(await send(e, 'a=p,i=1,c=1000,r=1000')), ['place', 'respond'])
  assert.deepEqual(kinds(await send(e, 'a=p,i=1,c=1024,r=1024,U=1')), ['virtual', 'respond'])
  // Derived from the aspect ratio: 1x4000 pixels at c=1 is 2000 rows of 20 px.
  await send(e, `a=t,f=32,s=1,v=4000,i=2;${b64(new Uint8Array(4 * 4000))}`)
  assert.equal(responses(await send(e, 'a=p,i=2,c=1'))[0], response('i=2;EINVAL:placement too large'))
  // Derived from the size in cells: 20000 px wide is 2000 columns of 10 px.
  const wide = await send(e, `a=T,f=32,s=20000,v=1,i=3;${b64(new Uint8Array(4 * 20000))}`)
  assert.equal(responses(wide)[0], response('i=3;EINVAL:placement too large'))
})

test('attacker-controlled values never reach a response or a message', async () => {
  const e = engine()
  const value = 'x\x18\r\n\x7f;\\\x1b'
  const cases: Array<[Record<string, string>, string]> = [
    [{ a: 'T', i: '1', f: value }, 'EINVAL:unsupported format'],
    [{ a: 'T', i: '1', o: value }, 'EINVAL:unsupported compression'],
    [{ a: 'T', i: '1', t: value }, 'EINVAL:unsupported transmission medium'],
    [{ a: value, i: '1' }, 'EINVAL:unknown action'],
    [{ a: 'f', i: '1' }, 'EINVAL:animation is not supported'],
    [{ a: 'T', i: '1', s: value }, 'EINVAL:invalid value for key s'],
  ]
  for (const [keys, status] of cases) {
    const events = await e.handle({ keys, payload: '' })
    assert.deepEqual(responses(events), [response(`i=1;${status}`)], JSON.stringify(keys))
    for (const ev of events) {
      const text = ev.kind === 'respond' ? ev.data.slice(3, -2) : ev.kind === 'log' ? ev.message : ''
      assert.ok(!/[\x00-\x1f\x7f]/.test(text), `${ev.kind}: ${JSON.stringify(text)}`)
      assert.ok(!text.includes('x?'), `${ev.kind} echoes the value: ${JSON.stringify(text)}`)
    }
  }
  // pngjs errors (which can quote chunk bytes) all become one fixed message.
  const png = pngOf(4, 4, gradient(4, 4))
  const broken = Uint8Array.from(png)
  broken[40] = 0xff
  broken[41] = 0xfe
  const events = await send(e, `a=T,f=100,i=4;${b64(broken.subarray(0, 60))}`)
  assert.deepEqual(responses(events), [response('i=4;EBADPNG:invalid PNG')])
})

// Bounded memory: virtual placements share the stored image, and every
// per-command structure has a bound.

test('virtual placements share the stored image: a source rectangle, not a copy', async () => {
  const e = engine()
  await send(e, `a=t,f=32,s=64,v=64,i=7,q=2;${b64(gradient(64, 64))}`)
  const events: Virtual[] = []
  for (let p = 1; p <= 8; p++) events.push(...virtuals(await send(e, `a=p,U=1,i=7,p=${p},x=1,c=10,r=10,q=2`)))
  assert.equal(events.length, 8)
  for (const v of events) {
    assert.equal(v.image, events[0]!.image, 'the same object, not a crop per placement')
    assert.deepEqual(v.source, { x: 1, y: 0, width: 63, height: 64 })
  }
  assert.deepEqual([events[0]!.image.width, events[0]!.image.height], [64, 64])
  // The whole image needs no rectangle; a normal placement still gets its crop.
  assert.equal(virtuals(await send(e, 'a=p,U=1,i=7,p=9,q=2'))[0]?.source, undefined)
  assert.deepEqual([...(places(await send(e, 'a=p,i=7,x=1,y=2,w=1,h=1,q=2'))[0]?.image.data ?? [])], [1, 2, 3, 255])
})

test('virtual placements are bounded: past the bound the oldest is dropped with a delete', async () => {
  const e = engine({ maxVirtualPlacements: 3 })
  await send(e, `a=t,f=32,s=1,v=1,i=1,q=2;${b64(Uint8Array.of(1, 2, 3, 255))}`)
  await send(e, `a=t,f=32,s=1,v=1,i=2,q=2;${b64(Uint8Array.of(1, 2, 3, 255))}`)
  for (const p of [1, 2]) assert.deepEqual(kinds(await send(e, `a=p,U=1,i=1,p=${p},q=2`)), ['virtual'])
  assert.deepEqual(kinds(await send(e, 'a=p,U=1,i=2,q=2')), ['virtual'])
  // Replacing an existing one does not count as a new one.
  assert.deepEqual(kinds(await send(e, 'a=p,U=1,i=1,p=2,c=3,q=2')), ['virtual'])
  const events = await send(e, 'a=p,U=1,i=1,p=3,q=2')
  assert.deepEqual(kinds(events), ['delete', 'virtual'])
  assert.deepEqual(events.find((ev) => ev.kind === 'delete'), {
    kind: 'delete',
    imageIds: [1],
    virtual: [{ imageId: 1, placementId: 1 }],
  })
  assert.ok(events.some((ev) => ev.kind === 'log' && ev.message.includes('virtual placement 1 of image 1 dropped')))
  // Next oldest: image 2's only one (then "absent" says all of image 2's are gone).
  assert.deepEqual(
    (await send(e, 'a=p,U=1,i=1,p=4,q=2')).find((ev) => ev.kind === 'delete'),
    { kind: 'delete', imageIds: [2] },
  )
  // Deleting frees a slot.
  await send(e, 'a=d,d=i,i=1,p=3')
  assert.deepEqual(kinds(await send(e, 'a=p,U=1,i=1,p=5,q=2')), ['virtual'])
})

test('the default bound on virtual placements holds against a flood of puts', async () => {
  const e = engine()
  await send(e, `a=t,f=32,s=4,v=4,i=7,q=2;${b64(gradient(4, 4))}`)
  let dropped = 0
  for (let p = 1; p <= DEFAULT_MAX_VIRTUAL_PLACEMENTS + 10; p++) {
    for (const ev of await send(e, `a=p,U=1,i=7,p=${p},x=1,c=10,r=10,q=2`)) if (ev.kind === 'delete') dropped++
  }
  assert.equal(dropped, 10)
})

test('the number of stored images is bounded: past it the least recently used is evicted', async () => {
  const e = engine({ maxImages: 3 })
  const pixel = b64(Uint8Array.of(1, 2, 3, 255))
  await send(e, `a=T,U=1,f=32,s=1,v=1,i=1,q=2;${pixel}`)
  for (const i of [2, 3]) await send(e, `a=t,f=32,s=1,v=1,i=${i},q=2;${pixel}`)
  await send(e, 'a=p,i=2,q=2') // touch 2: 1 is the oldest, then 3
  const events = await send(e, `a=t,f=32,s=1,v=1,i=4,q=2;${pixel}`)
  // Image 1 had a virtual placement: its placeholders show nothing from now on.
  assert.deepEqual(events.find((ev) => ev.kind === 'delete'), { kind: 'delete', imageIds: [1] })
  assert.match(responses(await send(e, 'a=p,i=1'))[0] ?? '', /ENOENT/)
  for (const i of [2, 3, 4]) assert.deepEqual(kinds(await send(e, `a=p,i=${i}`)), ['place', 'respond'], `i=${i}`)
  // The default bound.
  const d = engine()
  for (let i = 1; i <= DEFAULT_MAX_IMAGES + 1; i++) await send(d, `a=t,f=32,s=1,v=1,i=${i},q=2;${pixel}`)
  assert.match(responses(await send(d, 'a=p,i=1'))[0] ?? '', /ENOENT/)
  assert.deepEqual(kinds(await send(d, 'a=p,i=2')), ['place', 'respond'])
})

test('storing an image (or deleting all placements) does not walk the store', async () => {
  const e = engine()
  const pixel = b64(Uint8Array.of(0, 0, 0, 0))
  const stored = 2000
  for (let i = 1; i <= stored; i++) await send(e, `a=t,f=32,s=1,v=1,i=${i},q=2;${pixel}`)
  // Count every walk of a map as large as the store while more images arrive.
  const proto = Map.prototype as unknown as Record<string | symbol, (...args: unknown[]) => unknown>
  const names: Array<string | symbol> = ['values', 'keys', 'entries', 'forEach', Symbol.iterator]
  const originals = names.map((name) => proto[name]!)
  let walks = 0
  names.forEach((name, k) => {
    const original = originals[k]!
    proto[name] = function (this: Map<unknown, unknown>, ...args: unknown[]) {
      if (this.size >= stored) walks++
      return original.apply(this, args)
    }
  })
  try {
    for (let i = stored + 1; i <= stored + 100; i++) await send(e, `a=t,f=32,s=1,v=1,i=${i},q=2;${pixel}`)
    // Nor does deleting all placements: only images with placements are visited.
    await send(e, 'a=p,i=5,q=2')
    for (let k = 0; k < 100; k++) await send(e, 'a=d,d=a')
  } finally {
    names.forEach((name, k) => (proto[name] = originals[k]!))
  }
  assert.equal(walks, 0)
})

test('image numbers: deleting the newest falls back to the one before it', async () => {
  const e = engine()
  const ids: number[] = []
  for (const shade of [1, 2, 3]) {
    const reply = responses(await send(e, `a=t,f=32,s=1,v=1,I=13;${b64(Uint8Array.of(shade, shade, shade, 255))}`))[0] ?? ''
    ids.push(Number(/i=(\d+)/.exec(reply)?.[1]))
  }
  const [oldest, middle, newest] = ids
  assert.deepEqual(await send(e, 'a=d,d=N,I=13'), [{ kind: 'delete', imageIds: [newest] }])
  assert.equal(places(await send(e, 'a=p,I=13'))[0]?.imageId, middle)
  // Freeing the oldest by id leaves the middle one the newest.
  await send(e, `a=d,d=I,i=${oldest}`)
  assert.equal(places(await send(e, 'a=p,I=13'))[0]?.imageId, middle)
  await send(e, 'a=d,d=N,I=13')
  assert.match(responses(await send(e, 'a=p,I=13'))[0] ?? '', /ENOENT/)
})

test('d=r touches only images with placements in the range, in id order', async () => {
  const e = engine()
  const pixel = b64(Uint8Array.of(1, 2, 3, 255))
  await send(e, `a=T,f=32,s=1,v=1,i=12,q=2;${pixel}`)
  await send(e, `a=t,f=32,s=1,v=1,i=11,q=2;${pixel}`)
  await send(e, `a=T,U=1,f=32,s=1,v=1,i=10,q=2;${pixel}`)
  await send(e, `a=T,f=32,s=1,v=1,i=20,q=2;${pixel}`)
  assert.deepEqual(await send(e, 'a=d,d=r,x=10,y=15'), [{ kind: 'delete', imageIds: [10, 12] }])
  // Nothing in the range is referenced any more, and d=r keeps image data.
  assert.deepEqual(await send(e, 'a=d,d=r,x=10,y=15'), [])
  for (const i of [10, 11, 12]) assert.deepEqual(kinds(await send(e, `a=p,i=${i},q=2`)), ['place'], `i=${i}`)
  assert.deepEqual(await send(e, 'a=d,d=R,x=0,y=4294967295'), [{ kind: 'delete', imageIds: [10, 11, 12, 20] }])
  assert.match(responses(await send(e, 'a=p,i=20'))[0] ?? '', /ENOENT/)
})

test('lookups by number and deletes by range or of everything do not walk the store', async () => {
  const e = engine()
  const pixel = b64(Uint8Array.of(0, 0, 0, 0))
  const stored = 2000
  // Each image keeps a virtual placement, so d=A cannot free it.
  for (let i = 1; i <= stored; i++) await send(e, `a=T,U=1,f=32,s=1,v=1,i=${i},q=2;${pixel}`)
  for (let k = 0; k < 50; k++) await send(e, `a=t,f=32,s=1,v=1,I=7,q=2;${pixel}`)
  // Count every walk of a map or set as large as the store.
  let walks = 0
  const restores = [Map.prototype, Set.prototype].map((target) => {
    const proto = target as unknown as Record<string | symbol, (...args: unknown[]) => unknown>
    const names: Array<string | symbol> = ['values', 'keys', 'entries', 'forEach', Symbol.iterator]
    const originals = names.map((name) => proto[name]!)
    names.forEach((name, k) => {
      const original = originals[k]!
      proto[name] = function (this: Map<unknown, unknown> | Set<unknown>, ...args: unknown[]) {
        if (this.size >= stored) walks++
        return original.apply(this, args)
      }
    })
    return () => names.forEach((name, k) => (proto[name] = originals[k]!))
  })
  try {
    for (let k = 0; k < 100; k++) await send(e, 'a=p,I=7,q=2')
    for (let k = 0; k < 100; k++) await send(e, `a=d,d=r,x=${stored + 1},y=1000000`)
    for (let k = 0; k < 100; k++) await send(e, `a=d,d=R,x=${stored + 1},y=1000000`)
    for (let k = 0; k < 100; k++) await send(e, 'a=d,d=A')
  } finally {
    for (const restore of restores) restore()
  }
  assert.equal(walks, 0)
  // d=A freed the numbered images but kept those with virtual placements.
  assert.match(responses(await send(e, 'a=p,I=7'))[0] ?? '', /ENOENT/)
  assert.deepEqual(kinds(await send(e, `a=p,i=${stored},q=2`)), ['place'])
})

test('placement ids past the bound are counted, not stored, and keep the image referenced', async () => {
  const e = engine({ maxPlacementIds: 2 })
  await send(e, `a=t,f=32,s=1,v=1,i=1,q=2;${b64(Uint8Array.of(1, 2, 3, 255))}`)
  for (const p of [1, 2, 3, 4, 1]) assert.deepEqual(kinds(await send(e, `a=p,i=1,p=${p},q=2`)), ['place'])
  // 3 and 4 are no longer told apart: deleting them by id cannot free the image.
  for (const p of [1, 2, 3, 4]) await send(e, `a=d,d=I,i=1,p=${p}`)
  assert.deepEqual(kinds(await send(e, 'a=p,i=1')), ['place', 'respond'])
  // Deleting all of its placements does.
  await send(e, 'a=d,d=I,i=1')
  assert.match(responses(await send(e, 'a=p,i=1'))[0] ?? '', /ENOENT/)
})
