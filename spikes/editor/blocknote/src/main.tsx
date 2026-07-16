import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Editor } from './editor.tsx'

const root = document.getElementById('root')
if (!root) throw new Error('blocknote: missing root')
createRoot(root).render(<StrictMode><Editor /></StrictMode>)
