import { generate } from '@movp/codegen'

const { migrationPath, typesPath } = await generate()

console.log(`wrote ${migrationPath}`)
console.log(`wrote ${typesPath}`)
