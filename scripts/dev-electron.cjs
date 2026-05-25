#!/usr/bin/env node

const { spawn } = require('node:child_process')
const path = require('node:path')

const electronBinary = require('electron')

const child = spawn(electronBinary, ['.'], {
  cwd: path.resolve(__dirname, '..'),
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: undefined,
    VITE_DEV_SERVER_URL: process.env.VITE_DEV_SERVER_URL ?? 'http://127.0.0.1:5173',
  },
  stdio: 'inherit',
})

child.on('error', (error) => {
  console.error(error)
  process.exit(1)
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }
  process.exit(code ?? 0)
})
