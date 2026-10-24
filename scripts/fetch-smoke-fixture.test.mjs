import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { FIXTURE, FIXTURE_URL, fetchSmokeFixture, verifyFixture } from './fetch-smoke-fixture.mjs'

const bytes = Buffer.from('offline synthetic WAV fixture')
const expected = { sizeBytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }

async function targetFor(t) {
  const dir = await mkdtemp(join(tmpdir(), 'audioscript-smoke-fixture-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return { dir, target: join(dir, '2.wav') }
}

test('固定官方 commit、文件大小与校验和，导入脚本不下载', () => {
  assert.ok(FIXTURE_URL.includes('/resolve/2593e24a11dd3e49598925eafbe859d546895201/test_wavs/2.wav'))
  assert.equal(FIXTURE.sizeBytes, 150124)
  assert.equal(FIXTURE.sha256, '20805bcc696b9b65f3357a2508a419d4f33b81006d47e1312e219b0fad934d1d')
  verifyFixture(bytes, expected)
})

test('Buffer 校验拒绝大小错误和相同大小的内容损坏', () => {
  assert.throws(() => verifyFixture(bytes.subarray(1), expected), /大小不符/)
  const corrupt = Buffer.from(bytes)
  corrupt[0] ^= 1
  assert.throws(() => verifyFixture(corrupt, expected), /SHA-256 不匹配/)
})

test('有效缓存每次验证后复用，不联网', async (t) => {
  const { target } = await targetFor(t)
  await writeFile(target, bytes)
  const result = await fetchSmokeFixture({
    target,
    expected,
    fetcher: () => assert.fail('有效缓存不应下载'),
  })
  assert.equal(result.cached, true)
  assert.equal(result.path, target)
})

test('损坏缓存直接报错，不吞错或自动覆盖缓存', async (t) => {
  const { target } = await targetFor(t)
  const corrupt = Buffer.alloc(bytes.length)
  await writeFile(target, corrupt)
  await assert.rejects(fetchSmokeFixture({
    target,
    expected,
    fetcher: () => assert.fail('损坏缓存必须先报告校验错误'),
  }), /SHA-256 不匹配/)
  assert.deepEqual(await readFile(target), corrupt)
})

test('新下载校验后原子安装，成功时不留下临时文件', async (t) => {
  const { dir, target } = await targetFor(t)
  const result = await fetchSmokeFixture({
    target,
    expected,
    fetcher: async (url) => {
      assert.equal(url, FIXTURE_URL)
      return new Response(bytes)
    },
  })
  assert.equal(result.cached, false)
  assert.deepEqual(await readFile(target), bytes)
  assert.deepEqual(await readdir(dir), ['2.wav'])
})

test('新下载内容损坏或 HTTP 失败时不发布目标文件并清理临时文件', async (t) => {
  const { dir, target } = await targetFor(t)
  await assert.rejects(fetchSmokeFixture({
    target,
    expected,
    fetcher: async () => new Response(Buffer.alloc(bytes.length)),
  }), /SHA-256 不匹配/)
  assert.deepEqual(await readdir(dir), [])
  await assert.rejects(fetchSmokeFixture({
    target,
    expected,
    fetcher: async () => new Response('not found', { status: 404 }),
  }), /HTTP 404/)
  assert.deepEqual(await readdir(dir), [])
})
