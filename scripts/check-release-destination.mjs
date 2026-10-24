#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'

export async function assertReleaseAvailable({ repository, tag, token, request = fetch }) {
  assert.match(repository, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, '仓库名无效')
  assert.match(tag, /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, '发布标签无效')
  assert.ok(token, '发布检查缺少 GitHub 授权')
  for (let page = 1; page <= 100; page++) {
    const response = await request(`https://api.github.com/repos/${repository}/releases?per_page=100&page=${page}`, { headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28' }, signal: AbortSignal.timeout(30_000) })
    assert.ok(response.ok, `无法确认发布目标（HTTP ${response.status}），停止发布`)
    const releases = await response.json()
    assert.ok(Array.isArray(releases), 'Release 列表格式错误')
    assert.ok(!releases.some(item => item.tag_name === tag), `${tag} 已有 Release 或草稿，禁止覆盖`)
    if (releases.length < 100) return
  }
  throw new Error('Release 列表超出检查范围，停止发布')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const project = JSON.parse(readFileSync(new URL('../project.json', import.meta.url), 'utf8'))
    const repository = project.repository.replace('https://github.com/', '')
    assert.equal(process.env.GITHUB_REPOSITORY, repository, '只能发布到本 fork')
    await assertReleaseAvailable({ repository, tag: process.env.GITHUB_REF_NAME, token: process.env.GH_TOKEN })
    console.log('发布目标可用，不存在同名 Release 或草稿。')
  } catch (error) {
    console.error(`发布目标检查失败：${error.message}`)
    process.exitCode = 1
  }
}
