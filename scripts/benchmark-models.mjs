#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { access, readFile, readdir, realpath, stat } from 'node:fs/promises'
import { arch, cpus, platform, release, totalmem } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

const CATALOG = fileURLToPath(new URL('../src-tauri/assets/model-catalog.json', import.meta.url))
const MAX_LOG_BYTES = 4 * 1024 * 1024
const MAX_WAV_BYTES = 32 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 120_000
export const USAGE = '用法：node scripts/benchmark-models.mjs --executable <model_smoke> --models-root <models目录> --wav <PCM16 WAV> [--runs <1–100，默认3>] [--timeout-ms <每轮超时毫秒，默认120000>]'

function checkedRuns(value) {
  if (!/^\d+$/.test(String(value)) || Number(value) < 1 || Number(value) > 100) {
    throw new Error('--runs 必须是 1–100 的整数')
  }
  return Number(value)
}

function checkedTimeout(value) {
  if (!/^\d+$/.test(String(value)) || Number(value) < 1 || Number(value) > 3_600_000) {
    throw new Error('--timeout-ms 必须是 1–3600000 的整数')
  }
  return Number(value)
}

export function parseArgs(args) {
  const options = { runs: 3, timeoutMs: DEFAULT_TIMEOUT_MS }
  const seen = new Set()
  const names = {
    '--executable': 'executable', '--models-root': 'modelsRoot', '--wav': 'wav',
    '--runs': 'runs', '--timeout-ms': 'timeoutMs',
  }
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--help' || arg === '-h') return null
    if (!Object.hasOwn(names, arg)) throw new Error(`未知参数：${arg}`)
    if (seen.has(arg)) throw new Error(`参数重复：${arg}`)
    seen.add(arg)
    const value = args[++i]
    if (!value || value.startsWith('--')) throw new Error(`参数 ${arg} 缺少值`)
    options[names[arg]] = arg === '--runs' ? checkedRuns(value) : arg === '--timeout-ms' ? checkedTimeout(value) : value
  }
  for (const [arg, name] of Object.entries(names)) {
    if (name !== 'runs' && name !== 'timeoutMs' && !options[name]) throw new Error(`缺少 ${arg}`)
  }
  return options
}

export function parseTimings(log) {
  const normalized = log.replace(/\r\n/g, '\n')
  function one(pattern, label, group = 1) {
    const matches = Array.from(normalized.matchAll(pattern))
    if (matches.length !== 1) throw new Error(`缺少或重复的计时字段：${label}；请使用当前版本的 model_smoke`)
    const value = Number(matches[0][group])
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`无效的计时字段：${label}`)
    return value
  }
  const timings = {
    asrInitMs: one(/^ASR 初始化耗时：(\d+) ms$/gm, 'ASR 初始化'),
    asrShutdownMs: one(/^ASR 关闭耗时：(\d+) ms；ASR 总耗时：(\d+) ms$/gm, 'ASR 关闭'),
    asrTotalMs: one(/^ASR 关闭耗时：(\d+) ms；ASR 总耗时：(\d+) ms$/gm, 'ASR 总耗时', 2),
  }
  for (const [direction, prefix] of [['en→zh', 'nmtEnZh'], ['zh→en', 'nmtZhEn']]) {
    timings[`${prefix}InitWithWarmupMs`] = one(
      new RegExp(`^NMT ${direction} 初始化耗时（含预热）：(\\d+) ms$`, 'gm'), `${direction} 初始化（含预热）`,
    )
    timings[`${prefix}InferenceMs`] = one(
      new RegExp(`^NMT ${direction} 单句推理耗时：(\\d+) ms$`, 'gm'), `${direction} 单句推理`,
    )
    timings[`${prefix}ShutdownMs`] = one(
      new RegExp(`^NMT ${direction} 关闭耗时：(\\d+) ms$`, 'gm'), `${direction} 关闭`,
    )
    // The smoke program embeds the translated sentence on this line. Extract only its final timing.
    timings[`${prefix}TotalMs`] = one(
      new RegExp(`^NMT ${direction}：[^\\n]*（(\\d+) ms）$`, 'gm'), `${direction} 总耗时`,
    )
  }
  timings.smokeTotalMs = one(/^模型冒烟验证通过（(\d+) ms）$/gm, '冒烟总耗时')
  return timings
}

export function summarize(runs) {
  if (runs.length === 0) throw new Error('没有完整运行记录，无法生成统计')
  const result = {}
  for (const key of Object.keys(runs[0])) {
    const values = runs.map((run) => run[key]).sort((a, b) => a - b)
    if (values.some((value) => !Number.isFinite(value) || value < 0)) throw new Error(`计时记录不完整：${key}`)
    const percentile = (p) => values[Math.ceil(p * values.length) - 1]
    result[key] = { p50: percentile(0.5), p95: percentile(0.95) }
  }
  return result
}

async function metadata(path, label, directory = false) {
  let info
  try {
    info = await stat(path)
  } catch (error) {
    throw new Error(`${label}不可读取：${path}（${error.code ?? '读取失败'}）`)
  }
  if (directory ? !info.isDirectory() : !info.isFile() || info.size === 0) {
    throw new Error(`${label}${directory ? '不是目录' : '不是非空文件'}：${path}`)
  }
  return { path, sizeBytes: info.size, modifiedAt: info.mtime.toISOString() }
}

async function modelMetadata(root, catalog) {
  const selected = [
    catalog.models.find((entry) => entry.kind === 'asr' && entry.tier === 'builtin'),
    catalog.models.find((entry) => entry.kind === 'mt' && entry.tier === 'base'),
  ]
  if (selected.some((entry) => !entry)) throw new Error('模型 catalog 缺少 builtin ASR 或 base MT')
  const result = []
  for (const entry of selected) {
    const directory = join(root, entry.install.dir)
    const directoryInfo = await metadata(directory, `模型 ${entry.id} 目录`, true)
    const required = []
    if (entry.kind === 'asr') {
      const names = await readdir(directory)
      for (const component of ['encoder', 'decoder', 'joiner']) {
        const candidates = names.filter((name) => name.startsWith(component) && name.endsWith('.onnx') &&
          name.includes('.int8.') === (entry.required.asr[component] === 'int8'))
        if (candidates.length !== 1) throw new Error(`模型 ${entry.id} 的 ${component} 文件缺失或不唯一`)
        required.push(candidates[0])
      }
      required.push(...entry.required.asr.files)
    } else {
      if (entry.install.directions.length !== 2) throw new Error('base MT 必须配置两个翻译方向')
      for (const direction of entry.install.directions) {
        required.push(...entry.required.mt.files.map((file) => join(direction, file)))
      }
    }
    const files = []
    for (const file of required.sort()) {
      const info = await metadata(join(directory, file), `模型 ${entry.id} 文件`)
      files.push({ ...info, path: relative(root, info.path).split('\\').join('/') })
    }
    result.push({
      id: entry.id, tier: entry.tier, directory: directoryInfo.path, modifiedAt: directoryInfo.modifiedAt,
      totalRequiredBytes: files.reduce((sum, file) => sum + file.sizeBytes, 0), files,
    })
  }
  return result
}

export function runSmoke(executable, args, { timeoutMs = DEFAULT_TIMEOUT_MS, killGraceMs = 1_000 } = {}) {
  checkedTimeout(timeoutMs)
  return new Promise((resolveRun, rejectRun) => {
    const started = performance.now()
    const child = spawn(executable, args, { shell: false, stdio: ['ignore', 'pipe', 'ignore'] })
    const chunks = []
    let bytes = 0
    let overflow = false
    let timedOut = false
    let killTimer
    const stop = () => {
      child.kill('SIGTERM')
      killTimer ??= setTimeout(() => child.kill('SIGKILL'), killGraceMs)
    }
    const timeoutTimer = setTimeout(() => {
      timedOut = true
      stop()
    }, timeoutMs)
    const cleanup = () => {
      clearTimeout(timeoutTimer)
      clearTimeout(killTimer)
    }
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length
      if (bytes > MAX_LOG_BYTES) {
        overflow = true
        stop()
      } else {
        chunks.push(chunk)
      }
    })
    child.once('error', (error) => {
      cleanup()
      rejectRun(new Error(`无法运行模型冒烟二进制（${error.code ?? '启动失败'}）`))
    })
    child.once('close', (code, signal) => {
      cleanup()
      if (timedOut) return rejectRun(new Error(`模型冒烟超时（${timeoutMs} ms），已停止子进程；原始日志不予输出`))
      if (overflow) return rejectRun(new Error('模型冒烟日志超过 4 MiB，已停止；原始日志不予输出'))
      if (code !== 0) return rejectRun(new Error(`模型冒烟失败（退出码 ${code ?? '无'}，信号 ${signal ?? '无'}）；原始日志不予输出`))
      resolveRun({ log: Buffer.concat(chunks).toString('utf8'), processWallMs: performance.now() - started })
    })
  })
}

export async function benchmarkModels(options, { runner = runSmoke } = {}) {
  const runsRequested = checkedRuns(options.runs ?? 3)
  const timeoutMs = checkedTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
  const executable = resolve(options.executable)
  const binary = await metadata(executable, '模型冒烟二进制')
  if (platform() !== 'win32') {
    try {
      await access(executable, constants.X_OK)
    } catch {
      throw new Error(`模型冒烟二进制不可执行：${executable}`)
    }
  }
  const wav = resolve(options.wav)
  const sample = await metadata(wav, 'WAV 样本')
  if (sample.sizeBytes > MAX_WAV_BYTES) throw new Error('WAV 样本超过 model_smoke 的 32 MiB 上限')
  const sampleSha256 = createHash('sha256').update(await readFile(wav)).digest('hex')
  await metadata(resolve(options.modelsRoot), '模型根目录', true)
  const modelsRoot = await realpath(resolve(options.modelsRoot))
  const catalogBytes = await readFile(CATALOG)
  const models = await modelMetadata(modelsRoot, JSON.parse(catalogBytes))
  const runs = []
  for (let i = 0; i < runsRequested; i++) {
    try {
      const { log, processWallMs } = await runner(executable, ['--models-root', modelsRoot, '--wav', wav], { timeoutMs })
      runs.push({ ...parseTimings(log), processWallMs: Math.round(processWallMs * 1000) / 1000 })
    } catch (error) {
      throw new Error(`第 ${i + 1}/${runsRequested} 次运行未完成：${error.message}`)
    }
  }
  const processors = cpus()
  return {
    schemaVersion: 1,
    benchmark: 'model-smoke-timing',
    createdAt: new Date().toISOString(),
    scope: '模型冒烟计时；不是麦克风端到端、首字延迟、识别或翻译质量评测。',
    environment: {
      platform: platform(), architecture: arch(), osRelease: release(), nodeVersion: process.version,
      cpuModel: processors[0]?.model ?? null, logicalCores: processors.length, totalMemoryBytes: totalmem(),
    },
    executable: binary,
    sample: { ...sample, sha256: sampleSha256 },
    models: { root: modelsRoot, catalogSha256: createHash('sha256').update(catalogBytes).digest('hex'), entries: models },
    runsRequested, runsCompleted: runs.length, perRunTimeoutMs: timeoutMs,
    unit: 'milliseconds',
    percentileMethod: 'nearest-rank',
    notes: [
      '每轮启动独立进程，模型初始化每次执行；不清理系统文件缓存，不承诺冷启动测量。',
      'p50/p95 使用 nearest-rank；默认 3 次的 p95 即最大值，不代表稳定的总体尾延迟。',
      '模型目录仅记录所需文件的路径、大小和修改时间，未哈希模型权重，不能用于验证权重内容一致性。',
      'ASR 将整个 WAV 尽快投喂而非实时播放；NMT 每个方向只运行冒烟程序固定的一句，不输出正文。',
    ],
    runs,
    summary: summarize(runs),
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseArgs(process.argv.slice(2))
    if (options === null) process.stdout.write(`${USAGE}\n`)
    else process.stdout.write(`${JSON.stringify(await benchmarkModels(options), null, 2)}\n`)
  } catch (error) {
    process.stderr.write(`模型计时失败：${error.message}\n`)
    process.exitCode = 1
  }
}
