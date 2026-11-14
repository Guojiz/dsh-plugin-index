#!/usr/bin/env node
/**
 * Build a public, large-scale DSH plugin index (format 1) straight from the npm registry.
 *
 *   node build-index.mjs [--out index.json] [--max-versions 12]
 *
 * Discovery: the registry search API supplies candidate package names; a candidate is a
 * DSH bundle only when some published version carries the `dsh.bundle` manifest field.
 * Every accepted version is emitted with its exact publish time, so the market can sort
 * by recency and pin an install spec per version.
 *
 * Validation runs through the validator DSH itself uses, so a build that would be
 * rejected by the Discover tab fails here first.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

/**
 * Prefer the validator installed as a dependency (CI), and fall back to the copy inside the
 * local DSH application so the builder also runs on a machine that has no npm install step.
 */
const APP_MODULES = process.env.DSH_APP_MODULES
  ?? '/Applications/DeepSeek Harness.app/Contents/Resources/app/dsh/node_modules'
const loadModule = async (specifier, fallbackRelative) => {
  try {
    return await import(specifier)
  } catch {
    return await import(pathToFileURL(`${APP_MODULES}/${fallbackRelative}`).href)
  }
}
const { parseMarketIndex, MarketIndexError } = await loadModule(
  '@deepseek-ai/dsh-plugin-market-index',
  '@deepseek-ai/dsh-plugin-market-index/lib/index.js',
)
const semver = (await loadModule('semver', 'semver/index.js')).default

const args = process.argv.slice(2)
const argOf = (flag, fallback) => {
  const at = args.indexOf(flag)
  return at === -1 ? fallback : args[at + 1]
}
const OUT = argOf('--out', 'index.json')
const MAX_VERSIONS = Number(argOf('--max-versions', '12'))
const INDEX_URL = argOf('--url', 'https://raw.githubusercontent.com/Guojiz/dsh-plugin-index/main/index.json')

const SEARCHES = [
  '@deepseek-ai/dsh',
  'dsh-bundle',
  'dsh-plugin',
  'deepseek-harness',
  'deepseek harness plugin',
  'keywords:dsh',
  'keywords:dsh-bundle',
  'keywords:dsh-plugin',
  'keywords:deepseek-harness',
]
/** Read mirrors in order; npmjs is canonical but is reset on some networks, so npmmirror backs it. */
const MIRRORS = (argOf('--mirrors', 'https://registry.npmmirror.com,https://registry.npmjs.org')).split(',')
let activeMirror = MIRRORS[0]

/** Fetch JSON from the first reachable mirror, with retries and mirror failover. */
async function getJson(path, attempts = 4) {
  let lastError
  for (const mirror of [activeMirror, ...MIRRORS.filter(base => base !== activeMirror)]) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const response = await fetch(`${mirror}${path}`, {
          headers: { 'user-agent': 'dsh-plugin-index-builder', accept: 'application/json' },
          signal: AbortSignal.timeout(45_000),
        })
        if (response.status === 404) return undefined
        if (!response.ok) throw new Error(`HTTP ${String(response.status)}`)
        const body = await response.json()
        activeMirror = mirror
        return body
      } catch (error) {
        lastError = error
        await new Promise(resolve => setTimeout(resolve, 500 * attempt ** 2))
      }
    }
  }
  throw lastError
}

/** Run `worker` over `items` with bounded concurrency, preserving input order. */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length)
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      results[index] = await worker(items[index], index)
    }
  })
  await Promise.all(runners)
  return results
}

// ---------------------------------------------------------------- discovery

const candidates = new Set()
for (const text of SEARCHES) {
  for (let from = 0; from < 1000; from += 250) {
    const page = await getJson(`/-/v1/search?text=${encodeURIComponent(text)}&size=250&from=${String(from)}`)
    const objects = page?.objects ?? []
    for (const object of objects) candidates.add(object.package.name)
    if (objects.length < 250) break
  }
  process.stderr.write(`search ${JSON.stringify(text)}: ${String(candidates.size)} candidates so far\n`)
}

// --------------------------------------------------------------- packuments

// A DSH bundle names DSH somewhere, so the irrelevant tail of a fuzzy registry search
// (any package that merely matched the query text) is dropped before the packument pass.
const relevant = [...candidates].filter(name => /dsh|deepseek|harness/iu.test(name))
process.stderr.write(`packuments: ${String(relevant.length)} of ${String(candidates.size)} candidates look DSH-related\n`)
let fetched = 0
const packuments = await mapLimit(relevant, 12, async (name) => {
  const doc = await getJson(`/${name.replace('/', '%2f')}`)
  if (++fetched % 100 === 0) {
    process.stderr.write(`  ${String(fetched)}/${String(relevant.length)}\n`)
  }
  if (!doc?.versions) return undefined
  return doc
})

const cleanUrl = (value) => {
  if (typeof value !== 'string') return undefined
  let text = value.trim()
  if (text.startsWith('git+')) text = text.slice(4)
  if (text.startsWith('git@github.com:')) text = `https://github.com/${text.slice('git@github.com:'.length)}`
  if (/^[\w.-]+\/[\w.-]+$/u.test(text)) return undefined
  if (!/^https?:\/\//u.test(text)) return undefined
  text = text.replace(/\.git$/u, '').replace(/\/+$/u, '')
  try {
    const url = new URL(text)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
    if (url.username || url.password || url.search || url.hash) return undefined
    return url.href
  } catch {
    return undefined
  }
}

/** A repository directory as the format accepts it: relative, printable segments, no `.` or `..`. */
const cleanDirectory = (value) => {
  if (typeof value !== 'string') return undefined
  const text = value.trim().replace(/^\.\//u, '').replace(/\/+$/u, '')
  if (text === '' || text.startsWith('/')) return undefined
  const segments = text.split('/')
  if (segments.some(segment => segment === '.' || segment === '..' || !/^[A-Za-z0-9._@+-]+$/u.test(segment))) return undefined
  return text
}

const homepageOf = (doc, version) => {
  for (const candidate of [version.homepage, doc.homepage]) {
    if (typeof candidate !== 'string') continue
    try {
      const url = new URL(candidate)
      if (url.protocol === 'https:' || url.protocol === 'http:') return url.href
    } catch { /* keep looking */ }
  }
  return undefined
}

const authorOf = (manifest) => {
  const author = manifest.author
  if (typeof author === 'object' && typeof author?.name === 'string') return author.name
  if (typeof author === 'string' && author.trim() !== '') return author
  return undefined
}

const titleOf = (name) => {
  const tail = name.includes('/') ? name.split('/')[1] : name
  const words = tail.replace(/^dsh-/u, '').replace(/-bundle$/u, '').split('-').filter(Boolean)
  return words.map((word) => word === 'dsh' ? 'DSH' : word[0].toUpperCase() + word.slice(1)).join(' ')
}

const CORE = new Set([
  '@deepseek-ai/dsh-base',
  '@deepseek-ai/dsh-web-app',
  '@deepseek-ai/dsh-headless',
  '@deepseek-ai/dsh-acp-app',
  '@deepseek-ai/dsh-sdk-app',
  '@deepseek-ai/dsh-sdk-minimal',
])

const categoryOf = (name) => {
  if (CORE.has(name)) return 'core'
  if (name.includes('experimental')) return 'experimental'
  return 'extension'
}

const plugins = []
const skipped = { noBundle: 0, badVersion: 0 }

for (const doc of packuments) {
  if (!doc) continue
  const versions = Object.keys(doc.versions)
  const bundleVersions = versions.filter(version => doc.versions[version].dsh?.bundle)
  if (bundleVersions.length === 0) { skipped.noBundle++; continue }

  const name = doc.name
  const times = doc.time ?? {}

  const published = bundleVersions
    .map((version) => {
      const manifest = doc.versions[version]
      const iso = times[version]
      const parsed = typeof iso === 'string' ? Date.parse(iso) : Number.NaN
      const publishTimestamp = Math.floor(parsed / 1000)
      if (!Number.isInteger(publishTimestamp) || publishTimestamp <= 0) return undefined
      const enginesRange = manifest.engines?.dsh
      const engines = typeof enginesRange === 'string'
        && !enginesRange.startsWith('workspace:')
        && semver.validRange(enginesRange) !== null
        ? { dsh: enginesRange }
        : undefined
      return {
        version,
        publishTimestamp,
        source: { type: 'npm' },
        ...engines === undefined ? {} : { engines },
      }
    })
    .filter(Boolean)
    .sort((left, right) => semver.rcompare(left.version, right.version))
    .slice(0, MAX_VERSIONS)

  if (published.length === 0) { skipped.badVersion++; continue }

  // Presentation comes from the newest version that is actually a bundle; a package may
  // have dropped `dsh.bundle` in a later release, so the dist-tag manifest is no guide.
  const newest = published[0].version
  const bundleDoc = doc.versions[newest]
  const latestDoc = doc.versions[doc['dist-tags']?.latest] ?? bundleDoc
  const bundleField = bundleDoc.dsh?.bundle ?? {}

  const repositoryUrl = cleanUrl(bundleDoc.repository?.url ?? latestDoc.repository?.url)
  const directory = cleanDirectory(bundleDoc.repository?.directory ?? latestDoc.repository?.directory)
  const keywords = Array.isArray(bundleDoc.keywords)
    ? bundleDoc.keywords.filter(keyword => typeof keyword === 'string').slice(0, 12)
    : []
  const labels = []
  if (name.startsWith('@deepseek-ai/')) labels.push('official')
  if (name.includes('experimental')) labels.push('experimental')
  if (bundleField.listedByDefault === false) labels.push('opt-in')
  if (Array.isArray(bundleField.platforms)) labels.push('platform-specific')

  plugins.push({
    name,
    title: { en: titleOf(name) },
    ...typeof (bundleDoc.description ?? latestDoc.description) === 'string'
      && (bundleDoc.description ?? latestDoc.description).trim() !== ''
      ? { description: { en: bundleDoc.description ?? latestDoc.description } }
      : {},
    ...authorOf(bundleDoc) === undefined ? {} : { author: authorOf(bundleDoc) },
    ...homepageOf(doc, bundleDoc) === undefined ? {} : { homepage: homepageOf(doc, bundleDoc) },
    ...repositoryUrl === undefined ? {} : {
      repository: {
        url: repositoryUrl,
        ...directory === undefined ? {} : { directory },
      },
    },
    metadata: {
      category: categoryOf(name),
      keywords,
      labels,
      sortKeys: { publishedTimestamp: published[0].publishTimestamp },
    },
    versions: published,
  })
}

plugins.sort((left, right) => {
  const official = Number(right.name.startsWith('@deepseek-ai/')) - Number(left.name.startsWith('@deepseek-ai/'))
  return official !== 0 ? official : left.name.localeCompare(right.name)
})

// ------------------------------------------------------------------ output

const index = {
  format: 1,
  title: {
    en: 'DSH Plugin Index',
    zh: 'DSH 插件索引',
  },
  description: {
    en: `Public index of ${String(plugins.length)} DSH bundles published to npm, rebuilt from the registry.`,
    zh: `公开索引：收录 npm 上 ${String(plugins.length)} 个 DSH 组合包，按 registry 重建。`,
  },
  metadata: {
    categories: {
      core: { title: { en: 'Core profile', zh: '核心 profile' } },
      experimental: { title: { en: 'Experimental', zh: '实验特性' } },
      extension: { title: { en: 'Extension', zh: '扩展' } },
    },
    labels: {
      official: { title: { en: 'Official', zh: '官方' } },
      experimental: { title: { en: 'Experimental', zh: '实验' } },
      'opt-in': { title: { en: 'Opt-in', zh: '需手动启用' } },
      'platform-specific': { title: { en: 'Platform-specific', zh: '限定平台' } },
    },
    sortKeys: {
      publishedTimestamp: { title: { en: 'Recently published', zh: '最近发布' }, order: 'desc' },
    },
  },
  plugins,
}

let validated
try {
  validated = parseMarketIndex(index, INDEX_URL)
} catch (error) {
  if (error instanceof MarketIndexError) {
    console.error(`FAIL  ${error.path}  ${error.reason}`)
    process.exitCode = 1
    process.exit()
  }
  throw error
}

await writeFile(OUT, `${JSON.stringify(index, null, 2)}\n`)
const bytes = (await readFile(OUT)).byteLength
console.error(`PASS  ${OUT}  ${String(bytes)} bytes`)
console.error(`      ${String(validated.plugins.length)} plugin(s), ${String(validated.plugins.reduce((sum, plugin) => sum + plugin.versions.length, 0))} version(s); skipped ${String(skipped.noBundle)} non-bundle, ${String(skipped.badVersion)} without publish time`)
