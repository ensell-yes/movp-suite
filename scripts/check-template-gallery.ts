import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { generate } from '@movp/codegen'
import { schemaFingerprint, type MovpSchema } from '@movp/core-schema'
// 06d owns the untrusted-I/O guards. Build create-movp before running this gate so its public dist
// surface supplies the same implementation used by published scaffolds.
import { copyFileGuarded, readFileGuarded, MAX_FILE_BYTES } from '../packages/create-movp/dist/index.js'

interface TemplateSpec {
  name: string
  projectCollections: string[]
  reusesPlatform: string[]
  pages: string[]
}

const TEMPLATES: TemplateSpec[] = [
  {
    name: 'marketing-site',
    projectCollections: ['author', 'newsletter_subscriber'],
    reusesPlatform: ['content_item', 'content_seo', 'content_schedule'],
    pages: ['src/pages/blog/index.astro'],
  },
]

const DEFAULT_TEMPLATES_DIR = 'templates'
const HEX64 = /^[0-9a-f]{64}$/

function fail(name: string, reason: string): never {
  throw new Error(`template_gallery_invalid: [${name}] ${reason}`)
}

function argValue(flag: string): string | undefined {
  const inline = process.argv.find((arg) => arg.startsWith(`${flag}=`))
  if (inline !== undefined) return inline.slice(flag.length + 1)
  const index = process.argv.indexOf(flag)
  return index === -1 ? undefined : process.argv[index + 1]
}

function assertRegularFile(name: string, path: string, what: string): void {
  const info = lstatSync(path, { throwIfNoEntry: false })
  if (info === undefined) fail(name, `missing ${what}: ${path}`)
  if (info.isSymbolicLink()) fail(name, `${what} rejected unread - template_symlink_rejected: ${path}`)
  if (!info.isFile()) fail(name, `${what} rejected unread - template_not_regular_file: ${path}`)
  if (info.size > MAX_FILE_BYTES) fail(name, `${what} rejected unread - template_file_too_large: ${path}`)
}

function readTemplateText(name: string, path: string, what: string): string {
  try {
    return readFileGuarded(path).toString('utf8')
  } catch (error) {
    fail(name, `${what} rejected by the guarded read - ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function loadSchema(dir: string, name: string): Promise<MovpSchema> {
  const modulePath = join(dir, 'supabase', 'functions', '_shared', 'schema.ts')
  // lstat must precede import(): importing a symlink executes its target.
  assertRegularFile(name, modulePath, 'schema module')
  const module: unknown = await import(pathToFileURL(modulePath).href)
  const schema = (module as { schema?: unknown }).schema
  if (typeof schema !== 'object' || schema === null || !Array.isArray((schema as MovpSchema).collections)) {
    fail(name, 'schema module must export a `schema` MovpSchema')
  }
  return schema as MovpSchema
}

function assertComposition(name: string, schema: MovpSchema, spec: TemplateSpec): void {
  const project = schema.projectCollections.map((collection) => collection.name).sort()
  if (JSON.stringify(project) !== JSON.stringify([...spec.projectCollections].sort())) {
    fail(name, `projectCollections ${JSON.stringify(project)} !== expected ${JSON.stringify(spec.projectCollections)}`)
  }
  for (const collection of schema.projectCollections) {
    if (collection.layer !== 'project') fail(name, `project collection "${collection.name}" has layer="${collection.layer}"`)
  }
  const platformNames = new Set(schema.platformCollections.map((collection) => collection.name))
  for (const collection of schema.platformCollections) {
    if (collection.layer !== 'platform') fail(name, `platform collection "${collection.name}" has layer="${collection.layer}"`)
  }
  for (const required of spec.reusesPlatform) {
    if (!platformNames.has(required)) fail(name, `expected to inherit platform collection "${required}"`)
  }
  const fingerprint = schemaFingerprint(schema)
  if (!HEX64.test(fingerprint)) fail(name, `schemaFingerprint is not 64-hex: ${fingerprint}`)
}

async function assertProjectCodegen(name: string, dir: string, schema: MovpSchema, spec: TemplateSpec): Promise<void> {
  const registrySource = join(dir, 'movp.deltas.json')
  if (!existsSync(registrySource)) fail(name, 'missing movp.deltas.json')
  const scratch = mkdtempSync(join(tmpdir(), `movp-tmpl-${name}-`))
  try {
    const migrationsDir = join(scratch, 'supabase', 'migrations')
    const registryPath = join(scratch, 'movp.deltas.json')
    try {
      copyFileGuarded(registrySource, registryPath)
    } catch (error) {
      fail(name, `movp.deltas.json rejected by the guarded copy - ${error instanceof Error ? error.message : String(error)}`)
    }
    const manifestPath = join(scratch, 'movp.schema.json')
    const baseline = '20260713000200_movp_generated.sql'
    const options = {
      schema,
      migrationsDir,
      migrationName: baseline,
      deltasRegistryPath: registryPath,
      manifestPath,
    }

    await generate(options)
    // These reads consume files just written into this process's private scratch directory, not
    // untrusted template input.
    const first = readFileSync(join(migrationsDir, baseline), 'utf8')
    await generate(options)
    const second = readFileSync(join(migrationsDir, baseline), 'utf8')
    if (first !== second) fail(name, 'project baseline is not byte-stable across two runs (immutability)')

    for (const collection of spec.projectCollections) {
      if (!first.includes(`create table if not exists public.${collection} (`)) {
        fail(name, `baseline missing project table ${collection}`)
      }
    }
    if (!first.includes("'project')")) fail(name, 'baseline missing layer=project metadata')
    if (first.includes('create table if not exists public.movp_collections')) {
      fail(name, 'baseline re-emits platform metadata infra (must not)')
    }
    for (const platformTable of spec.reusesPlatform) {
      if (first.includes(`create table if not exists public.${platformTable} (`)) {
        fail(name, `baseline re-emits inherited platform table ${platformTable} (must not)`)
      }
    }
    if (!existsSync(manifestPath)) fail(name, 'movp.schema.json manifest not written')
    void readdirSync(migrationsDir)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

function assertAssets(name: string, dir: string, spec: TemplateSpec): void {
  const seedPath = join(dir, 'supabase', 'seed.sql')
  if (!existsSync(seedPath)) fail(name, 'missing supabase/seed.sql')
  const seed = readTemplateText(name, seedPath, 'supabase/seed.sql')
  if (/\.\.\/|\/Code\/supasuite|packages\/[a-z]/.test(seed)) fail(name, 'seed.sql leaks a source-repo path')
  for (const page of spec.pages) {
    const pagePath = join(dir, page)
    if (!existsSync(pagePath)) fail(name, `missing page ${page}`)
    const text = readTemplateText(name, pagePath, `page ${page}`)
    if (!/Base\.astro/.test(text)) fail(name, `page ${page} must import the Base layout`)
    if (/[:<]\s*any\b|\bas any\b/.test(text)) fail(name, `page ${page} uses the any type`)
  }
  if (!existsSync(join(dir, 'README.md'))) fail(name, 'missing README.md')
  if (!existsSync(join(dir, 'movp.config.mjs'))) fail(name, 'missing movp.config.mjs')
  if (!existsSync(join(dir, 'supabase', 'config.toml'))) fail(name, 'missing supabase/config.toml')
  if (!existsSync(join(dir, 'package.json.template'))) fail(name, 'missing package.json.template')
  if (existsSync(join(dir, 'package.json'))) fail(name, 'committed a bare package.json (must be package.json.template)')
}

async function main(): Promise<void> {
  const only = argValue('--template')
  const templatesDir = argValue('--templates-dir') ?? DEFAULT_TEMPLATES_DIR
  const selected = only ? TEMPLATES.filter((template) => template.name === only) : TEMPLATES
  if (only && selected.length === 0) throw new Error(`unknown template: ${only}`)
  console.log(`template-gallery: templates-dir=${templatesDir}`)
  for (const spec of selected) {
    const dir = join(templatesDir, spec.name)
    // Structural guarded reads run before importing or executing the schema module.
    assertAssets(spec.name, dir, spec)
    const schema = await loadSchema(dir, spec.name)
    assertComposition(spec.name, schema, spec)
    await assertProjectCodegen(spec.name, dir, schema, spec)
    console.log(`template-gallery: ${spec.name} OK`)
  }
  console.log(`template-gallery: ${selected.length} template(s) verified`)
}

await main()
