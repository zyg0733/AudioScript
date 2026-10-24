import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { main, prepareSignedRelease } from './prepare-signed-release.mjs'

const config = JSON.parse(await readFile(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8'))
const project = JSON.parse(await readFile(new URL('../project.json', import.meta.url), 'utf8'))
const { version, identifier, productName } = config
const sha = (value) => createHash('sha256').update(value).digest('hex')
const publicBytes = Buffer.alloc(42, 1)
publicBytes.write('Ed')
const publicKey = Buffer.from(`untrusted comment: synthetic public key fixture\n${publicBytes.toString('base64')}`).toString('base64')
const publicKeySha256 = sha(publicKey)
const output = `ASR 定稿 [0–4690 ms]：测试语音
ASR 投喂与收尾通过（1 段）
NMT en→zh 会话模型初始化预算通过：ASR + NMT = 1250 ms，预算 45000 ms
NMT en→zh：Hello, world. → 你好,世界。
NMT zh→en 会话模型初始化预算通过：ASR + NMT = 1300 ms，预算 45000 ms
NMT zh→en：今天天气很好。 → It's a nice day.
模型冒烟验证通过（2000 ms）`
const platforms = [
  { platform: 'macos-arm64', artifact: 'macOS-ARM', format: 'Mach-O arm64',
    files: [`${productName}_${version}_aarch64.dmg`], paths: [''],
    updates: [{ directory: 'updater-macOS-ARM', file: `${productName}.app.tar.gz`, targets: ['darwin-aarch64', 'darwin-aarch64-app'] }] },
  { platform: 'windows-x64', artifact: 'Windows-x64', format: 'PE x86_64',
    files: [`${productName}_${version}_x64-setup.exe`, `${productName}_${version}_x64_en-US.msi`], paths: ['nsis', 'msi'],
    updates: [
      { directory: 'updater-Windows-x64', index: 0, targets: ['windows-x86_64', 'windows-x86_64-nsis'] },
      { directory: 'updater-Windows-x64-msi', index: 1, targets: ['windows-x86_64-msi'] },
    ] },
  { platform: 'linux-x64', artifact: 'Linux-x64', format: 'ELF x86_64',
    files: [`${productName}_${version}_amd64.deb`, `${productName}_${version}_amd64.AppImage`], paths: ['deb', 'appimage'],
    updates: [
      { directory: 'updater-Linux-x64', index: 1, targets: ['linux-x86_64', 'linux-x86_64-appimage'] },
      { directory: 'updater-Linux-x64-deb', index: 0, targets: ['linux-x86_64-deb'] },
    ] },
]

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'audioscript-release-stage-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const write = async (relative, text) => {
    const path = join(root, relative)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, typeof text === 'string' ? text : `${JSON.stringify(text, null, 2)}\n`)
    return path
  }
  const edit = async (relative, mutate) => {
    const data = JSON.parse(await readFile(join(root, relative), 'utf8'))
    mutate(data)
    await write(relative, data)
  }
  const manifest = { version, notes: '回归测试', pub_date: '2026-10-24T00:00:00Z', platforms: {} }
  const manifestVerification = { version, artifacts: [] }
  for (const platform of platforms) {
    const verificationDir = `verification-${platform.artifact}`
    const installers = []
    for (const [index, file] of platform.files.entries()) {
      const body = `synthetic installer fixture: ${file}`
      await write(`AudioScript-${platform.artifact}/${platform.paths[index]}/${file}`, body)
      const entry = { file, bytes: Buffer.byteLength(body), sha256: sha(body), format: platform.format,
        modelFiles: 1, smoke: 'passed', smokeRuns: [{ mode: 'default', output }] }
      if (!file.endsWith('.AppImage')) entry.version = version
      if (platform.platform !== 'macos-arm64') entry.smokeRuns.push({ mode: 'mkl-disabled', output })
      if (platform.platform === 'macos-arm64') Object.assign(entry, {
        identifier, minimumSystemVersion: config.bundle.macOS.minimumSystemVersion, codeSignature: 'verified',
      })
      installers.push(entry)
    }
    await write(`${verificationDir}/${platform.platform}-verification.json`, {
      platform: platform.platform, version, identity: identifier, smokeRequested: true, installers,
      models: [{ path: 'fixture-model.bin', sha256: sha('synthetic model fixture') }],
    })
    await write(`${verificationDir}/${platform.platform}-SHA256SUMS.txt`, installers.map((entry) => `${entry.sha256}  ${entry.file}\n`).join(''))
    const updaterReport = { platform: platform.platform, version, publicKeySha256, artifacts: [] }
    for (const update of platform.updates) {
      const file = update.file ?? platform.files[update.index]
      const body = update.file ? `synthetic updater fixture: ${file}` : `synthetic installer fixture: ${file}`
      const signature = Buffer.from(`synthetic signature fixture: ${file}`).toString('base64')
      await write(`${update.directory}/${file}`, body)
      await write(`${update.directory}/${file}.sig`, `${signature}\n`)
      const report = { artifact: file, version, signedVersion: version, sha256: sha(body) }
      manifestVerification.artifacts.push(report)
      updaterReport.artifacts.push({ ...report,
        negativeChecks: { tamperedArtifact: true, wrongPublicKey: true, wrongVersion: true } })
      for (const target of update.targets) manifest.platforms[target] = {
        url: `${project.repository}/releases/download/v${version}/${encodeURIComponent(file)}`, signature,
      }
    }
    await write(`${verificationDir}/${platform.platform}-updater-verification.json`, updaterReport)
  }
  await write('latest.json', manifest)
  await write('latest.json.verification.json', manifestVerification)
  const options = { artifactRoot: root, publicKey, now: '2026-10-24T01:00:00Z', env: {
    GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: project.repository.split('github.com/')[1],
    GITHUB_SHA: 'a'.repeat(40), GITHUB_RUN_ID: '123456',
  } }
  return { root, write, edit, options, stage: () => prepareSignedRelease(options) }
}

test('完整工件通过后生成同一批安装器、签名、报告和校验清单', async (t) => {
  const data = await fixture(t)
  const report = await data.stage()
  assert.equal(report.repository, data.options.env.GITHUB_REPOSITORY)
  assert.equal(report.version, version)
  assert.equal(report.tag, `v${version}`)
  assert.equal(report.commit, 'a'.repeat(40))
  assert.equal(report.runUrl, `${project.repository}/actions/runs/123456`)
  assert.equal(report.publicKeySha256, publicKeySha256)
  assert.equal(report.files.length, 22)
  const names = await readdir(join(data.root, 'release-files'))
  assert.equal(names.length, 24)
  const checksums = (await readFile(join(data.root, 'release-files', 'SHA256SUMS.txt'), 'utf8')).trim().split('\n')
  assert.equal(checksums.length, 23)
  for (const line of checksums) {
    const [, expected, name] = /^([a-f0-9]{64})  (.+)$/.exec(line)
    assert.equal(sha(await readFile(join(data.root, 'release-files', name))), expected)
  }
  for (const entry of report.files) assert.equal(sha(await readFile(join(data.root, 'release-files', entry.file))), entry.sha256)
})

test('只信任源码配置，不接受工件根目录的仓库或版本配置', async (t) => {
  const data = await fixture(t)
  await data.write('project.json', { repository: 'https://github.com/other/project' })
  await data.write('src-tauri/tauri.conf.json', { version: '999.0.0', identifier: 'other' })
  const report = await data.stage()
  assert.equal(report.version, version)
  assert.equal(report.repository, data.options.env.GITHUB_REPOSITORY)
})

test('更新清单必须恰好包含八个平台别名，并准确引用本 fork 的版本和原始签名', async (t) => {
  const mutations = [
    (manifest) => { delete manifest.platforms['darwin-aarch64-app'] },
    (manifest) => { manifest.platforms['linux-other'] = manifest.platforms['linux-x86_64'] },
    (manifest) => { manifest.platforms['windows-x86_64'].url = manifest.platforms['windows-x86_64'].url.replace(project.repository, project.upstreamRepository) },
    (manifest) => { manifest.platforms['linux-x86_64-deb'].url += '?token=fixture' },
    (manifest) => { manifest.platforms['darwin-aarch64'].signature = 'different-signature' },
    (manifest) => { manifest.version = '999.0.0' },
  ]
  for (const mutate of mutations) {
    const data = await fixture(t)
    await data.edit('latest.json', mutate)
    await assert.rejects(data.stage())
    assert.equal(existsSync(join(data.root, 'release-files')), false)
  }
})

test('更新清单验签报告必须覆盖五个唯一资产及准确签名版本和实际 SHA', async (t) => {
  for (const mutate of [
    (report) => report.artifacts.pop(),
    (report) => report.artifacts.push(report.artifacts[0]),
    (report) => { report.artifacts[0].sha256 = '0'.repeat(64) },
    (report) => { report.artifacts[0].signedVersion = '999.0.0' },
    (report) => { report.version = '999.0.0' },
  ]) {
    const data = await fixture(t)
    await data.edit('latest.json.verification.json', mutate)
    await assert.rejects(data.stage())
  }
})

test('平台更新验签报告必须来自相同公钥且每个反例全部通过', async (t) => {
  for (const mutate of [
    (report) => { report.publicKeySha256 = '0'.repeat(64) },
    (report) => { report.version = '999.0.0' },
    (report) => { report.artifacts[0].negativeChecks.wrongPublicKey = false },
    (report) => { delete report.artifacts[0].negativeChecks.wrongVersion },
    (report) => { report.artifacts[0].sha256 = '0'.repeat(64) },
    (report) => report.artifacts.pop(),
  ]) {
    const data = await fixture(t)
    await data.edit('verification-Windows-x64/windows-x64-updater-verification.json', mutate)
    await assert.rejects(data.stage())
  }
})

test('缺少签名、同名额外资产或安装器与更新器副本不一致时拒绝汇总', async (t) => {
  for (const mutate of [
    async (data) => rm(join(data.root, `updater-macOS-ARM/${productName}.app.tar.gz.sig`)),
    async (data) => data.write(`AudioScript-Windows-x64/extra/${platforms[1].files[0]}`, 'extra duplicate'),
    async (data) => data.write(`updater-Windows-x64/${platforms[1].files[0]}`, 'different payload'),
    async (data) => data.write(`updater-Linux-x64/extra/${platforms[2].files[1]}`, 'extra duplicate'),
  ]) {
    const data = await fixture(t)
    await mutate(data)
    await assert.rejects(data.stage())
  }
})

test('安装包报告必须匹配应用身份、模型数量、真实语音和双模式预算验证', async (t) => {
  for (const mutate of [
    (report) => { report.identity = 'other.app' },
    (report) => { report.smokeRequested = false },
    (report) => { report.installers[0].sha256 = '0'.repeat(64) },
    (report) => { report.installers[0].modelFiles = 99 },
    (report) => { report.installers[0].smoke = 'not requested' },
    (report) => report.installers[0].smokeRuns.pop(),
    (report) => { report.installers[0].smokeRuns[0].output = output.replace('1250 ms', '45001 ms') },
    (report) => { report.installers[0].smokeRuns[0].output = output.replace('预算 45000 ms', '预算 99999 ms') },
    (report) => { report.installers[0].smokeRuns[0].output = output.replace('ASR 定稿', '省略语音') },
    (report) => { report.installers[0].smokeRuns[0].output = output.replace('NMT zh→en：', '省略反向：') },
  ]) {
    const data = await fixture(t)
    await data.edit('verification-Linux-x64/linux-x64-verification.json', mutate)
    await assert.rejects(data.stage())
  }
})

test('macOS 必须完成应用资源签名校验且 SHA256SUMS 不能与实际包不一致', async (t) => {
  const data = await fixture(t)
  await data.edit('verification-macOS-ARM/macos-arm64-verification.json', (report) => { report.installers[0].codeSignature = 'skipped' })
  await assert.rejects(data.stage(), /资源签名/)
  const other = await fixture(t)
  await other.write('verification-macOS-ARM/macos-arm64-SHA256SUMS.txt', `${'0'.repeat(64)}  ${platforms[0].files[0]}\n`)
  await assert.rejects(other.stage(), /SHA256SUMS/)
})

test('拒绝符号链接，并保留已存在的发布目录', async (t) => {
  const data = await fixture(t)
  const file = `AudioScript-macOS-ARM/${platforms[0].files[0]}`
  await rm(join(data.root, file))
  await data.write('outside-file', 'symlink target')
  await symlink(join(data.root, 'outside-file'), join(data.root, file))
  await assert.rejects(data.stage(), /符号链接/)
  const other = await fixture(t)
  await other.write('release-files/keep.txt', 'existing content')
  await assert.rejects(other.stage())
  assert.equal(await readFile(join(other.root, 'release-files/keep.txt'), 'utf8'), 'existing content')
})

test('CI 源仓库、准确提交和运行编号必须完整，参数必须明确', async (t) => {
  for (const override of [{ GITHUB_REPOSITORY: 'other/project' }, { GITHUB_SHA: '' }, { GITHUB_RUN_ID: '' }]) {
    const data = await fixture(t)
    data.options.env = { ...data.options.env, ...override }
    await assert.rejects(data.stage())
  }
  for (const args of [['--unknown', 'x'], ['--artifact-root'], ['--output-dir', 'x', '--output-dir', 'y']]) {
    await assert.rejects(main(args))
  }
})
