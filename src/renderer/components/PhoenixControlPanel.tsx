import type { PhoenixRunResponse } from '@shared/types'

interface PhoenixControlPanelProps {
  configPath?: string
  configText: string
  setConfigText: (next: string) => void
  onLoadConfig: () => void
  onRun: () => void
  running: boolean
  runResult?: PhoenixRunResponse
}

export function PhoenixControlPanel({
  configPath,
  configText,
  setConfigText,
  onLoadConfig,
  onRun,
  running,
  runResult
}: PhoenixControlPanelProps) {
  return (
    <section className="glass-panel phoenix-panel">
      <div className="panel-header">
        <div>
          <div className="panel-kicker">Run Phoenix</div>
          <h3>Launch the pipeline from the dashboard</h3>
        </div>
        <div className="action-row">
          <button className="action-button" onClick={onLoadConfig}>
            Load YAML
          </button>
          <button className="action-button solid" onClick={onRun} disabled={running}>
            {running ? 'Running…' : 'Run Pipeline'}
          </button>
        </div>
      </div>

      <div className="config-path-banner">
        <span>Config path</span>
        <strong>{configPath ?? 'Inline workbench config'}</strong>
      </div>

      <textarea
        className="phoenix-config-editor"
        value={configText}
        onChange={(event) => setConfigText(event.target.value)}
        spellCheck={false}
      />

      {runResult ? (
        <div className={`run-result-card ${runResult.ok ? 'success' : 'error'}`}>
          <div className="run-result-topline">
            <strong>{runResult.ok ? 'Run complete' : 'Run failed'}</strong>
            <span>{runResult.entityCount} entities</span>
          </div>
          <div className="run-tier-strip">
            <span>A {runResult.tierACount}</span>
            <span>B {runResult.tierBCount}</span>
            <span>C {runResult.tierCCount}</span>
          </div>
          {runResult.outputPaths.length > 0 ? (
            <div className="run-output-list">
              {runResult.outputPaths.map((path) => (
                <code key={path}>{path}</code>
              ))}
            </div>
          ) : null}
          {runResult.error ? <pre>{runResult.error}</pre> : null}
        </div>
      ) : null}
    </section>
  )
}

