import React from 'react'
import ReactDOM from 'react-dom/client'

import '@glideapps/glide-data-grid/dist/index.css'
import 'maplibre-gl/dist/maplibre-gl.css'

import { App } from './App'
import './styles.css'
import './parcel-explorer.css'
import './loading-owner-analytics.css'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
