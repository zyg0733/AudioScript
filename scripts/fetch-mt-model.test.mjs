import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

test('已缓存的双向模型会生成各自的许可说明，无需下载', () => {
  const root = mkdtempSync(join(tmpdir(), 'audioscript-mt-test-'))
  try {
    const scripts = join(root, 'scripts')
    mkdirSync(scripts, { recursive: true })
    copyFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fetch-mt-model.mjs'), join(scripts, 'fetch-mt-model.mjs'))
    for (const direction of ['en-zh', 'zh-en']) {
      const dir = join(root, 'src-tauri', 'assets', 'models', 'mt', `opus-mt-${direction}-ct2`)
      mkdirSync(dir, { recursive: true })
      for (const name of ['model.bin', 'source-tokenizer.json', 'target-tokenizer.json']) writeFileSync(join(dir, name), 'fixture')
    }
    execFileSync(process.execPath, [join(scripts, 'fetch-mt-model.mjs')], { encoding: 'utf8' })
    const readNotice = (direction) => readFileSync(join(root, 'src-tauri', 'assets', 'models', 'mt', `opus-mt-${direction}-ct2`, 'NOTICE.txt'), 'utf8')
    assert.match(readNotice('en-zh'), /Helsinki-NLP\/opus-mt-en-zh[\s\S]*Apache-2\.0/)
    assert.match(readNotice('zh-en'), /Helsinki-NLP\/opus-mt-zh-en[\s\S]*CC-BY-4\.0/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
