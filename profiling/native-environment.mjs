export const pinnedBinaryEnvironment = Object.fromEntries([
  'npm_config_manage_package_manager_versions', 'NPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS',
  'pnpm_config_manage_package_manager_versions', 'PNPM_CONFIG_MANAGE_PACKAGE_MANAGER_VERSIONS',
].map(name => [name, 'false']))
