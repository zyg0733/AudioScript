#!/usr/bin/env node
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, lstatSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export function verifyReleaseUpload({ metadata, assetDir, draft, tagCommit }) {
  const provenance = JSON.parse(readFileSync(join(assetDir, 'release-verification.json'), 'utf8'))
  const project = JSON.parse(readFileSync(new URL('../project.json', import.meta.url), 'utf8'))
  const repository = project.repository.replace('https://github.com/', '')
  assert.equal(provenance.repository, repository, '发布报告不是本 fork')
  assert.match(provenance.commit, /^[a-f0-9]{40}$/, '发布报告缺少准确提交')
  assert.equal(tagCommit, provenance.commit, '远端标签实际提交与已验证提交不一致')
  assert.equal(provenance.tag, `v${provenance.version}`)
  assert.equal(metadata.tag_name, provenance.tag, 'Release 标签不匹配')
  assert.equal(metadata.target_commitish, provenance.commit, 'Release 目标不是已验证提交')
  assert.equal(metadata.draft, draft, 'Release 公开状态不匹配')
  assert.equal(metadata.prerelease, false, '正式更新不能指向预发布')
  const names = readdirSync(assetDir).sort()
  assert.ok(names.includes('latest.json') && names.includes('SHA256SUMS.txt'), '发布附件不完整')
  assert.deepEqual(metadata.assets.map(item => item.name).sort(), names, '服务端附件缺失、重复或多出文件')
  assert.ok(metadata.html_url.startsWith(`${project.repository}/releases/tag/`), 'Release 地址不属于本 fork')
  const assetTag = metadata.html_url.split('/').at(-1)
  assert.ok(assetTag === provenance.tag || (draft && /^untagged-[a-f0-9]+$/.test(assetTag)), 'Release 下载标签无效')
  for (const name of names) {
    const path = join(assetDir, name)
    assert.ok(lstatSync(path).isFile(), '发布文件必须为普通文件')
    const bytes = readFileSync(path)
    const asset = metadata.assets.find(item => item.name === name)
    assert.equal(asset.state, 'uploaded', `${name} 尚未上传完成`)
    assert.equal(asset.size, bytes.length, `${name} 服务端体积错误`)
    assert.equal(asset.digest, `sha256:${createHash('sha256').update(bytes).digest('hex')}`, `${name} 服务端 SHA-256 不一致`)
    assert.equal(asset.browser_download_url, `${project.repository}/releases/download/${assetTag}/${name}`, `${name} 下载来源错误`)
  }
  return names.length
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2)
    const value = name => args[args.indexOf(name) + 1]
    assert.ok(args.includes('--metadata') && args.includes('--asset-dir') && args.includes('--tag-commit'), '缺少发布元数据、附件目录或远端标签提交')
    assert.notEqual(args.includes('--draft'), args.includes('--published'), '必须指定草稿或公开状态')
    const count = verifyReleaseUpload({ metadata: JSON.parse(readFileSync(value('--metadata'), 'utf8')), assetDir: resolve(value('--asset-dir')), tagCommit: value('--tag-commit'), draft: args.includes('--draft') })
    console.log(`发布的 ${count} 个附件与已验证文件逐项一致。`)
  } catch (error) {
    console.error(`发布附件检查失败：${error.message}`)
    process.exitCode = 1
  }
}
