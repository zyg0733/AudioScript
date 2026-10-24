import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

const page = readFileSync(new URL('../docs/index.html', import.meta.url), 'utf8')
const project = JSON.parse(readFileSync(new URL('../project.json', import.meta.url), 'utf8'))
const api = page.match(/var API = '([^']+)'/)?.[1]
const cacheKey = page.match(/var RELEASE_KEY = '([^']+)'/)?.[1]
const ttl = 10 * 60 * 1000
const suffixes = [...page.matchAll(/data-asset="([^"]+)"/g)].map((match) => match[1])
const loaderStart = page.indexOf('        function renderRelease()')
const loaderEnd = page.indexOf('        function initDownload()', loaderStart)
assert.ok(loaderStart >= 0 && loaderEnd > loaderStart, '官网 Release 加载逻辑未找到')
const loader = page.slice(loaderStart, loaderEnd)

function releaseFixture(version = '9.8.7') {
  return {
    tag_name: `v${version}`,
    published_at: '2026-10-24T10:00:00Z',
    assets: [
      `AudioScript_${version}_aarch64.dmg`,
      `AudioScript_${version}_x64-setup.exe`,
      `AudioScript_${version}_x64_en-US.msi`,
      `AudioScript_${version}_amd64.deb`,
      `AudioScript_${version}_amd64.AppImage`,
      'AudioScript.app.tar.gz',
      'latest.json',
    ].map((name) => ({ name, browser_download_url: `${project.repository}/releases/download/v${version}/${name}` })),
  }
}

function harness({ cache = new Map(), payload = releaseFixture(), status = 200 } = {}) {
  const version = { textContent: 'Fork Releases' }
  const date = { textContent: '—' }
  const buttons = suffixes.map((suffix) => ({
    href: `${project.repository}/releases/latest`,
    getAttribute: () => suffix,
    setAttribute(name, value) {
      assert.equal(name, 'href')
      this.href = value
    },
  }))
  const requests = []
  const context = {
    release: null,
    API: api,
    RELEASE_KEY: cacheKey,
    RELEASE_TTL: ttl,
    $: (selector) => ({ '[data-version]': version, '[data-date]': date })[selector],
    $$: (selector) => (selector === '[data-asset]' ? buttons : []),
    sessionStorage: {
      getItem: (key) => cache.get(key) ?? null,
      setItem: (key, value) => cache.set(key, value),
    },
    AbortController,
    setTimeout: () => 1,
    clearTimeout: () => {},
    fetch: async (url) => {
      requests.push(url)
      return { ok: status >= 200 && status < 300, status, json: async () => payload }
    },
  }
  runInNewContext(loader, context)
  return {
    cache,
    buttons,
    version,
    date,
    requests,
    async load() {
      context.loadRelease()
      await new Promise(setImmediate)
    },
  }
}

test('官网把正式版本的五种安装包映射到本 fork 下载按钮，并显示 tag 和日期', async () => {
  assert.equal(api, project.repository.replace('https://github.com/', 'https://api.github.com/repos/') + '/releases/latest')
  assert.deepEqual(suffixes, ['aarch64.dmg', 'x64-setup.exe', 'x64_en-US.msi', 'amd64.deb', 'amd64.AppImage'])
  const site = harness()
  await site.load()
  assert.deepEqual(site.requests, [api])
  assert.equal(site.version.textContent, 'v9.8.7')
  assert.equal(site.date.textContent, '2026-10-24')
  site.buttons.forEach((button, index) => {
    assert.ok(button.href.startsWith(`${project.repository}/releases/download/v9.8.7/`))
    assert.ok(button.href.endsWith(suffixes[index]))
  })
})

test('首发之前的 404 不写缓存，发布后刷新页面可重新获取下载地址', async () => {
  const firstVisit = harness({ status: 404 })
  await firstVisit.load()
  assert.equal(firstVisit.cache.has(cacheKey), false)
  assert.ok(firstVisit.buttons.every((button) => button.href === `${project.repository}/releases/latest`))

  const afterPublication = harness({ cache: firstVisit.cache })
  await afterPublication.load()
  assert.deepEqual(afterPublication.requests, [api])
  assert.equal(afterPublication.version.textContent, 'v9.8.7')
  assert.equal(afterPublication.cache.has(cacheKey), true)
})

test('十分钟内的成功缓存可复用，缓存过期后重新请求新版本', async () => {
  const cached = {
    time: Date.now(),
    data: { tag: 'v1.0.0', date: '2026-10-23', assets: {} },
  }
  const cache = new Map([[cacheKey, JSON.stringify(cached)]])
  const freshVisit = harness({ cache })
  await freshVisit.load()
  assert.equal(freshVisit.requests.length, 0)
  assert.equal(freshVisit.version.textContent, 'v1.0.0')

  cached.time = Date.now() - ttl - 1
  cache.set(cacheKey, JSON.stringify(cached))
  const expiredVisit = harness({ cache })
  await expiredVisit.load()
  assert.deepEqual(expiredVisit.requests, [api])
  assert.equal(expiredVisit.version.textContent, 'v9.8.7')
})
