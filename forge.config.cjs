const path = require('node:path')

const notarizationCredentials = {
  appleId: process.env.APPLE_ID,
  appleIdPassword: process.env.APPLE_PASSWORD,
  teamId: process.env.APPLE_TEAM_ID,
}
const notarizationValues = Object.values(notarizationCredentials)
const notarizationConfigured = notarizationValues.every(Boolean)

if (!notarizationConfigured && notarizationValues.some(Boolean)) {
  throw new Error(
    'Apple notarization requires APPLE_ID, APPLE_PASSWORD, and APPLE_TEAM_ID together.',
  )
}

const shouldSignMac = Boolean(process.env.APPLE_SIGNING_IDENTITY || notarizationConfigured)

/** @type {import('@electron-forge/shared-types').ForgeConfig} */
module.exports = {
  packagerConfig: {
    appBundleId: 'dev.soitis.git-guis',
    appCategoryType: 'public.app-category.developer-tools',
    asar: true,
    executableName: 'Git Guis',
    extraResource: [path.join(__dirname, 'bin')],
    icon: path.join(__dirname, 'assets', 'icon'),
    name: 'Git Guis',
    ...(shouldSignMac
      ? {
          osxSign: {
            hardenedRuntime: true,
            ...(process.env.APPLE_SIGNING_IDENTITY
              ? { identity: process.env.APPLE_SIGNING_IDENTITY }
              : {}),
          },
        }
      : {}),
    ...(notarizationConfigured
      ? {
          osxNotarize: {
            ...notarizationCredentials,
            tool: 'notarytool',
          },
        }
      : {}),
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin'],
    },
    {
      name: '@electron-forge/maker-squirrel',
      platforms: ['win32'],
      config: {
        name: 'git_guis',
      },
    },
    {
      name: '@electron-forge/maker-deb',
      platforms: ['linux'],
    },
    {
      name: '@electron-forge/maker-rpm',
      platforms: ['linux'],
    },
  ],
}
