const fs = require('fs/promises');
const path = require('path');
const { minify } = require('terser');
const CleanCSS = require('clean-css');

const root = __dirname;

async function minifyJavaScript(input, output) {
  const source = await fs.readFile(path.join(root, input), 'utf8');
  const result = await minify(source, {
    compress: true,
    mangle: true,
    format: { comments: false },
  });
  if (!result.code) throw new Error(`No output generated for ${input}`);
  await fs.writeFile(path.join(root, output), `${result.code}\n`);
}

async function minifyCss(input, output) {
  const source = await fs.readFile(path.join(root, input), 'utf8');
  const result = new CleanCSS({ level: 2 }).minify(source);
  if (result.errors.length) throw new Error(`${input}: ${result.errors.join('; ')}`);
  await fs.writeFile(path.join(root, output), `${result.styles}\n`);
}

async function build() {
  await Promise.all([
    minifyJavaScript('script.js', 'script.min.js'),
    minifyJavaScript('roadmap.js', 'roadmap.min.js'),
    minifyCss('styles.css', 'styles.min.css'),
    minifyCss('editorial.css', 'editorial.min.css'),
  ]);
}

build().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});