// Compare the plugin's fallback image scaling against the runtime's own
// implementation, and check imageTarget's guards. Pure functions only: this
// extracts them from index.js by name so no host services are needed.
import { readFileSync, writeFileSync } from 'node:fs'

/** Take a top-level `function name(` block through its matching closing brace. */
function extract(source, name) {
  const start = source.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`function ${name} not found`)
  let depth = 0
  let index = source.indexOf('{', start)
  for (; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1
    else if (source[index] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, index + 1)
    }
  }
  throw new Error(`unbalanced braces in ${name}`)
}

const src = readFileSync(process.argv[2], 'utf8')
const out = []
try {
  const code = [
    extract(src, 'fallbackImageDimensions'),
    // imageTarget references the constants and the optional runtime import.
    'const IMAGE_MAX_PIXELS = 1048576',
    'const IMAGE_MAX_BYTES = 1500000',
    'const IMAGE_FALLBACK_EDGE = 1024',
    'const requestImageDimensions = undefined',
    extract(src, 'imageTarget'),
  ].join('\n')
  const fns = new Function(`${code}; return { fallbackImageDimensions, imageTarget }`)()

  const reference = (width, height, maxPixels) => {
    const scale = Math.min(1, Math.sqrt(maxPixels / (width * height)))
    if (scale === 1) return { width, height }
    if (width >= height) {
      let pw = Math.max(1, Math.floor(width * scale))
      let ph = Math.max(1, Math.round(pw * height / width))
      while (pw * ph > maxPixels && pw > 1) {
        pw -= 1
        ph = Math.max(1, Math.round(pw * height / width))
      }
      return { width: pw, height: ph }
    }
    let ph = Math.max(1, Math.floor(height * scale))
    let pw = Math.max(1, Math.round(ph * width / height))
    while (pw * ph > maxPixels && ph > 1) {
      ph -= 1
      pw = Math.max(1, Math.round(ph * width / height))
    }
    return { width: pw, height: ph }
  }

  const cases = [
    [1920, 1080], [1080, 1920], [800, 600], [1024, 1024], [100, 50],
    [4000, 3000], [3000, 4000], [5000, 200], [200, 5000], [1, 1], [16, 9],
  ]
  let mismatches = 0
  for (const [w, h] of cases) {
    const mine = fns.fallbackImageDimensions(w, h, 1048576)
    const ref = reference(w, h, 1048576)
    const same = mine.width === ref.width && mine.height === ref.height
    const pixels = mine.width * mine.height
    if (!same) mismatches += 1
    out.push(`${w}x${h} -> ${mine.width}x${mine.height} (${pixels} px) ${same ? 'match' : `MISMATCH ref ${ref.width}x${ref.height}`}`)
  }
  out.push(`mismatches: ${mismatches}`)

  out.push(`imageTarget no dims: ${JSON.stringify(fns.imageTarget({}))}`)
  out.push(`imageTarget zero dims: ${JSON.stringify(fns.imageTarget({ width: 0, height: 0 }))}`)
  out.push(`imageTarget 1920x1080: ${JSON.stringify(fns.imageTarget({ width: 1920, height: 1080 }))}`)
  out.push(`imageTarget 800x600: ${JSON.stringify(fns.imageTarget({ width: 800, height: 600 }))}`)
} catch (error) {
  out.push(`ERROR ${error && error.message}`)
}
writeFileSync(process.argv[3], out.join('\n'))
process.exit(0)
