#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const project = JSON.parse(readFileSync(new URL('../project.json', import.meta.url), 'utf8'))
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/

function fail(message) {
  throw new Error(message)
}

export function normalizeVersion(version) {
  const normalized = typeof version === 'string' ? version.replace(/^v/, '') : ''
  if (!semver.test(normalized)) fail('版本必须是合法的 SemVer 版本号')
  return normalized
}

function decodeBase64(value, label, expectedLength) {
  if (!value || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    fail(`${label}不是有效的 base64`)
  }
  const bytes = Buffer.from(value, 'base64')
  if (bytes.toString('base64') !== value || (expectedLength !== undefined && bytes.length !== expectedLength)) {
    fail(`${label}长度或编码无效`)
  }
  return bytes
}

export function parseSignature(encoded) {
  const signature = encoded.trim()
  const bytes = decodeBase64(signature, '更新签名')
  let text
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    fail('更新签名不是有效的 UTF-8 文本')
  }
  const lines = text.replace(/\r?\n$/, '').split(/\r?\n/)
  if (lines.length !== 4 || !lines[0].startsWith('untrusted comment: ') || !lines[2].startsWith('trusted comment: ')) {
    fail('更新签名必须包含完整的 minisign 签名及可信注释')
  }
  const payload = decodeBase64(lines[1], '更新签名正文', 74)
  if (!['Ed', 'ED'].includes(payload.subarray(0, 2).toString('ascii'))) fail('更新签名算法无效')
  decodeBase64(lines[3], '更新签名的可信注释签名', 64)
  return signature
}

export function parseArguments(argv) {
  const options = { version: '', baseUrl: '', notes: '', out: 'latest.json', verifyExecutable: '', platforms: [] }
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i]
    const value = argv[i + 1]
    if (value === undefined) fail(`参数 ${flag} 缺少值`)
    switch (flag) {
      case '--version': options.version = value; break
      case '--base-url': options.baseUrl = value; break
      case '--notes': options.notes = value; break
      case '--out': options.out = value; break
      case '--verify-executable': options.verifyExecutable = value; break
      case '--platform': {
        const at = value.indexOf('=')
        if (at <= 0 || at === value.length - 1) fail('--platform 需要 target=artifact 形式')
        options.platforms.push({ target: value.slice(0, at), artifact: value.slice(at + 1) })
        break
      }
      default: fail(`未知参数 ${flag}`)
    }
  }
  return options
}

export function verifyArtifact({ executable, artifact, signaturePath, version, publicKey }) {
  const env = { TAURI_UPDATER_PUBLIC_KEY: publicKey }
  // 验签进程只需要公钥与系统路径，不继承发布私钥或其他 CI Secret。
  for (const name of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'HOME']) {
    if (process.env[name]) env[name] = process.env[name]
  }
  const result = spawnSync(executable, ['--artifact', artifact, '--signature', signaturePath, '--version', version], {
    encoding: 'utf8', env, timeout: 300_000, maxBuffer: 1024 * 1024,
  })
  if (result.error || result.status !== 0) fail(`更新包验签失败：${basename(artifact)}`)
  try {
    return JSON.parse(result.stdout)
  } catch {
    fail(`验签程序未返回有效报告：${basename(artifact)}`)
  }
}

export function buildUpdaterManifest(options, verify = verifyArtifact) {
  const version = normalizeVersion(options.version)
  const baseUrl = options.baseUrl?.replace(/\/+$/, '')
  const expectedBase = `${project.repository.replace(/\/+$/, '')}/releases/download/v${version}`
  if (baseUrl !== expectedBase) fail('下载地址必须指向本项目仓库与当前版本标签')
  if (!options.verifyExecutable) fail('缺少 --verify-executable；必须先完整验签再生成更新清单')
  const publicKey = options.publicKey?.trim()
  if (!publicKey) fail('缺少 TAURI_UPDATER_PUBLIC_KEY 公钥')
  if (!Array.isArray(options.platforms) || options.platforms.length === 0) fail('至少需要一个 --platform')

  const targets = new Set()
  const artifacts = new Map()
  const platforms = {}
  for (const { target, artifact } of options.platforms) {
    if (typeof target !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9_]+)+$/.test(target)) fail('更新平台标识无效')
    if (targets.has(target)) fail(`更新平台重复：${target}`)
    targets.add(target)
    if (typeof artifact !== 'string' || !artifact) fail(`更新包路径为空：${target}`)

    let canonical
    let signature
    const signaturePath = `${artifact}.sig`
    try {
      canonical = realpathSync(artifact)
      if (!statSync(canonical).isFile() || statSync(canonical).size === 0) fail('更新包必须是非空文件')
      signature = parseSignature(readFileSync(signaturePath, 'utf8'))
    } catch (error) {
      fail(`更新包或签名不可用：${basename(artifact)}（${error.message}）`)
    }

    const existing = artifacts.get(canonical)
    if (existing) {
      if (existing.signature !== signature || existing.name !== basename(artifact)) fail('同一更新包存在不同签名或文件名')
    } else {
      artifacts.set(canonical, { artifact, canonical, signaturePath, signature, name: basename(artifact) })
    }
    platforms[target] = { signature, url: `${baseUrl}/${encodeURIComponent(basename(artifact))}` }
  }

  const verification = []
  for (const entry of artifacts.values()) {
    const report = verify({ executable: options.verifyExecutable, artifact: entry.artifact,
      signaturePath: entry.signaturePath, version, publicKey })
    const sha256 = createHash('sha256').update(readFileSync(entry.canonical)).digest('hex')
    if (!report || report.version !== version || normalizeVersion(report.signedVersion) !== version ||
      report.artifact !== entry.name || report.sha256 !== sha256) {
      fail(`验签报告与更新包或版本不一致：${entry.name}`)
    }
    verification.push(report)
  }
  const date = options.now === undefined ? new Date() : new Date(options.now)
  if (Number.isNaN(date.getTime())) fail('发布时间无效')
  return {
    manifest: { version, notes: options.notes ?? '', pub_date: date.toISOString(), platforms },
    verification,
  }
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv)
  const { manifest, verification } = buildUpdaterManifest({
    ...options, publicKey: process.env.TAURI_UPDATER_PUBLIC_KEY,
  })
  writeFileSync(options.out, `${JSON.stringify(manifest, null, 2)}\n`)
  writeFileSync(`${options.out}.verification.json`, `${JSON.stringify({ version: manifest.version, artifacts: verification }, null, 2)}\n`)
  process.stdout.write(`已生成 ${options.out}，${verification.length} 个更新包完整验签通过：${Object.keys(manifest.platforms).join('、')}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`更新清单错误：${error.message}\n`)
    process.exitCode = 1
  }
}
