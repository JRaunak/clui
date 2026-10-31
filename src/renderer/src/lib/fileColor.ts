// A workbook's own colours on Clui's surfaces. A colour on an unfilled cell keeps its hue and moves in OKLCH lightness,
// chroma lowered only to stay in gamut, until it reaches its floor against the theme's background.
export type RGB = [number, number, number]

const lin = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const unlin = (c: number): number => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055)
const luminance = ([r, g, b]: RGB): number => 0.2126 * lin(r / 255) + 0.7152 * lin(g / 255) + 0.0722 * lin(b / 255)
export const contrast = (a: RGB, b: RGB): number => {
  const [x, y] = [luminance(a), luminance(b)]
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
}
export const rgbOf = (hex: string): RGB => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as RGB
const hexOf = (c: RGB): string => `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`

function oklab([r, g, b]: RGB): RGB {
  const [R, G, B] = [r, g, b].map((v) => lin(v / 255))
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B)
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B)
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B)
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s]
}
/** Linear sRGB 0 to 1, possibly out of gamut. */
function fromOklab([L, a, b]: RGB): RGB {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s]
}
const inGamut = (c: RGB): boolean => c.every((v) => v >= -1e-4 && v <= 1 + 1e-4)
const toRGB = (c: RGB): RGB => c.map((v) => unlin(Math.min(1, Math.max(0, v))) * 255) as RGB

const cache = new Map<string, string>()
/** `hex` moved to `floor`:1 on `bg`; unchanged when it already reaches it. */
export function readable(hex: string, bg: RGB, floor: number): string {
  const key = `${hex}|${bg.join(',')}|${floor}`
  const hit = cache.get(key)
  if (hit) return hit
  let out = hex
  if (contrast(rgbOf(hex), bg) < floor) {
    const [L0, a, b] = oklab(rgbOf(hex))
    const C0 = Math.hypot(a, b)
    const h = Math.atan2(b, a)
    const up = luminance(bg) < 0.18
    for (let L = L0; up ? L <= 1 : L >= 0; L += up ? 0.005 : -0.005) {
      // The most chroma this lightness holds in gamut, up to the colour's own.
      let lo = 0
      let hi = C0
      for (let i = 0; i < 12; i++) {
        const mid = (lo + hi) / 2
        if (inGamut(fromOklab([L, mid * Math.cos(h), mid * Math.sin(h)]))) lo = mid
        else hi = mid
      }
      const c = toRGB(fromOklab([L, lo * Math.cos(h), lo * Math.sin(h)]))
      out = hexOf(c)
      if (contrast(rgbOf(out), bg) >= floor) break
    }
  }
  if (cache.size > 4096) cache.clear()
  cache.set(key, out)
  return out
}
