import type { QueryFilter, QueryRequest } from '@shared/types'

interface QueryLabPanelProps {
  query: QueryRequest
  onChange: (next: QueryRequest) => void
  onRun: () => void
}

const fieldOptions = [
  { value: 'owner_name', label: 'Owner Name' },
  { value: 'client_name', label: 'Client Name' },
  { value: 'contractor_name', label: 'Contractor Name' },
  { value: 'person_name', label: 'Person / Client Name' },
  { value: 'person_role', label: 'Person Role' },
  { value: 'address', label: 'Address' },
  { value: 'parcel_id', label: 'AIN / APN / Parcel' },
  { value: 'permit_value', label: 'Permit Value' },
  { value: 'permit_duration_days', label: 'Permit Duration (days)' },
  { value: 'permit_duration_months', label: 'Permit Duration (months)' },
  { value: 'total_phone_numeric', label: 'Total Phone Numeric' },
  { value: 'deed_number', label: 'Deed Number' },
  { value: 'deed_date', label: 'Deed Date' },
  { value: 'sb79_applies', label: 'SB 79 Applies' },
  { value: 'sb9_applies', label: 'SB 9 Applies' }
]

const operatorOptions = [
  { value: 'contains', label: 'contains' },
  { value: 'eq', label: '=' },
  { value: 'gt', label: '>' },
  { value: 'gte', label: '>=' },
  { value: 'lt', label: '<' },
  { value: 'lte', label: '<=' },
  { value: 'between', label: 'between' },
  { value: 'is_true', label: 'is true' },
  { value: 'is_false', label: 'is false' }
] as const

const sortOptions = [
  { value: 'permit_value', label: 'Permit Value' },
  { value: 'permit_duration_days', label: 'Permit Duration' },
  { value: 'permit_duration_months', label: 'Permit Duration (months)' },
  { value: 'total_phone_numeric', label: 'Phone Numeric' },
  { value: 'person_name', label: 'Person / Client Name' },
  { value: 'owner_name', label: 'Owner Name' },
  { value: 'address', label: 'Address' },
  { value: 'parcel_id', label: 'Parcel' },
  { value: 'deed_date', label: 'Deed Date' }
]

function updateFilter(filters: QueryFilter[], index: number, patch: Partial<QueryFilter>) {
  return filters.map((filter, current) => (current === index ? { ...filter, ...patch } : filter))
}

export function QueryLabPanel({ query, onChange, onRun }: QueryLabPanelProps) {
  const setFilters = (filters: QueryFilter[]) => onChange({ ...query, filters })

  return (
    <section className="glass-panel query-panel">
      <div className="panel-header">
        <div>
          <div className="panel-kicker">Query Lab</div>
          <h3>Cross-bucket dossier queries</h3>
        </div>
        <button className="action-button solid" onClick={onRun}>
          Run Query
        </button>
      </div>

      <div className="query-preset-row">
        <button
          className="chip-button"
          onClick={() =>
            onChange({
              ...query,
              searchText: '',
              filters: [
                { field: 'person_name', operator: 'contains', value: 'john' },
                { field: 'permit_value', operator: 'between', value: 100000, valueMax: 200000 },
                { field: 'permit_duration_days', operator: 'lt', value: 90 }
              ],
              sorts: [{ field: 'total_phone_numeric', direction: 'desc' }]
            })
          }
        >
          John · $100k-$200k · under 90 days · phone numeric desc
        </button>
        <button
          className="chip-button"
          onClick={() =>
            onChange({
              ...query,
              searchText: '',
              filters: [
                { field: 'owner_name', operator: 'contains', value: 'martin' },
                { field: 'sb79_applies', operator: 'is_true' }
              ],
              sorts: [{ field: 'permit_value', direction: 'desc' }]
            })
          }
        >
          Owners like Martin · SB 79 true · permit value desc
        </button>
        <button
          className="chip-button"
          onClick={() =>
            onChange({
              ...query,
              searchText: '',
              filters: [{ field: 'sb79_applies', operator: 'is_true' }],
              sorts: [{ field: 'permit_value', direction: 'desc' }]
            })
          }
        >
          SB 79 true · highest permit value
        </button>
      </div>

      <div className="query-filter-list">
        {query.filters.map((filter, index) => (
          <div key={`filter-${index}`} className="query-filter-row">
            <select
              value={filter.field}
              onChange={(event) => setFilters(updateFilter(query.filters, index, { field: event.target.value }))}
            >
              {fieldOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>

            <select
              value={filter.operator}
              onChange={(event) =>
                setFilters(updateFilter(query.filters, index, { operator: event.target.value as QueryFilter['operator'] }))
              }
            >
              {operatorOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>

            {!['is_true', 'is_false'].includes(filter.operator) ? (
              <input
                value={String(filter.value ?? '')}
                onChange={(event) => setFilters(updateFilter(query.filters, index, { value: event.target.value }))}
                placeholder="value"
              />
            ) : (
              <div className="query-placeholder">boolean check</div>
            )}

            {filter.operator === 'between' ? (
              <input
                value={String(filter.valueMax ?? '')}
                onChange={(event) => setFilters(updateFilter(query.filters, index, { valueMax: event.target.value }))}
                placeholder="max"
              />
            ) : null}

            <button
              className="icon-button"
              onClick={() => setFilters(query.filters.filter((_, current) => current !== index))}
            >
              ×
            </button>
          </div>
        ))}
      </div>

      <div className="query-toolbar">
        <button
          className="chip-button"
          onClick={() =>
            setFilters([...query.filters, { field: 'person_name', operator: 'contains', value: '' }])
          }
        >
          Add Filter
        </button>
        <div className="query-sort-row">
          <select
            value={query.sorts[0]?.field ?? 'permit_value'}
            onChange={(event) =>
              onChange({
                ...query,
                sorts: [{ field: event.target.value, direction: query.sorts[0]?.direction ?? 'desc' }]
              })
            }
          >
            {sortOptions.map((option) => (
              <option key={option.value} value={option.value}>
                Sort: {option.label}
              </option>
            ))}
          </select>
          <select
            value={query.sorts[0]?.direction ?? 'desc'}
            onChange={(event) =>
              onChange({
                ...query,
                sorts: [{ field: query.sorts[0]?.field ?? 'permit_value', direction: event.target.value as 'asc' | 'desc' }]
              })
            }
          >
            <option value="desc">Descending</option>
            <option value="asc">Ascending</option>
          </select>
          <input
            type="number"
            min={25}
            max={2000}
            step={25}
            value={query.limit}
            onChange={(event) => onChange({ ...query, limit: Number(event.target.value) || 250 })}
            placeholder="Limit"
          />
        </div>
        <div className="query-hint">
          The query surface targets canonical record dossiers, so names, parcel IDs, addresses,
          deed markers, permit metrics, and buildability flags can all be combined in one pass.
        </div>
      </div>
    </section>
  )
}
