const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const vendorDir = path.join(root, 'static', 'vendor');
fs.mkdirSync(vendorDir, { recursive: true });

function copyFirstExisting(name, candidates, targetFilename) {
  const source = candidates
    .map((candidate) => path.join(root, candidate))
    .find((candidatePath) => fs.existsSync(candidatePath));

  if (!source) {
    const tried = candidates.map((candidate) => `- ${candidate}`).join('\n');
    throw new Error(`Cannot find ${name}. Tried:\n${tried}`);
  }

  const target = path.join(vendorDir, targetFilename);
  fs.copyFileSync(source, target);
  console.log(`[vendor] ${name}: ${path.relative(root, source)} -> ${path.relative(root, target)}`);
}

copyFirstExisting(
  'mammoth browser bundle',
  [
    'node_modules/mammoth/mammoth.browser.min.js',
    'node_modules/mammoth/mammoth.browser.js'
  ],
  'mammoth.browser.min.js'
);

copyFirstExisting(
  'pixi browser bundle',
  [
    'node_modules/pixi.js/dist/pixi.min.js',
    'node_modules/pixi.js/dist/pixi.js',
    'node_modules/pixi.js/lib/index.js'
  ],
  'pixi.min.js'
);
