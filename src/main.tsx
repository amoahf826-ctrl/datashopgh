import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './style.css';
import './responsive.css';
import './brand-theme.css';

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch(error => {
      console.error('CheapDataBundle offline support could not start:', error);
    });
  });
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
