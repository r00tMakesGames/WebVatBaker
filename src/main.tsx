import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root not found');

// StrictMode is intentionally omitted: the viewport owns a WebGL context and a
// requestAnimationFrame loop, and double-invoked effects would tear it down.
createRoot(container).render(<App />);
