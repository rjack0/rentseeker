import { writeFile } from 'fs/promises'
import { mkdtemp, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'

import { describe, expect, it } from 'vitest'

import type { QueryRequest } from '../src/shared/types'
import { DuckDBWorkspace } from '../src/main/services/duckdbWorkspace'

describe('DuckDBWorkspace query semantics', () => {
  it('matches the complex permit query against a known-good tiny dataset', async () => {
    const rootPath = await mkdtemp(join(tmpdir(), 'rentseeker-query-'))
    await mkdir(join(rootPath, 'workspace'), { recursive: true })

    const csvPath = join(rootPath, 'tiny.csv')
    await writeFile(
      csvPath,
      [
        'owner_name,client_name,contractor_name,address,parcel_ain,parcel_apn,phone,permit_number,permit_value,permit_issue_date,certificate_of_occupancy_date,deed_number,deed_date,zoning,sb79_flag,sb9_flag,latitude,longitude',
        'Owner Martin,John Martin,Atlas Build,"100 Martin St, Los Angeles, CA",AIN-1-000001,APN-1-000001,"(310) 555-0101",PRM-1-0000001,150000,2024-01-01,2024-03-01,DEED-1-0000001,2024-01-15,R2,true,false,34.100000,-118.300000',
        'Owner Reed,Jane Reed,Pioneer Works,"200 Hill St, Pasadena, CA",AIN-1-000002,APN-1-000002,"(310) 555-0102",PRM-1-0000002,250000,2024-01-01,2024-07-15,DEED-1-0000002,2024-02-01,R1,false,false,34.200000,-118.200000'
      ].join('\n'),
      'utf8'
    )

    const workspace = new DuckDBWorkspace(rootPath)
    await workspace.initialize()
    await workspace.ingestFiles([csvPath])

    const query: QueryRequest = {
      searchText: '',
      limit: 50,
      offset: 0,
      filters: [
        { field: 'client_name', operator: 'contains', value: 'john' },
        { field: 'permit_value', operator: 'between', value: 100000, valueMax: 200000 },
        { field: 'permit_duration_days', operator: 'lt', value: 90 }
      ],
      sorts: [{ field: 'total_phone_numeric', direction: 'desc' }]
    }

    const allRows = await workspace.runStructuredQuery({
      searchText: '',
      limit: 50,
      offset: 0,
      filters: [],
      sorts: []
    })

    expect(allRows.total).toBe(2)
    expect(allRows.rows.some((row) => row.client_name === 'John Martin')).toBe(true)

    const filteredRows = await workspace.runStructuredQuery(query)
    expect(filteredRows.total).toBe(1)
    expect(filteredRows.rows[0]?.client_name).toBe('John Martin')
  })
})
