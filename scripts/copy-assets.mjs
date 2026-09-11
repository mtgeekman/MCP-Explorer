import { cpSync, mkdirSync } from 'node:fs';
mkdirSync('dist/renderer', { recursive: true });
cpSync('src/renderer', 'dist/renderer', { recursive: true });
console.log('copied renderer assets');
