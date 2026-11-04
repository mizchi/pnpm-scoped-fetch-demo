import fs from 'node:fs'
import path from 'node:path'

export function currentProject(cwd = process.cwd()) {
  let directory = fs.realpathSync(cwd), project
  for (;;) {
    const manifest = path.join(directory, 'package.json')
    if (!project && fs.existsSync(manifest)) {
      const value = JSON.parse(fs.readFileSync(manifest, 'utf8'))
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid package.json: ${manifest}`)
      project = directory
    }
    if (fs.existsSync(path.join(directory, 'pnpm-workspace.yaml'))) {
      if (!project) throw new Error(`No package.json for current project: ${cwd}`)
      if (!fs.existsSync(path.join(directory, 'pnpm-lock.yaml'))) throw new Error(`No workspace lockfile: ${directory}`)
      return { workspace: directory, directory: project, importer: path.relative(directory, project).split(path.sep).join('/') || '.' }
    }
    const parent = path.dirname(directory)
    if (parent === directory) throw new Error(`No workspace found for current project: ${cwd}`)
    directory = parent
  }
}
