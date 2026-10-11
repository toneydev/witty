import type { Register } from 'claude-code'

// One 8x4 sprite, drawn two ways side by side in the band above the prompt:
//   Image  -> kitty graphics protocol where the terminal has it, its alt elsewhere
//   Raster -> colored half-block cells (U+2580, fg = top pixel, bg = bottom pixel), any terminal
const W = 8
const H = 4
const R = 0xe05050
const Y = 0xe0c040
const G = 0x50c070
const B = 0x4080e0
const PIX: number[][] = [
  [R, R, Y, Y, G, G, B, B],
  [R, R, Y, Y, G, G, B, B],
  [B, B, G, G, Y, Y, R, R],
  [B, B, G, G, Y, Y, R, R],
]

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
function base64(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!
    const b = i + 1 < bytes.length ? bytes[i + 1]! : 0
    const c = i + 2 < bytes.length ? bytes[i + 2]! : 0
    const n = (a << 16) | (b << 8) | c
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]!
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63]! : '='
    out += i + 2 < bytes.length ? B64[n & 63]! : '='
  }
  return out
}

function rgbaSource(): string {
  const out = new Uint8Array(W * H * 4)
  let i = 0
  for (const row of PIX) {
    for (const c of row) {
      out[i++] = (c >> 16) & 255
      out[i++] = (c >> 8) & 255
      out[i++] = c & 255
      out[i++] = 255
    }
  }
  return base64(out)
}

function rasterCells(): string {
  const rows = H / 2
  const words = new Uint32Array(W * rows * 3)
  let i = 0
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < W; c++) {
      words[i++] = 0x2580 // upper half block
      words[i++] = PIX[2 * r]![c]!
      words[i++] = PIX[2 * r + 1]![c]!
    }
  }
  return base64(new Uint8Array(words.buffer))
}

const RGBA = rgbaSource()
const CELLS = rasterCells()

export const register: Register = on => {
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const below = await next(e)
    const { Box, Text, Image, Raster } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1} paddingX={1}>
          <Text dimColor>witty-probe</Text>
          <Text dimColor>Image:</Text>
          <Image source={{ rgba: RGBA, width: W, height: H }} columns={W} rows={2} alt="[alt: no kitty graphics here]" />
          <Text dimColor>Raster:</Text>
          <Raster key="sprite" columns={W} rows={2} cells={CELLS} />
        </Box>
        {below}
      </Box>
    )
  })
}
