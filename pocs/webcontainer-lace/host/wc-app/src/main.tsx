import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';
import { report, describeOpener } from './report';

void report('log', {
  text: 'DApp booted on preview origin. ' + describeOpener(),
  level: 'info',
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
