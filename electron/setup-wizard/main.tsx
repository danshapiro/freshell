import React from 'react'
import { createRoot } from 'react-dom/client'
import { Wizard } from './wizard.js'
import './wizard.css'

createRoot(document.getElementById('wizard-root')!).render(<Wizard />)
