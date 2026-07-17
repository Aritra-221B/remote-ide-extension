/**
 * Copies the static dashboard files (html/css/js) into dist/dashboard.
 * Run automatically as part of `npm run build` so F5 debugging and
 * vsce packaging always ship the current dashboard.
 */
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'src', 'dashboard');
const dest = path.join(__dirname, '..', 'dist', 'dashboard');

fs.mkdirSync(dest, { recursive: true });
fs.cpSync(src, dest, { recursive: true });
console.log(`[copy-dashboard] ${src} -> ${dest}`);
