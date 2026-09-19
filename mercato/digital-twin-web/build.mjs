import { build } from 'esbuild'
import { copyFile } from 'node:fs/promises'
await build({ entryPoints: ['viewer.js'], bundle: true, minify: true, format: 'iife', globalName: 'DigitalTwinRenderer', outfile: '../modules/digital_twins/assets/viewer.js', target: ['es2022'], legalComments: 'eof' })
await copyFile('node_modules/three/LICENSE', '../modules/digital_twins/assets/THREE-LICENSE.txt')
