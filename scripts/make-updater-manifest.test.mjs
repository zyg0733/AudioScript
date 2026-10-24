import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { buildUpdaterManifest, normalizeVersion, parseArguments, parseSignature } from './make-updater-manifest.mjs'

const script = fileURLToPath(new URL('./make-updater-manifest.mjs', import.meta.url))
const project = JSON.parse(readFileSync(new URL('../project.json', import.meta.url), 'utf8'))
// Tauri updater 的公开签名向量；不包含私钥。
const publicKey = Buffer.from('untrusted comment: minisign public key: A49EF4746FA6E6D7\nRWTX5qZvdPSepDGWg2bz8n6ArQnBMwgQK1geVosorcbLzcunD+KJ+cYe').toString('base64')
const signatureText = 'untrusted comment: signature from tauri secret key\nRUTX5qZvdPSepPF2zsjvP/L/TQtBLRnWRvaq+4omK1UEugtQp/USrGiI1v762sDy3id3aor7bRC9ETyeot6lMHHrWoZ5hjUM1Qc=\ntrusted comment: timestamp:1791649051\tfile:payload\tversion:2.0.0\nDDq2CLOEl5cQmC2eJRHlnZPVViOZsu1CjpPKQoei4A/XBfkDqGO0B+QMrcrHgEQ5qV3mne75tdFWhJpqUXh9AA=='
const signature = Buffer.from(signatureText).toString('base64')
const hash = (value) => createHash('sha256').update(value).digest('hex')

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'audioscript-manifest-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const artifact = join(dir, 'AudioScript 2.0.0.AppImage')
  writeFileSync(artifact, 'test')
  writeFileSync(`${artifact}.sig`, `${signature}\n`)
  const options = {
    version: 'v2.0.0', baseUrl: `${project.repository}/releases/download/v2.0.0/`,
    publicKey, verifyExecutable: 'fixture-verifier', now: '2026-10-24T00:00:00Z', notes: '更新说明',
    platforms: [{ target: 'linux-x86_64', artifact }],
  }
  const report = { artifact: basename(artifact), version: '2.0.0', signedVersion: '2.0.0', sha256: hash('test') }
  return { dir, artifact, options, report }
}

test('版本解析接受标准 SemVer 并拒绝含糊或不合法的版本', () => {
  for (const value of ['0.2.12', 'v2.0.0', '1.2.3-rc.1+build.2']) {
    assert.equal(normalizeVersion(value), value.replace(/^v/, ''))
  }
  for (const value of ['', '1.2', '01.2.3', '1.2.3-01', '1.2.3-', '1.2.3+', 'v1.2.3/path', ' 1.2.3', 'vv1.2.3']) {
    assert.throws(() => normalizeVersion(value), /SemVer/)
  }
})

test('清单必须使用本 fork 与当前版本标签的 HTTPS 下载目录', (t) => {
  const { options, report } = fixture(t)
  for (const baseUrl of [
    `${project.upstreamRepository}/releases/download/v2.0.0`,
    `${project.repository}/releases/download/v2.0.1`,
    `${project.repository}/releases/latest/download`,
    `${project.repository}/releases/download/v2.0.0?token=fixture`,
    `${project.repository.replace('https:', 'http:')}/releases/download/v2.0.0`,
  ]) {
    assert.throws(() => buildUpdaterManifest({ ...options, baseUrl }, () => report), /本项目仓库与当前版本标签/)
  }
})

test('重复或不合法的平台不能覆盖已有清单项', (t) => {
  const { options, report } = fixture(t)
  assert.throws(() => buildUpdaterManifest({ ...options, platforms: [...options.platforms, ...options.platforms] }, () => report), /平台重复/)
  for (const target of ['__proto__', 'linux', 'linux-x86_64/other', 'Linux-x86_64']) {
    assert.throws(() => buildUpdaterManifest({ ...options, platforms: [{ ...options.platforms[0], target }] }, () => report), /平台标识无效/)
  }
})

test('缺少公钥、验签程序或更新包时不能生成清单', (t) => {
  const { options, report } = fixture(t)
  for (const [change, message] of [
    [{ publicKey: '' }, /TAURI_UPDATER_PUBLIC_KEY/],
    [{ verifyExecutable: '' }, /verify-executable/],
    [{ platforms: [] }, /至少需要一个/],
  ]) assert.throws(() => buildUpdaterManifest({ ...options, ...change }, () => report), message)
})

test('签名必须包含合法 base64、算法、完整 minisign 签名和全局签名', () => {
  assert.equal(parseSignature(`${signature}\n`), signature)
  for (const value of ['', 'not a signature', `${signature}!`, Buffer.from('plain text').toString('base64')]) {
    assert.throws(() => parseSignature(value))
  }
  for (const text of [
    signatureText.replace('RUTX', 'AATX'),
    signatureText.replace('trusted comment: timestamp:', 'untrusted timestamp:'),
    signatureText.split('\n').slice(0, 3).join('\n'),
    `${signatureText}\nextra`,
    signatureText.replace(/\n[^\n]+$/, '\nAAAA'),
  ]) assert.throws(() => parseSignature(Buffer.from(text).toString('base64')))
})

test('不存在、空更新包或空签名均拒绝，尚未调用验签程序', (t) => {
  const { artifact, options } = fixture(t)
  let calls = 0
  const verify = () => { calls++; assert.fail('不能对无效输入开始验签') }
  writeFileSync(`${artifact}.sig`, '')
  assert.throws(() => buildUpdaterManifest(options, verify), /签名不可用/)
  writeFileSync(`${artifact}.sig`, signature)
  writeFileSync(artifact, '')
  assert.throws(() => buildUpdaterManifest(options, verify), /非空文件/)
  rmSync(artifact)
  assert.throws(() => buildUpdaterManifest(options, verify), /签名不可用/)
  assert.equal(calls, 0)
})

test('平台别名共享同一已验签资产，清单引用准确签名和编码后的文件名', (t) => {
  const { artifact, options, report } = fixture(t)
  const calls = []
  const result = buildUpdaterManifest({ ...options, platforms: [
    ...options.platforms, { target: 'linux-x86_64-appimage', artifact },
  ] }, (args) => { calls.push(args); return report })
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], {
    executable: options.verifyExecutable, artifact, signaturePath: `${artifact}.sig`, version: '2.0.0', publicKey,
  })
  assert.equal(result.manifest.version, '2.0.0')
  assert.equal(result.manifest.pub_date, '2026-10-24T00:00:00.000Z')
  assert.equal(result.manifest.notes, '更新说明')
  assert.deepEqual(result.manifest.platforms['linux-x86_64'], {
    signature, url: `${project.repository}/releases/download/v2.0.0/AudioScript%202.0.0.AppImage`,
  })
  assert.deepEqual(result.manifest.platforms['linux-x86_64-appimage'], result.manifest.platforms['linux-x86_64'])
  assert.deepEqual(result.verification, [report])
})

test('所有唯一更新包都必须通过验签，不能遗漏第二个资产', (t) => {
  const { dir, options, report } = fixture(t)
  const other = join(dir, 'AudioScript_2.0.0_x64-setup.exe')
  writeFileSync(other, 'second payload')
  writeFileSync(`${other}.sig`, signature)
  let calls = 0
  assert.throws(() => buildUpdaterManifest({ ...options, platforms: [
    ...options.platforms, { target: 'windows-x86_64', artifact: other },
  ] }, () => { if (calls++ === 0) return report; throw new Error('第二个包验签失败') }), /第二个包验签失败/)
  assert.equal(calls, 2)
})

test('验签报告必须匹配清单版本、可信签名版本、实际文件名和 SHA-256', (t) => {
  const { options, report } = fixture(t)
  for (const change of [
    { version: '2.0.1' }, { signedVersion: '2.0.1' }, { signedVersion: '' },
    { artifact: 'other.AppImage' }, { sha256: '0'.repeat(64) },
  ]) assert.throws(() => buildUpdaterManifest(options, () => ({ ...report, ...change })))
})

test('CLI 参数拒绝未知选项、缺值及缺少更新包路径', () => {
  for (const argv of [['--version'], ['--unknown', 'x'], ['--platform', 'linux-x86_64=']]) {
    assert.throws(() => parseArguments(argv))
  }
  assert.equal(parseArguments(['--verify-executable', '/tmp/verifier']).verifyExecutable, '/tmp/verifier')
})

function cli(t, code, extraEnv = {}) {
  const data = fixture(t)
  const executable = join(data.dir, 'fixture-verifier')
  writeFileSync(executable, `#!${process.execPath}\n${code}`, { mode: 0o755 })
  const out = join(data.dir, 'latest.json')
  const result = spawnSync(process.execPath, [script,
    '--version', data.options.version, '--base-url', data.options.baseUrl,
    '--verify-executable', executable, '--out', out,
    '--platform', `linux-x86_64=${data.artifact}`,
  ], { encoding: 'utf8', env: { ...process.env, TAURI_UPDATER_PUBLIC_KEY: publicKey, ...extraEnv } })
  return { ...data, ...result, out }
}

test('CLI 必须实际执行验签程序，且验签子进程不继承无关 Secret', (t) => {
  const result = cli(t, `
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
if (process.env.UNRELATED_TEST_SECRET || !process.env.TAURI_UPDATER_PUBLIC_KEY) process.exit(8)
const args = process.argv.slice(2)
const value = (flag) => args[args.indexOf(flag) + 1]
if (!fs.existsSync(value('--signature')) || args.includes('--allow-unversioned')) process.exit(9)
process.stdout.write(JSON.stringify({ artifact: path.basename(value('--artifact')), version: value('--version'),
  signedVersion: value('--version'), sha256: crypto.createHash('sha256').update(fs.readFileSync(value('--artifact'))).digest('hex') }))
`, { UNRELATED_TEST_SECRET: 'SYNTHETIC_TEST_ONLY' })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(readFileSync(result.out, 'utf8')).version, '2.0.0')
  assert.match(result.stdout, /1 个更新包完整验签通过/)
})

test('CLI 验签失败或报告不是 JSON 时不得写出 latest.json', (t) => {
  for (const code of ['process.exit(7)', 'process.stdout.write("not-json")']) {
    const result = cli(t, code)
    assert.notEqual(result.status, 0)
    assert.equal(existsSync(result.out), false)
    assert.match(result.stderr, /验签/)
  }
})
