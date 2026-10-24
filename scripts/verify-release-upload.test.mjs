import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { verifyReleaseUpload } from './verify-release-upload.mjs'

function fixture(t, draft) {
  const dir = mkdtempSync(join(tmpdir(), 'audioscript-release-upload-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const commit = 'a'.repeat(40)
  writeFileSync(join(dir, 'release-verification.json'), JSON.stringify({ repository: 'zyg0733/AudioScript', version: '1.2.3', tag: 'v1.2.3', commit }))
  writeFileSync(join(dir, 'latest.json'), '{}')
  writeFileSync(join(dir, 'SHA256SUMS.txt'), 'fixture')
  const tag = draft ? 'untagged-abc123' : 'v1.2.3'
  const metadata = { tag_name: 'v1.2.3', target_commitish: commit, draft, prerelease: false, html_url: `https://github.com/zyg0733/AudioScript/releases/tag/${tag}`, assets: readdirSync(dir).map(name => {
    const bytes = readFileSync(join(dir, name))
    return { name, state: 'uploaded', size: bytes.length, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, browser_download_url: `https://github.com/zyg0733/AudioScript/releases/download/${tag}/${name}` }
  }) }
  return { dir, metadata }
}
test('草稿和公开版本逐文件验证，草稿临时地址不能混入公开版本', t => {
  for (const draft of [true, false]) {
    const { dir, metadata } = fixture(t, draft)
    const tagCommit = metadata.target_commitish
    assert.equal(verifyReleaseUpload({ metadata, assetDir: dir, draft, tagCommit }), 3)
    assert.throws(() => verifyReleaseUpload({ metadata, assetDir: dir, draft, tagCommit: 'b'.repeat(40) }), /远端标签/)
    if (draft) {
      metadata.draft = false
      assert.throws(() => verifyReleaseUpload({ metadata, assetDir: dir, draft: false, tagCommit }), /下载标签/)
    }
  }
})
test('错提交、缺附件、坏摘要、错大小、错误下载来源均阻止发布', t => {
  const { dir, metadata } = fixture(t, true)
  const tagCommit = metadata.target_commitish
  const cases = [m => { m.target_commitish = 'b'.repeat(40) }, m => { m.assets.pop() }, m => { m.assets[0].digest = 'sha256:incorrect' }, m => { m.assets[0].size++ }, m => { m.assets[0].browser_download_url = 'https://example.com/asset' }]
  for (const change of cases) {
    const copy = structuredClone(metadata)
    change(copy)
    assert.throws(() => verifyReleaseUpload({ metadata: copy, assetDir: dir, draft: true, tagCommit }))
  }
})
