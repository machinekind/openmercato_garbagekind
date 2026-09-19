import { copyFile, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const runtimeRoot = await realpath(path.resolve(process.argv[2] || process.env.MERCATO_ROOT || path.join(scriptDirectory, '..', 'open-mercato')))
const source = await realpath(path.join(scriptDirectory, 'modules', 'digital_twins'))
const appRoot = await realpath(path.join(runtimeRoot, 'apps', 'mercato'))
const modulesRoot = await realpath(path.join(appRoot, 'src', 'modules'))
const target = path.join(modulesRoot, 'digital_twins')
const modulesFile = path.join(appRoot, 'src', 'modules.ts')
const original = await readFile(modulesFile, 'utf8')
const registration = "{ id: 'digital_twins', from: '@app' }"
const anchor = '// Official modules activated via'
let updated = original
if (!/\bid\s*:\s*['"]digital_twins['"]/.test(original)) {
  if (!original.includes(anchor)) throw new Error('Cannot locate the module-registration anchor; no files were changed.')
  const newline = original.includes('\r\n') ? '\r\n' : '\n'
  updated = original.replace(anchor, `enabledModules.push(${registration})${newline}${newline}${anchor}`)
}

async function assertRegularLocation(location) {
  try {
    const entry = await lstat(location)
    if (entry.isSymbolicLink()) throw new Error(`Refusing to follow symbolic link: ${location}`)
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error
  }
}

async function copyModule(directory, destination) {
  await assertRegularLocation(destination)
  await mkdir(destination, { recursive: true })
  let copied = 0
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error(`Refusing source symbolic link: ${entry.name}`)
    const from = path.join(directory, entry.name)
    const to = path.join(destination, entry.name)
    await assertRegularLocation(to)
    if (entry.isDirectory()) copied += await copyModule(from, to)
    else if (entry.isFile()) {
      const incoming = await readFile(from)
      let existing = null
      try { existing = await readFile(to) } catch (error) { if (error.code !== 'ENOENT') throw error }
      if (!existing || !incoming.equals(existing)) {
        await copyFile(from, to)
        copied += 1
      }
    }
  }
  return copied
}

const copied = await copyModule(source, target)
if (updated !== original) await writeFile(modulesFile, updated, 'utf8')
console.log(`Digital twins installed: ${copied} changed files; registration ${updated === original ? 'already present' : 'added'}.`)
console.log(`Runtime: ${runtimeRoot}`)
console.log('Next: yarn generate; yarn mercato auth sync-role-acls; yarn mercato configs cache structural --all-tenants')
