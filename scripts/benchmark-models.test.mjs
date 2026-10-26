import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { benchmarkModels, parseArgs, parseTimings, runSmoke, summarize } from './benchmark-models.mjs'

const catalog = JSON.parse(await readFile(new URL('../src-tauri/assets/model-catalog.json', import.meta.url)))
const asr = catalog.models.find((entry) => entry.kind === 'asr' && entry.tier === 'builtin')
const mt = catalog.models.find((entry) => entry.kind === 'mt' && entry.tier === 'base')
const PRIVATE_TEXT = 'PRIVATE_TRANSCRIPT_DO_NOT_PRINT'

function smokeLog(offset = 0) {
  return [
    '2026-10-26 INFO native model initialization',
    `ASR 初始化耗时：${10 + offset} ms`,
    `ASR 定稿 [0–100 ms]：${PRIVATE_TEXT}`,
    `ASR 关闭耗时：2 ms；ASR 总耗时：${100 + offset} ms`,
    `NMT en→zh 初始化耗时（含预热）：${20 + offset} ms`,
    `NMT en→zh 单句推理耗时：${3 + offset} ms`,
    'NMT en→zh 关闭耗时：1 ms',
    `NMT en→zh：${PRIVATE_TEXT} → ${PRIVATE_TEXT}（${30 + offset} ms）`,
    `NMT zh→en 初始化耗时（含预热）：${40 + offset} ms`,
    `NMT zh→en 单句推理耗时：${5 + offset} ms`,
    'NMT zh→en 关闭耗时：2 ms',
    `NMT zh→en：${PRIVATE_TEXT} → ${PRIVATE_TEXT}（${50 + offset} ms）`,
    `模型冒烟验证通过（${200 + offset} ms）`,
    '',
  ].join('\n')
}

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'audioscript-model-benchmark-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const modelsRoot = join(dir, 'models with spaces ; $(never-run)')
  const asrDir = join(modelsRoot, asr.install.dir)
  await mkdir(asrDir, { recursive: true })
  for (const component of ['encoder', 'decoder', 'joiner']) {
    const suffix = asr.required.asr[component] === 'int8' ? '.int8.onnx' : '.onnx'
    await writeFile(join(asrDir, `${component}-fixture${suffix}`), 'offline fake model')
  }
  for (const file of asr.required.asr.files) await writeFile(join(asrDir, file), 'offline fake tokens')
  for (const direction of mt.install.directions) {
    const directory = join(modelsRoot, mt.install.dir, direction)
    await mkdir(directory, { recursive: true })
    for (const file of mt.required.mt.files) await writeFile(join(directory, file), 'offline fake model')
  }
  const wav = join(dir, 'sample with spaces.wav')
  const bytes = Buffer.from('synthetic sample; only the real smoke executable validates PCM16')
  await writeFile(wav, bytes)
  return { dir, modelsRoot, asrDir, wav, bytes, executable: process.execPath }
}

test('CLI requires explicit input paths, defaults to three runs and keeps paths literal', () => {
  assert.deepEqual(parseArgs(['--executable', 'binary with spaces', '--models-root', 'model ; directory', '--wav', 'x.wav']), {
    executable: 'binary with spaces', modelsRoot: 'model ; directory', wav: 'x.wav', runs: 3, timeoutMs: 120_000,
  })
  assert.equal(parseArgs(['--help']), null)
  const base = ['--executable', 'binary', '--models-root', 'models', '--wav', 'x.wav']
  assert.equal(parseArgs([...base, '--runs', '12']).runs, 12)
  assert.equal(parseArgs([...base, '--timeout-ms', '500']).timeoutMs, 500)
  for (const count of ['0', '-1', '1.5', '101', 'Infinity', '']) {
    assert.throws(() => parseArgs([...base, '--runs', count]), /--runs/)
  }
  for (const timeout of ['0', '-1', '1.5', '3600001', 'Infinity']) {
    assert.throws(() => parseArgs([...base, '--timeout-ms', timeout]), /--timeout-ms/)
  }
  for (const args of [[], ['--executable'], [...base, '--unknown'], [...base, '--wav', 'second.wav']]) {
    assert.throws(() => parseArgs(args), /缺少|未知|重复/)
  }
})

test('extracts both translation directions, initialization warmup and totals without retaining speech text', () => {
  const result = parseTimings(smokeLog().replaceAll('\n', '\r\n'))
  assert.deepEqual(result, {
    asrInitMs: 10, asrShutdownMs: 2, asrTotalMs: 100,
    nmtEnZhInitWithWarmupMs: 20, nmtEnZhInferenceMs: 3, nmtEnZhShutdownMs: 1, nmtEnZhTotalMs: 30,
    nmtZhEnInitWithWarmupMs: 40, nmtZhEnInferenceMs: 5, nmtZhEnShutdownMs: 2, nmtZhEnTotalMs: 50,
    smokeTotalMs: 200,
  })
  assert.equal(JSON.stringify(result).includes(PRIVATE_TEXT), false)
})

test('rejects incomplete, duplicate and unsafe timings without echoing the original log', () => {
  for (const log of [
    smokeLog().replace('NMT en→zh 单句推理耗时：3 ms', ''),
    `${smokeLog()}ASR 初始化耗时：1 ms\n`,
    smokeLog().replace('ASR 初始化耗时：10 ms', 'ASR 初始化耗时：9007199254740992 ms'),
    `${PRIVATE_TEXT}\n模型冒烟验证失败`,
  ]) {
    assert.throws(() => parseTimings(log), (error) => {
      assert.match(error.message, /计时字段/)
      assert.equal(error.message.includes(PRIVATE_TEXT), false)
      return true
    })
  }
})

test('p50 and p95 use nearest rank including small samples, zero and incomplete-run rejection', () => {
  assert.deepEqual(summarize([{ ms: 30 }, { ms: 0 }, { ms: 10 }]), { ms: { p50: 10, p95: 30 } })
  assert.deepEqual(summarize(Array.from({ length: 20 }, (_, index) => ({ ms: index + 1 }))), {
    ms: { p50: 10, p95: 19 },
  })
  assert.throws(() => summarize([]), /没有完整运行/)
  assert.throws(() => summarize([{ ms: 1 }, {}]), /计时记录不完整/)
})

test('runs sequentially with argument arrays and reports platform, fingerprint, model metadata and all samples', async (t) => {
  const files = await fixture(t)
  const calls = []
  let active = false
  const report = await benchmarkModels(files, { runner: async (executable, args, options) => {
    assert.equal(active, false, 'runs must not overlap')
    active = true
    calls.push({ executable, args, options })
    await Promise.resolve()
    active = false
    return { log: smokeLog(calls.length), processWallMs: 250 + calls.length }
  } })
  assert.equal(calls.length, 3)
  for (const call of calls) {
    assert.equal(call.executable, resolve(process.execPath))
    assert.deepEqual(call.args, ['--models-root', report.models.root, '--wav', files.wav])
    assert.deepEqual(call.options, { timeoutMs: 120_000 })
  }
  assert.equal(report.environment.platform, process.platform)
  assert.equal(report.environment.architecture, process.arch)
  assert.equal(report.sample.sha256, createHash('sha256').update(files.bytes).digest('hex'))
  assert.equal(report.sample.sizeBytes, files.bytes.length)
  assert.deepEqual(report.models.entries.map((entry) => entry.id), [asr.id, mt.id])
  assert.equal(report.models.entries[0].files.length, 3 + asr.required.asr.files.length)
  assert.equal(report.models.entries[1].files.length, 2 * mt.required.mt.files.length)
  assert.ok(report.models.entries.every((entry) => entry.totalRequiredBytes > 0))
  assert.equal(report.runsRequested, 3)
  assert.equal(report.runsCompleted, 3)
  assert.equal(report.perRunTimeoutMs, 120_000)
  assert.deepEqual(report.summary.asrInitMs, { p50: 12, p95: 13 })
  assert.deepEqual(report.summary.processWallMs, { p50: 252, p95: 253 })
  assert.equal(report.percentileMethod, 'nearest-rank')
  assert.match(report.scope, /不是麦克风端到端/)
  assert.equal(JSON.stringify(report).includes(PRIVATE_TEXT), false)
})

test('rejects missing binary, sample or model root before executing or downloading anything', async (t) => {
  const files = await fixture(t)
  const runner = () => assert.fail('preflight failures must not execute a child')
  for (const [field, expected] of [['executable', /二进制不可读取/], ['wav', /WAV 样本不可读取/], ['modelsRoot', /模型根目录不可读取/]]) {
    await assert.rejects(benchmarkModels({ ...files, [field]: join(files.dir, 'missing') }, { runner }), expected)
  }
})

test('rejects missing and ambiguous ASR files and missing directional translation weights', async (t) => {
  const files = await fixture(t)
  const runner = () => assert.fail('incomplete models must not execute a child')
  const tokens = join(files.asrDir, asr.required.asr.files[0])
  await rm(tokens)
  await assert.rejects(benchmarkModels(files, { runner }), /模型 asr-builtin 文件不可读取/)
  await writeFile(tokens, 'restored')
  const duplicate = join(files.asrDir, 'encoder-duplicate.int8.onnx')
  await writeFile(duplicate, 'duplicate')
  await assert.rejects(benchmarkModels(files, { runner }), /encoder 文件缺失或不唯一/)
  await rm(duplicate)
  await rm(join(files.modelsRoot, mt.install.dir, mt.install.directions[0], 'model.bin'))
  await assert.rejects(benchmarkModels(files, { runner }), /模型 mt-base 文件不可读取/)
})

test('an incomplete later run fails the report rather than publishing partial percentiles or speech text', async (t) => {
  const files = await fixture(t)
  let calls = 0
  await assert.rejects(benchmarkModels({ ...files, runs: 3 }, { runner: async () => ({
    log: ++calls === 1 ? smokeLog() : PRIVATE_TEXT, processWallMs: 100,
  }) }), (error) => {
    assert.match(error.message, /第 2\/3 次运行未完成/)
    assert.equal(error.message.includes(PRIVATE_TEXT), false)
    return true
  })
  assert.equal(calls, 2)
})

test('the subprocess runner passes literal arguments without a shell and measures process wall time', async () => {
  const value = 'literal ; $(echo should-not-run)'
  const result = await runSmoke(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', value])
  assert.equal(result.log, value)
  assert.ok(result.processWallMs > 0)
})

test('subprocess failures never forward stdout, stderr or transcript text', async () => {
  await assert.rejects(runSmoke(process.execPath, ['-e',
    `process.stdout.write(${JSON.stringify(PRIVATE_TEXT)}); process.stderr.write(${JSON.stringify(PRIVATE_TEXT)}); process.exit(9)`,
  ]), (error) => {
    assert.match(error.message, /退出码 9/)
    assert.equal(error.message.includes(PRIVATE_TEXT), false)
    return true
  })
})

test('a hung child that ignores termination is bounded and never leaks its output', { timeout: 3_000 }, async () => {
  const started = Date.now()
  await assert.rejects(runSmoke(process.execPath, ['-e',
    `process.on('SIGTERM', () => {}); process.stdout.write(${JSON.stringify(PRIVATE_TEXT)}); setInterval(() => {}, 1000)`,
  ], { timeoutMs: 150, killGraceMs: 25 }), (error) => {
    assert.match(error.message, /超时（150 ms）/)
    assert.equal(error.message.includes(PRIVATE_TEXT), false)
    return true
  })
  assert.ok(Date.now() - started < 2_000)
})
