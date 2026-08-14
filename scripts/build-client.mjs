import { readFile, writeFile } from 'node:fs/promises'

const path = new URL('../lib/client.js', import.meta.url)
let source = await readFile(path, 'utf8')

const reactImport = "import { createElement, useState } from 'react';"
if (!source.includes(reactImport)) throw new Error('unexpected React import in compiled client entry')
source = source.replace(reactImport, 'const { createElement, useState } = require("react");')
source = source.replace('export const inject =', 'const inject =')
source = source.replace('export function apply(', 'function apply(')
source = source.replace(/\n?\/\/# sourceMappingURL=client\.js\.map\s*$/, '')
if (/\b(?:import|export)\s/.test(source)) throw new Error('compiled client entry still contains ESM syntax')

const bundle = `window.__ModuleLoader__.load({
  id: "dsh-weixin",
  factory: (require) => {
    const module = { exports: {} };
${source.split('\n').map(line => `    ${line}`).join('\n')}
    module.exports.apply = apply;
    module.exports.inject = inject;
    return module.exports;
  }
});
`
if (!bundle.includes('const { createElement, useState } = require("react");')) {
  throw new Error('client bundle is missing required React runtime imports')
}

await writeFile(path, bundle)
