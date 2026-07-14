import { generate } from '@movp/codegen'
import { schema } from '@movp/core-schema'

const { migrationPath, typesPath, deltaPaths } = await generate({ schema })

console.log(`wrote ${migrationPath}`)
for (const path of deltaPaths) console.log(`wrote ${path}`)
console.log(`wrote ${typesPath}`)
