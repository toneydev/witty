// Payload → RGBA for kitty graphics transmissions (`f`, `t`, `o`, `s`, `v`, `S`, `O`).

import { inflateRawSync, inflateSync } from 'node:zlib'
import { PNG } from 'pngjs'
import type { Rgba } from '../types.ts'
import { KittyError, uintKey } from './command.ts'

/** Default largest decoded image, in bytes of RGBA. */
export const DEFAULT_MAX_IMAGE_BYTES = 64 * 1024 * 1024
/** Default largest accumulated payload, in base64 bytes. */
export const DEFAULT_MAX_PAYLOAD_BYTES = 32 * 1024 * 1024

export type DecodeOptions = {
  /** Reads a file for `t=f` / `t=t`; absent, those transports are refused with EINVAL. */
  readFile?: ((path: string) => Promise<Uint8Array>) | undefined
  /** Deletes a `t=t` temp file after reading; absent, the file is left in place. */
  deleteFile?: ((path: string) => Promise<void>) | undefined
  /** Largest decoded image, bytes of RGBA. */
  maxImageBytes?: number | undefined
  /** Largest payload, base64 bytes (for `t=d`). */
  maxPayloadBytes?: number | undefined
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

/**
 * Decodes the image data a transmit command carries into RGBA, following
 * kitty's rules: `f=100` PNG, `f=24` RGB / `f=32` RGBA raw with `s`×`v`
 * pixels (default `f=32`); `o=z` zlib-inflates the data first; `t=d` (the
 * default) means the payload is the base64 data, `t=f` / `t=t` that it is the
 * base64 of a file path, read through `options.readFile` honoring `O`
 * (offset) and `S` (size). A `t=t` file is deleted after reading, but only
 * when its path contains `tty-graphics-protocol`. `t=s` is refused.
 *
 * Throws `KittyError` with the response code for every failure.
 */
export async function decodeImage(
  keys: Record<string, string>,
  payload: string,
  options: DecodeOptions = {},
): Promise<Rgba> {
  const maxImageBytes = options.maxImageBytes ?? DEFAULT_MAX_IMAGE_BYTES
  const maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES
  const format = keys.f === undefined || keys.f === '' ? '32' : keys.f
  if (format !== '24' && format !== '32' && format !== '100') {
    throw new KittyError('EINVAL', `unsupported format f=${format}`)
  }
  const compression = keys.o ?? ''
  if (compression !== '' && compression !== 'z') {
    throw new KittyError('EINVAL', `unsupported compression o=${compression}`)
  }

  let data = await readData(keys, payload, options, maxPayloadBytes, maxImageBytes)
  if (compression === 'z') data = inflate(data, maxImageBytes)
  if (format === '100') return decodePng(data, maxImageBytes)
  return decodeRaw(data, format === '24' ? 3 : 4, keys, maxImageBytes)
}

/** The transmitted bytes, before decompression, from the medium `t` names. */
async function readData(
  keys: Record<string, string>,
  payload: string,
  options: DecodeOptions,
  maxPayloadBytes: number,
  maxImageBytes: number,
): Promise<Uint8Array> {
  const medium = keys.t === undefined || keys.t === '' ? 'd' : keys.t
  switch (medium) {
    case 'd':
      if (payload.length > maxPayloadBytes) {
        throw new KittyError('EFBIG', `payload of ${payload.length} bytes exceeds ${maxPayloadBytes}`)
      }
      return base64(payload)
    case 'f':
    case 't':
      return readFileData(medium, keys, payload, options, maxImageBytes)
    case 's':
      throw new KittyError('EINVAL', 'shared memory transmission (t=s) is not supported')
    default:
      throw new KittyError('EINVAL', `unknown transmission medium t=${medium}`)
  }
}

async function readFileData(
  medium: 'f' | 't',
  keys: Record<string, string>,
  payload: string,
  options: DecodeOptions,
  maxImageBytes: number,
): Promise<Uint8Array> {
  const { readFile, deleteFile } = options
  if (readFile === undefined) {
    throw new KittyError('EINVAL', `file transmission (t=${medium}) is not supported`)
  }
  const offset = uintKey(keys, 'O')
  const size = uintKey(keys, 'S')
  const path = Buffer.from(payload, 'base64').toString('utf8')
  if (path === '' || path.includes('\0')) throw new KittyError('EINVAL', 'invalid file path')

  let file: Uint8Array
  try {
    file = await readFile(path)
  } catch {
    throw new KittyError('EBADF', 'Failed to read image file')
  } finally {
    // kitty's safety rule: only files that are clearly graphics temp files are deleted.
    if (medium === 't' && deleteFile !== undefined && path.includes('tty-graphics-protocol')) {
      await deleteFile(path).catch(() => undefined)
    }
  }
  if (offset > file.length || (size > 0 && offset + size > file.length)) {
    throw new KittyError('EBADF', 'Failed to read image file')
  }
  const data = file.subarray(offset, size > 0 ? offset + size : file.length)
  if (data.length > maxImageBytes) {
    throw new KittyError('EFBIG', `file data of ${data.length} bytes exceeds ${maxImageBytes}`)
  }
  return data
}

function base64(text: string): Uint8Array {
  const buf = Buffer.from(text, 'base64')
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.length)
}

/** zlib inflate (RFC 1950), falling back to raw deflate; output bounded by `limit`. */
function inflate(data: Uint8Array, limit: number): Uint8Array {
  const attempt = (fn: typeof inflateSync): Uint8Array | KittyError => {
    try {
      const out = fn(data, { maxOutputLength: limit })
      return new Uint8Array(out.buffer, out.byteOffset, out.length)
    } catch (error) {
      if (error instanceof RangeError || (error as { code?: unknown }).code === 'ERR_BUFFER_TOO_LARGE') {
        return new KittyError('EFBIG', `inflated data exceeds ${limit} bytes`)
      }
      return new KittyError('EINVAL', 'Failed to inflate image data')
    }
  }
  const zlib = attempt(inflateSync)
  if (!(zlib instanceof KittyError)) return zlib
  if (zlib.code === 'EFBIG') throw zlib
  const raw = attempt(inflateRawSync)
  if (raw instanceof KittyError) throw raw.code === 'EFBIG' ? raw : zlib
  return raw
}

function checkSize(width: number, height: number, maxImageBytes: number): void {
  if (width === 0 || height === 0) throw new KittyError('EINVAL', 'zero width or height is not allowed')
  const bytes = width * height * 4
  if (bytes > maxImageBytes) {
    throw new KittyError('EFBIG', `image of ${width}x${height} exceeds ${maxImageBytes} bytes of RGBA`)
  }
}

/** PNG → RGBA 8-bit (pngjs normalises palette, gray, alpha and 16-bit input). */
function decodePng(data: Uint8Array, maxImageBytes: number): Rgba {
  if (data.length < 24 || PNG_SIGNATURE.some((byte, index) => data[index] !== byte)) {
    throw new KittyError('EBADPNG', 'not a PNG image')
  }
  // IHDR is always the first chunk: check the size before inflating anything.
  const view = new DataView(data.buffer, data.byteOffset, data.length)
  checkSize(view.getUint32(16), view.getUint32(20), maxImageBytes)
  let png: { width: number; height: number; data: Buffer }
  try {
    png = PNG.sync.read(Buffer.from(data.buffer, data.byteOffset, data.length))
  } catch (error) {
    throw new KittyError('EBADPNG', error instanceof Error ? error.message : String(error))
  }
  const { width, height } = png
  if (png.data.length < width * height * 4) throw new KittyError('EBADPNG', 'truncated PNG image data')
  const rgba = new Uint8Array(width * height * 4)
  rgba.set(png.data.subarray(0, rgba.length))
  return { width, height, data: rgba }
}

/** Raw RGB (`bpp` 3) or RGBA (`bpp` 4) of `s`×`v` pixels → RGBA. */
function decodeRaw(data: Uint8Array, bpp: 3 | 4, keys: Record<string, string>, maxImageBytes: number): Rgba {
  const width = uintKey(keys, 's')
  const height = uintKey(keys, 'v')
  checkSize(width, height, maxImageBytes)
  const pixels = width * height
  const needed = pixels * bpp
  if (data.length < needed) {
    throw new KittyError('ENODATA', `Insufficient image data: ${data.length} < ${needed}`)
  }
  if (bpp === 4) return { width, height, data: data.slice(0, needed) }
  const rgba = new Uint8Array(pixels * 4)
  for (let src = 0, dst = 0; src < needed; src += 3, dst += 4) {
    rgba[dst] = data[src]!
    rgba[dst + 1] = data[src + 1]!
    rgba[dst + 2] = data[src + 2]!
    rgba[dst + 3] = 255
  }
  return { width, height, data: rgba }
}
