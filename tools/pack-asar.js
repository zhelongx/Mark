#!/usr/bin/env node
/*
 * Minimal deterministic ASAR writer for Mark's dependency-free app payload.
 * Electron's ASAR archive starts with two Chromium Pickles: the byte size of
 * the JSON header and the JSON header itself.  File offsets are relative to
 * the first byte after that header.  Keeping this small writer in-tree avoids
 * placing a Node runtime or a package-manager cache in the slim release.
 */
const fs = require('fs');
const path = require('path');

const [sourceArgument, destinationArgument] = process.argv.slice(2);
if (!sourceArgument || !destinationArgument) {
  throw new Error('Usage: node tools/pack-asar.js <source-directory> <output.asar>');
}

const source = path.resolve(sourceArgument);
const destination = path.resolve(destinationArgument);
if (!fs.statSync(source).isDirectory()) throw new Error(`Source is not a directory: ${source}`);
if (fs.existsSync(destination)) throw new Error(`Refusing to overwrite archive: ${destination}`);

function collect(directory, relative = '') {
  const result = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
    const childPath = path.join(directory, entry.name);
    if (entry.isDirectory()) result.push(...collect(childPath, childRelative));
    else if (entry.isFile()) result.push({ path: childPath, relative: childRelative.replaceAll('\\', '/') });
  }
  return result;
}

function createTree(files) {
  const root = { files: {} };
  let offset = 0;
  for (const file of files) {
    const size = fs.statSync(file.path).size;
    let node = root;
    for (const segment of file.relative.split('/').slice(0, -1)) {
      node.files[segment] ??= { files: {} };
      node = node.files[segment];
    }
    node.files[file.relative.split('/').at(-1)] = { size, offset: String(offset) };
    file.size = size;
    offset += size;
  }
  return root;
}

function align4(length) { return (length + 3) & ~3; }
function pickle(payload) {
  const result = Buffer.alloc(4 + align4(payload.length));
  // Chromium Pickle stores the padded payload capacity, not the logical byte
  // count. Electron rejects an otherwise valid ASAR when this is unaligned.
  result.writeUInt32LE(align4(payload.length), 0);
  payload.copy(result, 4);
  return result;
}
function pickleUInt32(value) {
  const payload = Buffer.alloc(4);
  payload.writeUInt32LE(value, 0);
  return pickle(payload);
}
function pickleString(value) {
  const text = Buffer.from(value, 'utf8');
  const payload = Buffer.alloc(4 + text.length);
  payload.writeUInt32LE(text.length, 0);
  text.copy(payload, 4);
  return pickle(payload);
}

const files = collect(source);
const header = pickleString(JSON.stringify(createTree(files)));
const size = pickleUInt32(header.length);
fs.mkdirSync(path.dirname(destination), { recursive: true });
const descriptor = fs.openSync(destination, 'wx');
try {
  fs.writeSync(descriptor, size);
  fs.writeSync(descriptor, header);
  for (const file of files) {
    const contents = fs.readFileSync(file.path);
    if (contents.length !== file.size) throw new Error(`File changed while packaging: ${file.relative}`);
    fs.writeSync(descriptor, contents);
  }
} finally {
  fs.closeSync(descriptor);
}
console.log(JSON.stringify({ source, destination, files: files.length, bytes: fs.statSync(destination).size }));
