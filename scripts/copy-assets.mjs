import { cpSync, mkdirSync } from 'node:fs';
mkdirSync('dist/renderer', { recursive: true });
cpSync('src/renderer', 'dist/renderer', { recursive: true });
mkdirSync('dist/fixture', { recursive: true });
cpSync('scripts/fixture', 'dist/fixture', { recursive: true });
console.log('copied renderer assets and fixture server');
