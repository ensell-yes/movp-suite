export default function viteModuleIds() {
  return {
    name: 'spike-module-ids',
    generateBundle() {
      const ids = [...this.getModuleIds()].filter((id) => !id.startsWith('\0')).sort()
      this.emitFile({ type: 'asset', fileName: 'module-ids.json', source: JSON.stringify(ids, null, 2) })
    },
  }
}
