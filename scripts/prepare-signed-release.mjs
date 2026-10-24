#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const TARGETS = {
  'darwin-aarch64': 'macos-arm64',
  'darwin-aarch64-app': 'macos-arm64',
  'windows-x86_64': 'windows-nsis',
  'windows-x86_64-nsis': 'windows-nsis',
  'windows-x86_64-msi': 'windows-msi',
  'linux-x86_64': 'linux-appimage',
  'linux-x86_64-appimage': 'linux-appimage',
  'linux-x86_64-deb': 'linux-deb',
}
const NEGATIVE_CHECKS = ['tamperedArtifact', 'wrongPublicKey', 'wrongVersion']
const HASH = /^[a-f0-9]{64}$/
const hash = (value) => createHash('sha256').update(value).digest('hex')

function exactNames(actual, expected, message) {
  assert.deepEqual([...actual].sort(), [...expected].sort(), message)
}

async function json(path) {
  return JSON.parse(await readFile(path, 'utf8'))
}

async function filesUnder(directory) {
  assert.ok((await lstat(directory)).isDirectory(), '发布工件目录无效或为符号链接')
  const result = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    assert.ok(!entry.isSymbolicLink(), `发布工件不能是符号链接：${entry.name}`)
    if (entry.isDirectory()) result.push(...await filesUnder(path))
    else {
      assert.ok(entry.isFile(), `发布工件不是普通文件：${entry.name}`)
      result.push(path)
    }
  }
  return result
}

async function fileInfo(path) {
  const info = await lstat(path)
  assert.ok(info.isFile() && info.size > 0, `发布工件必须是非空普通文件：${basename(path)}`)
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path)) digest.update(chunk)
  return { file: basename(path), bytes: info.size, sha256: digest.digest('hex') }
}

function publicKeyFingerprint(publicKey) {
  const key = publicKey?.trim()
  assert.ok(key && /^[A-Za-z0-9+/]+={0,2}$/.test(key), '缺少或无效的 TAURI_UPDATER_PUBLIC_KEY 公钥')
  const envelope = Buffer.from(key, 'base64')
  assert.equal(envelope.toString('base64'), key, '更新公钥 base64 格式无效')
  const lines = envelope.toString('utf8').trim().split(/\r?\n/)
  const bytes = Buffer.from(lines[1] ?? '', 'base64')
  assert.ok(lines.length === 2 && lines[0].startsWith('untrusted comment:') &&
    bytes.length === 42 && ['Ed', 'ED'].includes(bytes.subarray(0, 2).toString()), '更新公钥格式无效')
  return hash(key)
}

export function verifySmokeRuns(installer, platform) {
  assert.equal(installer.smoke, 'passed', '安装包模型冒烟未通过')
  assert.ok(Array.isArray(installer.smokeRuns), '缺少安装包模型冒烟详情')
  exactNames(installer.smokeRuns.map((run) => run.mode),
    platform === 'macos-arm64' ? ['default'] : ['default', 'mkl-disabled'], '安装包模型冒烟模式不完整或重复')
  for (const { output } of installer.smokeRuns) {
    assert.equal(typeof output, 'string', '模型冒烟输出无效')
    assert.match(output, /ASR 定稿 \[[^\]]+\]：\S/, '缺少真实语音识别结果')
    assert.match(output, /ASR 投喂与收尾通过（[1-9]\d* 段）/, '语音收尾检查未通过')
    assert.match(output, /模型冒烟验证通过（\d+ ms）/, '模型冒烟未完整结束')
    const directions = []
    for (const match of output.matchAll(/NMT (en→zh|zh→en) 会话模型初始化预算通过：ASR \+ NMT = (\d+) ms，预算 (\d+) ms/g)) {
      assert.equal(Number(match[3]), 45_000, '会话模型初始化预算错误')
      assert.ok(Number(match[2]) <= 45_000, '会话模型初始化超过预算')
      directions.push(match[1])
    }
    exactNames(directions, ['en→zh', 'zh→en'], '双向翻译初始化预算未完整通过')
    for (const direction of ['en→zh', 'zh→en']) {
      assert.ok(output.split('\n').some((line) => line.startsWith(`NMT ${direction}：`) && line.includes(' → ')),
        '缺少双向翻译推理结果')
    }
  }
}

function checkVerification(entry, name, version, sha256) {
  assert.ok(entry && entry.artifact === name && entry.version === version && entry.signedVersion === version &&
    entry.sha256 === sha256, `更新验签报告与实际资产或版本不一致：${name}`)
}

function uniqueEntries(entries, expected, nameKey, message) {
  assert.ok(Array.isArray(entries), message)
  exactNames(entries.map((entry) => entry[nameKey]), expected, message)
  return new Map(entries.map((entry) => [entry[nameKey], entry]))
}

export async function prepareSignedRelease({ artifactRoot = process.cwd(), outputDir,
  publicKey = process.env.TAURI_UPDATER_PUBLIC_KEY, env = process.env, now = new Date() } = {}) {
  artifactRoot = resolve(artifactRoot)
  outputDir = resolve(outputDir ?? join(artifactRoot, 'release-files'))
  const project = await json(join(ROOT, 'project.json'))
  const config = await json(join(ROOT, 'src-tauri', 'tauri.conf.json'))
  const { version, identifier, productName } = config
  assert.match(version, /^\d+\.\d+\.\d+$/, '签名正式发布版本格式无效')
  const repository = project.repository.replace(/^https:\/\/github\.com\//, '')
  assert.equal(project.repository, `https://github.com/${repository}`, '项目仓库地址无效')
  assert.match(repository, /^[\w.-]+\/[\w.-]+$/, '项目仓库标识无效')
  if (env.GITHUB_REPOSITORY) assert.equal(env.GITHUB_REPOSITORY, repository, 'CI 仓库与本项目不一致')
  if (env.GITHUB_ACTIONS === 'true') {
    assert.match(env.GITHUB_SHA ?? '', /^[a-f0-9]{40}$/, 'CI 发布缺少准确提交 SHA')
    assert.match(env.GITHUB_RUN_ID ?? '', /^[1-9]\d*$/, 'CI 发布缺少工作流运行编号')
  }
  const publicKeySha256 = publicKeyFingerprint(publicKey)
  const manifestPath = join(artifactRoot, 'latest.json')
  const manifestVerificationPath = `${manifestPath}.verification.json`
  const manifest = await json(manifestPath)
  const manifestVerification = await json(manifestVerificationPath)
  assert.equal(manifest.version, version, '更新清单版本与源码版本不一致')
  assert.equal(manifestVerification.version, version, '更新清单验签版本与源码版本不一致')
  assert.ok(manifest.platforms && typeof manifest.platforms === 'object', '缺少更新清单平台')
  exactNames(Object.keys(manifest.platforms), Object.keys(TARGETS), '更新清单必须恰好包含八个平台及别名')
  assert.ok(typeof manifest.pub_date === 'string' && !Number.isNaN(Date.parse(manifest.pub_date)), '更新清单发布日期无效')

  const platforms = [
    { platform: 'macos-arm64', artifact: 'macOS-ARM', format: 'Mach-O arm64',
      installers: [`${productName}_${version}_aarch64.dmg`] },
    { platform: 'windows-x64', artifact: 'Windows-x64', format: 'PE x86_64',
      installers: [`${productName}_${version}_x64-setup.exe`, `${productName}_${version}_x64_en-US.msi`] },
    { platform: 'linux-x64', artifact: 'Linux-x64', format: 'ELF x86_64',
      installers: [`${productName}_${version}_amd64.deb`, `${productName}_${version}_amd64.AppImage`] },
  ]
  const staged = new Map()
  async function stage(path, role, allowInstallerDuplicate = false) {
    const info = await fileInfo(path)
    assert.match(info.file, /^[A-Za-z0-9][A-Za-z0-9._+-]*$/, '发布文件名含不安全字符')
    const previous = staged.get(info.file)
    if (previous) {
      assert.ok(allowInstallerDuplicate && previous.role === 'installer' && previous.sha256 === info.sha256 &&
        previous.bytes === info.bytes, `发布文件名冲突或副本不一致：${info.file}`)
    } else staged.set(info.file, { ...info, source: path, role })
    return info
  }
  const installerInfo = new Map()
  const updaterReports = new Map()
  for (const platform of platforms) {
    const verificationDir = join(artifactRoot, `verification-${platform.artifact}`)
    const reportPath = join(verificationDir, `${platform.platform}-verification.json`)
    const updaterReportPath = join(verificationDir, `${platform.platform}-updater-verification.json`)
    const checksumPath = join(verificationDir, `${platform.platform}-SHA256SUMS.txt`)
    const report = await json(reportPath)
    const updaterReport = await json(updaterReportPath)
    assert.equal(report.platform, platform.platform, '安装包报告平台错误')
    assert.equal(report.version, version, '安装包报告版本错误')
    assert.equal(report.identity, identifier, '安装包报告应用标识错误')
    assert.equal(report.smokeRequested, true, '安装包未请求真实模型检查')
    assert.ok(Array.isArray(report.models) && report.models.length > 0, '安装包缺少模型校验详情')
    assert.equal(new Set(report.models.map((model) => model.path)).size, report.models.length, '模型报告存在重复资源')
    for (const model of report.models) assert.match(model.sha256, HASH, '模型校验和无效')
    const entries = uniqueEntries(report.installers, platform.installers, 'file', '安装包报告资产缺失、重复或多余')
    const installerFiles = await filesUnder(join(artifactRoot, `AudioScript-${platform.artifact}`))
    exactNames(installerFiles.map((path) => basename(path)), platform.installers, '安装包工件缺失、重复或多余')
    for (const path of installerFiles) {
      const info = await stage(path, 'installer')
      const entry = entries.get(info.file)
      assert.ok(entry.sha256 === info.sha256 && entry.bytes === info.bytes, `安装包 SHA-256 或体积不一致：${info.file}`)
      assert.equal(entry.format, platform.format, '安装包原生架构错误')
      if (entry.version !== undefined) assert.equal(entry.version, version, '安装包内应用版本错误')
      assert.equal(entry.modelFiles, report.models.length, '安装包模型文件数量错误')
      if (platform.platform === 'macos-arm64') {
        assert.equal(entry.identifier, identifier, 'macOS 应用标识错误')
        assert.equal(entry.minimumSystemVersion, config.bundle.macOS.minimumSystemVersion, 'macOS 最低版本错误')
        assert.equal(entry.codeSignature, 'verified', 'macOS 资源签名未通过')
      }
      verifySmokeRuns(entry, platform.platform)
      installerInfo.set(info.file, info)
    }
    const checksumLines = (await readFile(checksumPath, 'utf8')).trim().split(/\r?\n/)
    exactNames(checksumLines, platform.installers.map((name) => `${installerInfo.get(name).sha256}  ${name}`),
      '平台安装包 SHA256SUMS 与实际资产不一致')
    assert.equal(updaterReport.platform, platform.platform, '更新验签报告平台错误')
    assert.equal(updaterReport.version, version, '更新验签报告版本错误')
    assert.equal(updaterReport.publicKeySha256, publicKeySha256, '更新验签报告公钥指纹不一致')
    updaterReports.set(platform.platform, updaterReport)
    const verificationFiles = await filesUnder(verificationDir)
    exactNames(verificationFiles.map((path) => basename(path)), [basename(reportPath), basename(updaterReportPath), basename(checksumPath)],
      '平台验证工件缺失、重复或多余')
    for (const path of verificationFiles) await stage(path, 'verification')
  }

  const updates = [
    { id: 'macos-arm64', platform: 'macos-arm64', directory: 'updater-macOS-ARM', extension: '.app.tar.gz' },
    { id: 'windows-nsis', platform: 'windows-x64', directory: 'updater-Windows-x64', name: platforms[1].installers[0] },
    { id: 'windows-msi', platform: 'windows-x64', directory: 'updater-Windows-x64-msi', name: platforms[1].installers[1] },
    { id: 'linux-appimage', platform: 'linux-x64', directory: 'updater-Linux-x64', name: platforms[2].installers[1] },
    { id: 'linux-deb', platform: 'linux-x64', directory: 'updater-Linux-x64-deb', name: platforms[2].installers[0] },
  ]
  const updateInfo = new Map()
  for (const update of updates) {
    const files = await filesUnder(join(artifactRoot, update.directory))
    const payloads = files.filter((path) => update.name ? basename(path) === update.name : path.endsWith(update.extension))
    assert.equal(payloads.length, 1, '每种更新工件必须恰好包含一个更新包')
    const path = payloads[0]
    exactNames(files, [path, `${path}.sig`], '更新工件缺少签名或包含多余、重复资产')
    const info = await stage(path, 'updater', update.platform !== 'macos-arm64')
    const signature = (await readFile(`${path}.sig`, 'utf8')).trim()
    assert.ok(signature, '更新签名为空')
    await stage(`${path}.sig`, 'signature')
    updateInfo.set(update.id, { ...info, signature, platform: update.platform })
  }
  const names = [...updateInfo.values()].map((entry) => entry.file)
  assert.equal(new Set(names).size, 5, '更新包文件名冲突')
  const verification = uniqueEntries(manifestVerification.artifacts, names, 'artifact', '更新清单验签报告缺失、重复或多余')
  for (const [target, id] of Object.entries(TARGETS)) {
    const info = updateInfo.get(id)
    const entry = manifest.platforms[target]
    assert.equal(entry.url, `${project.repository}/releases/download/v${version}/${encodeURIComponent(info.file)}`,
      '更新清单必须指向本 fork 当前版本的准确资产')
    assert.equal(entry.signature, info.signature, '更新清单签名与原始 .sig 不一致')
    checkVerification(verification.get(info.file), info.file, version, info.sha256)
  }
  for (const [platform, report] of updaterReports) {
    const expected = [...updateInfo.values()].filter((entry) => entry.platform === platform)
    const entries = uniqueEntries(report.artifacts, expected.map((entry) => entry.file), 'artifact', '平台更新验签资产缺失、重复或多余')
    for (const info of expected) {
      const entry = entries.get(info.file)
      checkVerification(entry, info.file, version, info.sha256)
      assert.ok(entry.negativeChecks && typeof entry.negativeChecks === 'object', '缺少更新签名反例检查')
      exactNames(Object.keys(entry.negativeChecks), NEGATIVE_CHECKS, '更新签名反例检查不完整')
      for (const check of NEGATIVE_CHECKS) assert.equal(entry.negativeChecks[check], true, '更新签名反例检查未通过')
    }
  }
  await stage(manifestPath, 'manifest')
  await stage(manifestVerificationPath, 'verification')
  const releaseVerification = {
    repository, version, tag: `v${version}`, commit: env.GITHUB_SHA ?? null,
    runUrl: env.GITHUB_RUN_ID ? `${project.repository}/actions/runs/${env.GITHUB_RUN_ID}` : null,
    publicKeySha256, verifiedAt: new Date(now).toISOString(),
    files: [...staged.values()].map(({ file, bytes, sha256 }) => ({ file, bytes, sha256 }))
      .sort((a, b) => a.file.localeCompare(b.file)),
  }
  await mkdir(dirname(outputDir), { recursive: true })
  const temporary = await mkdtemp(join(dirname(outputDir), '.audioscript-release-stage-'))
  try {
    for (const entry of staged.values()) {
      const destination = join(temporary, entry.file)
      await copyFile(entry.source, destination)
      const copied = await fileInfo(destination)
      assert.ok(copied.sha256 === entry.sha256 && copied.bytes === entry.bytes, '汇总时工件内容发生变化')
    }
    const reportName = 'release-verification.json'
    await writeFile(join(temporary, reportName), `${JSON.stringify(releaseVerification, null, 2)}\n`)
    const reportInfo = await fileInfo(join(temporary, reportName))
    const checksums = [...staged.values(), reportInfo].sort((a, b) => a.file.localeCompare(b.file))
      .map(({ file, sha256 }) => `${sha256}  ${file}\n`).join('')
    await writeFile(join(temporary, 'SHA256SUMS.txt'), checksums)
    await rename(temporary, outputDir)
  } catch (error) {
    await rm(temporary, { recursive: true, force: true })
    throw error
  }
  return releaseVerification
}

export async function main(argv = process.argv.slice(2)) {
  const options = {}
  for (let i = 0; i < argv.length; i += 2) {
    assert.ok(['--artifact-root', '--output-dir'].includes(argv[i]) && argv[i + 1] && !argv[i + 1].startsWith('--'),
      '发布汇总参数无效或缺少值')
    const key = argv[i] === '--artifact-root' ? 'artifactRoot' : 'outputDir'
    assert.equal(options[key], undefined, '发布汇总参数不可重复')
    options[key] = argv[i + 1]
  }
  const report = await prepareSignedRelease(options)
  process.stdout.write(`签名发布工件汇总通过：v${report.version}，${report.files.length} 个源工件。\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`发布工件汇总失败：${error.message}\n`)
    process.exitCode = 1
  })
}
