#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeVersion, parseSignature, verifyArtifact } from './make-updater-manifest.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const packages = {
  'macos-arm64': [['macos', '.app.tar.gz']],
  'windows-x64': [['nsis', '-setup.exe'], ['msi', '.msi']],
  'linux-x64': [['appimage', '.AppImage'], ['deb', '.deb']],
}
const hash = (value) => createHash('sha256').update(value).digest('hex')

function fail(message) {
  throw new Error(message)
}

export function discoverUpdaterArtifacts(bundleRoot, platform) {
  if (!Object.hasOwn(packages, platform)) fail('未知更新包验证平台')
  return packages[platform].map(([directory, suffix]) => {
    let files
    try {
      files = readdirSync(join(bundleRoot, directory), { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(suffix)).map((entry) => join(bundleRoot, directory, entry.name))
    } catch {
      fail(`缺少 ${platform} 更新包目录：${directory}`)
    }
    if (files.length !== 1) fail(`${platform} 的 ${directory} 更新包必须恰好一个（找到 ${files.length} 个）`)
    return files[0]
  })
}

export function differentPublicKey(publicKey) {
  const normalized = publicKey.trim()
  const decoded = Buffer.from(normalized, 'base64')
  if (decoded.toString('base64') !== normalized) fail('更新公钥编码无效')
  const lines = decoded.toString('utf8').trimEnd().split(/\r?\n/)
  const packet = Buffer.from(lines[1] ?? '', 'base64')
  if (lines.length !== 2 || !lines[0].startsWith('untrusted comment: ') || packet.length !== 42 ||
    packet.toString('base64') !== lines[1] || !['Ed', 'ED'].includes(packet.subarray(0, 2).toString('ascii'))) {
    fail('更新公钥格式无效')
  }
  // 保留算法与 ID，替换为 RFC 8032 公开测试向量中的另一有效公钥，避免只触发 ID 不匹配。
  const first = Buffer.from('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a', 'hex')
  const second = Buffer.from('3d4017c3e843895a92b70aa74d1b7ebc9c982ccf2ec4968cc0cd55f12af4660c', 'hex')
  const replacement = packet.subarray(10).equals(first) ? second : first
  replacement.copy(packet, 10)
  return Buffer.from(`${lines[0]}\n${packet.toString('base64')}\n`).toString('base64')
}

function verifierEnvironment(publicKey) {
  const env = { TAURI_UPDATER_PUBLIC_KEY: publicKey }
  for (const name of ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'HOME']) {
    if (process.env[name]) env[name] = process.env[name]
  }
  return env
}

function requireRejected(execute, executable, { artifact, signaturePath, version, publicKey }, check) {
  const result = execute(executable, ['--artifact', artifact, '--signature', signaturePath, '--version', version], {
    encoding: 'utf8', env: verifierEnvironment(publicKey), timeout: 300_000, maxBuffer: 1024 * 1024,
  })
  if (!result || result.error || result.signal || result.status !== 1 || result.stdout !== '' ||
    typeof result.stderr !== 'string' || !result.stderr.startsWith('更新验签失败')) {
    fail(`更新包反例未被验签器明确拒绝：${basename(artifact)}（${check}）`)
  }
}

export function verifyUpdaterArtifacts(options, { verify = verifyArtifact, execute = spawnSync } = {}) {
  const platform = options.platform
  const version = normalizeVersion(options.version)
  const publicKey = options.publicKey?.trim()
  if (!publicKey) fail('缺少 TAURI_UPDATER_PUBLIC_KEY 公钥')
  if (!options.verifyExecutable) fail('缺少 --verify-executable')
  const wrongPublicKey = differentPublicKey(publicKey)
  const bundleRoot = options.bundleRoot ?? join(root, 'src-tauri/target/release/bundle')
  const artifacts = discoverUpdaterArtifacts(bundleRoot, platform)
  const [major, minor, patch] = version.split(/[.+-]/)
  const wrongVersion = `${major}.${minor}.${BigInt(patch) + 1n}`
  const temporary = mkdtempSync(join(tmpdir(), 'audioscript-updater-negative-'))
  try {
    const reports = artifacts.map((artifact, index) => {
      if (statSync(artifact).size === 0) fail(`更新包为空：${basename(artifact)}`)
      const signaturePath = `${artifact}.sig`
      parseSignature(readFileSync(signaturePath, 'utf8'))
      const args = { executable: options.verifyExecutable, artifact, signaturePath, version, publicKey }
      const report = verify(args)
      const sha256 = hash(readFileSync(artifact))
      if (!report || report.artifact !== basename(artifact) || report.version !== version ||
        normalizeVersion(report.signedVersion) !== version || report.sha256 !== sha256) {
        fail(`更新包验签报告不一致：${basename(artifact)}`)
      }
      const tampered = join(temporary, `${index}-${basename(artifact)}`)
      copyFileSync(artifact, tampered)
      appendFileSync(tampered, Buffer.from('\nAUDIOSCRIPT_TAMPERED_TEST\n'))
      requireRejected(execute, options.verifyExecutable, { ...args, artifact: tampered }, 'tamperedArtifact')
      rmSync(tampered)
      requireRejected(execute, options.verifyExecutable, { ...args, publicKey: wrongPublicKey }, 'wrongPublicKey')
      requireRejected(execute, options.verifyExecutable, { ...args, version: wrongVersion }, 'wrongVersion')
      return { artifact: report.artifact, version, signedVersion: report.signedVersion, sha256,
        negativeChecks: { tamperedArtifact: true, wrongPublicKey: true, wrongVersion: true } }
    })
    return { platform, version, publicKeySha256: hash(publicKey), artifacts: reports }
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

export function parseArguments(argv) {
  const options = { platform: '', verifyExecutable: '' }
  for (let i = 0; i < argv.length; i += 2) {
    const value = argv[i + 1]
    if (value === undefined) fail(`参数 ${argv[i]} 缺少值`)
    switch (argv[i]) {
      case '--platform': options.platform = value; break
      case '--verify-executable': options.verifyExecutable = value; break
      case '--bundle-root': options.bundleRoot = resolve(value); break
      case '--out': options.out = resolve(value); break
      default: fail(`未知参数 ${argv[i]}`)
    }
  }
  return options
}

export function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv)
  if (!Object.hasOwn(packages, options.platform)) fail('未知更新包验证平台')
  const out = options.out ?? join(root, '.cache/installer-verification', `${options.platform}-updater-verification.json`)
  rmSync(out, { force: true })
  const version = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8')).version
  const report = verifyUpdaterArtifacts({ ...options, version, publicKey: process.env.TAURI_UPDATER_PUBLIC_KEY })
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`)
  process.stdout.write(`${options.platform} 的 ${report.artifacts.length} 个更新包签名与三类反例全部验证通过：${out}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`更新工件验证失败：${error.message}\n`)
    process.exitCode = 1
  }
}
