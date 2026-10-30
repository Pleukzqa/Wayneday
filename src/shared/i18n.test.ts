import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { setLang, t } from './i18n.ts'
import { TH } from './th.ts'

const SRC = join(import.meta.dirname, '..')

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isDirectory()) return sources(p)
    return /\.tsx?$/.test(e.name) && !e.name.includes('.test.') && e.name !== 'th.ts' ? [p] : []
  })
}

test('every literal t() string has a Thai translation', () => {
  const missing = new Set<string>()
  for (const file of sources(SRC)) {
    const src = readFileSync(file, 'utf8')
    const keys = [
      ...[...src.matchAll(/\bt\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)')/g)].map((m) => m[1] ?? m[2]),
      // t(cond ? 'a' : 'b')
      ...[...src.matchAll(/\bt\([^()'"]*\?\s*'([^']*)'\s*:\s*'([^']*)'/g)].flatMap((m) => [m[1], m[2]]),
    ]
    for (const raw of keys) {
      const key = raw.replace(/\\(['"])/g, '$1')
      // Pure placeholders and symbols read the same in both languages.
      if (/[A-Za-z]/.test(key.replace(/\{\w+\}/g, '')) && !(key in TH)) missing.add(key)
    }
  }
  assert.deepEqual([...missing], [])
})

test('Thai translations keep their placeholders', () => {
  const ph = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join()
  for (const [en, th] of Object.entries(TH)) assert.equal(ph(th), ph(en), en)
})

test('t fills placeholders in the chosen language', () => {
  setLang('th')
  assert.equal(t('Add students ({n})', { n: 4 }), 'เพิ่มนิสิต (4)')
  setLang('en')
  assert.equal(t('Add students ({n})', { n: 4 }), 'Add students (4)')
})
