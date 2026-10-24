import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { differentPublicKey, discoverUpdaterArtifacts, parseArguments, verifyUpdaterArtifacts } from './verify-updater-artifacts.mjs'

const script = fileURLToPath(new URL('./verify-updater-artifacts.mjs', import.meta.url))
const publicKey = Buffer.from('untrusted comment: minisign public key: A49EF4746FA6E6D7\nRWTX5qZvdPSepDGWg2bz8n6ArQnBMwgQK1geVosorcbLzcunD+KJ+cYe').toString('base64')
const signature = Buffer.from('untrusted comment: signature from tauri secret key\nRUTX5qZvdPSepPF2zsjvP/L/TQtBLRnWRvaq+4omK1UEugtQp/USrGiI1v762sDy3id3aor7bRC9ETyeot6lMHHrWoZ5hjUM1Qc=\ntrusted comment: timestamp:1791649051\tfile:payload\tversion:2.0.0\nDDq2CLOEl5cQmC2eJRHlnZPVViOZsu1CjpPKQoei4A/XBfkDqGO0B+QMrcrHgEQ5qV3mne75tdFWhJpqUXh9AA==').toString('base64')
const hash = (value) => createHash('sha256').update(value).digest('hex')
const rejected = () => ({ status: 1, stdout: '', stderr: '更新验签失败：更新包或签名校验失败\n' })

function fixture(t, platform = 'linux-x64') {
  const dir = mkdtempSync(join(tmpdir(), 'audioscript-updater-gate-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const names = {
    'macos-arm64': ['macos/AudioScript.app.tar.gz'],
    'windows-x64': ['nsis/AudioScript_2.0.0_x64-setup.exe', 'msi/AudioScript_2.0.0_x64_en-US.msi'],
    'linux-x64': ['appimage/AudioScript_2.0.0_amd64.AppImage', 'deb/AudioScript_2.0.0_amd64.deb'],
  }
  const artifacts = names[platform].map((name) => {
    const path = join(dir, name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, 'test')
    writeFileSync(`${path}.sig`, signature)
    return path
  })
  const options = { platform, bundleRoot: dir, version: '2.0.0', publicKey, verifyExecutable: 'fixture-verifier' }
  const verify = ({ artifact, version }) => ({ artifact: basename(artifact), version, signedVersion: version,
    sha256: hash(readFileSync(artifact)) })
  return { dir, artifacts, options, verify }
}

test('每个平台要求每类更新包恰好一个，并忽略对应 .sig 文件', (t) => {
  for (const platform of ['macos-arm64', 'windows-x64', 'linux-x64']) {
    const { dir, artifacts } = fixture(t, platform)
    assert.deepEqual(discoverUpdaterArtifacts(dir, platform), artifacts)
    rmSync(artifacts[0])
    assert.throws(() => discoverUpdaterArtifacts(dir, platform), /必须恰好一个/)
    writeFileSync(artifacts[0], 'test')
    writeFileSync(join(dirname(artifacts[0]), `extra-${basename(artifacts[0])}`), 'test')
    assert.throws(() => discoverUpdaterArtifacts(dir, platform), /必须恰好一个/)
  }
  assert.throws(() => discoverUpdaterArtifacts('/missing', 'unknown'), /未知/)
  assert.throws(() => discoverUpdaterArtifacts('/missing', 'linux-x64'), /缺少/)
})

test('错误公钥保持合法封装、算法和 ID，只替换实际公钥字节', () => {
  const changed = differentPublicKey(publicKey)
  const originalPacket = Buffer.from(Buffer.from(publicKey, 'base64').toString('utf8').split('\n')[1], 'base64')
  const changedPacket = Buffer.from(Buffer.from(changed, 'base64').toString('utf8').split('\n')[1], 'base64')
  assert.equal(changedPacket.length, 42)
  assert.deepEqual(changedPacket.subarray(0, 10), originalPacket.subarray(0, 10))
  assert.notDeepEqual(changedPacket.subarray(10), originalPacket.subarray(10))
  assert.notEqual(differentPublicKey(changed), changed)
  for (const invalid of ['', 'invalid', `${publicKey}!`, Buffer.from('plain text').toString('base64')]) {
    assert.throws(() => differentPublicKey(invalid), /公钥/)
  }
})

test('每个包真实正向验签，并在临时副本上执行篡改、错公钥和错版本反例', (t) => {
  const { artifacts, options, verify } = fixture(t)
  const calls = []
  const temporaryPaths = []
  let positiveCalls = 0
  const report = verifyUpdaterArtifacts(options, {
    verify: (args) => { positiveCalls++; return verify(args) },
    execute: (executable, args, runOptions) => {
      assert.equal(executable, options.verifyExecutable)
      const value = (flag) => args[args.indexOf(flag) + 1]
      const mode = calls.length % 3
      const original = artifacts[Math.floor(calls.length / 3)]
      assert.equal(value('--signature'), `${original}.sig`)
      assert.equal(runOptions.env.TAURI_UPDATER_PUBLIC_KEY, mode === 1 ? differentPublicKey(publicKey) : publicKey)
      assert.equal(value('--version'), mode === 2 ? '2.0.1' : '2.0.0')
      assert.ok(!args.includes('--allow-unversioned'))
      assert.ok(Object.keys(runOptions.env).every((name) => ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'TAURI_UPDATER_PUBLIC_KEY'].includes(name)))
      if (mode === 0) {
        assert.notEqual(value('--artifact'), original)
        assert.equal(readFileSync(original, 'utf8'), 'test')
        assert.ok(readFileSync(value('--artifact'), 'utf8').startsWith('test\nAUDIOSCRIPT_TAMPERED_TEST'))
        temporaryPaths.push(value('--artifact'))
      } else assert.equal(value('--artifact'), original)
      calls.push(args)
      return rejected()
    },
  })
  assert.equal(positiveCalls, 2)
  assert.equal(calls.length, 6)
  assert.equal(report.platform, 'linux-x64')
  assert.equal(report.version, '2.0.0')
  assert.equal(report.publicKeySha256, hash(publicKey))
  assert.equal(report.artifacts.length, 2)
  for (const artifact of report.artifacts) {
    assert.equal(artifact.version, '2.0.0')
    assert.equal(artifact.signedVersion, '2.0.0')
    assert.equal(artifact.sha256, hash('test'))
    assert.deepEqual(artifact.negativeChecks, { tamperedArtifact: true, wrongPublicKey: true, wrongVersion: true })
  }
  for (const path of temporaryPaths) {
    assert.equal(existsSync(path), false)
    assert.equal(existsSync(dirname(path)), false)
  }
  for (const artifact of artifacts) assert.equal(readFileSync(artifact, 'utf8'), 'test')
})

test('正向报告版本、签名版本、文件名或 SHA 不一致时不能通过 gate', (t) => {
  const { options, verify } = fixture(t)
  for (const change of [{ version: '2.0.1' }, { signedVersion: '2.0.1' }, { artifact: 'wrong' }, { sha256: '0'.repeat(64) }]) {
    assert.throws(() => verifyUpdaterArtifacts(options, {
      verify: (args) => ({ ...verify(args), ...change }), execute: () => assert.fail('正向报告异常时不应执行反例'),
    }), /报告不一致/)
  }
})

test('进程启动失败、错误退出码、空错误或 stdout 有输出都不能冒充反例验签成功', (t) => {
  const { options, verify } = fixture(t)
  for (const result of [
    { error: new Error('spawn failed'), status: null, stdout: '', stderr: '' },
    { status: 0, stdout: '', stderr: '更新验签失败' },
    { status: 2, stdout: '', stderr: '更新验签失败' },
    { status: 1, stdout: 'unexpected', stderr: '更新验签失败' },
    { status: 1, stdout: '', stderr: 'other program failed' },
    { status: 1, signal: 'SIGTERM', stdout: '', stderr: '更新验签失败' },
  ]) {
    let temporary
    assert.throws(() => verifyUpdaterArtifacts(options, {
      verify, execute: (_executable, args) => { temporary = args[args.indexOf('--artifact') + 1]; return result },
    }), /未被验签器明确拒绝/)
    assert.equal(existsSync(dirname(temporary)), false)
  }
})

test('三个反例任意一个未被拒绝都必须中止，不能忽略后续反例', (t) => {
  const { options, verify } = fixture(t)
  for (const failureAt of [0, 1, 2, 5]) {
    let calls = 0
    assert.throws(() => verifyUpdaterArtifacts(options, {
      verify, execute: () => calls++ === failureAt ? { status: 0, stdout: '{}', stderr: '' } : rejected(),
    }), /未被验签器明确拒绝/)
    assert.equal(calls, failureAt + 1)
  }
})

test('空包、缺签名、坏签名和缺少配置均不能调用正向验签器', (t) => {
  const { artifacts, options, verify } = fixture(t)
  for (const change of [{ publicKey: '' }, { verifyExecutable: '' }]) {
    assert.throws(() => verifyUpdaterArtifacts({ ...options, ...change }, { verify, execute: rejected }))
  }
  writeFileSync(artifacts[0], '')
  assert.throws(() => verifyUpdaterArtifacts(options, { verify: () => assert.fail('空包不能验签') }), /为空/)
  writeFileSync(artifacts[0], 'test')
  rmSync(`${artifacts[0]}.sig`)
  assert.throws(() => verifyUpdaterArtifacts(options, { verify: () => assert.fail('无签名不能验签') }))
  writeFileSync(`${artifacts[0]}.sig`, 'bad-signature')
  assert.throws(() => verifyUpdaterArtifacts(options, { verify: () => assert.fail('坏签名不能验签') }), /签名/)
})

test('CLI 参数接受平台和验签路径，拒绝缺值、未知选项和版本覆盖', () => {
  assert.equal(parseArguments(['--platform', 'linux-x64', '--verify-executable', '/tmp/verify']).platform, 'linux-x64')
  for (const args of [['--platform'], ['--unknown', 'x'], ['--version', '2.0.0']]) assert.throws(() => parseArguments(args))
})

test('CLI gate 失败不写报告，并移除上次可能遗留的成功报告', (t) => {
  const { dir } = fixture(t)
  const out = join(dir, 'verification.json')
  writeFileSync(out, 'STALE_REPORT')
  const result = spawnSync(process.execPath, [script, '--platform', 'linux-x64', '--bundle-root', dir,
    '--verify-executable', join(dir, 'missing-verifier'), '--out', out], {
    encoding: 'utf8', env: { ...process.env, TAURI_UPDATER_PUBLIC_KEY: publicKey },
  })
  assert.notEqual(result.status, 0)
  assert.equal(existsSync(out), false)
  assert.match(result.stderr, /更新工件验证失败/)
})
