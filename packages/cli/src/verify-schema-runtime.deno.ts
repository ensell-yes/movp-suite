import { runtimeFingerprint } from '@movp/core-schema'

const specifier = Deno.args[0]
if (!specifier) {
  console.error('verify-schema-runtime.deno: missing edge schema specifier')
  Deno.exit(2)
}

const module = await import(specifier)
console.log(runtimeFingerprint(module.schema))
