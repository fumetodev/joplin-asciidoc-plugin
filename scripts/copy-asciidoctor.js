// Copy asciidoctor and its dependencies to dist/node_modules
// so the Joplin plugin sandbox can require() them at runtime
const fs = require("fs");
const path = require("path");

const src = path.join(__dirname, "..", "node_modules");
const dest = path.join(__dirname, "..", "dist", "node_modules");

// Packages needed by asciidoctor at runtime
const packages = [
  "asciidoctor",
  "@asciidoctor/core",
  "@asciidoctor/cli",
  "@asciidoctor/opal-runtime",
  "unxhr",
];

function copyDir(from, to) {
  if (!fs.existsSync(from)) {
    console.warn(`  Skipping ${from} (not found)`);
    return;
  }
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const srcPath = path.join(from, entry.name);
    const destPath = path.join(to, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

// Clean
if (fs.existsSync(dest)) {
  fs.rmSync(dest, { recursive: true });
}

for (const pkg of packages) {
  const pkgSrc = path.join(src, pkg);
  const pkgDest = path.join(dest, pkg);
  console.log(`Copying ${pkg}...`);
  copyDir(pkgSrc, pkgDest);
}

console.log("Done copying asciidoctor dependencies.");
