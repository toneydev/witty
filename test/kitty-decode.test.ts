// decodeImage error messages (src/kitty/decode.ts): fixed strings, nothing derived from the data.

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { deflateSync } from 'node:zlib'
import { KittyError } from '../src/kitty/command.ts'
import { decodeImage } from '../src/kitty/decode.ts'
import type { DecodeOptions } from '../src/kitty/decode.ts'

const b64 = (data: Uint8Array | string): string => Buffer.from(data).toString('base64')

/** Expects decodeImage to reject with `code` and a message free of digits. */
async function failsWith(keys: Record<string, string>, payload: string, options: DecodeOptions, code: string): Promise<void> {
  await assert.rejects(decodeImage(keys, payload, options), (error: unknown) => {
    assert.ok(error instanceof KittyError, String(error))
    assert.equal(error.code, code, error.status)
    assert.doesNotMatch(error.message, /\d/, error.status)
    return true
  })
}

describe('t=d error messages', () => {
  it('ENODATA does not echo the data length or the needed size', async () => {
    await failsWith({ f: '32', s: '7', v: '9' }, b64(new Uint8Array(13)), {}, 'ENODATA')
    await failsWith({ f: '24', s: '5', v: '3' }, b64(new Uint8Array(44)), {}, 'ENODATA')
  })

  it('EFBIG does not echo sizes or limits', async () => {
    const limits = { maxImageBytes: 1024, maxPayloadBytes: 64 }
    await failsWith({ f: '32', s: '123', v: '456' }, b64(new Uint8Array(8)), limits, 'EFBIG')
    await failsWith({ f: '32', s: '1', v: '1' }, 'A'.repeat(100), limits, 'EFBIG')
    await failsWith({ f: '100', o: 'z' }, b64(deflateSync(new Uint8Array(5000))), limits, 'EFBIG')
    // Raw data inflating past s*v*bpp is a mismatch, not a size limit (as in kitty).
    await failsWith({ f: '32', s: '1', v: '1', o: 'z' }, b64(deflateSync(new Uint8Array(5000))), limits, 'EINVAL')
  })
})
