import { createWriteStream } from 'fs'
import { mkdtemp, mkdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { performance } from 'perf_hooks'
import { once } from 'events'

import { describe, expect, it } from 'vitest'

import type { QueryRequest } from '../src/shared/types'
import { DuckDBWorkspace } from '../src/main/services/duckdbWorkspace'

const ROWS_PER_FILE = 100_000
const FILE_COUNT = 3

const streets = ['Martin', 'Olive', 'Hill', 'Grand', 'Sunset', 'Cypress', 'Riverside', 'Figueroa']
const cities = ['Los Angeles', 'Pasadena', 'Long Beach', 'Burbank', 'Santa Monica', 'Glendale']
const zoningCodes = ['R1', 'R2', 'RD1.5', 'C2', 'RAS4', 'MU']
const contractorNames = ['Atlas Build', 'Pioneer Works', 'Northline Group', 'Blue Beam Construction']
const ownerLastNames = ['Martin', 'Nguyen', 'Garcia', 'Patel', 'Kim', 'Lopez', 'Wright', 'Reed']
const clientFirstNames = ['John', 'Jane', 'Maria', 'Alex', 'Jordan', 'Taylor', 'Chris', 'Devon']

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0')
}

function csvEscape(value: string | number | boolean): string {
  const text = String(value)
  if (text.includes(',') || text.includes('"') || text.includes('\n')) {
    return `"${text.replace(/"/g, '""')}"`
  }
  return text
}

function numericPhone(datasetIndex: number, rowIndex: number): string {
  return `1${pad(200_000_0000 + datasetIndex * 100_000 + rowIndex, 10)}`
}

function formattedPhone(datasetIndex: number, rowIndex: number): string {
  const digits = numericPhone(datasetIndex, rowIndex).slice(-10)
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`
}

function dayString(dayOffset: number): string {
  const base = new Date(Date.UTC(2024, 0, 1))
  base.setUTCDate(base.getUTCDate() + dayOffset)
  return base.toISOString().slice(0, 10)
}

function buildRow(datasetIndex: number, rowIndex: number): string[] {
  const ownerLast = ownerLastNames[(rowIndex + datasetIndex) % ownerLastNames.length]
  const ownerName = `${rowIndex % 19 === 0 ? 'John' : 'Owner'} ${ownerLast}`
  const clientFirst = rowIndex % 11 === 0 ? 'John' : clientFirstNames[(rowIndex + datasetIndex) % clientFirstNames.length]
  const clientName = `${clientFirst} ${ownerLastNames[(rowIndex * 3 + datasetIndex) % ownerLastNames.length]}`
  const contractorName = contractorNames[(rowIndex + datasetIndex) % contractorNames.length]
  const street = streets[rowIndex % streets.length]
  const city = cities[(rowIndex + datasetIndex) % cities.length]
  const address = `${100 + (rowIndex % 9900)} ${street} St, ${city}, CA`
  const ain = `AIN-${datasetIndex + 1}-${pad(rowIndex, 6)}`
  const apn = `APN-${datasetIndex + 1}-${pad((rowIndex * 7) % 1_000_000, 6)}`
  const permitNumber = `PRM-${datasetIndex + 1}-${pad(rowIndex, 7)}`
  const deedNumber = `DEED-${datasetIndex + 1}-${pad(rowIndex, 7)}`
  const zoning = zoningCodes[(rowIndex * 5 + datasetIndex) % zoningCodes.length]
  const matchingQuery = rowIndex % 11 === 0
  const permitValue = matchingQuery ? 100_000 + (rowIndex % 95_000) : 220_000 + (rowIndex % 180_000)
  const permitStart = rowIndex % 365
  const permitDurationDays = matchingQuery ? 30 + (rowIndex % 45) : 110 + (rowIndex % 180)
  const permitIssueDate = dayString(permitStart)
  const certificateDate = dayString(permitStart + permitDurationDays)
  const deedDate = dayString((rowIndex * 2) % 365)
  const sb79 = matchingQuery || rowIndex % 7 === 0 ? 'true' : 'false'
  const sb9 = rowIndex % 5 === 0 ? 'true' : 'false'
  const lat = (34.0 + datasetIndex * 0.08 + (rowIndex % 400) * 0.00045).toFixed(6)
  const lng = (-118.6 + datasetIndex * 0.05 + (rowIndex % 400) * 0.00045).toFixed(6)

  return [
    ownerName,
    clientName,
    contractorName,
    address,
    ain,
    apn,
    formattedPhone(datasetIndex, rowIndex),
    permitNumber,
    String(permitValue),
    permitIssueDate,
    certificateDate,
    deedNumber,
    deedDate,
    zoning,
    sb79,
    sb9,
    lat,
    lng
  ]
}

async function generateCsv(filePath: string, datasetIndex: number): Promise<void> {
  const stream = createWriteStream(filePath, { encoding: 'utf8' })
  const header = [
    'owner_name',
    'client_name',
    'contractor_name',
    'address',
    'parcel_ain',
    'parcel_apn',
    'phone',
    'permit_number',
    'permit_value',
    'permit_issue_date',
    'certificate_of_occupancy_date',
    'deed_number',
    'deed_date',
    'zoning',
    'sb79_flag',
    'sb9_flag',
    'latitude',
    'longitude'
  ]

  stream.write(`${header.join(',')}\n`)

  for (let rowIndex = 0; rowIndex < ROWS_PER_FILE; rowIndex += 1) {
    const line = buildRow(datasetIndex, rowIndex).map(csvEscape).join(',')
    if (!stream.write(`${line}\n`)) {
      await once(stream, 'drain')
    }
  }

  stream.end()
  await once(stream, 'finish')
}

describe('DuckDBWorkspace large-scale stress verification', () => {
  it(
    'ingests three 100k-row CSVs and serves the complex query pattern quickly',
    async () => {
      const rootPath = await mkdtemp(join(tmpdir(), 'rentseeker-stress-'))
      await mkdir(join(rootPath, 'workspace'), { recursive: true })
      await mkdir(join(rootPath, 'generated'), { recursive: true })

      const filePaths: string[] = []
      for (let datasetIndex = 0; datasetIndex < FILE_COUNT; datasetIndex += 1) {
        const filePath = join(rootPath, 'generated', `stress-${datasetIndex + 1}.csv`)
        await generateCsv(filePath, datasetIndex)
        filePaths.push(filePath)
      }
      console.info(`[stress] generated ${FILE_COUNT} CSV files x ${ROWS_PER_FILE} rows`)

      const workspace = new DuckDBWorkspace(rootPath)

      const ingestStart = performance.now()
      await workspace.initialize()
      console.info('[stress] workspace initialized')
      const ingestResult = await workspace.ingestFiles(filePaths)
      const ingestMs = performance.now() - ingestStart
      console.info(`[stress] ingest complete in ${Math.round(ingestMs)}ms`)

      expect(ingestResult.datasets).toHaveLength(FILE_COUNT)

      const snapshot = await workspace.getSnapshot()
      console.info('[stress] snapshot loaded')
      expect(snapshot.datasets).toHaveLength(FILE_COUNT)
      expect(Number(snapshot.metrics[0]?.value ?? '0')).toBe(FILE_COUNT * ROWS_PER_FILE)

      const complexQuery: QueryRequest = {
        searchText: '',
        limit: 250,
        offset: 0,
        filters: [
          { field: 'client_name', operator: 'contains', value: 'john' },
          { field: 'permit_value', operator: 'between', value: 100000, valueMax: 200000 },
          { field: 'permit_duration_days', operator: 'lt', value: 90 }
        ],
        sorts: [{ field: 'total_phone_numeric', direction: 'desc' }]
      }

      const queryTimings: number[] = []
      let queryResult = await workspace.runStructuredQuery(complexQuery)
      console.info(`[stress] warm query rows=${queryResult.rows.length} total=${queryResult.total}`)
      for (let pass = 0; pass < 3; pass += 1) {
        const queryStart = performance.now()
        queryResult = await workspace.runStructuredQuery(complexQuery)
        queryTimings.push(performance.now() - queryStart)
        console.info(`[stress] measured query ${pass + 1} in ${Math.round(queryTimings[pass] ?? 0)}ms`)
      }

      expect(queryResult.total).toBeGreaterThan(20_000)
      expect(queryResult.rows.length).toBe(250)
      for (let index = 1; index < queryResult.rows.length; index += 1) {
        const previous = Number(queryResult.rows[index - 1]?.total_phone_numeric ?? 0)
        const current = Number(queryResult.rows[index]?.total_phone_numeric ?? 0)
        expect(previous).toBeGreaterThanOrEqual(current)
      }

      const warmQueryMax = Math.max(...queryTimings)
      expect(warmQueryMax).toBeLessThan(1000)

      const topRecordId = String(queryResult.rows[0]?.id)
      const dossierStart = performance.now()
      const dossier = await workspace.getDossier(topRecordId)
      const dossierMs = performance.now() - dossierStart
      console.info(`[stress] dossier loaded in ${Math.round(dossierMs)}ms`)
      expect(dossier.entityId).toBe(topRecordId)
      expect(dossier.facts.some((fact) => fact.key === 'client_name')).toBe(true)

      const graphStart = performance.now()
      const graph = await workspace.getConnectionGraph(topRecordId, 'query-lab')
      const graphMs = performance.now() - graphStart
      console.info(`[stress] graph loaded in ${Math.round(graphMs)}ms`)
      expect(graph.nodes.length).toBeGreaterThan(0)
      expect(graph.edges.length).toBeGreaterThan(0)

      const recordBucketStart = performance.now()
      const recordBucket = await workspace.getBucketData('records', {
        searchText: 'john',
        limit: 100,
        offset: 0,
        filters: [],
        sorts: []
      })
      const recordBucketMs = performance.now() - recordBucketStart
      console.info(`[stress] record bucket loaded in ${Math.round(recordBucketMs)}ms`)
      expect(recordBucket.rows.length).toBeGreaterThan(0)

      console.info(
        JSON.stringify(
          {
            ingestMs: Math.round(ingestMs),
            queryTimingsMs: queryTimings.map((value) => Math.round(value)),
            dossierMs: Math.round(dossierMs),
            graphMs: Math.round(graphMs),
            recordBucketMs: Math.round(recordBucketMs),
            totalRecords: FILE_COUNT * ROWS_PER_FILE,
            matchedRows: queryResult.total
          },
          null,
          2
        )
      )

      expect(dossierMs).toBeLessThan(1000)
      expect(graphMs).toBeLessThan(1000)
      expect(recordBucketMs).toBeLessThan(1000)
    },
    600_000
  )
})
