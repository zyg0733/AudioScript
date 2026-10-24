import assert from 'node:assert/strict'
import { writeFileSync, existsSync } from 'node:fs'
import { test } from 'node:test'
import { checkUpdaterSigning } from './check-updater-signing.mjs'

const env = { TAURI_UPDATER_PUBLIC_KEY: Buffer.from('public fixture').toString('base64'), TAURI_SIGNING_PRIVATE_KEY: 'synthetic-private-fixture', TAURI_SIGNING_PRIVATE_KEY_PASSWORD: 'synthetic-password-fixture' }
test('前置挑战只把私钥交给官方签名器，验签不接收私钥，临时文件始终清理', () => {
  let challenge
  const calls = []
  checkUpdaterSigning({ env, execute(command, args, options) {
    calls.push(command)
    if (calls.length === 1) {
      challenge = args.at(-1)
      assert.equal(options.env.TAURI_SIGNING_PRIVATE_KEY, env.TAURI_SIGNING_PRIVATE_KEY)
      assert.equal(args.includes(env.TAURI_SIGNING_PRIVATE_KEY), false)
      writeFileSync(`${challenge}.sig`, Buffer.from('synthetic signature fixture').toString('base64'))
    } else {
      assert.equal(command, 'minisign')
      assert.equal(options.env.TAURI_SIGNING_PRIVATE_KEY, undefined)
      assert.equal(options.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD, undefined)
    }
  } })
  assert.equal(calls.length, 2)
  assert.equal(existsSync(challenge), false)
})
test('私钥或密码错误和公私钥不匹配均阻止构建，错误不泄露签名器输出', () => {
  for (const failAt of [1, 2]) {
    let calls = 0
    let challenge
    assert.throws(() => checkUpdaterSigning({ env, execute(command, args) {
      if (++calls === failAt) throw new Error(env.TAURI_SIGNING_PRIVATE_KEY)
      challenge = args.at(-1)
      writeFileSync(`${challenge}.sig`, Buffer.from('fixture').toString('base64'))
    } }), error => !error.message.includes(env.TAURI_SIGNING_PRIVATE_KEY) && /挑战/.test(error.message))
    if (challenge) assert.equal(existsSync(challenge), false)
  }
})
