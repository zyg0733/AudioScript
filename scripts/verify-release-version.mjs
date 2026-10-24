#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function releaseVersion(sources, tag = '') {
  const version = JSON.parse(sources.package).version
  assert.match(version, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, '发布版本必须为正式语义版本')
  const cargoPackage = sources.cargo.match(/\[package\]([\s\S]*?)(?=\n\[|$)/)?.[1]
  assert.match(cargoPackage ?? '', /^name\s*=\s*"audioscript"$/m, 'Cargo.toml 应用包不存在')
  const versions = {
    'tauri.conf.json': JSON.parse(sources.tauri).version,
    'Cargo.toml': cargoPackage?.match(/^version\s*=\s*"([^"]+)"/m)?.[1],
    'Cargo.lock': sources.lock.match(/\[\[package\]\]\r?\nname = "audioscript"\r?\nversion = "([^"]+)"/)?.[1],
    '官网': sources.site.match(/"softwareVersion"\s*:\s*"([^"]+)"/)?.[1],
  }
  for (const [file, value] of Object.entries(versions)) assert.equal(value, version, `${file} 版本与 package.json 不一致`)
  if (tag) assert.equal(tag, `v${version}`, '发布标签与应用版本不一致')
  return version
}

export function verifyReleaseVersion(root, tag = '') {
  const read = file => readFileSync(resolve(root, file), 'utf8')
  return releaseVersion({ package: read('package.json'), tauri: read('src-tauri/tauri.conf.json'), cargo: read('src-tauri/Cargo.toml'), lock: read('src-tauri/Cargo.lock'), site: read('docs/index.html') }, tag)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
    const tag = (process.env.GITHUB_REF ?? '').startsWith('refs/tags/') ? process.env.GITHUB_REF.slice(10) : ''
    console.log(`发布版本一致：${verifyReleaseVersion(root, tag)}`)
  } catch (error) {
    console.error(`发布版本校验失败：${error.message}`)
    process.exitCode = 1
  }
}
