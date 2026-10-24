import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { expectedModelFiles, run, runModelSmoke, sameVersion, verifyExecutableHeader, verifyExtracted, verifyLddResult, verifyMacInfo, verifyModelCopies } from './verify-installers.mjs'

const catalog = {
  models: [
    {
      id: 'asr-builtin', kind: 'asr', bundled: true, install: { dir: 'asr' },
      required: { asr: { encoder: 'int8', decoder: 'fp32', joiner: 'int8', files: ['tokens.txt'] } },
      sizes: { installedBytes: 20 },
    },
    {
      id: 'mt-base', kind: 'mt', bundled: true, install: { dir: 'mt', directions: ['en-zh', 'zh-en'] },
      required: { mt: { files: ['model.bin', 'source-tokenizer.json', 'target-tokenizer.json'] } },
      sizes: { installedBytes: 20 },
    },
  ],
}

async function put(path, contents) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, contents)
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'audioscript-installer-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = join(root, 'source-models')
  for (const file of ['encoder-x.int8.onnx', 'decoder-x.onnx', 'joiner-x.int8.onnx', 'tokens.txt']) {
    await put(join(source, 'asr', file), `model fixture ${file}`)
  }
  for (const direction of ['en-zh', 'zh-en']) {
    await put(join(source, 'mt', direction, 'model.bin'), 'model fixture')
    await put(join(source, 'mt', direction, 'source-tokenizer.json'), '{"model":{"type":"Unigram"}}')
    await put(join(source, 'mt', direction, 'target-tokenizer.json'), '{"model":{"type":"Unigram"}}')
    await put(join(source, 'mt', direction, 'NOTICE.txt'), 'Helsinki-NLP / OPUS-MT fixture attribution')
  }
  return { root, source }
}

function executable(platform) {
  const bytes = Buffer.alloc(256)
  if (platform === 'macos-arm64') {
    bytes.writeUInt32LE(0xfeedfacf, 0)
    bytes.writeUInt32LE(0x0100000c, 4)
  } else if (platform === 'linux-x64') {
    bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1])
    bytes.writeUInt16LE(62, 18)
  } else {
    bytes.write('MZ')
    bytes.writeUInt32LE(128, 60)
    bytes.write('PE\0\0', 128)
    bytes.writeUInt16LE(0x8664, 132)
    bytes.writeUInt16LE(0x20b, 152)
  }
  return bytes
}

test('读取两种内置模型及许可证，安装包逐文件 SHA-256 必须匹配', async (t) => {
  const { root, source } = await fixture(t)
  const expected = await expectedModelFiles(source, catalog)
  assert.equal(expected.length, 12)
  assert.equal(expected.filter((file) => file.path.endsWith('NOTICE.txt')).length, 2)
  assert.ok(expected.every((file) => /^[a-f0-9]{64}$/.test(file.sha256)))
  const installed = join(root, 'installed-models')
  await cp(source, installed, { recursive: true })
  await verifyModelCopies(installed, expected)
  await writeFile(join(installed, 'mt', 'en-zh', 'model.bin'), 'tampered fixture')
  await assert.rejects(verifyModelCopies(installed, expected), /与构建源不一致/)
})

test('丢失或空的安装资源不能通过验证', async (t) => {
  const { root, source } = await fixture(t)
  const expected = await expectedModelFiles(source, catalog)
  const installed = join(root, 'installed-models')
  await cp(source, installed, { recursive: true })
  await writeFile(join(installed, 'asr', 'tokens.txt'), '')
  await assert.rejects(verifyModelCopies(installed, expected), /为空/)
  await rm(join(installed, 'asr', 'tokens.txt'))
  await assert.rejects(verifyModelCopies(installed, expected), /ENOENT/)
})

test('缓存 ASR 模型精度错误、重复模型不能用于打包', async (t) => {
  const { source } = await fixture(t)
  await put(join(source, 'asr', 'encoder-x.onnx'), 'wrong fp32 fixture')
  await assert.rejects(expectedModelFiles(source, catalog), /恰好保留一个/)
  await rm(join(source, 'asr', 'encoder-x.int8.onnx'))
  await assert.rejects(expectedModelFiles(source, catalog), /精度错误/)
})

test('双向 MT 必需文件、NOTICE 与 tokenizer JSON 都要有效', async (t) => {
  const { source } = await fixture(t)
  const notice = join(source, 'mt', 'zh-en', 'NOTICE.txt')
  await rm(notice)
  await assert.rejects(expectedModelFiles(source, catalog), /NOTICE.txt/)
  await put(notice, '')
  await assert.rejects(expectedModelFiles(source, catalog), /为空/)
  await put(notice, 'fixture attribution')
  await writeFile(join(source, 'mt', 'en-zh', 'target-tokenizer.json'), 'invalid json')
  await assert.rejects(expectedModelFiles(source, catalog), SyntaxError)
})

test('明显小于目录声明体积的模型缓存不能通过验证', async (t) => {
  const { source } = await fixture(t)
  const large = structuredClone(catalog)
  large.models[0].sizes.installedBytes = 1_000_000
  await assert.rejects(expectedModelFiles(source, large), /内置模型体积异常/)
})

test('检查可执行文件真实格式和架构，不能依赖安装包文件名', () => {
  for (const platform of ['macos-arm64', 'linux-x64', 'windows-x64']) {
    assert.ok(verifyExecutableHeader(executable(platform), platform))
    assert.throws(() => verifyExecutableHeader(Buffer.from('fake executable'), platform))
  }
  const macIntel = executable('macos-arm64')
  macIntel.writeUInt32LE(0x01000007, 4)
  assert.throws(() => verifyExecutableHeader(macIntel, 'macos-arm64'), /ARM64/)
  const linuxArm = executable('linux-x64')
  linuxArm.writeUInt16LE(183, 18)
  assert.throws(() => verifyExecutableHeader(linuxArm, 'linux-x64'), /x86_64/)
  const win32 = executable('windows-x64')
  win32.writeUInt16LE(0x014c, 132)
  assert.throws(() => verifyExecutableHeader(win32, 'windows-x64'), /x64/)
  const badPeOffset = executable('windows-x64')
  badPeOffset.writeUInt32LE(0xfffffff0, 60)
  assert.throws(() => verifyExecutableHeader(badPeOffset, 'windows-x64'), /PE 头无效/)
})

test('从真实解包目录定位主程序和 models，缺少模型必须失败', async (t) => {
  const { root, source } = await fixture(t)
  const expected = await expectedModelFiles(source, catalog)
  const extracted = join(root, 'extracted')
  const binary = join(extracted, 'usr', 'bin', 'AudioScript')
  const models = join(extracted, 'usr', 'lib', 'audioscript', 'models')
  await put(binary, executable('linux-x64'))
  await cp(source, models, { recursive: true })
  const args = { root: extracted, platform: 'linux-x64', config: { version: '0.2.11' }, expected }
  const report = await verifyExtracted(args)
  assert.equal(report.installedExecutable, binary)
  assert.equal(report.resourcesRoot, dirname(models))
  assert.equal(report.format, 'ELF x86_64')
  assert.equal(report.smoke, 'not requested')
  await rm(join(models, 'mt', 'en-zh', 'model.bin'))
  await assert.rejects(verifyExtracted(args), /ENOENT/)
})

test('安装元信息仅接受目标版本及 Windows 规范化末尾零', () => {
  assert.ok(sameVersion('0.2.11', '0.2.11'))
  assert.ok(sameVersion('0.2.11.0', '0.2.11'))
  assert.equal(sameVersion('0.2.10', '0.2.11'), false)
  assert.equal(sameVersion('0.2.11-beta', '0.2.11'), false)
})

test('macOS 元信息要求自有标识、目标版本、14.2 及两项音频权限', () => {
  const config = { identifier: 'io.github.zyg0733.audioscript', version: '0.2.11' }
  const info = {
    CFBundleIdentifier: config.identifier, CFBundleShortVersionString: config.version,
    LSMinimumSystemVersion: '14.2', NSMicrophoneUsageDescription: 'fixture microphone',
    NSAudioCaptureUsageDescription: 'fixture system audio',
  }
  verifyMacInfo(info, config)
  assert.throws(() => verifyMacInfo({ ...info, LSMinimumSystemVersion: '10.13' }, config), /最低版本/)
  assert.throws(() => verifyMacInfo({ ...info, CFBundleIdentifier: 'com.upstream.app' }, config), /标识错误/)
  assert.throws(() => verifyMacInfo({ ...info, NSAudioCaptureUsageDescription: '' }, config), /系统声音权限/)
})

test('Linux ldd 缺失依赖总失败，静态程序无依赖输出允许通过', () => {
  assert.match(verifyLddResult({ status: 0, stdout: 'libc.so.6 => /lib/libc.so.6 (0x0)' }), /libc/)
  assert.match(verifyLddResult({ status: 1, stderr: 'not a dynamic executable' }), /not a dynamic/)
  for (const status of [0, 1]) {
    assert.throws(() => verifyLddResult({ status, stdout: 'libmissing.so => not found' }), /缺少动态依赖/)
  }
  assert.throws(() => verifyLddResult({ status: 1, stderr: 'Permission denied' }), /ldd 验证失败/)
  assert.throws(() => verifyLddResult({ error: new Error('ENOENT') }), /无法执行 ldd/)
})

test('Windows/Linux 对同一模型和音频额外运行禁用 MKL 的 smoke 并保留输出', async (t) => {
  const { root } = await fixture(t)
  const script = join(root, 'smoke-fixture.mjs')
  await put(script, `console.log(JSON.stringify({ args: process.argv.slice(2), mkl: process.env.CT2_USE_MKL ?? 'auto' }))`)
  const execute = (file, args, options) => {
    const child = spawnSync(process.execPath, [file, ...args], { ...options, encoding: 'utf8' })
    assert.equal(child.status, 0, child.stderr)
    return child.stdout
  }
  for (const platform of ['windows-x64', 'linux-x64']) {
    const results = runModelSmoke(script, { platform, modelsRoot: '/fixture/models', wav: '/fixture/audio.wav' }, execute)
    assert.deepEqual(results.map((result) => result.mode), ['default', 'mkl-disabled'])
    const normal = JSON.parse(results[0].output)
    const fallback = JSON.parse(results[1].output)
    assert.deepEqual(fallback.args, ['--models-root', '/fixture/models', '--wav', '/fixture/audio.wav'])
    assert.deepEqual(fallback.args, normal.args)
    assert.equal(fallback.mkl, '0')
  }
  const mac = runModelSmoke(script, { platform: 'macos-arm64', modelsRoot: '/fixture/models' }, execute)
  assert.deepEqual(mac.map((result) => result.mode), ['default'])
  assert.deepEqual(JSON.parse(mac[0].output).args, ['--models-root', '/fixture/models'])
})

test('MKL 禁用后的回退推理失败必须使验证失败', async (t) => {
  const { root } = await fixture(t)
  const script = join(root, 'smoke-failure.mjs')
  await put(script, `if (process.env.CT2_USE_MKL === '0') { console.error('No SGEMM backend on CPU'); process.exit(1) }; console.log('default inference passed')`)
  const execute = (file, args, options) => {
    const env = { ...options.env }
    if (options.env === process.env) delete env.CT2_USE_MKL
    const child = spawnSync(process.execPath, [file, ...args], { ...options, env, encoding: 'utf8' })
    assert.equal(child.status, 0, child.stderr)
    return child.stdout
  }
  assert.throws(() => runModelSmoke(script, { platform: 'linux-x64', modelsRoot: '/fixture/models' }, execute), /No SGEMM backend/)
})

test('模型失败保留 stdout 成功步骤与 stderr 故障原因，不能互相遮盖', () => {
  assert.throws(() => run(process.execPath, ['-e', `console.log('ASR 初始化及识别成功'); console.error('NMT No SGEMM backend on CPU'); process.exit(1)`]), (error) => {
    assert.match(error.message, /ASR 初始化及识别成功/)
    assert.match(error.message, /NMT No SGEMM backend on CPU/)
    return true
  })
})
