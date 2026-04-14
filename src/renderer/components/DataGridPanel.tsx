import { useMemo } from 'react'
import DataEditor, {
  GridCellKind,
  type GridCell,
  type GridColumn,
  type Item
} from '@glideapps/glide-data-grid'

import { useElementSize } from '@renderer/hooks/useElementSize'

interface GridPanelRow {
  id: string
  title: string
  values: Record<string, string | number | boolean | null>
}

interface DataGridPanelProps {
  title: string
  columns: string[]
  rows: GridPanelRow[]
  onSelect: (rowId: string) => void
}

function toCell(content: string): GridCell {
  return {
    kind: GridCellKind.Text,
    data: content,
    displayData: content,
    allowOverlay: true
  }
}

export function DataGridPanel({ title, columns, rows, onSelect }: DataGridPanelProps) {
  const { ref, size } = useElementSize<HTMLDivElement>()

  const gridColumns = useMemo<GridColumn[]>(
    () => [{ title: 'Title', width: 220 }, ...columns.map((column) => ({ title: column, width: 168 }))],
    [columns]
  )

  const getCellContent = (cell: Item): GridCell => {
    const [columnIndex, rowIndex] = cell
    const row = rows[rowIndex]
    if (!row) {
      return toCell('')
    }
    if (columnIndex === 0) {
      return toCell(row.title)
    }
    const key = columns[columnIndex - 1]
    const rawValue = row.values[key]
    return toCell(rawValue === null || rawValue === undefined ? '' : String(rawValue))
  }

  return (
    <section className="glass-panel grid-panel">
      <div className="panel-header">
        <div>
          <div className="panel-kicker">Result Surface</div>
          <h3>{title}</h3>
        </div>
        <div className="panel-chip">{rows.length} visible rows</div>
      </div>
      <div className="grid-shell" ref={ref}>
        {size.width > 0 && size.height > 0 ? (
          <DataEditor
            width={size.width}
            height={Math.max(320, size.height)}
            rowMarkers="number"
            smoothScrollX
            smoothScrollY
            columns={gridColumns}
            rows={rows.length}
            getCellContent={getCellContent}
            onCellActivated={(cell) => {
              const target = rows[cell[1]]
              if (target) {
                onSelect(target.id)
              }
            }}
          />
        ) : null}
      </div>
    </section>
  )
}

