const path = require('node:path')

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
