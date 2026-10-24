import assert from 'node:assert/strict'
import { test } from 'node:test'
import { releaseVersion } from './verify-release-version.mjs'

const fixture = () => ({ package: '{"version":"1.2.3"}', tauri: '{"version":"1.2.3"}', cargo: '[package]\nname = "audioscript"\nversion = "1.2.3"\n\n[dependencies]\nother = "9.9.9"', lock: '[[package]]\nname = "other"\nversion = "9.9.9"\n\n[[package]]\nname = "audioscript"\nversion = "1.2.3"\n', site: '{"softwareVersion":"1.2.3"}' })

test('发布校验绑定五处应用版本与标签，忽略其他依赖版本', () => {
  assert.equal(releaseVersion(fixture(), 'v1.2.3'), '1.2.3')
  assert.throws(() => releaseVersion(fixture(), 'v9.9.9'), /标签/)
  for (const key of Object.keys(fixture())) {
    const sources = fixture()
    sources[key] = sources[key].replace('1.2.3', '1.2.4')
    assert.throws(() => releaseVersion(sources))
  }
})

test('缺失版本、非正式版本和缺失应用包拒绝发布', () => {
  for (const version of ['01.2.3', '1.2.3-beta.1', '1.2', '']) {
    assert.throws(() => releaseVersion({ ...fixture(), package: JSON.stringify({ version }) }))
  }
  assert.throws(() => releaseVersion({ ...fixture(), cargo: '[package]\nname = "other"\nversion = "1.2.3"' }), /应用包/)
  assert.throws(() => releaseVersion({ ...fixture(), site: '{}' }), /官网/)
})
