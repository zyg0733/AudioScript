#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export function checkUpdaterSigning({ directory = root, env = process.env, execute = execFileSync } = {}) {
  assert.ok(env.TAURI_UPDATER_PUBLIC_KEY && env.TAURI_SIGNING_PRIVATE_KEY, '签名挑战缺少本项目公钥或私钥配置')
  const temporary = mkdtempSync(join(tmpdir(), 'audioscript-signing-check-'))
  try {
    const version = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).version
    const challenge = join(temporary, 'challenge.txt')
    writeFileSync(challenge, `AudioScript ${version} ${randomBytes(32).toString('hex')}\n`, { mode: 0o600 })
    const publicFile = join(temporary, 'public.pub')
    writeFileSync(publicFile, Buffer.from(env.TAURI_UPDATER_PUBLIC_KEY, 'base64'), { mode: 0o600 })
    try {
      execute(process.execPath, [join(directory, 'node_modules/@tauri-apps/cli/tauri.js'), 'signer', 'sign', '--app-version', version, challenge], { cwd: directory, env: { ...env, CI: 'true' }, stdio: 'pipe', timeout: 60_000 })
    } catch {
      throw new Error('签名挑战失败，请核对本项目私钥及密码；未输出签名工具日志')
    }
    const rawSignature = readFileSync(`${challenge}.sig`, 'utf8').trim()
    assert.equal(Buffer.from(rawSignature, 'base64').toString('base64'), rawSignature, '签名挑战返回无效签名格式')
    const signatureFile = join(temporary, 'challenge.minisig')
    writeFileSync(signatureFile, Buffer.from(rawSignature, 'base64'), { mode: 0o600 })
    const verifyEnv = { ...env }
    delete verifyEnv.TAURI_SIGNING_PRIVATE_KEY
    delete verifyEnv.TAURI_SIGNING_PRIVATE_KEY_PASSWORD
    try {
      execute('minisign', ['-Vm', challenge, '-p', publicFile, '-x', signatureFile], { env: verifyEnv, stdio: 'pipe', timeout: 30_000 })
    } catch {
      throw new Error('签名挑战验签失败，仓库公钥与私钥不匹配')
    }
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    checkUpdaterSigning()
    console.log('签名挑战及自有公钥验签通过。')
  } catch (error) {
    console.error(`签名配置校验失败：${error.message}`)
    process.exitCode = 1
  }
}
