import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertReleaseAvailable } from './check-release-destination.mjs'

const options = { repository: 'zyg0733/AudioScript', tag: 'v1.2.3', token: 'synthetic-test-token' }
test('公开版本和草稿均不得覆盖，API错误不能当作版本不存在', async () => {
  for (const draft of [true, false]) {
    await assert.rejects(assertReleaseAvailable({ ...options, request: async () => ({ ok: true, json: async () => [{ tag_name: options.tag, draft }] }) }), /禁止覆盖/)
  }
  for (const status of [401, 403, 404, 429, 500]) {
    await assert.rejects(assertReleaseAvailable({ ...options, request: async () => ({ ok: false, status }) }), /停止发布/)
  }
})
test('遍历后续页，确认没有同名版本才允许创建', async () => {
  let calls = 0
  await assertReleaseAvailable({ ...options, request: async () => ({ ok: true, json: async () => ++calls === 1 ? Array.from({ length: 100 }, (_, i) => ({ tag_name: `v0.0.${i}` })) : [] }) })
  assert.equal(calls, 2)
  await assert.rejects(assertReleaseAvailable({ ...options, request: async () => ({ ok: true, json: async () => [{ tag_name: options.tag }] }) }), /禁止覆盖/)
})
