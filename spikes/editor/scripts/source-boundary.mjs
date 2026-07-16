#!/usr/bin/env node
import { readTextBounded, walkRegularFiles } from './lib/safe-io.mjs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import ts from 'typescript'

const CLIENT_FORBIDDEN = ['@movp/domain', '@movp/auth', '@supabase', 'packages/domain', '@spike/oracle']
const TYPE_ESCAPE = ['@ts-ignore', '@ts-expect-error']
const SOURCE_EXTENSION = /\.(?:ts|tsx|mts|cts)$/
const clientDir = process.argv[2]
const allSourceRoot = process.argv[3]
const viteEntry = process.argv[4]
if (!clientDir || !allSourceRoot || !viteEntry) {
  console.error('source-boundary:E_USAGE')
  process.exit(2)
}

const escapes = (root, target) => {
  const rel = relative(resolve(root), resolve(target))
  return rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
}

const moduleSpecifiers = (source) => {
  const specifiers = []
  const visit = (node) => {
    let literal
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
      literal = node.moduleSpecifier
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression && ts.isStringLiteralLike(node.moduleReference.expression)) {
      literal = node.moduleReference.expression
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0])) {
      literal = node.arguments[0]
    }
    if (literal) specifiers.push(literal.text)
    ts.forEachChild(node, visit)
  }
  visit(source)
  return specifiers
}

const countAnyKeywords = (source) => {
  let count = 0
  const visit = (node) => {
    if (node.kind === ts.SyntaxKind.AnyKeyword) count++
    ts.forEachChild(node, visit)
  }
  visit(source)
  return count
}

let violations = 0
let clientFiles, allFiles
try {
  clientFiles = walkRegularFiles(clientDir)
  allFiles = walkRegularFiles(allSourceRoot)
} catch (error) {
  console.error(error instanceof Error ? error.message : 'source-boundary:E_READ')
  process.exit(1)
}
const resolvedEntry = resolve(viteEntry)
if (escapes(clientDir, resolvedEntry) || !SOURCE_EXTENSION.test(resolvedEntry) || !clientFiles.some((path) => resolve(path) === resolvedEntry)) {
  console.error(`source-boundary:E_VITE_ENTRY path=${viteEntry}`)
  violations++
}
for (const p of clientFiles) {
  if (!SOURCE_EXTENSION.test(p)) continue
  const text = readTextBounded(p)
  const source = ts.createSourceFile(p, text, ts.ScriptTarget.Latest, true)
  for (const specifier of moduleSpecifiers(source)) {
    if (CLIENT_FORBIDDEN.some((pattern) => specifier.includes(pattern))) {
      console.error(`source-boundary:E_CLIENT_FORBIDDEN path=${p}`)
      violations++
    }
    if (specifier.startsWith('.') && escapes(clientDir, resolve(dirname(p), specifier))) {
      console.error(`source-boundary:E_CLIENT_ESCAPE path=${p}`)
      violations++
    }
  }
}
for (const p of allFiles) {
  if (!SOURCE_EXTENSION.test(p)) continue
  const text = readTextBounded(p)
  for (const pattern of TYPE_ESCAPE) if (text.includes(pattern)) {
    console.error(`source-boundary:E_TYPE_ESCAPE path=${p}`)
    violations++
  }
  const count = countAnyKeywords(ts.createSourceFile(p, text, ts.ScriptTarget.Latest, true))
  if (count > 0) {
    console.error(`source-boundary:E_ANY_KEYWORD path=${p} count=${count}`)
    violations += count
  }
}
if (violations) { console.error(`source-boundary:E_VIOLATIONS count=${violations}`); process.exit(1) }
console.log('source-boundary:clean count=0')
