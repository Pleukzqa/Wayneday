// Turns the demo build (dist-demo/) into a page for a claude.ai artifact:
// no html/head/body skeleton, CSS inlined, the app script and its chunks served alongside.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const dir = join(import.meta.dirname, '..', 'dist-demo')
const html = readFileSync(join(dir, 'index.html'), 'utf8')
const css = [...html.matchAll(/<link rel="stylesheet"[^>]*href="\.\/([^"]+)"[^>]*>/g)]
  .map((m) => readFileSync(join(dir, m[1]), 'utf8'))
  .join('\n')
const script = /<script type="module"[^>]*src="\.\/([^"]+)"[^>]*><\/script>/.exec(html)?.[1]
if (!script) throw new Error('No module script found in dist-demo/index.html')

const page = `<title>Wayneday Demo</title>
<meta name="claude:viewport-fit-sides" content="cover">
<style>
${css}
</style>
<div id="root"></div>
<script type="module" src="${script}"></script>
`
writeFileSync(join(dir, 'artifact.html'), page)

// The publisher rejects a literal U+FFFD (it appears inside exceljs string literals); use the escape instead.
for (const f of readdirSync(join(dir, 'assets')).filter((f) => f.endsWith('.js'))) {
  const path = join(dir, 'assets', f)
  const src = readFileSync(path, 'utf8')
  if (src.includes('\uFFFD')) writeFileSync(path, src.replaceAll('\uFFFD', '\\ufffd'))
}
console.log(`dist-demo/artifact.html (${page.length} bytes) -> ${script}`)
