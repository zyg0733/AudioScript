#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { copyFile, existsSync } from 'node:fs'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const VENV = join(ROOT, '.cache', 'ct2venv')

const IS_WIN = process.platform === 'win32'
const VENV_BIN = join(VENV, IS_WIN ? 'Scripts' : 'bin')
const PYTHON = IS_WIN ? 'python' : 'python3'
const PY = join(VENV_BIN, IS_WIN ? 'python.exe' : 'python')
const TOK_CACHE = join(ROOT, '.cache', 'mt')

const argv = process.argv.slice(2)
const argValue = (name) => {
  const i = argv.indexOf(name)
  return i >= 0 ? argv[i + 1] : undefined
}
const big = argValue('--tier') === 'big'
const printCatalog = argv.includes('--print-catalog')
const force = argv.includes('--force')

const MT_DIR = big ? join(ROOT, '.cache', 'mt-big-build') : join(ROOT, 'src-tauri', 'assets', 'models', 'mt')
const DIST_DIR = join(ROOT, 'dist', 'models', 'models-v1')

const BASE_PAIRS = [
  {
    hf: 'Helsinki-NLP/opus-mt-en-zh',
    dir: 'opus-mt-en-zh-ct2',
    tokenizer: 'tok-en-zh',
    note: 'en→zh (Apache-2.0)',
  },
  {
    hf: 'Helsinki-NLP/opus-mt-zh-en',
    dir: 'opus-mt-zh-en-ct2',
    tokenizer: 'tok-zh-en',
    note: 'zh→en (CC-BY-4.0，需署名)',
  },
]

const BIG_PAIRS = [
  {
    hf: 'Helsinki-NLP/opus-mt-tc-big-en-zh',
    candidates: ['Helsinki-NLP/opus-mt-tc-big-en-zh', 'Helsinki-NLP/opus-mt-tc-big-en-zho'],
    dir: 'opus-mt-tc-big-en-zh-ct2',
    tokenizer: 'tok-tc-big-en-zh',
    note: 'en→zh tc-big (CC-BY-4.0)',
  },
  {
    hf: 'Helsinki-NLP/opus-mt-tc-big-zh-en',
    candidates: ['Helsinki-NLP/opus-mt-tc-big-zh-en', 'Helsinki-NLP/opus-mt-tc-big-zho-en'],
    dir: 'opus-mt-tc-big-zh-en-ct2',
    tokenizer: 'tok-tc-big-zh-en',
    note: 'zh→en tc-big (CC-BY-4.0)',
  },
]

const PAIRS = big ? BIG_PAIRS : BASE_PAIRS

const SPM_TO_JSON_SCRIPT = `
import sys, os, sentencepiece
sys.path.insert(0, os.path.dirname(sentencepiece.__file__))
from tokenizers import SentencePieceUnigramTokenizer
tok = SentencePieceUnigramTokenizer.from_spm(sys.argv[1])
tok.save(sys.argv[2])
`

async function exists(p) {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

async function dirSize(dir) {
  let total = 0
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    total += e.isDirectory() ? await dirSize(p) : (await stat(p)).size
  }
  return total
}

async function sha256File(path) {
  const { createHash } = await import('node:crypto')
  const { createReadStream } = await import('node:fs')
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolvePromise(hash.digest('hex')))
  })
}

async function resolveHf(pair) {
  if (!pair.candidates) return pair.hf
  const endpoint = (process.env.HF_ENDPOINT || 'https://huggingface.co').replace(/\/$/, '')
  for (const id of pair.candidates) {
    try {
      const res = await fetch(`${endpoint}/api/models/${id}`)
      if (res.ok) {
        process.stdout.write(`🔎 ${pair.note} → ${id}\n`)
        return id
      }
    } catch {
    }
  }
  throw new Error(`找不到 tc-big 仓库：${pair.candidates.join(' / ')}（检查网络/HF 访问）`)
}

async function packBig() {
  const notice = [
    'These model weights come from the Helsinki-NLP / OPUS-MT project (CC-BY-4.0).',
    'AudioScript converts them to CTranslate2 int8 and converts the SentencePiece',
    'vocabularies to tokenizer JSON. Training data is unchanged.',
    '',
    'Source: https://huggingface.co/Helsinki-NLP',
    'License: https://creativecommons.org/licenses/by/4.0/',
    '',
  ].join('\n')

  for (const pair of PAIRS) {
    await writeFile(join(MT_DIR, pair.dir, 'NOTICE.txt'), notice)
  }

  await mkdir(DIST_DIR, { recursive: true })
  const archive = join(DIST_DIR, 'opus-mt-tc-big-en-zh-zh-en-ct2-int8.tar.gz')
  await rm(archive, { force: true })
  process.stdout.write(`📦 打包 ${archive}\n`)
  run('tar', ['-czf', archive, '-C', MT_DIR, '.'])

  const sha = await sha256File(archive)
  const size = (await stat(archive)).size
  const installed = await dirSize(MT_DIR)
  const fragment = { id: 'mt-big', sha256: sha, sizeBytes: size, installedBytes: installed }
  if (printCatalog) {
    process.stdout.write(`\nCATALOG_FRAGMENT\n${JSON.stringify(fragment, null, 2)}\n`)
  } else {
    process.stdout.write(`sha256=${sha}\nsizeBytes=${size}\ninstalledBytes=${installed}\n`)
  }
}

async function isReady(dir) {
  return (
    (await exists(join(dir, 'model.bin'))) &&
    (await exists(join(dir, 'source-tokenizer.json'))) &&
    (await exists(join(dir, 'target-tokenizer.json')))
  )
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts })
  if (r.error) throw new Error(`无法执行 ${cmd}：${r.error.message}`)
  if (r.status !== 0) throw new Error(`${cmd} 退出码 ${r.status}`)
}

async function ensureVenv() {
  if (!(await exists(PY))) {
    process.stdout.write('🐍 创建 Python venv（一次性的，约 1-2 分钟）…\n')
    await mkdir(join(ROOT, '.cache'), { recursive: true })
    run(PYTHON, ['-m', 'venv', VENV])
    run(PY, ['-m', 'pip', 'install', '--quiet', '--upgrade', 'pip'])
  }

  const probe = spawnSync(
    PY,
    ['-c', 'import torch, ctranslate2, transformers, sentencepiece, google.protobuf'],
    { stdio: 'ignore' },
  )
  if (probe.status !== 0) {
    const v = spawnSync(PY, ['-V'], { encoding: 'utf8' })
    const version = (v.stdout || v.stderr || '').trim()
    process.stdout.write(`📦 安装转换依赖（torch 较大，首次约 3-5 分钟）… [${version}]\n`)
    run(PY, [
      '-m',
      'pip',
      'install',
      'torch',
      'ctranslate2',
      'transformers',
      'sentencepiece',
      'protobuf',
    ])
  }
}

async function fetchVocab(pair) {
  const out = join(TOK_CACHE, pair.tokenizer)
  if (!force && (await exists(join(out, 'source.spm')))) return out

  await mkdir(out, { recursive: true })
  process.stdout.write(`🔤 下载词表：${pair.hf}\n`)
  run(PY, [
    '-c',
    `from transformers import AutoTokenizer; \
AutoTokenizer.from_pretrained(${JSON.stringify(pair.hf)}).save_pretrained(${JSON.stringify(out)})`,
  ])
  return out
}

async function convert(pair) {
  const out = join(MT_DIR, pair.dir)
  if (!force && (await isReady(out))) {
    const size = await dirSize(out)
    process.stdout.write(
      `✅ ${pair.note} 已就绪（${(size / 1024 / 1024).toFixed(0)} MB）\n`,
    )
    return
  }

  await ensureVenv()
  const tokDir = await fetchVocab(pair)

  await mkdir(MT_DIR, { recursive: true })
  await rm(out, { recursive: true, force: true })

  process.stdout.write(`⬇️  转换 ${pair.note}（下载 fp32 权重 + 转 int8）…\n`)
  run(join(VENV_BIN, IS_WIN ? 'ct2-transformers-converter.exe' : 'ct2-transformers-converter'), [
    '--model',
    pair.hf,
    '--output_dir',
    out,
    '--quantization',
    'int8',
  ])

  for (const [spm, outName] of [
    ['source.spm', 'source-tokenizer.json'],
    ['target.spm', 'target-tokenizer.json'],
  ]) {
    process.stdout.write(`🔤 生成词表：${outName}\n`)
    run(PY, ['-c', SPM_TO_JSON_SCRIPT, join(tokDir, spm), join(out, outName)])
  }

  if (!(await isReady(out))) {
    throw new Error(`转换后仍缺文件：${out}`)
  }
  const size = await dirSize(out)
  process.stdout.write(`✅ ${pair.note} 完成（${(size / 1024 / 1024).toFixed(0)} MB）\n`)
}

async function main() {
  process.stdout.write(
    `${big ? '可选大模型' : '内置'}机器翻译模型（opus-mt + CTranslate2 int8）\n\n`,
  )
  if (big) {
    await rm(MT_DIR, { recursive: true, force: true })
    for (const pair of PAIRS) {
      pair.hf = await resolveHf(pair)
    }
  }

  for (const pair of PAIRS) {
    await convert(pair)
    await writeFile(join(MT_DIR, pair.dir, 'NOTICE.txt'), [
      `Source: https://huggingface.co/${pair.hf}`,
      'Attribution: Helsinki-NLP / OPUS-MT',
      `License: ${pair.note.includes('Apache-2.0') ? 'Apache-2.0 (https://www.apache.org/licenses/LICENSE-2.0)' : 'CC-BY-4.0 (https://creativecommons.org/licenses/by/4.0/)'}`,
      'AudioScript converts the model weights to CTranslate2 int8 and the SentencePiece vocabularies to tokenizer JSON.',
      'Training data is unchanged.',
      '',
    ].join('\n'))
  }

  const total = await dirSize(MT_DIR)
  process.stdout.write(`\n✅ 翻译模型全部就绪，合计 ${(total / 1024 / 1024).toFixed(0)} MB\n`)

  if (big) {
    await packBig()
  }
}

main().catch((e) => {
  console.error(`\n❌ ${e.message}`)
  process.exit(1)
})
