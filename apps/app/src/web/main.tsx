import { render } from 'preact'
import '@fontsource-variable/hanken-grotesk/wght.css'
import '@fontsource/space-grotesk/700.css'
import 'shades-gradient/gradient.css'
import './app.css'
import './compact.css'
import { App } from './app.tsx'

render(<App />, document.getElementById('root')!)
