import { generate } from '@movp/codegen'

const { migrationPath, typesPath, deltaPaths } = await generate()

console.log(`wrote ${migrationPath}`)
for (const path of deltaPaths) console.log(`wrote ${path}`)
console.log(`wrote ${typesPath}`)
