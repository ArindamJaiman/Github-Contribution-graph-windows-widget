/**
 * Generate a simple tray icon PNG (16x16 green GitHub-style icon)
 * Run: node scripts/generate-icon.js
 */
const fs = require('fs');
const path = require('path');

// Minimal 16x16 PNG with a green square
// We'll create a raw RGBA buffer and use Electron's nativeImage at runtime instead
// This script creates a placeholder file

const assetsDir = path.join(__dirname, '..', 'assets');
if (!fs.existsSync(assetsDir)) {
  fs.mkdirSync(assetsDir, { recursive: true });
}

console.log('Assets directory ready at:', assetsDir);
console.log('Note: The tray icon is generated at runtime using Electron nativeImage.');
console.log('For a custom .ico file, place icon.ico in the assets/ directory.');
