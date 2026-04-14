import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { join } from 'path'

import type { PhoenixRunRequest, PhoenixRunResponse } from '@shared/types'

export class PhoenixRunner {
  private readonly rootPath: string

  constructor(rootPath: string) {
    this.rootPath = rootPath
  }

  async run(request: PhoenixRunRequest): Promise<PhoenixRunResponse> {
    const pythonExecutable = this.getPythonExecutable()
    const args = ['-m', 'phoenix.workbench_bridge', 'run']

    if (request.configPath) {
      args.push('--config', request.configPath)
    } else {
      args.push('--config-text', request.configText)
    }

    return new Promise((resolvePromise) => {
      const child = spawn(pythonExecutable, args, {
        cwd: this.rootPath,
        env: { ...process.env, PYTHONPATH: this.rootPath }
      })

      let stdout = ''
      let stderr = ''

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString()
      })
      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString()
      })

      child.on('close', (code) => {
        if (code !== 0) {
          resolvePromise({
            ok: false,
            configPath: request.configPath ?? 'inline-config',
            entityCount: 0,
            tierACount: 0,
            tierBCount: 0,
            tierCCount: 0,
            outputPaths: [],
            error: stderr || stdout || `Python bridge exited with code ${code}`
          })
          return
        }

        try {
          const payload = JSON.parse(stdout.trim()) as PhoenixRunResponse
          resolvePromise(payload)
        } catch (error) {
          resolvePromise({
            ok: false,
            configPath: request.configPath ?? 'inline-config',
            entityCount: 0,
            tierACount: 0,
            tierBCount: 0,
            tierCCount: 0,
            outputPaths: [],
            error: `Unable to parse Python bridge output: ${String(error)}\n${stdout}`
          })
        }
      })
    })
  }

  private getPythonExecutable(): string {
    const unixPath = join(this.rootPath, '.venv', 'bin', 'python')
    const windowsPath = join(this.rootPath, '.venv', 'Scripts', 'python.exe')
    if (existsSync(unixPath)) {
      return unixPath
    }
    if (existsSync(windowsPath)) {
      return windowsPath
    }
    return 'python3'
  }
}

