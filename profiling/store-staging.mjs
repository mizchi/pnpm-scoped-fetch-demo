import fs from 'node:fs'
import path from 'node:path'
import { filesUnder } from './store-snapshot.mjs'

export function stageStore({ directory, layout, files, sourceFiles, indexDirectory }) {
  fs.mkdirSync(directory, { recursive: true })
  function link(from, relative) {
    const filename = path.join(directory, relative)
    fs.mkdirSync(path.dirname(filename), { recursive: true })
    fs.linkSync(from, filename)
  }
  for (const file of files) link(sourceFiles[file.path], file.path)
  for (const folder of ['index', 'index-aliases']) {
    const from = path.join(indexDirectory, layout, folder)
    if (fs.existsSync(from)) for (const relative of filesUnder(from)) link(path.join(from, relative), `${layout}/${folder}/${relative}`)
  }
  return directory
}
