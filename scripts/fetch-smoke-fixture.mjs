#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const FIXTURE_URL = 'https://huggingface.co/csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20/resolve/2593e24a11dd3e49598925eafbe859d546895201/test_wavs/2.wav'
export const FIXTURE = Object.freeze({
  sizeBytes: 150124,
  sha256: '20805bcc696b9b65f3357a2508a419d4f33b81006d47e1312e219b0fad934d1d',
})
const TARGET = fileURLToPath(new URL('../.cache/release-smoke/2.wav', import.meta.url))

export function verifyFixture(bytes, expected = FIXTURE) {
  if (bytes.length !== expected.sizeBytes) {
    throw new Error(`ASR 测试音频大小不符：预期 ${expected.sizeBytes} 字节，实际 ${bytes.length} 字节`)
  }
  if (createHash('sha256').update(bytes).digest('hex') !== expected.sha256) {
    throw new Error('ASR 测试音频 SHA-256 不匹配，请移除损坏缓存后重试')
  }
}

export async function fetchSmokeFixture({ target = TARGET, expected = FIXTURE, fetcher = fetch } = {}) {
  let cached
  try {
    cached = await readFile(target)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (cached !== undefined) {
    verifyFixture(cached, expected)
    return { path: target, cached: true }
  }

  await mkdir(dirname(target), { recursive: true })
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`
  try {
    const response = await fetcher(FIXTURE_URL, { redirect: 'follow', signal: AbortSignal.timeout(60_000) })
    if (!response.ok) throw new Error(`下载 ASR 测试音频失败：HTTP ${response.status}`)
    await writeFile(temporary, Buffer.from(await response.arrayBuffer()), { flag: 'wx' })
    verifyFixture(await readFile(temporary), expected)
    await rename(temporary, target)
    return { path: target, cached: false }
  } finally {
    await rm(temporary, { force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fetchSmokeFixture()
    .then(({ path, cached }) => process.stdout.write(`ASR 测试音频${cached ? '缓存校验通过' : '下载并校验通过'}：${path}\n`))
    .catch((error) => {
      process.stderr.write(`${error.message}\n`)
      process.exitCode = 1
    })
}
