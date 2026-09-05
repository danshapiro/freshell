import React from 'react'
import { createRoot } from 'react-dom/client'
import './picker.css'
import { ProfilePicker } from './picker.js'

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ProfilePicker />
  </React.StrictMode>,
)
