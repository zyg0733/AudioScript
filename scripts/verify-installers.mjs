#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, mkdir, mkdtemp, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PLATFORMS = {
  'macos-arm64': { host: 'darwin', packages: [['dmg', '.dmg']] },
  'windows-x64': { host: 'win32', packages: [['nsis', '.exe'], ['msi', '.msi']] },
  'linux-x64': { host: 'linux', packages: [['deb', '.deb'], ['appimage', '.AppImage']] },
}

export async function sha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function filesUnder(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...await filesUnder(path))
    else if (entry.isFile()) files.push(path)
  }
  return files.sort()
}

function exactlyOne(items, message) {
  assert.equal(items.length, 1, `${message}（找到 ${items.length} 项）`)
  return items[0]
}

async function nonempty(path) {
  const info = await stat(path)
  assert.ok(info.isFile() && info.size > 0, `文件缺失或为空：${path}`)
  return info.size
}

export async function expectedModelFiles(modelsRoot, catalog) {
  const expected = []
  const bundled = catalog.models.filter((entry) => entry.bundled)
  assert.ok(bundled.some((entry) => entry.kind === 'asr'), 'catalog 缺少内置 ASR')
  assert.ok(bundled.some((entry) => entry.kind === 'mt'), 'catalog 缺少内置 MT')
  for (const entry of bundled) {
    const directory = join(modelsRoot, entry.install.dir)
    const files = await filesUnder(directory)
    if (entry.kind === 'asr') {
      const names = (await readdir(directory, { withFileTypes: true })).filter((file) => file.isFile()).map((file) => file.name)
      for (const component of ['encoder', 'decoder', 'joiner']) {
        const precision = entry.required.asr[component]
        const candidates = names.filter((name) => name.startsWith(component) && name.endsWith('.onnx'))
        const chosen = exactlyOne(candidates, `ASR ${component} 必须恰好保留一个模型`)
        assert.equal(chosen.includes('.int8.'), precision === 'int8', `ASR ${component} 精度错误：${chosen}`)
      }
      for (const file of entry.required.asr.files) await nonempty(join(directory, file))
    } else if (entry.kind === 'mt') {
      assert.equal(entry.install.directions.length, 2, '内置 MT 必须包含双向模型')
      for (const direction of entry.install.directions) {
        for (const file of [...entry.required.mt.files, 'NOTICE.txt']) await nonempty(join(directory, direction, file))
        for (const file of ['source-tokenizer.json', 'target-tokenizer.json']) {
          JSON.parse(await readFile(join(directory, direction, file), 'utf8'))
        }
      }
    }
    let size = 0
    for (const file of files) {
      size += await nonempty(file)
      expected.push({ path: relative(modelsRoot, file).split('\\').join('/'), sha256: await sha256(file) })
    }
    assert.ok(size >= (entry.sizes?.installedBytes ?? 0) / 2, `内置模型体积异常：${entry.id} 只有 ${size} bytes`)
  }
  return expected.sort((a, b) => a.path.localeCompare(b.path))
}

export function verifyExecutableHeader(buffer, platform) {
  if (platform === 'macos-arm64') {
    assert.ok(buffer.length >= 12 && buffer.readUInt32LE(0) === 0xfeedfacf, '应用不是 64 位 Mach-O')
    assert.equal(buffer.readUInt32LE(4), 0x0100000c, '应用不是 macOS ARM64')
    return 'Mach-O arm64'
  }
  if (platform === 'linux-x64') {
    assert.ok(buffer.length >= 20 && buffer.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])), '应用不是 ELF')
    assert.equal(buffer[4], 2, '应用不是 64 位 ELF')
    assert.equal(buffer[5], 1, '应用不是 little-endian ELF')
    assert.equal(buffer.readUInt16LE(18), 62, '应用不是 Linux x86_64')
    return 'ELF x86_64'
  }
  assert.equal(platform, 'windows-x64', `未知平台：${platform}`)
  assert.ok(buffer.length >= 64 && buffer.toString('ascii', 0, 2) === 'MZ', '应用不是 PE')
  const offset = buffer.readUInt32LE(60)
  assert.ok(offset <= buffer.length - 26 && buffer.toString('ascii', offset, offset + 4) === 'PE\0\0', 'PE 头无效')
  assert.equal(buffer.readUInt16LE(offset + 4), 0x8664, '应用不是 Windows x64')
  assert.equal(buffer.readUInt16LE(offset + 24), 0x20b, '应用不是 PE32+')
  return 'PE x86_64'
}

async function executableFormat(path, platform) {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(64 * 1024)
    const { bytesRead } = await handle.read(buffer)
    return verifyExecutableHeader(buffer.subarray(0, bytesRead), platform)
  } finally {
    await handle.close()
  }
}

export async function verifyModelCopies(modelsRoot, expected) {
  for (const file of expected) {
    const path = join(modelsRoot, ...file.path.split('/'))
    await nonempty(path)
    assert.equal(await sha256(path), file.sha256, `安装包内置模型与构建源不一致：${file.path}`)
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 180_000, ...options })
  if (result.error) throw new Error(`无法执行 ${command}：${result.error.message}`)
  assert.ok((options.allowedStatuses ?? [0]).includes(result.status), `${command} 验证失败（${result.status}）：${result.stderr || result.stdout}`)
  return result.stdout
}

function powershell(script, env = {}) {
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(`$ErrorActionPreference = 'Stop'; ${script}`, 'utf16le').toString('base64')], {
    env: { ...process.env, ...env },
  }).trim()
}

export function sameVersion(actual, expected) {
  return actual === expected || actual === `${expected}.0`
}

export function verifyMacInfo(info, config) {
  assert.equal(info.CFBundleIdentifier, config.identifier, 'macOS 应用标识错误')
  assert.ok(sameVersion(info.CFBundleShortVersionString, config.version), 'macOS 应用版本错误')
  assert.equal(info.LSMinimumSystemVersion, '14.2', 'macOS 最低版本必须为 14.2')
  assert.ok(info.NSMicrophoneUsageDescription, 'macOS 包缺少麦克风权限说明')
  assert.ok(info.NSAudioCaptureUsageDescription, 'macOS 包缺少系统声音权限说明')
}

export function verifyLddResult(result) {
  if (result.error) throw new Error(`无法执行 ldd：${result.error.message}`)
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim()
  assert.ok(!/\bnot found\b/i.test(output), `Linux 安装包缺少动态依赖：${output}`)
  assert.ok(result.status === 0 || (result.status === 1 && /not a dynamic executable|statically linked/i.test(output)), `ldd 验证失败：${output}`)
  return output
}

export async function verifyExtracted({ root, platform, config, expected, smokeExecutable, smokeWav }) {
  const files = await filesUnder(root)
  let executable
  let modelsRoot
  const metadata = {}
  if (platform === 'macos-arm64') {
    const plist = exactlyOne(files.filter((file) => file.endsWith('.app/Contents/Info.plist')), 'DMG 必须包含一个应用 Info.plist')
    const info = JSON.parse(run('plutil', ['-convert', 'json', '-o', '-', plist]))
    verifyMacInfo(info, config)
    run('codesign', ['--verify', '--deep', '--strict', dirname(dirname(plist))])
    executable = join(dirname(plist), 'MacOS', info.CFBundleExecutable)
    modelsRoot = join(dirname(plist), 'Resources', 'models')
    Object.assign(metadata, { version: info.CFBundleShortVersionString, identifier: info.CFBundleIdentifier, minimumSystemVersion: info.LSMinimumSystemVersion, codeSignature: 'verified' })
  } else {
    const executableNames = platform === 'windows-x64' ? ['audioscript.exe'] : ['audioscript']
    executable = exactlyOne(files.filter((file) => executableNames.includes(basename(file).toLowerCase())), '安装包必须包含一个主程序')
    const first = expected[0].path.split('/')
    const suffix = join('models', ...first)
    const anchor = exactlyOne(files.filter((file) => file.endsWith(join('', suffix))), '安装包必须包含一个完整的 models 资源目录')
    modelsRoot = anchor.slice(0, -join(...first).length - 1)
    if (platform === 'windows-x64') {
      assert.equal(dirname(modelsRoot), dirname(executable), 'Windows models 必须位于主程序同目录')
      metadata.version = powershell('(Get-Item -LiteralPath $env:AUDIOSCRIPT_VERIFY_EXE).VersionInfo.ProductVersion', { AUDIOSCRIPT_VERIFY_EXE: executable })
      assert.ok(sameVersion(metadata.version, config.version), `Windows 应用版本错误：${metadata.version}`)
    }
  }
  await nonempty(executable)
  const format = await executableFormat(executable, platform)
  await verifyModelCopies(modelsRoot, expected)
  let smoke = 'not requested'
  let smokeOutput = ''
  if (smokeExecutable) {
    smokeOutput = run(smokeExecutable, ['--models-root', modelsRoot, ...smokeWav ? ['--wav', smokeWav] : []]).trim()
    process.stdout.write(`模型 smoke (${platform})：\n${smokeOutput}\n`)
    smoke = 'passed'
  }
  return { installedExecutable: executable, resourcesRoot: dirname(modelsRoot), format, ...metadata, modelFiles: expected.length, smoke, smokeOutput }
}

async function verifyInstaller(installer, platform, config, expected, smokeExecutable, smokeWav) {
  const temporary = await mkdtemp(join(tmpdir(), 'audioscript-installer-'))
  let mounted = false
  try {
    let root = temporary
    const metadata = {}
    if (platform === 'macos-arm64') {
      run('hdiutil', ['verify', installer])
      root = join(temporary, 'mount')
      await mkdir(root)
      run('hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', root, installer])
      mounted = true
    } else if (platform === 'linux-x64' && installer.endsWith('.deb')) {
      const fields = run('dpkg-deb', ['--field', installer])
      metadata.version = /^Version: (.+)$/m.exec(fields)?.[1]
      metadata.architecture = /^Architecture: (.+)$/m.exec(fields)?.[1]
      assert.ok(sameVersion(metadata.version, config.version), 'Debian 安装包版本错误')
      assert.equal(metadata.architecture, 'amd64', 'Debian 安装包架构错误')
      run('dpkg-deb', ['--extract', installer, temporary])
    } else if (platform === 'linux-x64') {
      await chmod(installer, 0o755)
      const extractionEnv = { ...process.env }
      delete extractionEnv.APPIMAGE_EXTRACT_AND_RUN
      run(installer, ['--appimage-extract'], { cwd: temporary, env: extractionEnv })
      root = join(temporary, 'squashfs-root')
    } else if (installer.endsWith('.msi')) {
      const info = JSON.parse(powershell(`$installer = New-Object -ComObject WindowsInstaller.Installer; $db = $installer.OpenDatabase($env:AUDIOSCRIPT_VERIFY_MSI, 0); $view = $db.OpenView("SELECT Value FROM Property WHERE Property='ProductVersion'"); $view.Execute(); $record = $view.Fetch(); @{ version = $record.StringData(1); architecture = $db.SummaryInformation(0).Property(7) } | ConvertTo-Json -Compress`, { AUDIOSCRIPT_VERIFY_MSI: installer }))
      assert.ok(sameVersion(info.version, config.version), 'MSI 安装包版本错误')
      assert.ok(info.architecture.startsWith('x64;'), `MSI 安装包架构错误：${info.architecture}`)
      Object.assign(metadata, info)
      run('msiexec.exe', ['/a', installer, '/qn', `TARGETDIR=${temporary}`, '/norestart'], { allowedStatuses: [0, 3010] })
    } else {
      run('7z', ['x', installer, `-o${temporary}`, '-y'])
    }
    assert.ok(basename(installer).includes(`_${config.version}_`), `安装包名称版本与应用配置不符：${basename(installer)}`)
    const extracted = await verifyExtracted({ root, platform, config, expected, smokeExecutable, smokeWav })
    if (platform === 'linux-x64') metadata.nativeDependencies = verifyLddResult(spawnSync('ldd', [extracted.installedExecutable], { encoding: 'utf8', timeout: 30_000 }))
    return { file: basename(installer), bytes: await nonempty(installer), sha256: await sha256(installer), ...metadata, ...extracted }
  } finally {
    if (mounted) run('hdiutil', ['detach', join(temporary, 'mount'), '-force'])
    await rm(temporary, { recursive: true, force: true })
  }
}

async function main() {
  const args = process.argv.slice(2)
  const allowed = new Set(['--platform', '--bundle-dir', '--output-dir', '--smoke-executable', '--smoke-wav'])
  const values = {}
  for (let i = 0; i < args.length; i += 2) {
    assert.ok(allowed.has(args[i]) && args[i + 1] && !args[i + 1].startsWith('--'), `参数无效或缺值：${args[i]}`)
    values[args[i]] = args[i + 1]
  }
  const platform = values['--platform']
  assert.ok(PLATFORMS[platform], '--platform 必须为 macos-arm64、windows-x64 或 linux-x64')
  assert.equal(process.platform, PLATFORMS[platform].host, '必须在安装包的对应平台原生 runner 上验证')
  const config = JSON.parse(await readFile(join(ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8'))
  const catalog = JSON.parse(await readFile(join(ROOT, 'src-tauri', 'assets', 'model-catalog.json'), 'utf8'))
  const expected = await expectedModelFiles(join(ROOT, 'src-tauri', 'assets', 'models'), catalog)
  const bundle = resolve(values['--bundle-dir'] ?? join(ROOT, 'src-tauri', 'target', 'release', 'bundle'))
  const output = resolve(values['--output-dir'] ?? join(ROOT, '.cache', 'installer-verification'))
  const results = []
  assert.ok(!values['--smoke-wav'] || values['--smoke-executable'], '--smoke-wav 需要 --smoke-executable')
  for (const [directory, extension] of PLATFORMS[platform].packages) {
    const matches = (await readdir(join(bundle, directory))).filter((file) => file.endsWith(extension)).map((file) => join(bundle, directory, file))
    const installer = exactlyOne(matches, `${directory} 必须恰好包含一个 ${extension} 安装包`)
    results.push(await verifyInstaller(installer, platform, config, expected, values['--smoke-executable'] && resolve(values['--smoke-executable']), values['--smoke-wav'] && resolve(values['--smoke-wav'])))
    process.stdout.write(`已验证 ${basename(installer)}：架构、元信息、内置模型${values['--smoke-executable'] ? '及模型加载' : ''}\n`)
  }
  await mkdir(output, { recursive: true })
  await writeFile(join(output, `${platform}-SHA256SUMS.txt`), results.map((item) => `${item.sha256}  ${item.file}\n`).join(''))
  await writeFile(join(output, `${platform}-verification.json`), `${JSON.stringify({ platform, version: config.version, identity: config.identifier, smokeRequested: Boolean(values['--smoke-executable']), installers: results, models: expected }, null, 2)}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`安装包验证失败：${error.message}\n`)
    process.exitCode = 1
  })
}
